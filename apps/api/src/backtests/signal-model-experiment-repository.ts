import { createHash, randomUUID } from "node:crypto";
import type { MarketId } from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, contentHash } from "./research-coverage.js";
import type {
  FinalTestClaimRequest,
  FinalTestClaimVerifier,
} from "./signal-model-candidate.js";
import { signalModelTestMembershipHash } from "./signal-model-candidate.js";

export type SignalModelStage = "TRAIN" | "VALIDATION" | "TEST";
export type SignalModelStageMembership = {
  sessionDates: readonly string[];
  opportunityIds: readonly string[];
};
export type SignalModelResearchPlan = {
  sourceRunId: string;
  marketId: MarketId;
  sourceDigest: string;
  sourceBindingHash: string;
  strategy: string;
  memberships: Record<
    Lowercase<SignalModelStage>,
    SignalModelStageMembership & { membershipHash: string }
  >;
  comparisonCriteria: Record<string, unknown>;
  modelParameters: Record<string, unknown>;
};
export type SignalModelAttempt = {
  attemptId: string;
  stage: SignalModelStage;
  candidateIdentity: string;
  status:
    | "SUCCEEDED"
    | "INSUFFICIENT_EVIDENCE"
    | "FAILED"
    | "CANCELED"
    | "INTERRUPTED";
  outcome: Record<string, unknown>;
};
export type SignalModelJobFence = {
  jobId: string;
  leaseOwner: string;
  attemptCount: number;
};
export type PreparedSignalModelAuthorization = {
  id: string;
  plan: SignalModelResearchPlan;
  planHash: string;
  trialBudget: number;
  mode: "PREPARE_ONLY";
  expiresAt: string;
  idempotencyKey: string;
};
type AuthorizationRow = {
  id: string;
  market_id: MarketId;
  source_run_id: string;
  source_digest: string;
  plan_hash: string;
  plan: SignalModelResearchPlan;
  trial_budget: number;
  mode: "PREPARE_ONLY" | "EXECUTE_WHEN_READY";
  expires_at: Date;
  revoked_at: Date | null;
  idempotency_key: string;
};
type ClaimRow = {
  authorization_id: string;
  execution_job_id: string;
  stage: SignalModelStage;
  claim_id: string;
  membership_hash: string;
  consumed_at: Date | null;
  market_id: MarketId;
  source_run_id: string;
  source_digest: string;
  plan_hash: string;
  mode: string;
  expires_at: Date;
  revoked_at: Date | null;
  job_status: string;
  lease_owner: string | null;
  attempt_count: number;
  lease_expires_at: Date | null;
  cancellation_requested: boolean;
};
const HASH = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Independent model authority. Public creation is PREPARE_ONLY; there is intentionally no EXECUTE-grant issuer here. */
export class PostgresSignalModelExperimentStore implements FinalTestClaimVerifier {
  constructor(private readonly pool: Pool) {}

