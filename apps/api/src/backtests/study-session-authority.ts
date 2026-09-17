import {
  executableFrozenStudyPlanSchema,
  requiredStudyExecutions,
  type StudyAuthorityRef,
  type FrozenStudyPlan,
  type StudyStage,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, contentHash } from "./research-coverage.js";
import type { StudyExecutionFence } from "./strategy-study-service.js";

export type StudySessionKey = {
  experimentId: string;
  stage: StudyStage;
  side: "baseline" | "challenger";
  sessionDate: string;
};

export type StudySessionAuthorityState =
  "STARTED" | "ACCEPTED" | "ALREADY_STARTED";

export interface StudySessionAuthority {
  begin(
    key: StudySessionKey,
    fence: StudyExecutionFence,
  ): Promise<StudySessionAuthorityState>;
  assertCurrent(fence: StudyExecutionFence): Promise<void>;
  accept(
    key: StudySessionKey,
    fence: StudyExecutionFence,
    resultHash: string,
  ): Promise<void>;
}

/**
 * Database-owned fence for one scanner session.  It deliberately keeps the
 * network call outside the transaction: begin/assertCurrent/accept are short
 * lock transactions, while the scanner request itself is cancellable.
 */
export class PostgresStudySessionAuthority implements StudySessionAuthority {
  constructor(
    private readonly pool: Pool,
    private readonly authority: StudyAuthorityRef | undefined,
    private readonly plan: FrozenStudyPlan,
  ) {}

