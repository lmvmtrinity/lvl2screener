import {
  profileConfigVersionSchema,
  researchEvidenceBindingSchema,
  researchCoverageReportSchema,
  scannerProfileSchema,
  strategyDefinitionSchema,
  strategyEvaluationSchema,
  type AnalysisKind,
  type BacktestRun,
  type ScannerProfile,
  type ProfileConfigVersion,
  type StrategyDefinition,
  type StrategyEvaluation,
  type StrategyName,
  type StrategyParameters,
  type MarketId,
  type ComparisonCohortSelection,
} from "@tsx-scanner/contracts";
import { assertEvidenceBinding } from "../backtests/research-evidence-repository.js";
import type { Pool } from "pg";
import type { StrategyBacktestEvidence } from "../backtests/evidence-service.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";
import { marketSessionTimezone } from "../backtests/execution-provenance.js";
import {
  comparisonCohortKey,
  comparisonWindowHash,
  sha256,
  type ComparisonCohortRecord,
  type ComparisonScope,
} from "./comparison-scope.js";

type ProfileRow = {
  id: string;
  name: string;
  market_id: MarketId;
  strategy_definition_id: string;
  analysis_kind: AnalysisKind;
  strategy_key: StrategyName;
  strategy_version: string;
  config_id: string;
  config_version: string;
  source_calibration_run_id: string | null;
  parameters: unknown;
  enabled: boolean;
  display_order: number;
  created_at: Date;
  updated_at: Date;
  evidence_qualified: boolean;
  evidence_id: string | null;
  evidence_backtest_run_id: string | null;
  evidence_strategy_key: StrategyName | null;
  evidence_strategy_version: string | null;
  evidence_qualification: "EXPLORATORY" | "EVIDENCE_QUALIFIED" | null;
  evidence_created_at: Date | null;
  paper_trades: string | number;
  paper_wins: string | number;
  paper_net_pnl: string | number | null;
  paper_qualified?: boolean;
};
type DefinitionRow = {
  id: string;
  analysis_kind: AnalysisKind;
  strategy_key: StrategyName;
  version: string;
  name: string;
  description: string;
  enabled: boolean;
  parameter_schema: unknown;
  created_at: Date;
};
type EvaluationRow = {
  profile_id: string;
  profile_name: string;
  instrument_id: string;
  symbol: string;
  timestamp: Date;
  strategy_key: StrategyName;
  strategy_version: "1.0.0";
  config_version: string;
  state: string;
  score: number;
  reason_codes: unknown;
  entry_reference: string | null;
  stop_reference: string | null;
  target_reference: string | null;
  estimated_rr: string | null;
  snapshot_json: unknown;
  score_version: string;
  score_components: unknown;
  score_explanation: unknown;
  setup_instance_id: string | null;
  formation_evidence: unknown;
};
const evaluationFromRow = (v: EvaluationRow): StrategyEvaluation =>
  strategyEvaluationSchema.parse({
    kind: "SETUP",
    instrumentId: v.instrument_id,
    symbol: v.symbol,
    timestamp: v.timestamp.toISOString(),
    profileId: v.profile_id,
    profileName: v.profile_name,
    strategy: v.strategy_key,
    strategyVersion: v.strategy_version,
    configVersion: v.config_version,
    state: v.state,
    score: v.score,
    setupScore: v.score,
    scoreVersion: v.score_version,
    scoreComponents: presentJson(v.score_components),
    scoreExplanation: v.score_explanation ?? undefined,
    setupInstanceId: v.setup_instance_id,
    formationEvidence: v.formation_evidence,
    reasonCodes: v.reason_codes,
    entryReference:
      v.entry_reference == null ? null : Number(v.entry_reference),
    stopReference: v.stop_reference == null ? null : Number(v.stop_reference),
    targetReference:
      v.target_reference == null ? null : Number(v.target_reference),
    estimatedRr: v.estimated_rr == null ? null : Number(v.estimated_rr),
    featureSnapshot: v.snapshot_json,
  });

