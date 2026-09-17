import type { Pool } from "pg";

/**
 * Backtests, calibrations, ranking studies, and statistical training all persist `RUNNING` (or
 * `TRAINING`) before doing synchronous work, then update to a terminal status when that work
 * finishes. A process restart mid-run leaves the row permanently stuck in that in-progress status
 * — the API never sees it again, so nothing ever completes or fails it.
 *
 * W8 replaced the HTTP-request-holds-the-connection-open execution model with a durable
 * research_job queue (lease/heartbeat/cancellation, see research-jobs/research-job-repository.ts
 * and worker.ts) — but it deliberately did NOT change what these four *_run/*_model tables'
 * synchronous creation code does internally: BacktestJobHandler still calls the same
 * store.markRunning(...)/store.complete(...)/store.fail(...) sequence, and the other three job
 * types still run their existing CalibrationService/RankingResearchService/
 * StatisticalModelService.create() synchronously inside one job attempt (see
 * worker/handlers/synchronous-job-handler.ts). So a worker process crashing mid-run can still
 * leave one of these rows stuck RUNNING/TRAINING, exactly as an API crash could before W8 — the
 * crash is now detected and retried/interrupted at the *job* level (research_job's lease expires
 * and reapExpiredLeases() requeues or marks it INTERRUPTED), but the *_run row the crashed
 * attempt already created is orphaned independently of that. This boot-time sweep remains the
 * fallback that reconciles those rows to INTERRUPTED so they don't show as forever-running in the
 * UI; it is a complement to W8's lease reaping; it does not need to run for research_job rows
 * themselves, which are already reaped continuously (not just at boot) by the worker.
 */
const ORPHANED_RESEARCH_TARGETS: readonly {
  table: string;
  statuses: readonly string[];
}[] = [
  { table: "backtest_run", statuses: ["RUNNING"] },
  { table: "calibration_run", statuses: ["RUNNING"] },
  { table: "statistical_model", statuses: ["TRAINING"] },
  { table: "ranking_research_run", statuses: ["RUNNING"] },
];

export interface ReconciledResearchTable {
  table: string;
  interruptedCount: number;
}

export async function reconcileOrphanedResearch(
  pool: Pool,
): Promise<ReconciledResearchTable[]> {
  const results: ReconciledResearchTable[] = [];
  for (const target of ORPHANED_RESEARCH_TARGETS) {
    const result = await pool.query(
      `UPDATE ${target.table}
       SET status = 'INTERRUPTED',
           error = COALESCE(error, 'Interrupted by an API restart while status was ' || status),
           completed_at = COALESCE(completed_at, NOW())
       WHERE status = ANY($1::text[])`,
      [target.statuses],
    );
    results.push({
      table: target.table,
      interruptedCount: result.rowCount ?? 0,
    });
  }
  return results;
}
