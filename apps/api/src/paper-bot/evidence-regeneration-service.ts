import { normalizedQuoteSize } from "./normalized-quote-size.js";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  setupStrategyNameSchema,
  type MarketId,
  type SetupStrategyName,
  type StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";
import { admitReplaySession } from "../backtests/replay-quote-admission.js";
import { PostgresPaperBotStore } from "./paper-bot-repository.js";
import { PostgresPaperExecutionStore } from "./paper-execution-repository.js";
import { regenerateSessionEvidence } from "./evidence-regeneration.js";
import { zonedSessionBoundary } from "./session-time.js";
import type { AssumptionsSnapshot, CandleFact, QuoteFact } from "./types.js";
import type { PaperSignalObservation } from "./paper-bot-repository.js";

export type EvidenceRegenerationMode = "FILL_ONLY" | "CORRECTED_STRATEGY";

export interface CorrectedStrategyReplayEngine {
  runBacktestSignals(payload: unknown): Promise<{
    events: readonly StrategyStateEvent[];
    dataQuality: unknown;
  }>;
}

interface RawQuoteRow {
  instrumentId: string;
  symbol: string;
  sector: string | null;
  timestamp: Date | string;
  bid: number | string;
  ask: number | string;
  bidSize: number | string;
  askSize: number | string;
  spread: number | string;
  last: number | string;
  dayOpen: number | string;
  dayHigh: number | string;
  dayLow: number | string;
  volume: number | string;
  dataStatus: QuoteFact["dataStatus"];
  actionable: boolean;
  delaySeconds: number | null;
}

interface RawCandleRow {
  instrumentId: string;
  symbol: string;
  timeframe: "OneMinute" | "FiveMinutes" | "OneDay";
  start: Date | string;
  end: Date | string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
  isComplete: boolean;
}

interface SourceRun {
  marketId: MarketId;
  sessionDate: string;
  timezone: string;
  closeAt: Date;
  assumptions: AssumptionsSnapshot;
  version: string;
  status: string;
}

interface CorrectedProfile {
  strategy: SetupStrategyName;
  profileId: string;
  profileName: string;
  profileConfigId: string;
  configVersion: string;
  profileParameters: Record<string, unknown>;
}

function poolFor(client: PoolClient): Pool {
  const query = client.query.bind(client);
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool;
}

function groupByInstrument<Fact extends { instrumentId: string }>(
  facts: Fact[],
): Map<string, Fact[]> {
  const grouped = new Map<string, Fact[]>();
  for (const fact of facts) {
    const existing = grouped.get(fact.instrumentId);
    if (existing) existing.push(fact);
    else grouped.set(fact.instrumentId, [fact]);
  }
  return grouped;
}

export class EvidenceRegenerationService {
  constructor(
    private readonly pool: Pool,
    private readonly correctedStrategyEngine?: CorrectedStrategyReplayEngine,
  ) {}

