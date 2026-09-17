import type { Pool } from "pg";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";
import { COORDINATION_POLICY_VERSION } from "./coordination-policy.js";

export type EvidenceCohortClassification =
  "CURRENT_AUTHORITATIVE" | "REVISED_LEGACY" | "UNREPRODUCIBLE_HISTORICAL";

export interface EvidenceCohortAuditItem {
  readonly marketId: string;
  readonly executionModelVersion: string | null;
  readonly classification: EvidenceCohortClassification;
  readonly runCount: number;
  readonly closedQuoteCount: number;
  readonly closedCandleCount: number;
  readonly netPnl: number;
  readonly cumulativeR: number;
  readonly firstSignalAt: string | null;
  readonly lastSignalAt: string | null;
  readonly qualifiedProfileCount: number;
  readonly trainedDatasetCount: number;
  readonly activeModelCount: number;
}

export interface AffectedModelDependency {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly strategy: string;
  readonly sourceKind: string;
  readonly executionModelVersion: string | null;
  readonly active: boolean;
  readonly needsRetraining: boolean;
  readonly status: "CURRENT" | "SUPERSEDED_COHORT";
}

export interface AffectedQualificationDependency {
  readonly marketId: string;
  readonly profileConfigId: string;
  readonly strategyKey: string;
  readonly strategyVersion: string;
  readonly executionModelVersion: string;
  readonly policyVersion: string;
  readonly closedTrades: number;
  readonly netPnl: number;
  readonly qualification: string;
  readonly isAuthoritative: boolean;
  readonly requiresReevaluation: boolean;
}

export interface EvidenceCohortAuditReport {
  readonly currentAuthoritativeVersion: string;
  readonly currentCoordinationVersion: string;
  readonly auditedAt: string;
  readonly cohorts: readonly EvidenceCohortAuditItem[];
  readonly affectedModels: readonly AffectedModelDependency[];
  readonly affectedQualifications: readonly AffectedQualificationDependency[];
}

export function classifyEvidenceCohort(
  modelVersion: string | null | undefined,
): EvidenceCohortClassification {
  if (!modelVersion) {
    return "UNREPRODUCIBLE_HISTORICAL";
  }
  if (modelVersion === AUTHORITATIVE_EXECUTION_MODEL_VERSION) {
    return "CURRENT_AUTHORITATIVE";
  }
  return "REVISED_LEGACY";
}

export class EvidenceCohortService {
  constructor(private readonly pool: Pool) {}

  classifyCohort(
    modelVersion: string | null | undefined,
  ): EvidenceCohortClassification {
    return classifyEvidenceCohort(modelVersion);
  }

  async auditCohorts(): Promise<EvidenceCohortAuditReport> {
    const [cohorts, models, qualifications] = await Promise.all([
      this.listCohortSummaries(),
      this.listAffectedModels(),
      this.listAffectedQualifications(),
    ]);

    return {
      currentAuthoritativeVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      currentCoordinationVersion: COORDINATION_POLICY_VERSION,
      auditedAt: new Date().toISOString(),
      cohorts,
      affectedModels: models,
      affectedQualifications: qualifications,
    };
  }

