import type { Pool, PoolClient } from "pg";
import type {
  CandleExecutionState,
  QuoteExecutionState,
} from "./execution-core.js";
import { roundMoney } from "./financials.js";
import type {
  ExecutionModel,
  ExecutionStatus,
  OpenPosition,
  QuoteFact,
} from "./types.js";

export interface OpenExecutionRow {
  readonly executionState?: QuoteExecutionState | CandleExecutionState | null;
  readonly observationId: string;
  readonly instrumentId: string;
  readonly model: ExecutionModel;
  readonly status: Extract<ExecutionStatus, "OPEN" | "CLOSE_PENDING">;
  readonly position: OpenPosition;
  /** QUOTE rows only; always null for CANDLE rows, which never depend on a quote. */
  readonly entryMarketSnapshot: unknown;
  readonly entrySizeCoverage: number | null;
  readonly lastFactTimestamp: string;
}

/**
 * Per-run execution counts and the most recent write, for the operational
 * status surface required by private development record ("Failure
 * visibility"). A healthy process must not be able to conceal a paper
 * lifecycle that has stopped transitioning.
 */
export interface PaperRunHealth {
  readonly open: number;
  readonly closePending: number;
  readonly closed: number;
  readonly noFill: number;
  /** Executable markets the economics gate declined; never a data failure. */
  readonly rejectedEconomics: number;
  /** CLOSE_PENDING rows past the close horizon, no longer offered facts. */
  readonly abandoned: number;
  readonly lastTransitionAt: string | null;
}

export interface PaperExecutionStore {
  /**
   * Creates both initial model rows in one transaction. Existing children are
   * left untouched, allowing reconciliation to repair a partial crash without
   * resetting an execution that has already advanced.
   */
  insertInitialExecutions(
    observationId: string,
    quoteState: QuoteExecutionState,
    candleState: CandleExecutionState,
  ): Promise<void>;

  /**
   * Inserts or updates the single (observation_id, model) row to match
   * `state`. Safe to call repeatedly with the same state: the underlying
   * UPSERT is not itself idempotency protection (execution-core's
   * transition functions already refuse to re-derive a settled outcome) but
   * a write with unchanged columns is a no-op in effect.
   */
  upsertQuoteExecution(
    observationId: string,
    state: QuoteExecutionState,
  ): Promise<void>;
  upsertCandleExecution(
    observationId: string,
    state: CandleExecutionState,
  ): Promise<void>;

  /**
   * Every OPEN or CLOSE_PENDING execution, for the durable live processor to
   * resume on startup (private development record, Phase 3). Resuming
   * from the persisted position and replaying facts forward from it is
   * sufficient: reprocessing a fact already seen before a crash is a
   * harmless no-op in execution-core.
   */
  findOpenAndClosePending(runId: string): Promise<OpenExecutionRow[]>;

  /** Execution counts and last write time for one run. */
  runHealth(runId: string): Promise<PaperRunHealth>;

  /**
   * Stops offering facts to every unresolved execution of a run whose close
   * horizon has expired. The rows keep status CLOSE_PENDING, so they remain
   * excluded from closed-trade statistics and are reported as unresolved
   * rather than closed at a price from an unrelated session.
   */
  abandonUnresolvedExecutions(runId: string, reason: string): Promise<number>;

  /**
   * Recovers the decision-time quote snapshot persisted for this observation's
   * quote execution model.
   */
  findQuoteSnapshotForObservation?(
    observationId: string,
  ): Promise<QuoteFact | null>;
}

interface ExecutionColumns {
  readonly status: ExecutionStatus;
  readonly entryPrice: number | null;
  readonly entryTime: string | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly shares: number | null;
  readonly initialRisk: number | null;
  readonly exitPrice: number | null;
  readonly exitTime: string | null;
  readonly exitReason: string | null;
  readonly fee: number | null;
  readonly grossPnl: number | null;
  readonly netPnl: number | null;
  readonly rMultiple: number | null;
  readonly noFillReason: string | null;
  readonly economicsReason: string | null;
  readonly economics: unknown;
  readonly sizing: unknown;
  readonly entryMarketSnapshot: unknown;
  readonly exitMarketSnapshot: unknown;
  readonly entrySizeCoverage: number | null;
  readonly exitSizeCoverage: number | null;
  readonly sessionCloseDelayMs: number | null;
  readonly lastFactTimestamp: string | null;
}