/** Mirrors the research scheduler's purged-sample floor for paper qualification. */
const MINIMUM_PAPER_TRADES = 200;
export function qualify(
  row: Pick<
    ProfileRow,
    | "evidence_qualified"
    | "paper_trades"
    | "paper_wins"
    | "paper_net_pnl"
    | "paper_qualified"
  >,
): {
  qualification: "EXPLORATORY" | "PAPER_QUALIFIED" | "EVIDENCE_QUALIFIED";
  qualificationReason: string;
} {
  if (row.evidence_qualified) {
    return {
      qualification: "EVIDENCE_QUALIFIED",
      qualificationReason:
        "Linked to a completed captured-history backtest that met every Phase 8 evidence gate for this exact configuration.",
    };
  }
  const trades = Number(row.paper_trades),
    wins = Number(row.paper_wins),
    netPnl = Number(row.paper_net_pnl ?? 0);
  const paperQualified =
    row.paper_qualified ??
    (trades >= MINIMUM_PAPER_TRADES && netPnl > 0 && wins > 0);
  if (paperQualified) {
    return {
      qualification: "PAPER_QUALIFIED",
      qualificationReason: `${trades} closed paper trades with positive net P&L meet the minimum sample for paper qualification.`,
    };
  }
  if (trades > 0) {
    return {
      qualification: "EXPLORATORY",
      qualificationReason: `${trades} closed paper trade(s) recorded; at least ${MINIMUM_PAPER_TRADES} with positive net P&L are required before paper qualification.`,
    };
  }
  return {
    qualification: "EXPLORATORY",
    qualificationReason:
      "No qualifying paper or holdout evidence is linked to this profile configuration.",
  };
}
const profileFromRow = (row: ProfileRow): ScannerProfile =>
  scannerProfileSchema.parse({
    id: row.id,
    name: row.name,
    marketId: row.market_id,
    strategyDefinitionId: row.strategy_definition_id,
    analysisKind: row.analysis_kind,
    strategyKey: row.strategy_key,
    strategyVersion: row.strategy_version,
    configId: row.config_id,
    configVersion: row.config_version,
    sourceCalibrationRunId: row.source_calibration_run_id,
    parameters: row.parameters,
    enabled: row.enabled,
    ...qualify(row),
    qualificationEvidence: row.evidence_id
      ? {
          id: row.evidence_id,
          profileConfigId: row.config_id,
          backtestRunId: row.evidence_backtest_run_id,
          strategy: row.evidence_strategy_key,
          strategyVersion: row.evidence_strategy_version,
          qualification: row.evidence_qualification,
          createdAt: row.evidence_created_at?.toISOString(),
        }
      : null,
    displayOrder: row.display_order,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
// Phase 4 columns are empty on rows written before the migration; leaving them
// undefined lets the contract fall back to its legacy V1 defaults.
const presentJson = (value: unknown): unknown =>
  value && Object.keys(value as object).length ? value : undefined;
function assertRealizedAfterSignal(
  signalTime: Date,
  entryTime: Date,
  exitTime: Date | null,
): void {
  if (
    exitTime &&
    (exitTime.getTime() < signalTime.getTime() ||
      exitTime.getTime() < entryTime.getTime())
  )
    throw new Error("Comparison outcome exit precedes signal or entry time");
}
/**
 * Paper qualification counts the paper bot's own executions in the paper evidence
 * tables (ADR-009: automated evidence is its own record and never interleaved
 * with any user-entered data).
 *
 * The sample is pinned to one cohort so a 30-trade sample is always computed under
 * a single fill definition: the exact profile configuration (`profile_config_id`,
 * so editing a parameter starts a new sample), the canonical quote model (each
 * observation also carries a supplementary CANDLE execution that would otherwise
 * double every trade), LIVE runs only, and the execution model version plus
 * assumptions snapshot of the most recent completed authoritative live run. Retuning bot
 * economics -- position size, slippage, fees -- therefore starts a new sample
 * rather than silently blending incomparable fills.
 */
const profileSelect = `SELECT p.id,p.name,p.market_id,p.strategy_definition_id,d.analysis_kind,d.strategy_key,d.version strategy_version,c.id config_id,c.config_version,c.source_calibration_run_id,c.parameters,p.enabled,p.display_order,p.created_at,p.updated_at,
  COALESCE(pe.qualification='EVIDENCE_QUALIFIED',false) evidence_qualified,
  pe.id evidence_id,pe.backtest_run_id evidence_backtest_run_id,pe.strategy_key evidence_strategy_key,pe.strategy_version evidence_strategy_version,pe.qualification evidence_qualification,pe.created_at evidence_created_at,
  COALESCE(pt.trades,0) paper_trades, COALESCE(pt.wins,0) paper_wins, pt.net_pnl paper_net_pnl,COALESCE(pt.paper_qualified,false) paper_qualified
  FROM scanner_profile p JOIN strategy_definition d ON d.id=p.strategy_definition_id JOIN scanner_profile_config c ON c.id=p.current_config_id
  LEFT JOIN LATERAL (SELECT * FROM profile_config_evidence e WHERE e.profile_config_id=c.id AND e.revoked_at IS NULL ORDER BY (e.qualification='EVIDENCE_QUALIFIED') DESC,e.created_at DESC LIMIT 1) pe ON true
  LEFT JOIN LATERAL (
    SELECT r.market_id,r.execution_model_version,r.assumptions
    FROM paper_bot_run r
    WHERE r.source='LIVE' AND r.status='COMPLETED' AND r.execution_model_version=$1 AND r.market_id=p.market_id
    ORDER BY r.session_date DESC,r.completed_at DESC,r.started_at DESC LIMIT 1
  ) ref ON true
  LEFT JOIN LATERAL (SELECT q.closed_trades trades,q.wins,q.net_pnl,(q.qualification='PAPER_QUALIFIED') paper_qualified
    FROM paper_profile_qualification q
    WHERE q.market_id=ref.market_id AND q.profile_config_id=c.id AND q.strategy_key=d.strategy_key AND q.strategy_version=d.version
      AND q.execution_model_version=ref.execution_model_version AND q.assumptions=ref.assumptions
      AND q.policy_version='paper-qualification-v4'
    ORDER BY q.computed_at DESC LIMIT 1) pt ON true`;

export type ComparisonOutcome = {
  profileId: string;
  profileName: string;
  outcomeId: string;
  realizedAt: string | null;
  setup: boolean;
  pnl: number | null;
  rMultiple: number | null;
  holdMinutes: number | null;
  falsePositive: boolean;
  cohortKey?: string;
};
export interface ProfileStore {
  listDefinitions(): Promise<StrategyDefinition[]>;
  listProfiles(): Promise<ScannerProfile[]>;
  getProfile(id: string): Promise<ScannerProfile | undefined>;
  createProfile(
    value: {
      name: string;
      marketId: MarketId;
      strategyDefinitionId: string;
      parameters: StrategyParameters;
      enabled: boolean;
      displayOrder?: number;
      sourceCalibrationRunId?: string;
    },
    configVersion: string,
  ): Promise<ScannerProfile>;
  updateProfile(
    id: string,
    value: {
      name?: string;
      parameters?: StrategyParameters;
      enabled?: boolean;
      displayOrder?: number;
      sourceCalibrationRunId?: string;
    },
    configVersion?: string,
  ): Promise<ScannerProfile | undefined>;
  getCalibrationRecommendation?(id: string): Promise<
    | {
        status: string;
        marketId: MarketId;
        executionModelVersion: string | null;
        strategy: StrategyName;
        recommendedConfig: Record<string, unknown> | null;
      }
    | undefined
  >;
  duplicateProfile(
    id: string,
    name: string,
    configVersion: string,
  ): Promise<ScannerProfile | undefined>;
  listConfigVersions(profileId: string): Promise<ProfileConfigVersion[]>;
  listEvaluations(
    profileId?: string,
    limit?: number,
  ): Promise<StrategyEvaluation[]>;
  listLatestEvaluations?(limit?: number): Promise<StrategyEvaluation[]>;
  comparisonOutcomes(
    profileIds: string[],
    source: "LIVE" | "PAPER" | "BACKTEST",
    start: string,
    end: string,
    timeStart: string,
    timeEnd: string,
    marketId?: MarketId,
    cohortKeys?: ComparisonCohortSelection,
  ): Promise<ComparisonOutcome[]>;
  comparisonCohorts(
    profileIds: string[],
    source: "LIVE" | "PAPER" | "BACKTEST",
    start: string,
    end: string,
    timeStart: string,
    timeEnd: string,
    marketId?: MarketId,
  ): Promise<ComparisonCohortRecord[]>;
  comparisonScopes(
    profileIds: string[],
    source: "LIVE" | "PAPER" | "BACKTEST",
    start: string,
    end: string,
    timeStart: string,
    timeEnd: string,
    marketId?: MarketId,
    cohortKeys?: ComparisonCohortSelection,
  ): Promise<ComparisonScope[]>;
}

export class PostgresProfileStore implements ProfileStore {
  constructor(private readonly pool: Pool) {}
  async listDefinitions(): Promise<StrategyDefinition[]> {
    const r = await this.pool.query<DefinitionRow>(
      "SELECT * FROM strategy_definition ORDER BY analysis_kind,strategy_key,version",
    );
    return r.rows.map((v) =>
      strategyDefinitionSchema.parse({
        id: v.id,
        analysisKind: v.analysis_kind,
        strategyKey: v.strategy_key,
        version: v.version,
        name: v.name,
        description: v.description,
        enabled: v.enabled,
        parameterSchema: v.parameter_schema,
        createdAt: v.created_at.toISOString(),
      }),
    );
  }
  async linkBacktestEvidence(
    run: BacktestRun,
    evidence: StrategyBacktestEvidence[],
  ): Promise<void> {
    // During the Phase 4 cutover the current Python replay remains available,
    // but it must not grant new profile qualification under retired fill
    // semantics. Authoritative reruns will carry the shared-core version.
    if (run.executionModelVersion !== AUTHORITATIVE_EXECUTION_MODEL_VERSION)
      return;
    for (const value of evidence)
      await this.pool.query(
        `INSERT INTO profile_config_evidence
        (profile_config_id,strategy_definition_id,strategy_key,strategy_version,backtest_run_id,qualification,evidence)
        SELECT c.id,d.id,d.strategy_key,d.version,$1,$2,$3::jsonb
        FROM scanner_profile p
        JOIN scanner_profile_config c ON c.id=p.current_config_id
        JOIN strategy_definition d ON d.id=p.strategy_definition_id
        WHERE c.parameters=$4::jsonb AND d.strategy_key=$5 AND d.version=$6
        ON CONFLICT(profile_config_id,backtest_run_id,strategy_key,strategy_version)
        DO UPDATE SET qualification=EXCLUDED.qualification,evidence=EXCLUDED.evidence,revoked_at=NULL`,
        [
          run.id,
          value.evidence.qualification,
          JSON.stringify(value.evidence),
          JSON.stringify(run.parameters),
          value.strategy,
          run.strategyVersion,
        ],
      );
  }
  async replaceBacktestEvidence(
    source: BacktestRun,
    replacement: BacktestRun,
    evidence: StrategyBacktestEvidence[],
  ): Promise<void> {
    if (
      replacement.executionModelVersion !==
      AUTHORITATIVE_EXECUTION_MODEL_VERSION
    )
      throw new Error("Replacement evidence is not authoritative");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const value of evidence)
        await client.query(
          `INSERT INTO profile_config_evidence
          (profile_config_id,strategy_definition_id,strategy_key,strategy_version,backtest_run_id,qualification,evidence)
          SELECT old.profile_config_id,old.strategy_definition_id,old.strategy_key,old.strategy_version,$2,$3,$4::jsonb
          FROM profile_config_evidence old
          WHERE old.backtest_run_id=$1 AND old.strategy_key=$5
          ON CONFLICT(profile_config_id,backtest_run_id,strategy_key,strategy_version)
          DO UPDATE SET qualification=EXCLUDED.qualification,evidence=EXCLUDED.evidence,revoked_at=NULL`,
          [
            source.id,
            replacement.id,
            value.evidence.qualification,
            JSON.stringify(value.evidence),
            value.strategy,
          ],
        );
      await client.query(
        `UPDATE profile_config_evidence SET revoked_at=COALESCE(revoked_at,now())
         WHERE backtest_run_id=$1`,
        [source.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async listProfiles(): Promise<ScannerProfile[]> {
    const r = await this.pool.query<ProfileRow>(
      `${profileSelect} ORDER BY p.display_order,p.name`,
      [AUTHORITATIVE_EXECUTION_MODEL_VERSION],
    );
    return r.rows.map(profileFromRow);
  }
  async getProfile(id: string): Promise<ScannerProfile | undefined> {
    const r = await this.pool.query<ProfileRow>(
      `${profileSelect} WHERE p.id=$2`,
      [AUTHORITATIVE_EXECUTION_MODEL_VERSION, id],
    );
    return r.rows[0] ? profileFromRow(r.rows[0]) : undefined;
  }

  /**
   * Resolves the immutable profile configuration named by a persisted event,
   * rather than the profile's mutable current_config_id. Paper execution may
   * reconcile an event after the operator has already revised the profile.
   */
  async getProfileConfig(
    profileId: string,
    configVersion: string,
  ): Promise<
    { configId: string; configVersion: string; parameters: unknown } | undefined
  > {
    const result = await this.pool.query<{
      configId: string;
      configVersion: string;
      parameters: unknown;
    }>(
      `SELECT id AS "configId", config_version AS "configVersion", parameters
       FROM scanner_profile_config
       WHERE profile_id=$1 AND config_version=$2`,
      [profileId, configVersion],
    );
    return result.rows[0];
  }
  async createProfile(
    value: {
      name: string;
      marketId: MarketId;
      strategyDefinitionId: string;
      parameters: StrategyParameters;
      enabled: boolean;
      displayOrder?: number;
      sourceCalibrationRunId?: string;
    },
    configVersion: string,
  ): Promise<ScannerProfile> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const p = await c.query<{ id: string }>(
        `INSERT INTO scanner_profile(name,market_id,strategy_definition_id,enabled,display_order) VALUES($1,$2,$3,$4,COALESCE($5,(SELECT COALESCE(MAX(display_order),-1)+1 FROM scanner_profile WHERE market_id=$2))) RETURNING id`,
        [
          value.name,
          value.marketId,
          value.strategyDefinitionId,
          value.enabled,
          value.displayOrder,
        ],
      );
      const id = p.rows[0]!.id;
      const cfg = await c.query<{ id: string }>(
        "INSERT INTO scanner_profile_config(profile_id,market_id,config_version,parameters,source_calibration_run_id) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id",
        [
          id,
          value.marketId,
          configVersion,
          JSON.stringify(value.parameters),
          value.sourceCalibrationRunId ?? null,
        ],
      );
      await c.query(
        "UPDATE scanner_profile SET current_config_id=$2 WHERE id=$1",
        [id, cfg.rows[0]!.id],
      );
      await c.query("COMMIT");
      return (await this.getProfile(id))!;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async updateProfile(
    id: string,
    value: {
      name?: string;
      parameters?: StrategyParameters;
      enabled?: boolean;
      displayOrder?: number;
      sourceCalibrationRunId?: string;
    },
    configVersion?: string,
  ): Promise<ScannerProfile | undefined> {
    const existing = await this.getProfile(id);
    if (!existing) return undefined;
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      let configId = existing.configId;
      if (value.parameters && configVersion) {
        const r = await c.query<{ id: string }>(
          "INSERT INTO scanner_profile_config(profile_id,market_id,config_version,parameters,source_calibration_run_id) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id",
          [
            id,
            existing.marketId,
            configVersion,
            JSON.stringify(value.parameters),
            value.sourceCalibrationRunId ?? null,
          ],
        );
        configId = r.rows[0]!.id;
      }
      await c.query(
        "UPDATE scanner_profile SET name=COALESCE($2,name),enabled=COALESCE($3,enabled),display_order=COALESCE($4,display_order),current_config_id=$5,updated_at=now() WHERE id=$1",
        [id, value.name, value.enabled, value.displayOrder, configId],
      );
      await c.query("COMMIT");
      return (await this.getProfile(id))!;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async getCalibrationRecommendation(id: string) {
    const result = await this.pool.query<{
      status: string;
      market_id: MarketId;
      execution_model_version: string | null;
      strategy_name: StrategyName;
      recommended_config: Record<string, unknown> | null;
    }>(
      `SELECT status,market_id,execution_model_version,strategy_name,recommended_config
       FROM calibration_run WHERE id=$1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          status: row.status,
          marketId: row.market_id,
          executionModelVersion: row.execution_model_version,
          strategy: row.strategy_name,
          recommendedConfig: row.recommended_config,
        }
      : undefined;
  }
  async duplicateProfile(
    id: string,
    name: string,
    configVersion: string,
  ): Promise<ScannerProfile | undefined> {
    const p = await this.getProfile(id);
    if (!p) return undefined;
    return this.createProfile(
      {
        name,
        marketId: p.marketId,
        strategyDefinitionId: p.strategyDefinitionId,
        parameters: p.parameters,
        enabled: false,
      },
      configVersion,
    );
  }
  async listConfigVersions(profileId: string): Promise<ProfileConfigVersion[]> {
    const r = await this.pool.query<{
      id: string;
      config_version: string;
      parameters: unknown;
      created_at: Date;
      source_calibration_run_id: string | null;
      current: boolean;
    }>(
      "SELECT c.id,c.config_version,c.source_calibration_run_id,c.parameters,c.created_at,(c.id=p.current_config_id) current FROM scanner_profile_config c JOIN scanner_profile p ON p.id=c.profile_id WHERE c.profile_id=$1 ORDER BY c.created_at,c.id",
      [profileId],
    );
    return r.rows.map((v) =>
      profileConfigVersionSchema.parse({
        configId: v.id,
        configVersion: v.config_version,
        sourceCalibrationRunId: v.source_calibration_run_id,
        parameters: v.parameters,
        createdAt: v.created_at.toISOString(),
        current: v.current,
        changes: [],
      }),
    );
  }
  async listEvaluations(
    profileId?: string,
    limit = 1000,
  ): Promise<StrategyEvaluation[]> {
    const r = await this.pool.query<EvaluationRow>(
      `SELECT e.profile_id,p.name profile_name,e.instrument_id,i.symbol,e.timestamp,e.strategy_key,e.strategy_version,e.config_version,e.state,e.score,e.reason_codes,e.entry_reference,e.stop_reference,e.target_reference,e.estimated_rr,e.score_version,e.score_components,e.score_explanation,e.setup_instance_id,e.formation_evidence,fs.snapshot_json FROM strategy_evaluation e JOIN scanner_profile p ON p.id=e.profile_id JOIN instrument i ON i.id=e.instrument_id JOIN feature_snapshot fs ON fs.id=e.feature_snapshot_id ${profileId ? "WHERE e.profile_id=$1" : ""} ORDER BY e.timestamp DESC,e.score DESC LIMIT $${profileId ? 2 : 1}`,
      [...(profileId ? [profileId] : []), Math.max(1, Math.min(5000, limit))],
    );
    return r.rows.map(evaluationFromRow);
  }
  /** Latest evaluation per profile/instrument within the most recent evaluation window.
   * The materialized `latest` set keeps `feature_snapshot` payload lookups bounded to the
   * deduplicated rows instead of every row in the window. */
  async listLatestEvaluations(limit = 5000): Promise<StrategyEvaluation[]> {
    const r = await this.pool.query<EvaluationRow>(
      `WITH recent AS MATERIALIZED (
         SELECT e.id,e.profile_id,e.instrument_id,e.timestamp,e.score
           FROM strategy_evaluation e
          ORDER BY e.timestamp DESC,e.score DESC
          LIMIT $1
       ),
       latest AS MATERIALIZED (
         SELECT DISTINCT ON (r.profile_id,r.instrument_id) r.id
           FROM recent r
          ORDER BY r.profile_id,r.instrument_id,r.timestamp DESC,r.score DESC
       )
       SELECT e.profile_id,p.name profile_name,e.instrument_id,i.symbol,e.timestamp,e.strategy_key,e.strategy_version,e.config_version,e.state,e.score,e.reason_codes,e.entry_reference,e.stop_reference,e.target_reference,e.estimated_rr,e.score_version,e.score_components,e.score_explanation,e.setup_instance_id,e.formation_evidence,fs.snapshot_json
         FROM latest l
         JOIN strategy_evaluation e ON e.id=l.id
         JOIN scanner_profile p ON p.id=e.profile_id
         JOIN instrument i ON i.id=e.instrument_id
         JOIN feature_snapshot fs ON fs.id=e.feature_snapshot_id
        ORDER BY e.timestamp DESC,e.score DESC`,
      [Math.max(1, Math.min(5000, limit))],
    );
    return r.rows.map(evaluationFromRow);
  }
  async comparisonOutcomes(
    profileIds: string[],
    source: "LIVE" | "PAPER" | "BACKTEST",
    start: string,
    end: string,
    timeStart: string,
    timeEnd: string,
    marketId: MarketId = "CA_TSX",
    cohortKeys?: ComparisonCohortSelection,
  ): Promise<ComparisonOutcome[]> {
    const timezone = marketSessionTimezone(marketId);
    const windowHash = comparisonWindowHash(
      marketId,
      start,
      end,
      timeStart,
      timeEnd,
    );
    const include = (profileId: string, cohortKey: string) =>
      !cohortKeys?.[profileId] || cohortKeys[profileId] === cohortKey;
    if (source === "LIVE") {
      const r = await this.pool.query<{
        id: string;
        profile_id: string;
        name: string;
        outcome_id: string;
        false_positive: boolean;
        profile_config_id: string;
        strategy_version: string;
      }>(
        `SELECT e.profile_id,p.name,MIN(e.id::text) outcome_id,
          BOOL_OR(e.previous_state='READY' AND e.state='INVALIDATED') false_positive,
          p.current_config_id profile_config_id,d.version strategy_version
         FROM strategy_evaluation e
         JOIN scanner_profile p ON p.id=e.profile_id
         JOIN scanner_profile_config c ON c.id=p.current_config_id
         JOIN strategy_definition d ON d.id=p.strategy_definition_id
         WHERE e.profile_id=ANY($1::uuid[]) AND e.config_version=c.config_version AND e.strategy_version=d.version
           AND e.setup_instance_id IS NOT NULL
           AND e.timestamp >= ($2::date::timestamp AT TIME ZONE $7) AND e.timestamp < (($3::date + 1)::timestamp AT TIME ZONE $7)
           AND e.market_id=$6
           AND (e.timestamp AT TIME ZONE $7)::time BETWEEN $4::time AND $5::time
           AND (e.state='READY' OR (e.previous_state='READY' AND e.state='INVALIDATED'))
         GROUP BY e.profile_id,p.name,e.setup_instance_id,p.current_config_id,d.version
         ORDER BY MIN(e.timestamp),outcome_id`,
        [profileIds, start, end, timeStart, timeEnd, marketId, timezone],
      );
      return r.rows.flatMap((v) => {
        const cohortKey = comparisonCohortKey({
          marketId,
          profileConfigId: v.profile_config_id,
          strategyVersion: v.strategy_version,
          executionModelVersion: null,
          executionAssumptions: null,
          signalSemanticsVersion: null,
          replayScope: null,
          inputHash: null,
          windowHash,
        });
        if (!include(v.profile_id, cohortKey)) return [];
        return [
          {
            profileId: v.profile_id,
            profileName: v.name,
            outcomeId: `LIVE:${v.outcome_id}`,
            realizedAt: null,
            setup: true,
            pnl: null,
            rMultiple: null,
            holdMinutes: null,
            falsePositive: v.false_positive,
            cohortKey,
          },
        ];
      });
    }
    if (source === "PAPER") {
      const r = await this.pool.query<{
        id: string;
        profile_id: string;
        name: string;
        net_pnl: string | null;
        r_multiple: string | null;
        signal_time: Date;
        entry_time: Date;
        exit_time: Date | null;
        profile_config_id: string;
        strategy_version: string;
        execution_model_version: string;
        execution_assumptions: unknown;
        signal_semantics_version: string | null;
        replay_scope: string | null;
      }>(
        `SELECT x.id,o.profile_id,o.profile_name name,x.net_pnl,x.r_multiple,o.signal_timestamp signal_time,x.entry_time,x.exit_time,
                o.profile_config_id,o.strategy_version,r.execution_model_version,
                r.assumptions execution_assumptions,
                o.source_event_payload->>'signalSemanticsVersion' signal_semantics_version,
                r.assumptions->>'evidenceScope' replay_scope
         FROM paper_execution x
         JOIN paper_signal_observation o ON o.id=x.observation_id
         JOIN paper_bot_run r ON r.id=o.run_id
         JOIN scanner_profile p ON p.id=o.profile_id
         JOIN scanner_profile_config c ON c.id=p.current_config_id
         JOIN strategy_definition d ON d.id=p.strategy_definition_id
         WHERE o.profile_id=ANY($1::uuid[]) AND o.profile_config_id=c.id
           AND o.strategy_key=d.strategy_key AND o.strategy_version=d.version
           AND r.source='LIVE' AND x.model='QUOTE' AND x.status='CLOSED'
           AND o.signal_timestamp >= ($2::date::timestamp AT TIME ZONE $7) AND o.signal_timestamp < (($3::date + 1)::timestamp AT TIME ZONE $7)
           AND r.market_id=$6
           AND (o.signal_timestamp AT TIME ZONE $7)::time BETWEEN $4::time AND $5::time
         ORDER BY x.exit_time,x.id`,
        [profileIds, start, end, timeStart, timeEnd, marketId, timezone],
      );
      return r.rows.flatMap((v) => {
        assertRealizedAfterSignal(v.signal_time, v.entry_time, v.exit_time);
        const cohortKey = comparisonCohortKey({
          marketId,
          profileConfigId: v.profile_config_id,
          strategyVersion: v.strategy_version,
          executionModelVersion: v.execution_model_version,
          executionAssumptions: v.execution_assumptions,
          signalSemanticsVersion: v.signal_semantics_version,
          replayScope: v.replay_scope,
          inputHash: null,
          windowHash,
        });
        if (!include(v.profile_id, cohortKey)) return [];
        return [
          {
            profileId: v.profile_id,
            profileName: v.name,
            outcomeId: `PAPER:${v.id}`,
            realizedAt: v.exit_time?.toISOString() ?? null,
            setup: true,
            pnl: v.net_pnl == null ? null : Number(v.net_pnl),
            rMultiple: v.r_multiple == null ? null : Number(v.r_multiple),
            holdMinutes: v.exit_time
              ? (v.exit_time.getTime() - v.entry_time.getTime()) / 60000
              : null,
            falsePositive: v.net_pnl != null && Number(v.net_pnl) <= 0,
            cohortKey,
          },
        ];
      });
    }
    const r = await this.pool.query<{
      profile_id: string;
      name: string;
      setup: boolean;
      outcome_id: string;
      net_pnl: string | null;
      r_multiple: string | null;
      signal_time: Date;
      entry_time: Date;
      exit_time: Date | null;
      profile_config_id: string;
      strategy_version: string;
      execution_model_version: string | null;
      execution_assumptions: unknown | null;
      replay_input: unknown | null;
      replay_scope: string | null;
    }>(
      `SELECT p.id profile_id,p.name,TRUE setup,
              concat('BACKTEST:',MIN(e.id)::text) outcome_id,
              NULL::numeric net_pnl,NULL::numeric r_multiple,MIN(e.timestamp) signal_time,MIN(e.timestamp) entry_time,NULL::timestamptz exit_time,
              c.id profile_config_id,r.strategy_version,r.execution_model_version,
              r.execution_assumptions,r.replay_input,
              r.execution_assumptions->>'evidenceScope' replay_scope
       FROM backtest_state_event e
       JOIN backtest_run r ON r.id=e.run_id
       JOIN profile_config_evidence pe ON pe.backtest_run_id=r.id AND pe.strategy_key=e.strategy_name AND pe.strategy_version=r.strategy_version AND pe.revoked_at IS NULL
       JOIN scanner_profile_config c ON c.id=pe.profile_config_id
       JOIN scanner_profile p ON p.current_config_id=c.id
       WHERE p.id=ANY($1::uuid[]) AND e.state='READY' AND e.setup_instance_id IS NOT NULL
         AND e.timestamp >= ($2::date::timestamp AT TIME ZONE $7) AND e.timestamp < (($3::date + 1)::timestamp AT TIME ZONE $7)
         AND r.market_id=$6
         AND (e.timestamp AT TIME ZONE $7)::time BETWEEN $4::time AND $5::time
       GROUP BY p.id,p.name,c.id,r.strategy_version,r.execution_model_version,r.execution_assumptions,r.replay_input,e.run_id,e.strategy_name,e.setup_instance_id
       UNION ALL
       SELECT p.id,p.name,FALSE,concat('BACKTEST:',t.id::text),t.net_pnl,t.r_multiple,t.signal_timestamp,t.entry_time,t.exit_time,
              c.id,r.strategy_version,r.execution_model_version,r.execution_assumptions,r.replay_input,
              r.execution_assumptions->>'evidenceScope'
       FROM backtest_trade t
       JOIN backtest_run r ON r.id=t.run_id
       JOIN profile_config_evidence pe ON pe.backtest_run_id=r.id AND pe.strategy_key=t.strategy_name AND pe.strategy_version=t.strategy_version AND pe.revoked_at IS NULL
       JOIN scanner_profile_config c ON c.id=pe.profile_config_id
       JOIN scanner_profile p ON p.current_config_id=c.id
       WHERE p.id=ANY($1::uuid[]) AND t.setup_instance_id IS NOT NULL
         AND t.entry_time >= ($2::date::timestamp AT TIME ZONE $7) AND t.entry_time < (($3::date + 1)::timestamp AT TIME ZONE $7)
         AND r.market_id=$6
         AND (t.entry_time AT TIME ZONE $7)::time BETWEEN $4::time AND $5::time
       ORDER BY exit_time NULLS LAST,outcome_id`,
      [profileIds, start, end, timeStart, timeEnd, marketId, timezone],
    );
    return r.rows.flatMap((v) => {
      assertRealizedAfterSignal(v.signal_time, v.entry_time, v.exit_time);
      const replayInput =
        v.replay_input && typeof v.replay_input === "object"
          ? (v.replay_input as { inputHash?: unknown })
          : undefined;
      const inputHash =
        typeof replayInput?.inputHash === "string"
          ? replayInput.inputHash
          : null;
      const cohortKey = comparisonCohortKey({
        marketId,
        profileConfigId: v.profile_config_id,
        strategyVersion: v.strategy_version,
        executionModelVersion: v.execution_model_version,
        executionAssumptions: v.execution_assumptions,
        signalSemanticsVersion: null,
        replayScope: v.replay_scope,
        inputHash,
        windowHash,
      });
      if (!include(v.profile_id, cohortKey)) return [];
      return [
        {
          profileId: v.profile_id,
          profileName: v.name,
          outcomeId: v.outcome_id,
          realizedAt: v.exit_time?.toISOString() ?? null,
          setup: v.setup,
          pnl: v.net_pnl == null ? null : Number(v.net_pnl),
          rMultiple: v.r_multiple == null ? null : Number(v.r_multiple),
          holdMinutes: v.exit_time
            ? (v.exit_time.getTime() - v.entry_time.getTime()) / 60000
            : null,
          falsePositive: v.net_pnl != null && Number(v.net_pnl) <= 0,
          cohortKey,
        },
      ];
    });
  }

  async comparisonCohorts(
    profileIds: string[],
    source: "LIVE" | "PAPER" | "BACKTEST",
    start: string,
    end: string,
    timeStart: string,
    timeEnd: string,
    marketId: MarketId = "CA_TSX",
  ): Promise<ComparisonCohortRecord[]> {
    const timezone = marketSessionTimezone(marketId);
    const windowHash = comparisonWindowHash(
      marketId,
      start,
      end,
      timeStart,
      timeEnd,
    );
    if (source === "LIVE") {
      const result = await this.pool.query<{
        profile_id: string;
        profile_config_id: string;
        strategy_version: string;
        outcome_count: string;
      }>(
        `SELECT e.profile_id,p.current_config_id profile_config_id,d.version strategy_version,
                count(DISTINCT e.setup_instance_id)::text outcome_count
         FROM strategy_evaluation e
         JOIN scanner_profile p ON p.id=e.profile_id
         JOIN scanner_profile_config c ON c.id=p.current_config_id
         JOIN strategy_definition d ON d.id=p.strategy_definition_id
         WHERE e.profile_id=ANY($1::uuid[]) AND e.config_version=c.config_version AND e.strategy_version=d.version
           AND e.setup_instance_id IS NOT NULL
           AND e.timestamp >= ($2::date::timestamp AT TIME ZONE $7) AND e.timestamp < (($3::date + 1)::timestamp AT TIME ZONE $7)
           AND e.market_id=$6
           AND (e.timestamp AT TIME ZONE $7)::time BETWEEN $4::time AND $5::time
           AND (e.state='READY' OR (e.previous_state='READY' AND e.state='INVALIDATED'))
         GROUP BY e.profile_id,p.current_config_id,d.version`,
        [profileIds, start, end, timeStart, timeEnd, marketId, timezone],
      );
      return result.rows.map((row) => {
        const cohortKey = comparisonCohortKey({
          marketId,
          profileConfigId: row.profile_config_id,
          strategyVersion: row.strategy_version,
          executionModelVersion: null,
          executionAssumptions: null,
          signalSemanticsVersion: null,
          replayScope: null,
          inputHash: null,
          windowHash,
        });
        return {
          profileId: row.profile_id,
          cohortKey,
          marketId,
          windowHash,
          universeHash: null,
          featureVersion: null,
          executionModelVersion: null,
          executionAssumptionsHash: null,
          inputHash: null,
          coverageReportHash: null,
          coverageComplete: false,
          executionAssumptions: null,
          outcomeCount: Number(row.outcome_count),
        };
      });
    }

    if (source === "PAPER") {
      const result = await this.pool.query<{
        profile_id: string;
        profile_config_id: string;
        strategy_version: string;
        execution_model_version: string;
        execution_assumptions: unknown;
        signal_semantics_version: string | null;
        replay_scope: string | null;
        outcome_count: string;
      }>(
        `SELECT o.profile_id,o.profile_config_id,o.strategy_version,r.execution_model_version,
                r.assumptions execution_assumptions,
                o.source_event_payload->>'signalSemanticsVersion' signal_semantics_version,
                r.assumptions->>'evidenceScope' replay_scope,count(*)::text outcome_count
         FROM paper_execution x
         JOIN paper_signal_observation o ON o.id=x.observation_id
         JOIN paper_bot_run r ON r.id=o.run_id
         JOIN scanner_profile p ON p.id=o.profile_id
         JOIN scanner_profile_config c ON c.id=p.current_config_id
         JOIN strategy_definition d ON d.id=p.strategy_definition_id
         WHERE o.profile_id=ANY($1::uuid[]) AND o.profile_config_id=c.id
           AND o.strategy_key=d.strategy_key AND o.strategy_version=d.version
           AND r.source='LIVE' AND x.model='QUOTE' AND x.status='CLOSED'
           AND o.signal_timestamp >= ($2::date::timestamp AT TIME ZONE $7) AND o.signal_timestamp < (($3::date + 1)::timestamp AT TIME ZONE $7)
           AND r.market_id=$6
           AND (o.signal_timestamp AT TIME ZONE $7)::time BETWEEN $4::time AND $5::time
         GROUP BY o.profile_id,o.profile_config_id,o.strategy_version,r.execution_model_version,
                  r.assumptions,o.source_event_payload->>'signalSemanticsVersion',r.assumptions->>'evidenceScope'`,
        [profileIds, start, end, timeStart, timeEnd, marketId, timezone],
      );
      return result.rows.map((row) => {
        const cohortKey = comparisonCohortKey({
          marketId,
          profileConfigId: row.profile_config_id,
          strategyVersion: row.strategy_version,
          executionModelVersion: row.execution_model_version,
          executionAssumptions: row.execution_assumptions,
          signalSemanticsVersion: row.signal_semantics_version,
          replayScope: row.replay_scope,
          inputHash: null,
          windowHash,
        });
        return {
          profileId: row.profile_id,
          cohortKey,
          marketId,
          windowHash,
          universeHash: null,
          featureVersion: null,
          executionModelVersion: row.execution_model_version,
          executionAssumptionsHash: sha256(row.execution_assumptions),
          inputHash: null,
          coverageReportHash: null,
          coverageComplete: false,
          executionAssumptions: row.execution_assumptions,
          outcomeCount: Number(row.outcome_count),
        };
      });
    }

    const result = await this.pool.query<{
      profile_id: string;
      profile_config_id: string;
      strategy_version: string;
      execution_model_version: string | null;
      execution_assumptions: unknown | null;
      replay_input: unknown | null;
      evidence_binding: unknown;
      run_id: string;
      coverage_report: unknown;
      manifest: unknown;
      outcome_count: string;
    }>(
      `SELECT p.id profile_id,c.id profile_config_id,r.strategy_version,r.execution_model_version,
              r.execution_assumptions,r.replay_input,eb.binding AS evidence_binding,cr.report AS coverage_report,rm.manifest,min(r.id::text) AS run_id,count(*)::text outcome_count
       FROM (
         SELECT e.run_id,e.strategy_name,e.timestamp observed_at
         FROM backtest_state_event e
         WHERE e.state='READY' AND e.setup_instance_id IS NOT NULL
           AND e.timestamp >= ($2::date::timestamp AT TIME ZONE $7) AND e.timestamp < (($3::date + 1)::timestamp AT TIME ZONE $7)
           AND (e.timestamp AT TIME ZONE $7)::time BETWEEN $4::time AND $5::time
         UNION ALL
         SELECT t.run_id,t.strategy_name,t.entry_time observed_at
         FROM backtest_trade t
         WHERE t.setup_instance_id IS NOT NULL
           AND t.entry_time >= ($2::date::timestamp AT TIME ZONE $7) AND t.entry_time < (($3::date + 1)::timestamp AT TIME ZONE $7)
           AND (t.entry_time AT TIME ZONE $7)::time BETWEEN $4::time AND $5::time
       ) observed
       JOIN backtest_run r ON r.id=observed.run_id AND r.market_id=$6
       JOIN profile_config_evidence pe ON pe.backtest_run_id=r.id
         AND pe.strategy_key=observed.strategy_name AND pe.strategy_version=r.strategy_version
         AND pe.revoked_at IS NULL
       JOIN scanner_profile_config c ON c.id=pe.profile_config_id
       JOIN scanner_profile p ON p.current_config_id=c.id
       LEFT JOIN research_evidence_binding eb ON eb.owner_kind='BACKTEST' AND eb.owner_id=r.id AND eb.market_id=r.market_id AND eb.binding=r.research_evidence
       LEFT JOIN research_coverage_report cr ON cr.hash=eb.coverage_report_hash AND cr.market_id=eb.market_id AND cr.input_hash=eb.input_hash
       LEFT JOIN research_manifest rm ON rm.hash=eb.manifest_hash AND rm.market_id=eb.market_id
       WHERE p.id=ANY($1::uuid[])
       GROUP BY p.id,c.id,r.strategy_version,r.execution_model_version,r.execution_assumptions,r.replay_input,eb.binding,cr.report,rm.manifest`,
      [profileIds, start, end, timeStart, timeEnd, marketId, timezone],
    );
    return result.rows.map((row) => {
      const binding = researchEvidenceBindingSchema.safeParse(
        row.evidence_binding,
      );
      const coverage = researchCoverageReportSchema.safeParse(
        row.coverage_report,
      );
      let proven = false;
      if (binding.success && coverage.success && row.manifest) {
        try {
          assertEvidenceBinding(
            { kind: "BACKTEST", id: row.run_id, marketId },
            coverage.data,
            binding.data,
          );
          proven = true;
        } catch {
          /* Missing/conflicting historical proof stays unavailable. */
        }
      }
      const manifest = row.manifest as {
        plan?: { featureVersion?: unknown };
      } | null;
      const featureVersion =
        proven && typeof manifest?.plan?.featureVersion === "string"
          ? manifest.plan.featureVersion
          : null;

      const replayInput =
        row.replay_input && typeof row.replay_input === "object"
          ? (row.replay_input as { inputHash?: unknown })
          : undefined;
      const inputHash =
        proven && binding.success
          ? binding.data.inputHash
          : typeof replayInput?.inputHash === "string"
            ? replayInput.inputHash
            : null;
      const replayScope =
        row.execution_assumptions &&
        typeof row.execution_assumptions === "object"
          ? ((row.execution_assumptions as { evidenceScope?: string })
              .evidenceScope ?? null)
          : null;
      const cohortKey = comparisonCohortKey({
        marketId,
        profileConfigId: row.profile_config_id,
        strategyVersion: row.strategy_version,
        executionModelVersion: row.execution_model_version,
        executionAssumptions: row.execution_assumptions,
        signalSemanticsVersion: null,
        replayScope,
        inputHash,
        windowHash,
      });
      return {
        profileId: row.profile_id,
        cohortKey,
        marketId,
        windowHash,
        universeHash: null,
        featureVersion,
        executionModelVersion: row.execution_model_version,
        executionAssumptionsHash: row.execution_assumptions
          ? sha256(row.execution_assumptions)
          : null,
        inputHash,
        coverageReportHash:
          proven && binding.success ? binding.data.coverageReportHash : null,
        coverageComplete: proven,
        executionAssumptions: row.execution_assumptions,
        outcomeCount: Number(row.outcome_count),
      };
    });
  }

  async comparisonScopes(
    profileIds: string[],
    source: "LIVE" | "PAPER" | "BACKTEST",
    start: string,
    end: string,
    timeStart: string,
    timeEnd: string,
    marketId: MarketId = "CA_TSX",
    cohortKeys?: ComparisonCohortSelection,
  ): Promise<ComparisonScope[]> {
    const windowHash = comparisonWindowHash(
      marketId,
      start,
      end,
      timeStart,
      timeEnd,
    );
    const cohorts = await this.comparisonCohorts(
      profileIds,
      source,
      start,
      end,
      timeStart,
      timeEnd,
      marketId,
    );
    return profileIds.map((profileId) => {
      const candidates = cohorts.filter(
        (value) => value.profileId === profileId,
      );
      const chosen = cohortKeys?.[profileId]
        ? candidates.find((value) => value.cohortKey === cohortKeys[profileId])
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      return chosen
        ? {
            profileId: chosen.profileId,
            marketId: chosen.marketId,
            windowHash: chosen.windowHash,
            universeHash: chosen.universeHash,
            featureVersion: chosen.featureVersion,
            executionModelVersion: chosen.executionModelVersion,
            executionAssumptionsHash: chosen.executionAssumptionsHash,
            inputHash: chosen.inputHash,
            coverageReportHash: chosen.coverageReportHash,
            coverageComplete: chosen.coverageComplete,
          }
        : {
            profileId,
            marketId,
            windowHash,
            universeHash: null,
            featureVersion: null,
            executionModelVersion: null,
            executionAssumptionsHash: null,
            inputHash: null,
            coverageReportHash: null,
            coverageComplete: false,
          };
    });
  }
}