  async begin(
    key: StudySessionKey,
    fence: StudyExecutionFence,
  ): Promise<StudySessionAuthorityState> {
    this.assertKey(key);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertCurrentWithClient(client, fence);
      const authorityId = this.authorityId();
      const prior = await client.query<{ state: string }>(
        `SELECT 'ACCEPTED' AS state
           FROM study_session_acceptance
          WHERE authority_id=$1 AND experiment_id=$2 AND stage=$3
            AND side=$4 AND session_date=$5
         UNION ALL
         SELECT state
           FROM study_session_receipt
          WHERE authority_id=$1 AND experiment_id=$2 AND stage=$3
            AND side=$4 AND session_date=$5
         LIMIT 1`,
        [authorityId, key.experimentId, key.stage, key.side, key.sessionDate],
      );
      if (prior.rows[0]) {
        await client.query("COMMIT");
        return prior.rows[0].state === "STARTED"
          ? "ALREADY_STARTED"
          : "ACCEPTED";
      }
      const admitted = await client.query<{
        admitted_executions: number;
        used: string;
      }>(
        `SELECT g.admitted_executions,(SELECT count(*) FROM study_session_receipt r WHERE r.authority_id=g.id)::text AS used FROM study_execution_grant g WHERE g.id=$1`,
        [authorityId],
      );
      if (
        Number(admitted.rows[0]?.used) >=
        Number(admitted.rows[0]?.admitted_executions)
      )
        throw new Error("STUDY_AUTHORIZATION_BUDGET_EXCEEDED");
      await client.query(
        `INSERT INTO study_session_receipt(
           authority_id,experiment_id,stage,side,session_date,state,
           result_hash,job_id,attempt_count
         ) VALUES($1,$2,$3,$4,$5,'STARTED',NULL,$6,$7)`,
        [
          authorityId,
          key.experimentId,
          key.stage,
          key.side,
          key.sessionDate,
          fence.jobId,
          fence.attemptCount,
        ],
      );
      await client.query("COMMIT");
      return "STARTED";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async assertCurrent(fence: StudyExecutionFence): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertCurrentWithClient(client, fence);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async accept(
    key: StudySessionKey,
    fence: StudyExecutionFence,
    resultHash: string,
  ): Promise<void> {
    this.assertKey(key);
    if (!/^[a-f0-9]{64}$/.test(resultHash))
      throw new Error("STUDY_SESSION_RESULT_HASH_INVALID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertCurrentWithClient(client, fence);
      const authorityId = this.authorityId();
      const started = await client.query(
        `SELECT 1 FROM study_session_receipt
          WHERE authority_id=$1 AND experiment_id=$2 AND stage=$3
            AND side=$4 AND session_date=$5 AND state='STARTED' AND job_id=$6 AND attempt_count=$7
          FOR SHARE`,
        [
          authorityId,
          key.experimentId,
          key.stage,
          key.side,
          key.sessionDate,
          fence.jobId,
          fence.attemptCount,
        ],
      );
      if (!started.rows[0]) throw new Error("STUDY_SESSION_BEGIN_REQUIRED");
      await client.query(
        `INSERT INTO study_session_acceptance(
           authority_id,experiment_id,stage,side,session_date,result_hash,
           job_id,attempt_count
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (authority_id,experiment_id,stage,side,session_date)
         DO NOTHING`,
        [
          authorityId,
          key.experimentId,
          key.stage,
          key.side,
          key.sessionDate,
          resultHash,
          fence.jobId,
          fence.attemptCount,
        ],
      );
      const accepted = await client.query<{
        result_hash: string;
        job_id: string;
        attempt_count: number;
      }>(
        `SELECT result_hash,job_id,attempt_count FROM study_session_acceptance WHERE authority_id=$1 AND experiment_id=$2 AND stage=$3 AND side=$4 AND session_date=$5`,
        [authorityId, key.experimentId, key.stage, key.side, key.sessionDate],
      );
      const prior = accepted.rows[0];
      if (
        !prior ||
        prior.result_hash !== resultHash ||
        prior.job_id !== fence.jobId ||
        prior.attempt_count !== fence.attemptCount
      )
        throw new Error("STUDY_SESSION_RESULT_CONFLICT");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private assertKey(key: StudySessionKey): void {
    if (key.experimentId !== this.plan.experimentId)
      throw new Error("STUDY_SESSION_EXPERIMENT_MISMATCH");
    const expected = this.plan.sessionPlan?.sessions[key.stage];
    if (!expected || !expected.includes(key.sessionDate))
      throw new Error("STUDY_SESSION_NOT_IN_FROZEN_PLAN");
  }

  private authorityId(): string {
    return authorityId(this.authority);
  }

  private async assertCurrentWithClient(
    client: PoolClient,
    fence: StudyExecutionFence,
  ): Promise<void> {
    const grant = await assertStudyAuthority(client, this.authority, fence);
    if (canonicalJson(grant.plan) !== canonicalJson(this.plan))
      throw new Error("STUDY_AUTHORIZATION_PLAN_MISMATCH");
  }
}

export function sessionResultHash(value: unknown): string {
  return contentHash(value);
}

export function authorityId(authority: StudyAuthorityRef | undefined): string {
  if (!authority) throw new Error("STUDY_SESSION_AUTHORITY_REQUIRED");
  return authority.kind === "EXECUTE_WHEN_READY"
    ? authority.authorizationId
    : authority.grantId;
}

export async function assertStudyAuthority(
  client: PoolClient,
  authority: StudyAuthorityRef | undefined,
  fence: StudyExecutionFence,
  options: { allowEnded?: boolean } = {},
): Promise<{ plan: FrozenStudyPlan; admitted_executions: number }> {
  const jobs = await client.query<{
    valid: boolean;
    cancellation_requested: boolean;
    request_payload: { plan: unknown; authority: unknown };
  }>(
    `SELECT status='RUNNING' AND lease_owner=$2 AND attempt_count=$3 AND lease_expires_at>clock_timestamp() AS valid,cancellation_requested,request_payload FROM research_job WHERE id=$1 FOR UPDATE`,
    [fence.jobId, fence.leaseOwner, fence.attemptCount],
  );
  const job = jobs.rows[0];
  if (!job?.valid) throw new Error("STUDY_LEASE_LOST");
  if (job.cancellation_requested && !options.allowEnded)
    throw new Error("STUDY_AUTHORITY_LOST");
  const id = authorityId(authority);
  if (authority?.kind === "EXECUTE_WHEN_READY") {
    const result = await client.query<{ valid: boolean }>(
      `SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AND dispatched_job_id=$2 AS valid FROM study_execution_authorization WHERE id=$1 FOR UPDATE`,
      [id, fence.jobId],
    );
    if (!result.rows[0] || (!result.rows[0].valid && !options.allowEnded))
      throw new Error("STUDY_AUTHORITY_LOST");
  }
  const result = await client.query<{
    plan: FrozenStudyPlan;
    plan_hash: string;
    market_id: string;
    experiment_id: string;
    admitted_executions: number;
    job_id: string;
    kind: string;
  }>(
    `SELECT plan,plan_hash,market_id,experiment_id,admitted_executions,job_id,kind FROM study_execution_grant WHERE id=$1 FOR UPDATE`,
    [id],
  );
  const grant = result.rows[0];
  if (
    !grant ||
    grant.job_id !== fence.jobId ||
    grant.kind !== authority!.kind ||
    canonicalJson(job.request_payload.authority) !== canonicalJson(authority)
  )
    throw new Error("STUDY_AUTHORITY_LOST");
  const plan = executableFrozenStudyPlanSchema.parse(grant.plan);
  if (
    contentHash(plan) !== grant.plan_hash ||
    canonicalJson(plan) !== canonicalJson(job.request_payload.plan) ||
    plan.experimentId !== grant.experiment_id ||
    plan.comparison.marketId !== grant.market_id ||
    requiredStudyExecutions(plan) !== grant.admitted_executions
  )
    throw new Error("STUDY_AUTHORIZATION_PLAN_MISMATCH");
  return { ...grant, plan };
}
