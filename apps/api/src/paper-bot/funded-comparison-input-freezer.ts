import {
  createBacktestSchema,
  inputItemOrderKey,
  replayInputSnapshotSchema,
  type BacktestRun,
  type CreateBacktest,
  type FundedComparisonContextEntry,
  type FundedComparisonInputChunk,
  type FundedComparisonInputItem,
  type FundedComparisonReplayProfile,
  type FundedComparisonSourceOpportunity,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { ReplaySessionPolicy } from "../backtests/backtest-repository.js";
import {
  admitReplayQuotes,
  admitReplaySession,
  type ReplayQuoteLike,
} from "../backtests/replay-quote-admission.js";
import {
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  marketSessionTimezone,
} from "../backtests/execution-provenance.js";
import { FundedComparisonSpecificationError } from "./funded-comparison-specification.js";
import {
  backtestBaselineResultDigest,
  fundedComparisonChunkDigest,
  fundedComparisonInputItemDigest,
  fundedComparisonSessionInputDigest,
} from "./funded-comparison-digest.js";
import {
  buildFundedHistoricalObservations,
  fundedHistoricalConfigVersion,
  fundedHistoricalProfiles,
  type FundedHistoricalProfile,
  type FundedHistoricalSignalEngine,
} from "./funded-historical-signal-bridge.js";
import { planFundedHistoricalRange } from "./funded-historical-range-plan.js";
import { normalizedQuoteSize } from "./normalized-quote-size.js";
import type { InsertObservationInput } from "./paper-bot-repository.js";
import { zonedSessionBoundary } from "./session-time.js";
import { stableUuid } from "./stable-uuid.js";

/**
 * Freezes the complete policy-neutral shared exogenous stream for one or more
 * sessions of a completed retained baseline into immutable comparison-owned
 * input chunks. Replay reads only these rows: raw `quote_snapshot`,
 * `candle`, `strategy_state_event` and `context_evaluation` rows are
 * retention-managed and must never be re-queried once the specification is
 * frozen.
 */

export interface FundedComparisonBaselineStore {
  get(id: string): Promise<BacktestRun | undefined>;
  loadReplaySessionDates(
    input: CreateBacktest,
    replayInput: ReturnType<typeof replayInputSnapshotSchema.parse>,
    policy?: ReplaySessionPolicy,
  ): Promise<string[]>;
  loadReplaySession(
    replayInput: ReturnType<typeof replayInputSnapshotSchema.parse>,
    policy: ReplaySessionPolicy,
    sessionDate: string,
  ): Promise<
    Record<string, unknown> & {
      readonly quotes?: readonly ReplayQuoteLike[];
      readonly candles?: readonly unknown[];
      readonly session?: { readonly instruments?: readonly unknown[] };
    }
  >;
}

export interface FundedComparisonFreezeInput {
  readonly baselineRunId: string;
  readonly marketId: MarketId;
  readonly evidenceCutoffAt: string;
  readonly maxSessions: number;
  readonly replayPolicy: ReplaySessionPolicy;
}

export interface FundedComparisonFreezeDependencies {
  readonly pool: Pool;
  readonly store: FundedComparisonBaselineStore;
  readonly engine: FundedHistoricalSignalEngine;
}

export interface FundedComparisonFrozenSession {
  readonly sessionDate: string;
  readonly sessionStartAt: string;
  readonly scheduledCloseAt: string;
  readonly sessionTimezone: "America/Toronto" | "America/New_York";
  readonly itemCount: number;
  readonly chunkCount: number;
  readonly sessionInputDigest: string;
  readonly items: readonly FundedComparisonInputItem[];
  readonly chunks: readonly FundedComparisonInputChunk[];
  readonly opportunities: readonly FundedComparisonSourceOpportunity[];
}

export interface FundedComparisonFrozenInput {
  readonly baseline: {
    backtestRunId: string;
    configVersion: string;
    strategyKeys: string[];
    startDate: string;
    endDate: string;
    executionModelVersion: string;
    replayInputDigest: string;
    baselineResultDigest: string;
    completedAt: string;
  };
  /**
   * Comparison-owned immutable replay configuration. Later replay reads this
   * payload only and never re-reads mutable `backtest_run` configuration.
   */
  readonly replay: {
    readonly request: CreateBacktest;
    readonly profiles: readonly FundedComparisonReplayProfile[];
  };
  readonly request: CreateBacktest;
  readonly profiles: readonly FundedHistoricalProfile[];
  readonly sessionDates: readonly string[];
  readonly sessions: readonly FundedComparisonFrozenSession[];
  readonly opportunities: readonly FundedComparisonSourceOpportunity[];
  readonly lastInputEffectiveAt: string;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function observationFeatureVersion(
  observation: InsertObservationInput,
): string {
  const snapshot = observation.featureSnapshot as
    { featureVersion?: unknown } | null | undefined;
  const version = snapshot?.featureVersion;
  if (typeof version !== "string" || version.trim() === "")
    throw new FundedComparisonSpecificationError(
      "REPLAY_LINEAGE_UNAVAILABLE",
      `Source opportunity ${observation.sourceEventId} has no retained feature version`,
    );
  return version;
}

export interface FundedComparisonContextRow {
  readonly signalKey: string;
  readonly status: "UNAVAILABLE" | "WEAK" | "NEUTRAL" | "STRONG" | "STALE";
  readonly timestamp: Date | string;
  readonly benchmarkTimestamp: Date | string | null;
}

export interface FundedComparisonQuoteRow {
  readonly instrumentId: string;
  readonly timestamp: Date | string;
  readonly bid: number | string;
  readonly ask: number | string;
  readonly bidSize: number | string;
  readonly askSize: number | string;
  readonly sizeUnit: "SHARES" | "BOARD_LOTS" | "UNKNOWN" | null;
  readonly sizeMultiplier: number | string | null;
  readonly isDelayed: boolean;
  readonly isHalted: boolean;
  readonly source: string;
}

export interface FundedComparisonInvalidationRow {
  readonly eventId: string;
  readonly instrumentId: string;
  readonly setupInstanceId: string | null;
  readonly at: Date | string;
}

/**
 * Loads the exact context evidence the decision-time capture would have read at
 * `signalTimestamp`, using the same `DISTINCT ON (signal_key)` semantics, so the
 * frozen item reproduces the decision input byte-for-byte.
 */
export async function loadFundedComparisonContexts(
  pool: Pool,
  marketId: MarketId,
  instrumentId: string,
  signalTimestamp: string,
): Promise<FundedComparisonContextEntry[]> {
  const { rows } = await pool.query<FundedComparisonContextRow>(
    `SELECT DISTINCT ON (signal_key) signal_key AS "signalKey",status,
       timestamp,benchmark_timestamp AS "benchmarkTimestamp"
     FROM context_evaluation
     WHERE market_id=$1 AND instrument_id=$2 AND timestamp <= $3::timestamptz
       AND (benchmark_timestamp IS NULL OR benchmark_timestamp <= $3::timestamptz)
     ORDER BY signal_key,timestamp DESC,id`,
    [marketId, instrumentId, signalTimestamp],
  );
  return rows
    .map((row) => ({
      signalKey: row.signalKey,
      status: row.status,
      timestamp: iso(row.timestamp),
      benchmarkTimestamp:
        row.benchmarkTimestamp === null ? null : iso(row.benchmarkTimestamp),
    }))
    .sort((left, right) => left.signalKey.localeCompare(right.signalKey));
}

export async function loadFundedComparisonSessionQuotes(
  pool: Pool,
  marketId: MarketId,
  instrumentIds: readonly string[],
  sessionDate: string,
  sessionTimezone: string,
  scheduledCloseAt: string,
): Promise<FundedComparisonQuoteRow[]> {
  if (instrumentIds.length === 0) return [];
  const { rows } = await pool.query<FundedComparisonQuoteRow>(
    `SELECT q.instrument_id AS "instrumentId",q.timestamp,q.bid::float8,q.ask::float8,
       q.bid_size::float8 AS "bidSize",q.ask_size::float8 AS "askSize",
       q.size_unit AS "sizeUnit",q.size_multiplier::float8 AS "sizeMultiplier",
       q.is_delayed AS "isDelayed",q.is_halted AS "isHalted",q.source
     FROM quote_snapshot q
     JOIN instrument i ON i.id=q.instrument_id AND i.market_id=$1
     WHERE q.instrument_id=ANY($2::uuid[])
       AND q.timestamp >= ($3::date AT TIME ZONE $4)
       AND q.timestamp <= $5::timestamptz
     ORDER BY q.timestamp,q.instrument_id,q.source`,
    [marketId, instrumentIds, sessionDate, sessionTimezone, scheduledCloseAt],
  );
  return rows;
}

export async function loadFundedComparisonSessionInvalidations(
  pool: Pool,
  instrumentIds: readonly string[],
  sessionStartAt: string,
  scheduledCloseAt: string,
): Promise<FundedComparisonInvalidationRow[]> {
  if (instrumentIds.length === 0) return [];
  const { rows } = await pool.query<FundedComparisonInvalidationRow>(
    `SELECT e.id AS "eventId",e.instrument_id AS "instrumentId",
       e.setup_instance_id AS "setupInstanceId",e.timestamp AS at
     FROM strategy_state_event e
     WHERE e.new_state='INVALIDATED'
       AND e.instrument_id=ANY($1::uuid[])
       AND e.timestamp >= $2::timestamptz
       AND e.timestamp <= $3::timestamptz
     ORDER BY e.timestamp,e.id`,
    [instrumentIds, sessionStartAt, scheduledCloseAt],
  );
  return rows;
}

export interface FundedComparisonSessionProjectionInput {
  readonly baselineRunId: string;
  readonly sessionDate: string;
  readonly sessionStartAt: string;
  readonly scheduledCloseAt: string;
  readonly sessionTimezone: "America/Toronto" | "America/New_York";
  readonly observations: readonly InsertObservationInput[];
  readonly quotes: readonly FundedComparisonQuoteRow[];
  readonly invalidations: readonly FundedComparisonInvalidationRow[];
  readonly contextsFor: (
    observation: InsertObservationInput,
  ) => readonly FundedComparisonContextEntry[];
}

export interface FundedComparisonSessionProjection {
  readonly items: readonly FundedComparisonInputItem[];
  readonly opportunities: readonly FundedComparisonSourceOpportunity[];
}

function normalizedFundedComparisonQuotes(
  rows: readonly FundedComparisonQuoteRow[],
): Extract<FundedComparisonInputItem, { kind: "QUOTE" }>[] {
  const projected = rows.map((quote) => {
    const size = normalizedQuoteSize(quote.sizeUnit, quote.sizeMultiplier);
    return {
      kind: "QUOTE" as const,
      instrumentId: quote.instrumentId,
      timestamp: iso(quote.timestamp),
      bid: Number(quote.bid),
      ask: Number(quote.ask),
      bidSize: Number(quote.bidSize),
      askSize: Number(quote.askSize),
      sizeUnit:
        size.sizeUnit === "SHARES" ? ("SHARES" as const) : ("UNKNOWN" as const),
      sizeMultiplier: size.sizeMultiplier ?? 1,
      dataStatus: quote.isHalted
        ? ("HALTED" as const)
        : quote.isDelayed
          ? ("DELAYED" as const)
          : ("REALTIME" as const),
      actionable: !quote.isHalted && !quote.isDelayed,
      source: quote.source,
    };
  });
  const admitted = admitReplayQuotes(projected).admitted;
  const byEconomicTime = new Map<string, (typeof admitted)[number][]>();
  for (const quote of admitted) {
    const key = `${quote.instrumentId}:${quote.timestamp}`;
    const matches = byEconomicTime.get(key) ?? [];
    matches.push(quote);
    byEconomicTime.set(key, matches);
  }
  const normalized: Extract<FundedComparisonInputItem, { kind: "QUOTE" }>[] =
    [];
  for (const matches of byEconomicTime.values()) {
    matches.sort((left, right) => left.source.localeCompare(right.source));
    const selected = matches[0]!;
    const economicIdentity = ({ source: _source, ...quote }: typeof selected) =>
      JSON.stringify(quote);
    const selectedIdentity = economicIdentity(selected);
    if (matches.some((quote) => economicIdentity(quote) !== selectedIdentity))
      throw new FundedComparisonSpecificationError(
        "RETAINED_INPUT_MISSING",
        `Conflicting retained quote sources for ${selected.instrumentId} at ${selected.timestamp}`,
      );
    normalized.push(selected);
  }
  return normalized.sort((left, right) =>
    inputItemOrderKey(left).localeCompare(inputItemOrderKey(right)),
  );
}

/**
 * Pure projection of one session's retained evidence into canonical ordered
 * policy-neutral items. Source identity is derived from the baseline run and the
 * source event, never from a destination run or account.
 */
export function projectFundedComparisonSessionItems(
  input: FundedComparisonSessionProjectionInput,
): FundedComparisonSessionProjection {
  const items: FundedComparisonInputItem[] = [
    {
      kind: "SESSION_BOUNDARY",
      sessionDate: input.sessionDate,
      sessionStartAt: input.sessionStartAt,
      scheduledCloseAt: input.scheduledCloseAt,
      sessionTimezone: input.sessionTimezone,
    },
  ];
  const ordered = [...input.observations].sort((left, right) => {
    const byTime =
      Date.parse(left.signalTimestamp) - Date.parse(right.signalTimestamp);
    return byTime !== 0
      ? byTime
      : left.sourceEventId.localeCompare(right.sourceEventId);
  });
  const opportunities: FundedComparisonSourceOpportunity[] = [];
  const opportunityByKey = new Map<string, FundedComparisonSourceOpportunity>();
  ordered.forEach((observation, index) => {
    const sourceOpportunityId = stableUuid(
      `funded-comparison-source-opportunity:${input.baselineRunId}:${observation.sourceEventId}`,
    );
    const sourceOrdinal = index + 1;
    const contexts = [...input.contextsFor(observation)];
    const item: FundedComparisonInputItem = {
      kind: "OPPORTUNITY",
      sourceOpportunityId,
      sessionDate: input.sessionDate,
      sourceOrdinal,
      sourceEventId: observation.sourceEventId,
      setupInstanceId: observation.setupInstanceId ?? observation.sourceEventId,
      instrumentId: observation.instrumentId,
      symbol: observation.symbol,
      profileConfigId: observation.profileConfigId,
      strategyKey: observation.strategyKey,
      strategyVersion: observation.strategyVersion,
      score: observation.score,
      eligibilityStatus: observation.eligibilityStatus,
      eligibilityReason: observation.eligibilityReason,
      signalTimestamp: iso(observation.signalTimestamp),
      signalSemanticsVersion:
        (observation.sourceEventPayload as { signalSemanticsVersion?: string })
          .signalSemanticsVersion ?? "",
      observationFeatureVersion: observationFeatureVersion(observation),
      entryReference: observation.entryReference,
      stopReference: observation.stopReference,
      targetReference: observation.targetReference,
      atr14: observation.atr14,
      reasonCodes: Array.isArray(observation.reasonCodes)
        ? (observation.reasonCodes as string[]).filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      sourceEventPayload: observation.sourceEventPayload,
      featureSnapshot: observation.featureSnapshot,
      contexts,
    };
    items.push(item);
    const opportunity: FundedComparisonSourceOpportunity = {
      sourceOpportunityId,
      sessionDate: input.sessionDate,
      sourceOrdinal,
      sourceEventId: observation.sourceEventId,
      setupInstanceId: observation.setupInstanceId ?? observation.sourceEventId,
      instrumentId: observation.instrumentId,
      profileConfigId: observation.profileConfigId,
      signalTimestamp: iso(observation.signalTimestamp),
      sourceContentDigest: fundedComparisonInputItemDigest(item),
    };
    opportunities.push(opportunity);
    opportunityByKey.set(
      `${observation.instrumentId}:${observation.setupInstanceId ?? observation.sourceEventId}`,
      opportunity,
    );
  });
  for (const invalidation of input.invalidations) {
    const match = opportunityByKey.get(
      `${invalidation.instrumentId}:${invalidation.setupInstanceId}`,
    );
    if (!match) continue;
    const at = iso(invalidation.at);
    if (Date.parse(at) < Date.parse(match.signalTimestamp)) continue;
    items.push({
      kind: "INVALIDATION",
      eventId: invalidation.eventId,
      sourceOpportunityId: match.sourceOpportunityId,
      at,
    });
  }
  items.push(...normalizedFundedComparisonQuotes(input.quotes));
  items.push({
    kind: "SESSION_BOUNDARY",
    sessionDate: input.sessionDate,
    sessionStartAt: input.scheduledCloseAt,
    scheduledCloseAt: input.scheduledCloseAt,
    sessionTimezone: input.sessionTimezone,
  });
  return { items, opportunities };
}

/**
 * Canonical chunking of one session's item stream. The complete stream is
 * sorted by the canonical `(effective time, kind rank, identity)` key before it
 * is sliced, so chunk boundaries never split the order and adjacent chunks stay
 * monotone across the boundary.
 */
export function chunkFundedComparisonItems(
  sessionDate: string,
  items: readonly FundedComparisonInputItem[],
): FundedComparisonInputChunk[] {
  const ordered = [...items].sort((left, right) => {
    const leftKey = inputItemOrderKey(left);
    const rightKey = inputItemOrderKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const chunks: FundedComparisonInputChunk[] = [];
  for (let offset = 0; offset < ordered.length; offset += 1_000) {
    const slice = ordered.slice(offset, offset + 1_000);
    const entries = slice.map((item) => ({
      itemDigest: fundedComparisonInputItemDigest(item),
      item,
    }));
    const chunkOrdinal = chunks.length + 1;
    const firstEffectiveAt = itemEffectiveAt(slice[0]!);
    const lastEffectiveAt = itemEffectiveAt(slice[slice.length - 1]!);
    chunks.push({
      sessionDate,
      chunkOrdinal,
      itemCount: entries.length,
      firstEffectiveAt,
      lastEffectiveAt,
      chunkDigest: fundedComparisonChunkDigest({
        sessionDate,
        chunkOrdinal,
        firstEffectiveAt,
        lastEffectiveAt,
        itemDigests: entries.map((entry) => entry.itemDigest),
      }),
      items: entries,
    });
  }
  return chunks;
}

function itemEffectiveAt(item: FundedComparisonInputItem): string {
  switch (item.kind) {
    case "SESSION_BOUNDARY":
      return item.sessionStartAt;
    case "OPPORTUNITY":
      return item.signalTimestamp;
    case "QUOTE":
      return item.timestamp;
    case "INVALIDATION":
      return item.at;
  }
}

export function sessionInputDigestOf(
  sessionDate: string,
  chunks: readonly FundedComparisonInputChunk[],
): string {
  return fundedComparisonSessionInputDigest({
    sessionDate,
    chunkDigests: chunks.map((chunk) => chunk.chunkDigest),
    itemCount: chunks.reduce((total, chunk) => total + chunk.itemCount, 0),
  });
}

/**
 * Materializes the complete shared stream from the retained baseline. This is
 * the only FP03 path allowed to read raw source tables, and it runs before
 * `specificationFrozenAt`.
 */
export async function freezeFundedComparisonSharedInput(
  input: FundedComparisonFreezeInput,
  deps: FundedComparisonFreezeDependencies,
): Promise<FundedComparisonFrozenInput> {
  const run = await deps.store.get(input.baselineRunId);
  if (
    !run ||
    run.status !== "COMPLETED" ||
    !run.completedAt ||
    !run.replayInput ||
    !run.metrics ||
    !run.dataQuality
  )
    throw new FundedComparisonSpecificationError(
      "BASELINE_LINEAGE_UNAVAILABLE",
      "The comparison baseline is not a completed, lineage-retained backtest run",
    );
  if (run.marketId !== input.marketId)
    throw new FundedComparisonSpecificationError(
      "MARKET_CURRENCY_MISMATCH",
      "The baseline belongs to another market",
    );
  const replayInput = replayInputSnapshotSchema.parse(run.replayInput);
  if (replayInput.marketId !== run.marketId)
    throw new FundedComparisonSpecificationError(
      "MARKET_CURRENCY_MISMATCH",
      "The retained replay input belongs to another market",
    );
  const request = createBacktestSchema.parse({
    name: run.name,
    marketId: run.marketId,
    startDate: run.startDate,
    endDate: run.endDate,
    strategies: run.strategies,
    symbols: run.symbols,
    startingCapital: run.startingCapital,
    positionSize: run.positionSize,
    slippageBps: run.slippageBps,
    feePerTrade: run.feePerTrade,
    parameters: run.parameters,
  });
  const sessionDates = planFundedHistoricalRange(
    await deps.store.loadReplaySessionDates(
      request,
      replayInput,
      input.replayPolicy,
    ),
    input.maxSessions,
  );
  if (sessionDates.length === 0)
    throw new FundedComparisonSpecificationError(
      "SESSION_MEMBERSHIP_MISMATCH",
      "The baseline retains no eligible replay session",
    );
  const timezone = marketSessionTimezone(run.marketId);
  const configVersion = fundedHistoricalConfigVersion(request.parameters);
  const profiles = fundedHistoricalProfiles(
    run.marketId,
    request.strategies,
    configVersion,
  );
  const sessions: FundedComparisonFrozenSession[] = [];
  const allOpportunities: FundedComparisonSourceOpportunity[] = [];
  let lastInputEffectiveAt = "";
  for (const sessionDate of sessionDates) {
    const sessionStartAt = zonedSessionBoundary(sessionDate, "09:30", timezone);
    const scheduledCloseAt = zonedSessionBoundary(
      sessionDate,
      input.replayPolicy.scanning.end,
      timezone,
    );
    const session = await deps.store.loadReplaySession(
      replayInput,
      input.replayPolicy,
      sessionDate,
    );
    const admitted = admitReplaySession(session);
    const replay = await deps.engine.runBacktestSignals({
      runId: run.id,
      marketId: run.marketId,
      configVersion,
      strategies: request.strategies,
      parameters: request.parameters,
      assumptions: {
        startingCapital: request.startingCapital,
        positionSize: request.positionSize,
        slippageBps: request.slippageBps,
        feePerTrade: request.feePerTrade,
      },
      sessions: [admitted],
    });
    const observations = buildFundedHistoricalObservations({
      runId: run.id,
      profiles,
      events: replay.events,
      parameters: request.parameters,
      scoreCutoff: request.parameters.scoreCutoff,
    }).filter((observation) => observation.eligibilityStatus === "ELIGIBLE");
    const instrumentIds = [
      ...new Set(observations.map((observation) => observation.instrumentId)),
    ];
    const [quotes, invalidations, contexts] = await Promise.all([
      loadFundedComparisonSessionQuotes(
        deps.pool,
        run.marketId,
        instrumentIds,
        sessionDate,
        timezone,
        scheduledCloseAt,
      ),
      loadFundedComparisonSessionInvalidations(
        deps.pool,
        instrumentIds,
        sessionStartAt,
        scheduledCloseAt,
      ),
      Promise.all(
        observations.map((observation) =>
          loadFundedComparisonContexts(
            deps.pool,
            run.marketId,
            observation.instrumentId,
            observation.signalTimestamp,
          ),
        ),
      ),
    ]);
    const contextsByIndex = new Map(
      observations.map((observation, index) => [observation, contexts[index]!]),
    );
    const projection = projectFundedComparisonSessionItems({
      baselineRunId: run.id,
      sessionDate,
      sessionStartAt,
      scheduledCloseAt,
      sessionTimezone: timezone,
      observations,
      quotes,
      invalidations,
      contextsFor: (observation) => contextsByIndex.get(observation) ?? [],
    });
    const chunks = chunkFundedComparisonItems(sessionDate, projection.items);
    const sessionInputDigest = sessionInputDigestOf(sessionDate, chunks);
    for (const item of projection.items) {
      const at = itemEffectiveAt(item);
      if (at > lastInputEffectiveAt) lastInputEffectiveAt = at;
    }
    sessions.push({
      sessionDate,
      sessionStartAt,
      scheduledCloseAt,
      sessionTimezone: timezone,
      itemCount: projection.items.length,
      chunkCount: chunks.length,
      sessionInputDigest,
      items: projection.items,
      chunks,
      opportunities: projection.opportunities,
    });
    allOpportunities.push(...projection.opportunities);
  }
  if (lastInputEffectiveAt > input.evidenceCutoffAt)
    throw new FundedComparisonSpecificationError(
      "SOURCE_CUTOFF_AFTER_FREEZE",
      "Retained source input is effective after the requested evidence cutoff",
    );
  const replayProfiles: FundedComparisonReplayProfile[] = profiles.map(
    (profile) => ({
      strategyKey: profile.strategy,
      profileId: profile.profileId,
      profileName: profile.profileName,
      profileConfigId: profile.profileConfigId,
      configVersion: profile.configVersion,
    }),
  );
  return {
    baseline: {
      backtestRunId: run.id,
      configVersion: run.configVersion,
      strategyKeys: [...run.strategies],
      startDate: run.startDate,
      endDate: run.endDate,
      executionModelVersion:
        run.executionModelVersion ?? AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      replayInputDigest: replayInput.inputHash,
      baselineResultDigest: backtestBaselineResultDigest(run),
      completedAt: iso(run.completedAt),
    },
    replay: { request, profiles: replayProfiles },
    request,
    profiles,
    sessionDates,
    sessions,
    opportunities: allOpportunities,
    lastInputEffectiveAt,
  };
}
