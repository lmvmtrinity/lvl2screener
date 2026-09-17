import type { Pool } from "pg";

/** W2: operator-facing view of `prune_retention_history()` runs (see
 *  database/init/028-retention-correction.sql). Backs both `/metrics`
 *  (`scanner_retention_*`) and the operator-triggered `/api/system/retention/run` endpoint, so
 *  a failed or skipped retention run is visible without a database console. */
export interface RetentionTableResult {
  table: string;
  rowsDeleted: number;
  error: string | null;
}

export interface RetentionRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED_CONCURRENT";
  tableResults: RetentionTableResult[];
  error: string | null;
}

interface RetentionRunRow {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  status: RetentionRunSummary["status"];
  table_results: RetentionTableResult[];
  error: string | null;
}

function toSummary(row: RetentionRunRow): RetentionRunSummary {
  return {
    id: row.id,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    status: row.status,
    tableResults: row.table_results,
    error: row.error,
  };
}

export interface RetentionService {
  /** Invokes `prune_retention_history()` and returns its logged run. Intended for an operator
   *  explicitly triggering a run (or a manually invoked scheduled job) -- see the "opt-in
   *  scheduling" note in the corrective migration for why this is never called automatically
   *  by API startup. */
  runNow(): Promise<RetentionRunSummary>;
  /** The most recent retention run of any status, or null if none has ever run on this
   *  database (e.g. a fresh install, or before an operator has opted in). */
  getLatestRun(): Promise<RetentionRunSummary | null>;
}

export class PostgresRetentionService implements RetentionService {
  constructor(private readonly pool: Pool) {}

  async runNow(): Promise<RetentionRunSummary> {
    await this.pool.query("SELECT * FROM prune_retention_history()");
    const latest = await this.getLatestRun();
    if (!latest)
      throw new Error(
        "prune_retention_history() ran but left no retention_job_run row.",
      );
    return latest;
  }

  async getLatestRun(): Promise<RetentionRunSummary | null> {
    const result = await this.pool.query<RetentionRunRow>(
      `SELECT id, started_at, finished_at, status, table_results, error
       FROM retention_job_run
       ORDER BY started_at DESC
       LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? toSummary(row) : null;
  }
}
