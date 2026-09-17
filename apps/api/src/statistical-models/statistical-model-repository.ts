import {
  statisticalModelSchema,
  challengerScopeSchema,
  type CreateStatisticalModel,
  type StatisticalModel,
  type StatisticalTrainingResult,
  type ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, contentHash } from "../backtests/research-coverage.js";
import { PostgresResearchEvidenceStore } from "../backtests/research-evidence-repository.js";

type Row = {
  id: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  name: string;
  status: string;
  model_type: string;
  model_version: string;
  source_kind: "BACKTEST_RUN" | "PAPER_EVIDENCE";
  backtest_run_id: string | null;
  training_dataset_id: string | null;
  strategy_name: string;
  input: unknown;
  artifact: unknown;
  train_metrics: unknown;
  test_metrics: unknown;
  calibration: unknown;
  eligible_for_activation: boolean;
  active: boolean;
  warnings: unknown;
  error: string | null;
  training_start: Date | null;
  training_end: Date | null;
  test_start: Date | null;
  test_end: Date | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  research_evidence: unknown;
};
const columns =
  "id,market_id,name,status,model_type,model_version,source_kind,backtest_run_id,training_dataset_id,strategy_name,input,artifact,train_metrics,test_metrics,calibration,eligible_for_activation,active,warnings,error,training_start,training_end,test_start,test_end,research_evidence,created_at,started_at,completed_at";

