import {
  paperBotActivitySchema,
  paperBotRunSchema,
  paperCohortCurvePointSchema,
  paperCohortAggregateSchema,
  paperCommissionSensitivitySchema,
  paperCoordinationDecisionSchema,
  paperCoordinationSummarySchema,
  paperModelDivergenceSchema,
  paperProfileQualificationSchema,
  paperPerformanceCurveSchema,
  paperExecutionSchema,
  paperSignalObservationSchema,
  paperTradeJournalSchema,
  type PaperBotActivity,
  type PaperBotRun,
  type PaperCohortCurvePoint,
  type PaperCohortAggregate,
  type PaperCommissionSensitivity,
  type PaperCoordinationDecision,
  type PaperCoordinationSummary,
  type PaperEvidenceFilters,
  type PaperExecution,
  type PaperJournalProjection,
  type PaperModelDivergence,
  type PaperPerformanceCurve,
  type PaperPerformanceGranularity,
  type PaperProfileQualification,
  type PaperSignalObservation,
  type PaperTradeJournal,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";

type Json = Record<string, unknown>;
const COHORT_PROVENANCE = `'marketId',r.market_id,
  'currency',coalesce(r.assumptions->'costs'->>'currency','UNKNOWN'),
  'signalSemanticsVersion',coalesce(o.source_event_payload->>'signalSemanticsVersion','UNKNOWN'),
  'replayScope',coalesce(r.assumptions->>'evidenceScope','UNKNOWN')`;

const numeric = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const count = (value: unknown): number => Number(value ?? 0);
const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const filterValues = (filters: PaperEvidenceFilters) => [
  filters.profileId ?? null,
  filters.profileConfigId ?? null,
  filters.executionModelVersion ?? null,
  filters.source ?? null,
  filters.startDate ?? null,
  filters.endDate ?? null,
  filters.model ?? null,
  filters.status ?? null,
  filters.noFillReason ?? null,
  filters.exitReason ?? null,
  filters.economicsReason ?? null,
  filters.marketId ?? "CA_TSX",
];

const FROM_FILTERS = `
  FROM paper_signal_observation o
  JOIN paper_bot_run r ON r.id=o.run_id
  WHERE ($1::uuid IS NULL OR o.profile_id=$1)
    AND ($2::uuid IS NULL OR o.profile_config_id=$2)
    AND ($3::text IS NULL OR r.execution_model_version=$3)
    AND ($4::text IS NULL OR r.source=$4)
    AND ($5::date IS NULL OR o.signal_timestamp >= $5::date)
    AND ($6::date IS NULL OR o.signal_timestamp < ($6::date + INTERVAL '1 day'))
    AND r.market_id=$12`;

const EXECUTION_FROM_FILTERS = `
  FROM paper_signal_observation o
  JOIN paper_bot_run r ON r.id=o.run_id
  JOIN paper_execution e ON e.observation_id=o.id
  WHERE ($1::uuid IS NULL OR o.profile_id=$1)
    AND ($2::uuid IS NULL OR o.profile_config_id=$2)
    AND ($3::text IS NULL OR r.execution_model_version=$3)
    AND ($4::text IS NULL OR r.source=$4)
    AND ($5::date IS NULL OR o.signal_timestamp >= $5::date)
    AND ($6::date IS NULL OR o.signal_timestamp < ($6::date + INTERVAL '1 day'))
    AND ($7::text IS NULL OR e.model=$7)
    AND ($8::text IS NULL OR e.status=$8)
    AND ($9::text IS NULL OR e.no_fill_reason=$9)
    AND ($10::text IS NULL OR e.exit_reason=$10)
    AND ($11::text IS NULL OR e.economics_reason=$11)
    AND r.market_id=$12`;

/**
 * Coordination queries take their own parameter list: a coordinated decision
 * spans every profile that observed the symbol, so the cohort-level filters
 * used elsewhere have no meaning here.
 */
const coordinationFilterValues = (filters: PaperEvidenceFilters) => [
  filters.executionModelVersion ?? null,
  filters.source ?? null,
  filters.startDate ?? null,
  filters.endDate ?? null,
  filters.marketId ?? "CA_TSX",
];

const COORDINATION_FROM_FILTERS = `
  FROM paper_coordination_decision d
  JOIN paper_bot_run r ON r.id=d.run_id
  LEFT JOIN paper_coordination_position p ON p.decision_id=d.id
  WHERE ($1::text IS NULL OR r.execution_model_version=$1)
    AND ($2::text IS NULL OR r.source=$2)
    AND ($3::date IS NULL OR d.decision_timestamp >= $3::date)
    AND ($4::date IS NULL OR d.decision_timestamp < ($4::date + INTERVAL '1 day'))
    AND r.market_id=$5`;

/**
 * The two profit-and-loss ledgers behind `/api/paper-bot/journal`. They are
 * kept as bare SELECTs so the entry list and its totals can wrap the same
 * rows in a CTE: a total that came from a different predicate than the rows
 * it sits under would be a quietly wrong number.
 *
 * The coordinated ledger takes the run-level coordination parameters
 * ($1..$5, including market identity); the independent one takes the full
 * cohort filter list ($1..$12).
 */
const COORDINATED_LEDGER = `
  SELECT p.id,d.run_id AS "runId",r.session_date AS "sessionDate",o.symbol,
    o.strategy_key AS "strategyKey",o.profile_name AS "profileName",
    o.config_version AS "configVersion",p.status,
    (p.state->'position'->>'entryPrice')::numeric AS "entryPrice",
    (p.state->'position'->>'entryTime')::timestamptz AS "entryTime",
    (p.state->'position'->>'stop')::numeric AS "stopPrice",
    (p.state->'position'->>'target')::numeric AS "targetPrice",
    (p.state->'position'->>'shares')::bigint AS shares,
    (p.state->'position'->>'initialRisk')::numeric AS "initialRisk",
    (p.state->'sizing'->>'requestedRisk')::numeric AS "requestedRisk",
    p.state->'sizing'->'appliedCaps' AS "bindingCaps",
    (p.state->'exit'->'financials'->>'exitPrice')::numeric AS "exitPrice",
    p.exit_time AS "exitTime",p.exit_reason AS "exitReason",
    (p.state->'exit'->'financials'->>'grossPnl')::numeric AS "grossPnl",
    (p.state->'exit'->'financials'->>'netPnl')::numeric AS "netPnl",
    (p.state->'exit'->'financials'->>'rMultiple')::numeric AS "rMultiple",
    (p.state->>'lastFactTimestamp')::timestamptz AS "lastFactTimestamp",
    p.recovery_source AS "recoverySource",
    p.recovery_boundary AS "recoveryBoundary",
    p.recovery_fact_timestamp AS "recoveryFactTimestamp",
    p.recovery_delay_ms AS "recoveryDelayMs"
  FROM paper_coordination_position p
  JOIN paper_coordination_decision d ON d.id=p.decision_id
  JOIN paper_bot_run r ON r.id=d.run_id
  JOIN paper_signal_observation o ON o.id=p.observation_id
  WHERE p.status IN ('OPEN','CLOSE_PENDING','CLOSED')
    AND ($1::text IS NULL OR r.execution_model_version=$1)
    AND ($2::text IS NULL OR r.source=$2)
    AND ($3::date IS NULL OR d.decision_timestamp >= $3::date)
    AND ($4::date IS NULL OR d.decision_timestamp < ($4::date + INTERVAL '1 day'))
    AND r.market_id=$5`;

const INDEPENDENT_LEDGER = `
  SELECT e.id,o.run_id AS "runId",r.session_date AS "sessionDate",o.symbol,
    o.strategy_key AS "strategyKey",o.profile_name AS "profileName",
    o.config_version AS "configVersion",e.status,
    e.entry_price AS "entryPrice",e.entry_time AS "entryTime",
    e.stop_price AS "stopPrice",e.target_price AS "targetPrice",e.shares,
    e.initial_risk AS "initialRisk",e.exit_price AS "exitPrice",
    e.exit_time AS "exitTime",e.exit_reason AS "exitReason",
    (e.sizing->>'requestedRisk')::numeric AS "requestedRisk",
    e.sizing->'appliedCaps' AS "bindingCaps",
    e.gross_pnl AS "grossPnl",e.net_pnl AS "netPnl",e.r_multiple AS "rMultiple",
    e.last_fact_timestamp AS "lastFactTimestamp",
    NULL::text AS "recoverySource",NULL::timestamptz AS "recoveryBoundary",
    NULL::timestamptz AS "recoveryFactTimestamp",NULL::bigint AS "recoveryDelayMs"
  ${EXECUTION_FROM_FILTERS}
    AND e.status IN ('OPEN','CLOSE_PENDING','CLOSED')`;

/**
 * Totals over whichever ledger is wrapped as `ledger`. Won and lost net are
 * summed separately so the profit factor never has to be re-derived from a
 * rounded total, and the largest win and loss are taken from the winners and
 * losers respectively -- the best of five losses is not a win.
 */
const JOURNAL_TOTALS = `
  SELECT count(*) FILTER (WHERE status='CLOSED')::int AS closed_trades,
    count(*) FILTER (WHERE status IN ('OPEN','CLOSE_PENDING'))::int AS open_positions,
    count(*) FILTER (WHERE status='CLOSED' AND round("netPnl",2)>0)::int AS wins,
    count(*) FILTER (WHERE status='CLOSED' AND round("netPnl",2)<0)::int AS losses,
    count(*) FILTER (WHERE status='CLOSED' AND round("netPnl",2)=0)::int AS scratches,
    coalesce(sum("grossPnl") FILTER (WHERE status='CLOSED'),0) AS gross_pnl,
    coalesce(sum("grossPnl"-"netPnl") FILTER (WHERE status='CLOSED'),0) AS costs,
    coalesce(sum("netPnl") FILTER (WHERE status='CLOSED'),0) AS net_pnl,
    coalesce(sum("netPnl") FILTER (WHERE status='CLOSED' AND round("netPnl",2)>0),0) AS won_net_pnl,
    coalesce(-sum("netPnl") FILTER (WHERE status='CLOSED' AND round("netPnl",2)<0),0) AS lost_net_pnl,
    coalesce(sum("rMultiple") FILTER (WHERE status='CLOSED'),0) AS cumulative_r,
    avg("rMultiple") FILTER (WHERE status='CLOSED') AS average_r,
    max("netPnl") FILTER (WHERE status='CLOSED' AND round("netPnl",2)>0) AS largest_win,
    min("netPnl") FILTER (WHERE status='CLOSED' AND round("netPnl",2)<0) AS largest_loss
  FROM ledger`;

/**
 * The coordinated account's realized-P&L curve. Both variants read the same
 * closed-position rows, bounded by the session that realized the P&L rather
 * than the decision timestamp: a performance point belongs to the session
 * that produced it. TRADE keeps one point per position; DAY aggregates a
 * session with the same windowed running total. Aggregation stays in
 * PostgreSQL so a long range never depends on the 500-row journal page.
 */
const PERFORMANCE_TRADE_CURVE = `
  SELECT r.session_date AS "sessionDate",
    p.exit_time AS "closedAt",
    (p.state->'exit'->'financials'->>'netPnl')::numeric AS "netPnl",
    1 AS trades,
    sum((p.state->'exit'->'financials'->>'netPnl')::numeric)
      OVER (ORDER BY p.exit_time,p.id ROWS UNBOUNDED PRECEDING) AS "cumulativeNetPnl"
  FROM paper_coordination_position p
  JOIN paper_coordination_decision d ON d.id=p.decision_id
  JOIN paper_bot_run r ON r.id=d.run_id
  WHERE p.status='CLOSED' AND p.exit_time IS NOT NULL
    AND ($1::text IS NULL OR r.source=$1)
    AND ($2::date IS NULL OR r.session_date >= $2::date)
    AND ($3::date IS NULL OR r.session_date <= $3::date)
    AND r.market_id=$4
  ORDER BY p.exit_time,p.id`;

const PERFORMANCE_DAY_CURVE = `
  WITH closed AS (
    SELECT r.session_date AS "sessionDate",
      max(p.exit_time) AS "closedAt",
      sum((p.state->'exit'->'financials'->>'netPnl')::numeric) AS "netPnl",
      count(*)::int AS trades
    FROM paper_coordination_position p
    JOIN paper_coordination_decision d ON d.id=p.decision_id
    JOIN paper_bot_run r ON r.id=d.run_id
    WHERE p.status='CLOSED' AND p.exit_time IS NOT NULL
      AND ($1::text IS NULL OR r.source=$1)
      AND ($2::date IS NULL OR r.session_date >= $2::date)
      AND ($3::date IS NULL OR r.session_date <= $3::date)
      AND r.market_id=$4
    GROUP BY r.session_date
  )
  SELECT "sessionDate","closedAt","netPnl",trades,
    sum("netPnl") OVER (ORDER BY "sessionDate" ROWS UNBOUNDED PRECEDING) AS "cumulativeNetPnl"
  FROM closed
  ORDER BY "sessionDate"`;

export interface PaperEvidenceStore {
  listActivities(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperBotActivity[]>;
  listRuns(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperBotRun[]>;
  listObservations(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperSignalObservation[]>;
  listExecutions(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperExecution[]>;
  aggregates(filters: PaperEvidenceFilters): Promise<PaperCohortAggregate[]>;
  commissionSensitivity(
    filters: PaperEvidenceFilters,
    roundTripCommissions: readonly number[],
  ): Promise<PaperCommissionSensitivity[]>;
  curves(filters: PaperEvidenceFilters): Promise<PaperCohortCurvePoint[]>;
  /**
   * The coordinated shadow projection. Only run-level filters apply: a
   * coordinated decision is made for a symbol across every profile that saw
   * it, so it has no single cohort to filter by.
   */
  coordinationDecisions(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperCoordinationDecision[]>;
  coordinationSummary(
    filters: PaperEvidenceFilters,
  ): Promise<PaperCoordinationSummary>;
  divergences(filters: PaperEvidenceFilters): Promise<PaperModelDivergence[]>;
  qualifications(
    filters: PaperEvidenceFilters,
  ): Promise<PaperProfileQualification[]>;
  historicalFor(
    aggregate: PaperCohortAggregate,
  ): Promise<HistoricalAggregate | HistoricalUnavailable>;
  journal(
    filters: PaperEvidenceFilters,
    projection: PaperJournalProjection,
    limit?: number,
  ): Promise<PaperTradeJournal>;
  /**
   * The coordinated account's realized-P&L curve. Only run-level filters
   * apply, and the bounds are required so a long range is always explicitly
   * scoped by its caller.
   */
  performanceCurve(
    filters: PaperEvidenceFilters,
    range: { startDate: string; endDate: string },
    granularity: PaperPerformanceGranularity,
  ): Promise<PaperPerformanceCurve>;
}

export interface HistoricalAggregate {
  backtestRunId: string;
  closedTrades: number;
  wins: number;
  averageR: number | null;
  cumulativeR: number;
  exitReasons: Record<string, number>;
}
export interface HistoricalUnavailable {
  reason: string;
}

export class PostgresPaperEvidenceStore implements PaperEvidenceStore {
  constructor(private readonly pool: Pool) {}

  async listActivities(
    filters: PaperEvidenceFilters,
    limit = 100,
  ): Promise<PaperBotActivity[]> {
    const result = await this.pool.query(
      `SELECT a.id,a.run_id AS "runId",a.occurred_at AS "occurredAt",
        a.event_type AS "eventType",a.severity,a.symbol,
        a.strategy_key AS "strategyKey",a.model,a.message,a.details
       FROM paper_bot_activity a
       JOIN paper_bot_run r ON r.id=a.run_id
       LEFT JOIN paper_signal_observation o ON o.id=a.observation_id
       LEFT JOIN paper_execution e ON e.id=a.execution_id
       WHERE ($1::uuid IS NULL OR o.profile_id=$1)
         AND ($2::uuid IS NULL OR o.profile_config_id=$2)
         AND ($3::text IS NULL OR r.execution_model_version=$3)
         AND ($4::text IS NULL OR r.source=$4)
         AND ($5::date IS NULL OR r.session_date >= $5::date)
         AND ($6::date IS NULL OR r.session_date <= $6::date)
         AND ($7::text IS NULL OR a.model=$7)
         AND ($8::text IS NULL OR a.details->>'status'=$8)
         AND ($9::text IS NULL OR a.details->>'noFillReason'=$9)
         AND ($10::text IS NULL OR a.details->>'exitReason'=$10)
         AND ($11::text IS NULL OR a.details->>'economicsReason'=$11)
         AND r.market_id=$12
       ORDER BY a.occurred_at DESC,a.id DESC LIMIT $13`,
      [...filterValues(filters), limit],
    );
    return result.rows.map((row) =>
      paperBotActivitySchema.parse({
        ...row,
        occurredAt: iso(row.occurredAt),
      }),
    );
  }

  async listRuns(
    filters: PaperEvidenceFilters,
    limit = 100,
  ): Promise<PaperBotRun[]> {
    const result = await this.pool.query(
      `SELECT id,source,session_date AS "sessionDate",session_timezone AS "sessionTimezone",
        scheduled_close_at AS "scheduledCloseAt",status,execution_model_version AS "executionModelVersion",
        assumptions,started_at AS "startedAt",completed_at AS "completedAt",failed_at AS "failedAt",failure_reason AS "failureReason"
       FROM paper_bot_run
       WHERE ($3::text IS NULL OR execution_model_version=$3)
         AND ($4::text IS NULL OR source=$4)
         AND ($5::date IS NULL OR session_date >= $5::date)
         AND ($6::date IS NULL OR session_date <= $6::date)
         AND market_id=$12
         AND (
           ($1::uuid IS NULL AND $2::uuid IS NULL AND $7::text IS NULL AND $8::text IS NULL AND $9::text IS NULL AND $10::text IS NULL AND $11::text IS NULL)
           OR EXISTS (
             SELECT 1 FROM paper_signal_observation o
             LEFT JOIN paper_execution e ON e.observation_id=o.id
             WHERE o.run_id=paper_bot_run.id
               AND ($1::uuid IS NULL OR o.profile_id=$1)
               AND ($2::uuid IS NULL OR o.profile_config_id=$2)
               AND ($7::text IS NULL OR e.model=$7)
               AND ($8::text IS NULL OR e.status=$8)
               AND ($9::text IS NULL OR e.no_fill_reason=$9)
               AND ($10::text IS NULL OR e.exit_reason=$10)
               AND ($11::text IS NULL OR e.economics_reason=$11)
           )
         )
       ORDER BY session_date DESC,started_at DESC LIMIT $13`,
      [...filterValues(filters), limit],
    );
    return result.rows.map((row) =>
      paperBotRunSchema.parse({
        ...row,
        sessionDate: iso(row.sessionDate)!.slice(0, 10),
        scheduledCloseAt: iso(row.scheduledCloseAt),
        startedAt: iso(row.startedAt),
        completedAt: iso(row.completedAt),
        failedAt: iso(row.failedAt),
      }),
    );
  }

  async listObservations(
    filters: PaperEvidenceFilters,
    limit = 200,
  ): Promise<PaperSignalObservation[]> {
    const result = await this.pool.query(
      `SELECT o.id,o.run_id AS "runId",o.source_event_id AS "sourceEventId",
        o.source_signal_id AS "sourceSignalId",o.setup_instance_id AS "setupInstanceId",
        o.instrument_id AS "instrumentId",o.symbol,o.profile_id AS "profileId",o.profile_name AS "profileName",
        o.profile_config_id AS "profileConfigId",o.config_version AS "configVersion",o.profile_parameters AS "profileParameters",
        o.strategy_key AS "strategyKey",o.strategy_version AS "strategyVersion",o.signal_timestamp AS "signalTimestamp",o.score,
        o.eligibility_status AS "eligibilityStatus",o.eligibility_reason AS "eligibilityReason",o.reason_codes AS "reasonCodes",o.created_at AS "createdAt"
        ${FROM_FILTERS}
        AND (
          ($7::text IS NULL AND $8::text IS NULL AND $9::text IS NULL AND $10::text IS NULL AND $11::text IS NULL)
          OR EXISTS (
            SELECT 1 FROM paper_execution e WHERE e.observation_id=o.id
              AND ($7::text IS NULL OR e.model=$7)
              AND ($8::text IS NULL OR e.status=$8)
              AND ($9::text IS NULL OR e.no_fill_reason=$9)
              AND ($10::text IS NULL OR e.exit_reason=$10)
              AND ($11::text IS NULL OR e.economics_reason=$11)
          )
        )
        ORDER BY o.signal_timestamp DESC,o.id DESC LIMIT $13`,
      [...filterValues(filters), limit],
    );
    return result.rows.map((row) =>
      paperSignalObservationSchema.parse({
        ...row,
        signalTimestamp: iso(row.signalTimestamp),
        createdAt: iso(row.createdAt),
      }),
    );
  }

  async listExecutions(
    filters: PaperEvidenceFilters,
    limit = 200,
  ): Promise<PaperExecution[]> {
    const result = await this.pool.query(
      `SELECT e.id,e.observation_id AS "observationId",o.run_id AS "runId",e.model,e.status,e.execution_state AS "executionState",
        e.entry_price AS "entryPrice",e.entry_time AS "entryTime",e.stop_price AS "stopPrice",e.target_price AS "targetPrice",e.shares,
        e.exit_price AS "exitPrice",e.exit_time AS "exitTime",e.exit_reason AS "exitReason",e.fee,e.gross_pnl AS "grossPnl",
        e.net_pnl AS "netPnl",e.r_multiple AS "rMultiple",e.no_fill_reason AS "noFillReason",
        e.economics_reason AS "economicsReason",e.economics,e.sizing,
        e.entry_size_coverage AS "entrySizeCoverage",e.exit_size_coverage AS "exitSizeCoverage",
        e.session_close_delay_ms AS "sessionCloseDelayMs",e.created_at AS "createdAt",e.updated_at AS "updatedAt"
        ${EXECUTION_FROM_FILTERS}
        ORDER BY COALESCE(e.exit_time,e.entry_time,o.signal_timestamp) DESC,e.id DESC LIMIT $13`,
      [...filterValues(filters), limit],
    );
    return result.rows.map((row) =>
      paperExecutionSchema.parse({
        ...row,
        entryPrice: numeric(row.entryPrice),
        entryTime: iso(row.entryTime),
        stopPrice: numeric(row.stopPrice),
        targetPrice: numeric(row.targetPrice),
        shares: numeric(row.shares),
        exitPrice: numeric(row.exitPrice),
        exitTime: iso(row.exitTime),
        fee: numeric(row.fee),
        grossPnl: numeric(row.grossPnl),
        netPnl: numeric(row.netPnl),
        rMultiple: numeric(row.rMultiple),
        economics: row.economics ?? null,
        sizing: row.sizing ?? null,
        entrySizeCoverage: numeric(row.entrySizeCoverage),
        exitSizeCoverage: numeric(row.exitSizeCoverage),
        sessionCloseDelayMs: numeric(row.sessionCloseDelayMs),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }),
    );
  }

  async aggregates(
    filters: PaperEvidenceFilters,
  ): Promise<PaperCohortAggregate[]> {
    const result = await this.pool.query<AggregateRow>(
      `WITH base AS (
        SELECT o.id AS observation_id,o.eligibility_status,
          jsonb_build_object(
            'profileId',o.profile_id,'profileName',o.profile_name,
            'profileConfigId',o.profile_config_id,'configVersion',o.config_version,
            'strategyKey',o.strategy_key,'strategyVersion',o.strategy_version,
            'source',r.source,'executionModelVersion',r.execution_model_version,
            ${COHORT_PROVENANCE},'assumptions',r.assumptions
          ) AS cohort
        ${FROM_FILTERS}
        AND (
          ($7::text IS NULL AND $8::text IS NULL AND $9::text IS NULL AND $10::text IS NULL AND $11::text IS NULL)
          OR EXISTS (
            SELECT 1 FROM paper_execution e WHERE e.observation_id=o.id
              AND ($7::text IS NULL OR e.model=$7)
              AND ($8::text IS NULL OR e.status=$8)
              AND ($9::text IS NULL OR e.no_fill_reason=$9)
              AND ($10::text IS NULL OR e.exit_reason=$10)
          AND ($11::text IS NULL OR e.economics_reason=$11)
          )
        )
      ),
      selected_models AS (
        SELECT unnest(CASE WHEN $7::text IS NULL THEN ARRAY['QUOTE','CANDLE']::text[] ELSE ARRAY[$7::text] END) AS model
      ),
      cohorts AS (
        SELECT cohort,count(*)::int AS signal_count,
          count(*) FILTER (WHERE eligibility_status='ELIGIBLE')::int AS eligible_signal_count
        FROM base GROUP BY cohort
      ),
      executions AS (
        SELECT b.cohort,e.model,e.status,e.r_multiple,e.exit_reason,e.no_fill_reason,
          e.economics_reason,
          e.entry_market_snapshot,e.entry_size_coverage,e.exit_size_coverage,e.session_close_delay_ms
        FROM base b JOIN paper_execution e ON e.observation_id=b.observation_id
        WHERE ($7::text IS NULL OR e.model=$7)
          AND ($8::text IS NULL OR e.status=$8)
          AND ($9::text IS NULL OR e.no_fill_reason=$9)
          AND ($10::text IS NULL OR e.exit_reason=$10)
          AND ($11::text IS NULL OR e.economics_reason=$11)
      ),
      metrics AS (
        SELECT cohort,model,
          count(*) FILTER (WHERE status IN ('OPEN','CLOSE_PENDING','CLOSED'))::int AS fills,
          count(*) FILTER (WHERE status='NO_FILL')::int AS no_fills,
          count(*) FILTER (WHERE status='REJECTED_ECONOMICS')::int AS rejected_economics,
          count(*) FILTER (WHERE status='CLOSED')::int AS closed_trades,
          count(*) FILTER (WHERE status='OPEN')::int AS open_executions,
          count(*) FILTER (WHERE status='CLOSE_PENDING')::int AS close_pending_executions,
          count(*) FILTER (WHERE status IN ('OPEN','CLOSE_PENDING'))::int AS unresolved_executions,
          count(*) FILTER (WHERE status='CLOSED' AND r_multiple > 0)::int AS wins,
          avg(r_multiple) FILTER (WHERE status='CLOSED') AS average_r,
          sum(r_multiple) FILTER (WHERE status='CLOSED') AS cumulative_r,
          count(*) FILTER (WHERE status='CLOSED' AND exit_reason='SESSION_CLOSE_DELAYED')::int AS delayed_close_count,
          coalesce(sum(session_close_delay_ms) FILTER (WHERE status='CLOSED' AND exit_reason='SESSION_CLOSE_DELAYED'),0)::bigint AS delayed_close_total_ms
        FROM executions GROUP BY cohort,model
      ),
      exit_distribution AS (
        SELECT cohort,model,jsonb_object_agg(exit_reason,occurrences) AS values
        FROM (SELECT cohort,model,exit_reason,count(*)::int AS occurrences FROM executions
              WHERE status='CLOSED' GROUP BY cohort,model,exit_reason) grouped
        GROUP BY cohort,model
      ),
      no_fill_distribution AS (
        SELECT cohort,model,jsonb_object_agg(no_fill_reason,occurrences) AS values
        FROM (SELECT cohort,model,no_fill_reason,count(*)::int AS occurrences FROM executions
              WHERE status='NO_FILL' GROUP BY cohort,model,no_fill_reason) grouped
        GROUP BY cohort,model
      ),
      economics_distribution AS (
        SELECT cohort,model,jsonb_object_agg(economics_reason,occurrences) AS values
        FROM (SELECT cohort,model,economics_reason,count(*)::int AS occurrences FROM executions
              WHERE status='REJECTED_ECONOMICS' GROUP BY cohort,model,economics_reason) grouped
        GROUP BY cohort,model
      ),
      size_distribution AS (
        SELECT cohort,model,jsonb_object_agg(bucket,occurrences) AS values
        FROM (
          SELECT cohort,model,
            CASE WHEN entry_size_coverage IS NULL THEN 'UNKNOWN'
                 WHEN entry_size_coverage < 1 THEN 'BELOW_ONE'
                 WHEN entry_size_coverage < 2 THEN 'ONE_TO_TWO'
                 ELSE 'TWO_OR_MORE' END AS bucket,
            count(*)::int AS occurrences
          FROM executions WHERE status IN ('OPEN','CLOSE_PENDING','CLOSED')
          GROUP BY cohort,model,bucket
        ) grouped GROUP BY cohort,model
      ),
      exit_size_distribution AS (
        SELECT cohort,model,jsonb_object_agg(bucket,occurrences) AS values
        FROM (
          SELECT cohort,model,
            CASE WHEN exit_size_coverage IS NULL THEN 'UNKNOWN'
                 WHEN exit_size_coverage < 1 THEN 'BELOW_ONE'
                 WHEN exit_size_coverage < 2 THEN 'ONE_TO_TWO'
                 ELSE 'TWO_OR_MORE' END AS bucket,
            count(*)::int AS occurrences
          FROM executions WHERE status='CLOSED'
          GROUP BY cohort,model,bucket
        ) grouped GROUP BY cohort,model
      ),
      entry_spread AS (
        SELECT cohort,model,count(*)::int AS sample_count,
          min((entry_market_snapshot->>'spread')::numeric) AS minimum,
          max((entry_market_snapshot->>'spread')::numeric) AS maximum,
          avg((entry_market_snapshot->>'spread')::numeric) AS average
        FROM executions
        WHERE entry_market_snapshot ? 'spread'
        GROUP BY cohort,model
      )
      SELECT c.cohort,m.model,c.signal_count,c.eligible_signal_count,
        coalesce(x.fills,0)::int AS fills,coalesce(x.no_fills,0)::int AS no_fills,
        coalesce(x.rejected_economics,0)::int AS rejected_economics,
        coalesce(x.closed_trades,0)::int AS closed_trades,coalesce(x.unresolved_executions,0)::int AS unresolved_executions,
        coalesce(x.open_executions,0)::int AS open_executions,
        coalesce(x.close_pending_executions,0)::int AS close_pending_executions,
        coalesce(x.wins,0)::int AS wins,x.average_r,x.cumulative_r,
        coalesce(x.delayed_close_count,0)::int AS delayed_close_count,coalesce(x.delayed_close_total_ms,0)::bigint AS delayed_close_total_ms,
        coalesce(ed.values,'{}'::jsonb) AS exit_reasons,coalesce(nd.values,'{}'::jsonb) AS no_fill_reasons,
        coalesce(ecd.values,'{}'::jsonb) AS economics_reasons,
        coalesce(sd.values,'{}'::jsonb) AS size_coverage,
        coalesce(esd.values,'{}'::jsonb) AS exit_size_coverage,
        coalesce(sp.sample_count,0)::int AS entry_spread_sample_count,
        sp.minimum AS entry_spread_minimum,sp.maximum AS entry_spread_maximum,sp.average AS entry_spread_average
      FROM cohorts c CROSS JOIN selected_models m
      LEFT JOIN metrics x ON x.cohort=c.cohort AND x.model=m.model
      LEFT JOIN exit_distribution ed ON ed.cohort=c.cohort AND ed.model=m.model
      LEFT JOIN no_fill_distribution nd ON nd.cohort=c.cohort AND nd.model=m.model
      LEFT JOIN economics_distribution ecd ON ecd.cohort=c.cohort AND ecd.model=m.model
      LEFT JOIN size_distribution sd ON sd.cohort=c.cohort AND sd.model=m.model
      LEFT JOIN exit_size_distribution esd ON esd.cohort=c.cohort AND esd.model=m.model
      LEFT JOIN entry_spread sp ON sp.cohort=c.cohort AND sp.model=m.model
      ORDER BY c.cohort->>'profileName',c.cohort->>'configVersion',m.model`,
      filterValues(filters),
    );
    return result.rows.map(mapAggregate);
  }

  /**
   * Re-prices every closed trade of a cohort under alternative fixed
   * round-trip commissions. The stored rows are never modified: each scenario
   * re-derives net P&L from the persisted gross result and the trade's own
   * initial risk, so a conclusion drawn under one broker schedule can be
   * checked against another (docs/paper-bot-performance-improvement-plan.md,
   * Phase 1: "commission sensitivity report").
   */
  async commissionSensitivity(
    filters: PaperEvidenceFilters,
    roundTripCommissions: readonly number[],
  ): Promise<PaperCommissionSensitivity[]> {
    const result = await this.pool.query<CommissionScenarioRow>(
      `WITH closed AS (
        SELECT jsonb_build_object(
          'profileId',o.profile_id,'profileName',o.profile_name,
          'profileConfigId',o.profile_config_id,'configVersion',o.config_version,
          'strategyKey',o.strategy_key,'strategyVersion',o.strategy_version,
          'source',r.source,'executionModelVersion',r.execution_model_version,
          ${COHORT_PROVENANCE},'assumptions',r.assumptions
        ) AS cohort,e.model,e.gross_pnl,e.initial_risk
        ${EXECUTION_FROM_FILTERS}
        AND e.status='CLOSED' AND e.initial_risk > 0
      ),
      scenarios AS (SELECT unnest($13::numeric[]) AS commission)
      SELECT c.cohort,c.model,s.commission AS round_trip_commission,
        count(*)::int AS closed_trades,
        count(*) FILTER (WHERE c.gross_pnl - s.commission > 0)::int AS wins,
        sum(c.gross_pnl - s.commission) AS net_pnl,
        avg((c.gross_pnl - s.commission) / c.initial_risk) AS average_r,
        sum((c.gross_pnl - s.commission) / c.initial_risk) AS cumulative_r,
        coalesce(sum(c.gross_pnl - s.commission) FILTER (WHERE c.gross_pnl - s.commission > 0),0) AS gross_profit,
        coalesce(-sum(c.gross_pnl - s.commission) FILTER (WHERE c.gross_pnl - s.commission < 0),0) AS gross_loss
      FROM closed c CROSS JOIN scenarios s
      GROUP BY c.cohort,c.model,s.commission
      ORDER BY c.cohort->>'profileName',c.cohort->>'configVersion',c.model,s.commission`,
      [...filterValues(filters), [...roundTripCommissions]],
    );
    const byCohort = new Map<string, PaperCommissionSensitivity>();
    for (const row of result.rows) {
      const key = `${JSON.stringify(row.cohort)}\u0000${row.model}`;
      const closedTrades = count(row.closed_trades);
      const wins = count(row.wins);
      const grossLoss = numeric(row.gross_loss) ?? 0;
      const existing = byCohort.get(key);
      const scenario = {
        roundTripCommission: numeric(row.round_trip_commission) ?? 0,
        closedTrades,
        wins,
        winRate: rate(wins, closedTrades),
        netPnl: numeric(row.net_pnl) ?? 0,
        averageR: numeric(row.average_r),
        expectancyR: numeric(row.average_r),
        cumulativeR: numeric(row.cumulative_r) ?? 0,
        profitFactor:
          grossLoss === 0 ? null : (numeric(row.gross_profit) ?? 0) / grossLoss,
      };
      if (existing) {
        byCohort.set(key, {
          ...existing,
          scenarios: [...existing.scenarios, scenario],
        });
        continue;
      }
      byCohort.set(key, {
        cohort: row.cohort as PaperCommissionSensitivity["cohort"],
        model: row.model,
        scenarios: [scenario],
      });
    }
    return [...byCohort.values()].map((value) =>
      paperCommissionSensitivitySchema.parse(value),
    );
  }

  async coordinationDecisions(
    filters: PaperEvidenceFilters,
    limit = 200,
  ): Promise<PaperCoordinationDecision[]> {
    const result = await this.pool.query(
      `SELECT d.id,d.run_id AS "runId",d.symbol,d.decision_timestamp AS "decisionTimestamp",
        d.outcome,d.reason,d.policy_version AS "policyVersion",
        d.selected_observation_id AS "selectedObservationId",
        d.selected_strategy_key AS "selectedStrategyKey",
        d.confirmation_observation_ids AS "confirmationObservationIds",
        jsonb_array_length(d.candidate_snapshot) AS "candidateCount",
        d.candidate_snapshot AS candidates,
        coalesce((
          SELECT jsonb_object_agg(e.observation_id::text, jsonb_build_object(
            'status',e.status,'netPnl',e.net_pnl,'rMultiple',e.r_multiple
          ))
          FROM paper_execution e
          WHERE e.observation_id IN (
            SELECT trigger_observation_id::uuid
            FROM jsonb_array_elements_text(d.trigger_observation_ids)
              AS trigger_observation_id
          )
            AND e.model='QUOTE'
        ), '{}'::jsonb) AS "candidateOutcomes",
        d.context_snapshot AS contexts,d.state_snapshot AS state,
        d.shadow_decision AS "shadowDecision",
        p.status AS "positionStatus",p.exit_reason AS "exitReason",p.exit_time AS "exitTime",
        (p.state->'exit'->'financials'->>'netPnl')::numeric AS "netPnl",
        (p.state->'exit'->'financials'->>'rMultiple')::numeric AS "rMultiple",
        d.created_at AS "createdAt"
        ${COORDINATION_FROM_FILTERS}
        ORDER BY d.decision_timestamp DESC,d.id DESC LIMIT $6`,
      [...coordinationFilterValues(filters), limit],
    );
    return result.rows.map((row) =>
      paperCoordinationDecisionSchema.parse({
        ...row,
        decisionTimestamp: iso(row.decisionTimestamp),
        exitTime: iso(row.exitTime),
        netPnl: numeric(row.netPnl),
        rMultiple: numeric(row.rMultiple),
        createdAt: iso(row.createdAt),
      }),
    );
  }

  async coordinationSummary(
    filters: PaperEvidenceFilters,
  ): Promise<PaperCoordinationSummary> {
    const totals = await this.pool.query<CoordinationSummaryRow>(
      `SELECT count(DISTINCT d.id)::int AS decisions,
        count(DISTINCT d.id) FILTER (WHERE d.outcome='APPROVED')::int AS approved,
        count(DISTINCT d.id) FILTER (WHERE d.outcome='DEFERRED')::int AS deferred,
        count(DISTINCT d.id) FILTER (WHERE d.outcome='REJECTED')::int AS rejected,
        count(p.id) FILTER (WHERE p.status IN ('OPEN','CLOSE_PENDING'))::int AS open_positions,
        count(p.id) FILTER (WHERE p.status='CLOSED')::int AS closed_trades,
        count(p.id) FILTER (WHERE p.status='CLOSED'
          AND round((p.state->'exit'->'financials'->>'netPnl')::numeric,2) > 0)::int AS wins,
        count(p.id) FILTER (WHERE p.status='CLOSED'
          AND round((p.state->'exit'->'financials'->>'netPnl')::numeric,2) < 0)::int AS losses,
        count(p.id) FILTER (WHERE p.status='CLOSED'
          AND round((p.state->'exit'->'financials'->>'netPnl')::numeric,2) = 0)::int AS scratches,
        coalesce(sum((p.state->'exit'->'financials'->>'netPnl')::numeric)
          FILTER (WHERE p.status='CLOSED'),0) AS net_pnl,
        coalesce(sum((p.state->'exit'->'financials'->>'rMultiple')::numeric)
          FILTER (WHERE p.status='CLOSED'),0) AS cumulative_r,
        avg((p.state->'exit'->'financials'->>'rMultiple')::numeric)
          FILTER (WHERE p.status='CLOSED') AS average_r,
        count(DISTINCT d.symbol) FILTER (WHERE d.outcome='APPROVED')::int AS symbols_traded,
        (count(DISTINCT d.id) FILTER (WHERE d.outcome='APPROVED')
          - count(DISTINCT d.symbol) FILTER (WHERE d.outcome='APPROVED'))::int AS repeated_symbol_entries
        ${COORDINATION_FROM_FILTERS}`,
      coordinationFilterValues(filters),
    );
    const grouped = await this.pool.query<{
      bucket: string;
      kind: string;
      occurrences: number | string;
    }>(
      `SELECT 'REASON' AS kind,d.reason AS bucket,count(DISTINCT d.id)::int AS occurrences
        ${COORDINATION_FROM_FILTERS}
        GROUP BY d.reason
      UNION ALL
      SELECT 'EXIT',p.exit_reason,count(p.id)::int
        ${COORDINATION_FROM_FILTERS}
        AND p.status='CLOSED' AND p.exit_reason IS NOT NULL
        GROUP BY p.exit_reason
      UNION ALL
      SELECT 'POLICY',d.policy_version,count(DISTINCT d.id)::int
        ${COORDINATION_FROM_FILTERS}
        GROUP BY d.policy_version`,
      coordinationFilterValues(filters),
    );
    const bucketsOf = (kind: string) =>
      Object.fromEntries(
        grouped.rows
          .filter((row) => row.kind === kind)
          .map((row) => [row.bucket, count(row.occurrences)]),
      );
    const row = totals.rows[0];
    const closedTrades = count(row?.closed_trades);
    return paperCoordinationSummarySchema.parse({
      policyVersions: grouped.rows
        .filter((entry) => entry.kind === "POLICY")
        .map((entry) => entry.bucket)
        .sort(),
      decisions: count(row?.decisions),
      approved: count(row?.approved),
      deferred: count(row?.deferred),
      rejected: count(row?.rejected),
      reasons: bucketsOf("REASON"),
      openPositions: count(row?.open_positions),
      closedTrades,
      wins: count(row?.wins),
      winRate: rate(count(row?.wins), closedTrades),
      netPnl: numeric(row?.net_pnl) ?? 0,
      cumulativeR: numeric(row?.cumulative_r) ?? 0,
      averageR: numeric(row?.average_r),
      exitReasons: bucketsOf("EXIT"),
      symbolsTraded: count(row?.symbols_traded),
      repeatedSymbolEntries: Math.max(0, count(row?.repeated_symbol_entries)),
    });
  }

  async curves(
    filters: PaperEvidenceFilters,
  ): Promise<PaperCohortCurvePoint[]> {
    const result = await this.pool.query<CurveRow>(
      `WITH closed AS (
        SELECT jsonb_build_object(
          'profileId',o.profile_id,'profileName',o.profile_name,
          'profileConfigId',o.profile_config_id,'configVersion',o.config_version,
          'strategyKey',o.strategy_key,'strategyVersion',o.strategy_version,
          'source',r.source,'executionModelVersion',r.execution_model_version,
          ${COHORT_PROVENANCE},'assumptions',r.assumptions
        ) AS cohort,e.model,r.session_date,e.r_multiple
        ${EXECUTION_FROM_FILTERS}
        AND e.status='CLOSED'
      ), daily AS (
        SELECT cohort,model,session_date,count(*)::int AS closed_trades,
          coalesce(sum(r_multiple),0) AS daily_r
        FROM closed GROUP BY cohort,model,session_date
      )
      SELECT cohort,model,session_date,closed_trades,daily_r,
        sum(daily_r) OVER (PARTITION BY cohort,model ORDER BY session_date) AS cumulative_r
      FROM daily
      ORDER BY cohort->>'profileName',cohort->>'configVersion',model,session_date`,
      filterValues({ ...filters, status: undefined }),
    );
    return result.rows.map((row) =>
      paperCohortCurvePointSchema.parse({
        cohort: row.cohort,
        model: row.model,
        sessionDate: iso(row.session_date)!.slice(0, 10),
        closedTrades: count(row.closed_trades),
        dailyR: numeric(row.daily_r) ?? 0,
        cumulativeR: numeric(row.cumulative_r) ?? 0,
      }),
    );
  }

  async qualifications(
    filters: PaperEvidenceFilters,
  ): Promise<PaperProfileQualification[]> {
    const result = await this.pool.query<QualificationRow>(
      `SELECT p.id profile_id,p.name profile_name,q.profile_config_id,q.strategy_key,q.strategy_version,
        q.execution_model_version,q.assumptions,q.policy_version,q.as_of_run_id,
        q.closed_trades,q.wins,q.net_pnl,q.cumulative_r,q.average_r,q.qualification,q.computed_at
       FROM paper_profile_qualification q
       JOIN scanner_profile_config c ON c.id=q.profile_config_id
       JOIN scanner_profile p ON p.id=c.profile_id
       JOIN paper_bot_run r ON r.id=q.as_of_run_id
       WHERE ($1::uuid IS NULL OR p.id=$1)
         AND ($2::uuid IS NULL OR q.profile_config_id=$2)
         AND ($3::text IS NULL OR q.execution_model_version=$3)
         AND ($4::date IS NULL OR r.session_date >= $4::date)
         AND ($5::date IS NULL OR r.session_date <= $5::date)
         AND q.market_id=$6
       ORDER BY q.computed_at DESC,p.name`,
      [
        filters.profileId ?? null,
        filters.profileConfigId ?? null,
        filters.executionModelVersion ?? null,
        filters.startDate ?? null,
        filters.endDate ?? null,
        filters.marketId ?? "CA_TSX",
      ],
    );
    return result.rows.map((row) =>
      paperProfileQualificationSchema.parse({
        profileId: row.profile_id,
        profileName: row.profile_name,
        profileConfigId: row.profile_config_id,
        strategyKey: row.strategy_key,
        strategyVersion: row.strategy_version,
        executionModelVersion: row.execution_model_version,
        assumptions: row.assumptions,
        policyVersion: row.policy_version,
        asOfRunId: row.as_of_run_id,
        closedTrades: count(row.closed_trades),
        wins: count(row.wins),
        netPnl: Number(row.net_pnl),
        cumulativeR: Number(row.cumulative_r),
        averageR: Number(row.average_r),
        qualification: row.qualification,
        computedAt: row.computed_at.toISOString(),
      }),
    );
  }

  async divergences(
    filters: PaperEvidenceFilters,
  ): Promise<PaperModelDivergence[]> {
    const result = await this.pool.query<DivergenceRow>(
      `WITH paired AS (
        SELECT jsonb_build_object(
          'profileId',o.profile_id,'profileName',o.profile_name,
          'profileConfigId',o.profile_config_id,'configVersion',o.config_version,
          'strategyKey',o.strategy_key,'strategyVersion',o.strategy_version,
          'source',r.source,'executionModelVersion',r.execution_model_version,
          ${COHORT_PROVENANCE},'assumptions',r.assumptions
        ) AS cohort,
          quote.status AS quote_status,quote.entry_price AS quote_entry_price,
          quote.exit_price AS quote_exit_price,quote.net_pnl AS quote_net_pnl,
          quote.r_multiple AS quote_r_multiple,quote.exit_reason AS quote_exit_reason,
          candle.status AS candle_status,candle.entry_price AS candle_entry_price,
          candle.exit_price AS candle_exit_price,candle.net_pnl AS candle_net_pnl,
          candle.r_multiple AS candle_r_multiple,candle.exit_reason AS candle_exit_reason
        FROM paper_signal_observation o
        JOIN paper_bot_run r ON r.id=o.run_id
        JOIN paper_execution quote ON quote.observation_id=o.id AND quote.model='QUOTE'
        JOIN paper_execution candle ON candle.observation_id=o.id AND candle.model='CANDLE'
        WHERE ($1::uuid IS NULL OR o.profile_id=$1)
          AND ($2::uuid IS NULL OR o.profile_config_id=$2)
          AND ($3::text IS NULL OR r.execution_model_version=$3)
          AND ($4::text IS NULL OR r.source=$4)
          AND ($5::date IS NULL OR o.signal_timestamp >= $5::date)
          AND ($6::date IS NULL OR o.signal_timestamp < ($6::date + INTERVAL '1 day'))
          AND r.market_id=$7
      )
      SELECT cohort,count(*)::int AS paired_executions,
        count(*) FILTER (WHERE quote_status='CLOSED' AND candle_status='CLOSED')::int AS paired_closed_executions,
        count(*) FILTER (
          WHERE quote_entry_price IS NOT NULL AND candle_entry_price IS NOT NULL
        )::int AS entry_price_sample_count,
        avg(quote_entry_price-candle_entry_price) AS entry_price_average,
        count(*) FILTER (WHERE quote_status='CLOSED' AND candle_status='CLOSED')::int AS closed_sample_count,
        avg(quote_exit_price-candle_exit_price) FILTER (WHERE quote_status='CLOSED' AND candle_status='CLOSED') AS exit_price_average,
        avg(quote_net_pnl-candle_net_pnl) FILTER (WHERE quote_status='CLOSED' AND candle_status='CLOSED') AS net_pnl_average,
        avg(quote_r_multiple-candle_r_multiple) FILTER (WHERE quote_status='CLOSED' AND candle_status='CLOSED') AS r_multiple_average,
        count(*) FILTER (WHERE quote_status='CLOSED' AND candle_status='CLOSED' AND quote_exit_reason IS DISTINCT FROM candle_exit_reason)::int AS exit_reason_mismatches
      FROM paired GROUP BY cohort
      ORDER BY cohort->>'profileName',cohort->>'configVersion'`,
      [...filterValues(filters).slice(0, 6), filters.marketId ?? "CA_TSX"],
    );
    return result.rows.map((row) => {
      const pairedClosed = count(row.paired_closed_executions);
      return paperModelDivergenceSchema.parse({
        cohort: row.cohort,
        pairedExecutions: count(row.paired_executions),
        pairedClosedExecutions: pairedClosed,
        entryPriceDifference: {
          sampleCount: count(row.entry_price_sample_count),
          average: numeric(row.entry_price_average),
        },
        exitPriceDifference: {
          sampleCount: count(row.closed_sample_count),
          average: numeric(row.exit_price_average),
        },
        netPnlDifference: {
          sampleCount: count(row.closed_sample_count),
          average: numeric(row.net_pnl_average),
        },
        rMultipleDifference: {
          sampleCount: count(row.closed_sample_count),
          average: numeric(row.r_multiple_average),
        },
        exitReasonMismatch: rate(
          count(row.exit_reason_mismatches),
          pairedClosed,
        ),
      });
    });
  }

  async historicalFor(
    aggregate: PaperCohortAggregate,
  ): Promise<HistoricalAggregate | HistoricalUnavailable> {
    const provenance = [
      aggregate.cohort.marketId,
      aggregate.cohort.currency,
      aggregate.cohort.signalSemanticsVersion,
      aggregate.cohort.replayScope,
    ];
    if (provenance.some((value) => !value || value === "UNKNOWN"))
      return {
        reason:
          "Historical comparison requires explicit market, currency, signal semantics and replay scope.",
      };
    const candidates = await this.pool.query<{ id: string }>(
      `SELECT r.id
       FROM profile_config_evidence e
       JOIN backtest_run r ON r.id=e.backtest_run_id
       WHERE e.profile_config_id=$1 AND e.strategy_key=$2 AND e.strategy_version=$3
         AND e.revoked_at IS NULL AND r.status='COMPLETED'
         AND r.execution_model_version=$4 AND r.execution_assumptions=$5::jsonb
         AND r.execution_assumptions->>'signalSemanticsVersion'=$6
         AND r.execution_assumptions->'costs'->>'currency'=$7
         AND r.execution_assumptions->>'evidenceScope'=$8
       ORDER BY r.id`,
      [
        aggregate.cohort.profileConfigId,
        aggregate.cohort.strategyKey,
        aggregate.cohort.strategyVersion,
        aggregate.cohort.executionModelVersion,
        JSON.stringify(aggregate.cohort.assumptions),
        aggregate.cohort.signalSemanticsVersion,
        aggregate.cohort.currency,
        aggregate.cohort.replayScope,
      ],
    );
    if (candidates.rows.length !== 1)
      return {
        reason:
          candidates.rows.length === 0
            ? "No exact profile-evidence backtest shares this execution model and assumptions."
            : "More than one exact profile-evidence backtest matches; select a cohort with unambiguous provenance.",
      };
    const backtestRunId = candidates.rows[0]!.id;
    const metrics = await this.pool.query<{
      closed_trades: string;
      wins: string;
      average_r: string | null;
      cumulative_r: string | null;
    }>(
      `SELECT count(*) AS closed_trades,count(*) FILTER (WHERE r_multiple>0) AS wins,
        avg(r_multiple) AS average_r,sum(r_multiple) AS cumulative_r
       FROM backtest_trade
       WHERE run_id=$1 AND strategy_name=$2 AND strategy_version=$3`,
      [
        backtestRunId,
        aggregate.cohort.strategyKey,
        aggregate.cohort.strategyVersion,
      ],
    );
    const exits = await this.pool.query<{
      exit_reason: string;
      occurrences: string;
    }>(
      `SELECT exit_reason,count(*) AS occurrences FROM backtest_trade
       WHERE run_id=$1 AND strategy_name=$2 AND strategy_version=$3
       GROUP BY exit_reason`,
      [
        backtestRunId,
        aggregate.cohort.strategyKey,
        aggregate.cohort.strategyVersion,
      ],
    );
    const row = metrics.rows[0]!;
    return {
      backtestRunId,
      closedTrades: count(row.closed_trades),
      wins: count(row.wins),
      averageR: numeric(row.average_r),
      cumulativeR: numeric(row.cumulative_r) ?? 0,
      exitReasons: Object.fromEntries(
        exits.rows.map((value) => [
          value.exit_reason,
          count(value.occurrences),
        ]),
      ),
    };
  }

  /**
   * The bot's trade-by-trade P&L ledger, one ADR-010 projection at a time.
   * Totals come from every trade the filters match rather than the returned
   * page, and the coordinated running balance is a window over that same full
   * set, so shortening the list can never move a number a reader sees.
   */
  async journal(
    filters: PaperEvidenceFilters,
    projection: PaperJournalProjection,
    limit = 200,
  ): Promise<PaperTradeJournal> {
    if (projection === "FUNDED")
      throw new Error(
        "Funded journal is served by the funded reporting service",
      );
    const coordinated = projection === "COORDINATED";
    const ledger = coordinated ? COORDINATED_LEDGER : INDEPENDENT_LEDGER;
    const values = coordinated
      ? coordinationFilterValues(filters)
      : filterValues(filters);
    // A running balance exists only for the coordinated projection. The
    // independent executions overlap by construction, so no account ever held
    // them together and no balance ever ran through them (ADR-010).
    const running = coordinated
      ? `CASE WHEN l.status='CLOSED' THEN sum(l."netPnl")
          OVER (ORDER BY l."exitTime",l.id ROWS UNBOUNDED PRECEDING) END`
      : "NULL::numeric";
    const entries = await this.pool.query<JournalEntryRow>(
      `WITH ledger AS (${ledger})
       SELECT l.*,l."grossPnl"-l."netPnl" AS costs,${running} AS "runningNetPnl"
       FROM ledger l
       ORDER BY coalesce(l."exitTime",l."entryTime") DESC NULLS LAST,l.id DESC
       LIMIT $${values.length + 1}`,
      [...values, limit],
    );
    const totals = await this.pool.query<JournalTotalsRow>(
      `WITH ledger AS (${ledger}) ${JOURNAL_TOTALS}`,
      values,
    );
    const row = totals.rows[0];
    const closedTrades = count(row?.closed_trades);
    const lost = numeric(row?.lost_net_pnl) ?? 0;
    const unresolved = coordinated
      ? await this.pool.query<{
          id: string;
          symbol: string;
          sessionDate: Date | string;
          status: "OPEN" | "CLOSE_PENDING";
          runStatus: "RUNNING" | "CLOSE_PENDING" | "COMPLETED" | "FAILED";
          entryTime: Date | string | null;
          lastFactTimestamp: Date | string | null;
          ageMs: number | string;
        }>(
          `SELECT p.id,p.symbol,p.session_date AS "sessionDate",p.status,
             r.status AS "runStatus",
             (p.state->'position'->>'entryTime')::timestamptz AS "entryTime",
             (p.state->>'lastFactTimestamp')::timestamptz AS "lastFactTimestamp",
             greatest(0,extract(epoch FROM (now()-coalesce(
               (p.state->>'lastFactTimestamp')::timestamptz,
               (p.state->'position'->>'entryTime')::timestamptz,p.created_at)))*1000)::bigint AS "ageMs"
           FROM paper_coordination_position p
           JOIN paper_coordination_decision d ON d.id=p.decision_id
           JOIN paper_bot_run r ON r.id=d.run_id
           WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=$1 AND mode='SHADOW')
             AND p.status IN ('OPEN','CLOSE_PENDING')
           ORDER BY p.session_date,p.created_at`,
          [filters.marketId ?? "CA_TSX"],
        )
      : { rows: [] };
    return paperTradeJournalSchema.parse({
      projection,
      entries: entries.rows.map((entry) => ({
        ...entry,
        sessionDate: iso(entry.sessionDate)!.slice(0, 10),
        entryPrice: numeric(entry.entryPrice),
        entryTime: iso(entry.entryTime),
        stopPrice: numeric(entry.stopPrice),
        targetPrice: numeric(entry.targetPrice),
        shares: numeric(entry.shares),
        initialRisk: numeric(entry.initialRisk),
        requestedRisk: numeric(entry.requestedRisk),
        riskDeploymentRatio:
          numeric(entry.requestedRisk) && numeric(entry.initialRisk) !== null
            ? numeric(entry.initialRisk)! / numeric(entry.requestedRisk)!
            : null,
        bindingCaps: Array.isArray(entry.bindingCaps) ? entry.bindingCaps : [],
        exitPrice: numeric(entry.exitPrice),
        exitTime: iso(entry.exitTime),
        grossPnl: numeric(entry.grossPnl),
        costs: numeric(entry.costs),
        netPnl: numeric(entry.netPnl),
        rMultiple: numeric(entry.rMultiple),
        runningNetPnl: numeric(entry.runningNetPnl),
        lastFactTimestamp: iso(entry.lastFactTimestamp),
        recoverySource: entry.recoverySource,
        recoveryBoundary: iso(entry.recoveryBoundary),
        recoveryFactTimestamp: iso(entry.recoveryFactTimestamp),
        recoveryDelayMs: numeric(entry.recoveryDelayMs),
      })),
      totals: {
        closedTrades,
        openPositions: count(row?.open_positions),
        wins: count(row?.wins),
        losses: count(row?.losses),
        scratches: count(row?.scratches),
        winRate: rate(count(row?.wins), closedTrades),
        grossPnl: numeric(row?.gross_pnl) ?? 0,
        costs: numeric(row?.costs) ?? 0,
        netPnl: numeric(row?.net_pnl) ?? 0,
        // Undefined without a loss to divide by, rather than infinite.
        profitFactor:
          lost === 0 ? null : (numeric(row?.won_net_pnl) ?? 0) / lost,
        cumulativeR: numeric(row?.cumulative_r) ?? 0,
        averageR: numeric(row?.average_r),
        largestWin: numeric(row?.largest_win),
        largestLoss: numeric(row?.largest_loss),
      },
      unresolvedPositions: unresolved.rows.map((position) => ({
        ...position,
        sessionDate: iso(position.sessionDate)!.slice(0, 10),
        entryTime: iso(position.entryTime),
        lastFactTimestamp: iso(position.lastFactTimestamp),
        ageMs: Number(position.ageMs),
      })),
    });
  }

  /**
   * Realized net P&L over time for the coordinated shadow account. The
   * running total is a window over the same closed rows the points come
   * from, so the curve cannot drift from the rows beneath it.
   */
  async performanceCurve(
    filters: PaperEvidenceFilters,
    range: { startDate: string; endDate: string },
    granularity: PaperPerformanceGranularity,
  ): Promise<PaperPerformanceCurve> {
    const marketId = filters.marketId ?? "CA_TSX";
    const result = await this.pool.query<PerformanceCurveRow>(
      granularity === "TRADE" ? PERFORMANCE_TRADE_CURVE : PERFORMANCE_DAY_CURVE,
      [filters.source ?? null, range.startDate, range.endDate, marketId],
    );
    return paperPerformanceCurveSchema.parse({
      account: "COORDINATED",
      marketId,
      currency: marketId === "CA_TSX" ? "CAD" : "USD",
      granularity,
      startDate: range.startDate,
      endDate: range.endDate,
      points: result.rows.map((row) => ({
        sessionDate: iso(row.sessionDate)!.slice(0, 10),
        closedAt: iso(row.closedAt)!,
        netPnl: numeric(row.netPnl) ?? 0,
        cumulativeNetPnl: numeric(row.cumulativeNetPnl) ?? 0,
        trades: count(row.trades),
      })),
      warnings: [],
    });
  }
}

interface JournalEntryRow {
  id: string;
  runId: string;
  sessionDate: Date | string;
  symbol: string;
  strategyKey: string;
  profileName: string;
  configVersion: string;
  status: "OPEN" | "CLOSE_PENDING" | "CLOSED";
  entryPrice: number | string | null;
  entryTime: Date | string | null;
  stopPrice: number | string | null;
  targetPrice: number | string | null;
  shares: number | string | null;
  initialRisk: number | string | null;
  requestedRisk: number | string | null;
  bindingCaps: unknown;
  exitPrice: number | string | null;
  exitTime: Date | string | null;
  exitReason: string | null;
  grossPnl: number | string | null;
  costs: number | string | null;
  netPnl: number | string | null;
  rMultiple: number | string | null;
  runningNetPnl: number | string | null;
  lastFactTimestamp: Date | string | null;
  recoverySource: string | null;
  recoveryBoundary: Date | string | null;
  recoveryFactTimestamp: Date | string | null;
  recoveryDelayMs: number | string | null;
}

interface JournalTotalsRow {
  closed_trades: number | string;
  open_positions: number | string;
  wins: number | string;
  losses: number | string;
  scratches: number | string;
  gross_pnl: number | string | null;
  costs: number | string | null;
  net_pnl: number | string | null;
  won_net_pnl: number | string | null;
  lost_net_pnl: number | string | null;
  cumulative_r: number | string | null;
  average_r: number | string | null;
  largest_win: number | string | null;
  largest_loss: number | string | null;
}

interface PerformanceCurveRow {
  sessionDate: Date | string;
  closedAt: Date | string;
  netPnl: number | string | null;
  cumulativeNetPnl: number | string | null;
  trades: number | string;
}

interface AggregateRow {
  cohort: Json;
  model: "QUOTE" | "CANDLE";
  signal_count: number | string;
  eligible_signal_count: number | string;
  fills: number | string;
  no_fills: number | string;
  rejected_economics: number | string;
  closed_trades: number | string;
  open_executions: number | string;
  close_pending_executions: number | string;
  unresolved_executions: number | string;
  wins: number | string;
  average_r: number | string | null;
  cumulative_r: number | string | null;
  delayed_close_count: number | string;
  delayed_close_total_ms: number | string;
  exit_reasons: Json;
  no_fill_reasons: Json;
  economics_reasons: Json;
  size_coverage: Json;
  exit_size_coverage: Json;
  entry_spread_sample_count: number | string;
  entry_spread_minimum: number | string | null;
  entry_spread_maximum: number | string | null;
  entry_spread_average: number | string | null;
}

interface CoordinationSummaryRow {
  decisions: number | string;
  approved: number | string;
  deferred: number | string;
  rejected: number | string;
  open_positions: number | string;
  closed_trades: number | string;
  wins: number | string;
  losses: number | string;
  scratches: number | string;
  net_pnl: number | string | null;
  cumulative_r: number | string | null;
  average_r: number | string | null;
  symbols_traded: number | string;
  repeated_symbol_entries: number | string;
}

interface CommissionScenarioRow {
  cohort: Json;
  model: "QUOTE" | "CANDLE";
  round_trip_commission: number | string;
  closed_trades: number | string;
  wins: number | string;
  net_pnl: number | string | null;
  average_r: number | string | null;
  cumulative_r: number | string | null;
  gross_profit: number | string | null;
  gross_loss: number | string | null;
}

interface CurveRow {
  cohort: Json;
  model: "QUOTE" | "CANDLE";
  session_date: Date | string;
  closed_trades: number | string;
  daily_r: number | string | null;
  cumulative_r: number | string | null;
}

interface DivergenceRow {
  cohort: Json;
  paired_executions: number | string;
  paired_closed_executions: number | string;
  entry_price_sample_count: number | string;
  entry_price_average: number | string | null;
  closed_sample_count: number | string;
  exit_price_average: number | string | null;
  net_pnl_average: number | string | null;
  r_multiple_average: number | string | null;
  exit_reason_mismatches: number | string;
}

interface QualificationRow {
  profile_id: string;
  profile_name: string;
  profile_config_id: string;
  strategy_key: string;
  strategy_version: string;
  execution_model_version: string;
  assumptions: Json;
  policy_version: string;
  as_of_run_id: string;
  closed_trades: number | string;
  wins: number | string;
  net_pnl: number | string;
  cumulative_r: number | string;
  average_r: number | string;
  qualification: "EXPLORATORY" | "PAPER_QUALIFIED";
  computed_at: Date;
}

function mapAggregate(row: AggregateRow): PaperCohortAggregate {
  const closedTrades = count(row.closed_trades);
  const fills = count(row.fills);
  const delayedCloseCount = count(row.delayed_close_count);
  const delayedCloseTotalMs = count(row.delayed_close_total_ms);
  const sizeCoverage = ["UNKNOWN", "BELOW_ONE", "ONE_TO_TWO", "TWO_OR_MORE"]
    .filter((bucket) => row.size_coverage[bucket] !== undefined)
    .map((bucket) => ({ bucket, count: count(row.size_coverage[bucket]) }));
  const exitSizeCoverage = ["UNKNOWN", "BELOW_ONE", "ONE_TO_TWO", "TWO_OR_MORE"]
    .filter((bucket) => row.exit_size_coverage[bucket] !== undefined)
    .map((bucket) => ({
      bucket,
      count: count(row.exit_size_coverage[bucket]),
    }));
  return paperCohortAggregateSchema.parse({
    cohort: row.cohort,
    model: row.model,
    signalCount: count(row.signal_count),
    eligibleSignalCount: count(row.eligible_signal_count),
    fills,
    noFills: count(row.no_fills),
    rejectedEconomics: count(row.rejected_economics),
    closedTrades,
    openExecutions: count(row.open_executions),
    closePendingExecutions: count(row.close_pending_executions),
    unresolvedExecutions: count(row.unresolved_executions),
    fillRate: rate(fills, count(row.eligible_signal_count)),
    winRate: rate(count(row.wins), closedTrades),
    averageR: numeric(row.average_r),
    expectancyR: numeric(row.average_r),
    cumulativeR: numeric(row.cumulative_r) ?? 0,
    exitReasons: numbers(row.exit_reasons),
    noFillReasons: numbers(row.no_fill_reasons),
    economicsReasons: numbers(row.economics_reasons),
    sizeCoverage,
    exitSizeCoverage,
    entrySpread: {
      sampleCount: count(row.entry_spread_sample_count),
      minimum: numeric(row.entry_spread_minimum),
      maximum: numeric(row.entry_spread_maximum),
      average: numeric(row.entry_spread_average),
    },
    delayedClose: {
      count: delayedCloseCount,
      totalDurationMs: delayedCloseTotalMs,
      averageDurationMs:
        delayedCloseCount === 0
          ? null
          : delayedCloseTotalMs / delayedCloseCount,
    },
  });
}

const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});
const numbers = (value: Json) =>
  Object.fromEntries(
    Object.entries(value).map(([key, amount]) => [key, count(amount)]),
  );
