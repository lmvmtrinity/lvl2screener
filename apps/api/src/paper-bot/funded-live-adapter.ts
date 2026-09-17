import { normalizedQuoteSize } from "./normalized-quote-size.js";
import type { Pool } from "pg";
import type { MarketId } from "@tsx-scanner/contracts";
import {
  FundedFactAdapter,
  type FundedDrainBudget,
  type FundedFactEnvelope,
} from "./funded-fact-adapter.js";
import { FundedOrderService } from "./funded-order-service.js";
import { PostgresFundedLedgerStore } from "./funded-ledger-repository.js";
import {
  fundedReconstructionMetrics,
  type FundedReconstructionMetricsRegistry,
} from "./funded-reconstruction-observability.js";
import { fundedPolicy, type FundedPolicy } from "./funded-policy.js";
import type { PaperSignalObservation } from "./paper-bot-repository.js";
import type {
  AssumptionsSnapshot,
  QuoteFact,
  SignalFact,
  SizingContext,
} from "./types.js";
import { fundedReservationDebit } from "./financials.js";
import { FundedDecisionEvidenceRepository } from "./funded-decision-evidence-repository.js";
import type { DecisionRefusalRequest } from "./funded-decision-evidence-repository.js";
import { FundedDecisionOutcomeProjector } from "./funded-decision-outcome-projector.js";
import { zonedSessionBoundary } from "./session-time.js";

export const DEFAULT_FUNDED_SIGNAL_MAX_AGE_MINUTES = 20;

export interface FundedInvalidation {
  readonly eventId: string;
  readonly orderId: string;
  readonly at: string;
}