export interface StatisticalModelStore {
  create(input: CreateStatisticalModel): Promise<StatisticalModel>;
  markTraining(id: string): Promise<void>;
  complete(
    id: string,
    result: StatisticalTrainingResult,
    version: string,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<StatisticalModel>;
  fail(id: string, error: string): Promise<void>;
  list(limit?: number): Promise<StatisticalModel[]>;
  listActive(): Promise<StatisticalModel[]>;
  get(id: string): Promise<StatisticalModel | undefined>;
  activate(id: string, strategy: string): Promise<StatisticalModel>;
  deactivate(id: string): Promise<StatisticalModel>;
}

export class PostgresStatisticalModelStore implements StatisticalModelStore {
  constructor(private readonly pool: Pool) {}
  async create(input: CreateStatisticalModel): Promise<StatisticalModel> {
    const isPaperEvidence = input.sourceKind === "PAPER_EVIDENCE";
    const result = await this.pool.query<Row>(
      `INSERT INTO statistical_model(market_id,name,status,model_type,model_version,source_kind,backtest_run_id,training_dataset_id,strategy_name,input)
       VALUES(COALESCE((SELECT market_id FROM statistical_training_dataset WHERE id=$4),
                       (SELECT market_id FROM backtest_run WHERE id=$3)),
              $1,'PENDING','LOGISTIC_SETUP_QUALITY','pending',$2,$3,$4,$5,$6::jsonb) RETURNING ${columns}`,
      [
        input.name,
        isPaperEvidence ? "PAPER_EVIDENCE" : "BACKTEST_RUN",
        isPaperEvidence ? null : input.backtestRunId,
        isPaperEvidence ? input.trainingDatasetId : null,
        input.strategy,
        JSON.stringify(input),
      ],
    );
    return map(result.rows[0]!);
  }
  async markTraining(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE statistical_model SET status='TRAINING',started_at=now(),error=null WHERE id=$1",
      [id],
    );
  }
  async complete(
    id: string,
    result: StatisticalTrainingResult,
    version: string,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<StatisticalModel> {
    const client = await this.pool.connect();
    let model: StatisticalModel;
    try {
      await client.query("BEGIN");
      const value = await client.query<Row>(
        `UPDATE statistical_model SET status=$2,model_version=$3,artifact=$4::jsonb,train_metrics=$5::jsonb,test_metrics=$6::jsonb,calibration=$7::jsonb,eligible_for_activation=$8,warnings=$9::jsonb,training_start=$10,training_end=$11,test_start=$12,test_end=$13,completed_at=clock_timestamp(),research_evidence=COALESCE($14::jsonb,research_evidence) WHERE id=$1 RETURNING ${columns}`,
        [
          id,
          result.status,
          version,
          JSON.stringify(result.artifact),
          JSON.stringify(result.train),
          JSON.stringify(result.test),
          JSON.stringify(result.calibration),
          result.eligibleForActivation,
          JSON.stringify(result.warnings),
          result.trainingStart,
          result.trainingEnd,
          result.testStart,
          result.testEnd,
          researchEvidence ? JSON.stringify(researchEvidence) : null,
        ],
      );
      const row = value.rows[0];
      if (!row) throw new Error("STATISTICAL_MODEL_NOT_FOUND");
      if (researchEvidence)
        await new PostgresResearchEvidenceStore(this.pool).bindWithClient(
          client,
          { kind: "MODEL", id, marketId: row.market_id },
          researchEvidence,
        );
      await this.persistModelScope(client, id, result.artifact);
      model = map(row);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return model;
  }
  async fail(id: string, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE statistical_model SET status='FAILED',active=false,error=$2,completed_at=now() WHERE id=$1",
      [id, error.slice(0, 5000)],
    );
  }
  async list(limit = 50): Promise<StatisticalModel[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${columns} FROM statistical_model ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(map);
  }
  async listActive(): Promise<StatisticalModel[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${columns} FROM statistical_model WHERE active=true ORDER BY strategy_name`,
    );
    return result.rows.map(map);
  }
  async get(id: string): Promise<StatisticalModel | undefined> {
    const result = await this.pool.query<Row>(
      `SELECT ${columns} FROM statistical_model WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }
  async activate(id: string, strategy: string): Promise<StatisticalModel> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `WITH target AS (
           SELECT m.market_id,d.cohort
             FROM statistical_model m
             JOIN statistical_training_dataset d ON d.id=m.training_dataset_id
            WHERE m.id=$1
         )
         UPDATE statistical_model m
            SET active=false
          WHERE m.strategy_name=$2 AND m.active=true
            AND m.market_id=(SELECT market_id FROM target)
            AND (
              NOT EXISTS (SELECT 1 FROM target)
              OR m.training_dataset_id IN (
                SELECT d.id FROM statistical_training_dataset d,target
                 WHERE d.cohort=target.cohort
              )
            )`,
        [id, strategy],
      );
      const result = await client.query<Row>(
        `UPDATE statistical_model SET active=true WHERE id=$1 RETURNING ${columns}`,
        [id],
      );
      await client.query("COMMIT");
      return map(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async deactivate(id: string): Promise<StatisticalModel> {
    const result = await this.pool.query<Row>(
      `UPDATE statistical_model SET active=false WHERE id=$1 RETURNING ${columns}`,
      [id],
    );
    return map(result.rows[0]!);
  }

  private async persistModelScope(
    client: PoolClient,
    modelId: string,
    artifact: unknown,
  ): Promise<void> {
    const source = await client.query<{
      market_id: "CA_TSX" | "US_EQUITIES";
      strategy_name: string;
      cohort: unknown;
      parameters: unknown;
      source_kind: string;
      source_id: string;
      source_digest: string | null;
      qualified: boolean;
      label_cutoff: Date | null;
    }>(
      `SELECT m.market_id,m.strategy_name,d.cohort,b.parameters,m.source_kind,
          COALESCE(d.id,b.id) AS source_id,d.source_digest,
          COALESCE((d.research_qualification->>'qualified')::boolean,false) AS qualified,
          (SELECT CASE WHEN count(*)>0 AND bool_and(normalized_row->>'labelAvailableAt' IS NOT NULL)
             THEN max((normalized_row->>'labelAvailableAt')::timestamptz) ELSE NULL END
           FROM statistical_training_dataset_member WHERE dataset_id=d.id) AS label_cutoff
        FROM statistical_model m
        LEFT JOIN statistical_training_dataset d ON d.id=m.training_dataset_id
        LEFT JOIN backtest_run b ON b.id=m.backtest_run_id WHERE m.id=$1`,
      [modelId],
    );
    const row = source.rows[0];
    // Missing historical source proofs stay unavailable. Never infer a scope
    // or a label-availability time from the current profile or exit clock.
    if (
      !row ||
      !row.qualified ||
      !row.source_digest ||
      !row.label_cutoff ||
      !artifact
    )
      return;
    const raw = row.cohort as Record<string, unknown> | null;
    if (!raw || typeof raw.assumptions !== "object" || raw.assumptions === null)
      return;
    const scope = challengerScopeSchema.safeParse({
      marketId: row.market_id,
      currency: row.market_id === "CA_TSX" ? "CAD" : "USD",
      strategy: row.strategy_name,
      strategyVersion: raw.strategyVersion,
      profileConfigId: raw.profileConfigId,
      configVersion: raw.configVersion,
      executionModelVersion: raw.executionModelVersion,
      executionAssumptionsHash: contentHash(raw.assumptions),
      signalSemanticsVersion: raw.signalSemanticsVersion,
      replayScope: raw.replayScope,
    });
    if (
      !scope.success ||
      scope.data.signalSemanticsVersion === "UNKNOWN" ||
      scope.data.replayScope === "UNKNOWN"
    )
      return;
    const hash = contentHash(scope.data);
    await client.query(
      `INSERT INTO challenger_model_scope(model_id,scope_hash,scope,source_kind,source_id,source_digest,artifact_hash,training_label_cutoff_at)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8) ON CONFLICT(model_id) DO NOTHING`,
      [
        modelId,
        hash,
        JSON.stringify(scope.data),
        row.source_kind,
        row.source_id,
        row.source_digest,
        contentHash(artifact),
        row.label_cutoff,
      ],
    );
    const saved = await client.query<{
      scope_hash: string;
      scope: unknown;
      artifact_hash: string;
    }>(
      "SELECT scope_hash,scope,artifact_hash FROM challenger_model_scope WHERE model_id=$1",
      [modelId],
    );
    if (
      !saved.rows[0] ||
      saved.rows[0].scope_hash !== hash ||
      canonicalJson(saved.rows[0].scope) !== canonicalJson(scope.data) ||
      saved.rows[0].artifact_hash !== contentHash(artifact)
    )
      throw new Error("MODEL_SCOPE_CONFLICT");
  }
}

function map(row: Row): StatisticalModel {
  return statisticalModelSchema.parse({
    id: row.id,
    marketId: row.market_id,
    name: row.name,
    status: row.status,
    modelType: row.model_type,
    modelVersion: row.model_version,
    sourceKind: row.source_kind,
    backtestRunId: row.backtest_run_id,
    trainingDatasetId: row.training_dataset_id,
    strategy: row.strategy_name,
    input: row.input,
    artifact: row.artifact,
    trainMetrics: row.train_metrics,
    testMetrics: row.test_metrics,
    calibration: row.calibration,
    eligibleForActivation: row.eligible_for_activation,
    active: row.active,
    warnings: row.warnings,
    error: row.error,
    trainingStart: iso(row.training_start),
    trainingEnd: iso(row.training_end),
    testStart: iso(row.test_start),
    testEnd: iso(row.test_end),
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    researchEvidence: row.research_evidence ?? null,
  });
}
const iso = (value: Date | null) => value?.toISOString() ?? null;