const EMPTY: ExecutionColumns = {
  status: "PENDING",
  entryPrice: null,
  entryTime: null,
  stopPrice: null,
  targetPrice: null,
  shares: null,
  initialRisk: null,
  exitPrice: null,
  exitTime: null,
  exitReason: null,
  fee: null,
  grossPnl: null,
  netPnl: null,
  rMultiple: null,
  noFillReason: null,
  economicsReason: null,
  economics: null,
  sizing: null,
  entryMarketSnapshot: null,
  exitMarketSnapshot: null,
  entrySizeCoverage: null,
  exitSizeCoverage: null,
  sessionCloseDelayMs: null,
  lastFactTimestamp: null,
};

function columnsForQuote(state: QuoteExecutionState): ExecutionColumns {
  if (state.status === "NO_FILL") {
    return {
      ...EMPTY,
      status: "NO_FILL",
      noFillReason: state.noFillReason,
      entryMarketSnapshot: state.entryMarketSnapshot,
    };
  }
  if (state.status === "REJECTED_ECONOMICS") {
    return {
      ...EMPTY,
      status: "REJECTED_ECONOMICS",
      economicsReason: state.economicsReason,
      economics: state.economics,
      entryMarketSnapshot: state.entryMarketSnapshot,
    };
  }
  const base: ExecutionColumns = {
    ...EMPTY,
    status: state.status,
    entryPrice: state.position.entryPrice,
    entryTime: state.position.entryTime,
    stopPrice: state.position.stop,
    targetPrice: state.position.target,
    shares: state.position.shares,
    initialRisk: state.position.initialRisk,
    economics: state.economics ?? null,
    sizing: state.sizing ?? null,
    entryMarketSnapshot: state.entryMarketSnapshot,
    entrySizeCoverage: state.entrySizeCoverage,
    lastFactTimestamp:
      state.status === "CLOSED" ? state.exit.exitTime : state.lastFactTimestamp,
  };
  if (state.status !== "CLOSED") return base;
  return {
    ...base,
    status: "CLOSED",
    exitPrice: state.exit.financials.exitPrice,
    exitTime: state.exit.exitTime,
    exitReason: state.exit.exitReason,
    fee: roundMoney(
      state.exit.financials.grossPnl - state.exit.financials.netPnl,
    ),
    grossPnl: state.exit.financials.grossPnl,
    netPnl: state.exit.financials.netPnl,
    rMultiple: state.exit.financials.rMultiple,
    exitMarketSnapshot: state.exit.exitMarketSnapshot,
    exitSizeCoverage: state.exit.exitSizeCoverage,
    sessionCloseDelayMs: state.exit.sessionCloseDelayMs,
  };
}

function columnsForCandle(state: CandleExecutionState): ExecutionColumns {
  if (state.status === "NO_FILL") {
    return { ...EMPTY, status: "NO_FILL", noFillReason: state.noFillReason };
  }
  if (state.status === "REJECTED_ECONOMICS") {
    return {
      ...EMPTY,
      status: "REJECTED_ECONOMICS",
      economicsReason: state.economicsReason,
      economics: state.economics,
    };
  }
  const base: ExecutionColumns = {
    ...EMPTY,
    status: state.status,
    entryPrice: state.position.entryPrice,
    entryTime: state.position.entryTime,
    stopPrice: state.position.stop,
    targetPrice: state.position.target,
    shares: state.position.shares,
    initialRisk: state.position.initialRisk,
    economics: state.economics ?? null,
    sizing: state.sizing ?? null,
    lastFactTimestamp:
      state.status === "CLOSED" ? state.exit.exitTime : state.lastFactTimestamp,
  };
  if (state.status !== "CLOSED") return base;
  return {
    ...base,
    status: "CLOSED",
    exitPrice: state.exit.financials.exitPrice,
    exitTime: state.exit.exitTime,
    exitReason: state.exit.exitReason,
    fee: roundMoney(
      state.exit.financials.grossPnl - state.exit.financials.netPnl,
    ),
    grossPnl: state.exit.financials.grossPnl,
    netPnl: state.exit.financials.netPnl,
    rMultiple: state.exit.financials.rMultiple,
  };
}

