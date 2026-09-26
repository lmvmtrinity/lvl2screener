import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { PostgresStrategyLearningExperimentStore } from "../src/backtests/strategy-learning-experiment-repository.js";
import { contentHash } from "../src/backtests/research-coverage.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!databaseUrl)("strategy learning ledger PostgreSQL", () => {
  let pool: Pool;
  let store: PostgresStrategyLearningExperimentStore;
  const studyId = randomUUID();
  const jobId = randomUUID();
  const grantId = randomUUID();
  const specHash = "a".repeat(64);
  const binding = {
    manifestHash: "b".repeat(64),
    coverageReportHash: "c".repeat(64),
    inputHash: "d".repeat(64),
    engineRevision: "e".repeat(40),
    runtimeFingerprint: "f".repeat(64),
    verifiedAt: "2026-09-10T12:00:00.000Z",
  };
  const identity = {
    studyId,
    studySpecHash: specHash,
    marketId: "CA_TSX" as const,
    sourceDigest: binding.inputHash,
    binding,
    authority: { kind: "DIRECT_SUBMISSION" as const, grantId },
    trialBudget: 1,
  };
  const fence = (id: string) => ({
    jobId: id,
    leaseOwner: "ledger-test",
    attemptCount: 1,
  });
  const candidate = (value: string) => {
    const candidateSpec = { value };
    return { candidateIdentity: contentHash(candidateSpec), candidateSpec };
  };
  const authorizeId = randomUUID();
  const secondStudyId = randomUUID();
  const secondHash = "8".repeat(64);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    await migrate(pool);
    const spec = {
      experimentId: studyId,
      binding,
      comparison: { marketId: "CA_TSX" },
    };
    await pool.query(
      `INSERT INTO research_job(id,job_type,status,request_payload,attempt_count,max_attempts,lease_owner,lease_expires_at,heartbeat_at,started_at)
      VALUES($1,'STRATEGY_STUDY','RUNNING',$2::jsonb,1,3,'ledger-test',NOW()+INTERVAL '1 hour',NOW(),NOW())`,
      [jobId, JSON.stringify({ plan: spec })],
    );
    await pool.query(
      "INSERT INTO strategy_study(id,market_id,spec_hash,spec) VALUES($1,'CA_TSX',$2,$3::jsonb)",
      [studyId, specHash, JSON.stringify(spec)],
    );
    await pool.query(
      `INSERT INTO study_execution_grant(id,kind,job_id,experiment_id,market_id,plan_hash,plan,admitted_executions)
      VALUES($1,'DIRECT_SUBMISSION',$2,$3,'CA_TSX',$4,$5::jsonb,1)`,
      [grantId, jobId, studyId, specHash, JSON.stringify(spec)],
    );
    store = new PostgresStrategyLearningExperimentStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  const createDirectLedger = async () => {
    const id = randomUUID();
    const hash = "5".repeat(64);
    const nextJobId = randomUUID();
    const nextGrantId = randomUUID();
    const plan = {
      experimentId: id,
      binding,
      comparison: { marketId: "CA_TSX" },
    };
    await pool.query(
      `INSERT INTO research_job(id,job_type,status,request_payload,attempt_count,max_attempts,lease_owner,lease_expires_at,heartbeat_at,started_at)
      VALUES($1,'STRATEGY_STUDY','RUNNING',$2::jsonb,1,3,'ledger-test',NOW()+INTERVAL '1 hour',NOW(),NOW())`,
      [nextJobId, JSON.stringify({ plan })],
    );
    await pool.query(
      "INSERT INTO strategy_study(id,market_id,spec_hash,spec) VALUES($1,'CA_TSX',$2,$3::jsonb)",
      [id, hash, JSON.stringify(plan)],
    );
    await pool.query(
      `INSERT INTO study_execution_grant(id,kind,job_id,experiment_id,market_id,plan_hash,plan,admitted_executions)
      VALUES($1,'DIRECT_SUBMISSION',$2,$3,'CA_TSX',$4,$5::jsonb,1)`,
      [nextGrantId, nextJobId, id, hash, JSON.stringify(plan)],
    );
    const frozen = {
      ...identity,
      studyId: id,
      studySpecHash: hash,
      authority: { kind: "DIRECT_SUBMISSION" as const, grantId: nextGrantId },
    };
    await store.freeze(frozen);
    return { studyId: id, jobId: nextJobId };
  };

  it("freezes a market/source bound identity and counts failed attempts against the immutable budget", async () => {
    await expect(store.freeze(identity)).resolves.toMatchObject(identity);
    await expect(store.freeze({ ...identity, trialBudget: 2 })).rejects.toThrow(
      "STRATEGY_STUDY_LEDGER_IDENTITY_CONFLICT",
    );
    const attempt = {
      attemptId: randomUUID(),
      candidateIdentity: "9".repeat(64),
      status: "FAILED" as const,
      outcome: { reason: "NO_CANDIDATES" },
    };
    const candidateInput = candidate("candidate-a");
    attempt.candidateIdentity = candidateInput.candidateIdentity;
    const claimRequest = { attemptId: attempt.attemptId, ...candidateInput };
    await expect(
      store.claim(
        studyId,
        { ...claimRequest, candidateIdentity: "f".repeat(64) },
        fence(jobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_TRIAL_CANDIDATE_IDENTITY_MISMATCH");
    const claim = await store.claim(studyId, claimRequest, fence(jobId));
    await expect(
      store.claim(studyId, claimRequest, fence(jobId)),
    ).resolves.toEqual(claim);
    await expect(
      store.claim(
        studyId,
        { ...claimRequest, attemptId: randomUUID() },
        fence(jobId),
      ),
    ).resolves.toEqual(claim);
    await expect(
      store.claim(
        studyId,
        { ...claimRequest, ...candidate("candidate-conflict") },
        fence(jobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_TRIAL_CLAIM_CONFLICT");
    await expect(
      store.claim(studyId, claimRequest, {
        ...fence(jobId),
        leaseOwner: "wrong-worker",
      }),
    ).rejects.toThrow("STRATEGY_STUDY_AUTHORIZATION_INVALID");
    await expect(
      store.append(studyId, attempt, {
        ...fence(jobId),
        attemptCount: 2,
      }),
    ).rejects.toThrow("STRATEGY_STUDY_AUTHORIZATION_INVALID");
    await expect(store.append(studyId, attempt, fence(jobId))).resolves.toEqual(
      attempt,
    );
    await expect(
      store.claim(
        studyId,
        { ...claimRequest, attemptId: randomUUID() },
        fence(jobId),
      ),
    ).resolves.toMatchObject({ status: "COMPLETED", terminalAttempt: attempt });
    await expect(store.append(studyId, attempt, fence(jobId))).resolves.toEqual(
      attempt,
    );
    const additionalCandidate = candidate("candidate-budget");
    await expect(
      store.claim(
        studyId,
        { attemptId: randomUUID(), ...additionalCandidate },
        fence(jobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED");
    await expect(store.linkFinalTest(studyId, randomUUID())).rejects.toThrow(
      "STRATEGY_STUDY_TEST_CLAIM_REQUIRED",
    );
    await expect(
      pool.query(
        "UPDATE strategy_study_trial_attempt SET status='SUCCEEDED' WHERE study_id=$1",
        [studyId],
      ),
    ).rejects.toThrow("IMMUTABLE_STRATEGY_LEARNING_LEDGER");
    await expect(
      pool.query(
        "UPDATE strategy_study_trial_claim SET candidate_identity='7' WHERE study_id=$1",
        [studyId],
      ),
    ).rejects.toThrow("IMMUTABLE_STRATEGY_LEARNING_LEDGER");
  });

  it("reserves budget before work and lets a restarted worker resume the exact claim", async () => {
    const ledger = await createDirectLedger();
    const attemptId = randomUUID();
    const candidateInput = candidate("candidate-restart");
    const candidateIdentity = candidateInput.candidateIdentity;
    const claimRequest = { attemptId, ...candidateInput };
    const claim = await store.claim(
      ledger.studyId,
      claimRequest,
      fence(ledger.jobId),
    );
    const restartedStore = new PostgresStrategyLearningExperimentStore(pool);
    await expect(
      restartedStore.claim(ledger.studyId, claimRequest, fence(ledger.jobId)),
    ).resolves.toEqual(claim);
    await expect(
      restartedStore.claim(
        ledger.studyId,
        { attemptId: randomUUID(), ...candidate("budget-race") },
        fence(ledger.jobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED");
    await expect(
      restartedStore.append(
        ledger.studyId,
        {
          attemptId,
          candidateIdentity,
          status: "INTERRUPTED",
          outcome: { reason: "process restarted before receipt" },
        },
        fence(ledger.jobId),
      ),
    ).resolves.toMatchObject({ status: "INTERRUPTED" });
  });

  it("retains an insufficient candidate trial with its frozen evaluation receipt", async () => {
    const ledger = await createDirectLedger();
    const attemptId = randomUUID();
    const candidateSpec = {
      version: "bounded-rule-candidate-v1",
      searchSpaceHash: "a".repeat(64),
      value: "bounded-candidate",
    };
    const candidateInput = {
      candidateIdentity: contentHash(candidateSpec),
      candidateSpec,
    };
    const claim = { attemptId, ...candidateInput };
    await store.claim(ledger.studyId, claim, fence(ledger.jobId));
    const outcome = {
      candidateIdentity: claim.candidateIdentity,
      candidateSpec: claim.candidateSpec,
      matchedEconomicEvaluation: {
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["INSUFFICIENT_PAIRED_SESSIONS"],
        baselineRunIds: ["baseline-run"],
        challengerRunIds: ["challenger-run"],
      },
    };
    const attempt = {
      attemptId,
      candidateIdentity: claim.candidateIdentity,
      status: "INSUFFICIENT_EVIDENCE" as const,
      outcome,
    };
    await expect(
      store.append(ledger.studyId, attempt, fence(ledger.jobId)),
    ).resolves.toEqual(attempt);
    const persisted = await pool.query(
      "SELECT status,outcome FROM strategy_study_trial_attempt WHERE study_id=$1 AND attempt_id=$2",
      [ledger.studyId, attemptId],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      outcome,
    });
    await expect(
      store.claim(
        ledger.studyId,
        { attemptId: randomUUID(), ...candidate("second-candidate") },
        fence(ledger.jobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED");
  });

  it("serializes concurrent claims so one candidate receives the final budget slot", async () => {
    const ledger = await createDirectLedger();
    const results = await Promise.allSettled([
      store.claim(
        ledger.studyId,
        { attemptId: randomUUID(), ...candidate("race-a") },
        fence(ledger.jobId),
      ),
      store.claim(
        ledger.studyId,
        { attemptId: randomUUID(), ...candidate("race-b") },
        fence(ledger.jobId),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toBe(
      "STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED",
    );
  });

  it("rejects authority mismatches and stops writes after authorization revocation", async () => {
    await expect(
      store.freeze({
        ...identity,
        authority: { kind: "DIRECT_SUBMISSION", grantId: randomUUID() },
      }),
    ).rejects.toThrow("STRATEGY_STUDY_AUTHORIZATION_INVALID");
    const spec = {
      experimentId: secondStudyId,
      binding,
      comparison: { marketId: "CA_TSX" },
    };
    await pool.query(
      "INSERT INTO strategy_study(id,market_id,spec_hash,spec) VALUES($1,'CA_TSX',$2,$3::jsonb)",
      [secondStudyId, secondHash, JSON.stringify(spec)],
    );
    const authorizedJobId = randomUUID();
    await pool.query(
      `INSERT INTO research_job(id,job_type,status,request_payload,attempt_count,max_attempts,lease_owner,lease_expires_at,heartbeat_at,started_at)
      VALUES($1,'STRATEGY_STUDY','RUNNING',$2::jsonb,1,3,'ledger-test',NOW()+INTERVAL '1 hour',NOW(),NOW())`,
      [authorizedJobId, JSON.stringify({ plan: spec })],
    );
    await pool.query(
      `INSERT INTO study_execution_authorization(id,market_id,frozen_plan_hash,prerequisite_policy_hash,source_window_start,source_window_end,engine_revision,runtime_fingerprint,expires_at,max_studies,max_session_executions,mode,plan,idempotency_key)
      VALUES($1,'CA_TSX',$2,$3,'2026-09-01','2026-09-10',$4,$5,NOW()+INTERVAL '1 day',1,10,'EXECUTE_WHEN_READY',$6::jsonb,$7)`,
      [
        authorizeId,
        secondHash,
        "7".repeat(64),
        binding.engineRevision,
        binding.runtimeFingerprint,
        JSON.stringify(spec),
        randomUUID(),
      ],
    );
    await pool.query(
      "UPDATE study_execution_authorization SET dispatched_job_id=$2 WHERE id=$1",
      [authorizeId, authorizedJobId],
    );
    const authorized = {
      ...identity,
      studyId: secondStudyId,
      studySpecHash: secondHash,
      authority: {
        kind: "EXECUTE_WHEN_READY" as const,
        authorizationId: authorizeId,
      },
    };
    await store.freeze(authorized);
    const revokedAttemptId = randomUUID();
    const revokedCandidate = candidate("revoked");
    await store.claim(
      secondStudyId,
      { attemptId: revokedAttemptId, ...revokedCandidate },
      fence(authorizedJobId),
    );
    await pool.query(
      "UPDATE study_execution_authorization SET revoked_at=NOW() WHERE id=$1",
      [authorizeId],
    );
    await expect(
      store.claim(
        secondStudyId,
        { attemptId: randomUUID(), ...candidate("post-revoke") },
        fence(authorizedJobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_AUTHORIZATION_INVALID");
    await expect(
      store.append(
        secondStudyId,
        {
          attemptId: revokedAttemptId,
          candidateIdentity: revokedCandidate.candidateIdentity,
          status: "CANCELED",
          outcome: { reason: "revoked" },
        },
        fence(authorizedJobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_AUTHORIZATION_INVALID");
  });

  it("rejects prepare-only, undispatched, expired, and terminal execution jobs", async () => {
    const makeAuthorized = async (
      mode: "PREPARE_ONLY" | "EXECUTE_WHEN_READY",
      dispatched: boolean,
    ) => {
      const id = randomUUID();
      const hash = randomUUID()
        .replaceAll("-", "")
        .padEnd(64, "1")
        .slice(0, 64);
      const authId = randomUUID();
      const plan = {
        experimentId: id,
        binding,
        comparison: { marketId: "CA_TSX" },
      };
      const nextJobId = randomUUID();
      await pool.query(
        `INSERT INTO research_job(id,job_type,status,request_payload,attempt_count,max_attempts,lease_owner,lease_expires_at,heartbeat_at,started_at)
      VALUES($1,'STRATEGY_STUDY','RUNNING',$2::jsonb,1,3,'ledger-test',NOW()+INTERVAL '1 hour',NOW(),NOW())`,
        [nextJobId, JSON.stringify({ plan })],
      );
      await pool.query(
        "INSERT INTO strategy_study(id,market_id,spec_hash,spec) VALUES($1,'CA_TSX',$2,$3::jsonb)",
        [id, hash, JSON.stringify(plan)],
      );
      await pool.query(
        `INSERT INTO study_execution_authorization(id,market_id,frozen_plan_hash,prerequisite_policy_hash,source_window_start,source_window_end,engine_revision,runtime_fingerprint,expires_at,max_studies,max_session_executions,mode,plan,idempotency_key,dispatched_job_id)
        VALUES($1,'CA_TSX',$2,$3,'2026-09-01','2026-09-10',$4,$5,NOW()+INTERVAL '1 day',1,10,$6,$7::jsonb,$8,$9)`,
        [
          authId,
          hash,
          "7".repeat(64),
          binding.engineRevision,
          binding.runtimeFingerprint,
          mode,
          JSON.stringify(plan),
          randomUUID(),
          dispatched ? nextJobId : null,
        ],
      );
      return {
        id,
        hash,
        authId,
        jobId: nextJobId,
        identity: {
          ...identity,
          studyId: id,
          studySpecHash: hash,
          authority: {
            kind: "EXECUTE_WHEN_READY" as const,
            authorizationId: authId,
          },
        },
      };
    };

    const prepareOnly = await makeAuthorized("PREPARE_ONLY", true);
    await expect(store.freeze(prepareOnly.identity)).rejects.toThrow(
      "STRATEGY_STUDY_AUTHORIZATION_INVALID",
    );
    const undispatched = await makeAuthorized("EXECUTE_WHEN_READY", false);
    await expect(store.freeze(undispatched.identity)).rejects.toThrow(
      "STRATEGY_STUDY_AUTHORIZATION_INVALID",
    );

    const expired = await makeAuthorized("EXECUTE_WHEN_READY", true);
    await store.freeze(expired.identity);
    const expiredAttemptId = randomUUID();
    const expiredCandidate = candidate("expired");
    await store.claim(
      expired.id,
      { attemptId: expiredAttemptId, ...expiredCandidate },
      fence(expired.jobId),
    );
    await pool.query(
      "UPDATE research_job SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [expired.jobId],
    );
    await expect(
      store.append(
        expired.id,
        {
          attemptId: expiredAttemptId,
          candidateIdentity: expiredCandidate.candidateIdentity,
          status: "INTERRUPTED",
          outcome: { reason: "lease expired" },
        },
        fence(expired.jobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_AUTHORIZATION_INVALID");

    const terminalId = randomUUID();
    const terminalHash = "4".repeat(64);
    const terminalJobId = randomUUID();
    const terminalGrantId = randomUUID();
    const terminalPlan = {
      experimentId: terminalId,
      binding,
      comparison: { marketId: "CA_TSX" },
    };
    await pool.query(
      `INSERT INTO research_job(id,job_type,status,request_payload,attempt_count,max_attempts,lease_owner,lease_expires_at,heartbeat_at,started_at)
      VALUES($1,'STRATEGY_STUDY','RUNNING',$2::jsonb,1,3,'ledger-test',NOW()+INTERVAL '1 hour',NOW(),NOW())`,
      [terminalJobId, JSON.stringify({ plan: terminalPlan })],
    );
    await pool.query(
      "INSERT INTO strategy_study(id,market_id,spec_hash,spec) VALUES($1,'CA_TSX',$2,$3::jsonb)",
      [terminalId, terminalHash, JSON.stringify(terminalPlan)],
    );
    await pool.query(
      `INSERT INTO study_execution_grant(id,kind,job_id,experiment_id,market_id,plan_hash,plan,admitted_executions)
      VALUES($1,'DIRECT_SUBMISSION',$2,$3,'CA_TSX',$4,$5::jsonb,1)`,
      [
        terminalGrantId,
        terminalJobId,
        terminalId,
        terminalHash,
        JSON.stringify(terminalPlan),
      ],
    );
    await store.freeze({
      ...identity,
      studyId: terminalId,
      studySpecHash: terminalHash,
      authority: { kind: "DIRECT_SUBMISSION", grantId: terminalGrantId },
    });
    const terminalAttemptId = randomUUID();
    const terminalCandidate = candidate("terminal");
    await store.claim(
      terminalId,
      { attemptId: terminalAttemptId, ...terminalCandidate },
      fence(terminalJobId),
    );
    await pool.query(
      "UPDATE research_job SET status='CANCELLED',completed_at=NOW() WHERE id=$1",
      [terminalJobId],
    );
    await expect(
      store.append(
        terminalId,
        {
          attemptId: terminalAttemptId,
          candidateIdentity: terminalCandidate.candidateIdentity,
          status: "CANCELED",
          outcome: { reason: "job canceled" },
        },
        fence(terminalJobId),
      ),
    ).rejects.toThrow("STRATEGY_STUDY_AUTHORIZATION_INVALID");
  });
});