export interface FundedLiveCycleInput {
  readonly at: string;
  readonly sessionDate: string;
  readonly scheduledCloseAt: string;
  /** Instruments expected from the selected market's current universe. */
  readonly expectedInstrumentIds?: readonly string[];
  readonly observations: readonly PaperSignalObservation[];
  readonly invalidations: readonly FundedInvalidation[];
  readonly quotes: readonly (QuoteFact & { instrumentId: string })[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A READY observation is evidence of a formation at signal time, not a
 * standing instruction to enter for the rest of the session. The deadline is
 * derived once at the adapter boundary and then persisted as order.expiresAt.
 * Older observations use the strategy setup timeout as a conservative
 * compatibility default.
 */
export function fundedSignalValidityDeadline(
  observation: Pick<
    PaperSignalObservation,
    "signalTimestamp" | "profileParameters"
  > &
    Partial<Pick<PaperSignalObservation, "sourceEventPayload">>,
  sessionDate: string,
  scheduledCloseAt: string,
  assumptions: Pick<AssumptionsSnapshot, "sessionTimezone">,
): string | undefined {
  const signal = Date.parse(observation.signalTimestamp);
  const close = Date.parse(scheduledCloseAt);
  if (!Number.isFinite(signal) || !Number.isFinite(close)) return undefined;
  const parameters = recordOf(observation.profileParameters);
  const configuredAge =
    parameters?.signalValidityMinutes ??
    parameters?.maxSignalAgeMinutes ??
    parameters?.setupTimeoutMinutes ??
    parameters?.setup_timeout_minutes;
  if (
    configuredAge !== undefined &&
    (typeof configuredAge !== "number" ||
      !Number.isFinite(configuredAge) ||
      configuredAge <= 0)
  )
    return undefined;
  const maxAgeMinutes =
    typeof configuredAge === "number" &&
    Number.isFinite(configuredAge) &&
    configuredAge > 0
      ? configuredAge
      : DEFAULT_FUNDED_SIGNAL_MAX_AGE_MINUTES;
  const deadlines = [close, signal + maxAgeMinutes * 60_000];
  const rawEntryWindow =
    recordOf(observation.sourceEventPayload)?.entryWindow ??
    parameters?.entryWindow ??
    parameters?.entry_window;
  const entryWindow = recordOf(rawEntryWindow);
  const hardEnd = entryWindow?.hardEnd ?? entryWindow?.hard_end;
  if (
    rawEntryWindow !== undefined &&
    rawEntryWindow !== null &&
    (!entryWindow || typeof hardEnd !== "string")
  )
    return undefined;
  if (typeof hardEnd === "string") {
    try {
      const entryClose = Date.parse(
        zonedSessionBoundary(sessionDate, hardEnd, assumptions.sessionTimezone),
      );
      if (Number.isFinite(entryClose)) deadlines.push(entryClose);
    } catch {
      return undefined;
    }
  }
  const deadline = Math.min(...deadlines);
  return Number.isFinite(deadline) && deadline > signal
    ? new Date(deadline).toISOString()
    : undefined;
}

export interface FundedLiveCycleResult {
  readonly enqueued: number;
  readonly processed: number;
  readonly skippedObservations: number;
  readonly skippedQuotes: number;
  readonly coverageGaps: number;
  /** Decision captures that failed this cycle (also kept in the inbox). */
  readonly captureFailures: number;
  /** Outcome projection attempts that failed this cycle. */
  readonly projectionFailures: number;
  /** Durable decisions still missing evidence capture after the repair pass. */
  readonly decisionGaps: number;
  /** Durable decisions with unrepresented fact/order/ledger sources. */
  readonly outcomeGaps: number;
}

export function countFundedCoverageGaps(
  expectedInstrumentIds: readonly string[],
  actionableInstrumentIds: ReadonlySet<string>,
  skippedInputs: number,
): number {
  if (!Number.isSafeInteger(skippedInputs) || skippedInputs < 0)
    throw new Error("Invalid funded coverage skip count");
  return (
    skippedInputs +
    new Set(
      expectedInstrumentIds.filter(
        (instrumentId) => !actionableInstrumentIds.has(instrumentId),
      ),
    ).size
  );
}

export interface FundedOperationalSnapshot {
  readonly closePendingOrders: number;
  readonly oldestClosePendingAgeMs: number | null;
  readonly riskVetoesTotal: number;
  readonly coverageGapsTotal: number;
  readonly recoveryFailuresTotal: number;
  readonly lastCycleLatencyMs: number | null;
  readonly pendingFacts?: number;
  readonly oldestPendingFactAgeMs?: number | null;
  /** In-process evidence-capture faults; resets with the process. */
  readonly evidenceCaptureFailuresTotal?: number;
  /** In-process outcome-projection faults; resets with the process. */
  readonly evidenceProjectionFailuresTotal?: number;
  /**
   * Durable repairable gaps derived from the database, so a restart does not
   * erase visibility: decisions still missing capture and decisions whose
   * durable sources have no outcome version yet.
   */
  readonly evidenceDecisionGapsTotal?: number;
  readonly evidenceOutcomeGapsTotal?: number;
  /** Trailing five-minute averages over the account's durable fact stream. The
   *  subtraction is the sustained capacity deficit: a positive value means the
   *  drain is falling behind arrivals. */
  readonly factsArrivedPerMinute?: number | null;
  readonly factsDrainedPerMinute?: number | null;
  readonly arrivalMinusDrainPerMinute?: number | null;
  /** Last bounded ledger reconstruction: wall duration and replayed rows. */
  readonly reconstructionDurationMs?: number | null;
  readonly reconstructionDurationMaxMs?: number | null;
  readonly reconstructionReplayedEvents?: number | null;
  readonly reconstructionPages?: number | null;
  /** Replayed window span (boundary minus checkpoint boundary); null after a
   *  full replay from account creation. */
  readonly reconstructionCheckpointAgeMs?: number | null;
  readonly reconstructionLastObservedTimestampSeconds?: number | null;
  readonly reconstructionCountTotal?: number;
  readonly reconstructionFullReplaysTotal?: number;
  /** Fail-closed reconstructions blocked by the event budget; target zero. */
  readonly reconstructionBudgetFailuresTotal?: number;
}

export interface FundedLiveAdapterOptions {
  readonly pool: Pool;
  readonly runId: string;
  readonly accountId: string;
  readonly currency: "CAD" | "USD";
  readonly marketId: MarketId;
  readonly assumptions: AssumptionsSnapshot;
  readonly policy?: FundedPolicy;
  readonly reconstructionMetrics?: FundedReconstructionMetricsRegistry;
}

/**
 * Converts a durable scanner observation into the immutable execution order
 * used by the funded simulator. A first discovery uses the current cycle
 * boundary; retries reuse the timestamp already persisted in the inbox.
 */
export function buildFundedSignalEnvelope(
  observation: PaperSignalObservation,
  submittedAt: string,
  expiresAt: string,
  assumptions: AssumptionsSnapshot,
  maximumDebit = fundedReservationDebit(assumptions),
  maximumRisk = assumptions.riskBudget ?? maximumDebit,
  options: { enforceValidity?: boolean; policy?: FundedPolicy } = {},
): FundedFactEnvelope | undefined {
  const submitted = Date.parse(submittedAt);
  const signalTimestamp = Date.parse(observation.signalTimestamp);
  const deadline =
    options.enforceValidity === false
      ? expiresAt
      : fundedSignalValidityDeadline(
          observation,
          observation.signalTimestamp.slice(0, 10),
          expiresAt,
          assumptions,
        );
  const expires = deadline ? Date.parse(deadline) : Number.NaN;
  const latencyMs = assumptions.latencyMs ?? 0;
  if (
    !Number.isFinite(submitted) ||
    !Number.isFinite(signalTimestamp) ||
    !Number.isFinite(expires) ||
    !Number.isSafeInteger(latencyMs) ||
    latencyMs < 0 ||
    submitted < signalTimestamp ||
    submitted >= expires ||
    submitted + latencyMs >= expires
  )
    return undefined;
  const signal: SignalFact = {
    entryReference: observation.entryReference,
    stopReference: observation.stopReference,
    targetReference: observation.targetReference,
    atr14: observation.atr14,
    signalTimestamp: observation.signalTimestamp,
  };
  const marketContext = observation.fundedContexts?.find(
    (value) => value.signalKey === "MARKET_RELATIVE_STRENGTH",
  );
  // Run provenance stays on the run snapshot, outside strict execution facts.
  const { evidenceScope: _evidenceScope, ...factAssumptions } = assumptions;
  return {
    id: `funded-signal:${observation.id}`,
    fact: {
      type: "SIGNAL",
      instrumentId: observation.instrumentId,
      order: {
        orderId: observation.id,
        signal,
        assumptions: factAssumptions,
        context: definedContext({
          executionMode: "CAPACITY_CONSTRAINED",
          latencyMs,
          ...(options.policy?.portfolio?.version === "funded-portfolio-v2" &&
          observation.fundedContexts
            ? {
                contexts: observation.fundedContexts,
                contextStatus: marketContext?.status,
                contextTimestamp: marketContext?.timestamp,
              }
            : {}),
          ...(options.policy?.portfolio?.version === "funded-portfolio-v2"
            ? {
                strategyKey: observation.strategyKey,
                maximumHoldingMinutes:
                  options.policy.portfolio.maximumHoldingMinutesByStrategy?.[
                    observation.strategyKey
                  ] ?? options.policy.portfolio.maximumHoldingMinutes,
                stalledBreakoutMinutes:
                  options.policy.portfolio.stalledBreakoutMinutes,
                stalledBreakoutMinProgressR:
                  options.policy.portfolio.stalledBreakoutMinProgressR,
              }
            : {}),
        }),
        submittedAt: new Date(submitted).toISOString(),
        expiresAt: new Date(expires).toISOString(),
      },
      maximumDebit,
      maximumRisk,
    },
  };
}

export function buildFundedInvalidationEnvelope(
  invalidation: FundedInvalidation,
  preSubmission = false,
): FundedFactEnvelope | undefined {
  if (!invalidation.eventId || !invalidation.orderId) return undefined;
  if (!Number.isFinite(Date.parse(invalidation.at))) return undefined;
  return {
    id: `funded-invalidation:${invalidation.eventId}`,
    fact: {
      type: "CANCEL",
      orderId: invalidation.orderId,
      at: new Date(invalidation.at).toISOString(),
      reason: "SIGNAL_INVALIDATED",
      ...(preSubmission ? { preSubmissionEventId: invalidation.eventId } : {}),
    },
  };
}

export function buildFundedQuoteEnvelope(
  quote: QuoteFact & { instrumentId: string },
  policy: FundedPolicy,
): FundedFactEnvelope | undefined {
  const timestamp = Date.parse(quote.timestamp);
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(quote.bid) ||
    !Number.isFinite(quote.ask) ||
    !Number.isFinite(quote.bidSize) ||
    !Number.isFinite(quote.askSize) ||
    quote.sizeUnit === "UNKNOWN" ||
    quote.sizeUnit === "BOARD_LOTS" ||
    (quote.sizeMultiplier !== undefined && quote.sizeMultiplier !== 1) ||
    quote.dataStatus !== "REALTIME" ||
    !quote.actionable
  )
    return undefined;
  return {
    id: `funded-quote:${quote.instrumentId}:${new Date(timestamp).toISOString()}`,
    fact: {
      type: "QUOTE",
      instrumentId: quote.instrumentId,
      quote: {
        timestamp: new Date(timestamp).toISOString(),
        bid: quote.bid,
        ask: quote.ask,
        bidSize: quote.bidSize,
        askSize: quote.askSize,
        dataStatus: "REALTIME",
        actionable: true,
      },
      participation: policy.participation,
      impactBps: policy.impactBps,
    },
  };
}

/**
 * Live observation/quote adapter for the funded path. It is deliberately
 * independent of the legacy PaperBotLiveProcessor so existing independent and
 * shadow evidence cannot be resized or rewritten by funded account state.
 */
export class FundedLiveAdapter {
  private readonly inbox: FundedFactAdapter;
  private readonly evidence: FundedDecisionEvidenceRepository;
  private readonly projector: FundedDecisionOutcomeProjector;
  private projectionFailures = 0;
  private evidenceProjectionFailures = 0;
  private lastProjectionError: string | null = null;