  async listCohortSummaries(): Promise<EvidenceCohortAuditItem[]> {
    const result = await this.pool.query<{
      market_id: string;
      execution_model_version: string | null;
      run_count: number | string;
      closed_quote_count: number | string;
      closed_candle_count: number | string;
      net_pnl: number | string | null;
      cumulative_r: number | string | null;
      first_signal_at: Date | null;
      last_signal_at: Date | null;
      qualified_profile_count: number | string;
      trained_dataset_count: number | string;
      active_model_count: number | string;
    }>(`
      WITH run_cohorts AS (
        SELECT
          r.market_id,
          r.execution_model_version,
          count(DISTINCT r.id)::int AS run_count,
          count(e.id) FILTER (WHERE e.model = 'QUOTE' AND e.status = 'CLOSED')::int AS closed_quote_count,
          count(e.id) FILTER (WHERE e.model = 'CANDLE' AND e.status = 'CLOSED')::int AS closed_candle_count,
          coalesce(sum(e.net_pnl) FILTER (WHERE e.model = 'QUOTE' AND e.status = 'CLOSED'), 0)::numeric AS net_pnl,
          coalesce(sum(e.r_multiple) FILTER (WHERE e.model = 'QUOTE' AND e.status = 'CLOSED'), 0)::numeric AS cumulative_r,
          min(o.signal_timestamp) AS first_signal_at,
          max(o.signal_timestamp) AS last_signal_at
        FROM paper_bot_run r
        LEFT JOIN paper_signal_observation o ON o.run_id = r.id
        LEFT JOIN paper_execution e ON e.observation_id = o.id
        GROUP BY r.market_id, r.execution_model_version
      ),
      qual_counts AS (
        SELECT
          market_id,
          execution_model_version,
          count(*) FILTER (WHERE qualification = 'PAPER_QUALIFIED')::int AS qualified_profile_count
        FROM paper_profile_qualification
        GROUP BY market_id, execution_model_version
      ),
      dataset_counts AS (
        SELECT
          market_id,
          cohort->>'executionModelVersion' AS execution_model_version,
          count(*)::int AS trained_dataset_count
        FROM statistical_training_dataset
        GROUP BY market_id, cohort->>'executionModelVersion'
      ),
      model_counts AS (
        SELECT
          d.market_id,
          d.cohort->>'executionModelVersion' AS execution_model_version,
          count(m.id) FILTER (WHERE m.active = true)::int AS active_model_count
        FROM statistical_model m
        JOIN statistical_training_dataset d ON d.id = m.training_dataset_id
        GROUP BY d.market_id, d.cohort->>'executionModelVersion'
      )
      SELECT
        rc.market_id,
        rc.execution_model_version,
        rc.run_count,
        rc.closed_quote_count,
        rc.closed_candle_count,
        rc.net_pnl,
        rc.cumulative_r,
        rc.first_signal_at,
        rc.last_signal_at,
        coalesce(qc.qualified_profile_count, 0) AS qualified_profile_count,
        coalesce(dc.trained_dataset_count, 0) AS trained_dataset_count,
        coalesce(mc.active_model_count, 0) AS active_model_count
      FROM run_cohorts rc
      LEFT JOIN qual_counts qc
        ON qc.market_id = rc.market_id
       AND (qc.execution_model_version = rc.execution_model_version OR (qc.execution_model_version IS NULL AND rc.execution_model_version IS NULL))
      LEFT JOIN dataset_counts dc
        ON dc.market_id = rc.market_id
       AND (dc.execution_model_version = rc.execution_model_version OR (dc.execution_model_version IS NULL AND rc.execution_model_version IS NULL))
      LEFT JOIN model_counts mc
        ON mc.market_id = rc.market_id
       AND (mc.execution_model_version = rc.execution_model_version OR (mc.execution_model_version IS NULL AND rc.execution_model_version IS NULL))
      ORDER BY rc.market_id, rc.execution_model_version DESC NULLS LAST
    `);

    return result.rows.map((row) => ({
      marketId: row.market_id,
      executionModelVersion: row.execution_model_version,
      classification: classifyEvidenceCohort(row.execution_model_version),
      runCount: Number(row.run_count),
      closedQuoteCount: Number(row.closed_quote_count),
      closedCandleCount: Number(row.closed_candle_count),
      netPnl: Math.round(Number(row.net_pnl) * 100) / 100,
      cumulativeR: Math.round(Number(row.cumulative_r) * 100) / 100,
      firstSignalAt: row.first_signal_at
        ? row.first_signal_at.toISOString()
        : null,
      lastSignalAt: row.last_signal_at
        ? row.last_signal_at.toISOString()
        : null,
      qualifiedProfileCount: Number(row.qualified_profile_count),
      trainedDatasetCount: Number(row.trained_dataset_count),
      activeModelCount: Number(row.active_model_count),
    }));
  }

  async listAffectedModels(): Promise<AffectedModelDependency[]> {
    const result = await this.pool.query<{
      id: string;
      model_version: string;
      strategy: string;
      source_kind: string;
      dataset_execution_model_version: string | null;
      backtest_execution_model_version: string | null;
      active: boolean;
    }>(`
      SELECT
        m.id,
        m.model_version,
        m.strategy_name AS strategy,
        m.source_kind,
        d.cohort->>'executionModelVersion' AS dataset_execution_model_version,
        b.execution_model_version AS backtest_execution_model_version,
        m.active
      FROM statistical_model m
      LEFT JOIN statistical_training_dataset d ON d.id = m.training_dataset_id
      LEFT JOIN backtest_run b ON b.id = m.backtest_run_id
      ORDER BY m.created_at DESC
    `);

    return result.rows.map((row) => {
      const version =
        row.dataset_execution_model_version ??
        row.backtest_execution_model_version;
      const isCurrent = version === AUTHORITATIVE_EXECUTION_MODEL_VERSION;
      return {
        modelId: row.id,
        modelVersion: row.model_version,
        strategy: row.strategy,
        sourceKind: row.source_kind,
        executionModelVersion: version,
        active: row.active,
        needsRetraining: !isCurrent,
        status: isCurrent ? "CURRENT" : "SUPERSEDED_COHORT",
      };
    });
  }

  async listAffectedQualifications(): Promise<
    AffectedQualificationDependency[]
  > {
    const result = await this.pool.query<{
      market_id: string;
      profile_config_id: string;
      strategy_key: string;
      strategy_version: string;
      execution_model_version: string;
      policy_version: string;
      closed_trades: number;
      net_pnl: number | string;
      qualification: string;
    }>(`
      SELECT
        market_id,
        profile_config_id,
        strategy_key,
        strategy_version,
        execution_model_version,
        policy_version,
        closed_trades,
        net_pnl,
        qualification
      FROM paper_profile_qualification
      ORDER BY market_id, strategy_key, computed_at DESC
    `);

    return result.rows.map((row) => {
      const isAuthoritative =
        row.execution_model_version === AUTHORITATIVE_EXECUTION_MODEL_VERSION;
      return {
        marketId: row.market_id,
        profileConfigId: row.profile_config_id,
        strategyKey: row.strategy_key,
        strategyVersion: row.strategy_version,
        executionModelVersion: row.execution_model_version,
        policyVersion: row.policy_version,
        closedTrades: Number(row.closed_trades),
        netPnl: Number(row.net_pnl),
        qualification: row.qualification,
        isAuthoritative,
        requiresReevaluation:
          !isAuthoritative && row.qualification === "PAPER_QUALIFIED",
      };
    });
  }
}
