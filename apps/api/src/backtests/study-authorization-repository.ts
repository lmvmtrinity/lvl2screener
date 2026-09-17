import { randomUUID } from "node:crypto";
import { ResearchJobRepository } from "../research-jobs/research-job-repository.js";
import {
  frozenStudyPlanSchema,
  executableFrozenStudyPlanSchema,
  type ResearchJob,
  studyAuthorizationRecordSchema,
  studyExecutionAuthorizationSchema,
  requiredStudyExecutions,
  type FrozenStudyPlan,
  type MarketId,
  type StudyAuthorizationRecord,
  type StudyExecutionAuthorization,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { canonicalJson, contentHash } from "./research-coverage.js";

export type StudyAuthorizationDispatch =
  | { state: "DISPATCHED"; jobId: string }
  | { state: "WAITING" | "PREPARE_ONLY" | "REVOKED" | "EXPIRED" | "USED" };

export interface StudyAuthorizationRepository {
  create(
    authorization: StudyExecutionAuthorization,
    plan: FrozenStudyPlan,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord>;
  get(id: string): Promise<StudyAuthorizationRecord | null>;
  getPlan(id: string): Promise<FrozenStudyPlan | null>;
  list(marketId: MarketId, limit?: number): Promise<StudyAuthorizationRecord[]>;
  revoke(
    id: string,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord | null>;
  reserveAndEnqueue(
    id: string,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationDispatch>;
}

type AuthorizationRow = {
  id: string;
  market_id: MarketId;
  frozen_plan_hash: string;
  prerequisite_policy_hash: string;
  source_window_start: string | Date;
  source_window_end: string | Date;
  engine_revision: string;
  runtime_fingerprint: string;
  expires_at: Date;
  max_studies: 1;
  max_session_executions: number;
  mode: "PREPARE_ONLY" | "EXECUTE_WHEN_READY";
  plan: unknown;
  granted_at: Date;
  revoked_at: Date | null;
  dispatched_job_id: string | null;
  idempotency_key: string;
  revoke_idempotency_key: string | null;
};

const columns = `id,market_id,frozen_plan_hash,prerequisite_policy_hash,
  source_window_start,source_window_end,engine_revision,runtime_fingerprint,
  expires_at,max_studies,max_session_executions,mode,plan,granted_at,revoked_at,
  dispatched_job_id,idempotency_key,revoke_idempotency_key`;

export class PostgresStudyAuthorizationRepository implements StudyAuthorizationRepository {
  constructor(private readonly pool: Pool) {}

  async createDirect(
    rawPlan: FrozenStudyPlan,
    idempotencyKey: string,
  ): Promise<ResearchJob> {
    const plan = executableFrozenStudyPlanSchema.parse(rawPlan);
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["study-direct:" + idempotencyKey],
      );
      const existing = await client.query<{
        request_payload: { plan: unknown; authority?: { grantId?: string } };
      }>(
        "SELECT request_payload FROM research_job WHERE job_type='STRATEGY_STUDY' AND idempotency_key=$1",
        [idempotencyKey],
      );
      if (
        existing.rows[0] &&
        canonicalJson(existing.rows[0].request_payload.plan) !==
          canonicalJson(plan)
      )
        throw new Error("RESEARCH_JOB_IDEMPOTENCY_CONFLICT");
      const grantId =
        existing.rows[0]?.request_payload.authority?.grantId ?? randomUUID();
      const job = await new ResearchJobRepository(client).createStrictJob(
        "STRATEGY_STUDY",
        { plan, authority: { kind: "DIRECT_SUBMISSION", grantId } },
        idempotencyKey,
      );
      await client.query(
        `INSERT INTO study_execution_grant(id,kind,job_id,experiment_id,market_id,plan_hash,plan,admitted_executions)
        VALUES($1,'DIRECT_SUBMISSION',$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(id) DO NOTHING`,
        [
          grantId,
          job.id,
          plan.experimentId,
          plan.comparison.marketId,
          contentHash(plan),
          JSON.stringify(plan),
          requiredStudyExecutions(plan),
        ],
      );
      await client.query("COMMIT");
      return job;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async create(
    rawAuthorization: StudyExecutionAuthorization,
    rawPlan: FrozenStudyPlan,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord> {
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const authorization =
      studyExecutionAuthorizationSchema.parse(rawAuthorization);
    const plan = frozenStudyPlanSchema.parse(rawPlan);
    assertAuthorizationPlan(authorization, plan);
    if (requiredStudyExecutions(plan) > authorization.maxSessionExecutions)
      throw new Error("STUDY_AUTHORIZATION_BUDGET_EXCEEDED");
    const inserted = await this.pool.query<AuthorizationRow>(
      `INSERT INTO study_execution_authorization
       (id,market_id,frozen_plan_hash,prerequisite_policy_hash,source_window_start,
        source_window_end,engine_revision,runtime_fingerprint,expires_at,max_studies,
        max_session_executions,mode,plan,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
       ON CONFLICT DO NOTHING
       RETURNING ${columns}`,
      [
        authorization.id,
        authorization.marketId,
        authorization.frozenPlanHash,
        authorization.prerequisitePolicyHash,
        authorization.sourceWindowStart,
        authorization.sourceWindowEnd,
        authorization.engineRevision,
        authorization.runtimeFingerprint,
        authorization.expiresAt,
        authorization.maxStudies,
        authorization.maxSessionExecutions,
        authorization.mode,
        JSON.stringify(plan),
        idempotencyKey,
      ],
    );
    if (inserted.rows[0]) return mapAuthorization(inserted.rows[0]);
    const existing = await this.pool.query<AuthorizationRow>(
      `SELECT ${columns} FROM study_execution_authorization
       WHERE id=$1 OR idempotency_key=$2`,
      [authorization.id, idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("STUDY_AUTHORIZATION_SAVE_RACE");
    if (
      canonicalJson(mapAuthorization(row)) !==
      canonicalJson({
        ...authorization,
        grantedAt: mapAuthorization(row).grantedAt,
        revokedAt: mapAuthorization(row).revokedAt,
        dispatchedJobId: mapAuthorization(row).dispatchedJobId,
      })
    )
      throw new Error("STUDY_AUTHORIZATION_CONFLICT");
    return mapAuthorization(row);
  }

  async get(id: string): Promise<StudyAuthorizationRecord | null> {
    const result = await this.pool.query<AuthorizationRow>(
      `SELECT ${columns} FROM study_execution_authorization WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? mapAuthorization(result.rows[0]) : null;
  }

  async getPlan(id: string): Promise<FrozenStudyPlan | null> {
    const result = await this.pool.query<{ plan: unknown }>(
      "SELECT plan FROM study_execution_authorization WHERE id=$1",
      [id],
    );
    return result.rows[0]
      ? frozenStudyPlanSchema.parse(result.rows[0].plan)
      : null;
  }

  async list(
    marketId: MarketId,
    limit = 100,
  ): Promise<StudyAuthorizationRecord[]> {
    const result = await this.pool.query<AuthorizationRow>(
      `SELECT ${columns} FROM study_execution_authorization
       WHERE market_id=$1 ORDER BY granted_at DESC LIMIT $2`,
      [marketId, limit],
    );
    return result.rows.map(mapAuthorization);
  }

  async revoke(
    id: string,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord | null> {
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const result = await this.pool.query<AuthorizationRow>(
      `UPDATE study_execution_authorization
       SET revoked_at=clock_timestamp(), revoke_idempotency_key=$2
       WHERE id=$1 AND revoked_at IS NULL
       RETURNING ${columns}`,
      [id, idempotencyKey],
    );
    if (result.rows[0]) return mapAuthorization(result.rows[0]);
    const existing = await this.pool.query<AuthorizationRow>(
      `SELECT ${columns} FROM study_execution_authorization WHERE id=$1`,
      [id],
    );
    const row = existing.rows[0];
    if (!row) return null;
    if (row.revoke_idempotency_key !== idempotencyKey)
      throw new Error("STUDY_AUTHORIZATION_REVOKE_CONFLICT");
    return mapAuthorization(row);
  }

  async reserveAndEnqueue(
    id: string,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationDispatch> {
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<AuthorizationRow>(
        `SELECT ${columns} FROM study_execution_authorization WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = result.rows[0];
      if (!row) throw new Error("STUDY_AUTHORIZATION_NOT_FOUND");
      if (row.revoked_at) {
        await client.query("COMMIT");
        return { state: "REVOKED" };
      }
      if (row.dispatched_job_id) {
        await client.query("COMMIT");
        return { state: "USED" };
      }
      if (row.mode !== "EXECUTE_WHEN_READY") {
        await client.query("COMMIT");
        return { state: "PREPARE_ONLY" };
      }
      const clock = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      if (row.expires_at.getTime() <= clock.rows[0]!.now.getTime()) {
        await client.query("COMMIT");
        return { state: "EXPIRED" };
      }
      const admittedPlan = executableFrozenStudyPlanSchema.parse(row.plan);
      assertAuthorizationPlan(mapAuthorization(row), admittedPlan);
      if (requiredStudyExecutions(admittedPlan) > row.max_session_executions)
        throw new Error("STUDY_AUTHORIZATION_BUDGET_EXCEEDED");
      const payload = {
        plan: admittedPlan,
        authority: {
          kind: "EXECUTE_WHEN_READY" as const,
          authorizationId: id,
        },
      };
      if (!payload.plan.sessionPlan)
        throw new Error("STUDY_SESSION_PLAN_REQUIRED");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO research_job(job_type,idempotency_key,request_payload)
         VALUES('STRATEGY_STUDY',$1,$2::jsonb)
         ON CONFLICT(job_type,idempotency_key) DO NOTHING
         RETURNING id`,
        [idempotencyKey, JSON.stringify(payload)],
      );
      let jobId = inserted.rows[0]?.id;
      if (!jobId) {
        const existing = await client.query<{
          id: string;
          request_payload: unknown;
        }>(
          `SELECT id,request_payload FROM research_job
           WHERE job_type='STRATEGY_STUDY' AND idempotency_key=$1 FOR UPDATE`,
          [idempotencyKey],
        );
        const prior = existing.rows[0];
        if (!prior) throw new Error("RESEARCH_JOB_IDEMPOTENCY_RACE");
        if (canonicalJson(prior.request_payload) !== canonicalJson(payload))
          throw new Error("RESEARCH_JOB_IDEMPOTENCY_CONFLICT");
        jobId = prior.id;
      }
      const frozenPlan = executableFrozenStudyPlanSchema.parse(row.plan);
      await client.query(
        `INSERT INTO study_execution_grant(id,kind,authorization_id,job_id,experiment_id,market_id,plan_hash,plan,admitted_executions)
        VALUES($1,'EXECUTE_WHEN_READY',$1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          id,
          jobId,
          frozenPlan.experimentId,
          frozenPlan.comparison.marketId,
          contentHash(frozenPlan),
          JSON.stringify(frozenPlan),
          requiredStudyExecutions(frozenPlan),
        ],
      );
      if (frozenPlan.sessionPlan) {
        await client.query(
          `INSERT INTO study_session_plan(
             authorization_id,plan_hash,plan,admitted_executions
           ) VALUES($1,$2,$3::jsonb,$4)
           ON CONFLICT (authorization_id) DO NOTHING`,
          [
            id,
            contentHash(frozenPlan.sessionPlan),
            JSON.stringify(frozenPlan.sessionPlan),
            requiredStudyExecutions(frozenPlan),
          ],
        );
      }
      await client.query(
        `UPDATE study_execution_authorization SET dispatched_job_id=$2 WHERE id=$1`,
        [id, jobId],
      );
      await client.query("COMMIT");
      return { state: "DISPATCHED", jobId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function authorizationPlanHash(plan: FrozenStudyPlan): string {
  return contentHash(frozenStudyPlanSchema.parse(plan));
}

export function authorizationPolicyHash(plan: FrozenStudyPlan): string {
  return contentHash({
    marketId: plan.comparison.marketId,
    expectedSessions: plan.comparison.expectedSessions,
    unit: plan.comparison.unit,
    minimumSessions: plan.comparison.minimumSessions,
    blockLength: plan.comparison.blockLength,
    bootstrapSamples: plan.comparison.bootstrapSamples,
    seed: plan.comparison.seed,
  });
}

export function assertAuthorizationPlan(
  authorization: StudyExecutionAuthorization,
  plan: FrozenStudyPlan,
): void {
  if (authorization.marketId !== plan.comparison.marketId)
    throw new Error("STUDY_AUTHORIZATION_MARKET_MISMATCH");
  if (authorization.frozenPlanHash !== authorizationPlanHash(plan))
    throw new Error("STUDY_AUTHORIZATION_PLAN_MISMATCH");
  if (authorization.prerequisitePolicyHash !== authorizationPolicyHash(plan))
    throw new Error("STUDY_AUTHORIZATION_POLICY_MISMATCH");
  if (authorization.sourceWindowStart > authorization.sourceWindowEnd)
    throw new Error("STUDY_AUTHORIZATION_WINDOW_INVALID");
  if (authorization.engineRevision !== plan.binding.engineRevision)
    throw new Error("STUDY_AUTHORIZATION_ENGINE_MISMATCH");
  if (authorization.runtimeFingerprint !== plan.binding.runtimeFingerprint)
    throw new Error("STUDY_AUTHORIZATION_RUNTIME_MISMATCH");
  if (plan.sessionPlan) {
    const dates = Object.values(plan.sessionPlan.sessions).flat().sort();
    if (
      authorization.sourceWindowStart !== dates[0] ||
      authorization.sourceWindowEnd !== dates[dates.length - 1]
    )
      throw new Error("STUDY_AUTHORIZATION_WINDOW_MISMATCH");
  }
}

function mapAuthorization(row: AuthorizationRow): StudyAuthorizationRecord {
  return studyAuthorizationRecordSchema.parse({
    id: row.id,
    marketId: row.market_id,
    frozenPlanHash: row.frozen_plan_hash,
    prerequisitePolicyHash: row.prerequisite_policy_hash,
    sourceWindowStart: dateOnly(row.source_window_start),
    sourceWindowEnd: dateOnly(row.source_window_end),
    engineRevision: row.engine_revision,
    runtimeFingerprint: row.runtime_fingerprint,
    expiresAt: row.expires_at.toISOString(),
    maxStudies: row.max_studies,
    maxSessionExecutions: row.max_session_executions,
    mode: row.mode,
    grantedAt: row.granted_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    dispatchedJobId: row.dispatched_job_id,
  });
}

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

export type AuthorizationPlanRow = {
  authorization: StudyAuthorizationRecord;
  plan: FrozenStudyPlan;
};
