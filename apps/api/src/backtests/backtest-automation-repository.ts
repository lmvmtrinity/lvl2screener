import {
  backtestAutomationWorkIdentitySchema,
  type BacktestAutomationAuthorizationScope,
  type BacktestAutomationBlockerReason,
  type BacktestAutomationCycleOutcome,
  type BacktestAutomationJobProgress,
  type BacktestAutomationStageKey,
  type BacktestAutomationStageState,
  type BacktestAutomationTriggerOrigin,
  type BacktestAutomationWorkState,
  type MarketId,
  type ResearchJobErrorCategory,
  type ResearchJobStatus,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type {
  BacktestAutomationControlRecord,
  BacktestAutomationCycleRecord,
  BacktestAutomationJobSnapshot,
  BacktestAutomationStageRecord,
  BacktestAutomationStore,
  BacktestAutomationWorkRecord,
} from "./backtest-automation.js";

interface ControlRow {
  market_id: MarketId;
  enabled: boolean;
  cadence: "DAILY_POST_SESSION";
  max_outstanding: number;
  updated_at: Date;
}

interface WorkRow {
  work_key: string;
  market_id: MarketId;
  identity: unknown;
  state: BacktestAutomationWorkState;
  trigger_origin: BacktestAutomationTriggerOrigin;
  attempt_key: string;
  input_fingerprint: string;
  dispatched_fingerprint: string | null;
  consumed_fingerprint: string | null;
  blocker_reason: BacktestAutomationBlockerReason | null;
  job_id: string | null;
  run_id: string | null;
  retry_count: number;
  next_attempt_at: Date | null;
  failure_message: string | null;
  last_dispatched_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  waiting_since: Date | null;
  updated_at: Date;
}

interface CycleRow {
  cycle_id: string;
  market_id: MarketId;
  trigger_origin: BacktestAutomationTriggerOrigin;
  outcome: BacktestAutomationCycleOutcome;
  evaluated: number;
  dispatched: number;
  coalesced: number;
  blocked: number;
  retried: number;
  succeeded: number;
  failed: number;
  changes: unknown;
  started_at: Date;
  finished_at: Date | null;
}

interface StageRow {
  stage_key: BacktestAutomationStageKey;
  work_key: string;
  market_id: MarketId;
  state: BacktestAutomationStageState;
  authorization_scope: BacktestAutomationAuthorizationScope;
  input_identity_hash: string | null;
  reason_codes: unknown;
  job_id: string | null;
  retry_count: number;
  next_attempt_at: Date | null;
  failure_message: string | null;
  last_evaluated_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

const workColumns = `work_key,market_id,identity,state,trigger_origin,attempt_key,input_fingerprint,
  dispatched_fingerprint,consumed_fingerprint,blocker_reason,job_id,run_id,retry_count,next_attempt_at,failure_message,
  last_dispatched_at,last_success_at,last_failure_at,waiting_since,updated_at`;

const stageColumns = `stage_key,work_key,market_id,state,authorization_scope,input_identity_hash,
  reason_codes,job_id,retry_count,next_attempt_at,failure_message,last_evaluated_at,completed_at,updated_at`;

/** Durable A1 automation state. Writes are single-row upserts stamped by the
 * caller's clock so scheduling semantics stay testable; job idempotency keys
 * remain the guard against duplicate dispatches. */
export class PostgresBacktestAutomationStore implements BacktestAutomationStore {
  constructor(private readonly pool: Pool) {}

  async getControl(
    marketId: MarketId,
  ): Promise<BacktestAutomationControlRecord | undefined> {
    const result = await this.pool.query<ControlRow>(
      `SELECT market_id,enabled,cadence,max_outstanding,updated_at
         FROM backtest_automation_control WHERE market_id=$1`,
      [marketId],
    );
    const row = result.rows[0];
    return row
      ? {
          marketId: row.market_id,
          enabled: row.enabled,
          cadence: row.cadence,
          maxOutstanding: row.max_outstanding,
          updatedAt: row.updated_at.toISOString(),
        }
      : undefined;
  }

  async upsertControl(control: BacktestAutomationControlRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_automation_control(market_id,enabled,cadence,max_outstanding,updated_at)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(market_id) DO UPDATE SET
         enabled=EXCLUDED.enabled, cadence=EXCLUDED.cadence,
         max_outstanding=EXCLUDED.max_outstanding, updated_at=EXCLUDED.updated_at`,
      [
        control.marketId,
        control.enabled,
        control.cadence,
        control.maxOutstanding,
        control.updatedAt,
      ],
    );
  }

  async getWork(
    workKey: string,
  ): Promise<BacktestAutomationWorkRecord | undefined> {
    const result = await this.pool.query<WorkRow>(
      `SELECT ${workColumns} FROM backtest_automation_work WHERE work_key=$1`,
      [workKey],
    );
    const row = result.rows[0];
    return row ? mapWork(row) : undefined;
  }

  async listWork(marketId: MarketId): Promise<BacktestAutomationWorkRecord[]> {
    const result = await this.pool.query<WorkRow>(
      `SELECT ${workColumns} FROM backtest_automation_work
        WHERE market_id=$1 ORDER BY updated_at DESC`,
      [marketId],
    );
    return result.rows.map(mapWork);
  }

  async saveWork(record: BacktestAutomationWorkRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_automation_work
         (work_key,market_id,kind,config_id,config_version,strategy_key,identity,
          state,trigger_origin,attempt_key,input_fingerprint,dispatched_fingerprint,consumed_fingerprint,
          blocker_reason,job_id,run_id,retry_count,next_attempt_at,failure_message,
          last_dispatched_at,last_success_at,last_failure_at,waiting_since,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT(work_key) DO UPDATE SET
         state=EXCLUDED.state,
         trigger_origin=EXCLUDED.trigger_origin,
         attempt_key=EXCLUDED.attempt_key,
         input_fingerprint=EXCLUDED.input_fingerprint,
         dispatched_fingerprint=EXCLUDED.dispatched_fingerprint,
         consumed_fingerprint=EXCLUDED.consumed_fingerprint,
         blocker_reason=EXCLUDED.blocker_reason,
         job_id=EXCLUDED.job_id,
         run_id=EXCLUDED.run_id,
         retry_count=EXCLUDED.retry_count,
         next_attempt_at=EXCLUDED.next_attempt_at,
         failure_message=EXCLUDED.failure_message,
         last_dispatched_at=EXCLUDED.last_dispatched_at,
         last_success_at=EXCLUDED.last_success_at,
         last_failure_at=EXCLUDED.last_failure_at,
         waiting_since=EXCLUDED.waiting_since,
         updated_at=EXCLUDED.updated_at`,
      [
        record.workKey,
        record.marketId,
        record.identity.kind,
        record.identity.configId,
        record.identity.configVersion,
        record.identity.strategyKey,
        JSON.stringify(record.identity),
        record.state,
        record.triggerOrigin,
        record.attemptKey,
        record.inputFingerprint,
        record.dispatchedFingerprint,
        record.consumedFingerprint,
        record.blockerReason,
        record.jobId,
        record.runId,
        record.retryCount,
        record.nextAttemptAt,
        record.failureMessage,
        record.lastDispatchedAt,
        record.lastSuccessAt,
        record.lastFailureAt,
        record.waitingSince,
        record.updatedAt,
      ],
    );
  }

  async countLiveWork(marketId: MarketId): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM backtest_automation_work w
         JOIN research_job j ON j.id = w.job_id
        WHERE w.market_id=$1 AND j.status IN ('QUEUED','RUNNING','CANCELLING')`,
      [marketId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async jobSnapshots(
    jobIds: readonly string[],
  ): Promise<Map<string, BacktestAutomationJobSnapshot>> {
    const snapshots = new Map<string, BacktestAutomationJobSnapshot>();
    if (!jobIds.length) return snapshots;
    const result = await this.pool.query<{
      id: string;
      status: ResearchJobStatus;
      result_ref_id: string | null;
      error: string | null;
      error_category: ResearchJobErrorCategory | null;
      completed_at: Date | null;
      started_at: Date | null;
      heartbeat_at: Date | null;
      progress: unknown;
    }>(
      `SELECT id,status,result_ref_id,error,error_category,completed_at,started_at,heartbeat_at,progress
         FROM research_job WHERE id=ANY($1::uuid[])`,
      [jobIds],
    );
    for (const row of result.rows)
      snapshots.set(row.id, {
        id: row.id,
        status: row.status,
        resultRefId: row.result_ref_id,
        error: row.error,
        errorCategory: row.error_category,
        completedAt: row.completed_at?.toISOString() ?? null,
        startedAt: row.started_at?.toISOString() ?? null,
        heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
        progress: jobProgress(row.progress),
      });
    return snapshots;
  }

  async runEndDates(runIds: readonly string[]): Promise<Map<string, string>> {
    const endDates = new Map<string, string>();
    if (!runIds.length) return endDates;
    const result = await this.pool.query<{ id: string; end_date: string }>(
      `SELECT id, end_date::text AS end_date
         FROM backtest_run WHERE id=ANY($1::uuid[])`,
      [runIds],
    );
    for (const row of result.rows) endDates.set(row.id, row.end_date);
    return endDates;
  }

  /** Candidate counts for completed runs, so an empty replay cannot present
   * itself as a fresh baseline. Historical snapshots carry the union of resolved
   * session candidates in `candidateInstruments`. */
  async runCandidateCounts(
    runIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!runIds.length) return counts;
    const result = await this.pool.query<{ id: string; candidates: string }>(
      `SELECT id,
              jsonb_array_length(COALESCE(replay_input->'candidateInstruments','[]'::jsonb))::text AS candidates
         FROM backtest_run WHERE id=ANY($1::uuid[])`,
      [runIds],
    );
    for (const row of result.rows) counts.set(row.id, Number(row.candidates));
    return counts;
  }

  async listCycles(
    marketId: MarketId,
    limit: number,
  ): Promise<BacktestAutomationCycleRecord[]> {
    const result = await this.pool.query<CycleRow>(
      `SELECT cycle_id,market_id,trigger_origin,outcome,evaluated,dispatched,coalesced,
              blocked,retried,succeeded,failed,changes,started_at,finished_at
         FROM backtest_automation_cycle
        WHERE market_id=$1 ORDER BY started_at DESC LIMIT $2`,
      [marketId, Math.max(1, Math.min(limit, 100))],
    );
    return result.rows.map(mapCycle);
  }

  async insertCycle(record: BacktestAutomationCycleRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_automation_cycle
         (cycle_id,market_id,trigger_origin,outcome,evaluated,dispatched,coalesced,
          blocked,retried,succeeded,failed,changes,started_at,finished_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
      [
        record.cycleId,
        record.marketId,
        record.triggerOrigin,
        record.outcome,
        record.evaluated,
        record.dispatched,
        record.coalesced,
        record.blocked,
        record.retried,
        record.succeeded,
        record.failed,
        JSON.stringify(record.changes),
        record.startedAt,
        record.finishedAt,
      ],
    );
  }

  async getStage(
    stageKey: BacktestAutomationStageKey,
    workKey: string,
  ): Promise<BacktestAutomationStageRecord | undefined> {
    const result = await this.pool.query<StageRow>(
      `SELECT ${stageColumns} FROM backtest_automation_stage
        WHERE stage_key=$1 AND work_key=$2`,
      [stageKey, workKey],
    );
    const row = result.rows[0];
    return row ? mapStage(row) : undefined;
  }

  async listStages(
    marketId: MarketId,
  ): Promise<BacktestAutomationStageRecord[]> {
    const result = await this.pool.query<StageRow>(
      `SELECT ${stageColumns} FROM backtest_automation_stage
        WHERE market_id=$1 ORDER BY updated_at DESC`,
      [marketId],
    );
    return result.rows.map(mapStage);
  }

  async saveStage(record: BacktestAutomationStageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_automation_stage
         (stage_key,work_key,market_id,state,authorization_scope,input_identity_hash,
          reason_codes,job_id,retry_count,next_attempt_at,failure_message,last_evaluated_at,
          completed_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT(stage_key,work_key) DO UPDATE SET
         state=EXCLUDED.state,
         authorization_scope=EXCLUDED.authorization_scope,
         input_identity_hash=EXCLUDED.input_identity_hash,
         reason_codes=EXCLUDED.reason_codes,
         job_id=EXCLUDED.job_id,
         retry_count=EXCLUDED.retry_count,
         next_attempt_at=EXCLUDED.next_attempt_at,
         failure_message=EXCLUDED.failure_message,
         last_evaluated_at=EXCLUDED.last_evaluated_at,
         completed_at=EXCLUDED.completed_at,
         updated_at=EXCLUDED.updated_at`,
      [
        record.stageKey,
        record.workKey,
        record.marketId,
        record.state,
        record.authorizationScope,
        record.inputIdentityHash,
        JSON.stringify(record.reasonCodes),
        record.jobId,
        record.retryCount,
        record.nextAttemptAt,
        record.failureMessage,
        record.lastEvaluatedAt,
        record.completedAt,
        record.updatedAt,
      ],
    );
  }

  async clearStages(workKey: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM backtest_automation_stage WHERE work_key=$1",
      [workKey],
    );
  }
}

