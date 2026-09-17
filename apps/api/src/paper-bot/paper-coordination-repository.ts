import type { Pool, PoolClient } from "pg";
import type { MarketId } from "@tsx-scanner/contracts";
import type { QuoteExecutionState } from "./execution-core.js";
import type {
  ContextSnapshot,
  CoordinationDecision,
  CoordinationState,
} from "./coordination-policy.js";

export interface RecordCoordinationDecisionInput {
  readonly runId: string;
  readonly symbol: string;
  readonly decisionTimestamp: string;
  readonly triggerObservationIds: readonly string[];
  readonly decision: CoordinationDecision;
  readonly state: CoordinationState;
  readonly initialPosition?: {
    readonly observationId: string;
    readonly state: QuoteExecutionState;
  } | null;
}

export interface ApprovedDecisionWithoutPosition {
  readonly id: string;
  readonly runId: string;
  readonly symbol: string;
  readonly decisionTimestamp: string;
  readonly selectedObservationId: string;
  readonly stateSnapshot: CoordinationState;
}

/** Persisted separately from executions because this is an auditable shadow projection. */
export interface CoordinationDecisionRecord {
  readonly id: string;
  readonly created: boolean;
}
export interface OpenCoordinationPosition {
  readonly id: string;
  readonly observationId: string;
  readonly instrumentId: string;
  /** The selected strategy, for per-strategy time and stall controls. */
  readonly strategyKey: string;
  readonly state: QuoteExecutionState;
}
export interface CoordinationRecoveryProvenance {
  readonly source: "LIVE_QUOTE" | "PERSISTED_QUOTE";
  readonly boundary: string;
  readonly factTimestamp: string;
  readonly delayMs: number;
}
export interface CoordinationPortfolioHealth {
  readonly unresolvedPositions: number;
  readonly completedRunsWithUnresolvedPositions: number;
  readonly oldestUnresolvedAgeMs: number | null;
  readonly unknownQuoteSizeUnits: number;
}
export interface PaperCoordinationStore {
  recordDecision(
    input: RecordCoordinationDecisionInput,
  ): Promise<CoordinationDecisionRecord>;
  findApprovedDecisionsWithoutPositions?(
    runId: string,
  ): Promise<ApprovedDecisionWithoutPosition[]>;
  /** Patch observational model facts after the v3 position has been opened. */
  updateDecisionModelFacts?(
    decisionId: string,
    decision: CoordinationDecision,
  ): Promise<void>;
  insertInitialQuotePosition(
    decisionId: string,
    observationId: string,
    state: QuoteExecutionState,
  ): Promise<void>;
  findOpenPositions(runId: string): Promise<OpenCoordinationPosition[]>;
  updateQuotePosition(
    id: string,
    state: QuoteExecutionState,
    recovery?: CoordinationRecoveryProvenance,
  ): Promise<void>;
  /**
   * Everything the coordinator needs to know about the portfolio and this
   * symbol at `before`: open exposure, the cooldown clock, and the market and
   * sector context readings the decision must be judged against.
   */
  stateForSymbol(
    _runId: string,
    symbol: string,
    before: string,
    instrumentId?: string,
  ): Promise<CoordinationState>;
  portfolioHealth?(marketId?: MarketId): Promise<CoordinationPortfolioHealth>;
}

