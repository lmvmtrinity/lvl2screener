import {
  calibrationRunSchema,
  createCalibrationSchema,
  type CalibrationRun,
  type CalibrationTrial,
  type CalibrationSelection,
  type CapturedHistoryAvailability,
  type CreateCalibration,
  type ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { PostgresResearchEvidenceStore } from "../backtests/research-evidence-repository.js";
import type { MarketId } from "@tsx-scanner/contracts";
import {
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  authoritativeExecutionAssumptions,
} from "../backtests/execution-provenance.js";

type Row = {
  id: string;
  market_id: MarketId;
  name: string;
  status: string;
  start_date: string | Date;
  end_date: string | Date;
  strategy_name: string;
  symbols: unknown;
  data_source: string;
  execution_model_version: string | null;
  execution_assumptions: unknown;
  input: unknown;
  captured_history_availability: unknown;
  combinations_tested: number;
  total_combinations: number;
  truncated: boolean;
  split_dates: unknown;
  recommendation: string;
  recommended_config: unknown;
  trials: unknown;
  holdout_selection: unknown;
  research_evidence: unknown;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};
const columns =
  "id,market_id,name,status,start_date,end_date,strategy_name,symbols,data_source,execution_model_version,execution_assumptions,input,captured_history_availability,combinations_tested,total_combinations,truncated,split_dates,recommendation,recommended_config,trials,holdout_selection,research_evidence,error,created_at,started_at,completed_at";

export interface CalibrationStore {
  getForJob(
    researchJobId: string,
    input: CreateCalibration,
  ): Promise<CalibrationRun | undefined>;
  create(
    input: CreateCalibration,
    total: number,
    truncated: boolean,
    capturedHistoryAvailability: CapturedHistoryAvailability,
    researchJobId?: string,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<CalibrationRun>;
  markRunning(id: string): Promise<boolean>;
  freezeSelection(
    id: string,
    selection: CalibrationSelection,
    trials: CalibrationTrial[],
    splitDates: { trainEnd: string; validationEnd: string },
  ): Promise<void>;
  complete(
    id: string,
    value: {
      trials: CalibrationTrial[];
      splitDates: { trainEnd: string; validationEnd: string };
      recommendation: string;
      recommendedConfig: CalibrationTrial["parameters"] | null;
      combinationsTested: number;
    },
  ): Promise<CalibrationRun>;
  fail(id: string, error: string): Promise<void>;
  list(limit?: number): Promise<CalibrationRun[]>;
  get(id: string): Promise<CalibrationRun | undefined>;
}

export class PostgresCalibrationStore implements CalibrationStore {
  constructor(private readonly pool: Pool) {}
  async getForJob(
    researchJobId: string,
    input: CreateCalibration,
  ): Promise<CalibrationRun | undefined> {
    const result = await this.pool.query<Row & { matching_input: boolean }>(
      `SELECT ${columns},input=$2::jsonb AS matching_input FROM calibration_run WHERE research_job_id=$1`,
      [researchJobId, JSON.stringify(input)],
    );
    if (!result.rows[0]) return undefined;
    if (!result.rows[0].matching_input)
      throw new Error("Conflicting calibration job retry");
    return map(result.rows[0]);
  }
  async create(
    input: CreateCalibration,
    total: number,
    truncated: boolean,
    capturedHistoryAvailability: CapturedHistoryAvailability,
    researchJobId?: string,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<CalibrationRun> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<Row>(
        `INSERT INTO calibration_run(market_id,name,status,start_date,end_date,strategy_name,symbols,data_source,
       execution_model_version,execution_assumptions,input,total_combinations,truncated,captured_history_availability,research_job_id,research_evidence)
       VALUES($1,$2,'PENDING',$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,$15::jsonb)
       ON CONFLICT(research_job_id) DO NOTHING
       RETURNING ${columns}`,
        [
          input.marketId,
          input.name,
          input.startDate,
          input.endDate,
          input.strategy,
          JSON.stringify(input.symbols),
          input.dataSource,
          AUTHORITATIVE_EXECUTION_MODEL_VERSION,
          JSON.stringify({
            ...authoritativeExecutionAssumptions(input),
            atrStopMultiple: input.atrStopMultiple,
            calibrationGrid: input.grid,
          }),
          JSON.stringify(input),
          total,
          truncated,
          JSON.stringify(capturedHistoryAvailability),
          researchJobId ?? null,
          researchEvidence ? JSON.stringify(researchEvidence) : null,
        ],
      );
      if (r.rows[0]) {
        if (researchEvidence)
          await new PostgresResearchEvidenceStore(this.pool).bindWithClient(
            client,
            { kind: "CALIBRATION", id: r.rows[0].id, marketId: input.marketId },
            researchEvidence,
          );
        await client.query("COMMIT");
        return map(r.rows[0]);
      }
      const existing = await client.query<Row>(
        `SELECT ${columns} FROM calibration_run WHERE research_job_id=$1 AND input=$2::jsonb`,
        [researchJobId, JSON.stringify(input)],
      );
      if (!existing.rows[0])
        throw new Error("Conflicting calibration job retry");
      await client.query("COMMIT");
      return map(existing.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async markRunning(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE calibration_run SET status='RUNNING',started_at=now(),error=null WHERE id=$1 AND status='PENDING' RETURNING id",
      [id],
    );
    return result.rows.length === 1;
  }
  async freezeSelection(
    id: string,
    selection: CalibrationSelection,
    trials: CalibrationTrial[],
    splitDates: { trainEnd: string; validationEnd: string },
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE calibration_run SET holdout_selection=$2::jsonb,trials=$3::jsonb,
       split_dates=$4::jsonb,combinations_tested=$5
       WHERE id=$1 AND status='RUNNING' AND holdout_selection IS NULL RETURNING id`,
      [
        id,
        JSON.stringify(selection),
        JSON.stringify(trials),
        JSON.stringify(splitDates),
        trials.length,
      ],
    );
    if (!result.rows.length)
      throw new Error("Calibration selection already frozen or run not active");
  }
  async complete(
    id: string,
    value: {
      trials: CalibrationTrial[];
      splitDates: { trainEnd: string; validationEnd: string };
      recommendation: string;
      recommendedConfig: CalibrationTrial["parameters"] | null;
      combinationsTested: number;
    },
  ): Promise<CalibrationRun> {
    const result = await this.pool.query(
      "UPDATE calibration_run SET status='COMPLETED',trials=$2::jsonb,split_dates=$3::jsonb,recommendation=$4,recommended_config=$5::jsonb,combinations_tested=$6,completed_at=now() WHERE id=$1 AND status='RUNNING' AND holdout_selection IS NOT NULL RETURNING id",
      [
        id,
        JSON.stringify(value.trials),
        JSON.stringify(value.splitDates),
        value.recommendation,
        JSON.stringify(value.recommendedConfig),
        value.combinationsTested,
      ],
    );
    if (!result.rows.length)
      throw new Error(
        "Calibration completion requires an active frozen selection",
      );
    return (await this.get(id))!;
  }
  async fail(id: string, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE calibration_run SET status='FAILED',error=$2,completed_at=now() WHERE id=$1 AND status='RUNNING'",
      [id, error.slice(0, 5000)],
    );
  }
  async list(limit = 50): Promise<CalibrationRun[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${columns} FROM calibration_run ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map(map);
  }
  async get(id: string): Promise<CalibrationRun | undefined> {
    const r = await this.pool.query<Row>(
      `SELECT ${columns} FROM calibration_run WHERE id=$1`,
      [id],
    );
    return r.rows[0] ? map(r.rows[0]) : undefined;
  }
}

function map(row: Row): CalibrationRun {
  return calibrationRunSchema.parse({
    id: row.id,
    marketId: row.market_id,
    name: row.name,
    status: row.status,
    startDate: date(row.start_date),
    endDate: date(row.end_date),
    strategy: row.strategy_name,
    symbols: row.symbols,
    dataSource: row.data_source,
    executionModelVersion: row.execution_model_version,
    executionAssumptions: row.execution_assumptions,
    input: createCalibrationSchema.parse(row.input),
    capturedHistoryAvailability: row.captured_history_availability,
    combinationsTested: row.combinations_tested,
    totalCombinations: row.total_combinations,
    truncated: row.truncated,
    splitDates: row.split_dates,
    recommendation: row.recommendation,
    recommendedConfig: row.recommended_config,
    trials: row.trials,
    holdoutSelection: row.holdout_selection,
    researchEvidence: row.research_evidence ?? null,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}
function date(value: string | Date): string {
  return typeof value === "string"
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}
