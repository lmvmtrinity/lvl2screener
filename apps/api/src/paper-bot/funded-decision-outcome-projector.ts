import type { Pool } from "pg";
import {
  fundedDecisionTimeInputSchema,
  type FundedOutcomeStatus,
} from "@tsx-scanner/contracts";
import {
  FundedDecisionEvidenceRepository,
  type PersistedOutcomeVersion,
} from "./funded-decision-evidence-repository.js";
import type { LedgerEvent } from "./funded-ledger.js";
import type { PendingEntryOrder } from "./pending-order.js";

interface FactRow {
  fact_id: string;
  outcome: Record<string, unknown> | null;
  processed_at: Date | string | null;
}

interface OrderRow {
  state: PendingEntryOrder;
  last_fact_id: string | null;
}

interface EventRow {
  event: LedgerEvent;
  event_sequence: number;
  fact_id: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Legacy version-1 decision content cannot satisfy the version-2 schema
 * (requested capital and the evidence marker are absent), but its stored action
 * and policy reason stay authoritative for projection. Nothing is defaulted:
 * a legacy row without a valid stored action fails visibly.
 */
function legacyDecisionIdentity(decision: {
  action: string;
  decision_content: unknown;
}): { action: "SUBMIT" | "DECLINE" | "DEFER"; policyReason: string | null } {
  const content = recordOf(decision.decision_content);
  const action =
    decision.action === "SUBMIT" ||
    decision.action === "DECLINE" ||
    decision.action === "DEFER"
      ? decision.action
      : undefined;
  if (!action) throw new Error("Legacy funded decision has no retained action");
  return { action, policyReason: stringOf(content?.policyReason) };
}

/**
 * Reasons that mean no executable quote existed. The distinction keeps
 * "the market was not executable" (NO_EXECUTABLE_QUOTE) separate from
 * "the quote was executable but no fill followed" (NO_FILL).
 */
const NON_EXECUTABLE_REASONS = new Set([
  "MISSING_QUOTE",
  "HALTED",
  "DELAYED",
  "STALE",
  "UNKNOWN_QUOTE_SIZE",
]);

interface AppendDraft {
  status: FundedOutcomeStatus;
  availableAt: string;
  sourceId: string;
  reason: string | null;
  detail: unknown;
  supersedesSequence?: number | null;
  /**
   * Exact durable funded fact that made this version knowable. It is persisted
   * only for historical-replay decisions; a version without one stays
   * unavailable to replay training.
   */
  sourceFactId?: string | null;
}

/**
 * Projects durable funded facts, order state and ledger events into
 * append-only outcome versions. Every source identity is a durable fact,
 * order or ledger identity; nothing is derived from the wall clock or query
 * order. The projector runs after economic transactions commit and never
 * participates in them, so a projector fault cannot roll back or block
 * economics, exits or recovery.
 *
 * Lifecycle-aware: a decision is revisited for as long as it has durable
 * sources without a version. A pending inbox fact or a still-open order is
 * deliberately not an outcome, and re-running any projection is idempotent per
 * durable source identity.
 */
export class FundedDecisionOutcomeProjector {
  constructor(
    private readonly pool: Pool,
    private readonly repository: FundedDecisionEvidenceRepository = new FundedDecisionEvidenceRepository(
      pool,
    ),
  ) {}