function exitColumns(
  state: QuoteExecutionState,
): [string | null, string | null] {
  return state.status === "CLOSED"
    ? [state.exit.exitReason, state.exit.exitTime]
    : [null, null];
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export class PostgresPaperCoordinationStore implements PaperCoordinationStore {
  constructor(private readonly pool: Pool) {}

  async recordDecision(
    input: RecordCoordinationDecisionInput,
  ): Promise<CoordinationDecisionRecord> {
    const runner =
      typeof this.pool.connect === "function"
        ? await this.pool.connect()
        : this.pool;
    const isClient = runner !== this.pool;
    try {
      if (isClient) await (runner as PoolClient).query("BEGIN");
      const inserted = await runner.query<{ id: string }>(
        `INSERT INTO paper_coordination_decision (
          portfolio_id,market_id,run_id,symbol,decision_timestamp,trigger_observation_ids,candidate_snapshot,
          selected_observation_id,selected_strategy_key,confirmation_observation_ids,
          outcome,reason,policy_version,state_snapshot,context_snapshot,shadow_decision
        ) VALUES ((SELECT id FROM paper_portfolio WHERE market_id=(SELECT market_id FROM paper_bot_run WHERE id=$1) AND mode='SHADOW'),(SELECT market_id FROM paper_bot_run WHERE id=$1),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (run_id,symbol,decision_timestamp) DO NOTHING RETURNING id`,
        [
          input.runId,
          input.symbol,
          input.decisionTimestamp,
          JSON.stringify(input.triggerObservationIds),
          JSON.stringify(input.decision.rankedCandidates),
          input.decision.selectedObservationId,
          input.decision.selectedStrategyKey,
          JSON.stringify(input.decision.confirmationObservationIds),
          input.decision.outcome,
          input.decision.reason,
          input.decision.policyVersion,
          JSON.stringify(input.state),
          JSON.stringify(input.decision.contexts),
          input.decision.shadowDecision
            ? JSON.stringify(input.decision.shadowDecision)
            : null,
        ],
      );
      let decisionId = inserted.rows[0]?.id;
      let created = true;
      if (!decisionId) {
        created = false;
        const existing = await runner.query<{ id: string }>(
          `SELECT id FROM paper_coordination_decision WHERE run_id=$1 AND symbol=$2 AND decision_timestamp=$3`,
          [input.runId, input.symbol, input.decisionTimestamp],
        );
        if (!existing.rows[0])
          throw new Error(
            "coordination decision conflict without existing row",
          );
        decisionId = existing.rows[0].id;
      }
      if (input.initialPosition && decisionId) {
        const [reason, time] = exitColumns(input.initialPosition.state);
        await runner.query(
          `INSERT INTO paper_coordination_position (decision_id,observation_id,portfolio_id,market_id,symbol,session_date,status,state,exit_reason,exit_time)
           SELECT $1,$2,d.portfolio_id,d.market_id,d.symbol,r.session_date,$3,$4,$5,$6
           FROM paper_coordination_decision d JOIN paper_bot_run r ON r.id=d.run_id WHERE d.id=$1
           ON CONFLICT (decision_id) DO NOTHING`,
          [
            decisionId,
            input.initialPosition.observationId,
            input.initialPosition.state.status,
            JSON.stringify(input.initialPosition.state),
            reason,
            time,
          ],
        );
      }
      if (isClient) await (runner as PoolClient).query("COMMIT");
      return { id: decisionId, created };
    } catch (err) {
      if (isClient) await (runner as PoolClient).query("ROLLBACK");
      throw err;
    } finally {
      if (isClient) (runner as PoolClient).release();
    }
  }

  async findApprovedDecisionsWithoutPositions(
    runId: string,
  ): Promise<ApprovedDecisionWithoutPosition[]> {
    const result = await this.pool.query<{
      id: string;
      runId: string;
      symbol: string;
      decisionTimestamp: Date | string;
      selectedObservationId: string;
      stateSnapshot: unknown;
    }>(
      `SELECT d.id, d.run_id AS "runId", d.symbol, d.decision_timestamp AS "decisionTimestamp",
              d.selected_observation_id AS "selectedObservationId", d.state_snapshot AS "stateSnapshot"
       FROM paper_coordination_decision d
       LEFT JOIN paper_coordination_position p ON p.decision_id = d.id
       WHERE d.run_id = $1
         AND d.outcome = 'APPROVED'
         AND d.selected_observation_id IS NOT NULL
         AND p.id IS NULL
       ORDER BY d.decision_timestamp, d.symbol, d.id`,
      [runId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      symbol: row.symbol,
      decisionTimestamp: toIso(row.decisionTimestamp),
      selectedObservationId: row.selectedObservationId,
      stateSnapshot:
        typeof row.stateSnapshot === "string"
          ? JSON.parse(row.stateSnapshot)
          : (row.stateSnapshot as CoordinationState),
    }));
  }
  async updateDecisionModelFacts(
    decisionId: string,
    decision: CoordinationDecision,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE paper_coordination_decision
          SET candidate_snapshot=$2::jsonb, shadow_decision=$3::jsonb
        WHERE id=$1`,
      [
        decisionId,
        JSON.stringify(decision.rankedCandidates),
        JSON.stringify(decision.shadowDecision),
      ],
    );
  }
  async insertInitialQuotePosition(
    decisionId: string,
    observationId: string,
    state: QuoteExecutionState,
  ): Promise<void> {
    const [reason, time] = exitColumns(state);
    await this.pool.query(
      `INSERT INTO paper_coordination_position (decision_id,observation_id,portfolio_id,market_id,symbol,session_date,status,state,exit_reason,exit_time)
       SELECT $1,$2,d.portfolio_id,d.market_id,d.symbol,r.session_date,$3,$4,$5,$6
       FROM paper_coordination_decision d JOIN paper_bot_run r ON r.id=d.run_id WHERE d.id=$1
       ON CONFLICT (decision_id) DO NOTHING`,
      [
        decisionId,
        observationId,
        state.status,
        JSON.stringify(state),
        reason,
        time,
      ],
    );
  }
  async findOpenPositions(runId: string): Promise<OpenCoordinationPosition[]> {
    const result = await this.pool.query<OpenCoordinationPosition>(
      `SELECT p.id,p.observation_id AS "observationId",o.instrument_id AS "instrumentId",
        o.strategy_key AS "strategyKey",p.state FROM paper_coordination_position p JOIN paper_coordination_decision d ON d.id=p.decision_id JOIN paper_signal_observation o ON o.id=p.observation_id WHERE d.run_id=$1 AND p.status IN ('OPEN','CLOSE_PENDING')`,
      [runId],
    );
    return result.rows;
  }
  async updateQuotePosition(
    id: string,
    state: QuoteExecutionState,
    recovery?: CoordinationRecoveryProvenance,
  ): Promise<void> {
    const [reason, time] = exitColumns(state);
    await this.pool.query(
      `UPDATE paper_coordination_position SET status=$2,state=$3,exit_reason=$4,exit_time=$5,
         recovery_source=COALESCE($6,recovery_source),
         recovery_boundary=COALESCE($7::timestamptz,recovery_boundary),
         recovery_fact_timestamp=COALESCE($8::timestamptz,recovery_fact_timestamp),
         recovery_delay_ms=COALESCE($9,recovery_delay_ms)
       WHERE id=$1`,
      [
        id,
        state.status,
        JSON.stringify(state),
        reason,
        time,
        recovery?.source ?? null,
        recovery?.boundary ?? null,
        recovery?.factTimestamp ?? null,
        recovery?.delayMs ?? null,
      ],
    );
  }
  async stateForSymbol(
    _runId: string,
    symbol: string,
    before: string,
    instrumentId?: string,
  ): Promise<CoordinationState> {
    const result = await this.pool.query<{
      open: boolean;
      lastStopAt: string | null;
      openSymbolNotional: string;
      openPositionCount: string;
      pendingCloseCount: string;
      totalOpenRisk: string;
      openPortfolioNotional: string;
      dailyRealizedLoss: string;
      dailyNetRealizedPnl: string;
      portfolioReconciliationRequired: boolean;
    }>(
      `WITH symbol_state AS (
         SELECT EXISTS(
           SELECT 1 FROM paper_coordination_position p
           JOIN paper_coordination_decision d ON d.id=p.decision_id
           WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=(SELECT market_id FROM paper_bot_run WHERE id=$3) AND mode='SHADOW')
             AND p.symbol=$1
             AND ((p.state->'position'->>'entryTime')::timestamptz <= $2 AND (p.status IN ('OPEN','CLOSE_PENDING') OR (p.status='CLOSED' AND p.exit_time > $2)))
         ) AS open,
         max(p.exit_time) FILTER (WHERE p.exit_reason='STOP' AND p.exit_time <= $2) AS "lastStopAt",
         coalesce(sum(
           (p.state->'position'->>'entryPrice')::numeric * (p.state->'position'->>'shares')::numeric
         ) FILTER (WHERE (p.state->'position'->>'entryTime')::timestamptz <= $2 AND (p.status IN ('OPEN','CLOSE_PENDING') OR (p.status='CLOSED' AND p.exit_time > $2))),0) AS "openSymbolNotional"
         FROM paper_coordination_position p
         JOIN paper_coordination_decision d ON d.id=p.decision_id
         WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=(SELECT market_id FROM paper_bot_run WHERE id=$3) AND mode='SHADOW')
           AND p.symbol=$1
       ), portfolio_state AS (
         SELECT count(*) FILTER (WHERE (p.state->'position'->>'entryTime')::timestamptz <= $2 AND (p.status IN ('OPEN','CLOSE_PENDING') OR (p.status='CLOSED' AND p.exit_time > $2))) AS "openPositionCount",
         count(*) FILTER (WHERE (p.state->'position'->>'entryTime')::timestamptz <= $2 AND p.status='CLOSE_PENDING') AS "pendingCloseCount",
         coalesce(sum((p.state->'position'->>'initialRisk')::numeric) FILTER (WHERE (p.state->'position'->>'entryTime')::timestamptz <= $2 AND (p.status IN ('OPEN','CLOSE_PENDING') OR (p.status='CLOSED' AND p.exit_time > $2))),0) AS "totalOpenRisk",
         coalesce(sum(
           (p.state->'position'->>'entryPrice')::numeric * (p.state->'position'->>'shares')::numeric
         ) FILTER (WHERE (p.state->'position'->>'entryTime')::timestamptz <= $2 AND (p.status IN ('OPEN','CLOSE_PENDING') OR (p.status='CLOSED' AND p.exit_time > $2))),0) AS "openPortfolioNotional",
         coalesce(sum(greatest(0, -coalesce((p.state->'exit'->'financials'->>'netPnl')::numeric, 0))) FILTER (
           WHERE p.status='CLOSED'
             AND p.exit_time <= $2
             AND (p.exit_time AT TIME ZONE r.session_timezone)::date = ($2::timestamptz AT TIME ZONE r.session_timezone)::date
         ),0) AS "dailyRealizedLoss",
         coalesce(sum(coalesce((p.state->'exit'->'financials'->>'netPnl')::numeric, 0)) FILTER (
           WHERE p.status='CLOSED'
             AND p.exit_time <= $2
             AND (p.exit_time AT TIME ZONE r.session_timezone)::date = ($2::timestamptz AT TIME ZONE r.session_timezone)::date
         ),0) AS "dailyNetRealizedPnl"
         FROM paper_coordination_position p
         JOIN paper_coordination_decision d ON d.id=p.decision_id
         JOIN paper_bot_run r ON r.id=d.run_id
         WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=(SELECT market_id FROM paper_bot_run WHERE id=$3) AND mode='SHADOW')
       )
       SELECT *,EXISTS(
         SELECT 1 FROM paper_coordination_position p
         JOIN paper_coordination_decision d ON d.id=p.decision_id
         WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=(SELECT market_id FROM paper_bot_run WHERE id=$3) AND mode='SHADOW')
           AND d.run_id<>$3
           AND ((p.state->'position'->>'entryTime')::timestamptz <= $2 AND (p.status IN ('OPEN','CLOSE_PENDING') OR (p.status='CLOSED' AND p.exit_time > $2)))
       ) AS "portfolioReconciliationRequired"
       FROM symbol_state CROSS JOIN portfolio_state`,
      [symbol, before, _runId],
    );
    const exits = await this.pool.query<{ exitReason: string }>(
      `SELECT p.exit_reason AS "exitReason" FROM paper_coordination_position p
       JOIN paper_coordination_decision d ON d.id=p.decision_id
       WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=(SELECT market_id FROM paper_bot_run WHERE id=$2) AND mode='SHADOW')
         AND p.status='CLOSED' AND p.exit_time <= $1
       ORDER BY p.exit_time DESC, p.id DESC`,
      [before, _runId],
    );
    let consecutiveStops = 0;
    for (const exit of exits.rows) {
      if (exit.exitReason !== "STOP") break;
      consecutiveStops += 1;
    }
    const row = result.rows[0];
    const { sector, openSectorNotional } = await this.sectorExposure(
      _runId,
      instrumentId,
      before,
    );
    return {
      hasOpenSymbolPosition: row?.open ?? false,
      lastStopAt: row?.lastStopAt ?? null,
      openPositionCount: Number(row?.openPositionCount ?? 0),
      pendingCloseCount: Number(row?.pendingCloseCount ?? 0),
      totalOpenRisk: Number(row?.totalOpenRisk ?? 0),
      openPortfolioNotional: Number(row?.openPortfolioNotional ?? 0),
      dailyCumulativeLoss: Number(row?.dailyRealizedLoss ?? 0),
      dailyNetRealizedPnl: Number(row?.dailyNetRealizedPnl ?? 0),
      dailyRealizedLoss: Number(row?.dailyRealizedLoss ?? 0),
      consecutiveStops,
      portfolioReconciliationRequired:
        row?.portfolioReconciliationRequired ?? false,
      sector,
      openSymbolNotional: Number(row?.openSymbolNotional ?? 0),
      openSectorNotional,
      contexts: await this.contextsFor(instrumentId, before),
    };
  }

  async portfolioHealth(
    marketId: MarketId = "CA_TSX",
  ): Promise<CoordinationPortfolioHealth> {
    const result = await this.pool.query<{
      unresolvedPositions: number | string;
      completedRunsWithUnresolvedPositions: number | string;
      oldestUnresolvedAgeMs: number | string | null;
      unknownQuoteSizeUnits: number | string;
    }>(
      `SELECT count(*)::int AS "unresolvedPositions",
        count(DISTINCT d.run_id) FILTER (WHERE r.status='COMPLETED')::int
          AS "completedRunsWithUnresolvedPositions",
        CASE WHEN count(*)=0 THEN NULL ELSE greatest(0,extract(epoch FROM
          (now()-min(coalesce((p.state->>'lastFactTimestamp')::timestamptz,
            (p.state->'position'->>'entryTime')::timestamptz,p.created_at))))*1000)::bigint END
          AS "oldestUnresolvedAgeMs",
        (SELECT count(*)::int FROM instrument i
          CROSS JOIN LATERAL (
            SELECT q.size_unit FROM quote_snapshot q
            WHERE q.instrument_id=i.id
            ORDER BY q.timestamp DESC LIMIT 1
          ) latest
          WHERE i.market_id=$1 AND latest.size_unit='UNKNOWN') AS "unknownQuoteSizeUnits"
       FROM paper_coordination_position p
       JOIN paper_coordination_decision d ON d.id=p.decision_id
       JOIN paper_bot_run r ON r.id=d.run_id
       WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=$1 AND mode='SHADOW')
         AND p.status IN ('OPEN','CLOSE_PENDING')`,
      [marketId],
    );
    const row = result.rows[0];
    return {
      unresolvedPositions: Number(row?.unresolvedPositions ?? 0),
      completedRunsWithUnresolvedPositions: Number(
        row?.completedRunsWithUnresolvedPositions ?? 0,
      ),
      oldestUnresolvedAgeMs:
        row?.oldestUnresolvedAgeMs === null ||
        row?.oldestUnresolvedAgeMs === undefined
          ? null
          : Number(row.oldestUnresolvedAgeMs),
      unknownQuoteSizeUnits: Number(row?.unknownQuoteSizeUnits ?? 0),
    };
  }

  /**
   * Open coordinated notional in the candidate's own sector. A symbol with no
   * classified sector is its own concentration unit: it is never folded into
   * an "unknown" bucket that would let unrelated names limit each other.
   */
  private async sectorExposure(
    _runId: string,
    instrumentId?: string,
    before?: string,
  ): Promise<{ sector: string | null; openSectorNotional: number }> {
    if (instrumentId === undefined)
      return { sector: null, openSectorNotional: 0 };
    const result = await this.pool.query<{
      sector: string | null;
      openSectorNotional: string;
    }>(
      `WITH candidate AS (SELECT industry_sector FROM instrument WHERE id=$1)
       SELECT (SELECT industry_sector FROM candidate) AS sector,
         coalesce(sum(
           (p.state->'position'->>'entryPrice')::numeric * (p.state->'position'->>'shares')::numeric
         ) FILTER (WHERE $3::timestamptz IS NULL AND p.status IN ('OPEN','CLOSE_PENDING') OR ($3::timestamptz IS NOT NULL AND (p.state->'position'->>'entryTime')::timestamptz <= $3 AND (p.status IN ('OPEN','CLOSE_PENDING') OR (p.status='CLOSED' AND p.exit_time > $3)))),0) AS "openSectorNotional"
       FROM paper_coordination_position p
       JOIN paper_coordination_decision d ON d.id=p.decision_id
       JOIN paper_signal_observation o ON o.id=p.observation_id
       JOIN instrument i ON i.id=o.instrument_id
       WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=(SELECT market_id FROM paper_bot_run WHERE id=$2) AND mode='SHADOW')
         AND i.industry_sector IS NOT NULL
         AND i.industry_sector=(SELECT industry_sector FROM candidate)`,
      [instrumentId, _runId, before ?? null],
    );
    const row = result.rows[0];
    return {
      sector: row?.sector ?? null,
      openSectorNotional: Number(row?.openSectorNotional ?? 0),
    };
  }

  /**
   * The latest reading per context signal at or before the decision. Readings
   * are returned as recorded, including STALE and UNAVAILABLE ones: the policy
   * decides what they mean, and the decision record must show what it saw.
   */
  private async contextsFor(
    instrumentId: string | undefined,
    before: string,
  ): Promise<ContextSnapshot[]> {
    if (instrumentId === undefined) return [];
    const result = await this.pool.query<{
      signalKey: string;
      status: ContextSnapshot["status"];
      score: number | string;
      timestamp: Date | string;
    }>(
      `SELECT DISTINCT ON (signal_key)
         signal_key AS "signalKey",status,context_score AS score,timestamp
       FROM context_evaluation
       WHERE instrument_id=$1 AND timestamp <= $2
       ORDER BY signal_key,timestamp DESC`,
      [instrumentId, before],
    );
    return result.rows.map((row) => ({
      signalKey: row.signalKey,
      status: row.status,
      score: Number(row.score),
      timestamp:
        row.timestamp instanceof Date
          ? row.timestamp.toISOString()
          : new Date(row.timestamp).toISOString(),
    }));
  }
}
