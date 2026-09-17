import {
  fundedDecisionTimeInputSchema,
  marketIdSchema,
  type FundedDecisionAction,
  type MarketId,
} from "@tsx-scanner/contracts";
import type {
  FundedDecisionDraft,
  FundedDecisionObservation,
  FundedEvidenceQueryable,
  FundedModelEvidenceInput,
} from "./funded-decision-evidence.js";
import {
  buildFundedCohortComponents,
  buildFundedDecisionDraft,
  fundedAccountStateEvidence,
  fundedPolicyVersion,
  participationPolicyVersion,
  type FundedDecisionCaptureContext,
} from "./funded-decision-evidence.js";
import { contentHash } from "./funded-evidence-digest.js";
import { normalizeFundedPolicy, type FundedPolicy } from "./funded-policy.js";
import {
  reconstructFundedLedgerAt,
  type FundedReconstructionObservation,
} from "./funded-ledger-repository.js";
import { finalExitOf } from "./funded-order-service.js";
import { costSnapshotOf } from "./financials.js";
import type { PendingEntryOrder } from "./pending-order.js";
import type { AssumptionsSnapshot, QuoteFact, SizingContext } from "./types.js";

/**
 * Reconstructs one immutable decision-time input from durable sources only.
 *
 * The caller runs this inside the funded run/account transaction at the exact
 * per-signal decision boundary. Nothing is accepted from an in-memory batch
 * snapshot and no version string is defaulted: every identity is read from the
 * durable run, policy, observation or funded inbox row that the decision
 * actually used. A value the sources cannot prove makes the build fail (and the
 * opportunity stays a visible capture gap) rather than being invented.
 */

export interface DurableDecisionInput {
  readonly runId: string;
  /** The funded decision is identified by the durable observation. */
  readonly observationId: string;
  readonly action: FundedDecisionAction;
  /** Exact funded-policy reason for DECLINE/DEFER; null for SUBMIT. */
  readonly policyReason: string | null;
  /**
   * For SUBMIT this is the exact persisted signal submission time. For a
   * policy refusal it is the deterministic boundary that ended the
   * opportunity (durable invalidation time or validity deadline), never the
   * current cycle clock.
   */
  readonly decisionAt: string;
  /**
   * Inclusive durable ledger event-sequence cursor proven at the decision
   * boundary. Events after it (including events that share the decision
   * timestamp) must not enter the immutable portfolio snapshot. The caller
   * owns proof of this cursor; an unprovable boundary fails capture closed.
   */
  readonly boundaryEventSequence: number;
}

interface RunRow {
  market_id: string;
  source: string;
  execution_model_version: string;
  assumptions: AssumptionsSnapshot;
  policy: FundedPolicy | null;
  account_id: string;
}

interface ObservationRow {
  strategy_key: string;
  strategy_version: string;
  score: number;
  reason_codes: unknown;
  feature_snapshot: Record<string, unknown> | null;
  source_event_payload: Record<string, unknown> | null;
  signal_timestamp: Date | string;
  entry_reference: number | string | null;
  stop_reference: number | string | null;
  target_reference: number | string | null;
  atr14: number | string | null;
  instrument_id: string;
}

interface ContextRow {
  signalKey: string;
  status: "UNAVAILABLE" | "WEAK" | "NEUTRAL" | "STRONG" | "STALE";
  timestamp: Date | string;
}

interface QuoteRow {
  timestamp: Date | string;
  bid: number | string;
  ask: number | string;
  bidSize: number | string;
  askSize: number | string;
  sizeUnit: "SHARES" | "BOARD_LOTS" | "UNKNOWN" | null;
  sizeMultiplier: number | string | null;
  isDelayed: boolean;
  isHalted: boolean;
}

interface ModelRow {
  model_id: string;
  model_version: string;
  strategy_name: string;
  input_snapshot: unknown;
  prediction: Record<string, unknown> | null;
  created_at: Date | string;
}

interface SignalFactRow {
  fact: {
    type?: string;
    maximumDebit?: number | string;
    maximumRisk?: number | string;
    order?: {
      assumptions?: AssumptionsSnapshot;
      context?: SizingContext;
      signal?: {
        entryReference: number | null;
        stopReference: number | null;
        targetReference: number | null;
        atr14: number | null;
        signalTimestamp: string;
      };
    };
  };
}

