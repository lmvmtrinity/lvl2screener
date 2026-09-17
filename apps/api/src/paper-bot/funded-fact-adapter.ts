import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { FundedOrderService } from "./funded-order-service.js";
import { fundedEnvelopesSchema } from "./funded-fact-schema.js";
import {
  cancelEntryOrder,
  submitEntryOrder,
  type PendingEntryOrder,
} from "./pending-order.js";
import { PostgresFundedLedgerStore } from "./funded-ledger-repository.js";
import { openEntryLiquidity } from "./shared-entry-liquidity.js";
import {
  factKey,
  factPriority,
  factTime,
  processFundedSessionFacts,
  type FundedSessionFact,
} from "./funded-session-driver.js";

export interface FundedFactEnvelope {
  id: string;
  fact: FundedSessionFact;
}
interface FactRow {
  fact_id: string;
  fact: FundedSessionFact;
  outcome: unknown;
  refusal_request: unknown;
  sort_key?: string;
}

export interface FundedDrainBudget {
  maxFacts: number;
  maxDurationMs: number;
}

/**
 * FP01 decision capture for the drain boundary. The decision is rebuilt from
 * durable sources inside the acknowledgement transaction, so a capture fault
 * cannot block later CLOCK/CANCEL/QUOTE facts: the fact is acknowledged with a
 * durable repairable gap instead.
 */
export interface FundedEvidenceProjectionOptions {
  readonly repository?: import("./funded-decision-evidence-repository.js").FundedDecisionEvidenceRepository;
}

/**
 * Refusal requests presented with one funded cycle input. They are committed
 * in the same enqueue transaction as the facts: a live request materializes
 * the immutable refusal source (with its boundary cursor); a deferred request
 * travels as an additive sidecar on its fact and receives the chronological
 * cursor from the ordered drain. The strict session-driver envelope is never
 * extended with evidence metadata.
 */
export interface FundedEnqueueOptions {
  readonly repository?: FundedEvidenceProjectionOptions["repository"];
  readonly refusalRequests?: readonly import("./funded-decision-evidence-repository.js").DecisionRefusalRequest[];
  /**
   * FP03 comparison seam: one validated durable sort key per SIGNAL order ID.
   * It is derived only from the frozen source batch/order rank and the source
   * opportunity identity, so two same-timestamp signals drain in the applied
   * comparison order without extending the strict session-driver envelope.
   */
  readonly signalSortKeys?: ReadonlyMap<string, string>;
}

/**
 * `000001:<uuid>` — a fixed-width applied rank (stable under COLLATE "C") and
 * the source opportunity identity. No caller-supplied free text is accepted.
 */
export const COMPARISON_SIGNAL_SORT_KEY_PATTERN =
  /^[0-9]{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function comparisonSignalSortKey(
  appliedRank: number,
  sourceOpportunityId: string,
): string {
  if (
    !Number.isSafeInteger(appliedRank) ||
    appliedRank < 1 ||
    appliedRank > 999_999
  )
    throw new Error("Invalid comparison signal rank");
  return `${appliedRank.toString().padStart(6, "0")}:${sourceOpportunityId}`;
}

interface BarrierRow {
  clock_at: Date | null;
  inflight_fact_id: string | null;
  inflight_fact_at: Date | null;
  inflight_priority: number | null;
  inflight_sort_key: string | null;
}

type FactOrder = {
  at: number;
  priority: number;
  sortKey: string;
  id: string;
};

/**
 * The additive refusal sidecar on an inbox fact. It retains the exact action,
 * reason and decision time; it is never part of the strict session-driver
 * envelope handed to `processFundedSessionFacts`.
 */
export interface FundedRefusalRequestMetadata {
  readonly observationId: string;
  readonly action: "DECLINE" | "DEFER";
  readonly policyReason: string;
  readonly decisionAt: string;
}

export function refusalRequestMetadataOf(
  value: unknown,
): FundedRefusalRequestMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.observationId !== "string" ||
    (record.action !== "DECLINE" && record.action !== "DEFER") ||
    typeof record.policyReason !== "string" ||
    record.policyReason.trim() === "" ||
    typeof record.decisionAt !== "string" ||
    !Number.isFinite(Date.parse(record.decisionAt))
  )
    return undefined;
  return {
    observationId: record.observationId,
    action: record.action,
    policyReason: record.policyReason,
    decisionAt: record.decisionAt,
  };
}