const UPSERT_SQL = `INSERT INTO paper_execution (
    observation_id, market_id, model, status,
    entry_price, entry_time, stop_price, target_price, shares, initial_risk,
    exit_price, exit_time, exit_reason, fee, gross_pnl, net_pnl, r_multiple,
    no_fill_reason, entry_market_snapshot, exit_market_snapshot,
    entry_size_coverage, exit_size_coverage, session_close_delay_ms,last_fact_timestamp,
    economics_reason, economics, sizing, execution_state
  ) VALUES ($1,(SELECT r.market_id FROM paper_signal_observation o JOIN paper_bot_run r ON r.id=o.run_id WHERE o.id=$1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
  ON CONFLICT (observation_id, model) DO UPDATE SET
    status=EXCLUDED.status, entry_price=EXCLUDED.entry_price, entry_time=EXCLUDED.entry_time,
    stop_price=EXCLUDED.stop_price, target_price=EXCLUDED.target_price, shares=EXCLUDED.shares,
    initial_risk=EXCLUDED.initial_risk, exit_price=EXCLUDED.exit_price, exit_time=EXCLUDED.exit_time,
    exit_reason=EXCLUDED.exit_reason, fee=EXCLUDED.fee, gross_pnl=EXCLUDED.gross_pnl,
    net_pnl=EXCLUDED.net_pnl, r_multiple=EXCLUDED.r_multiple, no_fill_reason=EXCLUDED.no_fill_reason,
    entry_market_snapshot=EXCLUDED.entry_market_snapshot, exit_market_snapshot=EXCLUDED.exit_market_snapshot,
    entry_size_coverage=EXCLUDED.entry_size_coverage, exit_size_coverage=EXCLUDED.exit_size_coverage,
    session_close_delay_ms=EXCLUDED.session_close_delay_ms,
    last_fact_timestamp=EXCLUDED.last_fact_timestamp,
    economics_reason=EXCLUDED.economics_reason, economics=EXCLUDED.economics,
    sizing=EXCLUDED.sizing, execution_state=EXCLUDED.execution_state,
    updated_at=now()`;

const INSERT_IF_ABSENT_SQL = `${UPSERT_SQL.slice(0, UPSERT_SQL.indexOf("  ON CONFLICT"))}
  ON CONFLICT (observation_id, model) DO NOTHING`;

function upsertParams(
  observationId: string,
  model: ExecutionModel,
  c: ExecutionColumns,
  state: QuoteExecutionState | CandleExecutionState,
): unknown[] {
  return [
    observationId,
    model,
    c.status,
    c.entryPrice,
    c.entryTime,
    c.stopPrice,
    c.targetPrice,
    c.shares,
    c.initialRisk,
    c.exitPrice,
    c.exitTime,
    c.exitReason,
    c.fee,
    c.grossPnl,
    c.netPnl,
    c.rMultiple,
    c.noFillReason,
    c.entryMarketSnapshot === null
      ? null
      : JSON.stringify(c.entryMarketSnapshot),
    c.exitMarketSnapshot === null ? null : JSON.stringify(c.exitMarketSnapshot),
    c.entrySizeCoverage,
    c.exitSizeCoverage,
    c.sessionCloseDelayMs,
    c.lastFactTimestamp,
    c.economicsReason,
    c.economics === null ? null : JSON.stringify(c.economics),
    c.sizing === null ? null : JSON.stringify(c.sizing),
    JSON.stringify(state),
  ];
}