  async project(
    runId: string,
    observationId: string,
  ): Promise<PersistedOutcomeVersion[]> {
    const decision = await this.repository.findDecision(runId, observationId);
    if (!decision)
      throw new Error("No funded decision exists for this outcome");
    const content =
      decision.evidence_schema_version >= 2
        ? fundedDecisionTimeInputSchema.parse(decision.decision_content)
        : undefined;
    const legacy = content ? undefined : legacyDecisionIdentity(decision);
    const action = content?.action ?? legacy?.action;
    const policyReason = content?.policyReason ?? legacy?.policyReason ?? null;
    const capturedAt = iso(decision.captured_at);
    const versions: PersistedOutcomeVersion[] = [];
    const append = async (draft: AppendDraft) => {
      versions.push(
        await this.repository.appendOutcomeVersion({
          runId,
          observationId,
          status: draft.status,
          availableAt: draft.availableAt,
          sourceKind: decision.source_kind,
          sourceId: draft.sourceId,
          reason: draft.reason,
          detail: draft.detail,
          supersedesSequence: draft.supersedesSequence ?? null,
          // Live capture uses its database clock; only a historical replay may
          // name a causal fact, and only the exact one that made it knowable.
          sourceFactId:
            decision.source_kind === "HISTORICAL_REPLAY"
              ? (draft.sourceFactId ?? null)
              : null,
        }),
      );
    };

    if (action === "DECLINE" || action === "DEFER") {
      const declined = action === "DECLINE";
      const reason =
        policyReason ??
        (declined
          ? "Funded policy declined the decision"
          : "Funded policy deferred the decision");
      await append({
        status: declined ? "POLICY_DECLINED" : "POLICY_DEFERRED",
        availableAt: capturedAt,
        sourceId: `decision:${observationId}:${declined ? "declined" : "deferred"}`,
        reason,
        detail: declined ? { declineReason: reason } : { deferReason: reason },
      });
      return versions;
    }

    const facts = await this.pool.query<FactRow>(
      `SELECT fact_id,outcome,processed_at FROM paper_funded_fact
       WHERE run_id=$1 AND fact_id=$2`,
      [runId, `funded-signal:${observationId}`],
    );
    const fact = facts.rows[0];
    const orderRows = await this.pool.query<OrderRow>(
      "SELECT state,last_fact_id FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
      [runId, observationId],
    );
    const order = orderRows.rows[0]?.state;
    const orderFactId = orderRows.rows[0]?.last_fact_id ?? null;
    if (fact?.outcome) {
      const factStatus = stringOf(fact.outcome.status) ?? "UNKNOWN";
      const availableAt = fact.processed_at
        ? iso(fact.processed_at)
        : capturedAt;
      if (factStatus === "RISK_VETO") {
        const vetoes = Array.isArray(fact.outcome.vetoes)
          ? fact.outcome.vetoes
          : [];
        const first = recordOf(vetoes[0]);
        const reason =
          stringOf(first?.reason) ?? "Funded deterministic risk veto";
        await append({
          status: "RISK_VETOED",
          availableAt,
          sourceId: `fact:${fact.fact_id}:veto`,
          reason,
          detail: { vetoReason: reason },
          sourceFactId: fact.fact_id,
        });
      } else if (factStatus === "PRE_SUBMISSION_SUPPRESSED") {
        await append({
          status: "POLICY_DECLINED",
          availableAt,
          sourceId: `fact:${fact.fact_id}:suppressed`,
          reason:
            "Durable pre-submission invalidation suppressed the submission",
          detail: { declineReason: "PRE_SUBMISSION_INVALIDATION" },
          sourceFactId: fact.fact_id,
        });
      } else if (factStatus === "APPLIED") {
        await append({
          status: "DECISION_ACCEPTED",
          availableAt,
          sourceId: `fact:${fact.fact_id}:accepted`,
          reason: null,
          detail: null,
          sourceFactId: fact.fact_id,
        });
      }
    } else if (!fact && !order) {
      await append({
        status: "UNRESOLVED",
        availableAt: capturedAt,
        sourceId: `decision:${observationId}:unresolved`,
        reason: "No durable funded signal fact or order was retained",
        detail: null,
      });
      return versions;
    }

    if (order)
      await this.projectOrder(runId, observationId, order, orderFactId, append);
    return versions;
  }

  /**
   * Bounded repair pass. It selects decisions whose durable fact/order/ledger
   * sources are not yet represented and reprojects them; per-source appends
   * are idempotent, so already-projected versions are not duplicated.
   */
  async projectPending(
    runId: string,
    limit = 50,
  ): Promise<{ projected: number; failed: number; remaining: number }> {
    const candidates = await this.repository.listProjectionCandidates(
      runId,
      limit,
    );
    let projected = 0;
    let failed = 0;
    for (const decision of candidates) {
      try {
        await this.project(decision.runId, decision.observationId);
        projected += 1;
      } catch {
        failed += 1;
      }
    }
    const remaining = await this.repository.projectionGapCount(runId);
    return { projected, failed, remaining };
  }