interface OrderHistoryRow {
  instrument_id: string;
  state: PendingEntryOrder;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The durable runtime identity carried by the observation. The funded path has
 * no separately persisted engine revision, so the signal-semantics version the
 * scanner recorded on the event is the only provable runtime provenance.
 */
function observationRuntimeVersion(observation: ObservationRow): string {
  const payload = observation.source_event_payload ?? {};
  const semantics = stringOf(payload.signalSemanticsVersion);
  const lineage = recordOf(payload.replayLineage);
  const lineageType = stringOf(lineage?.type);
  if (!semantics || semantics === "UNKNOWN")
    throw new Error("MISSING_SIGNAL_SEMANTICS_VERSION");
  return contentHash({
    signalSemanticsVersion: semantics,
    replayLineageType: lineageType,
  });
}

function observationFeatureVersion(observation: ObservationRow): string {
  const featureVersion = stringOf(
    (observation.feature_snapshot ?? {}).featureVersion,
  );
  if (!featureVersion) throw new Error("MISSING_FEATURE_VERSION");
  return featureVersion;
}

function sourceKindOf(run: RunRow): "LIVE_PAPER" | "HISTORICAL_REPLAY" {
  if (run.source === "LIVE") return "LIVE_PAPER";
  if (run.source === "BACKTEST") return "HISTORICAL_REPLAY";
  throw new Error("UNSUPPORTED_FUNDED_RUN_SOURCE");
}

async function quoteEvidence(
  client: FundedEvidenceQueryable,
  instrumentId: string,
  decisionAt: string,
): Promise<QuoteFact | null> {
  const { rows } = await client.query<QuoteRow>(
    `SELECT q.timestamp,q.bid::float8,q.ask::float8,q.bid_size::float8 AS "bidSize",
       q.ask_size::float8 AS "askSize",q.size_unit AS "sizeUnit",
       q.size_multiplier::float8 AS "sizeMultiplier",q.is_delayed AS "isDelayed",
       q.is_halted AS "isHalted"
     FROM quote_snapshot q
     WHERE q.instrument_id=$1 AND q.timestamp <= $2::timestamptz
     ORDER BY q.timestamp DESC,q.source
     LIMIT 1`,
    [instrumentId, decisionAt],
  );
  const row = rows[0];
  if (!row) return null;
  const bid = Number(row.bid);
  const ask = Number(row.ask);
  const bidSize = Number(row.bidSize);
  const askSize = Number(row.askSize);
  if (
    ![bid, ask, bidSize, askSize].every(Number.isFinite) ||
    bid <= 0 ||
    ask <= 0
  )
    return null;
  const sizeUnit =
    row.sizeUnit === "SHARES" ||
    row.sizeUnit === "BOARD_LOTS" ||
    row.sizeUnit === "UNKNOWN"
      ? row.sizeUnit
      : null;
  const sizeMultiplier = numberOrNull(row.sizeMultiplier);
  return {
    timestamp: iso(row.timestamp),
    bid,
    ask,
    bidSize,
    askSize,
    sizeUnit: sizeUnit ?? undefined,
    sizeMultiplier: sizeMultiplier ?? undefined,
    dataStatus: row.isHalted
      ? "HALTED"
      : row.isDelayed
        ? "DELAYED"
        : "REALTIME",
    actionable: !row.isHalted && !row.isDelayed,
  };
}

async function modelEvidence(
  client: FundedEvidenceQueryable,
  observationId: string,
  decisionAt: string,
): Promise<FundedModelEvidenceInput | null> {
  const { rows } = await client.query<ModelRow>(
    `SELECT model_id,model_version,strategy_name,input_snapshot,prediction,created_at
     FROM paper_model_prediction_snapshot
     WHERE observation_id=$1 AND created_at <= $2::timestamptz
     ORDER BY created_at DESC,model_id,model_version
     LIMIT 1`,
    [observationId, decisionAt],
  );
  const row = rows[0];
  if (!row) return null;
  const prediction = row.prediction
    ? Number(row.prediction.setupProbability)
    : Number.NaN;
  if (!Number.isFinite(prediction)) return null;
  return {
    modelId: row.model_id,
    modelVersion: row.model_version,
    strategyName: row.strategy_name,
    prediction,
    inputDigest: contentHash(row.input_snapshot ?? null),
    predictionAt: iso(row.created_at),
  };
}

/**
 * Reconstructs the portfolio state used by the funded decision at `at` from
 * the newest provable durable checkpoint plus the ordered ledger events after
 * it. Replay is capped at the proven decision boundary cursor, so events that
 * share the decision timestamp but follow its own reservation (or follow the
 * refusal evaluation) can never enter the snapshot. The caller holds the
 * funded run lock and the account row share lock.
 */
async function portfolioEvidence(
  client: FundedEvidenceQueryable,
  runId: string,
  accountId: string,
  instrumentId: string,
  at: string,
  boundaryEventSequence: number,
  policy: FundedPolicy,
  onReconstruction?: (observation: FundedReconstructionObservation) => void,
): Promise<NonNullable<FundedDecisionCaptureContext["accountState"]>> {
  // The account state used by the decision is the state before this decision's
  // own boundary: a retry or a later repair must reconstruct that same state,
  // not the post-boundary one. A checkpoint whose anchor is after the cursor is
  // rejected by the reconstruction query itself, because filtering query
  // results cannot remove an effect already inside the checkpoint state.
  const { ledger } = await reconstructFundedLedgerAt(client, accountId, at, {
    maxEventSequence: boundaryEventSequence,
    onReconstruction,
  });
  const history = await client.query<OrderHistoryRow>(
    `SELECT DISTINCT ON (h.order_id) o.instrument_id,h.state
     FROM paper_entry_order_history h
     JOIN paper_entry_order o ON o.order_id=h.order_id
     WHERE o.run_id=$1 AND h.fact_at <= $2::timestamptz
     ORDER BY h.order_id,h.revision DESC`,
    [runId, at],
  );
  const portfolio = policy.portfolio;
  let cooldownActive: boolean | null = null;
  let consecutiveStops: number | null = null;
  if (portfolio) {
    const closed = history.rows
      .map((row) => {
        const exit = finalExitOf(row.state);
        return exit && Date.parse(exit.at) <= Date.parse(at)
          ? { ...exit, instrumentId: row.instrument_id }
          : undefined;
      })
      .filter(
        (
          value,
        ): value is { at: string; stopped: boolean; instrumentId: string } =>
          value !== undefined,
      )
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
    const lastStop = closed.find(
      (value) => value.stopped && value.instrumentId === instrumentId,
    );
    cooldownActive =
      lastStop !== undefined &&
      Date.parse(at) <
        Date.parse(lastStop.at) + portfolio.cooldownMinutesAfterStop * 60_000;
    consecutiveStops = 0;
    for (const result of closed) {
      if (!result.stopped) break;
      consecutiveStops += 1;
    }
  }
  return fundedAccountStateEvidence(ledger, at, {
    cooldownActive,
    consecutiveStops,
  });
}

/**
 * Optional decision-time evidence provider. The live and historical paths read
 * the raw quote/context/model tables; the FP03 comparison binds this to its
 * immutable frozen chunks so replay never re-queries a retention-managed source.
 */
export interface FundedDecisionEvidenceSource {
  quote(instrumentId: string, at: string): Promise<QuoteFact | null>;
  contexts(
    marketId: MarketId,
    instrumentId: string,
    at: string,
  ): Promise<readonly FundedDecisionContextInput[]>;
  model(
    observationId: string,
    at: string,
  ): Promise<FundedModelEvidenceInput | null>;
}

export interface FundedDecisionContextInput {
  readonly signalKey: string;
  readonly status: "UNAVAILABLE" | "WEAK" | "NEUTRAL" | "STRONG" | "STALE";
  readonly timestamp: string;
}

export async function buildDurableFundedDecision(
  client: FundedEvidenceQueryable,
  input: DurableDecisionInput,
  onReconstruction?: (observation: FundedReconstructionObservation) => void,
  evidenceSource?: FundedDecisionEvidenceSource,
): Promise<FundedDecisionDraft> {
  if (
    !Number.isSafeInteger(input.boundaryEventSequence) ||
    input.boundaryEventSequence < 0
  )
    throw new Error("MISSING_DECISION_BOUNDARY_SEQUENCE");
  const runRows = await client.query<RunRow>(
    `SELECT r.market_id,r.source,r.execution_model_version,r.assumptions,b.policy,
       b.account_id
     FROM paper_bot_run r JOIN paper_funded_run b ON b.run_id=r.id
     WHERE r.id=$1`,
    [input.runId],
  );
  const run = runRows.rows[0];
  if (!run) throw new Error("Funded decision run not found");
  const marketId = marketIdSchema.parse(run.market_id) as MarketId;
  if (!run.policy) throw new Error("Funded decision run has no bound policy");
  const policy = normalizeFundedPolicy(run.policy);
  const sourceKind = sourceKindOf(run);

  const observationRows = await client.query<ObservationRow>(
    `SELECT strategy_key,strategy_version,score,reason_codes,feature_snapshot,
       source_event_payload,signal_timestamp,entry_reference,stop_reference,
       target_reference,atr_14 AS "atr14",instrument_id
     FROM paper_signal_observation WHERE run_id=$1 AND id=$2`,
    [input.runId, input.observationId],
  );
  const observation = observationRows.rows[0];
  if (!observation) throw new Error("Funded decision observation not found");
  const featureVersion = observationFeatureVersion(observation);
  const runtimeVersion = observationRuntimeVersion(observation);

  const contexts = evidenceSource
    ? (
        await evidenceSource.contexts(
          marketId,
          observation.instrument_id,
          iso(observation.signal_timestamp),
        )
      ).map((context) => ({
        signalKey: context.signalKey,
        status: context.status,
        timestamp: context.timestamp,
      }))
    : (
        await client.query<ContextRow>(
          `SELECT DISTINCT ON (signal_key) signal_key AS "signalKey",status,
       LEAST(timestamp,COALESCE(benchmark_timestamp,timestamp)) AS timestamp
     FROM context_evaluation
     WHERE market_id=$1 AND instrument_id=$2 AND timestamp <= $3::timestamptz
       AND (benchmark_timestamp IS NULL OR benchmark_timestamp <= $3::timestamptz)
     ORDER BY signal_key,timestamp DESC,id`,
          [
            marketId,
            observation.instrument_id,
            iso(observation.signal_timestamp),
          ],
        )
      ).rows.map((row) => ({
        signalKey: row.signalKey,
        status: row.status,
        timestamp: iso(row.timestamp),
      }));

  const factRows: SignalFactRow[] =
    input.action === "SUBMIT"
      ? (
          await client.query<SignalFactRow>(
            "SELECT fact FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
            [input.runId, `funded-signal:${input.observationId}`],
          )
        ).rows
      : [];
  const fact = factRows[0];
  const factOrder = fact?.fact.order;
  const maximumDebit = numberOrNull(fact?.fact.maximumDebit ?? null);
  const maximumRisk = numberOrNull(fact?.fact.maximumRisk ?? null);
  if (input.action === "SUBMIT" && !fact)
    throw new Error("Funded signal decision has no retained SIGNAL fact");
  if (
    input.action === "SUBMIT" &&
    (maximumDebit === null ||
      maximumRisk === null ||
      maximumDebit <= 0 ||
      maximumRisk < 0)
  )
    throw new Error("MISSING_FUNDED_REQUESTED_CAPITAL");

  const assumptions = (factOrder?.assumptions ??
    run.assumptions) as AssumptionsSnapshot;
  const quote = evidenceSource
    ? await evidenceSource.quote(observation.instrument_id, input.decisionAt)
    : await quoteEvidence(client, observation.instrument_id, input.decisionAt);
  const model = evidenceSource
    ? await evidenceSource.model(input.observationId, input.decisionAt)
    : await modelEvidence(client, input.observationId, input.decisionAt);
  const portfolio = await portfolioEvidence(
    client,
    input.runId,
    run.account_id,
    observation.instrument_id,
    input.decisionAt,
    input.boundaryEventSequence,
    policy,
    onReconstruction,
  );

  const decisionObservation: FundedDecisionObservation = {
    id: input.observationId,
    strategyKey: observation.strategy_key,
    strategyVersion: observation.strategy_version,
    score: Number(observation.score),
    reasonCodes: observation.reason_codes,
    fundedContexts: contexts,
  };
  const signal = factOrder?.signal ?? {
    entryReference: numberOrNull(observation.entry_reference),
    stopReference: numberOrNull(observation.stop_reference),
    targetReference: numberOrNull(observation.target_reference),
    atr14: numberOrNull(observation.atr14),
    signalTimestamp: iso(observation.signal_timestamp),
  };

  const decision = buildFundedDecisionDraft({
    observation: decisionObservation,
    order: {
      signal,
      assumptions,
      context: factOrder?.context,
      submittedAt: input.decisionAt,
    },
    requestedCapital:
      input.action === "SUBMIT"
        ? { maximumDebit: maximumDebit!, maximumRisk: maximumRisk! }
        : null,
    quote,
    context: {
      marketId,
      accountId: run.account_id,
      runId: input.runId,
      sourceKind,
      fundedPolicyVersion: fundedPolicyVersion(policy),
      executionModelVersion: run.execution_model_version,
      featureVersion,
      runtimeVersion,
      costPolicyVersion: costSnapshotOf(assumptions).brokerPricingVersion,
      participationVersion: participationPolicyVersion(policy),
      policy,
      accountState: portfolio,
      model,
    },
    action: input.action,
    policyReason: input.policyReason,
  });
  fundedDecisionTimeInputSchema.parse(decision);
  return {
    decision,
    cohort: buildFundedCohortComponents({
      marketId,
      sourceKind,
      fundedPolicyVersion: fundedPolicyVersion(policy),
      portfolioPolicyVersion:
        policy.portfolio?.version ?? "NO_PORTFOLIO_POLICY",
      executionModelVersion: run.execution_model_version,
      costPolicyVersion: costSnapshotOf(assumptions).brokerPricingVersion,
      participationVersion: participationPolicyVersion(policy),
      featureVersion,
      runtimeVersion,
      assumptions,
      signalModelId: model?.modelId ?? null,
      signalModelVersion: model?.modelVersion ?? null,
    }),
  };
}
