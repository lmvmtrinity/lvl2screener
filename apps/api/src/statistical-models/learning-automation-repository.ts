import type { Pool } from "pg";
import {
  learningAutomationRunSchema,
  type LearningAutomationRun,
} from "@tsx-scanner/contracts";

export interface RecordLearningAutomationRunInput {
  schedulerVersion: string;
  policyVersion: string;
  startedAt: Date;
  completedAt: Date;
  state: "SUCCESS" | "NOOP" | "FAILED";
  cohortsExamined: unknown[];
  noopReason?: string | null;
  createdDatasetId?: string | null;
  createdJobId?: string | null;
  error?: string | null;
}

export interface LearningAutomationStore {
  recordRun(input: RecordLearningAutomationRunInput): Promise<void>;
  listRuns(limit?: number): Promise<LearningAutomationRun[]>;
  latestRun(): Promise<LearningAutomationRun | undefined>;
}

export class PostgresLearningAutomationStore implements LearningAutomationStore {
  constructor(private readonly pool: Pool) {}

  async recordRun(input: RecordLearningAutomationRunInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO learning_automation_run (
        scheduler_version, policy_version, started_at, completed_at,
        state, cohorts_examined, noop_reason, created_dataset_id, created_job_id, error
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
      [
        input.schedulerVersion,
        input.policyVersion,
        input.startedAt,
        input.completedAt,
        input.state,
        JSON.stringify(input.cohortsExamined),
        input.noopReason ?? null,
        input.createdDatasetId ?? null,
        input.createdJobId ?? null,
        input.error ?? null,
      ],
    );
  }

  async listRuns(limit = 50): Promise<LearningAutomationRun[]> {
    const result = await this.pool.query(
      `SELECT id, scheduler_version AS "schedulerVersion", policy_version AS "policyVersion",
              started_at AS "startedAt", completed_at AS "completedAt", state,
              cohorts_examined AS "cohortsExamined", noop_reason AS "noopReason",
              created_dataset_id AS "createdDatasetId", created_job_id AS "createdJobId",
              error, created_at AS "createdAt"
         FROM learning_automation_run
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRun);
  }

  async latestRun(): Promise<LearningAutomationRun | undefined> {
    const result = await this.pool.query(
      `SELECT id, scheduler_version AS "schedulerVersion", policy_version AS "policyVersion",
              started_at AS "startedAt", completed_at AS "completedAt", state,
              cohorts_examined AS "cohortsExamined", noop_reason AS "noopReason",
              created_dataset_id AS "createdDatasetId", created_job_id AS "createdJobId",
              error, created_at AS "createdAt"
         FROM learning_automation_run
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }
}

function mapRun(row: Record<string, unknown>): LearningAutomationRun {
  return learningAutomationRunSchema.parse({
    ...row,
    startedAt:
      row.startedAt instanceof Date
        ? row.startedAt.toISOString()
        : String(row.startedAt),
    completedAt:
      row.completedAt instanceof Date
        ? row.completedAt.toISOString()
        : String(row.completedAt),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
  });
}
