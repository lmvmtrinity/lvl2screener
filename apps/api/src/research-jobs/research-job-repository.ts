import type {
  ResearchJob,
  ResearchJobErrorCategory,
  ResearchJobProgress,
  ResearchJobStatus,
  ResearchJobType,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import {
  researchEvidenceBindingSchema,
  type ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import { canonicalJson } from "../backtests/research-coverage.js";

/** Thrown by heartbeat/complete/fail when the caller no longer holds the job's lease (another
 * worker reaped it as expired and re-claimed it). The worker must stop processing immediately. */
export class LeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`Lease for research job ${jobId} was lost or expired.`);
    this.name = "LeaseLostError";
  }
}

interface JobRow {
  id: string;
  job_type: ResearchJobType;
  status: ResearchJobStatus;
  idempotency_key: string | null;
  request_payload: unknown;
  result_ref_id: string | null;
  progress: unknown;
  error: string | null;
  error_category: ResearchJobErrorCategory | null;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  cancellation_requested: boolean;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  research_evidence: unknown;
}

export interface ClaimedResearchJob extends ResearchJob {
  requestPayload: unknown;
  leaseOwner: string;
}

const jobColumns = `id,job_type,status,idempotency_key,request_payload,result_ref_id,progress,error,error_category,
  attempt_count,max_attempts,lease_owner,lease_expires_at,heartbeat_at,cancellation_requested,created_at,started_at,completed_at,research_evidence`;
const jobColumnsPrefixed = jobColumns
  .split(",")
  .map((column) => `j.${column.trim()}`)
  .join(",");

/** Error categories that are retried up to max_attempts instead of failing outright on the first
 * attempt. VALIDATION and CANCELLED are never worth retrying: the input won't change and a
 * cancellation must stay cancelled. */
const RETRYABLE_CATEGORIES: ReadonlySet<ResearchJobErrorCategory> = new Set([
  "UPSTREAM_ENGINE",
  "LEASE_EXPIRED",
  "UNKNOWN",
]);

/** Claim ordering classes. Explicit user/experiment requests sit above scheduled
 * catch-up, FIFO within a class, and both age so a stream of new requests cannot
 * starve scheduled work permanently. */
export const RESEARCH_JOB_PRIORITY = {
  SCHEDULED: 0,
  REQUESTED: 10,
} as const;

/** Minutes of queue age that add one point of effective claim priority. The
 * bonus is deliberately uncapped so an older scheduled job eventually catches
 * newer requested work even when requested jobs keep arriving. */
const CLAIM_AGING_MINUTES = 15;

export class ResearchJobRepository {
  constructor(private readonly pool: Pool | PoolClient) {}

  /** Return a repository facade that participates in the caller's transaction. */
  withClient(client: PoolClient): ResearchJobRepository {
    return new ResearchJobRepository(client);
  }

