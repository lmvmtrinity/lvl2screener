import { createHash } from "node:crypto";
import {
  backtestRunSchema,
  replayInputSnapshotSchema,
  type BacktestEvidenceReport,
  type BacktestReplayResult,
  type BacktestRun,
  type CapturedHistoryAvailability,
  type CapturedHistoryLimitation,
  type CreateBacktest,
  type ReplayInputInstrument,
  type ReplayInputSnapshot,
  type ReplaySessionCandidates,
  type ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import type { MarketId } from "@tsx-scanner/contracts";
import {
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  authoritativeExecutionAssumptions,
  marketSessionTimezone,
} from "./execution-provenance.js";
import { getRecentRegularSessions } from "../universe/market-calendar.js";
import type { StudyExecutionFence } from "./strategy-study-service.js";
import { PostgresResearchEvidenceStore } from "./research-evidence-repository.js";
import { contentHash } from "./research-coverage.js";
import {
  replayCandidatePlanDigest,
  type ReplayCandidatePlan,
} from "./replay-candidate-plan.js";

export interface ReplaySessionPolicy {
  /** Omitted only by legacy TSX callers during the compatibility window. */
  marketId?: MarketId;
  timezone: "America/Toronto" | "America/New_York";
  openingRange: { start: string; end: string };
  scanning: { start: string; end: string };
  entries: { preferredStart: string; preferredEnd: string; hardEnd: string };
  benchmarkMaxStalenessSeconds?: number;
}

interface RunRow {
  id: string;
  market_id: MarketId;
  name: string;
  status: string;
  start_date: string | Date;
  end_date: string | Date;
  strategies: unknown;
  symbols: unknown;
  data_source: string;
  strategy_version: string;
  config_version: string;
  execution_model_version: string | null;
  execution_assumptions: unknown;
  supersedes_backtest_run_id: string | null;
  starting_capital: string;
  position_size: string;
  slippage_bps: string;
  fee_per_trade: string;
  parameters: unknown;
  metrics: unknown;
  analyses: unknown;
  data_quality: unknown;
  captured_history_availability: unknown;
  replay_input: unknown;
  evidence: unknown;
  research_evidence: unknown;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface InstrumentRow {
  id: string;
  symbol: string;
  industry_sector: string | null;
  benchmark_kind: "MARKET" | "SECTOR" | null;
  benchmark_sector: string | null;
}
interface MembershipRunRow {
  session_date: string;
  run_id: string | null;
  completed_at: Date | null;
  discovered_count: number;
  eligible_count: number;
}
interface MembershipRow {
  run_id: string;
  instrument_id: string | null;
  symbol: string;
  sector: string | null;
}
interface QuoteRow {
  instrument_id: string;
  symbol: string;
  session_date: string;
  timestamp: Date;
  bid: string;
  ask: string;
  bid_size: string;
  ask_size: string;
  spread_absolute: string;
  last: string;
  day_open: string;
  day_high: string;
  day_low: string;
  day_volume: string;
  is_delayed: boolean;
  is_halted: boolean;
  delay_seconds: number | null;
}
interface CandleRow {
  instrument_id: string;
  symbol: string;
  local_date: string;
  timeframe: "OneMinute" | "FiveMinutes" | "OneDay";
  start_time: Date;
  end_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  is_complete: boolean;
}

const runColumns = `id,market_id,name,status,start_date,end_date,strategies,symbols,data_source,strategy_version,config_version,
  execution_model_version,execution_assumptions,supersedes_backtest_run_id,
  starting_capital,position_size,slippage_bps,fee_per_trade,parameters,metrics,analyses,data_quality,captured_history_availability,replay_input,evidence,research_evidence,error,created_at,started_at,completed_at`;

/** Bounded lookback for the interior no-quote assessment. Older intervals are
 * outside the evaluated window and must not be presented as assessed. */
export const CAPTURED_HISTORY_GAP_LOOKBACK_DAYS = 30;
/** A market-wide regular-session quote gap at least this long is reported. */
export const CAPTURED_HISTORY_GAP_MIN_MS = 10 * 60_000;
/** The bounded assessment is reused briefly so a page mount cannot scan quotes
 * on every request; availability bounds themselves are always read fresh. */
const CAPTURED_HISTORY_GAP_CACHE_MS = 5 * 60_000;
const CAPTURED_HISTORY_GAP_LIMIT = 25;

export class PostgresBacktestStore {
  private readonly capturedHistoryGapCache = new Map<
    string,
    { computedAt: number; limitations: CapturedHistoryLimitation[] }
  >();

  constructor(
    private readonly pool: Pool,
    private readonly fence?: StudyExecutionFence,
    private readonly authorityCheck?: (client: PoolClient) => Promise<void>,
  ) {}

  /** Create a study-scoped adapter. Derived runs must share the study job's lease fence. */
  withFence(
    fence: StudyExecutionFence,
    authorityCheck?: (client: PoolClient) => Promise<void>,
  ): PostgresBacktestStore {
    return new PostgresBacktestStore(this.pool, fence, authorityCheck);
  }

  async loadVerifiedReplayInput(
    reportHash: string,
  ): Promise<ReplayInputSnapshot> {
    const result = await this.pool.query<{
      session_date: string;
      payload: Record<string, unknown>;
      payload_hash: string;
      expected_hash: string;
      market_id: MarketId;
      verified_at: string;
    }>(
      `SELECT s.session_date::text,s.payload,s.payload_hash,r.report->'sessionPayloadHashes'->>s.session_date::text AS expected_hash,r.market_id,r.report->>'verifiedAt' AS verified_at
       FROM research_coverage_session s JOIN research_coverage_report r ON r.hash=s.report_hash
       WHERE s.report_hash=$1 AND r.status='VERIFIED' ORDER BY s.session_date`,
      [reportHash],
    );
    const rows = result.rows;
    if (!rows.length) throw new Error("VERIFIED_REPLAY_SESSION_UNAVAILABLE");
    const candidates = new Map<
      string,
      ReplayInputSnapshot["candidateInstruments"][number]
    >();
    const benchmarks = new Map<
      string,
      ReplayInputSnapshot["benchmarks"][number]
    >();
    const quoteTimes: string[] = [],
      candleTimes: string[] = [];
    for (const row of rows) {
      if (
        row.payload_hash !== row.expected_hash ||
        contentHash({ date: row.session_date, payload: row.payload }) !==
          row.expected_hash
      )
        throw new Error("STUDY_INPUT_CHANGED");
      const session = row.payload.session as {
        market: string;
        instruments: {
          instrumentId: string;
          symbol: string;
          sector: string | null;
          role: string;
          benchmarkKind: "MARKET" | "SECTOR" | null;
          benchmarkSector: string | null;
        }[];
      };
      if (session.market !== rows[0]!.market_id)
        throw new Error("STUDY_MARKET_MISMATCH");
      for (const item of session.instruments) {
        const identity = {
          instrumentId: item.instrumentId,
          symbol: item.symbol,
          sector: item.sector,
        };
        if (item.role === "BENCHMARK" && item.benchmarkKind) {
          const value = {
            ...identity,
            kind: item.benchmarkKind,
            benchmarkSector: item.benchmarkSector,
          };
          const previous = benchmarks.get(item.instrumentId);
          if (previous && contentHash(previous) !== contentHash(value))
            throw new Error("STUDY_INPUT_CHANGED");
          benchmarks.set(item.instrumentId, value);
        } else {
          const previous = candidates.get(item.instrumentId);
          if (previous && contentHash(previous) !== contentHash(identity))
            throw new Error("STUDY_INPUT_CHANGED");
          candidates.set(item.instrumentId, identity);
        }
      }
      for (const quote of row.payload.quotes as { timestamp: string }[])
        quoteTimes.push(quote.timestamp);
      for (const candle of row.payload.candles as {
        start: string;
        end: string;
      }[])
        candleTimes.push(candle.start, candle.end);
    }
    quoteTimes.sort();
    candleTimes.sort();
    const availability = {
      source: "CAPTURED_QUOTES" as const,
      observedAt: rows[0]!.verified_at,
      tables: {
        quoteSnapshot: {
          earliest: quoteTimes[0] ?? null,
          latest: quoteTimes.at(-1) ?? null,
        },
        candle: {
          earliest: candleTimes[0] ?? null,
          latest: candleTimes.at(-1) ?? null,
        },
      },
      replay: {
        earliestDate: rows[0]!.session_date,
        latestDate: rows.at(-1)!.session_date,
      },
    };
    const candidateInstruments = [...candidates.values()].sort((a, b) =>
      a.symbol.localeCompare(b.symbol),
    );
    return replayInputSnapshotSchema.parse({
      ...replayInputSnapshot({
        marketId: rows[0]!.market_id,
        requestedSymbols: candidateInstruments.map((i) => i.symbol),
        candidateInstruments,
        benchmarks: [...benchmarks.values()].sort((a, b) =>
          a.symbol.localeCompare(b.symbol),
        ),
        universeRefreshRunId: null,
        capturedHistoryAvailability: availability,
        warnings: [],
        // Verified coverage session payloads were frozen from retained
        // membership at coverage time; this snapshot only labels that origin.
        candidateProvenance: "HISTORICAL_MEMBERSHIP",
        sessions: [],
      }),
      resolvedAt: rows[0]!.verified_at,
    });
  }

  async loadVerifiedReplaySession(
    reportHash: string,
    date: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{
      payload: Record<string, unknown>;
      payload_hash: string;
      expected_hash: string;
    }>(
      `SELECT s.payload,s.payload_hash,r.report->'sessionPayloadHashes'->>$2 AS expected_hash
       FROM research_coverage_session s JOIN research_coverage_report r ON r.hash=s.report_hash
       WHERE s.report_hash=$1 AND s.session_date=$2::date AND r.status='VERIFIED'`,
      [reportHash, date],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.payload_hash !== row.expected_hash ||
      contentHash({ date, payload: row.payload }) !== row.expected_hash
    )
      throw new Error("VERIFIED_REPLAY_SESSION_UNAVAILABLE");
    return row.payload;
  }

  async create(
    input: CreateBacktest,
    configVersion: string,
    capturedHistoryAvailability: CapturedHistoryAvailability,
    replayInput: ReplayInputSnapshot,
    supersedesBacktestRunId?: string,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<BacktestRun> {
    const query = `INSERT INTO backtest_run
      (market_id,name,status,start_date,end_date,strategies,symbols,data_source,strategy_version,config_version,
       execution_model_version,execution_assumptions,
       supersedes_backtest_run_id,starting_capital,position_size,slippage_bps,fee_per_trade,parameters,captured_history_availability,replay_input,research_evidence)
      VALUES($1,$2,'PENDING',$3,$4,$5::jsonb,$6::jsonb,$7,'1.0.0',$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb) RETURNING ${runColumns}`;
    const values = [
      input.marketId,
      input.name,
      input.startDate,
      input.endDate,
      JSON.stringify(input.strategies),
      JSON.stringify(input.symbols),
      input.dataSource,
      configVersion,
      AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      JSON.stringify(authoritativeExecutionAssumptions(input)),
      supersedesBacktestRunId ?? null,
      input.startingCapital,
      input.positionSize,
      input.slippageBps,
      input.feePerTrade,
      JSON.stringify(input.parameters),
      JSON.stringify(capturedHistoryAvailability),
      JSON.stringify(replayInput),
      researchEvidence ? JSON.stringify(researchEvidence) : null,
    ];
    if (!this.fence) {
      if (!researchEvidence)
        return mapRun((await this.pool.query<RunRow>(query, values)).rows[0]!);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<RunRow>(query, values);
        const row = result.rows[0]!;
        await new PostgresResearchEvidenceStore(this.pool).bindWithClient(
          client,
          { kind: "BACKTEST", id: row.id, marketId: input.marketId },
          researchEvidence,
        );
        await client.query("COMMIT");
        return mapRun(row);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    return this.withFencedTransaction(async (client) => {
      const result = await client.query<RunRow>(query, values);
      const row = result.rows[0]!;
      if (researchEvidence)
        await new PostgresResearchEvidenceStore(this.pool).bindWithClient(
          client,
          { kind: "BACKTEST", id: row.id, marketId: input.marketId },
          researchEvidence,
        );
      return mapRun(row);
    });
  }

  async markRunning(id: string): Promise<void> {
    const query =
      "UPDATE backtest_run SET status='RUNNING',started_at=NOW(),error=NULL WHERE id=$1";
    if (!this.fence) {
      await this.pool.query(query, [id]);
      return;
    }
    await this.withFencedTransaction(async (client) => {
      await client.query(query, [id]);
    });
  }

  async complete(
    id: string,
    output: BacktestReplayResult,
    evidence: BacktestEvidenceReport,
  ): Promise<BacktestRun> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (this.fence) await assertBacktestFence(client, this.fence);
      await this.authorityCheck?.(client);
      await client.query(
        `UPDATE backtest_run SET status='COMPLETED',metrics=$2::jsonb,analyses=$3::jsonb,data_quality=$4::jsonb,evidence=$5::jsonb,completed_at=NOW() WHERE id=$1`,
        [
          id,
          JSON.stringify(output.metrics),
          JSON.stringify(output.analyses),
          JSON.stringify(output.dataQuality),
          JSON.stringify(evidence),
        ],
      );
      for (const trade of output.trades) await this.saveTrade(client, trade);
      for (const event of output.timeline)
        await client.query(
          `INSERT INTO backtest_state_event
        (run_id,instrument_id,symbol,strategy_name,timestamp,previous_state,state,score,reason_codes,setup_instance_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
          [
            id,
            event.instrumentId,
            event.symbol,
            event.strategy,
            event.timestamp,
            event.previousState,
            event.state,
            event.score,
            JSON.stringify(event.reasonCodes),
            event.setupInstanceId,
          ],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return (await this.get(id))!;
  }

  async fail(id: string, error: string): Promise<void> {
    const query =
      "UPDATE backtest_run SET status='FAILED',error=$2,completed_at=NOW() WHERE id=$1";
    const values = [id, error.slice(0, 5_000)];
    if (!this.fence) {
      await this.pool.query(query, values);
      return;
    }
    await this.withFencedTransaction(async (client) => {
      await client.query(query, values);
    }, false);
  }

  private async withFencedTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    checkAuthority = true,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertBacktestFence(client, this.fence);
      if (checkAuthority) await this.authorityCheck?.(client);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(limit = 100): Promise<BacktestRun[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${runColumns} FROM backtest_run ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => mapRun(row));
  }

  async get(id: string): Promise<BacktestRun | undefined> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${runColumns} FROM backtest_run WHERE id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const tradeResult = await this.pool.query(
      `SELECT id,run_id,instrument_id,symbol,strategy_name AS strategy,strategy_version,config_version,
      signal_timestamp,score,entry_time,entry_price,stop_price,target_price,exit_time,exit_price,shares,exit_reason,gross_pnl,net_pnl,r_multiple,hold_minutes,reason_codes,
      sector,atr_pct,rvol_at_time,context_score,context_evaluations,setup_instance_id,sampled_excursion FROM backtest_trade WHERE run_id=$1 ORDER BY entry_time`,
      [id],
    );
    return mapRun(
      row,
      tradeResult.rows.map((value) => ({
        id: value.id,
        runId: value.run_id,
        instrumentId: value.instrument_id,
        symbol: value.symbol,
        strategy: value.strategy,
        strategyVersion: value.strategy_version,
        configVersion: value.config_version,
        signalTimestamp: iso(value.signal_timestamp),
        score: value.score,
        entryTime: iso(value.entry_time),
        entryPrice: Number(value.entry_price),
        stopPrice: Number(value.stop_price),
        targetPrice: Number(value.target_price),
        exitTime: iso(value.exit_time),
        exitPrice: Number(value.exit_price),
        shares: Number(value.shares),
        exitReason: value.exit_reason,
        grossPnl: Number(value.gross_pnl),
        netPnl: Number(value.net_pnl),
        rMultiple: Number(value.r_multiple),
        holdMinutes: Number(value.hold_minutes),
        reasonCodes: value.reason_codes,
        sector: value.sector ?? null,
        atrPct: value.atr_pct == null ? null : Number(value.atr_pct),
        rvolAtTime:
          value.rvol_at_time == null ? null : Number(value.rvol_at_time),
        contextScore:
          value.context_score == null ? 50 : Number(value.context_score),
        contexts: value.context_evaluations ?? [],
        setupInstanceId: value.setup_instance_id ?? null,
        sampledExcursion: value.sampled_excursion ?? null,
      })),
    );
  }

  /**
   * Resolve the candidate selection once and freeze it into the immutable
   * replay-input snapshot. Explicit symbols produce a labeled captured-cohort
   * selection; an empty symbol list resolves each captured session from the
   * retained universe membership that was effective before that session opened,
   * so a later live-list change cannot rewrite a historical replay.
   */
  async resolveReplayInput(
    input: CreateBacktest,
    capturedHistoryAvailability: CapturedHistoryAvailability,
  ): Promise<ReplayInputSnapshot> {
    const requestedSymbols = [
      ...new Set(input.symbols.map((value) => value.trim()).filter(Boolean)),
    ].sort();
    const [plan, benchmarks] = await Promise.all([
      this.resolveReplayCandidatePlan(input),
      this.pool.query<InstrumentRow>(
        `SELECT id,symbol,industry_sector,benchmark_kind,benchmark_sector FROM instrument
         WHERE market_id=$1 AND benchmark_kind IS NOT NULL
         ORDER BY symbol`,
        [input.marketId],
      ),
    ]);
    return replayInputSnapshot({
      marketId: input.marketId,
      requestedSymbols,
      candidateInstruments: [...plan.candidateInstruments],
      benchmarks: benchmarks.rows.map((value) => ({
        instrumentId: value.id,
        symbol: value.symbol,
        sector: value.industry_sector,
        kind: value.benchmark_kind!,
        benchmarkSector: value.benchmark_sector,
      })),
      universeRefreshRunId: plan.universeRefreshRunId,
      capturedHistoryAvailability,
      warnings: [...plan.warnings],
      candidateProvenance: plan.provenance,
      sessions: [...plan.sessions],
    });
  }

  /**
   * Resolve replay candidates without loading quote payloads, so automation can
   * decide freshness and whether a replay is worth dispatching. Historical
   * sessions use the latest completed universe refresh that discovered symbols
   * and finished before that session's open; zero-discovery runs are treated as
   * unavailable discovery rather than as an intentionally empty list.
   */
  async resolveReplayCandidatePlan(
    input: Pick<
      CreateBacktest,
      "marketId" | "startDate" | "endDate" | "symbols"
    >,
  ): Promise<ReplayCandidatePlan> {
    const requestedSymbols = [
      ...new Set(input.symbols.map((value) => value.trim()).filter(Boolean)),
    ].sort();
    if (requestedSymbols.length)
      return this.explicitCapturedCohortPlan(input.marketId, requestedSymbols);
    return this.historicalMembershipPlan(
      input.marketId,
      input.startDate,
      input.endDate,
    );
  }

  private async explicitCapturedCohortPlan(
    marketId: MarketId,
    requestedSymbols: string[],
  ): Promise<ReplayCandidatePlan> {
    const instruments = await this.pool.query<InstrumentRow>(
      `SELECT id,symbol,industry_sector,benchmark_kind,benchmark_sector FROM instrument
        WHERE market_id=$2 AND symbol=ANY($1)
        ORDER BY symbol`,
      [requestedSymbols, marketId],
    );
    const candidateInstruments = instruments.rows
      .filter((value) => value.benchmark_kind === null)
      .map((value) => ({
        instrumentId: value.id,
        symbol: value.symbol,
        sector: value.industry_sector,
      }));
    const found = new Set(candidateInstruments.map((value) => value.symbol));
    const warnings = requestedSymbols
      .filter((symbol) => !found.has(symbol))
      .map(
        (symbol) =>
          `Requested symbol ${symbol} was not resolved as a replay candidate.`,
      );
    return {
      provenance: "EXPLICIT_CAPTURED_COHORT",
      sessions: [],
      candidateInstruments,
      universeRefreshRunId: null,
      warnings,
      digest: replayCandidatePlanDigest(
        "EXPLICIT_CAPTURED_COHORT",
        [],
        candidateInstruments,
      ),
    };
  }

  private async historicalMembershipPlan(
    marketId: MarketId,
    startDate: string,
    endDate: string,
  ): Promise<ReplayCandidatePlan> {
    const dates = await this.marketQuoteSessionDates(
      marketId,
      startDate,
      endDate,
    );
    if (!dates.length)
      return this.historicalMembershipResult(marketId, dates, []);
    const runs = await this.pool.query<MembershipRunRow>(
      `SELECT s.session_date::text AS session_date,
              r.id AS run_id, r.completed_at, r.discovered_count, r.eligible_count
         FROM unnest($2::date[]) AS s(session_date)
         LEFT JOIN LATERAL (
           SELECT r.id, r.completed_at, r.discovered_count, r.eligible_count
             FROM universe_refresh_run r
            WHERE r.market_id=$1 AND r.status='COMPLETED'
              AND r.completed_at IS NOT NULL AND r.discovered_count > 0
              AND r.completed_at <= ((s.session_date + TIME '09:30') AT TIME ZONE $3)
            ORDER BY r.completed_at DESC, r.id DESC
            LIMIT 1
         ) r ON TRUE
        ORDER BY s.session_date`,
      [marketId, dates, marketSessionTimezone(marketId)],
    );
    const runIds = [
      ...new Set(
        runs.rows
          .map((row) => row.run_id)
          .filter((value): value is string => value !== null),
      ),
    ];
    const members = runIds.length
      ? await this.pool.query<MembershipRow>(
          `SELECT run_id,instrument_id,symbol,sector
             FROM universe_membership
            WHERE run_id=ANY($1::uuid[]) AND eligible=TRUE AND instrument_id IS NOT NULL
            ORDER BY symbol`,
          [runIds],
        )
      : { rows: [] as MembershipRow[] };
    return this.historicalMembershipResult(
      marketId,
      dates,
      runs.rows,
      members.rows,
    );
  }

  private historicalMembershipResult(
    marketId: MarketId,
    dates: readonly string[],
    rows: readonly MembershipRunRow[],
    members: readonly MembershipRow[] = [],
  ): ReplayCandidatePlan {
    const membersByRun = new Map<string, ReplayInputInstrument[]>();
    for (const member of members) {
      const list = membersByRun.get(member.run_id) ?? [];
      list.push({
        instrumentId: member.instrument_id!,
        symbol: member.symbol,
        sector: member.sector,
      });
      membersByRun.set(member.run_id, list);
    }
    const warnings: string[] = [];
    const sessions: ReplaySessionCandidates[] = [];
    const staleSessions: string[] = [];
    for (const row of rows) {
      const candidates = row.run_id ? (membersByRun.get(row.run_id) ?? []) : [];
      if (!row.run_id) {
        sessions.push({
          sessionDate: row.session_date,
          resolution: "NO_EVIDENCE",
          membershipRunId: null,
          effectiveAt: null,
          candidates: [],
          reasonCodes: ["NO_MEMBERSHIP_EVIDENCE_BEFORE_SESSION"],
        });
        warnings.push(
          `No completed membership snapshot was effective before ${row.session_date} open; the session is excluded.`,
        );
        continue;
      }
      const effectiveAt = row.completed_at!.toISOString();
      if (row.eligible_count > 0 && candidates.length > 0) {
        const effectiveDate = dateInMarket(effectiveAt, marketId);
        const reasonCodes =
          effectiveDate === row.session_date
            ? []
            : ["MEMBERSHIP_EFFECTIVE_BEFORE_SESSION_DATE"];
        if (effectiveDate !== row.session_date)
          staleSessions.push(
            `${row.session_date} (run ${row.run_id} effective ${effectiveAt})`,
          );
        sessions.push({
          sessionDate: row.session_date,
          resolution: "RESOLVED",
          membershipRunId: row.run_id,
          effectiveAt,
          candidates,
          reasonCodes,
        });
        continue;
      }
      if (row.eligible_count > 0) {
        sessions.push({
          sessionDate: row.session_date,
          resolution: "NO_EVIDENCE",
          membershipRunId: row.run_id,
          effectiveAt,
          candidates: [],
          reasonCodes: ["MEMBERSHIP_ROWS_UNAVAILABLE"],
        });
        warnings.push(
          `Membership for ${row.session_date} reports eligible members but the retained rows are unavailable; the session is excluded.`,
        );
        continue;
      }
      sessions.push({
        sessionDate: row.session_date,
        resolution: "EMPTY",
        membershipRunId: row.run_id,
        effectiveAt,
        candidates: [],
        reasonCodes: ["MEMBERSHIP_EVALUATED_NO_ELIGIBLE"],
      });
      warnings.push(
        `Membership for ${row.session_date} was evaluated at ${effectiveAt} with no eligible members; the session is excluded.`,
      );
    }
    if (staleSessions.length)
      warnings.push(
        `Retained membership was reused across session dates because no newer snapshot completed before open: ${staleSessions.join("; ")}.`,
      );
    const candidateInstruments = [
      ...new Map(
        sessions
          .flatMap((session) => session.candidates)
          .map((candidate) => [candidate.instrumentId, candidate]),
      ).values(),
    ].sort((left, right) => left.symbol.localeCompare(right.symbol));
    if (!sessions.some((session) => session.candidates.length > 0))
      warnings.push(
        dates.length
          ? "No session in the requested range has retained membership candidates; nothing can be replayed."
          : "No captured quote sessions were available for the requested range.",
      );
    const distinctRunIds = [
      ...new Set(
        sessions
          .map((session) => session.membershipRunId)
          .filter((value): value is string => value !== null),
      ),
    ];
    return {
      provenance: "HISTORICAL_MEMBERSHIP",
      sessions,
      candidateInstruments,
      universeRefreshRunId:
        distinctRunIds.length === 1 ? distinctRunIds[0]! : null,
      warnings,
      digest: replayCandidatePlanDigest(
        "HISTORICAL_MEMBERSHIP",
        sessions,
        candidateInstruments,
      ),
    };
  }

  private async marketQuoteSessionDates(
    marketId: MarketId,
    startDate: string,
    endDate: string,
  ): Promise<string[]> {
    const timezone = marketSessionTimezone(marketId);
    const result = await this.pool.query<{ session_date: string }>(
      `SELECT DISTINCT (q.timestamp AT TIME ZONE $2)::date::text AS session_date
         FROM quote_snapshot q JOIN instrument i ON i.id=q.instrument_id
        WHERE i.market_id=$1
          AND (q.timestamp AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
        ORDER BY 1`,
      [marketId, timezone, startDate, endDate],
    );
    return result.rows.map((row) => row.session_date);
  }

  /** Merges candidate and benchmark instruments into one lookup list, as replay sessions need
   * both. Pulled out so the session-cursor path and the (legacy, still-supported) bulk path build
   * the exact same instrument list. Historical plans resolve candidates per session date so no
   * later membership change can leak into an earlier session. */
  private mergedInstruments(replayInput: ReplayInputSnapshot, date?: string) {
    const sessionCandidates = date
      ? replayInput.sessions.find((value) => value.sessionDate === date)
          ?.candidates
      : undefined;
    const candidates = replayInput.sessions.length
      ? (sessionCandidates ?? [])
      : replayInput.candidateInstruments;
    return [
      ...candidates.map((value) => ({
        ...value,
        benchmarkKind: null as
          ReplayInputSnapshot["benchmarks"][number]["kind"] | null,
        benchmarkSector: null as string | null,
      })),
      ...replayInput.benchmarks.map((value) => ({
        ...value,
        benchmarkKind: value.kind,
        benchmarkSector: value.benchmarkSector,
      })),
    ];
  }

  /** W8: distinct Toronto trading-session dates in range, queried without pulling any quote/candle
   * rows -- the caller (worker or {@link loadReplayData}) then asks for one session's data at a
   * time via {@link loadReplaySession} instead of holding every session in memory at once. */
  async loadReplaySessionDates(
    input: CreateBacktest,
    replayInput: ReplayInputSnapshot,
    policy: ReplaySessionPolicy = CA_REPLAY_POLICY,
  ): Promise<string[]> {
    if (replayInput.marketId !== input.marketId) {
      throw new Error("Replay input belongs to another market");
    }
    const ids = this.mergedInstruments(replayInput).map(
      (value) => value.instrumentId,
    );
    if (!ids.length) return [];
    const result = await this.pool.query<{ session_date: string }>(
      `SELECT DISTINCT (${sessionDateExpression("q.timestamp", policy.timezone)})::date::text AS session_date
       FROM quote_snapshot q
       WHERE q.instrument_id=ANY($1::uuid[]) AND (${sessionDateExpression("q.timestamp", policy.timezone)})::date BETWEEN $2::date AND $3::date
       ORDER BY 1`,
      [ids, input.startDate, input.endDate],
    );
    const dates = result.rows.map((row) => row.session_date);
    // Historical plans replay only sessions that resolved candidates. Proven
    // empty membership and missing membership evidence are reported on the
    // input, never replayed as benchmark-only sessions.
    if (!replayInput.sessions.length) return dates;
    const candidateDates = new Set(
      replayInput.sessions
        .filter((session) => session.candidates.length > 0)
        .map((session) => session.sessionDate),
    );
    return dates.filter((date) => candidateDates.has(date));
  }

  /** W8: loads and shapes exactly one Toronto trading session's replay payload -- one round trip
   * for quotes at that date, one for the trailing 45-day candle window that session needs, both
   * bounded by session size (not the whole run's date range). */
  async loadReplaySession(
    replayInput: ReplayInputSnapshot,
    policy: ReplaySessionPolicy,
    date: string,
  ): Promise<Record<string, unknown>> {
    const instruments = this.mergedInstruments(replayInput, date);
    const ids = instruments.map((value) => value.instrumentId);
    const quotes = ids.length
      ? await this.pool.query<QuoteRow>(
          `SELECT q.instrument_id,''::text AS symbol,(${sessionDateExpression("q.timestamp", policy.timezone)})::date::text session_date,
          q.timestamp,q.bid,q.ask,q.bid_size,q.ask_size,q.spread_absolute,q.last,q.day_open,q.day_high,q.day_low,q.day_volume,
          q.is_delayed,q.is_halted,q.delay_seconds
          FROM quote_snapshot q
          WHERE q.instrument_id=ANY($1::uuid[]) AND (${sessionDateExpression("q.timestamp", policy.timezone)})::date = $2::date
          ORDER BY q.timestamp,q.instrument_id`,
          [ids, date],
        )
      : { rows: [] as QuoteRow[] };
    const candles = ids.length
      ? await this.pool.query<CandleRow>(
          `SELECT c.instrument_id,''::text AS symbol,(${sessionDateExpression("c.start_time", policy.timezone)})::date::text local_date,
          c.timeframe,c.start_time,c.end_time,c.open,c.high,c.low,c.close,c.volume,c.is_complete
          FROM candle c
          WHERE c.instrument_id=ANY($1::uuid[]) AND c.start_time >= ($2::date - INTERVAL '45 days')
            AND c.start_time < ($2::date + INTERVAL '1 day') AND c.is_complete=TRUE
          ORDER BY c.end_time,c.instrument_id`,
          [ids, date],
        )
      : { rows: [] as CandleRow[] };
    return buildSessionPayload(
      date,
      instruments,
      quotes.rows,
      candles.rows,
      policy,
    );
  }

  /** Legacy bulk entry point kept for the still-supported synchronous fallback path (see W8's
   * PR-11 rollback note: retain the synchronous path until the chunked worker path has proven
   * byte-equivalent). Implemented on top of the same session-cursor queries as
   * {@link loadReplaySession} so both paths build identical session payloads from a single source
   * of truth, one Toronto session at a time rather than one big multi-week query. */
  async loadReplayData(
    input: CreateBacktest,
    replayInput: ReplayInputSnapshot,
    policy: ReplaySessionPolicy,
  ): Promise<Record<string, unknown>> {
    const dates = await this.loadReplaySessionDates(input, replayInput, policy);
    const sessions: Record<string, unknown>[] = [];
    for (const date of dates)
      sessions.push(await this.loadReplaySession(replayInput, policy, date));
    return { sessions };
  }

  async getCapturedHistoryAvailability(
    marketId: MarketId = "CA_TSX",
    options: { now?: Date } = {},
  ): Promise<CapturedHistoryAvailability> {
    const observedAt = options.now ?? new Date();
    const result = await this.pool.query<{
      source: "quoteSnapshot" | "candle";
      earliest: Date | null;
      latest: Date | null;
    }>(
      `
      SELECT 'quoteSnapshot'::text AS source, MIN(q.timestamp) AS earliest, MAX(q.timestamp) AS latest
      FROM quote_snapshot q JOIN instrument i ON i.id=q.instrument_id
      WHERE i.market_id=$1
      UNION ALL
      SELECT 'candle'::text AS source, MIN(c.start_time) AS earliest, MAX(c.start_time) AS latest
      FROM candle c JOIN instrument i ON i.id=c.instrument_id
      WHERE i.market_id=$1
    `,
      [marketId],
    );
    const bySource = new Map(result.rows.map((row) => [row.source, row]));
    const quoteSnapshot = availabilityFor(bySource.get("quoteSnapshot"));
    const candle = availabilityFor(bySource.get("candle"));
    return {
      source: "CAPTURED_QUOTES",
      observedAt: observedAt.toISOString(),
      tables: { quoteSnapshot, candle },
      replay: {
        earliestDate: dateInMarket(quoteSnapshot.earliest, marketId),
        latestDate: dateInMarket(quoteSnapshot.latest, marketId),
      },
      limitations: await this.interiorNoQuoteLimitations(
        marketId,
        quoteSnapshot.earliest,
        observedAt,
      ),
    };
  }

  /**
   * Bounded interior no-quote assessment for the reported market. It reads only
   * the most recent bounded lookback of retained quotes inside the market's
   * actual regular sessions (published calendar, including early closes and
   * holidays) and reports a market-wide gap only when completed candles exist
   * inside it, so a closure is not misread as a collection gap and backfilled
   * candles cannot erase missing forward quotes. The result is cached briefly
   * to keep a page mount from repeatedly scanning quotes.
   */
  private async interiorNoQuoteLimitations(
    marketId: MarketId,
    earliestQuote: string | null,
    observedAt: Date,
  ): Promise<CapturedHistoryLimitation[]> {
    if (!earliestQuote) return [];
    const earliestMs = Date.parse(earliestQuote);
    if (!Number.isFinite(earliestMs)) return [];
    const nowMs = observedAt.getTime();
    const windowStartMs = Math.max(
      earliestMs,
      nowMs - CAPTURED_HISTORY_GAP_LOOKBACK_DAYS * 86_400_000,
    );
    const cacheKey = `${marketId}:${Math.floor(windowStartMs / 3_600_000)}`;
    const cached = this.capturedHistoryGapCache.get(cacheKey);
    if (cached && nowMs - cached.computedAt < CAPTURED_HISTORY_GAP_CACHE_MS)
      return cached.limitations;
    const asOfDate =
      dateInMarket(observedAt.toISOString(), marketId) ??
      observedAt.toISOString().slice(0, 10);
    const sessions = getRecentRegularSessions(
      marketId,
      asOfDate,
      CAPTURED_HISTORY_GAP_LOOKBACK_DAYS + 10,
    )
      .filter(
        (session) =>
          Date.parse(session.close) > windowStartMs &&
          Date.parse(session.open) <= nowMs,
      )
      .map((session) => ({
        sessionDate: session.tradingDate,
        openAt: session.open,
        closeAt: session.close,
      }));
    if (sessions.length === 0) {
      this.capturedHistoryGapCache.set(cacheKey, {
        computedAt: nowMs,
        limitations: [],
      });
      return [];
    }
    const result = await this.pool.query<{
      previous_at: Date;
      timestamp: Date;
      session_date: string;
    }>(
      `WITH session_windows AS (
         SELECT (value->>'sessionDate')::date AS session_date,
                (value->>'openAt')::timestamptz AS open_at,
                (value->>'closeAt')::timestamptz AS close_at
           FROM jsonb_array_elements($4::jsonb) AS value
       ),
       market_instruments AS (
         SELECT id FROM instrument WHERE market_id=$1
       ),
       session_quotes AS (
         SELECT q.timestamp,
                w.session_date::text AS session_date,
                lag(q.timestamp) OVER (ORDER BY q.timestamp) AS previous_at,
                lag(w.session_date::text) OVER (ORDER BY q.timestamp) AS previous_session
           FROM quote_snapshot q
           JOIN session_windows w
             ON q.timestamp >= w.open_at AND q.timestamp < w.close_at
          WHERE q.instrument_id IN (SELECT id FROM market_instruments)
            AND q.timestamp >= $2 AND q.timestamp < $3
       )
       SELECT previous_at, timestamp, session_date
         FROM session_quotes
        WHERE previous_at IS NOT NULL
          AND session_date = previous_session
          AND timestamp - previous_at >= ($5::numeric * INTERVAL '1 millisecond')
          AND EXISTS (
            SELECT 1 FROM candle c
             WHERE c.instrument_id IN (SELECT id FROM market_instruments)
               AND c.is_complete = TRUE
               AND c.start_time >= previous_at AND c.start_time < timestamp
          )
        ORDER BY previous_at
        LIMIT ${CAPTURED_HISTORY_GAP_LIMIT}`,
      [
        marketId,
        new Date(windowStartMs),
        observedAt,
        JSON.stringify(sessions),
        CAPTURED_HISTORY_GAP_MIN_MS,
      ],
    );
    const limitations = result.rows.map((row): CapturedHistoryLimitation => ({
      marketId,
      kind: "INTERIOR_NO_QUOTE",
      basis: "QUOTE_GAP_WITH_BACKFILLED_CANDLES",
      startAt: row.previous_at.toISOString(),
      endAt: row.timestamp.toISOString(),
      sessionDates: [row.session_date],
      detail:
        "No forward quotes were retained through this interval although completed candles exist inside it. Backfilled candles do not reconstruct the missing quotes, so research that depends on forward quote evidence is limited for the affected sessions.",
      evaluatedFrom: new Date(windowStartMs).toISOString(),
      evaluatedThrough: observedAt.toISOString(),
    }));
    this.capturedHistoryGapCache.set(cacheKey, {
      computedAt: nowMs,
      limitations,
    });
    return limitations;
  }

  /** A1 input watermark: market-local session dates with per-date quote/candle
   * counts and latest timestamps. Newly completed sessions and late-arriving
   * regular-session rows change this fingerprint; in-place corrections that
   * preserve counts and timestamps are deliberately invisible and require an
   * explicit refresh.
   *
   * Quotes and intraday candles participate only inside the deterministic
   * session window ([09:30, 16:00) market-local), matching the engine's opening
   * range and scanning windows: pre-open warmup captures and post-close
   * extended-hours prints cannot change a replay, so they must not churn work
   * into re-replaying. Daily candles always participate because they align to
   * earlier sessions regardless of their midnight timestamp.
   *
   * The current market-local date is excluded until the 16:00 close passes.
   * Both markets close at 16:00 local; on an early-close day the session simply
   * enters the fingerprint later, which delays a reopen but never fabricates
   * one. */
  async captureInputFingerprint(
    marketId: MarketId = "CA_TSX",
    now: Date = new Date(),
    membership?: string,
  ): Promise<string> {
    const timezone = marketSessionTimezone(marketId);
    // The closed-session gate: include a row when the current market-local time
    // is at/after the session boundary, or when the row belongs to an earlier date.
    const regularSessionGate = `(
      ($3::timestamptz AT TIME ZONE $2)::time >= '16:00'
      OR (col AT TIME ZONE $2)::date < ($3::timestamptz AT TIME ZONE $2)::date
    )`;
    const inSessionWindow = `(
      (col AT TIME ZONE $2)::time >= '09:30'
      AND (col AT TIME ZONE $2)::time < '16:00'
    )`;
    const result = await this.pool.query<{
      session_date: string;
      quote_count: string;
      latest_quote_at: Date | null;
      candle_count: string;
      latest_candle_at: Date | null;
    }>(
      `SELECT u.session_date,
              sum(u.quote_count)::bigint::text AS quote_count,
              max(u.latest_quote_at) AS latest_quote_at,
              sum(u.candle_count)::bigint::text AS candle_count,
              max(u.latest_candle_at) AS latest_candle_at
         FROM (
           SELECT (q.timestamp AT TIME ZONE $2)::date::text AS session_date,
                  count(*) AS quote_count, max(q.timestamp) AS latest_quote_at,
                  0::bigint AS candle_count, NULL::timestamptz AS latest_candle_at
             FROM quote_snapshot q JOIN instrument i ON i.id=q.instrument_id
            WHERE i.market_id=$1
              AND ${inSessionWindow.replaceAll("col", "q.timestamp")}
              AND ${regularSessionGate.replaceAll("col", "q.timestamp")}
            GROUP BY 1
           UNION ALL
           SELECT (c.start_time AT TIME ZONE $2)::date::text AS session_date,
                  0::bigint AS quote_count, NULL::timestamptz AS latest_quote_at,
                  count(*) AS candle_count, max(c.start_time) AS latest_candle_at
             FROM candle c JOIN instrument i ON i.id=c.instrument_id
            WHERE i.market_id=$1
              AND (c.timeframe = 'OneDay'
                OR ${inSessionWindow.replaceAll("col", "c.start_time")})
              AND ${regularSessionGate.replaceAll("col", "c.start_time")}
            GROUP BY 1
         ) u
        GROUP BY u.session_date
        ORDER BY u.session_date`,
      [marketId, timezone, now.toISOString()],
    );
    return contentHash({
      watermark: result.rows.map((row) => ({
        sessionDate: row.session_date,
        quoteCount: Number(row.quote_count),
        latestQuoteAt: row.latest_quote_at?.toISOString() ?? null,
        candleCount: Number(row.candle_count),
        latestCandleAt: row.latest_candle_at?.toISOString() ?? null,
      })),
      membership: membership ?? null,
    });
  }

  private async saveTrade(
    client: PoolClient,
    value: BacktestReplayResult["trades"][number],
  ): Promise<void> {
    await client.query(
      `INSERT INTO backtest_trade
      (id,run_id,instrument_id,symbol,strategy_name,strategy_version,config_version,signal_timestamp,score,entry_time,entry_price,stop_price,target_price,exit_time,exit_price,shares,exit_reason,gross_pnl,net_pnl,r_multiple,hold_minutes,reason_codes,sector,atr_pct,rvol_at_time,context_score,context_evaluations,setup_instance_id,sampled_excursion)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,$26,$27::jsonb,$28,$29::jsonb)`,
      [
        value.id,
        value.runId,
        value.instrumentId,
        value.symbol,
        value.strategy,
        value.strategyVersion,
        value.configVersion,
        value.signalTimestamp,
        value.score,
        value.entryTime,
        value.entryPrice,
        value.stopPrice,
        value.targetPrice,
        value.exitTime,
        value.exitPrice,
        value.shares,
        value.exitReason,
        value.grossPnl,
        value.netPnl,
        value.rMultiple,
        value.holdMinutes,
        JSON.stringify(value.reasonCodes),
        value.sector,
        value.atrPct,
        value.rvolAtTime,
        value.contextScore,
        JSON.stringify(value.contexts),
        value.setupInstanceId,
        value.sampledExcursion ? JSON.stringify(value.sampledExcursion) : null,
      ],
    );
  }
}

async function assertBacktestFence(
  client: PoolClient,
  fence: StudyExecutionFence | undefined,
): Promise<void> {
  if (!fence) throw new Error("STUDY_RUN_MUTATION_REQUIRES_JOB_FENCE");
  const result = await client.query<{
    status: string;
    lease_owner: string | null;
    attempt_count: number;
    lease_expires_at: Date | null;
  }>(
    `SELECT status,lease_owner,attempt_count,lease_expires_at
       FROM research_job WHERE id=$1 FOR UPDATE`,
    [fence.jobId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.status !== "RUNNING" ||
    row.lease_owner !== fence.leaseOwner ||
    row.attempt_count !== fence.attemptCount ||
    !row.lease_expires_at ||
    row.lease_expires_at.getTime() <= Date.now()
  )
    throw new Error("STUDY_LEASE_LOST");
}

function mapCandle(value: CandleRow) {
  return {
    instrumentId: value.instrument_id,
    symbol: value.symbol,
    timeframe: value.timeframe,
    start: value.start_time.toISOString(),
    end: value.end_time.toISOString(),
    open: Number(value.open),
    high: Number(value.high),
    low: Number(value.low),
    close: Number(value.close),
    volume: Number(value.volume),
    isComplete: value.is_complete,
  };
}

interface MergedInstrument {
  instrumentId: string;
  symbol: string;
  sector: string | null;
  benchmarkKind: "MARKET" | "SECTOR" | null;
  benchmarkSector: string | null;
}

/** Shapes one Toronto session's replay payload from already-narrowed quote/candle rows. Pulled out
 * of the old bulk `loadReplayData` loop body verbatim so the session-cursor path
 * ({@link PostgresBacktestStore.loadReplaySession}) produces byte-identical sessions to what the
 * previous single-query implementation produced per date. */
export function buildSessionPayload(
  date: string,
  instruments: readonly MergedInstrument[],
  quoteRows: readonly QuoteRow[],
  candleRows: readonly CandleRow[],
  policy: ReplaySessionPolicy,
): Record<string, unknown> {
  const start = zonedBoundary(date, "09:30", policy.timezone);
  const end = zonedBoundary(date, "16:00", policy.timezone);
  const sessionQuotes = quoteRows.filter(
    (value) => value.session_date === date,
  );
  const sessionInstruments = instruments.filter((value) =>
    sessionQuotes.some((quote) => quote.instrument_id === value.instrumentId),
  );
  const relevantCandles = candleRows.filter((value) =>
    value.timeframe === "OneDay"
      ? value.end_time < start
      : value.timeframe === "OneMinute"
        ? value.end_time <= end &&
          value.end_time >= new Date(start.getTime() - 20 * 86_400_000)
        : value.local_date === date,
  );
  return {
    session: {
      marketId: policy.marketId ?? "CA_TSX",
      market: policy.marketId ?? "CA_TSX",
      timezone: policy.timezone,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      instruments: sessionInstruments.map((value) => ({
        instrumentId: value.instrumentId,
        symbol: value.symbol,
        sector: value.sector,
        role: value.benchmarkKind ? "BENCHMARK" : "CANDIDATE",
        benchmarkKind: value.benchmarkKind,
        benchmarkSector: value.benchmarkSector,
      })),
      benchmarks: sessionInstruments
        .filter((value) => value.benchmarkKind)
        .map((value) => ({
          kind: value.benchmarkKind,
          symbol: value.symbol,
          sector: value.benchmarkSector,
        })),
      benchmarkMaxStalenessSeconds: policy.benchmarkMaxStalenessSeconds ?? 30,
      openingRange: policy.openingRange,
      scanning: policy.scanning,
      entries: policy.entries,
    },
    candles: relevantCandles
      .filter((value) =>
        sessionInstruments.some(
          (instrument) => instrument.instrumentId === value.instrument_id,
        ),
      )
      .map((value) =>
        mapCandle({
          ...value,
          symbol: instrumentFor(instruments, value.instrument_id).symbol,
        }),
      ),
    quotes: sessionQuotes.map((value) => ({
      instrumentId: value.instrument_id,
      symbol: instrumentFor(instruments, value.instrument_id).symbol,
      timestamp: value.timestamp.toISOString(),
      bid: Number(value.bid),
      ask: Number(value.ask),
      bidSize: Number(value.bid_size),
      askSize: Number(value.ask_size),
      spread: Number(value.spread_absolute),
      last: Number(value.last),
      dayOpen: Number(value.day_open),
      dayHigh: Number(value.day_high),
      dayLow: Number(value.day_low),
      volume: Number(value.day_volume),
      dataStatus: value.is_halted
        ? "HALTED"
        : value.is_delayed
          ? "DELAYED"
          : "REALTIME",
      actionable: !value.is_halted && !value.is_delayed,
      delaySeconds: value.delay_seconds,
    })),
  };
}

function mapRun(row: RunRow, trades: unknown[] = []): BacktestRun {
  return backtestRunSchema.parse({
    id: row.id,
    marketId: row.market_id,
    name: row.name,
    status: row.status,
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    strategies: row.strategies,
    symbols: row.symbols,
    dataSource: row.data_source,
    strategyVersion: row.strategy_version,
    configVersion: row.config_version,
    executionModelVersion: row.execution_model_version,
    executionAssumptions: row.execution_assumptions,
    supersedesBacktestRunId: row.supersedes_backtest_run_id,
    startingCapital: Number(row.starting_capital),
    positionSize: Number(row.position_size),
    slippageBps: Number(row.slippage_bps),
    feePerTrade: Number(row.fee_per_trade),
    parameters: row.parameters,
    metrics: row.metrics,
    analyses: row.analyses,
    dataQuality: row.data_quality,
    capturedHistoryAvailability: row.captured_history_availability,
    replayInput: row.replay_input,
    evidence: row.evidence,
    researchEvidence: row.research_evidence ?? null,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    trades,
  });
}

function replayInputSnapshot(
  value: Omit<ReplayInputSnapshot, "version" | "resolvedAt" | "inputHash">,
): ReplayInputSnapshot {
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: "replay-input-v1",
        marketId: value.marketId,
        requestedSymbols: value.requestedSymbols,
        candidateInstruments: value.candidateInstruments,
        benchmarks: value.benchmarks,
        universeRefreshRunId: value.universeRefreshRunId,
        capturedHistoryAvailability: value.capturedHistoryAvailability,
        warnings: value.warnings,
        candidateProvenance: value.candidateProvenance,
        sessions: value.sessions,
      }),
    )
    .digest("hex");
  return {
    version: "replay-input-v1",
    resolvedAt: new Date().toISOString(),
    inputHash,
    ...value,
  };
}

const CA_REPLAY_POLICY: ReplaySessionPolicy = {
  marketId: "CA_TSX",
  timezone: "America/Toronto",
  openingRange: { start: "09:30", end: "09:45" },
  scanning: { start: "09:45", end: "16:00" },
  entries: { preferredStart: "10:00", preferredEnd: "11:30", hardEnd: "16:00" },
};

function sessionDateExpression(
  column: string,
  timezone: ReplaySessionPolicy["timezone"],
): string {
  // This closed union is application-controlled, never raw request input.
  return `(${column} AT TIME ZONE '${timezone}')`;
}

function instrumentFor<T extends { instrumentId: string }>(
  instruments: readonly T[],
  instrumentId: string,
): T {
  const value = instruments.find(
    (instrument) => instrument.instrumentId === instrumentId,
  );
  if (!value)
    throw new Error(
      `Replay input does not contain instrument ${instrumentId}.`,
    );
  return value;
}

function availabilityFor(
  value: { earliest: Date | null; latest: Date | null } | undefined,
) {
  return {
    earliest: value?.earliest?.toISOString() ?? null,
    latest: value?.latest?.toISOString() ?? null,
  };
}

function dateInMarket(
  timestamp: string | null,
  marketId: MarketId,
): string | null {
  if (!timestamp) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketSessionTimezone(marketId),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date(timestamp))
    .reduce<Record<string, string>>((parts, part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
      return parts;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateOnly(value: string | Date): string {
  return typeof value === "string"
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function zonedBoundary(date: string, time: string, timezone: string): Date {
  // Toronto is UTC-4 during the scanner's March-November trading season and UTC-5 otherwise.
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const localHour = Number(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(noonUtc),
  );
  const offsetHours = localHour - 12;
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
      hours! - offsetHours,
      minutes,
    ),
  );
}