  /** Visible count of FP01 outcome-projection faults; repair is idempotent. */
  projectionFailureCount(): number {
    return this.projectionFailures;
  }

  lastProjectionFailure(): string | null {
    return this.lastProjectionError;
  }
  private readonly service: FundedOrderService;
  private readonly ledger: PostgresFundedLedgerStore;
  private readonly policy: FundedPolicy;
  private coverageGapsTotal = 0;
  private recoveryFailuresTotal = 0;
  private lastCycleLatencyMs: number | null = null;
  private readonly reconstructionMetrics: FundedReconstructionMetricsRegistry;

  constructor(private readonly options: FundedLiveAdapterOptions) {
    this.reconstructionMetrics =
      options.reconstructionMetrics ?? fundedReconstructionMetrics;
    this.policy = options.policy ?? fundedPolicy();
    this.inbox = new FundedFactAdapter(options.pool, options.runId);
    this.evidence = new FundedDecisionEvidenceRepository(
      options.pool,
      (observation) =>
        this.reconstructionMetrics.observe(options.accountId, observation),
    );
    this.projector = new FundedDecisionOutcomeProjector(
      options.pool,
      this.evidence,
    );
    this.ledger = new PostgresFundedLedgerStore(options.pool);
    this.service = new FundedOrderService(
      options.pool,
      options.runId,
      options.accountId,
      options.currency,
    );
    if (options.marketId !== "CA_TSX" && options.marketId !== "US_EQUITIES")
      throw new Error("Unsupported funded live market");
  }