interface OpenExecutionQueryRow {
  executionState: QuoteExecutionState | CandleExecutionState | null;
  observationId: string;
  instrumentId: string;
  model: ExecutionModel;
  status: "OPEN" | "CLOSE_PENDING";
  entryPrice: string | number;
  entryTime: Date | string;
  stopPrice: string | number;
  targetPrice: string | number;
  shares: number;
  initialRisk: string | number;
  entryMarketSnapshot: unknown;
  entrySizeCoverage: string | number | null;
  lastFactTimestamp: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export class PostgresPaperExecutionStore implements PaperExecutionStore {
  constructor(private readonly pool: Pool) {}

  async insertInitialExecutions(
    observationId: string,
    quoteState: QuoteExecutionState,
    candleState: CandleExecutionState,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        INSERT_IF_ABSENT_SQL,
        upsertParams(
          observationId,
          "QUOTE",
          columnsForQuote(quoteState),
          quoteState,
        ),
      );
      await client.query(
        INSERT_IF_ABSENT_SQL,
        upsertParams(
          observationId,
          "CANDLE",
          columnsForCandle(candleState),
          candleState,
        ),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertQuoteExecution(
    observationId: string,
    state: QuoteExecutionState,
  ): Promise<void> {
    const columns = columnsForQuote(state);
    await this.pool.query(
      UPSERT_SQL,
      upsertParams(observationId, "QUOTE", columns, state),
    );
    if (state.status === "CLOSED")
      await this.captureLabelEvidence(observationId);
  }

  async upsertCandleExecution(
    observationId: string,
    state: CandleExecutionState,
  ): Promise<void> {
    const columns = columnsForCandle(state);
    await this.pool.query(
      UPSERT_SQL,
      upsertParams(observationId, "CANDLE", columns, state),
    );
  }

  /**
   * Label availability is useful challenger evidence, but it is not part of
   * authoritative execution settlement. Keep it on an isolated best-effort
   * write so a missing/new migration or a transient lock cannot roll back the
   * paper execution itself. Legacy closed rows intentionally remain
   * unavailable until this receipt is written prospectively.
   */
  private async captureLabelEvidence(observationId: string): Promise<void> {
    await this.writeLabelEvidence(1, observationId);
  }

  async reconcileLabelEvidence(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("CHALLENGER_LABEL_LIMIT_INVALID");
    return this.writeLabelEvidence(limit, null);
  }

  private async writeLabelEvidence(
    limit: number,
    observationId: string | null,
  ): Promise<number> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='250ms'");
      await client.query("SET LOCAL statement_timeout='1000ms'");
      const result = await client.query(
        `INSERT INTO challenger_label_evidence(
        execution_id,observation_id,market_id,model,exit_at,source_revision,label)
        SELECT e.id,e.observation_id,e.market_id,e.model,e.exit_time,'paper-execution-v1',
          jsonb_build_object('status',e.status,'rMultiple',e.r_multiple,'netPnl',e.net_pnl,'exitReason',e.exit_reason)
        FROM paper_execution e WHERE e.model='QUOTE' AND e.status='CLOSED'
          AND e.exit_time IS NOT NULL AND e.exit_time<=clock_timestamp()
          AND ($1::uuid IS NULL OR e.observation_id=$1)
          AND NOT EXISTS(SELECT 1 FROM challenger_label_evidence le WHERE le.execution_id=e.id)
        ORDER BY e.exit_time,e.id LIMIT $2 ON CONFLICT(execution_id) DO NOTHING`,
        [observationId, limit],
      );
      await client.query("COMMIT");
      return result.rowCount ?? 0;
    } catch {
      await client?.query("ROLLBACK").catch(() => undefined);
      // A later bounded worker pass captures at its actual recovery clock.
      return 0;
    } finally {
      client?.release();
    }
  }