  /**
   * Regenerates a chronological set of paper sessions. Each session keeps its
   * own immutable source/replacement lineage and its own 45-day candle
   * context, so a missing interval cannot be hidden by a neighboring session.
   * The aggregate is intentionally a coordination result rather than a new
   * paper run: the existing paper-run schema is session-scoped and research
   * qualification consumes the resulting replacement observations together.
   */
  async runMany(
    sourceRunIds: readonly string[],
    apply = false,
  ): Promise<{
    mode: "CORRECTED_STRATEGY";
    sourceRunIds: readonly string[];
    applied: boolean;
    sessionResults: readonly unknown[];
  }> {
    const requestedIds = [...sourceRunIds];
    if (
      requestedIds.length < 2 ||
      requestedIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id)) ||
      new Set(requestedIds).size !== requestedIds.length
    )
      throw new Error(
        "Multi-session corrected regeneration requires at least two distinct run UUIDs",
      );
    const selected = await this.pool.query<{
      id: string;
      marketId: MarketId;
      timezone: string;
      sessionDate: string;
    }>(
      `SELECT id,market_id AS "marketId",session_timezone AS timezone,session_date::text AS "sessionDate"
       FROM paper_bot_run WHERE id=ANY($1::uuid[])`,
      [requestedIds],
    );
    if (selected.rows.length !== requestedIds.length)
      throw new Error(
        "Multi-session corrected regeneration source run missing",
      );
    const first = selected.rows[0]!;
    if (
      selected.rows.some(
        (row) =>
          row.marketId !== first.marketId || row.timezone !== first.timezone,
      )
    )
      throw new Error(
        "Multi-session corrected regeneration requires one market and session timezone",
      );
    const dates = new Set(selected.rows.map((row) => row.sessionDate));
    if (dates.size !== selected.rows.length)
      throw new Error(
        "Multi-session corrected regeneration requires distinct session dates",
      );
    const ids = selected.rows
      .sort(
        (left, right) =>
          left.sessionDate.localeCompare(right.sessionDate) ||
          left.id.localeCompare(right.id),
      )
      .map((row) => row.id);
    const sessionResults: unknown[] = [];
    for (const runId of ids)
      sessionResults.push(await this.run(runId, apply, "CORRECTED_STRATEGY"));
    return {
      mode: "CORRECTED_STRATEGY",
      sourceRunIds: ids,
      applied: apply,
      sessionResults,
    };
  }

  async run(
    sourceRunId: string,
    apply = false,
    mode: EvidenceRegenerationMode = "FILL_ONLY",
  ) {
    const client = await this.pool.connect();
    let locked = false;
    try {
      if (apply) {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
          `paper-regeneration:${sourceRunId}`,
        ]);
        locked = true;
      }
      await client.query(
        apply
          ? "BEGIN ISOLATION LEVEL REPEATABLE READ"
          : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const requestDigest = createHash("sha256")
        .update(
          JSON.stringify([
            sourceRunId,
            AUTHORITATIVE_EXECUTION_MODEL_VERSION,
            mode,
          ]),
        )
        .digest("hex");
      const existing = await client.query<{
        replacementRunId: string;
        report: unknown;
      }>(
        'SELECT replacement_run_id AS "replacementRunId",report FROM paper_evidence_regeneration WHERE request_digest=$1',
        [requestDigest],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { ...existing.rows[0], reused: true };
      }
      const selected = await client.query<SourceRun>(
        `SELECT market_id AS "marketId",session_date::text AS "sessionDate",session_timezone AS timezone,
          scheduled_close_at AS "closeAt",assumptions,execution_model_version AS version,status
          FROM paper_bot_run WHERE id=$1`,
        [sourceRunId],
      );
      const source = selected.rows[0];
      if (!source) throw new Error("Source run not found");
      if (source.status === "RUNNING")
        throw new Error(
          "Finish source collection before regenerating evidence",
        );
      const facade = poolFor(client);
      const observationsStore = new PostgresPaperBotStore(facade);
      const ids = await client.query<{ id: string }>(
        "SELECT id FROM paper_signal_observation WHERE run_id=$1 ORDER BY signal_timestamp,id",
        [sourceRunId],
      );
      const observations: PaperSignalObservation[] = [];
      for (const { id } of ids.rows) {
        const observation = await observationsStore.findObservationById(id);
        if (!observation) throw new Error("Source observation disappeared");
        observations.push(observation);
      }
      if (mode === "CORRECTED_STRATEGY") {
        return await this.runCorrectedStrategy({
          client,
          sourceRunId,
          source,
          observations,
          requestDigest,
          apply,
        });
      }
      const quotes = await client.query<
        QuoteFact & { instrumentId: string; timestamp: string }
      >(
        `SELECT q.instrument_id AS "instrumentId",q.timestamp,q.bid::float8,q.ask::float8,
          q.bid_size::float8 AS "bidSize",q.ask_size::float8 AS "askSize",q.size_unit AS "sizeUnit",q.size_multiplier::float8 AS "sizeMultiplier",
          CASE WHEN q.is_halted THEN 'HALTED' WHEN q.is_delayed THEN 'DELAYED' ELSE 'REALTIME' END AS "dataStatus",
          NOT(q.is_halted OR q.is_delayed) AS actionable
         FROM quote_snapshot q JOIN paper_bot_run r ON r.id=$1
         WHERE q.instrument_id IN (SELECT instrument_id FROM paper_signal_observation WHERE run_id=$1)
           AND q.timestamp >= (r.session_date::timestamp AT TIME ZONE r.session_timezone)
           AND q.timestamp < ((r.session_date+1)::timestamp AT TIME ZONE r.session_timezone)
         ORDER BY q.timestamp,q.instrument_id`,
        [sourceRunId],
      );
      const candles = await client.query<CandleFact & { instrumentId: string }>(
        `SELECT c.instrument_id AS "instrumentId",c.start_time AS start,c.end_time AS "end",
          c.open::float8,c.high::float8,c.low::float8,c.close::float8
         FROM candle c JOIN paper_bot_run r ON r.id=$1
         WHERE c.instrument_id IN (SELECT instrument_id FROM paper_signal_observation WHERE run_id=$1)
           AND c.timeframe='OneMinute' AND c.is_complete
           AND c.start_time >= (r.session_date::timestamp AT TIME ZONE r.session_timezone)
           AND c.end_time <= r.scheduled_close_at
         ORDER BY c.start_time,c.instrument_id`,
        [sourceRunId],
      );
      const quoteFacts = quotes.rows.map((quote) => ({
        ...quote,
        ...normalizedQuoteSize(quote.sizeUnit, quote.sizeMultiplier),
        timestamp: new Date(quote.timestamp).toISOString(),
      }));
      const candleFacts = candles.rows.map((candle) => ({
        ...candle,
        start: new Date(candle.start).toISOString(),
        end: new Date(candle.end).toISOString(),
      }));
      const assumptions = {
        ...source.assumptions,
        latencyMs: 0,
        evidenceScope: "FILL_ONLY_ORIGINAL_SIGNALS",
      };
      const inputDigest = createHash("sha256")
        .update(
          JSON.stringify({
            observations,
            quoteFacts,
            candleFacts,
            assumptions,
          }),
        )
        .digest("hex");
      const report = regenerateSessionEvidence({
        originalRunId: sourceRunId,
        sessionDate: source.sessionDate,
        marketId: source.marketId,
        observations,
        quotesByInstrument: groupByInstrument(quoteFacts),
        candlesByInstrument: groupByInstrument(candleFacts),
        assumptions,
        isLegacyFillAuthority:
          !source.version || source.version.startsWith("legacy-"),
      });
      if (!apply) {
        await client.query("COMMIT");
        return {
          report,
          inputDigest,
          evidenceScope: assumptions.evidenceScope,
          applied: false,
          mode,
        };
      }
      if (report.reproducibility !== "REPRODUCIBLE")
        throw new Error(`Cannot regenerate: ${report.reproducibility}`);
      const replacement = await observationsStore.startBacktestRun({
        source: "BACKTEST",
        marketId: source.marketId,
        sessionDate: source.sessionDate,
        sessionTimezone: source.timezone,
        scheduledCloseAt: source.closeAt.toISOString(),
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const executions = new PostgresPaperExecutionStore(facade);
      const summaries = new Map(
        report.executions.map((execution) => [
          execution.observationId,
          execution,
        ]),
      );
      for (const original of observations) {
        const { observation } = await observationsStore.insertObservation({
          ...original,
          runId: replacement.id,
        });
        const replayed = summaries.get(original.id);
        if (replayed) {
          await executions.upsertQuoteExecution(
            observation.id,
            replayed.quoteState,
          );
          await executions.upsertCandleExecution(
            observation.id,
            replayed.candleState,
          );
        }
      }
      await observationsStore.completeRun(replacement.id);
      await client.query(
        `INSERT INTO paper_evidence_regeneration
        (source_run_id,replacement_run_id,request_digest,mode,input_digest,report) VALUES ($1,$2,$3,'FILL_ONLY',$4,$5)`,
        [
          sourceRunId,
          replacement.id,
          requestDigest,
          inputDigest,
          JSON.stringify(report),
        ],
      );
      await client.query("COMMIT");
      return {
        replacementRunId: replacement.id,
        report,
        inputDigest,
        evidenceScope: assumptions.evidenceScope,
        applied: true,
        mode,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      try {
        if (locked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            [`paper-regeneration:${sourceRunId}`],
          );
      } finally {
        client.release(locked);
      }
    }
  }

  private async runCorrectedStrategy(input: {
    client: PoolClient;
    sourceRunId: string;
    source: SourceRun;
    observations: readonly PaperSignalObservation[];
    requestDigest: string;
    apply: boolean;
  }) {
    if (!this.correctedStrategyEngine)
      throw new Error(
        "Corrected strategy regeneration requires a configured scanner replay engine",
      );
    if (input.observations.length === 0)
      throw new Error(
        "Corrected strategy regeneration requires retained strategy provenance",
      );

    const instrumentIds = [
      ...new Set(
        input.observations.map((observation) => observation.instrumentId),
      ),
    ];
    const sessionStart = zonedSessionBoundary(
      input.source.sessionDate,
      "09:30",
      input.source.timezone,
    );
    const sessionEnd = zonedSessionBoundary(
      input.source.sessionDate,
      "16:00",
      input.source.timezone,
    );
    const [quotes, candles, instruments] = await Promise.all([
      input.client.query<RawQuoteRow>(
        `SELECT q.instrument_id AS "instrumentId",i.symbol,i.industry_sector AS sector,
           q.timestamp,q.bid::float8,q.ask::float8,q.bid_size::float8 AS "bidSize",
           q.ask_size::float8 AS "askSize",q.spread_absolute::float8 AS spread,
           q.last::float8,q.day_open::float8 AS "dayOpen",q.day_high::float8 AS "dayHigh",
           q.day_low::float8 AS "dayLow",q.day_volume::float8 AS volume,
           CASE WHEN q.is_halted THEN 'HALTED' WHEN q.is_delayed THEN 'DELAYED' ELSE 'REALTIME' END AS "dataStatus",
           NOT(q.is_halted OR q.is_delayed) AS actionable,q.delay_seconds AS "delaySeconds"
         FROM quote_snapshot q JOIN instrument i ON i.id=q.instrument_id
         WHERE q.instrument_id=ANY($1::uuid[])
           AND q.timestamp >= ($2::date AT TIME ZONE $3)
           AND q.timestamp < (($2::date + INTERVAL '1 day') AT TIME ZONE $3)
         ORDER BY q.timestamp,q.instrument_id`,
        [instrumentIds, input.source.sessionDate, input.source.timezone],
      ),
      input.client.query<RawCandleRow>(
        `SELECT c.instrument_id AS "instrumentId",i.symbol,c.timeframe,
           c.start_time AS start,c.end_time AS "end",c.open::float8,c.high::float8,
           c.low::float8,c.close::float8,c.volume::float8,c.is_complete AS "isComplete"
         FROM candle c JOIN instrument i ON i.id=c.instrument_id
         WHERE c.instrument_id=ANY($1::uuid[])
           AND c.start_time >= (($2::date - INTERVAL '45 days') AT TIME ZONE $3)
           AND c.end_time < (($2::date + INTERVAL '1 day') AT TIME ZONE $3)
           AND c.is_complete
         ORDER BY c.end_time,c.instrument_id`,
        [instrumentIds, input.source.sessionDate, input.source.timezone],
      ),
      input.client.query<{
        id: string;
        symbol: string;
        sector: string | null;
      }>(
        "SELECT id,symbol,industry_sector AS sector FROM instrument WHERE id=ANY($1::uuid[]) ORDER BY symbol",
        [instrumentIds],
      ),
    ]);
    if (quotes.rows.length === 0 || candles.rows.length === 0)
      throw new Error(
        "Corrected strategy regeneration requires retained quotes and completed candles",
      );

    const scannerSession = {
      marketId: input.source.marketId,
      market: input.source.marketId,
      timezone: input.source.timezone,
      startTime: sessionStart,
      endTime: sessionEnd,
      instruments: instruments.rows.map((instrument) => ({
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        sector: instrument.sector,
        role: "CANDIDATE",
      })),
      benchmarks: [],
      benchmarkMaxStalenessSeconds: 30,
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:45", end: "16:00" },
      entries: {
        preferredStart: "10:00",
        preferredEnd: "11:30",
        hardEnd: "16:00",
      },
    };
    const scannerQuotes = quotes.rows.map((quote) => ({
      instrumentId: quote.instrumentId,
      symbol: quote.symbol,
      timestamp: new Date(quote.timestamp).toISOString(),
      bid: Number(quote.bid),
      ask: Number(quote.ask),
      bidSize: Number(quote.bidSize),
      askSize: Number(quote.askSize),
      spread: Number(quote.spread),
      last: Number(quote.last),
      dayOpen: Number(quote.dayOpen),
      dayHigh: Number(quote.dayHigh),
      dayLow: Number(quote.dayLow),
      volume: Number(quote.volume),
      dataStatus: quote.dataStatus,
      actionable: quote.actionable,
      delaySeconds: quote.delaySeconds,
    }));
    const scannerCandles = candles.rows.map((candle) => ({
      instrumentId: candle.instrumentId,
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      start: new Date(candle.start).toISOString(),
      end: new Date(candle.end).toISOString(),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
      isComplete: candle.isComplete,
    }));

    const profiles = correctedProfiles(input.observations);
    const replayedEvents: {
      event: StrategyStateEvent;
      profile: CorrectedProfile;
    }[] = [];
    const replayQuality: unknown[] = [];
    for (const profile of profiles) {
      const replay = await this.correctedStrategyEngine.runBacktestSignals({
        runId: input.sourceRunId,
        marketId: input.source.marketId,
        configVersion: profile.configVersion,
        strategies: [profile.strategy],
        parameters: profile.profileParameters,
        assumptions: {
          startingCapital:
            input.source.assumptions.maxNotional ??
            input.source.assumptions.positionSize,
          positionSize: input.source.assumptions.positionSize,
          slippageBps: input.source.assumptions.slippageBps,
          feePerTrade: input.source.assumptions.feePerTrade,
          stopMethod: input.source.assumptions.stopMethod,
          atrStopMultiple: input.source.assumptions.atrStopMultiple,
          rewardRiskRatio: input.source.assumptions.rewardRiskRatio,
        },
        sessions: [
          admitReplaySession({
            session: scannerSession,
            candles: scannerCandles,
            quotes: scannerQuotes,
          }),
        ],
      });
      replayQuality.push(replay.dataQuality);
      for (const event of replay.events) {
        if (event.marketId !== input.source.marketId)
          throw new Error(
            "Corrected strategy replay returned a market mismatch",
          );
        replayedEvents.push({ event, profile });
      }
    }

    const correctedObservations = replayedEvents
      .filter(({ event }) => event.state === "READY")
      .map(({ event, profile }, index) =>
        correctedObservation(input.sourceRunId, event, profile, index),
      );
    const quoteFacts = quotes.rows.map((quote) => ({
      instrumentId: quote.instrumentId,
      timestamp: new Date(quote.timestamp).toISOString(),
      bid: Number(quote.bid),
      ask: Number(quote.ask),
      bidSize: Number(quote.bidSize),
      askSize: Number(quote.askSize),
      dataStatus: quote.dataStatus,
      actionable: quote.actionable,
    }));
    const candleFacts = candles.rows
      .filter(
        (candle) =>
          candle.timeframe === "OneMinute" &&
          new Date(candle.start).getTime() >= Date.parse(sessionStart),
      )
      .map((candle) => ({
        instrumentId: candle.instrumentId,
        start: new Date(candle.start).toISOString(),
        end: new Date(candle.end).toISOString(),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
      }));
    const assumptions = {
      ...input.source.assumptions,
      latencyMs: 0,
      evidenceScope: "CORRECTED_STRATEGY_REGENERATION",
    };
    const executionReport = regenerateSessionEvidence({
      originalRunId: input.sourceRunId,
      sessionDate: input.source.sessionDate,
      marketId: input.source.marketId,
      observations: correctedObservations,
      quotesByInstrument: groupByInstrument(quoteFacts),
      candlesByInstrument: groupByInstrument(candleFacts),
      assumptions,
    });
    const report = {
      ...executionReport,
      evidenceScope: assumptions.evidenceScope,
      correctedSignalCount: replayedEvents.length,
      correctedReadyCount: correctedObservations.length,
      rawCoverageVerified:
        instrumentIds.every((id) =>
          quotes.rows.some((quote) => quote.instrumentId === id),
        ) &&
        instrumentIds.every((id) =>
          candles.rows.some((candle) => candle.instrumentId === id),
        ),
      replayQuality,
      sourceRunId: input.sourceRunId,
    };
    const inputDigest = createHash("sha256")
      .update(
        JSON.stringify({
          sourceRunId: input.sourceRunId,
          profiles,
          scannerQuotes,
          scannerCandles,
          replayedEvents: replayedEvents.map(({ event, profile }) => ({
            event: { ...event, eventId: undefined, setupInstanceId: undefined },
            profile,
          })),
          assumptions,
        }),
      )
      .digest("hex");
    if (!input.apply) {
      await input.client.query("COMMIT");
      return {
        report,
        inputDigest,
        evidenceScope: assumptions.evidenceScope,
        applied: false,
        mode: "CORRECTED_STRATEGY" as const,
      };
    }
    if (executionReport.reproducibility !== "REPRODUCIBLE")
      throw new Error(`Cannot regenerate: ${executionReport.reproducibility}`);
    const facade = poolFor(input.client);
    const observationsStore = new PostgresPaperBotStore(facade);
    const replacement = await observationsStore.startBacktestRun({
      source: "BACKTEST",
      marketId: input.source.marketId,
      sessionDate: input.source.sessionDate,
      sessionTimezone: input.source.timezone,
      scheduledCloseAt: input.source.closeAt.toISOString(),
      executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      assumptions,
    });
    const executions = new PostgresPaperExecutionStore(facade);
    const summaries = new Map(
      executionReport.executions.map((execution) => [
        execution.observationId,
        execution,
      ]),
    );
    for (const corrected of correctedObservations) {
      const { observation } = await observationsStore.insertObservation({
        ...corrected,
        runId: replacement.id,
      });
      const replayed = summaries.get(corrected.id);
      if (replayed) {
        await executions.upsertQuoteExecution(
          observation.id,
          replayed.quoteState,
        );
        await executions.upsertCandleExecution(
          observation.id,
          replayed.candleState,
        );
      }
    }
    await observationsStore.completeRun(replacement.id);
    await input.client.query(
      `INSERT INTO paper_evidence_regeneration
       (source_run_id,replacement_run_id,request_digest,mode,input_digest,report)
       VALUES ($1,$2,$3,'CORRECTED_STRATEGY',$4,$5)`,
      [
        input.sourceRunId,
        replacement.id,
        input.requestDigest,
        inputDigest,
        JSON.stringify(report),
      ],
    );
    await input.client.query("COMMIT");
    return {
      replacementRunId: replacement.id,
      report,
      inputDigest,
      evidenceScope: assumptions.evidenceScope,
      applied: true,
      mode: "CORRECTED_STRATEGY" as const,
    };
  }
}

function correctedProfiles(
  observations: readonly PaperSignalObservation[],
): CorrectedProfile[] {
  const profiles = new Map<string, CorrectedProfile>();
  for (const observation of observations) {
    const strategy = setupStrategyNameSchema.safeParse(observation.strategyKey);
    if (!strategy.success)
      throw new Error(
        `Unsupported corrected strategy provenance: ${observation.strategyKey}`,
      );
    if (
      !observation.profileParameters ||
      typeof observation.profileParameters !== "object" ||
      Array.isArray(observation.profileParameters)
    )
      throw new Error("Corrected strategy profile parameters are unavailable");
    const profile: CorrectedProfile = {
      strategy: strategy.data,
      profileId: observation.profileId,
      profileName: observation.profileName,
      profileConfigId: observation.profileConfigId,
      configVersion: observation.configVersion,
      profileParameters: observation.profileParameters as Record<
        string,
        unknown
      >,
    };
    const prior = profiles.get(profile.profileConfigId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(profile))
      throw new Error("Corrected strategy profile provenance is inconsistent");
    profiles.set(profile.profileConfigId, profile);
  }
  return [...profiles.values()].sort(
    (left, right) =>
      left.strategy.localeCompare(right.strategy) ||
      left.profileConfigId.localeCompare(right.profileConfigId),
  );
}

function correctedObservation(
  sourceRunId: string,
  event: StrategyStateEvent,
  profile: CorrectedProfile,
  index: number,
): PaperSignalObservation {
  const scoreCutoff =
    typeof profile.profileParameters.scoreCutoff === "number"
      ? profile.profileParameters.scoreCutoff
      : 0;
  return {
    id: stableUuid(
      `paper-corrected-observation:${sourceRunId}:${profile.profileConfigId}:${event.instrumentId}:${event.timestamp}:${index}`,
    ),
    marketId: event.marketId,
    runId: sourceRunId,
    sourceEventId: stableUuid(
      `paper-corrected-event:${sourceRunId}:${profile.profileConfigId}:${event.instrumentId}:${event.timestamp}:${index}`,
    ),
    sourceSignalId: null,
    setupInstanceId: event.setupInstanceId,
    instrumentId: event.instrumentId,
    symbol: event.symbol,
    profileId: profile.profileId,
    profileName: profile.profileName,
    profileConfigId: profile.profileConfigId,
    configVersion: profile.configVersion,
    profileParameters: profile.profileParameters,
    strategyKey: event.strategy,
    strategyVersion: event.strategyVersion,
    signalTimestamp: event.timestamp,
    score: event.score,
    entryReference: event.entryReference,
    stopReference: event.stopReference,
    targetReference: event.targetReference,
    atr14: event.featureSnapshot.atr14,
    featureSnapshot: event.featureSnapshot,
    reasonCodes: event.reasonCodes,
    sourceEventPayload: {
      ...event,
      correctionLineage: {
        type: "CORRECTED_STRATEGY_REGENERATION",
        sourceRunId,
        sourceEventIds: [],
      },
    },
    eligibilityStatus:
      event.score >= scoreCutoff ? "ELIGIBLE" : "BELOW_SCORE_CUTOFF",
    eligibilityReason: event.score >= scoreCutoff ? null : "SCORE_CUTOFF",
    createdAt: event.timestamp,
  };
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