  async bind(
    sessionDate: string,
    sessionStartAt: string,
    initialCash: number,
    dailyLossLimit: number,
  ): Promise<void> {
    await this.ledger.ensure(this.options.accountId, [
      this.options.currency,
      initialCash,
      sessionDate,
      sessionStartAt,
      dailyLossLimit,
    ]);
    await this.service.bind(this.policy, {
      session: sessionDate,
      at: sessionStartAt,
    });
  }

  /**
   * Returns retained actionable quotes after the atomically enqueued live clock
   * (or the executed clock for older runs). Pending facts remain in the inbox.
   * The current quote poll is persisted before this method is called, so a
   * restart can catch up the complete retained interval without trusting an
   * in-memory cursor. Non-actionable rows remain coverage evidence but are not
   * execution facts.
   */
  async retainedQuotes(
    instrumentIds: readonly string[],
    through: string,
  ): Promise<(QuoteFact & { instrumentId: string })[]> {
    if (instrumentIds.length === 0) return [];
    const result = await this.options.pool.query<{
      instrumentId: string;
      timestamp: Date | string;
      bid: number | string;
      ask: number | string;
      bidSize: number | string;
      askSize: number | string;
      sizeUnit: string | null;
      sizeMultiplier: number | null;
    }>(
      `SELECT DISTINCT ON (q.instrument_id,q.timestamp)
         q.instrument_id AS "instrumentId",q.timestamp,q.bid,q.ask,q.bid_size AS "bidSize",
         q.ask_size AS "askSize",q.size_unit AS "sizeUnit",q.size_multiplier AS "sizeMultiplier"
       FROM quote_snapshot q
       JOIN instrument i ON i.id=q.instrument_id AND i.market_id=$1
       JOIN paper_funded_run b ON b.run_id=$2
       JOIN paper_bot_run r ON r.id=b.run_id
       WHERE q.instrument_id=ANY($3::uuid[])
         AND q.timestamp > COALESCE(
           GREATEST(b.clock_at, (SELECT max(f.fact_at) FROM paper_funded_fact f
             WHERE f.run_id=b.run_id AND f.fact->>'type'='CLOCK'
               AND f.fact_id LIKE 'funded-clock:%')),
           r.session_date::timestamp AT TIME ZONE r.session_timezone
         )
         AND q.timestamp <= $4::timestamptz
         AND q.is_delayed=false AND q.is_halted=false
       ORDER BY q.instrument_id,q.timestamp,q.source`,
      [this.options.marketId, this.options.runId, [...instrumentIds], through],
    );
    return result.rows.map((row) => ({
      instrumentId: row.instrumentId,
      timestamp: new Date(row.timestamp).toISOString(),
      bid: Number(row.bid),
      ask: Number(row.ask),
      bidSize: Number(row.bidSize),
      askSize: Number(row.askSize),
      ...normalizedQuoteSize(row.sizeUnit, row.sizeMultiplier),
      dataStatus: "REALTIME",
      actionable: true,
    }));
  }

  /**
   * Record a failed recovery attempt and return the durable-in-process count.
   *
   * The caller may be handling a database or transport outage, so exposing the
   * increment synchronously lets it publish the counter without first querying
   * the funded tables for a full operational snapshot.
   */
  recordRecoveryFailure(): number {
    this.recoveryFailuresTotal += 1;
    return this.recoveryFailuresTotal;
  }