  async runHealth(runId: string): Promise<PaperRunHealth> {
    const result = await this.pool.query<{
      open: string;
      closePending: string;
      closed: string;
      noFill: string;
      rejectedEconomics: string;
      abandoned: string;
      lastTransitionAt: Date | string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE e.status='OPEN') AS "open",
         count(*) FILTER (WHERE e.status='CLOSE_PENDING') AS "closePending",
         count(*) FILTER (WHERE e.status='CLOSED') AS "closed",
         count(*) FILTER (WHERE e.status='NO_FILL') AS "noFill",
         count(*) FILTER (WHERE e.status='REJECTED_ECONOMICS') AS "rejectedEconomics",
         count(*) FILTER (WHERE e.close_abandoned_at IS NOT NULL) AS "abandoned",
         max(e.updated_at) AS "lastTransitionAt"
       FROM paper_execution e
       JOIN paper_signal_observation o ON o.id=e.observation_id
       WHERE o.run_id=$1`,
      [runId],
    );
    const row = result.rows[0];
    return {
      open: Number(row?.open ?? 0),
      closePending: Number(row?.closePending ?? 0),
      closed: Number(row?.closed ?? 0),
      noFill: Number(row?.noFill ?? 0),
      rejectedEconomics: Number(row?.rejectedEconomics ?? 0),
      abandoned: Number(row?.abandoned ?? 0),
      lastTransitionAt:
        row?.lastTransitionAt == null ? null : toIso(row.lastTransitionAt),
    };
  }

  async abandonUnresolvedExecutions(
    runId: string,
    reason: string,
  ): Promise<number> {
    const result = await this.pool.query(
      `UPDATE paper_execution e
         SET status='CLOSE_PENDING', close_abandoned_at=now(),
             unresolved_reason=$2, updated_at=now()
       FROM paper_signal_observation o
       WHERE o.id=e.observation_id AND o.run_id=$1
         AND e.status IN ('OPEN','CLOSE_PENDING')
         AND e.close_abandoned_at IS NULL`,
      [runId, reason],
    );
    return result.rowCount ?? 0;
  }

  async findOpenAndClosePending(runId: string): Promise<OpenExecutionRow[]> {
    const result = await this.pool.query<OpenExecutionQueryRow>(
      `SELECT e.observation_id AS "observationId", o.instrument_id AS "instrumentId", e.model, e.status,
        e.entry_price AS "entryPrice", e.entry_time AS "entryTime", e.stop_price AS "stopPrice",
        e.target_price AS "targetPrice", e.shares, e.initial_risk AS "initialRisk",
        e.entry_market_snapshot AS "entryMarketSnapshot", e.entry_size_coverage AS "entrySizeCoverage",
        e.last_fact_timestamp AS "lastFactTimestamp", e.execution_state AS "executionState"
       FROM paper_execution e JOIN paper_signal_observation o ON o.id = e.observation_id
       WHERE o.run_id=$1 AND e.status IN ('OPEN','CLOSE_PENDING')
         AND e.close_abandoned_at IS NULL`,
      [runId],
    );
    return result.rows.map((row) => ({
      executionState: row.executionState,
      observationId: row.observationId,
      instrumentId: row.instrumentId,
      model: row.model,
      status: row.status,
      position: {
        entryPrice: Number(row.entryPrice),
        entryTime: toIso(row.entryTime),
        stop: Number(row.stopPrice),
        target: Number(row.targetPrice),
        shares: row.shares,
        initialRisk: Number(row.initialRisk),
      },
      entryMarketSnapshot: row.entryMarketSnapshot,
      entrySizeCoverage:
        row.entrySizeCoverage === null ? null : Number(row.entrySizeCoverage),
      lastFactTimestamp: toIso(row.lastFactTimestamp),
    }));
  }

  async findQuoteSnapshotForObservation(
    observationId: string,
  ): Promise<QuoteFact | null> {
    const result = await this.pool.query<{ entry_market_snapshot: unknown }>(
      `SELECT entry_market_snapshot FROM paper_execution WHERE observation_id = $1 AND model = 'QUOTE'`,
      [observationId],
    );
    const snap = result.rows[0]?.entry_market_snapshot as Record<
      string,
      unknown
    > | null;
    if (!snap || typeof snap !== "object") return null;
    if (
      typeof snap.bid !== "number" ||
      typeof snap.ask !== "number" ||
      typeof snap.quoteTimestamp !== "string" ||
      !Number.isFinite(Date.parse(snap.quoteTimestamp)) ||
      typeof snap.bidSize !== "number" ||
      typeof snap.askSize !== "number" ||
      !["REALTIME", "DELAYED", "HALTED"].includes(String(snap.dataStatus))
    )
      return null;
    return {
      timestamp: snap.quoteTimestamp,
      bid: snap.bid,
      ask: snap.ask,
      bidSize: snap.bidSize,
      askSize: snap.askSize,
      dataStatus: (snap.dataStatus as QuoteFact["dataStatus"]) ?? "REALTIME",
      actionable: snap.dataStatus === "REALTIME",
    };
  }
}