function compareFactOrder(left: FactOrder, right: FactOrder): number {
  return (
    left.at - right.at ||
    left.priority - right.priority ||
    (left.sortKey < right.sortKey
      ? -1
      : left.sortKey > right.sortKey
        ? 1
        : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/** Identity of the economic fact, independent of a transport envelope ID. */
export function factEconomicKey(fact: FundedSessionFact): string {
  if (fact.type === "CLOCK") return `CLOCK|${new Date(fact.at).toISOString()}`;
  if (fact.type === "SIGNAL") return `SIGNAL|${fact.order.orderId}`;
  if (fact.type === "CANCEL")
    return `CANCEL|${fact.orderId}|${new Date(fact.at).toISOString()}`;
  return `QUOTE|${fact.instrumentId}|${new Date(fact.quote.timestamp).toISOString()}`;
}

/** Durable chronological inbox. A crash after an effect but before its acknowledgement
 * retries the same idempotent service operation. Producers and consumers share a run
 * advisory lock. Pool requires at least two clients.
 */
export class FundedFactAdapter {
  private captureFailures = 0;
  private lastCaptureError: string | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly runId: string,
  ) {}

  /** Visible count of SIGNAL decision-capture faults (never silently captured). */
  captureFailureCount(): number {
    return this.captureFailures;
  }

  lastCaptureFailure(): string | null {
    return this.lastCaptureError;
  }

  /** Record a capture fault observed outside the inbox drain. */
  recordCaptureFailure(error: unknown): void {
    this.captureFailures += 1;
    this.lastCaptureError =
      error instanceof Error ? error.message : String(error);
  }

  async enqueue(
    facts: readonly FundedFactEnvelope[],
    options: FundedEnqueueOptions = {},
  ): Promise<void> {
    fundedEnvelopesSchema.parse(facts);
    if (options.refusalRequests?.length && !options.repository)
      throw new Error(
        "Funded refusal requests require an evidence repository for their durable source",
      );
    for (const { fact } of facts) {
      if (fact.type === "SIGNAL") submitEntryOrder(fact.order);
      if (fact.type === "QUOTE")
        openEntryLiquidity(
          fact.instrumentId,
          fact.quote,
          fact.participation,
          fact.impactBps,
        );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const acquired = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
        [`funded-inbox:${this.runId}`],
      );
      if (!acquired.rows[0]?.locked)
        throw new Error("Funded inbox busy; retry enqueue");
      // Serialize suppression decisions with the order service, which locks
      // this lifecycle row before committing an order and its ledger effects.
      const run = await client.query(
        "SELECT id FROM paper_bot_run WHERE id=$1 FOR UPDATE",
        [this.runId],
      );
      if (!run.rows.length) throw new Error("Funded run not found");
      const barrier = await client.query<BarrierRow>(
        `SELECT clock_at,inflight_fact_id,inflight_fact_at,inflight_priority,inflight_sort_key
         FROM paper_funded_run WHERE run_id=$1`,
        [this.runId],
      );
      const inflight = barrier.rows[0];
      const barrierOrder =
        inflight?.inflight_fact_id &&
        inflight.inflight_fact_at &&
        inflight.inflight_priority !== null &&
        inflight.inflight_sort_key !== null
          ? {
              at: inflight.inflight_fact_at.getTime(),
              priority: inflight.inflight_priority,
              sortKey: inflight.inflight_sort_key,
              id: inflight.inflight_fact_id,
            }
          : undefined;
      for (const { id, fact } of facts) {
        if (!id || !Object.hasOwn(factPriority, fact.type))
          throw new Error("Invalid funded fact identity/type");
        const at = new Date(factTime(fact)).toISOString();
        const comparisonSortKey =
          fact.type === "SIGNAL"
            ? options.signalSortKeys?.get(fact.order.orderId)
            : undefined;
        if (
          comparisonSortKey !== undefined &&
          !COMPARISON_SIGNAL_SORT_KEY_PATTERN.test(comparisonSortKey)
        )
          throw new Error("Invalid comparison funded SIGNAL sort key");
        const expectedSortKey = comparisonSortKey ?? factKey(fact);
        const prior = await client.query<FactRow>(
          "SELECT fact,outcome,sort_key FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
          [this.runId, id],
        );
        if (prior.rows[0]) {
          // The persisted durable sort key is always compared with the expected
          // key, including an omitted comparison key on retry: a stored
          // comparison key can never silently fall back to the default fact key.
          if (
            !isDeepStrictEqual(prior.rows[0].fact, fact) ||
            prior.rows[0].sort_key !== expectedSortKey
          )
            throw new Error("Conflicting funded fact retry");
          continue;
        }
        const economicKey = factEconomicKey(fact);
        const equivalent = await client.query<FactRow>(
          "SELECT fact,outcome,sort_key FROM paper_funded_fact WHERE run_id=$1 AND economic_key=$2",
          [this.runId, economicKey],
        );
        if (equivalent.rows[0]) {
          if (
            !isDeepStrictEqual(equivalent.rows[0].fact, fact) ||
            equivalent.rows[0].sort_key !== expectedSortKey
          )
            throw new Error("Conflicting funded economic fact");
          continue;
        }
        const order = {
          at: Date.parse(at),
          priority: factPriority[fact.type],
          sortKey: expectedSortKey,
          id,
        }; // A newly supplied fact at an already processed timestamp is late too:
        // admitting it could reorder decisions or re-use allocated liquidity.
        const later = await client.query(
          "SELECT 1 FROM paper_funded_fact WHERE run_id=$1 AND outcome IS NOT NULL AND fact_at >= $2 LIMIT 1",
          [this.runId, at],
        );
        let outcome: Record<string, unknown> | null =
          later.rows.length ||
          (inflight?.clock_at &&
            Date.parse(at) < inflight.clock_at.getTime()) ||
          (barrierOrder && compareFactOrder(order, barrierOrder) <= 0)
            ? {
                status: "LATE_FACT",
                reason:
                  barrierOrder && compareFactOrder(order, barrierOrder) <= 0
                    ? "An earlier or equal fact is in-flight; chronology insertion refused"
                    : "Timestamp precedes the funded clock or was already processed; historical insertion refused",
              }
            : null;
        // An enqueue-side reconciliation must make the fact identity durable
        // before the order revision that names it as its cause. Other paths
        // insert the fact with its processed outcome in one statement.
        let insertedFact = false;
        if (fact.type === "CANCEL" && fact.preSubmissionEventId) {
          // An effects-before-acknowledgement crash leaves the SIGNAL inbox
          // row pending even though its order and reservation are committed.
          // That is an in-flight retry, not evidence that submission never
          // happened. Preserve the SIGNAL retry while reconciling a pending
          // order before the chronological drain resumes.
          const committedOrder = await client.query<{
            state: PendingEntryOrder;
          }>(
            "SELECT state FROM paper_entry_order WHERE run_id=$1 AND order_id=$2 FOR UPDATE",
            [this.runId, fact.orderId],
          );
          const current = committedOrder.rows[0]?.state;
          if (current?.status === "PENDING") {
            if (
              fact.reason !== "SIGNAL_INVALIDATED" ||
              Date.parse(fact.at) > Date.parse(current.submittedAt)
            )
              throw new Error("Invalid pre-submission reconciliation");
            await client.query(
              `INSERT INTO paper_funded_fact(run_id,fact_id,fact_at,priority,sort_key,fact,economic_key)
               VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
              [
                this.runId,
                id,
                at,
                factPriority[fact.type],
                expectedSortKey,
                JSON.stringify(fact),
                economicKey,
              ],
            );
            insertedFact = true;
            const account = await client.query<{
              account_id: string;
              currency: "CAD" | "USD";
              last_event_at: string;
            }>(
              `SELECT b.account_id,b.currency,a.state->>'lastEventAt' AS last_event_at
               FROM paper_funded_run b JOIN paper_funded_account a ON a.id=b.account_id
               WHERE b.run_id=$1 FOR UPDATE OF a`,
              [this.runId],
            );
            const binding = account.rows[0];
            if (!binding) throw new Error("Run has no funded binding");
            const effectiveAt = new Date(
              Math.max(
                Date.parse(current.submittedAt),
                Date.parse(current.lastQuoteAt ?? current.submittedAt),
                Date.parse(binding.last_event_at),
                inflight?.clock_at?.getTime() ?? 0,
              ),
            ).toISOString();
            const cancelled = cancelEntryOrder(
              current,
              effectiveAt,
              "SIGNAL_INVALIDATED",
            );
            // This is reconciliation of a known invalidation, not insertion of
            // an earlier execution fact. Release the committed reservation and
            // cancel the order under the same run/account transaction before
            // an unexecuted same-time quote can fill it. Keep the original fact
            // and record the effective boundary separately for audit/retries.
            await new PostgresFundedLedgerStore(this.pool).applyInTransaction(
              client,
              binding.account_id,
              [
                {
                  id: `release:${fact.orderId}`,
                  at: effectiveAt,
                  currency: binding.currency,
                  type: "RELEASE",
                  orderId: fact.orderId,
                },
              ],
              { causeRunId: this.runId, causeFactId: id },
            );
            await client.query(
              `UPDATE paper_entry_order
                  SET state=$2::jsonb,last_fact_at=$3::timestamptz,
                      last_fact_id=$5,revision=revision+1,updated_at=now()
                WHERE run_id=$4 AND order_id=$1`,
              [
                fact.orderId,
                JSON.stringify(cancelled),
                effectiveAt,
                this.runId,
                id,
              ],
            );
            outcome = {
              status: "APPLIED",
              reconciliation: "PRE_SUBMISSION_INVALIDATION",
              effectiveAt,
            };
          } else if (!current)
            // Enqueue-side suppression of a never-submitted SIGNAL is a
            // processed outcome too: the database trigger assigns its
            // applied sequence in this transaction. Ordering remains
            // chronological because enqueue and the ordered drain share the
            // run's advisory lock.
            await client.query(
              `UPDATE paper_funded_fact
               SET outcome=$3::jsonb,processed_at=now()
               WHERE run_id=$1 AND fact_id=$2 AND outcome IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM paper_entry_order o
                   WHERE o.run_id=$1 AND o.order_id=$4
                 )`,
              [
                this.runId,
                `funded-signal:${fact.orderId}`,
                JSON.stringify({
                  status: "PRE_SUBMISSION_SUPPRESSED",
                  reason: "Durable pre-submission invalidation",
                }),
                fact.orderId,
              ],
            );
        }
        if (insertedFact) {
          if (outcome)
            await client.query(
              `UPDATE paper_funded_fact
                  SET outcome=$3::jsonb,processed_at=now()
                WHERE run_id=$1 AND fact_id=$2 AND outcome IS NULL`,
              [this.runId, id, JSON.stringify(outcome)],
            );
        } else
          await client.query(
            `INSERT INTO paper_funded_fact(run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome,processed_at)
             VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,CASE WHEN $8::jsonb IS NULL THEN NULL ELSE now() END)`,
            [
              this.runId,
              id,
              at,
              factPriority[fact.type],
              expectedSortKey,
              JSON.stringify(fact),
              economicKey,
              outcome ? JSON.stringify(outcome) : null,
            ],
          );
      }
      if (options.refusalRequests?.length && options.repository)
        await options.repository.recordRefusalRequestsInTransaction(
          client as unknown as Parameters<
            typeof options.repository.recordRefusalRequestsInTransaction
          >[0],
          this.runId,
          options.refusalRequests,
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async drain(
    budget?: FundedDrainBudget,
    evidence: FundedEvidenceProjectionOptions = {},
  ): Promise<number> {
    if (
      budget &&
      (!Number.isSafeInteger(budget.maxFacts) ||
        budget.maxFacts < 1 ||
        !Number.isFinite(budget.maxDurationMs) ||
        budget.maxDurationMs <= 0)
    )
      throw new Error("Invalid funded drain budget");
    const started = performance.now();
    const client = await this.pool.connect();
    let locked = false;
    try {
      const acquired = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [`funded-inbox:${this.runId}`],
      );
      locked = acquired.rows[0]?.locked ?? false;
      if (!locked) return 0;
      const binding = await client.query<{
        account_id: string;
        currency: "CAD" | "USD";
      }>("SELECT account_id,currency FROM paper_funded_run WHERE run_id=$1", [
        this.runId,
      ]);
      if (!binding.rows[0]) throw new Error("Run has no funded binding");
      const service = new FundedOrderService(
        this.pool,
        this.runId,
        binding.rows[0].account_id,
        binding.rows[0].currency,
      );
      let processed = 0;
      for (;;) {
        // Yield only between fully acknowledged facts. A crash or time budget
        // never abandons committed effects or bypasses an in-flight barrier.
        if (
          budget &&
          processed > 0 &&
          (processed >= budget.maxFacts ||
            performance.now() - started >= budget.maxDurationMs)
        )
          return processed;
        // The acknowledgement and barrier clear are one transaction, but this
        // repair makes the drain safe for a database restored from an older
        // implementation or for a manually completed inbox row.
        await client.query(
          `UPDATE paper_funded_run b SET inflight_fact_id=NULL,inflight_fact_at=NULL,
             inflight_priority=NULL,inflight_sort_key=NULL
           FROM paper_funded_fact f
           WHERE b.run_id=$1 AND f.run_id=b.run_id AND f.fact_id=b.inflight_fact_id
             AND f.outcome IS NOT NULL`,
          [this.runId],
        );
        const rows = await client.query<FactRow>(
          `SELECT fact_id,fact,outcome,refusal_request FROM paper_funded_fact WHERE run_id=$1 AND outcome IS NULL
           ORDER BY fact_at,priority,sort_key COLLATE "C",fact_id COLLATE "C" LIMIT 1`,
          [this.runId],
        );
        const row = rows.rows[0];
        if (!row) return processed;
        const at = new Date(factTime(row.fact)).toISOString();
        const claimed = await client.query(
          `UPDATE paper_funded_run
           SET inflight_fact_id=$2,inflight_fact_at=$3,inflight_priority=$4,inflight_sort_key=$5
           WHERE run_id=$1 AND (inflight_fact_id IS NULL OR inflight_fact_id=$2)`,
          [
            this.runId,
            row.fact_id,
            at,
            factPriority[row.fact.type],
            factKey(row.fact),
          ],
        );
        if (claimed.rowCount !== 1)
          throw new Error("Funded inbox has a different in-flight fact");
        const result = await processFundedSessionFacts(service, [
          { fact: row.fact, factId: row.fact_id },
        ]);
        const outcome = result.reservationVetoes.length
          ? { status: "RISK_VETO", vetoes: result.reservationVetoes }
          : result.cancellationNoOps.length
            ? {
                status:
                  result.cancellationNoOps[0]?.reason ===
                  "PRE_SUBMISSION_INVALIDATION"
                    ? "PRE_SUBMISSION_SUPPRESSED"
                    : "CANCEL_NOOP_RESERVATION_VETO",
                noOps: result.cancellationNoOps,
              }
            : { status: "APPLIED" };
        // A pre-submission suppression encountered in inbox order resolves the
        // refusal source that the enqueue transaction committed with this
        // cycle input. A live refusal is already the immutable source; a
        // deferred historical request carries its exact semantics as a sidecar
        // and receives its chronological cursor here. Without a durable
        // source the drain records nothing: it never translates a suppression
        // CANCEL into an invented decline.
        const preSubmissionRefusal =
          row.fact.type === "CANCEL" &&
          row.fact.preSubmissionEventId !== undefined &&
          outcome.status === "PRE_SUBMISSION_SUPPRESSED";
        const refusalFact = row.fact.type === "CANCEL" ? row.fact : undefined;
        // FP01: the durable decision intent commits in its own transaction
        // before acknowledgement, so a capture fault cannot lose the action,
        // timestamp or proven ledger boundary. Capture itself then runs inside
        // the acknowledgement transaction from durable sources. A failed
        // intent write is not fatal: the acknowledgement transaction retries
        // the intent as part of capture.
        if (row.fact.type === "SIGNAL" && evidence.repository) {
          try {
            await evidence.repository.ensureDecisionIntent({
              runId: this.runId,
              observationId: row.fact.order.orderId,
              action: "SUBMIT",
              policyReason: null,
              decisionAt: new Date(row.fact.order.submittedAt).toISOString(),
            });
          } catch (intentError) {
            this.lastCaptureError =
              intentError instanceof Error
                ? intentError.message
                : String(intentError);
          }
        }
        await client.query("BEGIN");
        try {
          // FP01: capture the immutable decision inside the acknowledgement
          // transaction, after the economic effect has committed. The decision
          // is rebuilt from durable sources at the exact persisted submission
          // time, so a later signal in the same batch sees this signal's
          // committed reservation. A capture fault is savepoint-isolated: the
          // fact is still acknowledged (it can never be replayed into a second
          // economic effect) and the durable gap is repaired by
          // `repairMissingDecisions`; CLOCK/CANCEL/QUOTE facts in the
          // same batch are never blocked.
          if (row.fact.type === "SIGNAL" && evidence.repository) {
            await client.query("SAVEPOINT fp01_capture");
            try {
              await evidence.repository.captureSignalDecisionInTransaction(
                client as unknown as Parameters<
                  typeof evidence.repository.captureSignalDecisionInTransaction
                >[0],
                this.runId,
                row.fact.order.orderId,
              );
              await client.query("RELEASE SAVEPOINT fp01_capture");
            } catch (captureError) {
              await client.query("ROLLBACK TO SAVEPOINT fp01_capture");
              this.captureFailures += 1;
              this.lastCaptureError =
                captureError instanceof Error
                  ? captureError.message
                  : String(captureError);
            }
          } else if (
            preSubmissionRefusal &&
            refusalFact &&
            evidence.repository
          ) {
            const request = refusalRequestMetadataOf(row.refusal_request);
            if (request) {
              if (request.observationId !== refusalFact.orderId)
                throw new Error(
                  "Deferred funded refusal request does not match its fact",
                );
              // Materialize the deferred request at this exact chronological
              // position. It is part of the acknowledgement transaction, so a
              // proven cursor can never be lost once the suppression is
              // acknowledged; a failure retries the still-pending fact.
              await evidence.repository.recordDecisionRefusalInTransaction(
                client as unknown as Parameters<
                  typeof evidence.repository.recordDecisionRefusalInTransaction
                >[0],
                {
                  runId: this.runId,
                  observationId: refusalFact.orderId,
                  action: request.action,
                  policyReason: request.policyReason,
                  decisionAt: request.decisionAt,
                },
              );
            }
            await client.query("SAVEPOINT fp01_refusal");
            try {
              await evidence.repository.captureRefusalDecisionIfPresentInTransaction(
                client as unknown as Parameters<
                  typeof evidence.repository.captureRefusalDecisionIfPresentInTransaction
                >[0],
                this.runId,
                refusalFact.orderId,
              );
              await client.query("RELEASE SAVEPOINT fp01_refusal");
            } catch (refusalError) {
              await client.query("ROLLBACK TO SAVEPOINT fp01_refusal");
              this.captureFailures += 1;
              this.lastCaptureError =
                refusalError instanceof Error
                  ? refusalError.message
                  : String(refusalError);
            }
          }
          // The applied sequence is assigned by the database-owned trigger in
          // this same transaction: exactly one per-run sequence for a non-LATE
          // processed fact, never by the wall clock and never for a refused
          // LATE_FACT. A crash after commit retries into `outcome IS NULL`
          // (no-op) and preserves the original sequence.
          await client.query(
            `UPDATE paper_funded_fact
                SET outcome=$3::jsonb,processed_at=now()
              WHERE run_id=$1 AND fact_id=$2 AND outcome IS NULL`,
            [this.runId, row.fact_id, JSON.stringify(outcome)],
          );
          await client.query(
            `UPDATE paper_funded_run SET inflight_fact_id=NULL,inflight_fact_at=NULL,
               inflight_priority=NULL,inflight_sort_key=NULL
             WHERE run_id=$1 AND inflight_fact_id=$2`,
            [this.runId, row.fact_id],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
        processed += 1;
      }
    } finally {
      // Destroy the client if unlocking fails; do not return a held lock to the pool.
      let broken = false;
      if (locked)
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `funded-inbox:${this.runId}`,
          ])
          .catch(() => {
            broken = true;
          });
      client.release(broken);
    }
  }
}