  private async existingSignalFact(observationId: string): Promise<
    | (FundedFactEnvelope & {
        outcome: { status?: string } | null;
        committedOrder: boolean;
        pendingOrder: boolean;
      })
    | { suppressed: true }
    | undefined
  > {
    const result = await this.options.pool.query<{
      fact: FundedFactEnvelope["fact"];
      outcome: { status?: string } | null;
      committedOrder: boolean;
      pendingOrder: boolean;
    }>(
      `SELECT fact,outcome,
              EXISTS (
                SELECT 1 FROM paper_entry_order o
                WHERE o.run_id=$1 AND o.order_id=$3
              ) AS "committedOrder",
              EXISTS (
                SELECT 1 FROM paper_entry_order o
                WHERE o.run_id=$1 AND o.order_id=$3
                  AND o.state->>'status'='PENDING'
              ) AS "pendingOrder"
       FROM paper_funded_fact
       WHERE run_id=$1 AND (
         fact_id=$2
         OR (fact->>'type'='CANCEL' AND fact->>'orderId'=$3
             AND fact->'preSubmissionEventId' IS NOT NULL)
       )
       ORDER BY CASE WHEN fact_id=$2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [this.options.runId, `funded-signal:${observationId}`, observationId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.outcome?.status === "PRE_SUBMISSION_SUPPRESSED")
      return { suppressed: true };
    if (row.fact.type === "SIGNAL")
      return {
        id: `funded-signal:${observationId}`,
        fact: row.fact,
        outcome: row.outcome,
        committedOrder: row.committedOrder,
        pendingOrder: row.pendingOrder,
      };
    return { suppressed: true };
  }

  private async existingStaleCancellation(
    observationId: string,
  ): Promise<FundedFactEnvelope | undefined> {
    const result = await this.options.pool.query<{
      fact: FundedFactEnvelope["fact"];
    }>(
      `SELECT fact FROM paper_funded_fact
       WHERE run_id=$1 AND fact_id=$2 AND fact->>'type'='CANCEL'`,
      [this.options.runId, `funded-invalidation:stale-signal:${observationId}`],
    );
    const fact = result.rows[0]?.fact;
    return fact?.type === "CANCEL"
      ? {
          id: `funded-invalidation:stale-signal:${observationId}`,
          fact,
        }
      : undefined;
  }

  async operationalSnapshot(at: string): Promise<FundedOperationalSnapshot> {
    const observedAt = Date.parse(at);
    if (!Number.isFinite(observedAt))
      throw new Error("Invalid funded operational snapshot time");
    const result = await this.options.pool.query<{
      closePendingOrders: string | number;
      oldestClosePendingAt: Date | string | null;
      riskVetoesTotal: string | number;
      lateFactsTotal: string | number;
      pendingFacts: string | number;
      oldestPendingAt: Date | string | null;
      factsArrived5m: string | number;
      factsDrained5m: string | number;
    }>(
      `SELECT
         (SELECT count(*) FROM paper_funded_fact f
          WHERE f.run_id IN (
            SELECT fb.run_id FROM paper_funded_run fb
             JOIN paper_bot_run fr ON fr.id=fb.run_id
             WHERE fb.account_id=$1 AND fb.currency=$2 AND fr.market_id=$3)
            AND f.outcome IS NULL) AS "pendingFacts",
         (SELECT min(f.fact_at) FROM paper_funded_fact f
          WHERE f.run_id IN (
            SELECT fb.run_id FROM paper_funded_run fb
             JOIN paper_bot_run fr ON fr.id=fb.run_id
             WHERE fb.account_id=$1 AND fb.currency=$2 AND fr.market_id=$3)
            AND f.outcome IS NULL) AS "oldestPendingAt",
         count(*) FILTER (WHERE o.state->'execution'->>'status'='CLOSE_PENDING') AS "closePendingOrders",
         min(o.close_pending_at) FILTER (WHERE o.state->'execution'->>'status'='CLOSE_PENDING') AS "oldestClosePendingAt",
         (SELECT count(*) FROM paper_funded_fact f
          WHERE f.run_id IN (
            SELECT fb.run_id FROM paper_funded_run fb
             JOIN paper_bot_run fr ON fr.id=fb.run_id
             WHERE fb.account_id=$1 AND fb.currency=$2 AND fr.market_id=$3)
            AND f.outcome->>'status'='RISK_VETO') AS "riskVetoesTotal",
         (SELECT count(*) FROM paper_funded_fact f
          WHERE f.run_id IN (
            SELECT fb.run_id FROM paper_funded_run fb
             JOIN paper_bot_run fr ON fr.id=fb.run_id
             WHERE fb.account_id=$1 AND fb.currency=$2 AND fr.market_id=$3)
            AND f.outcome->>'status'='LATE_FACT') AS "lateFactsTotal",
         (SELECT COALESCE(sum(f.enqueued_count),0)
          FROM paper_funded_fact_rate_minute f
          WHERE f.run_id IN (
            SELECT fb.run_id FROM paper_funded_run fb
             JOIN paper_bot_run fr ON fr.id=fb.run_id
             WHERE fb.account_id=$1 AND fb.currency=$2 AND fr.market_id=$3)
            AND f.bucket_at >= date_trunc('minute',now()) - interval '4 minutes') AS "factsArrived5m",
         (SELECT COALESCE(sum(f.processed_count),0)
          FROM paper_funded_fact_rate_minute f
          WHERE f.run_id IN (
            SELECT fb.run_id FROM paper_funded_run fb
             JOIN paper_bot_run fr ON fr.id=fb.run_id
             WHERE fb.account_id=$1 AND fb.currency=$2 AND fr.market_id=$3)
            AND f.bucket_at >= date_trunc('minute',now()) - interval '4 minutes') AS "factsDrained5m"
       FROM paper_entry_order o
       JOIN paper_funded_run b ON b.run_id=o.run_id
       JOIN paper_bot_run r ON r.id=b.run_id
       WHERE b.account_id=$1 AND b.currency=$2 AND r.market_id=$3`,
      [this.options.accountId, this.options.currency, this.options.marketId],
    );
    const row = result.rows[0];
    const oldest = row?.oldestClosePendingAt
      ? row.oldestClosePendingAt instanceof Date
        ? row.oldestClosePendingAt.getTime()
        : Date.parse(row.oldestClosePendingAt)
      : Number.NaN;
    // Durable gaps are derived from the database so a restart cannot erase the
    // visibility of missing capture or unprojected outcomes.
    const [evidenceDecisionGapsTotal, evidenceOutcomeGapsTotal] =
      await Promise.all([
        this.evidence.decisionGapCount(this.options.runId),
        this.evidence.projectionGapCount(this.options.runId),
      ]);
    // Sustained five-minute averages; the difference is the capacity deficit
    // that matters, not any single cycle's batch size.
    const rate = (value: string | number | undefined): number =>
      Math.round((Number(value ?? 0) / 5) * 100) / 100;
    const factsArrivedPerMinute = rate(row?.factsArrived5m);
    const factsDrainedPerMinute = rate(row?.factsDrained5m);
    const reconstruction = this.reconstructionMetrics.snapshot(
      this.options.accountId,
    );
    return {
      closePendingOrders: Number(row?.closePendingOrders ?? 0),
      oldestClosePendingAgeMs: Number.isFinite(oldest)
        ? Math.max(0, observedAt - oldest)
        : null,
      riskVetoesTotal: Number(row?.riskVetoesTotal ?? 0),
      coverageGapsTotal:
        Number(row?.lateFactsTotal ?? 0) + this.coverageGapsTotal,
      recoveryFailuresTotal: this.recoveryFailuresTotal,
      lastCycleLatencyMs: this.lastCycleLatencyMs,
      pendingFacts: Number(row?.pendingFacts ?? 0),
      oldestPendingFactAgeMs: row?.oldestPendingAt
        ? Math.max(0, observedAt - new Date(row.oldestPendingAt).getTime())
        : null,
      evidenceCaptureFailuresTotal: this.inbox.captureFailureCount(),
      evidenceProjectionFailuresTotal: this.evidenceProjectionFailures,
      evidenceDecisionGapsTotal,
      evidenceOutcomeGapsTotal,
      factsArrivedPerMinute,
      factsDrainedPerMinute,
      arrivalMinusDrainPerMinute:
        Math.round((factsArrivedPerMinute - factsDrainedPerMinute) * 100) / 100,
      ...reconstruction,
    };
  }

  /**
   * Drains already-enqueued facts only, without re-running the cycle's input
   * work. Callers use it as a bounded catch-up between quote cycles so the
   * live batch budget (100 facts / 1,000 ms) can be reused while a backlog
   * remains. Ordering, advisory locking, effects-before-acknowledgement and
   * per-fact event-loop yielding are exactly the drain's; nothing here changes
   * them.
   */
  async drainEnqueued(budget?: FundedDrainBudget): Promise<number> {
    return this.inbox.drain(budget, { repository: this.evidence });
  }

  async process(
    input: FundedLiveCycleInput,
    budget?: FundedDrainBudget,
  ): Promise<FundedLiveCycleResult> {
    const started = performance.now();
    if (!Number.isFinite(Date.parse(input.at)))
      throw new Error("Invalid funded live cycle clock");
    const envelopes: FundedFactEnvelope[] = [
      {
        id: `funded-clock:${input.at}`,
        fact: { type: "CLOCK", at: new Date(input.at).toISOString() },
      },
    ];
    let skippedObservations = 0;
    const preSubmissionOrderIds = new Set<string>();
    // Refusal requests are committed atomically with this cycle's facts by the
    // enqueue transaction. They are never evidence-side best-effort writes, so
    // the exact action, reason, decision time and chronological cursor survive
    // a restart even if the observation is suppressed on later cycles.
    const refusalRequests: DecisionRefusalRequest[] = [];
    for (const observation of [...input.observations].sort(
      (left, right) =>
        Date.parse(left.signalTimestamp) - Date.parse(right.signalTimestamp) ||
        left.id.localeCompare(right.id),
    )) {
      const existing = await this.existingSignalFact(observation.id);
      const staleCancellation = await this.existingStaleCancellation(
        observation.id,
      );
      const validityDeadline = fundedSignalValidityDeadline(
        observation,
        input.sessionDate,
        input.scheduledCloseAt,
        this.options.assumptions,
      );
      const cycleAt = Date.parse(input.at);
      if (existing && "suppressed" in existing) continue;
      const hasKnownInvalidation = input.invalidations.some(
        (invalidation) =>
          invalidation.orderId === observation.id &&
          Date.parse(invalidation.at) <= cycleAt,
      );
      if (
        !existing &&
        (!validityDeadline || cycleAt >= Date.parse(validityDeadline)) &&
        !hasKnownInvalidation
      ) {
        skippedObservations += 1;
        const suppression =
          staleCancellation ??
          buildFundedInvalidationEnvelope(
            {
              eventId: `stale-signal:${observation.id}`,
              orderId: observation.id,
              // This boundary is stable across cycles. Never use input.at here:
              // the envelope ID is fixed, so a later cycle must be an identical
              // retry rather than a conflicting fact.
              at: validityDeadline ?? observation.signalTimestamp,
            },
            true,
          );
        if (suppression) envelopes.push(suppression);
        preSubmissionOrderIds.add(observation.id);
        // The opportunity was known and eligible, but its entry window closed
        // before the funded path could act. That is a deferral of the
        // opportunity, not a quality decline, and it is retained exactly once
        // with the cycle input.
        refusalRequests.push({
          observationId: observation.id,
          action: "DEFER",
          policyReason: validityDeadline
            ? "SIGNAL_VALIDITY_EXPIRED"
            : "SIGNAL_WINDOW_UNPROVABLE",
          decisionAt: validityDeadline ?? observation.signalTimestamp,
        });
        continue;
      }
      if (
        (!validityDeadline || cycleAt >= Date.parse(validityDeadline)) &&
        !hasKnownInvalidation &&
        existing &&
        "fact" in existing &&
        existing.fact.type === "SIGNAL"
      ) {
        // An already submitted signal may still be pending, in which case its
        // stable expiry cancellation is a normal cancellation. If the order
        // was already cancelled, rejected, filled, or closed, CLOCK/quote
        // processing has already settled it and no second cancellation fact is
        // needed.
        envelopes.push({ id: existing.id, fact: existing.fact });
        if (staleCancellation) {
          envelopes.push(staleCancellation);
          preSubmissionOrderIds.add(observation.id);
        } else if (existing.pendingOrder) {
          const cancellation = buildFundedInvalidationEnvelope({
            eventId: `stale-signal:${observation.id}`,
            orderId: observation.id,
            at: validityDeadline ?? observation.signalTimestamp,
          });
          if (cancellation) {
            envelopes.push(cancellation);
            preSubmissionOrderIds.add(observation.id);
          }
        }
        continue;
      }
      // Existing facts retain their original envelope and expiry. CLOCK expires
      // pending orders; a later recovery cycle must not rewrite their history.
      // A first discovery is timestamped at this cycle; retries reuse the
      // complete durable signal fact so an economics change cannot conflict
      // with a previously persisted reservation input.
      const submittedAt =
        existing && "fact" in existing
          ? existing.fact.type === "SIGNAL"
            ? existing.fact.order.submittedAt
            : undefined
          : new Date(
              Math.max(
                Date.parse(input.at),
                Date.parse(observation.signalTimestamp),
              ),
            ).toISOString();
      if (!submittedAt) continue;
      const priorInvalidation = [...input.invalidations]
        .filter(
          (invalidation) =>
            invalidation.orderId === observation.id &&
            Date.parse(invalidation.at) <= Date.parse(submittedAt),
        )
        .sort(
          (left, right) =>
            Date.parse(left.at) - Date.parse(right.at) ||
            left.eventId.localeCompare(right.eventId),
        )[0];
      if (existing && "fact" in existing && !priorInvalidation)
        // `outcome` is adapter bookkeeping, not part of the strict inbox
        // envelope. Keep retries byte-for-byte identical while stripping that
        // read-only column before schema validation.
        envelopes.push({ id: existing.id, fact: existing.fact });
      else if (
        existing &&
        "fact" in existing &&
        priorInvalidation &&
        existing.committedOrder
      ) {
        // Keep the original event timestamp. The inbox reconciles the committed
        // reservation atomically before draining any unexecuted quote, while
        // preserving the signal's effects-before-acknowledgement retry.
        const cancellation = buildFundedInvalidationEnvelope(
          priorInvalidation,
          true,
        );
        if (cancellation) {
          envelopes.push({ id: existing.id, fact: existing.fact });
          envelopes.push(cancellation);
          preSubmissionOrderIds.add(observation.id);
        } else skippedObservations += 1;
      } else if (
        existing &&
        "fact" in existing &&
        priorInvalidation &&
        existing.outcome !== null
      )
        envelopes.push({ id: existing.id, fact: existing.fact });
      else if (priorInvalidation) {
        const suppression = buildFundedInvalidationEnvelope(
          priorInvalidation,
          true,
        );
        if (suppression) {
          envelopes.push(suppression);
          preSubmissionOrderIds.add(observation.id);
          // A durable invalidation is an affirmative policy refusal, recorded
          // at the invalidation's own timestamp with the cycle input.
          refusalRequests.push({
            observationId: observation.id,
            action: "DECLINE",
            policyReason: "PRE_SUBMISSION_INVALIDATION",
            decisionAt: new Date(priorInvalidation.at).toISOString(),
          });
        } else skippedObservations += 1;
      } else {
        const boundedExpiry = new Date(
          Math.min(
            Date.parse(input.scheduledCloseAt),
            Date.parse(validityDeadline!),
          ),
        ).toISOString();
        const captured = await loadFundedObservationEvidence(
          this.options.pool,
          this.options.marketId,
          observation,
        );
        const envelope = buildFundedSignalEnvelope(
          captured,
          submittedAt,
          boundedExpiry,
          this.options.assumptions,
          undefined,
          undefined,
          { policy: this.policy },
        );
        if (envelope) envelopes.push(envelope);
        else {
          skippedObservations += 1;
          // The window is still open but the funded execution path cannot
          // construct an executable submission (for example, modeled latency
          // cannot release before expiry). That is an explicit policy decline,
          // retained with the cycle input even though no CANCEL fact exists.
          refusalRequests.push({
            observationId: observation.id,
            action: "DECLINE",
            policyReason: "SIGNAL_NOT_EXECUTABLE",
            decisionAt: submittedAt,
          });
        }
      }
    }
    for (const invalidation of [...input.invalidations].sort(
      (left, right) =>
        Date.parse(left.at) - Date.parse(right.at) ||
        left.eventId.localeCompare(right.eventId),
    )) {
      if (preSubmissionOrderIds.has(invalidation.orderId)) continue;
      const envelope = buildFundedInvalidationEnvelope(invalidation);
      if (envelope) envelopes.push(envelope);
    }
    let skippedQuotes = 0;
    const actionableQuoteInstruments = new Set<string>();
    for (const quote of [...input.quotes].sort(
      (left, right) =>
        Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
        left.instrumentId.localeCompare(right.instrumentId),
    )) {
      const envelope = buildFundedQuoteEnvelope(quote, this.policy);
      if (envelope) {
        envelopes.push(envelope);
        actionableQuoteInstruments.add(quote.instrumentId);
      } else skippedQuotes += 1;
    }
    const coverageGaps = countFundedCoverageGaps(
      input.expectedInstrumentIds ?? [],
      actionableQuoteInstruments,
      skippedObservations + skippedQuotes,
    );
    await this.inbox.enqueue(envelopes, {
      repository: this.evidence,
      refusalRequests,
    });
    // FP01 decision capture happens inside the drain's acknowledgement
    // transaction from durable sources; the drain is the production
    // repair/wiring path between cycles.
    const processed = await this.inbox.drain(budget, {
      repository: this.evidence,
    });
    // Repair decisions whose capture failed while their economics committed,
    // including non-SUBMIT refusals whose durable intent was written first.
    // The durable intent/fact remains the only input, so this is idempotent
    // and does not touch the order/ledger effects.
    let captureFailures = 0;
    let decisionGaps = 0;
    try {
      const repaired = await this.evidence.repairMissingDecisions(
        this.options.runId,
      );
      captureFailures = repaired.failed;
      decisionGaps = repaired.remaining;
      if (repaired.failed > 0)
        this.lastProjectionError ??= "Funded decision repair failed";
    } catch (repairError) {
      captureFailures = 1;
      decisionGaps = Number.MAX_SAFE_INTEGER;
      this.lastProjectionError =
        repairError instanceof Error
          ? repairError.message
          : String(repairError);
    }
    // Outcome projection runs after the economic drain and never participates
    // in it: a projector fault is counted, leaves economics committed and is
    // repaired by a later bounded pass.
    let projectionFailures = 0;
    let outcomeGaps = 0;
    try {
      const projection = await this.projector.projectPending(
        this.options.runId,
      );
      projectionFailures = projection.failed;
      outcomeGaps = projection.remaining;
      this.evidenceProjectionFailures += projection.failed;
    } catch (projectionError) {
      projectionFailures = 1;
      outcomeGaps = Number.MAX_SAFE_INTEGER;
      this.projectionFailures += 1;
      this.evidenceProjectionFailures += 1;
      this.lastProjectionError =
        projectionError instanceof Error
          ? projectionError.message
          : String(projectionError);
    }
    this.coverageGapsTotal += coverageGaps;
    this.lastCycleLatencyMs =
      Math.round((performance.now() - started) * 100) / 100;
    return {
      enqueued: envelopes.length,
      processed,
      skippedObservations,
      skippedQuotes,
      coverageGaps,
      captureFailures,
      projectionFailures,
      decisionGaps,
      outcomeGaps,
    };
  }
}

/** Reads only evidence that was available when the observation was generated. */
export async function loadFundedObservationEvidence(
  pool: Pool,
  marketId: MarketId,
  observation: PaperSignalObservation,
): Promise<PaperSignalObservation> {
  const result = await pool.query<{
    signalKey: string;
    status: "UNAVAILABLE" | "WEAK" | "NEUTRAL" | "STRONG" | "STALE";
    timestamp: Date | string;
  }>(
    `SELECT DISTINCT ON (signal_key) signal_key AS "signalKey", status,
      LEAST(timestamp,COALESCE(benchmark_timestamp,timestamp)) AS timestamp
     FROM context_evaluation WHERE market_id=$1 AND instrument_id=$2 AND timestamp <= $3
       AND (benchmark_timestamp IS NULL OR benchmark_timestamp <= $3)
     ORDER BY signal_key,timestamp DESC,id`,
    [marketId, observation.instrumentId, observation.signalTimestamp],
  );
  return {
    ...observation,
    fundedContexts: result.rows.map((row) => ({
      ...row,
      timestamp: new Date(row.timestamp).toISOString(),
    })),
  };
}

function definedContext(context: SizingContext): SizingContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}