  async prepare(input: {
    id?: string;
    plan: SignalModelResearchPlan;
    trialBudget: number;
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<PreparedSignalModelAuthorization> {
    const plan = validatePlan(input.plan);
    const planHash = contentHash(plan);
    if (input.id !== undefined && !UUID.test(input.id))
      throw new Error("SIGNAL_MODEL_AUTHORIZATION_ID_INVALID");
    if (
      !Number.isInteger(input.trialBudget) ||
      input.trialBudget < 1 ||
      input.trialBudget > 10000
    )
      throw new Error("SIGNAL_MODEL_TRIAL_BUDGET_INVALID");
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)
      throw new Error("SIGNAL_MODEL_IDEMPOTENCY_KEY_INVALID");
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())
      throw new Error("SIGNAL_MODEL_AUTHORIZATION_EXPIRY_INVALID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const old = await client.query<AuthorizationRow>(
        "SELECT * FROM signal_model_research_authorization WHERE idempotency_key=$1 FOR UPDATE",
        [input.idempotencyKey],
      );
      if (old.rows[0]) {
        const row = old.rows[0];
        if (
          row.plan_hash !== planHash ||
          row.trial_budget !== input.trialBudget ||
          row.expires_at.getTime() !== expiresAt.getTime()
        )
          throw new Error("SIGNAL_MODEL_AUTHORIZATION_IDEMPOTENCY_CONFLICT");
        await client.query("COMMIT");
        return authDto(row);
      }
      await assertSource(client, plan);
      const id = input.id ?? randomUUID();
      const inserted = await client.query<AuthorizationRow>(
        `INSERT INTO signal_model_research_authorization(id,market_id,source_run_id,source_digest,plan_hash,plan,trial_budget,expires_at,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
        [
          id,
          plan.marketId,
          plan.sourceRunId,
          plan.sourceDigest,
          planHash,
          JSON.stringify(plan),
          input.trialBudget,
          expiresAt,
          input.idempotencyKey,
        ],
      );
      await client.query("COMMIT");
      return authDto(inserted.rows[0]!);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async revoke(id: string, idempotencyKey: string): Promise<boolean> {
    if (!UUID.test(id) || !idempotencyKey.trim())
      throw new Error("SIGNAL_MODEL_REVOCATION_INVALID");
    const result = await this.pool.query(
      `UPDATE signal_model_research_authorization SET revoked_at=transaction_timestamp(),revoke_idempotency_key=$2
      WHERE id=$1 AND revoked_at IS NULL AND dispatched_job_id IS NULL AND mode='PREPARE_ONLY'`,
      [id, idempotencyKey],
    );
    if (result.rowCount === 1) return true;
    const prior = await this.pool.query(
      "SELECT revoke_idempotency_key FROM signal_model_research_authorization WHERE id=$1",
      [id],
    );
    if (prior.rows[0]?.revoke_idempotency_key === idempotencyKey) return true;
    return false;
  }

  async claimStage(
    authorizationId: string,
    stage: SignalModelStage,
    fence: SignalModelJobFence,
    claimId = randomUUID(),
  ): Promise<{ claimId: string; membershipHash: string }> {
    validateFence(fence);
    if (!UUID.test(authorizationId) || !UUID.test(claimId))
      throw new Error("SIGNAL_MODEL_CLAIM_ID_INVALID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const auth = await lockActiveGrant(client, authorizationId, fence);
      const membership =
        auth.plan.memberships[
          stage.toLowerCase() as Lowercase<SignalModelStage>
        ];
      if (!membership) throw new Error("SIGNAL_MODEL_STAGE_MISSING");
      if (stage === "VALIDATION")
        await requireSuccess(client, authorizationId, "TRAIN");
      if (stage === "TEST") {
        await requireSelection(client, authorizationId);
      }
      await client.query(
        `INSERT INTO signal_model_research_stage_claim(authorization_id,execution_job_id,stage,claim_id,membership_hash)
        VALUES($1,$2,$3,$4,$5)`,
        [
          authorizationId,
          fence.jobId,
          stage,
          claimId,
          membership.membershipHash,
        ],
      );
      await client.query("COMMIT");
      return { claimId, membershipHash: membership.membershipHash };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async appendAttempt(
    authorizationId: string,
    fence: SignalModelJobFence,
    attempt: SignalModelAttempt,
  ): Promise<SignalModelAttempt> {
    validateFence(fence);
    validateAttempt(attempt);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const authority = await client.query(
        "SELECT id FROM signal_model_research_authorization WHERE id=$1 FOR UPDATE",
        [authorizationId],
      );
      if (!authority.rows[0])
        throw new Error("SIGNAL_MODEL_AUTHORIZATION_NOT_FOUND");
      const prior = await client.query<{
        stage: SignalModelStage;
        candidate_identity: string;
        status: SignalModelAttempt["status"];
        outcome: Record<string, unknown>;
      }>(
        "SELECT stage,candidate_identity,status,outcome FROM signal_model_research_attempt WHERE authorization_id=$1 AND attempt_id=$2",
        [authorizationId, attempt.attemptId],
      );
      if (prior.rows[0]) {
        const p = prior.rows[0];
        if (
          p.stage !== attempt.stage ||
          p.candidate_identity !== attempt.candidateIdentity ||
          p.status !== attempt.status ||
          canonicalJson(p.outcome) !== canonicalJson(attempt.outcome)
        )
          throw new Error("SIGNAL_MODEL_ATTEMPT_CONFLICT");
        await client.query("COMMIT");
        return attempt;
      }
      await lockActiveGrant(client, authorizationId, fence);
      const claim = await client.query<{
        claim_id: string;
        consumed_at: Date | null;
      }>(
        "SELECT claim_id,consumed_at FROM signal_model_research_stage_claim WHERE authorization_id=$1 AND stage=$2 FOR UPDATE",
        [authorizationId, attempt.stage],
      );
      if (!claim.rows[0]) throw new Error("SIGNAL_MODEL_STAGE_CLAIM_REQUIRED");
      const count = await client.query<{ n: string }>(
        "SELECT count(*)::text n FROM signal_model_research_attempt WHERE authorization_id=$1",
        [authorizationId],
      );
      const number = Number(count.rows[0]!.n) + 1;
      await client.query(
        `INSERT INTO signal_model_research_attempt(authorization_id,stage,claim_id,attempt_id,attempt_number,candidate_identity,status,outcome,job_lease_owner,job_attempt_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [
          authorizationId,
          attempt.stage,
          claim.rows[0].claim_id,
          attempt.attemptId,
          number,
          attempt.candidateIdentity,
          attempt.status,
          JSON.stringify(attempt.outcome),
          fence.leaseOwner,
          fence.attemptCount,
        ],
      );
      if (attempt.stage === "VALIDATION" && attempt.status === "SUCCEEDED")
        await client.query(
          `INSERT INTO signal_model_validation_selection(authorization_id,validation_attempt_id,candidate_identity,threshold) VALUES($1,$2,$3,$4)`,
          [
            authorizationId,
            attempt.attemptId,
            attempt.candidateIdentity,
            attempt.outcome.selectedThreshold,
          ],
        );
      await client.query("COMMIT");
      return attempt;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async consumeFinalTestClaim(
    request: FinalTestClaimRequest,
  ): Promise<FinalTestClaimRequest | null> {
    if (
      !UUID.test(request.claimId) ||
      !UUID.test(request.sourceRunId) ||
      !HASH.test(request.membershipHash)
    )
      return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ClaimRow>(
        `SELECT c.*,a.market_id,a.source_run_id,a.source_digest,a.plan_hash,a.mode,a.expires_at,a.revoked_at,
          j.status job_status,j.lease_owner,j.attempt_count,j.lease_expires_at,j.cancellation_requested
        FROM signal_model_research_stage_claim c JOIN signal_model_research_authorization a ON a.id=c.authorization_id
        JOIN signal_model_research_execution_grant g ON g.authorization_id=a.id AND g.job_id=c.execution_job_id
        JOIN research_job j ON j.id=g.job_id WHERE c.claim_id=$1 AND c.stage='TEST' FOR UPDATE OF c,a,g,j`,
        [request.claimId],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.source_run_id !== request.sourceRunId ||
        row.market_id !== request.marketId ||
        row.membership_hash !== request.membershipHash ||
        row.mode !== "EXECUTE_WHEN_READY" ||
        row.revoked_at ||
        row.expires_at <= new Date() ||
        row.job_status !== "RUNNING" ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= new Date() ||
        row.cancellation_requested ||
        !row.lease_owner
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      await requireSelection(client, row.authorization_id);
      if (row.consumed_at) {
        const receipt = await client.query<{
          authorization_id: string;
          market_id: MarketId;
          source_run_id: string;
          source_digest: string;
          claim_id: string;
          membership_hash: string;
          consumed_at: Date;
        }>(
          `SELECT authorization_id,market_id,source_run_id,source_digest,claim_id,membership_hash,consumed_at
           FROM signal_model_research_test_consumption
           WHERE authorization_id=$1 AND claim_id=$2 FOR SHARE`,
          [row.authorization_id, request.claimId],
        );
        const prior = receipt.rows[0];
        if (
          !prior ||
          prior.market_id !== row.market_id ||
          prior.source_run_id !== row.source_run_id ||
          prior.source_digest !== row.source_digest ||
          prior.claim_id !== row.claim_id ||
          prior.membership_hash !== row.membership_hash ||
          prior.consumed_at.getTime() !== row.consumed_at.getTime()
        ) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query("COMMIT");
        return request;
      }
      const updated = await client.query(
        "UPDATE signal_model_research_stage_claim SET consumed_at=transaction_timestamp() WHERE claim_id=$1 AND consumed_at IS NULL",
        [request.claimId],
      );
      if (updated.rowCount !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return request;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (e instanceof Error && e.message.startsWith("SIGNAL_MODEL_"))
        return null;
      throw e;
    } finally {
      client.release();
    }
  }
}

function authDto(row: AuthorizationRow): PreparedSignalModelAuthorization {
  return {
    id: row.id,
    plan: row.plan,
    planHash: row.plan_hash,
    trialBudget: row.trial_budget,
    mode: "PREPARE_ONLY",
    expiresAt: row.expires_at.toISOString(),
    idempotencyKey: row.idempotency_key,
  };
}
function validatePlan(p: SignalModelResearchPlan): SignalModelResearchPlan {
  if (
    !UUID.test(p.sourceRunId) ||
    !HASH.test(p.sourceDigest) ||
    !HASH.test(p.sourceBindingHash) ||
    !(p.marketId === "CA_TSX" || p.marketId === "US_EQUITIES") ||
    !p.strategy.trim() ||
    !p.comparisonCriteria ||
    !p.modelParameters
  )
    throw new Error("SIGNAL_MODEL_PLAN_INVALID");
  const stages = ["train", "validation", "test"] as const;
  const seen = new Set<string>();
  for (const stage of stages) {
    const m = p.memberships?.[stage];
    if (
      !m ||
      !Array.isArray(m.sessionDates) ||
      !Array.isArray(m.opportunityIds) ||
      !m.sessionDates.length ||
      !m.opportunityIds.length ||
      m.sessionDates.some(
        (d, i) =>
          !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d) ||
          (i > 0 && m.sessionDates[i - 1]! >= d),
      ) ||
      m.opportunityIds.some((id) => !UUID.test(id)) ||
      new Set(m.opportunityIds).size !== m.opportunityIds.length
    )
      throw new Error(`SIGNAL_MODEL_${stage.toUpperCase()}_MEMBERSHIP_INVALID`);
    for (const id of m.opportunityIds) {
      if (seen.has(id)) throw new Error("SIGNAL_MODEL_OPPORTUNITY_REUSED");
      seen.add(id);
    }
    const hash = signalModelTestMembershipHash({
      sourceRunId: p.sourceRunId,
      marketId: p.marketId,
      sessionDates: m.sessionDates,
      opportunityIds: m.opportunityIds,
    });
    if (m.membershipHash !== hash)
      throw new Error("SIGNAL_MODEL_MEMBERSHIP_HASH_MISMATCH");
  }
  if (
    p.memberships.train.sessionDates.at(-1)! >=
      p.memberships.validation.sessionDates[0]! ||
    p.memberships.validation.sessionDates.at(-1)! >=
      p.memberships.test.sessionDates[0]!
  )
    throw new Error("SIGNAL_MODEL_CHRONOLOGY_INVALID");
  return p;
}
async function assertSource(c: PoolClient, p: SignalModelResearchPlan) {
  const r = await c.query<{ valid: boolean; binding: unknown }>(
    `SELECT (run.status='COMPLETED' AND run.data_source='CAPTURED_QUOTES' AND run.execution_model_version='paper-execution-v7' AND run.market_id=$2 AND run.data_quality->>'spread'='CAPTURED' AND run.strategies ? $3 AND run.research_evidence=e.binding AND e.market_id=$2 AND e.input_hash=$4 AND cov.status='VERIFIED' AND cov.input_hash=$4) AS valid,e.binding FROM backtest_run run JOIN research_evidence_binding e ON e.owner_kind='BACKTEST' AND e.owner_id=run.id JOIN research_coverage_report cov ON cov.hash=e.coverage_report_hash WHERE run.id=$1 FOR SHARE OF run,e,cov`,
    [p.sourceRunId, p.marketId, p.strategy, p.sourceDigest],
  );
  if (
    !r.rows[0]?.valid ||
    contentHash(r.rows[0].binding) !== p.sourceBindingHash
  )
    throw new Error("SIGNAL_MODEL_SOURCE_PROVENANCE_INVALID");
  const ids = [
    ...p.memberships.train.opportunityIds,
    ...p.memberships.validation.opportunityIds,
    ...p.memberships.test.opportunityIds,
  ];
  const trades = await c.query<{
    id: string;
    signal_timestamp: Date;
    exit_time: Date;
    strategy_name: string;
  }>(
    "SELECT id,signal_timestamp,exit_time,strategy_name FROM backtest_trade WHERE run_id=$1 AND id=ANY($2::uuid[]) FOR SHARE",
    [p.sourceRunId, ids],
  );
  if (
    trades.rows.length !== ids.length ||
    trades.rows.some((t) => t.strategy_name !== p.strategy)
  )
    throw new Error("SIGNAL_MODEL_SOURCE_MEMBERSHIP_UNPROVEN");
  const byId = new Map(trades.rows.map((t) => [t.id, t]));
  const session = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone:
        p.marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  for (const stage of ["train", "validation", "test"] as const) {
    const membership = p.memberships[stage];
    for (const id of membership.opportunityIds) {
      const trade = byId.get(id);
      if (
        !trade ||
        !membership.sessionDates.includes(session(trade.signal_timestamp))
      )
        throw new Error("SIGNAL_MODEL_SOURCE_MEMBERSHIP_MISMATCH");
      if (
        stage === "train" &&
        session(trade.exit_time) >= p.memberships.validation.sessionDates[0]!
      )
        throw new Error("SIGNAL_MODEL_TRAIN_LABEL_CHRONOLOGY_INVALID");
      if (
        stage === "validation" &&
        session(trade.exit_time) >= p.memberships.test.sessionDates[0]!
      )
        throw new Error("SIGNAL_MODEL_VALIDATION_LABEL_CHRONOLOGY_INVALID");
    }
  }
}
async function lockActiveGrant(
  c: PoolClient,
  id: string,
  f: SignalModelJobFence,
): Promise<AuthorizationRow> {
  const r = await c.query<AuthorizationRow>(
    `SELECT a.* FROM signal_model_research_authorization a JOIN signal_model_research_execution_grant g ON g.authorization_id=a.id JOIN research_job j ON j.id=g.job_id WHERE a.id=$1 AND g.job_id=$2 AND a.mode='EXECUTE_WHEN_READY' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND j.job_type='SIGNAL_MODEL_RESEARCH' AND j.status='RUNNING' AND j.lease_owner=$3 AND j.attempt_count=$4 AND j.lease_expires_at>clock_timestamp() AND NOT j.cancellation_requested FOR UPDATE OF a,g,j`,
    [id, f.jobId, f.leaseOwner, f.attemptCount],
  );
  if (!r.rows[0]) throw new Error("SIGNAL_MODEL_ACTIVE_JOB_REQUIRED");
  return r.rows[0];
}
async function requireSuccess(
  c: PoolClient,
  id: string,
  stage: SignalModelStage,
) {
  const r = await c.query(
    "SELECT 1 FROM signal_model_research_attempt WHERE authorization_id=$1 AND stage=$2 AND status='SUCCEEDED'",
    [id, stage],
  );
  if (!r.rows.length) throw new Error(`SIGNAL_MODEL_${stage}_SUCCESS_REQUIRED`);
}
async function requireSelection(c: PoolClient, id: string) {
  const r = await c.query(
    "SELECT 1 FROM signal_model_validation_selection WHERE authorization_id=$1",
    [id],
  );
  if (!r.rows.length)
    throw new Error("SIGNAL_MODEL_VALIDATION_SELECTION_REQUIRED");
}
function validateFence(f: SignalModelJobFence) {
  if (
    !UUID.test(f.jobId) ||
    !f.leaseOwner.trim() ||
    !Number.isInteger(f.attemptCount) ||
    f.attemptCount < 1
  )
    throw new Error("SIGNAL_MODEL_JOB_FENCE_INVALID");
}
function validateAttempt(a: SignalModelAttempt) {
  if (
    !UUID.test(a.attemptId) ||
    !HASH.test(a.candidateIdentity) ||
    !a.outcome ||
    typeof a.outcome !== "object" ||
    Array.isArray(a.outcome)
  )
    throw new Error("SIGNAL_MODEL_ATTEMPT_INVALID");
}
export function signalModelCandidateIdentity(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