  private async projectOrder(
    runId: string,
    observationId: string,
    order: PendingEntryOrder,
    orderFactId: string | null,
    append: (draft: AppendDraft) => Promise<void>,
  ): Promise<void> {
    const events = await this.pool.query<EventRow>(
      `SELECT e.event,e.event_sequence,e.fact_id FROM paper_funded_event e
       JOIN paper_funded_run r ON r.account_id=e.account_id
       WHERE r.run_id=$1 AND (e.event->>'orderId'=$2 OR e.event->>'positionId'=$2)
       ORDER BY e.event_sequence`,
      [runId, observationId],
    );
    // Exact causal fact of each retained ledger event. Order-state-only
    // outcomes fall back to the fact that last changed the order; a version
    // with neither source stays unavailable to replay training.
    const eventFactById = new Map(
      events.rows.map((row) => [row.event.id, row.fact_id]),
    );
    const ledgerSource = (eventId: string | undefined) =>
      (eventId ? eventFactById.get(eventId) : null) ?? orderFactId;
    const buy = events.rows
      .map((row) => row.event)
      .find(
        (event): event is Extract<LedgerEvent, { type: "BUY" }> =>
          event.type === "BUY",
      );
    const sells = events.rows
      .map((row) => row.event)
      .filter(
        (event): event is Extract<LedgerEvent, { type: "SELL" }> =>
          event.type === "SELL",
      );
    const execution = order.execution;
    const position =
      execution !== null &&
      (execution.status === "OPEN" ||
        execution.status === "CLOSE_PENDING" ||
        execution.status === "CLOSED") &&
      "position" in execution
        ? execution.position
        : undefined;
    if (buy || position) {
      const filledShares = buy?.shares ?? position?.shares ?? 0;
      const coverage =
        execution &&
        (execution.status === "OPEN" ||
          execution.status === "CLOSE_PENDING" ||
          execution.status === "CLOSED")
          ? execution.entrySizeCoverage
          : 1;
      const requestedShares = Math.max(
        filledShares,
        Math.round(
          filledShares / (coverage > 0 && coverage <= 1 ? coverage : 1),
        ),
      );
      const fraction =
        requestedShares > 0 ? Math.min(1, filledShares / requestedShares) : 0;
      const entryPrice = buy?.price ?? position?.entryPrice ?? Number.NaN;
      const stop = position?.stop ?? Number.NaN;
      const detail = {
        filledFraction: fraction,
        filledShares,
        requestedShares,
        averagePrice: entryPrice,
        fees: buy?.fee ?? 0,
        slippage: buy
          ? Math.abs(buy.price - (order.signal.entryReference ?? buy.price))
          : 0,
      };
      if (fraction < 1 && filledShares > 0 && requestedShares > filledShares)
        await append({
          status: "PARTIAL_FILL",
          availableAt: buy ? iso(buy.at) : order.submittedAt,
          sourceId: `ledger:${buy?.id ?? `${observationId}:entry`}`,
          reason: null,
          detail,
          sourceFactId: ledgerSource(buy?.id),
        });
      else
        await append({
          status: "FILLED",
          availableAt: buy ? iso(buy.at) : order.submittedAt,
          sourceId: `ledger:${buy?.id ?? `${observationId}:entry`}`,
          reason: null,
          detail: {
            ...detail,
            filledFraction: 1,
            filledShares: requestedShares,
          },
          sourceFactId: ledgerSource(buy?.id),
        });
      if (execution?.status === "CLOSED" && sells.length > 0) {
        const entryFee = buy?.fee ?? 0;
        const realized = sells.reduce(
          (total, sell) =>
            total + (sell.price - entryPrice) * sell.shares - sell.fee,
          0,
        );
        const netPnl = Math.round((realized - entryFee) * 10_000) / 10_000;
        const initialRisk =
          Number.isFinite(stop) && Number.isFinite(entryPrice)
            ? Math.abs(entryPrice - stop) * (position?.shares ?? filledShares)
            : 0;
        const lastSell = sells[sells.length - 1]!;
        await append({
          status: "CLOSED",
          availableAt: iso(lastSell.at),
          sourceId: `ledger:${lastSell.id}`,
          reason: null,
          detail: {
            filledFraction: fraction,
            realizedNetPnl: netPnl,
            realizedR:
              initialRisk > 0
                ? Math.round((netPnl / initialRisk) * 1_000_000) / 1_000_000
                : null,
          },
          sourceFactId: ledgerSource(lastSell.id),
        });
      }
      return;
    }
    if (order.status === "CANCELLED") {
      if (order.reason === "EXPIRED" || order.reason === "SESSION_CLOSED") {
        if (order.lastQuoteAt === null)
          // No quote ever reached the order: the opportunity expired without
          // an executable market. That is a distinct label from a market that
          // was executable but produced no fill.
          await append({
            status: "NO_EXECUTABLE_QUOTE",
            availableAt: order.expiresAt,
            sourceId: `order:${observationId}:no-executable-quote`,
            reason: "No executable quote was retained before expiry",
            detail: { detailReason: "NO_EXECUTABLE_QUOTE_RETAINED" },
            sourceFactId: orderFactId,
          });
        else
          await append({
            status: "EXPIRED",
            availableAt: order.lastQuoteAt,
            sourceId: `order:${observationId}:expired`,
            reason:
              order.reason === "EXPIRED"
                ? "Pending entry order expired"
                : "Session closed before entry",
            detail: null,
            sourceFactId: orderFactId,
          });
      } else if (order.reason === "RISK_VETO")
        await append({
          status: "RISK_VETOED",
          availableAt: order.lastQuoteAt ?? order.submittedAt,
          sourceId: `order:${observationId}:risk-veto`,
          reason: "Funded risk veto cancelled the order",
          detail: { vetoReason: "ORDER_CANCELLED_RISK_VETO" },
          sourceFactId: orderFactId,
        });
      else {
        const reason = order.reason ?? "UNKNOWN";
        await append({
          status: "NO_FILL",
          availableAt: order.lastQuoteAt ?? order.submittedAt,
          sourceId: `order:${observationId}:cancelled`,
          reason: `Order cancelled before fill: ${reason}`,
          detail: { noFillReason: `ORDER_CANCELLED_${reason}` },
          sourceFactId: orderFactId,
        });
      }
      return;
    }
    if (order.status === "REJECTED") {
      if (execution?.status === "NO_FILL") {
        if (NON_EXECUTABLE_REASONS.has(execution.noFillReason))
          await append({
            status: "NO_EXECUTABLE_QUOTE",
            availableAt: order.lastQuoteAt ?? order.submittedAt,
            sourceId: `order:${observationId}:no-executable-quote`,
            reason: `No executable quote: ${execution.noFillReason}`,
            detail: { detailReason: execution.noFillReason },
            sourceFactId: orderFactId,
          });
        else
          await append({
            status: "NO_FILL",
            availableAt: order.lastQuoteAt ?? order.submittedAt,
            sourceId: `order:${observationId}:no-fill`,
            reason: `No fill: ${execution.noFillReason}`,
            detail: { noFillReason: execution.noFillReason },
            sourceFactId: orderFactId,
          });
      } else if (execution?.status === "REJECTED_ECONOMICS")
        await append({
          status: "POLICY_DECLINED",
          availableAt: order.lastQuoteAt ?? order.submittedAt,
          sourceId: `order:${observationId}:economics`,
          reason: `Economics gate: ${execution.economicsReason}`,
          detail: { declineReason: execution.economicsReason },
          sourceFactId: orderFactId,
        });
      else
        await append({
          status: "UNRESOLVED",
          availableAt: order.submittedAt,
          sourceId: `order:${observationId}:rejected`,
          reason: "Order rejected without a retained execution reason",
          detail: null,
          sourceFactId: orderFactId,
        });
      return;
    }
    // A pending order has no terminal outcome yet; appending UNRESOLVED here
    // would fabricate a result. Later quotes, fills or exits revisit it.
  }
}
