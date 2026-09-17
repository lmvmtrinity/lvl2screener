import { normalizedQuoteSize } from "./normalized-quote-size.js";
import {
  strategyStateEventSchema,
  type StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { MarketId } from "@tsx-scanner/contracts";
import type { AssumptionsSnapshot, CandleFact, QuoteFact } from "./types.js";
import type { FundedLedger } from "./funded-ledger.js";
import type { FundedInvalidation } from "./funded-live-adapter.js";

export type PaperBotRunSource = "LIVE" | "BACKTEST";
export type PaperBotRunStatus =
  "RUNNING" | "CLOSE_PENDING" | "COMPLETED" | "FAILED";

export interface PaperBotRun {
  readonly id: string;
  readonly marketId: MarketId;
  readonly source: PaperBotRunSource;
  readonly sessionDate: string;
  readonly sessionTimezone: string;
  readonly scheduledCloseAt: string;
  readonly status: PaperBotRunStatus;
  readonly executionModelVersion: string;
  readonly assumptions: AssumptionsSnapshot;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly failureReason: string | null;
}

export interface StartRunInput {
  /** Defaults only for replaying legacy CA_TSX cohorts. New market callers set this explicitly. */
  readonly marketId?: MarketId;
  readonly source: PaperBotRunSource;
  readonly sessionDate: string;
  readonly sessionTimezone: string;
  readonly scheduledCloseAt: string;
  readonly executionModelVersion: string;
  readonly assumptions: AssumptionsSnapshot;
}

export type EligibilityStatus = "ELIGIBLE" | "BELOW_SCORE_CUTOFF";

export interface InsertObservationInput {
  readonly runId: string;
  readonly sourceEventId: string;
  readonly sourceSignalId: string | null;
  readonly setupInstanceId: string | null;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly profileConfigId: string;
  readonly configVersion: string;
  readonly profileParameters: unknown;
  readonly strategyKey: string;
  readonly strategyVersion: string;
  readonly signalTimestamp: string;
  readonly score: number;
  readonly entryReference: number | null;
  readonly stopReference: number | null;
  readonly targetReference: number | null;
  readonly atr14: number | null;
  readonly featureSnapshot: unknown;
  readonly reasonCodes: unknown;
  readonly sourceEventPayload: unknown;
  readonly eligibilityStatus: EligibilityStatus;
  readonly eligibilityReason: string | null;
}

export interface PaperSignalObservation extends InsertObservationInput {
  /** Retained decision-time context, captured into the immutable funded fact. */
  readonly fundedContexts?: import("./types.js").SizingContext["contexts"];
  readonly id: string;
  readonly marketId: MarketId;
  readonly createdAt: string;
  /** Database insertion wall time. Legacy rows remain null and cannot prove timely capture. */
  readonly capturedAt?: string | null;
}

export interface ChallengerObservationCapture {
  captureForObservation(
    client: PoolClient,
    observation: PaperSignalObservation,
  ): Promise<void>;
}

/** Distinguishes an insert that landed from one that hit the lifecycle/legacy unique index. */
export interface InsertObservationResult {
  readonly observation: PaperSignalObservation;
  readonly created: boolean;
}

export interface ReadyEventReconciliationCandidate {
  readonly sourceEventId: string;
  /**
   * Null when the persisted payload no longer satisfies the event contract
   * (an older schema, or a hand-edited row). Such a candidate is reported and
   * skipped rather than thrown: it can never become observable, so aborting
   * the batch on it would wedge reconciliation permanently.
   */
  readonly event: StrategyStateEvent | null;
  readonly parseError: string | null;
  readonly sourceSignalId: string;
  readonly quoteAtSignal: QuoteFact | null;
}

/** A run awaiting closure, with the data needed to apply the close horizon. */
export interface UnfinishedLiveRun {
  readonly run: PaperBotRun;
  /**
   * How many later LIVE session dates the bot has since recorded. The set of
   * LIVE runs is the bot's own record of the sessions it observed, so this
   * counts elapsed trading sessions without needing a market calendar: 0 is
   * the run's own session, 1 is the next one.
   */
  readonly laterSessions: number;
}

export interface PaperBotStore {
  /**
   * Resumes the existing RUNNING/CLOSE_PENDING live run for the same session
   * date and execution model version, or starts a new one. A restarting live
   * processor must call this before creating any observation so it never
   * opens a second concurrent run for the same session.
   */
  startOrResumeLiveRun(input: StartRunInput): Promise<PaperBotRun>;
  listUnfinishedLiveRuns(marketId?: MarketId): Promise<UnfinishedLiveRun[]>;

  /**
   * The completed one-minute bars ending exactly at `boundaryTimestamp`, from
   * persisted history rather than the current collection batch. A candle
   * execution whose noon bar was missed live can only ever resolve from here:
   * that bar was ingested, it is simply never re-delivered by a later cycle.
   * When the exact boundary bar was never ingested, the first complete bar
   * after it is returned instead, so a real delayed close resolves the row
   * rather than stranding the whole run in CLOSE_PENDING forever.
   */
  findSessionCloseCandles(
    instrumentIds: readonly string[],
    boundaryTimestamp: string,
  ): Promise<Map<string, CandleFact>>;
  /**
   * The first actionable quotes at or after the scheduled close, recovered
   * from persisted history when a processor starts after the session boundary.
   * Candidates are ordered oldest-first so the caller can keep advancing to a
   * later real quote when an earlier one cannot resolve the close (halted or
   * delayed rows are excluded here; size-dependent usability is decided by the
   * execution model). Never synthesizes a price.
   */
  findSessionCloseQuotes?(
    instrumentIds: readonly string[],
    boundaryTimestamp: string,
  ): Promise<Map<string, QuoteFact[]>>;
  startBacktestRun(input: StartRunInput): Promise<PaperBotRun>;
  completeRun(runId: string): Promise<void>;
  failRun(runId: string, reason: string): Promise<void>;
  settleRunAfterCloseRequest(
    runId: string,
  ): Promise<Extract<PaperBotRunStatus, "CLOSE_PENDING" | "COMPLETED">>;

  /**
   * Idempotent under the lifecycle unique index
   * (run_id, profile_config_id, setup_instance_id) and the legacy fallback
   * (run_id, source_event_id): a retried insert for an already-observed
   * lifecycle returns the existing row with `created: false` instead of
   * erroring or duplicating.
   */
  insertObservation(
    input: InsertObservationInput,
  ): Promise<InsertObservationResult>;
  findObservationById(id: string): Promise<PaperSignalObservation | undefined>;

  /** All eligible observations, including rows whose legacy evidence is already complete. */
  findEligibleObservationsForFunding?(
    runId: string,
  ): Promise<PaperSignalObservation[]>;

  /** Durable setup-lifecycle invalidations mapped to funded order identities. */
  findFundedInvalidations?(runId: string): Promise<FundedInvalidation[]>;

  /** Eligible rows lacking a shadow decision, used to repair post-deploy/restart gaps. */
  findEligibleObservationsWithoutCoordination?(
    runId: string,
  ): Promise<PaperSignalObservation[]>;

  /**
   * Persisted READY events in this run's session whose durable paper evidence
   * is incomplete. This includes a missing observation and an eligible
   * observation missing either execution child, so startup reconciliation
   * repairs every crash window in the creation sequence.
   */
  findUnobservedReadyEvents(
    runId: string,
    limit?: number,
  ): Promise<ReadyEventReconciliationCandidate[]>;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

interface PaperBotRunRow {
  id: string;
  marketId: MarketId;
  source: PaperBotRunSource;
  sessionDate: Date | string;
  sessionTimezone: string;
  scheduledCloseAt: Date | string;
  status: PaperBotRunStatus;
  executionModelVersion: string;
  assumptions: AssumptionsSnapshot;
  startedAt: Date | string;
  completedAt: Date | string | null;
  failedAt: Date | string | null;
  failureReason: string | null;
}

function mapRun(row: PaperBotRunRow): PaperBotRun {
  return {
    id: row.id,
    marketId: row.marketId,
    source: row.source,
    sessionDate: toIso(row.sessionDate).slice(0, 10),
    sessionTimezone: row.sessionTimezone,
    scheduledCloseAt: toIso(row.scheduledCloseAt),
    status: row.status,
    executionModelVersion: row.executionModelVersion,
    assumptions: row.assumptions,
    startedAt: toIso(row.startedAt),
    completedAt: row.completedAt ? toIso(row.completedAt) : null,
    failedAt: row.failedAt ? toIso(row.failedAt) : null,
    failureReason: row.failureReason,
  };
}

function validateResumedRun(
  run: PaperBotRun,
  input: StartRunInput,
): PaperBotRun {
  if (run.marketId !== (input.marketId ?? "CA_TSX")) {
    throw new Error(`paper bot run ${run.id} belongs to another market`);
  }
  if (run.status === "FAILED") {
    throw new Error(
      `paper bot run ${run.id} for ${run.sessionDate} is FAILED and cannot be resumed`,
    );
  }
  if (
    run.sessionTimezone !== input.sessionTimezone ||
    run.scheduledCloseAt !== new Date(input.scheduledCloseAt).toISOString() ||
    !isDeepStrictEqual(run.assumptions, input.assumptions)
  ) {
    throw new Error(
      `paper bot run ${run.id} assumptions do not match the immutable ${run.executionModelVersion} cohort`,
    );
  }
  return run;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

const SELECT_RUN = `SELECT id, market_id AS "marketId", source, session_date AS "sessionDate", session_timezone AS "sessionTimezone",
  scheduled_close_at AS "scheduledCloseAt", status, execution_model_version AS "executionModelVersion",
  assumptions, started_at AS "startedAt", completed_at AS "completedAt", failed_at AS "failedAt", failure_reason AS "failureReason"
  FROM paper_bot_run`;

/**
 * Upper bound of persisted post-close quote candidates returned per instrument.
 * The first actionable row is usually the close, but a capacity-constrained
 * exit can need a later one; twenty bounded real quotes cover that retry
 * without materializing a full five-minute collection window.
 */
const SESSION_CLOSE_QUOTE_CANDIDATES = 20;

interface PaperSignalObservationRow {
  id: string;
  marketId: MarketId;
  runId: string;
  sourceEventId: string;
  sourceSignalId: string | null;
  setupInstanceId: string | null;
  instrumentId: string;
  symbol: string;
  profileId: string;
  profileName: string;
  profileConfigId: string;
  configVersion: string;
  profileParameters: unknown;
  strategyKey: string;
  strategyVersion: string;
  signalTimestamp: Date | string;
  score: number;
  entryReference: string | number | null;
  stopReference: string | number | null;
  targetReference: string | number | null;
  atr14: string | number | null;
  featureSnapshot: unknown;
  reasonCodes: unknown;
  sourceEventPayload: unknown;
  eligibilityStatus: EligibilityStatus;
  eligibilityReason: string | null;
  createdAt: Date | string;
  capturedAt: Date | string | null;
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function mapObservation(
  row: PaperSignalObservationRow,
): PaperSignalObservation {
  return {
    id: row.id,
    marketId: row.marketId,
    runId: row.runId,
    sourceEventId: row.sourceEventId,
    sourceSignalId: row.sourceSignalId,
    setupInstanceId: row.setupInstanceId,
    instrumentId: row.instrumentId,
    symbol: row.symbol,
    profileId: row.profileId,
    profileName: row.profileName,
    profileConfigId: row.profileConfigId,
    configVersion: row.configVersion,
    profileParameters: row.profileParameters,
    strategyKey: row.strategyKey,
    strategyVersion: row.strategyVersion,
    signalTimestamp: toIso(row.signalTimestamp),
    score: row.score,
    entryReference: nullableNumber(row.entryReference),
    stopReference: nullableNumber(row.stopReference),
    targetReference: nullableNumber(row.targetReference),
    atr14: nullableNumber(row.atr14),
    featureSnapshot: row.featureSnapshot,
    reasonCodes: row.reasonCodes,
    sourceEventPayload: row.sourceEventPayload,
    eligibilityStatus: row.eligibilityStatus,
    eligibilityReason: row.eligibilityReason,
    createdAt: toIso(row.createdAt),
    capturedAt: row.capturedAt ? toIso(row.capturedAt) : null,
  };
}

const SELECT_OBSERVATION = `SELECT o.id, r.market_id AS "marketId", o.run_id AS "runId", o.source_event_id AS "sourceEventId", o.source_signal_id AS "sourceSignalId",
  o.setup_instance_id AS "setupInstanceId", o.instrument_id AS "instrumentId", o.symbol, o.profile_id AS "profileId", o.profile_name AS "profileName",
  o.profile_config_id AS "profileConfigId", o.config_version AS "configVersion", o.profile_parameters AS "profileParameters",
  o.strategy_key AS "strategyKey", o.strategy_version AS "strategyVersion", o.signal_timestamp AS "signalTimestamp", o.score,
  o.entry_reference AS "entryReference", o.stop_reference AS "stopReference", o.target_reference AS "targetReference", o.atr_14 AS "atr14",
  o.feature_snapshot AS "featureSnapshot", o.reason_codes AS "reasonCodes", o.source_event_payload AS "sourceEventPayload",
  o.eligibility_status AS "eligibilityStatus", o.eligibility_reason AS "eligibilityReason", o.created_at AS "createdAt",
  o.captured_at AS "capturedAt"
  FROM paper_signal_observation o JOIN paper_bot_run r ON r.id=o.run_id`;

export class PostgresPaperBotStore implements PaperBotStore {
  constructor(
    private readonly pool: Pool,
    private readonly challengerCapture?: ChallengerObservationCapture,
  ) {}

  async startOrResumeLiveRun(input: StartRunInput): Promise<PaperBotRun> {
    const existing = await this.pool.query<PaperBotRunRow>(
      `${SELECT_RUN} WHERE market_id=$1 AND source='LIVE' AND session_date=$2 AND execution_model_version=$3
        ORDER BY created_at LIMIT 1`,
      [
        input.marketId ?? "CA_TSX",
        input.sessionDate,
        input.executionModelVersion,
      ],
    );
    if (existing.rows[0])
      return validateResumedRun(mapRun(existing.rows[0]), input);
    try {
      return await this.insertRun(input);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.pool.query<PaperBotRunRow>(
        `${SELECT_RUN} WHERE market_id=$1 AND source='LIVE' AND session_date=$2 AND execution_model_version=$3
          ORDER BY created_at LIMIT 1`,
        [
          input.marketId ?? "CA_TSX",
          input.sessionDate,
          input.executionModelVersion,
        ],
      );
      if (!raced.rows[0]) throw error;
      return validateResumedRun(mapRun(raced.rows[0]), input);
    }
  }

  async findSessionCloseCandles(
    instrumentIds: readonly string[],
    boundaryTimestamp: string,
  ): Promise<Map<string, CandleFact>> {
    const candles = new Map<string, CandleFact>();
    if (instrumentIds.length === 0) return candles;
    const result = await this.pool.query<{
      instrumentId: string;
      startTime: Date | string;
      endTime: Date | string;
      open: string | number;
      high: string | number;
      low: string | number;
      close: string | number;
    }>(
      // Prefer the bar ending exactly at the boundary; when it was never
      // ingested, the first complete bar after it is a real delayed close.
      `SELECT DISTINCT ON (instrument_id)
         instrument_id AS "instrumentId", start_time AS "startTime",
         end_time AS "endTime", open, high, low, close
       FROM candle
       WHERE timeframe='OneMinute' AND is_complete
         AND end_time >= $2::timestamptz
         AND instrument_id = ANY($1::uuid[])
       ORDER BY instrument_id, end_time ASC`,
      [[...instrumentIds], boundaryTimestamp],
    );
    for (const row of result.rows) {
      candles.set(row.instrumentId, {
        start: toIso(row.startTime),
        end: toIso(row.endTime),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
      });
    }
    return candles;
  }

  async findSessionCloseQuotes(
    instrumentIds: readonly string[],
    boundaryTimestamp: string,
  ): Promise<Map<string, QuoteFact[]>> {
    const quotes = new Map<string, QuoteFact[]>();
    if (instrumentIds.length === 0) return quotes;
    const result = await this.pool.query<{
      instrumentId: string;
      timestamp: Date | string;
      bid: string | number;
      ask: string | number;
      bidSize: string | number;
      askSize: string | number;
      sizeUnit: string | null;
      sizeMultiplier: number | null;
      isDelayed: boolean;
      isHalted: boolean;
    }>(
      // One ordered candidate list per instrument, bounded so a long
      // post-close collection window cannot materialize thousands of rows.
      // The first actionable quote is not always usable (for example a
      // capacity-constrained exit needs displayed size), so the caller retries
      // with the next real quote instead of being stuck on the first row
      // forever.
      `SELECT q.instrument_id AS "instrumentId",q.timestamp,q.bid,q.ask,
         q.bid_size AS "bidSize",q.ask_size AS "askSize",
         q.size_unit AS "sizeUnit",q.size_multiplier AS "sizeMultiplier",
         q.is_delayed AS "isDelayed",q.is_halted AS "isHalted"
       FROM unnest($1::uuid[]) AS ids(instrument_id)
       CROSS JOIN LATERAL (
         SELECT instrument_id,timestamp,bid,ask,bid_size,ask_size,
           size_unit,size_multiplier,is_delayed,is_halted
         FROM quote_snapshot q0
         WHERE q0.instrument_id=ids.instrument_id
           AND q0.timestamp >= $2::timestamptz
           AND COALESCE(q0.is_halted,false)=false
           AND COALESCE(q0.is_delayed,false)=false
           AND q0.bid IS NOT NULL AND q0.bid > 0
           AND q0.bid_size IS NOT NULL AND q0.bid_size >= 0
         ORDER BY q0.timestamp ASC
         LIMIT $3
       ) q
       ORDER BY q.instrument_id,q.timestamp ASC`,
      [[...instrumentIds], boundaryTimestamp, SESSION_CLOSE_QUOTE_CANDIDATES],
    );
    for (const row of result.rows) {
      const list = quotes.get(row.instrumentId) ?? [];
      list.push({
        timestamp: toIso(row.timestamp),
        bid: Number(row.bid),
        ask: Number(row.ask),
        bidSize: Number(row.bidSize),
        askSize: Number(row.askSize),
        ...normalizedQuoteSize(row.sizeUnit, row.sizeMultiplier),
        dataStatus: "REALTIME",
        actionable: true,
      });
      quotes.set(row.instrumentId, list);
    }
    return quotes;
  }

  async listUnfinishedLiveRuns(
    marketId?: MarketId,
  ): Promise<UnfinishedLiveRun[]> {
    const filterMarket = marketId !== undefined;
    const result = await this.pool.query<
      PaperBotRunRow & { laterSessions: string }
    >(
      `SELECT r.id, r.market_id AS "marketId", r.source, r.session_date AS "sessionDate",
        r.session_timezone AS "sessionTimezone", r.scheduled_close_at AS "scheduledCloseAt",
        r.status, r.execution_model_version AS "executionModelVersion", r.assumptions,
        r.started_at AS "startedAt", r.completed_at AS "completedAt",
        r.failed_at AS "failedAt", r.failure_reason AS "failureReason",
        (SELECT count(DISTINCT later.session_date)
         FROM paper_bot_run later
         WHERE later.source='LIVE' AND later.market_id = r.market_id AND later.session_date > r.session_date) AS "laterSessions"
       FROM paper_bot_run r
       WHERE r.source='LIVE'
         ${filterMarket ? "AND r.market_id=$1" : ""}
         AND (
           r.status IN ('RUNNING','CLOSE_PENDING')
           -- A run settled to COMPLETED can still acquire an unfinished
           -- execution afterwards (a late reconciliation of a post-noon READY
           -- event). Without this it would never be revisited, leaving the
           -- execution OPEN forever.
           OR EXISTS (
             SELECT 1 FROM paper_signal_observation o
             JOIN paper_execution e ON e.observation_id=o.id
             WHERE o.run_id=r.id AND e.status IN ('OPEN','CLOSE_PENDING')
               AND e.close_abandoned_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM paper_coordination_position p
             JOIN paper_coordination_decision d ON d.id=p.decision_id
             WHERE d.run_id=r.id AND p.status IN ('OPEN','CLOSE_PENDING')
           )
         )
         ORDER BY r.session_date,r.started_at`,
      filterMarket ? [marketId] : [],
    );
    return result.rows.map((row) => ({
      run: mapRun(row),
      laterSessions: Number(row.laterSessions),
    }));
  }

  async startBacktestRun(input: StartRunInput): Promise<PaperBotRun> {
    return this.insertRun(input);
  }

  private async insertRun(input: StartRunInput): Promise<PaperBotRun> {
    const result = await this.pool.query<PaperBotRunRow>(
      `INSERT INTO paper_bot_run (market_id, source, session_date, session_timezone, scheduled_close_at, status, execution_model_version, assumptions)
        VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,$7)
        RETURNING id, market_id AS "marketId", source, session_date AS "sessionDate", session_timezone AS "sessionTimezone",
          scheduled_close_at AS "scheduledCloseAt", status, execution_model_version AS "executionModelVersion",
          assumptions, started_at AS "startedAt", completed_at AS "completedAt", failed_at AS "failedAt", failure_reason AS "failureReason"`,
      [
        input.marketId ?? "CA_TSX",
        input.source,
        input.sessionDate,
        input.sessionTimezone,
        input.scheduledCloseAt,
        input.executionModelVersion,
        JSON.stringify(input.assumptions),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("paper_bot_run insert returned no row");
    return mapRun(row);
  }

  async completeRun(runId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{ status: PaperBotRunStatus }>(
        "SELECT status FROM paper_bot_run WHERE id=$1 FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new Error(`paper bot run ${runId} not found`);
      await client.query(
        `UPDATE paper_bot_run SET status='COMPLETED', completed_at=now() WHERE id=$1`,
        [runId],
      );
      // A pre-079 completed run has no provable boundary. Re-settling it after
      // a later session must not manufacture one from the current account.
      if (run.rows[0].status !== "COMPLETED")
        await this.captureFundedRunSnapshot(client, runId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async failRun(runId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE paper_bot_run SET status='FAILED', failed_at=now(), failure_reason=$2 WHERE id=$1`,
      [runId, reason],
    );
  }

  async settleRunAfterCloseRequest(
    runId: string,
  ): Promise<"CLOSE_PENDING" | "COMPLETED"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{
        status: PaperBotRunStatus;
      }>(
        "SELECT status FROM paper_bot_run WHERE id=$1 AND status IN ('RUNNING','CLOSE_PENDING','COMPLETED') FOR UPDATE",
        [runId],
      );
      if (!run.rows[0])
        throw new Error(`paper bot run ${runId} cannot be settled`);
      const unresolved = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM paper_signal_observation o
           JOIN paper_execution e ON e.observation_id=o.id
           WHERE o.run_id=$1 AND e.status IN ('OPEN','CLOSE_PENDING')
             AND e.close_abandoned_at IS NULL
         ) OR EXISTS (
           SELECT 1 FROM paper_coordination_position p
           JOIN paper_coordination_decision d ON d.id=p.decision_id
           WHERE d.run_id=$1 AND p.status IN ('OPEN','CLOSE_PENDING')
         ) OR EXISTS (
           SELECT 1 FROM paper_entry_order o
           WHERE o.run_id=$1 AND (o.state->>'status'='PENDING'
             OR o.state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING'))
         ) OR EXISTS (
           SELECT 1 FROM paper_funded_fact f WHERE f.run_id=$1 AND f.outcome IS NULL
         ) AS exists`,
        [runId],
      );
      const status: "CLOSE_PENDING" | "COMPLETED" = unresolved.rows[0]?.exists
        ? "CLOSE_PENDING"
        : "COMPLETED";
      await client.query(
        `UPDATE paper_bot_run SET status=$2,
           completed_at=CASE WHEN $2='COMPLETED' THEN COALESCE(completed_at,now()) ELSE NULL END
         WHERE id=$1`,
        [runId, status],
      );
      // Only a real CLOSE_PENDING/RUNNING -> COMPLETED transition owns this
      // boundary. A legacy completed row without a snapshot remains
      // intentionally unavailable for run-end reporting.
      if (status === "COMPLETED" && run.rows[0].status !== "COMPLETED")
        await this.captureFundedRunSnapshot(client, runId);
      await client.query("COMMIT");
      return status;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async captureFundedRunSnapshot(
    client: PoolClient,
    runId: string,
  ): Promise<void> {
    const account = await client.query<{
      accountId: string;
      state: FundedLedger;
    }>(
      `SELECT b.account_id AS "accountId",a.state
       FROM paper_funded_run b
       JOIN paper_funded_account a ON a.id=b.account_id
       WHERE b.run_id=$1`,
      [runId],
    );
    const row = account.rows[0];
    if (!row) return;
    const orders = await client.query<{
      instrumentId: string;
      state: unknown;
    }>(
      'SELECT instrument_id AS "instrumentId",state FROM paper_entry_order WHERE run_id=$1 ORDER BY created_at,order_id',
      [runId],
    );
    const boundaryAt = row.state.lastEventAt;
    // The reconstruction checkpoint cursor is recorded only when it is
    // provable at write time: the snapshot state's final retained event must
    // be durably verified at exactly this boundary and no later-sequenced
    // durable event may claim a time at or before it. A NULL cursor keeps the
    // snapshot authoritative for run-end reporting but unavailable as a
    // reconstruction checkpoint, so no unprovable history is ever assumed.
    const finalEventId = row.state.events.at(-1)?.id ?? null;
    const anchor = finalEventId
      ? await client.query<{ event_sequence: number | string | null }>(
          `SELECT CASE WHEN NOT EXISTS (
                    SELECT 1 FROM paper_funded_event x
                     WHERE x.account_id=$1
                       AND x.event_sequence > e.event_sequence
                       AND (x.event->>'at')::timestamptz <= $2::timestamptz
                   )
                   THEN e.event_sequence END AS "event_sequence"
             FROM paper_funded_event e
            WHERE e.account_id=$1
              AND e.event_id=$3
              AND e.event_sequence_verified
              AND (e.event->>'at')::timestamptz = $2::timestamptz`,
          [row.accountId, boundaryAt, finalEventId],
        )
      : { rows: [{ event_sequence: null }] };
    await client.query(
      `INSERT INTO paper_funded_run_snapshot(run_id,account_id,boundary_at,state,orders,boundary_event_sequence)
       VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)
       ON CONFLICT(run_id) DO NOTHING`,
      [
        runId,
        row.accountId,
        boundaryAt,
        JSON.stringify(row.state),
        JSON.stringify(orders.rows),
        anchor.rows[0]?.event_sequence ?? null,
      ],
    );
  }

  async insertObservation(
    input: InsertObservationInput,
  ): Promise<InsertObservationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO paper_signal_observation (
          run_id, market_id, source_event_id, source_signal_id, setup_instance_id, instrument_id, symbol,
          profile_id, profile_name, profile_config_id, config_version, profile_parameters,
          strategy_key, strategy_version, signal_timestamp, score,
          entry_reference, stop_reference, target_reference, atr_14, feature_snapshot,
          reason_codes, source_event_payload, eligibility_status, eligibility_reason
        ) VALUES ($1,(SELECT market_id FROM paper_bot_run WHERE id=$1),$2,COALESCE($3,(SELECT signal_id FROM strategy_state_event WHERE id=$2)),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [
          input.runId,
          input.sourceEventId,
          input.sourceSignalId,
          input.setupInstanceId,
          input.instrumentId,
          input.symbol,
          input.profileId,
          input.profileName,
          input.profileConfigId,
          input.configVersion,
          JSON.stringify(input.profileParameters),
          input.strategyKey,
          input.strategyVersion,
          input.signalTimestamp,
          input.score,
          input.entryReference,
          input.stopReference,
          input.targetReference,
          input.atr14,
          JSON.stringify(input.featureSnapshot),
          JSON.stringify(input.reasonCodes),
          JSON.stringify(input.sourceEventPayload),
          input.eligibilityStatus,
          input.eligibilityReason,
        ],
      );
      let observation: PaperSignalObservation;
      if (inserted.rows[0]) {
        observation = await this.findByIdWithClient(
          client,
          inserted.rows[0].id,
        );
      } else {
        const existing = await this.findExistingWithClient(client, input);
        if (!existing) {
          throw new Error(
            "paper_signal_observation insert conflicted but no matching row was found",
          );
        }
        observation = existing;
      }
      if (
        observation.eligibilityStatus === "ELIGIBLE" &&
        this.challengerCapture
      ) {
        const timeouts = await client.query<{
          lock_timeout: string;
          statement_timeout: string;
        }>(
          "SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout",
        );
        await client.query("SAVEPOINT challenger_attempt_capture");
        try {
          await client.query("SET LOCAL lock_timeout = '250ms'");
          await client.query("SET LOCAL statement_timeout = '1000ms'");
          await this.challengerCapture.captureForObservation(
            client,
            observation,
          );
          await client.query("RELEASE SAVEPOINT challenger_attempt_capture");
        } catch {
          // The authoritative observation remains committed. Rolling back only
          // the savepoint preserves paper execution and leaves the omission
          // visible to the report/reconciliation path.
          await client.query(
            "ROLLBACK TO SAVEPOINT challenger_attempt_capture",
          );
          await client.query("RELEASE SAVEPOINT challenger_attempt_capture");
        }
        const original = timeouts.rows[0]!;
        await client.query(
          "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
          [original.lock_timeout, original.statement_timeout],
        );
      }
      await client.query("COMMIT");
      return { observation, created: Boolean(inserted.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findObservationById(
    id: string,
  ): Promise<PaperSignalObservation | undefined> {
    const result = await this.pool.query<PaperSignalObservationRow>(
      `${SELECT_OBSERVATION} WHERE o.id=$1`,
      [id],
    );
    return result.rows[0] ? mapObservation(result.rows[0]) : undefined;
  }

  async findEligibleObservationsWithoutCoordination(
    runId: string,
  ): Promise<PaperSignalObservation[]> {
    const result = await this.pool.query<PaperSignalObservationRow>(
      `${SELECT_OBSERVATION}
       WHERE o.run_id=$1 AND o.eligibility_status='ELIGIBLE'
         AND NOT EXISTS (
           SELECT 1 FROM paper_coordination_decision d
           WHERE d.run_id=o.run_id
             AND d.symbol=o.symbol
             AND d.decision_timestamp=o.signal_timestamp
         )
        ORDER BY o.signal_timestamp ASC, o.symbol ASC, o.id ASC`,
      [runId],
    );
    return result.rows.map(mapObservation);
  }

  async findEligibleObservationsForFunding(
    runId: string,
  ): Promise<PaperSignalObservation[]> {
    const result = await this.pool.query<PaperSignalObservationRow>(
      `${SELECT_OBSERVATION}
       WHERE o.run_id=$1 AND o.eligibility_status='ELIGIBLE'
       ORDER BY o.signal_timestamp ASC, o.id ASC`,
      [runId],
    );
    return result.rows.map(mapObservation);
  }

  async findFundedInvalidations(runId: string): Promise<FundedInvalidation[]> {
    const result = await this.pool.query<{
      eventId: string;
      orderId: string;
      at: Date | string;
    }>(
      `SELECT e.id AS "eventId",o.id AS "orderId",e.timestamp AS at
       FROM strategy_state_event e
       JOIN strategy_signal s ON s.id=e.signal_id
       JOIN scanner_profile_config c
         ON c.profile_id=e.profile_id AND c.config_version=s.config_version
       JOIN paper_signal_observation o
         ON o.run_id=$1 AND o.instrument_id=e.instrument_id
        AND o.profile_config_id=c.id AND o.setup_instance_id=e.setup_instance_id
       JOIN paper_bot_run r ON r.id=o.run_id
       WHERE o.eligibility_status='ELIGIBLE'
         AND e.market_id=r.market_id
         AND e.new_state='INVALIDATED' AND e.timestamp >= o.signal_timestamp
         AND NOT EXISTS (
           SELECT 1 FROM paper_funded_fact f
           WHERE f.run_id=o.run_id
             AND f.fact_id='funded-invalidation:' || e.id::text
         )
       ORDER BY e.timestamp,e.id`,
      [runId],
    );
    return result.rows.map((row) => ({
      eventId: row.eventId,
      orderId: row.orderId,
      at: toIso(row.at),
    }));
  }

  async findUnobservedReadyEvents(
    runId: string,
    limit = 500,
  ): Promise<ReadyEventReconciliationCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new Error(
        "paper-bot reconciliation limit must be between 1 and 5000",
      );
    }
    const result = await this.pool.query<{
      sourceEventId: string;
      payload: unknown;
      sourceSignalId: string;
      quoteTimestamp: Date | string | null;
      bid: string | number | null;
      ask: string | number | null;
      bidSize: string | number | null;
      askSize: string | number | null;
      sizeUnit: string | null;
      sizeMultiplier: number | null;
      isDelayed: boolean | null;
      isHalted: boolean | null;
    }>(
      `SELECT e.id AS "sourceEventId",e.payload,e.signal_id AS "sourceSignalId",
        q.timestamp AS "quoteTimestamp", q.bid, q.ask,
        q.bid_size AS "bidSize", q.ask_size AS "askSize",
        q.size_unit AS "sizeUnit", q.size_multiplier AS "sizeMultiplier",
        q.is_delayed AS "isDelayed", q.is_halted AS "isHalted"
       FROM strategy_state_event e
       JOIN strategy_signal s ON s.id=e.signal_id
       -- LEFT, deliberately: an event whose profile_id is NULL, or whose
       -- (profile_id, config_version) no longer resolves to a configuration,
       -- must still surface as a candidate. An inner join dropped it from the
       -- result entirely, so it was never observed and never reported -- an
       -- invisible hole in the evidence. It now reaches the processor, which
       -- fails on it explicitly and counts it as unreconcilable.
       LEFT JOIN scanner_profile_config c
         ON c.profile_id=e.profile_id AND c.config_version=s.config_version
       JOIN paper_bot_run r ON r.id=$1
       LEFT JOIN LATERAL (
         SELECT timestamp,bid,ask,bid_size,ask_size,size_unit,size_multiplier,is_delayed,is_halted
         FROM quote_snapshot q0
         WHERE q0.instrument_id=e.instrument_id AND q0.timestamp <= e.timestamp
         ORDER BY q0.timestamp DESC LIMIT 1
       ) q ON true
       WHERE e.new_state='READY'
         AND e.market_id = r.market_id
         AND e.timestamp >= (r.session_date::timestamp AT TIME ZONE r.session_timezone)
         AND e.timestamp < ((r.session_date + 1)::timestamp AT TIME ZONE r.session_timezone)
          AND NOT EXISTS (
            SELECT 1 FROM paper_signal_observation o
            JOIN paper_bot_run r_prior ON r_prior.id = o.run_id
            WHERE (
              o.run_id = r.id
              OR (r.source = 'LIVE' AND r_prior.source = 'LIVE' AND r_prior.market_id = r.market_id AND r_prior.session_date = r.session_date)
            ) AND (
              o.source_event_id=e.id OR
              (e.setup_instance_id IS NOT NULL
               AND c.id IS NOT NULL
               AND o.profile_config_id=c.id
               AND o.setup_instance_id=e.setup_instance_id)
             ) AND (
               o.eligibility_status='BELOW_SCORE_CUTOFF' OR
               (SELECT count(DISTINCT pe.model) FROM paper_execution pe
                WHERE pe.observation_id=o.id)=2
             )
           )
       ORDER BY e.timestamp,e.id
       LIMIT $2`,
      [runId, limit],
    );
    return result.rows.map((row) => {
      const parsed = strategyStateEventSchema.safeParse(row.payload);
      return {
        sourceEventId: row.sourceEventId,
        event: parsed.success ? parsed.data : null,
        parseError: parsed.success ? null : parsed.error.message,
        sourceSignalId: row.sourceSignalId,
        quoteAtSignal:
          row.quoteTimestamp === null
            ? null
            : {
                timestamp: toIso(row.quoteTimestamp),
                bid: Number(row.bid),
                ask: Number(row.ask),
                bidSize: Number(row.bidSize),
                askSize: Number(row.askSize),
                ...normalizedQuoteSize(row.sizeUnit, row.sizeMultiplier),
                dataStatus: row.isHalted
                  ? "HALTED"
                  : row.isDelayed
                    ? "DELAYED"
                    : "REALTIME",
                actionable: !row.isHalted && !row.isDelayed,
              },
      };
    });
  }

  private async findByIdWithClient(
    client: PoolClient,
    id: string,
  ): Promise<PaperSignalObservation> {
    const result = await client.query<PaperSignalObservationRow>(
      `${SELECT_OBSERVATION} WHERE o.id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (!row)
      throw new Error("paper_signal_observation not found after insert");
    return mapObservation(row);
  }

  private async findExistingWithClient(
    client: PoolClient,
    input: InsertObservationInput,
  ): Promise<PaperSignalObservation | undefined> {
    const result =
      input.setupInstanceId !== null
        ? await client.query<PaperSignalObservationRow>(
            `${SELECT_OBSERVATION} WHERE o.run_id=$1 AND o.profile_config_id=$2 AND o.setup_instance_id=$3`,
            [input.runId, input.profileConfigId, input.setupInstanceId],
          )
        : await client.query<PaperSignalObservationRow>(
            `${SELECT_OBSERVATION} WHERE o.run_id=$1 AND o.source_event_id=$2`,
            [input.runId, input.sourceEventId],
          );
    return result.rows[0] ? mapObservation(result.rows[0]) : undefined;
  }
}