  /** Strict enqueue path for evidence automation. A caller must supply an idempotency key so a
   * worker restart or duplicate source hint cannot create a second durable job. */
  async createStrictJob(
    jobType: ResearchJobType,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ResearchJob> {
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const existing = await this.pool.query<JobRow>(
      `SELECT ${jobColumns} FROM research_job WHERE job_type=$1 AND idempotency_key=$2`,
      [jobType, idempotencyKey],
    );
    if (existing.rows[0]) {
      if (
        canonicalJson(existing.rows[0].request_payload) !==
        canonicalJson(payload)
      )
        throw new Error("RESEARCH_JOB_IDEMPOTENCY_CONFLICT");
      return mapJob(existing.rows[0]);
    }
    const created = await this.createJob(jobType, payload, idempotencyKey);
    const durable = await this.pool.query<JobRow>(
      `SELECT ${jobColumns} FROM research_job WHERE id=$1`,
      [created.id],
    );
    const row = durable.rows[0];
    if (!row) throw new Error("RESEARCH_JOB_IDEMPOTENCY_RACE");
    if (canonicalJson(row.request_payload) !== canonicalJson(payload))
      throw new Error("RESEARCH_JOB_IDEMPOTENCY_CONFLICT");
    return mapJob(row);
  }

  /** Creates a QUEUED job, or returns the existing job unchanged when `idempotencyKey` was already
   * used for this job type -- a duplicate submit (double-click, client retry after a dropped
   * response) must never enqueue a second run. `priority` only affects claim order; idempotency
   * identity stays the job type plus key. */
  async createJob(
    jobType: ResearchJobType,
    payload: unknown,
    idempotencyKey?: string | null,
    priority: number = RESEARCH_JOB_PRIORITY.SCHEDULED,
  ): Promise<ResearchJob> {
    if (idempotencyKey) {
      const existing = await this.pool.query<JobRow>(
        `SELECT ${jobColumns} FROM research_job WHERE job_type=$1 AND idempotency_key=$2`,
        [jobType, idempotencyKey],
      );
      if (existing.rows[0]) return mapJob(existing.rows[0]);
    }
    try {
      const result = await this.pool.query<JobRow>(
        `INSERT INTO research_job (job_type, idempotency_key, request_payload, priority)
         VALUES ($1,$2,$3::jsonb,$4) RETURNING ${jobColumns}`,
        [jobType, idempotencyKey ?? null, JSON.stringify(payload), priority],
      );
      return mapJob(result.rows[0]!);
    } catch (error) {
      // A concurrent request with the same key can race the SELECT above; fall back to it.
      if (idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.pool.query<JobRow>(
          `SELECT ${jobColumns} FROM research_job WHERE job_type=$1 AND idempotency_key=$2`,
          [jobType, idempotencyKey],
        );
        if (existing.rows[0]) return mapJob(existing.rows[0]);
      }
      throw error;
    }
  }

  async get(id: string): Promise<ResearchJob | undefined> {
    const result = await this.pool.query<JobRow>(
      `SELECT ${jobColumns} FROM research_job WHERE id=$1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapJob(row) : undefined;
  }

  async list(jobType?: ResearchJobType, limit = 100): Promise<ResearchJob[]> {
    const result = jobType
      ? await this.pool.query<JobRow>(
          `SELECT ${jobColumns} FROM research_job WHERE job_type=$1 ORDER BY created_at DESC LIMIT $2`,
          [jobType, limit],
        )
      : await this.pool.query<JobRow>(
          `SELECT ${jobColumns} FROM research_job ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
    return result.rows.map(mapJob);
  }

  /** Claims the oldest claimable job of the given types: QUEUED, or RUNNING/CANCELLING with an
   * expired lease (a crashed worker never released it). `FOR UPDATE SKIP LOCKED` lets multiple
   * worker processes poll the same table concurrently without blocking on each other. Claim order
   * is priority class (requested above scheduled) plus FIFO within a class, with an aging bonus so
   * scheduled work cannot be starved by a stream of new requests. */
  async claimNext(
    jobTypes: readonly ResearchJobType[],
    leaseOwner: string,
    leaseMs: number,
  ): Promise<ClaimedResearchJob | undefined> {
    const result = await this.pool.query<JobRow>(
      `WITH candidate AS (
         SELECT id FROM research_job
         WHERE job_type = ANY($1::text[])
           AND attempt_count < max_attempts
           AND (
             status = 'QUEUED'
             OR (status IN ('RUNNING','CANCELLING') AND lease_expires_at < now())
           )
         ORDER BY (
             priority +
             EXTRACT(EPOCH FROM (clock_timestamp() - created_at)) / (${CLAIM_AGING_MINUTES} * 60.0)
           ) DESC, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE research_job j
       SET status = CASE WHEN j.status = 'CANCELLING' THEN 'CANCELLING' ELSE 'RUNNING' END,
           lease_owner = $2,
           lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
           heartbeat_at = now(),
           attempt_count = j.attempt_count + 1,
           started_at = COALESCE(j.started_at, now())
       FROM candidate
       WHERE j.id = candidate.id
       RETURNING ${jobColumnsPrefixed}`,
      [jobTypes, leaseOwner, String(leaseMs)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      ...mapJob(row),
      requestPayload: row.request_payload,
      leaseOwner,
    };
  }

  /** Extends the lease and persists progress. Returns the fresh cancellation flag so the caller
   * can stop between chunks. Throws {@link LeaseLostError} if this process no longer holds the
   * lease (another worker reaped and re-claimed it after a missed heartbeat window). */
  async heartbeat(
    id: string,
    leaseOwner: string,
    leaseMs: number,
    progress?: ResearchJobProgress,
  ): Promise<{ cancellationRequested: boolean }> {
    const result = await this.pool.query<{
      cancellation_requested: boolean;
    }>(
      `UPDATE research_job
       SET lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
           heartbeat_at = now(),
           progress = COALESCE($4::jsonb, progress)
       WHERE id=$1 AND lease_owner=$2 AND status IN ('RUNNING','CANCELLING')
       RETURNING cancellation_requested`,
      [
        id,
        leaseOwner,
        String(leaseMs),
        progress ? JSON.stringify(progress) : null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new LeaseLostError(id);
    return { cancellationRequested: row.cancellation_requested };
  }

  /** Marks a job SUCCEEDED and links it to the persisted research result row. */
  async complete(
    id: string,
    leaseOwner: string,
    resultRefId: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE research_job
       SET status='SUCCEEDED', result_ref_id=$3, completed_at=now(), lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2`,
      [id, leaseOwner, resultRefId],
    );
    if (result.rowCount === 0) throw new LeaseLostError(id);
  }

  async attachResearchEvidence(
    id: string,
    leaseOwner: string,
    binding: ResearchEvidenceBinding,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE research_job SET research_evidence=$3::jsonb
       WHERE id=$1 AND lease_owner=$2 AND status IN ('RUNNING','CANCELLING')`,
      [id, leaseOwner, JSON.stringify(binding)],
    );
    if (result.rowCount === 0) throw new LeaseLostError(id);
  }

  /** Must be called inside the transaction that writes derived evidence. */
  async lockEvidenceLease(
    id: string,
    leaseOwner: string,
    attemptCount: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `SELECT id FROM research_job WHERE id=$1 AND lease_owner=$2
       AND attempt_count=$3 AND status='RUNNING' AND cancellation_requested=FALSE
       AND lease_expires_at>clock_timestamp() FOR UPDATE`,
      [id, leaseOwner, attemptCount],
    );
    if (!result.rowCount) throw new LeaseLostError(id);
  }

  /** Marks a job CANCELLED (terminal). Used when the worker observes cancellation_requested. */
  async markCancelled(id: string, leaseOwner: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE research_job
       SET status='CANCELLED', error_category='CANCELLED',
           error=COALESCE(error, 'Cancelled by request'), completed_at=now(),
           lease_owner=NULL, lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2`,
      [id, leaseOwner],
    );
    if (result.rowCount === 0) throw new LeaseLostError(id);
  }

  /** Records a failure. Retries (re-queues) when the category is transient and attempts remain;
   * otherwise the job becomes terminally FAILED. */
  async fail(
    id: string,
    leaseOwner: string,
    error: string,
    category: ResearchJobErrorCategory,
  ): Promise<void> {
    const result = await this.pool.query<{
      attempt_count: number;
      max_attempts: number;
    }>(
      `SELECT attempt_count, max_attempts FROM research_job WHERE id=$1 AND lease_owner=$2`,
      [id, leaseOwner],
    );
    const row = result.rows[0];
    if (!row) throw new LeaseLostError(id);
    const canRetry =
      RETRYABLE_CATEGORIES.has(category) &&
      row.attempt_count < row.max_attempts;
    const updated = await this.pool.query(
      canRetry
        ? `UPDATE research_job
           SET status='QUEUED', error=$3, error_category=$4,
               lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL
           WHERE id=$1 AND lease_owner=$2`
        : `UPDATE research_job
           SET status='FAILED', error=$3, error_category=$4, completed_at=now(),
               lease_owner=NULL, lease_expires_at=NULL
           WHERE id=$1 AND lease_owner=$2`,
      [id, leaseOwner, error.slice(0, 5_000), category],
    );
    if (updated.rowCount === 0) throw new LeaseLostError(id);
  }

  /** Requests cancellation of a job. A QUEUED job (never claimed) is cancelled immediately; a
   * RUNNING one is flagged so the worker stops between chunks and finalizes it via
   * {@link markCancelled}. No-op on an already-terminal job. */
  async requestCancellation(id: string): Promise<ResearchJob | undefined> {
    const result = await this.pool.query<JobRow>(
      `UPDATE research_job
       SET status = CASE WHEN status='QUEUED' THEN 'CANCELLED' WHEN status='RUNNING' THEN 'CANCELLING' ELSE status END,
           cancellation_requested = TRUE,
           error_category = CASE WHEN status='QUEUED' THEN 'CANCELLED' ELSE error_category END,
           error = CASE WHEN status='QUEUED' THEN COALESCE(error, 'Cancelled by request') ELSE error END,
           completed_at = CASE WHEN status='QUEUED' THEN now() ELSE completed_at END
       WHERE id=$1 AND status IN ('QUEUED','RUNNING','CANCELLING')
       RETURNING ${jobColumns}`,
      [id],
    );
    if (result.rows[0]) return mapJob(result.rows[0]);
    return this.get(id);
  }

  /** Boot/periodic sweep: reclaims jobs whose lease expired without a heartbeat (worker crash).
   * Jobs with attempts remaining go back to QUEUED for another worker to pick up; jobs that have
   * exhausted max_attempts are marked INTERRUPTED so they don't retry forever and stay visible as
   * "needs attention" rather than silently vanishing. This complements (does not replace)
   * reconcile-orphaned-research.ts, which still governs the legacy *_run status columns written by
   * the still-supported synchronous fallback path -- see apps/api/src/worker.ts for the split. */
  async reapExpiredLeases(): Promise<{
    requeued: number;
    interrupted: number;
  }> {
    const requeued = await this.pool.query(
      `UPDATE research_job
       SET status='QUEUED', lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
           error=COALESCE(error, 'Worker lease expired without a heartbeat; requeued'),
           error_category='LEASE_EXPIRED'
       WHERE status IN ('RUNNING','CANCELLING') AND lease_expires_at < now() AND attempt_count < max_attempts`,
    );
    const interrupted = await this.pool.query(
      `UPDATE research_job
       SET status='INTERRUPTED', error_category='LEASE_EXPIRED', completed_at=now(),
           error=COALESCE(error, 'Worker lease expired without a heartbeat and attempts were exhausted'),
           lease_owner=NULL, lease_expires_at=NULL
       WHERE status IN ('RUNNING','CANCELLING') AND lease_expires_at < now() AND attempt_count >= max_attempts`,
    );
    return {
      requeued: requeued.rowCount ?? 0,
      interrupted: interrupted.rowCount ?? 0,
    };
  }
}

function mapJob(row: JobRow): ResearchJob {
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    resultRefId: row.result_ref_id,
    progress: (row.progress ?? {}) as ResearchJobProgress,
    error: row.error,
    errorCategory: row.error_category,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    cancellationRequested: row.cancellation_requested,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    researchEvidence:
      row.research_evidence === null || row.research_evidence === undefined
        ? null
        : researchEvidenceBindingSchema.parse(row.research_evidence),
    requestPayload: row.request_payload,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