/** Normalizes the durable research_job.progress jsonb into the bounded shape
 * the automation surface renders; partial or malformed writes stay invisible
 * rather than becoming an invented percentage. */
function jobProgress(value: unknown): BacktestAutomationJobProgress | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawTotal = record.totalSessions;
  const rawCompleted = record.completedSessions;
  const totalSessions =
    typeof rawTotal === "number" && Number.isInteger(rawTotal) && rawTotal > 0
      ? rawTotal
      : null;
  const completedSessions =
    typeof rawCompleted === "number" &&
    Number.isInteger(rawCompleted) &&
    rawCompleted >= 0
      ? Math.min(rawCompleted, totalSessions ?? rawCompleted)
      : null;
  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message
      : null;
  if (totalSessions === null && completedSessions === null && message === null)
    return null;
  return { totalSessions, completedSessions, message };
}

function mapWork(row: WorkRow): BacktestAutomationWorkRecord {
  return {
    workKey: row.work_key,
    marketId: row.market_id,
    identity: backtestAutomationWorkIdentitySchema.parse(row.identity),
    state: row.state,
    triggerOrigin: row.trigger_origin,
    attemptKey: row.attempt_key,
    inputFingerprint: row.input_fingerprint,
    dispatchedFingerprint: row.dispatched_fingerprint,
    consumedFingerprint: row.consumed_fingerprint,
    blockerReason: row.blocker_reason,
    jobId: row.job_id,
    runId: row.run_id,
    retryCount: row.retry_count,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    failureMessage: row.failure_message,
    lastDispatchedAt: row.last_dispatched_at?.toISOString() ?? null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastFailureAt: row.last_failure_at?.toISOString() ?? null,
    waitingSince: row.waiting_since?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCycle(row: CycleRow): BacktestAutomationCycleRecord {
  return {
    cycleId: row.cycle_id,
    marketId: row.market_id,
    triggerOrigin: row.trigger_origin,
    outcome: row.outcome,
    evaluated: row.evaluated,
    dispatched: row.dispatched,
    coalesced: row.coalesced,
    blocked: row.blocked,
    retried: row.retried,
    succeeded: row.succeeded,
    failed: row.failed,
    changes: Array.isArray(row.changes)
      ? row.changes.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function mapStage(row: StageRow): BacktestAutomationStageRecord {
  return {
    stageKey: row.stage_key,
    workKey: row.work_key,
    marketId: row.market_id,
    state: row.state,
    authorizationScope: row.authorization_scope,
    inputIdentityHash: row.input_identity_hash,
    reasonCodes: Array.isArray(row.reason_codes)
      ? row.reason_codes.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    jobId: row.job_id,
    retryCount: row.retry_count,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    failureMessage: row.failure_message,
    lastEvaluatedAt: row.last_evaluated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}
