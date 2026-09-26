import {
  strategyLearningExperimentIdentitySchema,
  strategyLearningFinalTestLinkSchema,
  strategyLearningTrialAttemptSchema,
  strategyLearningTrialClaimRequestSchema,
  strategyLearningTrialClaimSchema,
  type StrategyLearningExperimentIdentity,
  type StrategyLearningFinalTestLink,
  type StrategyLearningTrialAttempt,
  type StrategyLearningTrialClaim,
  type StrategyLearningTrialClaimRequest,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, contentHash } from "./research-coverage.js";
import type { StrategyLearningExperimentStore } from "./strategy-learning-experiment-service.js";
import type { StudyExecutionFence } from "./strategy-study-service.js";

type LedgerRow = {
  study_id: string;
  study_spec_hash: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  source_digest: string;
  binding: unknown;
  trial_budget: number;
  authority_kind: "EXECUTE_WHEN_READY" | "DIRECT_SUBMISSION";
  authority_id: string;
};

export class PostgresStrategyLearningExperimentStore implements StrategyLearningExperimentStore {
  constructor(private readonly pool: Pool) {}

  async freeze(
    raw: StrategyLearningExperimentIdentity,
  ): Promise<StrategyLearningExperimentIdentity> {
    const identity = strategyLearningExperimentIdentitySchema.parse(raw);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const study = await client.query<{
        spec_hash: string;
        spec: unknown;
        market_id: string;
      }>(
        "SELECT spec_hash,spec,market_id FROM strategy_study WHERE id=$1 FOR UPDATE",
        [identity.studyId],
      );
      const row = study.rows[0];
      if (!row) throw new Error("STRATEGY_STUDY_NOT_FOUND");
      if (
        row.spec_hash !== identity.studySpecHash ||
        row.market_id !== identity.marketId ||
        canonicalJson(
          row.spec && (row.spec as Record<string, unknown>).binding,
        ) !== canonicalJson(identity.binding)
      )
        throw new Error("STRATEGY_STUDY_LEDGER_IDENTITY_MISMATCH");
      await assertAuthority(client, identity);
      await client.query(
        `INSERT INTO strategy_study_trial_ledger(study_id,study_spec_hash,market_id,source_digest,binding,trial_budget,authority_kind,authority_id)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT(study_id) DO NOTHING`,
        [
          identity.studyId,
          identity.studySpecHash,
          identity.marketId,
          identity.sourceDigest,
          JSON.stringify(identity.binding),
          identity.trialBudget,
          identity.authority.kind,
          identity.authority.kind === "EXECUTE_WHEN_READY"
            ? identity.authority.authorizationId
            : identity.authority.grantId,
        ],
      );
      const stored = await getLedger(client, identity.studyId);
      if (!stored || canonicalJson(stored) !== canonicalJson(identity))
        throw new Error("STRATEGY_STUDY_LEDGER_IDENTITY_CONFLICT");
      await client.query("COMMIT");
      return stored;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(
    studyId: string,
  ): Promise<StrategyLearningExperimentIdentity | null> {
    const result = await this.pool.query<LedgerRow>(
      "SELECT * FROM strategy_study_trial_ledger WHERE study_id=$1",
      [studyId],
    );
    return result.rows[0] ? mapLedger(result.rows[0]) : null;
  }

  async claim(
    studyId: string,
    rawClaim: StrategyLearningTrialClaimRequest,
    fence: StudyExecutionFence,
  ): Promise<StrategyLearningTrialClaim> {
    const claim = strategyLearningTrialClaimRequestSchema.parse(rawClaim);
    if (contentHash(claim.candidateSpec) !== claim.candidateIdentity)
      throw new Error("STRATEGY_STUDY_TRIAL_CANDIDATE_IDENTITY_MISMATCH");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ledger = await client.query<LedgerRow>(
        "SELECT * FROM strategy_study_trial_ledger WHERE study_id=$1 FOR UPDATE",
        [studyId],
      );
      const row = ledger.rows[0];
      if (!row) throw new Error("STRATEGY_STUDY_LEDGER_NOT_FOUND");
      const identity = mapLedger(row);
      const jobId = await assertAuthority(client, identity, fence);
      const prior = await client.query<{
        attempt_id: string;
        candidate_identity: string;
        candidate_spec: unknown;
        attempt_number: number;
        job_id: string;
        claimed_at: Date;
        terminal_status: StrategyLearningTrialAttempt["status"] | null;
        terminal_outcome: unknown | null;
      }>(
        `SELECT c.attempt_id,c.candidate_identity,c.candidate_spec,c.attempt_number,c.job_id,c.claimed_at,
                a.status AS terminal_status,a.outcome AS terminal_outcome
           FROM strategy_study_trial_claim c
           LEFT JOIN strategy_study_trial_attempt a USING(study_id,attempt_id)
          WHERE c.study_id=$1
            AND (c.attempt_id=$2 OR c.candidate_identity=$3)
          ORDER BY (c.attempt_id=$2) DESC LIMIT 2`,
        [studyId, claim.attemptId, claim.candidateIdentity],
      );
      if (prior.rows[0]) {
        const value = prior.rows[0];
        if (
          prior.rows.length !== 1 ||
          value.candidate_identity !== claim.candidateIdentity ||
          canonicalJson(value.candidate_spec) !==
            canonicalJson(claim.candidateSpec) ||
          value.job_id !== jobId
        )
          throw new Error("STRATEGY_STUDY_TRIAL_CLAIM_CONFLICT");
        await client.query("COMMIT");
        return strategyLearningTrialClaimSchema.parse({
          studyId,
          studySpecHash: identity.studySpecHash,
          attemptId: value.attempt_id,
          candidateIdentity: value.candidate_identity,
          candidateSpec: value.candidate_spec,
          attemptNumber: value.attempt_number,
          jobId: value.job_id,
          status: value.terminal_status ? "COMPLETED" : "CLAIMED",
          ...(value.terminal_status
            ? {
                terminalAttempt: {
                  attemptId: value.attempt_id,
                  candidateIdentity: value.candidate_identity,
                  status: value.terminal_status,
                  outcome: value.terminal_outcome,
                },
              }
            : {}),
          claimedAt: value.claimed_at.toISOString(),
        });
      }
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM strategy_study_trial_claim WHERE study_id=$1",
        [studyId],
      );
      const attemptNumber = Number(count.rows[0]?.count ?? 0) + 1;
      if (attemptNumber > identity.trialBudget)
        throw new Error("STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED");
      const inserted = await client.query<{ claimed_at: Date }>(
        `INSERT INTO strategy_study_trial_claim(
          study_id,attempt_id,candidate_identity,candidate_spec,attempt_number,
          job_id,job_attempt_count,lease_owner
        ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING claimed_at`,
        [
          studyId,
          claim.attemptId,
          claim.candidateIdentity,
          JSON.stringify(claim.candidateSpec),
          attemptNumber,
          jobId,
          fence.attemptCount,
          fence.leaseOwner,
        ],
      );
      await client.query("COMMIT");
      return strategyLearningTrialClaimSchema.parse({
        studyId,
        studySpecHash: identity.studySpecHash,
        attemptId: claim.attemptId,
        candidateIdentity: claim.candidateIdentity,
        candidateSpec: claim.candidateSpec,
        attemptNumber,
        jobId,
        status: "CLAIMED",
        claimedAt: inserted.rows[0]!.claimed_at.toISOString(),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async append(
    studyId: string,
    raw: StrategyLearningTrialAttempt,
    fence: StudyExecutionFence,
  ): Promise<StrategyLearningTrialAttempt> {
    const attempt = strategyLearningTrialAttemptSchema.parse(raw);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ledger = await client.query<LedgerRow>(
        "SELECT * FROM strategy_study_trial_ledger WHERE study_id=$1 FOR UPDATE",
        [studyId],
      );
      const row = ledger.rows[0];
      if (!row) throw new Error("STRATEGY_STUDY_LEDGER_NOT_FOUND");
      const jobId = await assertAuthority(client, mapLedger(row), fence);
      const claim = await client.query<{
        candidate_identity: string;
        attempt_number: number;
        job_id: string;
      }>(
        `SELECT candidate_identity,attempt_number,job_id
           FROM strategy_study_trial_claim WHERE study_id=$1 AND attempt_id=$2`,
        [studyId, attempt.attemptId],
      );
      const claimRow = claim.rows[0];
      if (!claimRow) throw new Error("STRATEGY_STUDY_TRIAL_CLAIM_REQUIRED");
      if (
        claimRow.candidate_identity !== attempt.candidateIdentity ||
        claimRow.job_id !== jobId
      )
        throw new Error("STRATEGY_STUDY_TRIAL_CLAIM_CONFLICT");
      const prior = await client.query<{
        candidate_identity: string;
        status: string;
        outcome: unknown;
      }>(
        "SELECT candidate_identity,status,outcome FROM strategy_study_trial_attempt WHERE study_id=$1 AND attempt_id=$2",
        [studyId, attempt.attemptId],
      );
      if (prior.rows[0]) {
        const value = {
          attemptId: attempt.attemptId,
          candidateIdentity: prior.rows[0].candidate_identity,
          status: prior.rows[0].status,
          outcome: prior.rows[0].outcome,
        };
        if (canonicalJson(value) !== canonicalJson(attempt))
          throw new Error("TRIAL_ATTEMPT_CONFLICT");
        await client.query("COMMIT");
        return strategyLearningTrialAttemptSchema.parse(value);
      }
      await client.query(
        `INSERT INTO strategy_study_trial_attempt(
          study_id,attempt_id,candidate_identity,attempt_number,status,outcome,
          job_id,job_attempt_count,lease_owner
        ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [
          studyId,
          attempt.attemptId,
          attempt.candidateIdentity,
          claimRow.attempt_number,
          attempt.status,
          JSON.stringify(attempt.outcome),
          jobId,
          fence.attemptCount,
          fence.leaseOwner,
        ],
      );
      await client.query("COMMIT");
      return attempt;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async linkFinalTest(
    studyId: string,
    testClaimId: string,
  ): Promise<StrategyLearningFinalTestLink> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ledger = await client.query<LedgerRow>(
        "SELECT * FROM strategy_study_trial_ledger WHERE study_id=$1 FOR UPDATE",
        [studyId],
      );
      const row = ledger.rows[0];
      if (!row) throw new Error("STRATEGY_STUDY_LEDGER_NOT_FOUND");
      await assertAuthority(client, mapLedger(row));
      const inserted = await client.query<{ linked_at: Date }>(
        `INSERT INTO strategy_study_final_test_link(study_id,study_spec_hash,test_claim_id)
        VALUES($1,$2,$3) ON CONFLICT(study_id) DO NOTHING RETURNING linked_at`,
        [studyId, row.study_spec_hash, testClaimId],
      );
      let linkedAt = inserted.rows[0]?.linked_at;
      if (!linkedAt) {
        const existing = await client.query<{
          study_spec_hash: string;
          test_claim_id: string;
          linked_at: Date;
        }>(
          "SELECT study_spec_hash,test_claim_id,linked_at FROM strategy_study_final_test_link WHERE study_id=$1",
          [studyId],
        );
        const prior = existing.rows[0];
        if (
          !prior ||
          prior.study_spec_hash !== row.study_spec_hash ||
          prior.test_claim_id !== testClaimId
        )
          throw new Error("STRATEGY_STUDY_FINAL_TEST_ALREADY_LINKED");
        linkedAt = prior.linked_at;
      }
      await client.query("COMMIT");
      return strategyLearningFinalTestLinkSchema.parse({
        studyId,
        studySpecHash: row.study_spec_hash,
        testClaimId,
        linkedAt: linkedAt.toISOString(),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function getLedger(
  client: PoolClient,
  studyId: string,
): Promise<StrategyLearningExperimentIdentity | null> {
  const result = await client.query<LedgerRow>(
    "SELECT * FROM strategy_study_trial_ledger WHERE study_id=$1",
    [studyId],
  );
  return result.rows[0] ? mapLedger(result.rows[0]) : null;
}
function mapLedger(row: LedgerRow): StrategyLearningExperimentIdentity {
  return strategyLearningExperimentIdentitySchema.parse({
    studyId: row.study_id,
    studySpecHash: row.study_spec_hash,
    marketId: row.market_id,
    sourceDigest: row.source_digest,
    binding: row.binding,
    trialBudget: row.trial_budget,
    authority:
      row.authority_kind === "EXECUTE_WHEN_READY"
        ? { kind: row.authority_kind, authorizationId: row.authority_id }
        : { kind: row.authority_kind, grantId: row.authority_id },
  });
}
async function assertAuthority(
  client: PoolClient,
  identity: StrategyLearningExperimentIdentity,
  fence?: StudyExecutionFence,
): Promise<string> {
  if (identity.authority.kind === "EXECUTE_WHEN_READY") {
    const result = await client.query<{ valid: boolean; job_id: string }>(
      `SELECT j.id AS job_id,
        a.market_id=$2 AND a.frozen_plan_hash=$3 AND a.mode='EXECUTE_WHEN_READY'
        AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
        AND a.plan=s.spec AND j.job_type='STRATEGY_STUDY'
        AND j.status='RUNNING' AND j.lease_expires_at>clock_timestamp()
        AND NOT j.cancellation_requested
        AND ($5::uuid IS NULL OR j.id=$5::uuid)
        AND ($6::text IS NULL OR j.lease_owner=$6::text)
        AND ($7::integer IS NULL OR j.attempt_count=$7::integer) AS valid
      FROM study_execution_authorization a
      JOIN research_job j ON j.id=a.dispatched_job_id
      JOIN strategy_study s ON s.id=$4
      WHERE a.id=$1 AND s.spec_hash=$3 AND s.market_id=$2
        AND a.plan->>'experimentId'=$4::text
        AND j.request_payload->'plan'=s.spec
      FOR SHARE OF a,j`,
      [
        identity.authority.authorizationId,
        identity.marketId,
        identity.studySpecHash,
        identity.studyId,
        fence?.jobId ?? null,
        fence?.leaseOwner ?? null,
        fence?.attemptCount ?? null,
      ],
    );
    if (!result.rows[0]?.valid)
      throw new Error("STRATEGY_STUDY_AUTHORIZATION_INVALID");
    return result.rows[0].job_id;
  } else {
    const result = await client.query<{ valid: boolean; job_id: string }>(
      `SELECT j.id AS job_id,
        g.kind='DIRECT_SUBMISSION' AND g.experiment_id=$2 AND g.market_id=$3
        AND g.plan_hash=$4 AND g.plan=s.spec AND j.job_type='STRATEGY_STUDY'
        AND j.status='RUNNING' AND j.lease_expires_at>clock_timestamp()
        AND NOT j.cancellation_requested
        AND ($5::uuid IS NULL OR j.id=$5::uuid)
        AND ($6::text IS NULL OR j.lease_owner=$6::text)
        AND ($7::integer IS NULL OR j.attempt_count=$7::integer) AS valid
      FROM study_execution_grant g
      JOIN research_job j ON j.id=g.job_id
      JOIN strategy_study s ON s.id=g.experiment_id
      WHERE g.id=$1 AND s.id=$2 AND s.market_id=$3 AND s.spec_hash=$4
        AND j.request_payload->'plan'=s.spec
      FOR SHARE OF g,j`,
      [
        identity.authority.grantId,
        identity.studyId,
        identity.marketId,
        identity.studySpecHash,
        fence?.jobId ?? null,
        fence?.leaseOwner ?? null,
        fence?.attemptCount ?? null,
      ],
    );
    if (!result.rows[0]?.valid)
      throw new Error("STRATEGY_STUDY_AUTHORIZATION_INVALID");
    return result.rows[0].job_id;
  }
}
