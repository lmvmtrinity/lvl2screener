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
import type {
  DecisionRefusalRequest,
  FundedDecisionWorkWatermark,
} from "./funded-decision-evidence-repository.js";
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

/** Operational snapshot gap counters are recomputed at most once per minute. */
const GAP_COUNT_TTL_MS = 60_000;

/**
 * A bounded interval after which the decision repair and projection passes run
 * even when the durable work watermark did not move, so projection work driven
 * only by order or ledger transitions is never deferred indefinitely.
 */
const WORK_WATERMARK_FULL_PASS_MS = 60_000;

function sameRepairWorkWatermark(
  left: FundedDecisionWorkWatermark | null,
  right: FundedDecisionWorkWatermark | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.evidenceSequence === right.evidenceSequence &&
    left.intentCount === right.intentCount &&
    left.refusalCount === right.refusalCount &&
    left.signalAppliedSequence === right.signalAppliedSequence &&
    left.eligibleObservationCount === right.eligibleObservationCount
  );
}

function sameProjectionWorkWatermark(
  left: FundedDecisionWorkWatermark | null,
  right: FundedDecisionWorkWatermark | null,
): boolean {
  return (
    sameRepairWorkWatermark(left, right) &&
    left?.outcomeTransitionRevision === right?.outcomeTransitionRevision
  );
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
  /**
   * Durable evidence gap counters are expensive scans; the operational
   * snapshot reuses them for a bounded interval and refreshes immediately
   * after a failed or capped repair/projection pass.
   */
  private gapCountsCache: {
    at: number;
    decision: number;
    outcome: number;
  } | null = null;
  private lifetimeCountsCache: {
    at: number;
    risk: number;
    late: number;
  } | null = null;
  /**
   * Last observed decision-work watermark plus the cleanliness of the passes
   * that ran against it. A cycle skips the repair and projection candidate
   * reads only while the watermark is unchanged, the last pass was clean and
   * the bounded full-pass interval has not elapsed.
   */
  private workWatermark: FundedDecisionWorkWatermark | null = null;
  private repairClean = false;
  private projectionClean = false;
  private lastFullWorkPassAt = 0;

  /** Visible count of FP01 outcome-projection faults; repair is idempotent. */
  projectionFailureCount(): number {
    return this.projectionFailures;
  }

  lastProjectionFailure(): string | null {
    return this.lastProjectionError;
  }

  /** Force the next operational snapshot to recompute durable gap counters. */
  private invalidateGapCounts(): void {
    this.gapCountsCache = null;
  }

  private async readGapCounts(
    observedAt: number,
  ): Promise<{ decision: number; outcome: number }> {
    const cached = this.gapCountsCache;
    if (cached && observedAt - cached.at < GAP_COUNT_TTL_MS) return cached;
    const [decision, outcome] = await Promise.all([
      this.evidence.decisionGapCount(this.options.runId),
      this.evidence.projectionGapCount(this.options.runId),
    ]);
    const next = { at: observedAt, decision, outcome };
    this.gapCountsCache = next;
    return next;
  }

  private async readLifetimeCounts(
    observedAt: number,
  ): Promise<{ risk: number; late: number }> {
    const cached = this.lifetimeCountsCache;
    if (cached && observedAt - cached.at < GAP_COUNT_TTL_MS) return cached;
    const result = await this.options.pool.query<{
      risk: string | number;
      late: string | number;
    }>(
      `WITH runs AS MATERIALIZED (
         SELECT fb.run_id FROM paper_funded_run fb
         JOIN paper_bot_run r ON r.id=fb.run_id
         WHERE fb.account_id=$1 AND fb.currency=$2 AND r.market_id=$3
       )
       SELECT count(*) FILTER (WHERE f.outcome->>'status'='RISK_VETO') AS risk,
              count(*) FILTER (WHERE f.outcome->>'status'='LATE_FACT') AS late
       FROM paper_funded_fact f JOIN runs ON runs.run_id=f.run_id
       WHERE f.outcome->>'status' IN ('RISK_VETO','LATE_FACT')`,
      [this.options.accountId, this.options.currency, this.options.marketId],
    );
    const next = {
      at: observedAt,
      risk: Number(result.rows[0]?.risk ?? 0),
      late: Number(result.rows[0]?.late ?? 0),
    };
    this.lifetimeCountsCache = next;
    return next;
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

  private async existingObservationFacts(observationIds: string[]): Promise<
    Map<
      string,
      {
        existing?:
          | (FundedFactEnvelope & {
              outcome: { status?: string } | null;
              committedOrder: boolean;
              pendingOrder: boolean;
            })
          | { suppressed: true };
        staleCancellation?: FundedFactEnvelope;
      }
    >
  > {
    if (observationIds.length === 0) return new Map();
    const result = await this.options.pool.query<{
      observationId: string;
      fact: FundedFactEnvelope["fact"] | null;
      outcome: { status?: string } | null;
      committedOrder: boolean;
      pendingOrder: boolean;
      staleFact: FundedFactEnvelope["fact"] | null;
    }>(
      `WITH ids AS (SELECT unnest($2::text[]) AS observation_id)
       SELECT ids.observation_id AS "observationId", existing.fact,
              existing.outcome,
              EXISTS (SELECT 1 FROM paper_entry_order o
                      WHERE o.run_id=$1 AND o.order_id=ids.observation_id) AS "committedOrder",
              EXISTS (SELECT 1 FROM paper_entry_order o
                      WHERE o.run_id=$1 AND o.order_id=ids.observation_id
                        AND o.state->>'status'='PENDING') AS "pendingOrder",
              stale.fact AS "staleFact"
       FROM ids
       LEFT JOIN LATERAL (
         SELECT fact,outcome FROM paper_funded_fact
         WHERE run_id=$1 AND (
           fact_id='funded-signal:' || ids.observation_id OR
           (fact->>'type'='CANCEL' AND fact->>'orderId'=ids.observation_id
             AND fact->'preSubmissionEventId' IS NOT NULL)
         )
         ORDER BY CASE WHEN fact_id='funded-signal:' || ids.observation_id THEN 0 ELSE 1 END
         LIMIT 1
       ) existing ON true
       LEFT JOIN paper_funded_fact stale
         ON stale.run_id=$1
        AND stale.fact_id='funded-invalidation:stale-signal:' || ids.observation_id
        AND stale.fact->>'type'='CANCEL'`,
      [this.options.runId, observationIds],
    );
    const facts = new Map<
      string,
      {
        existing?:
          | (FundedFactEnvelope & {
              outcome: { status?: string } | null;
              committedOrder: boolean;
              pendingOrder: boolean;
            })
          | { suppressed: true };
        staleCancellation?: FundedFactEnvelope;
      }
    >();
    for (const row of result.rows) {
      const existing = !row.fact
        ? undefined
        : row.outcome?.status === "PRE_SUBMISSION_SUPPRESSED" ||
            row.fact.type !== "SIGNAL"
          ? ({ suppressed: true } as const)
          : {
              id: `funded-signal:${row.observationId}`,
              fact: row.fact,
              outcome: row.outcome,
              committedOrder: row.committedOrder,
              pendingOrder: row.pendingOrder,
            };
      facts.set(row.observationId, {
        existing,
        staleCancellation:
          row.staleFact?.type === "CANCEL"
            ? {
                id: `funded-invalidation:stale-signal:${row.observationId}`,
                fact: row.staleFact,
              }
            : undefined,
      });
    }
    return facts;
  }

  async operationalSnapshot(at: string): Promise<FundedOperationalSnapshot> {
    const observedAt = Date.parse(at);
    if (!Number.isFinite(observedAt))
      throw new Error("Invalid funded operational snapshot time");
    const result = await this.options.pool.query<{
      closePendingOrders: string | number;
      oldestClosePendingAt: Date | string | null;
      pendingFacts: string | number;
      oldestPendingAt: Date | string | null;
      factsArrived5m: string | number;
      factsDrained5m: string | number;
    }>(
      `WITH runs AS MATERIALIZED (
         SELECT fb.run_id FROM paper_funded_run fb
         JOIN paper_bot_run r ON r.id=fb.run_id
         WHERE fb.account_id=$1 AND fb.currency=$2 AND r.market_id=$3
       ), facts AS (
         SELECT count(*) AS pending,
                min(f.fact_at) AS oldest
         FROM paper_funded_fact f JOIN runs ON runs.run_id=f.run_id
         WHERE f.outcome IS NULL
       ), rates AS (
         SELECT COALESCE(sum(f.enqueued_count),0) AS arrived,
                COALESCE(sum(f.processed_count),0) AS drained
         FROM paper_funded_fact_rate_minute f JOIN runs ON runs.run_id=f.run_id
         WHERE f.bucket_at >= date_trunc('minute',now()) - interval '4 minutes'
       ), orders AS (
         SELECT count(*) FILTER (WHERE o.state->'execution'->>'status'='CLOSE_PENDING') AS pending,
                min(o.close_pending_at) FILTER (WHERE o.state->'execution'->>'status'='CLOSE_PENDING') AS oldest
         FROM paper_entry_order o JOIN runs ON runs.run_id=o.run_id
       )
       SELECT facts.pending AS "pendingFacts", facts.oldest AS "oldestPendingAt",
              rates.arrived AS "factsArrived5m", rates.drained AS "factsDrained5m",
              orders.pending AS "closePendingOrders", orders.oldest AS "oldestClosePendingAt"
       FROM facts CROSS JOIN rates CROSS JOIN orders`,
      [this.options.accountId, this.options.currency, this.options.marketId],
    );
    const row = result.rows[0];
    const oldest = row?.oldestClosePendingAt
      ? row.oldestClosePendingAt instanceof Date
        ? row.oldestClosePendingAt.getTime()
        : Date.parse(row.oldestClosePendingAt)
      : Number.NaN;
    // Durable gaps are derived from the database so a restart cannot erase the
    // visibility of missing capture or unprojected outcomes. The counters are
    // recomputed at most once per minute; a failed repair or projection pass
    // invalidates the cache immediately.
    const [gapCounts, lifetimeCounts] = await Promise.all([
      this.readGapCounts(observedAt),
      this.readLifetimeCounts(observedAt),
    ]);
    const evidenceDecisionGapsTotal = gapCounts.decision;
    const evidenceOutcomeGapsTotal = gapCounts.outcome;
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
      riskVetoesTotal: lifetimeCounts.risk,
      coverageGapsTotal: lifetimeCounts.late + this.coverageGapsTotal,
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
    const existingFacts = await this.existingObservationFacts(
      input.observations.map((observation) => observation.id),
    );
    for (const observation of [...input.observations].sort(
      (left, right) =>
        Date.parse(left.signalTimestamp) - Date.parse(right.signalTimestamp) ||
        left.id.localeCompare(right.id),
    )) {
      const { existing, staleCancellation } =
        existingFacts.get(observation.id) ?? {};
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
    // The repair and projection passes read durable candidate sets. A cheap
    // per-run watermark lets a quiet cycle prove those sets are unchanged
    // instead of rebuilding them; a read failure fails open into a full pass.
    let workWatermark: FundedDecisionWorkWatermark | null = null;
    try {
      workWatermark = await this.evidence.decisionWorkWatermark(
        this.options.runId,
      );
    } catch {
      workWatermark = null;
    }
    const repairWatermarkChanged =
      workWatermark !== null &&
      !sameRepairWorkWatermark(this.workWatermark, workWatermark);
    const projectionWatermarkChanged =
      workWatermark !== null &&
      !sameProjectionWorkWatermark(this.workWatermark, workWatermark);
    const forcedFullPass =
      Date.now() - this.lastFullWorkPassAt >= WORK_WATERMARK_FULL_PASS_MS;
    // Repair decisions whose capture failed while their economics committed,
    // including non-SUBMIT refusals whose durable intent was written first.
    // The durable intent/fact remains the only input, so this is idempotent
    // and does not touch the order/ledger effects.
    const runRepair =
      workWatermark === null ||
      repairWatermarkChanged ||
      !this.repairClean ||
      forcedFullPass;
    let captureFailures = 0;
    let decisionGaps = 0;
    if (runRepair) {
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
    }
    this.repairClean = captureFailures === 0 && decisionGaps === 0;
    // Outcome projection runs after the economic drain and never participates
    // in it: a projector fault is counted, leaves economics committed and is
    // repaired by a later bounded pass.
    const runProjection =
      workWatermark === null ||
      projectionWatermarkChanged ||
      !this.projectionClean ||
      forcedFullPass;
    let projectionFailures = 0;
    let outcomeGaps = 0;
    if (runProjection) {
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
    }
    this.projectionClean = projectionFailures === 0 && outcomeGaps === 0;
    if (runRepair || runProjection) {
      if (workWatermark !== null) this.workWatermark = workWatermark;
      // Only a pass that executed both bodies resets the forced-pass anchor,
      // so a persistently unclean single pass cannot starve the other.
      if (forcedFullPass || (runRepair && runProjection))
        this.lastFullWorkPassAt = Date.now();
    }
    if (
      captureFailures > 0 ||
      projectionFailures > 0 ||
      decisionGaps > 0 ||
      outcomeGaps > 0
    )
      this.invalidateGapCounts();
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
