import {
  signalModelResearchAuthorizationRecordSchema,
  signalModelResearchPlanSchema,
  signalModelResearchReportSchema,
  type SignalModelResearchAuthorization,
  type SignalModelResearchAuthorizationRecord,
  type SignalModelResearchPlan,
  type SignalModelResearchDispatch,
  type SignalModelResearchPreflight,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { contentHash, canonicalJson } from "./research-coverage.js";
import { PostgresCanonicalSignalOpportunityCaptureRepository } from "./signal-model-source-preflight.js";
import type {
  CanonicalFinalTestClaimRequest,
  CanonicalFinalTestClaimVerifier,
} from "./signal-model-source-preflight.js";
import type {
  SignalModelJobFence,
  SignalModelStage,
} from "./signal-model-experiment-repository.js";
import { PostgresSignalModelExperimentStore } from "./signal-model-experiment-repository.js";

type AuthorizationDbRow = {
  id: string;
  market_id: SignalModelResearchAuthorization["marketId"];
  source_run_id: string;
  source_digest: string;
  plan_hash: string;
  plan: unknown;
  trial_budget: number;
  mode: SignalModelResearchAuthorization["mode"];
  granted_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  dispatched_job_id: string | null;
  idempotency_key: string;
};

const MAX_SIGNAL_MODEL_RESEARCH_OUTSTANDING = 2;

function record(
  row: AuthorizationDbRow,
): SignalModelResearchAuthorizationRecord {
  return signalModelResearchAuthorizationRecordSchema.parse({
    id: row.id,
    marketId: row.market_id,
    frozenPlanHash: row.plan_hash,
    sourceDigest: row.source_digest,
    sourceBindingHash: (row.plan as SignalModelResearchPlan).source
      .sourceBindingHash,
    expiresAt: row.expires_at.toISOString(),
    trialBudget: row.trial_budget,
    mode: row.mode,
    grantedAt: row.granted_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    dispatchedJobId: row.dispatched_job_id,
  });
}

/** Strict model authority. A grant is created only by the separate dispatch transaction. */
export class PostgresSignalModelResearchControlStore implements CanonicalFinalTestClaimVerifier {
  private readonly sourceReader: PostgresCanonicalSignalOpportunityCaptureRepository;

  constructor(private readonly pool: Pool) {
    this.sourceReader = new PostgresCanonicalSignalOpportunityCaptureRepository(
      pool,
      this,
    );
  }

  consumeFinalTestClaim(request: CanonicalFinalTestClaimRequest) {
    return new PostgresSignalModelExperimentStore(
      this.pool,
    ).consumeFinalTestClaim(request);
  }

  async claimStage(
    authorizationId: string,
    stage: SignalModelStage,
    fence: SignalModelJobFence,
    claimId: string,
    membershipHash: string,
    trialCost = stage === "TRAIN" ? 1 : 0,
  ) {
    const result = await this.pool.query<{
      claim_id: string;
      membership_hash: string;
    }>(
      `INSERT INTO signal_model_research_stage_claim(authorization_id,execution_job_id,stage,claim_id,membership_hash,trial_cost)
       SELECT a.id,$2,$3,$4,$5,$6 FROM signal_model_research_authorization a
       JOIN signal_model_research_execution_grant g ON g.authorization_id=a.id AND g.job_id=$2
       JOIN research_job j ON j.id=g.job_id
       WHERE a.id=$1 AND a.mode='EXECUTE_WHEN_READY' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
         AND j.job_type='SIGNAL_MODEL_RESEARCH' AND j.status='RUNNING' AND j.lease_owner=$7
         AND j.attempt_count=$8 AND j.lease_expires_at>clock_timestamp() AND NOT j.cancellation_requested
       ON CONFLICT(authorization_id,stage) DO NOTHING RETURNING claim_id,membership_hash`,
      [
        authorizationId,
        fence.jobId,
        stage,
        claimId,
        membershipHash,
        trialCost,
        fence.leaseOwner,
        fence.attemptCount,
      ],
    );
    if (result.rows[0]) return result.rows[0];
    const active = await this.pool.query(
      `SELECT 1 FROM signal_model_research_authorization a
       JOIN signal_model_research_execution_grant g ON g.authorization_id=a.id AND g.job_id=$2
       JOIN research_job j ON j.id=g.job_id
       WHERE a.id=$1 AND a.mode='EXECUTE_WHEN_READY' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
         AND j.job_type='SIGNAL_MODEL_RESEARCH' AND j.status='RUNNING' AND j.lease_owner=$3
         AND j.attempt_count=$4 AND j.lease_expires_at>clock_timestamp() AND NOT j.cancellation_requested`,
      [authorizationId, fence.jobId, fence.leaseOwner, fence.attemptCount],
    );
    if (!active.rows.length)
      throw new Error("SIGNAL_MODEL_ACTIVE_JOB_REQUIRED");
    const prior = await this.pool.query<{
      claim_id: string;
      membership_hash: string;
    }>(
      "SELECT claim_id,membership_hash FROM signal_model_research_stage_claim WHERE authorization_id=$1 AND stage=$2",
      [authorizationId, stage],
    );
    if (
      prior.rows[0]?.claim_id === claimId &&
      prior.rows[0].membership_hash === membershipHash
    )
      return prior.rows[0];
    throw new Error("SIGNAL_MODEL_STAGE_CLAIM_CONFLICT_OR_JOB_FENCE_INVALID");
  }

  async appendAttempt(input: {
    authorizationId: string;
    fence: SignalModelJobFence;
    claimId: string;
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
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity = await client.query<{
        plan_hash: string;
        trial_budget: number;
      }>(
        "SELECT plan_hash,trial_budget FROM signal_model_research_authorization WHERE id=$1 FOR UPDATE",
        [input.authorizationId],
      );
      if (!identity.rows[0])
        throw new Error("SIGNAL_MODEL_AUTHORIZATION_NOT_FOUND");
      const old = await client.query<{
        stage: string;
        candidate_identity: string;
        status: string;
        outcome: unknown;
      }>(
        "SELECT stage,candidate_identity,status,outcome FROM signal_model_research_attempt WHERE authorization_id=$1 AND attempt_id=$2",
        [input.authorizationId, input.attemptId],
      );
      if (old.rows[0]) {
        if (
          old.rows[0].stage !== input.stage ||
          old.rows[0].candidate_identity !== input.candidateIdentity ||
          old.rows[0].status !== input.status ||
          canonicalJson(old.rows[0].outcome) !== canonicalJson(input.outcome)
        )
          throw new Error("SIGNAL_MODEL_ATTEMPT_CONFLICT");
        await client.query("COMMIT");
        return;
      }
      const active = await client.query(
        "SELECT 1 FROM signal_model_research_authorization a JOIN signal_model_research_execution_grant g ON g.authorization_id=a.id JOIN research_job j ON j.id=g.job_id WHERE a.id=$1 AND g.job_id=$2 AND a.mode='EXECUTE_WHEN_READY' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND j.job_type='SIGNAL_MODEL_RESEARCH' AND j.status='RUNNING' AND j.lease_owner=$3 AND j.attempt_count=$4 AND j.lease_expires_at>clock_timestamp() AND NOT j.cancellation_requested",
        [
          input.authorizationId,
          input.fence.jobId,
          input.fence.leaseOwner,
          input.fence.attemptCount,
        ],
      );
      if (!active.rows.length)
        throw new Error("SIGNAL_MODEL_ACTIVE_JOB_REQUIRED");
      const claim = await client.query(
        "SELECT 1 FROM signal_model_research_stage_claim WHERE authorization_id=$1 AND claim_id=$2 AND stage=$3",
        [input.authorizationId, input.claimId, input.stage],
      );
      if (!claim.rows.length)
        throw new Error("SIGNAL_MODEL_STAGE_CLAIM_REQUIRED");
      const sequence = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM signal_model_research_attempt WHERE authorization_id=$1",
        [input.authorizationId],
      );
      const attemptNumber = Number(sequence.rows[0]!.n) + 1;
      await client.query(
        "INSERT INTO signal_model_research_attempt(authorization_id,stage,claim_id,attempt_id,attempt_number,candidate_identity,status,outcome,job_lease_owner,job_attempt_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)",
        [
          input.authorizationId,
          input.stage,
          input.claimId,
          input.attemptId,
          attemptNumber,
          input.candidateIdentity,
          input.status,
          JSON.stringify(input.outcome),
          input.fence.leaseOwner,
          input.fence.attemptCount,
        ],
      );
      if (input.stage === "VALIDATION" && input.status === "SUCCEEDED") {
        const selected = await client.query(
          "INSERT INTO signal_model_validation_selection(authorization_id,validation_attempt_id,candidate_identity,threshold) VALUES($1,$2,$3,$4)",
          [
            input.authorizationId,
            input.attemptId,
            input.candidateIdentity,
            input.outcome.selectedThreshold,
          ],
        );
        void selected;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordReport(input: {
    authorizationId: string;
    fence: SignalModelJobFence;
    report: {
      experimentId: string;
      sourceDigest: string;
      planHash: string;
      status:
        "WAITING" | "INSUFFICIENT" | "COMPLETED" | "INTERRUPTED" | "FAILED";
      selectedCandidateIdentity: string | null;
      selectedThreshold: number | null;
      evaluation: Record<string, unknown> | null;
      reasonCodes: string[];
    };
  }): Promise<void> {
    const job = await this.pool.query(
      "SELECT 1 FROM signal_model_research_authorization a JOIN signal_model_research_execution_grant g ON g.authorization_id=a.id JOIN research_job j ON j.id=g.job_id WHERE a.id=$1 AND g.job_id=$2 AND a.mode='EXECUTE_WHEN_READY' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND j.job_type='SIGNAL_MODEL_RESEARCH' AND j.status='RUNNING' AND j.lease_owner=$3 AND j.attempt_count=$4 AND j.lease_expires_at>clock_timestamp() AND NOT j.cancellation_requested",
      [
        input.authorizationId,
        input.fence.jobId,
        input.fence.leaseOwner,
        input.fence.attemptCount,
      ],
    );
    if (!job.rows.length) throw new Error("SIGNAL_MODEL_ACTIVE_JOB_REQUIRED");
    const duplicate = await this.pool.query<{
      experiment_id: string;
      source_digest: string;
      plan_hash: string;
      status: string;
      selected_candidate_identity: string | null;
      selected_threshold: number | null;
      evaluation: unknown;
      reason_codes: string[];
    }>(
      "SELECT experiment_id,source_digest,plan_hash,status,selected_candidate_identity,selected_threshold,evaluation,reason_codes FROM signal_model_research_report WHERE authorization_id=$1",
      [input.authorizationId],
    );
    if (duplicate.rows[0]) {
      const old = duplicate.rows[0];
      const same =
        old.experiment_id === input.report.experimentId &&
        old.source_digest === input.report.sourceDigest &&
        old.plan_hash === input.report.planHash &&
        old.status === input.report.status &&
        old.selected_candidate_identity ===
          input.report.selectedCandidateIdentity &&
        old.selected_threshold === input.report.selectedThreshold &&
        canonicalJson(old.evaluation) ===
          canonicalJson(input.report.evaluation) &&
        canonicalJson(old.reason_codes) ===
          canonicalJson(input.report.reasonCodes);
      if (!same) throw new Error("SIGNAL_MODEL_REPORT_IDEMPOTENCY_CONFLICT");
      return;
    }
    const selected = await this.pool.query<{ id: string }>(
      "SELECT id FROM signal_model_research_authorization WHERE id=$1",
      [input.authorizationId],
    );
    if (!selected.rows.length)
      throw new Error("SIGNAL_MODEL_AUTHORIZATION_NOT_FOUND");
    await this.pool.query(
      `INSERT INTO signal_model_research_report(authorization_id,experiment_id,source_digest,plan_hash,job_id,status,selected_candidate_identity,selected_threshold,evaluation,reason_codes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
      [
        input.authorizationId,
        input.report.experimentId,
        input.report.sourceDigest,
        input.report.planHash,
        input.fence.jobId,
        input.report.status,
        input.report.selectedCandidateIdentity,
        input.report.selectedThreshold,
        input.report.evaluation === null
          ? null
          : JSON.stringify(input.report.evaluation),
        JSON.stringify(input.report.reasonCodes),
      ],
    );
  }

  async createAuthorization(input: {
    authorization: SignalModelResearchAuthorization;
    plan: SignalModelResearchPlan;
    idempotencyKey: string;
  }): Promise<SignalModelResearchAuthorizationRecord> {
    const plan = signalModelResearchPlanSchema.parse(input.plan);
    const auth = input.authorization;
    if (contentHash(plan) !== auth.frozenPlanHash)
      throw new Error("SIGNAL_MODEL_AUTHORIZATION_PLAN_MISMATCH");
    if (
      auth.marketId !== plan.source.marketId ||
      auth.sourceDigest !== plan.source.sourceDigest ||
      auth.sourceBindingHash !== plan.source.sourceBindingHash ||
      auth.trialBudget !== plan.trialBudget
    )
      throw new Error("SIGNAL_MODEL_AUTHORIZATION_SCOPE_MISMATCH");
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)
      throw new Error("SIGNAL_MODEL_IDEMPOTENCY_KEY_INVALID");
    await this.assertCanonicalSource(plan);

    const saved = await this.pool.query<AuthorizationDbRow>(
      `INSERT INTO signal_model_research_authorization
       (id,market_id,source_run_id,source_digest,plan_hash,plan,trial_budget,mode,expires_at,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        auth.id,
        auth.marketId,
        plan.source.runId,
        auth.sourceDigest,
        auth.frozenPlanHash,
        JSON.stringify(plan),
        auth.trialBudget,
        auth.mode,
        auth.expiresAt,
        input.idempotencyKey,
      ],
    );
    if (saved.rows[0]) return record(saved.rows[0]);
    const existing = await this.pool.query<AuthorizationDbRow>(
      "SELECT * FROM signal_model_research_authorization WHERE id=$1 OR idempotency_key=$2",
      [auth.id, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("SIGNAL_MODEL_AUTHORIZATION_SAVE_RACE");
    if (
      row.id !== auth.id ||
      row.plan_hash !== auth.frozenPlanHash ||
      row.mode !== auth.mode ||
      row.expires_at.toISOString() !== new Date(auth.expiresAt).toISOString() ||
      canonicalJson(row.plan) !== canonicalJson(plan)
    )
      throw new Error("SIGNAL_MODEL_AUTHORIZATION_CONFLICT");
    return record(row);
  }

  async preflight(
    planInput: SignalModelResearchPlan,
  ): Promise<SignalModelResearchPreflight> {
    const plan = signalModelResearchPlanSchema.parse(planInput);
    const scope = {
      runId: plan.source.runId,
      marketId: plan.source.marketId,
      strategy: plan.source.strategy,
      strategyVersion: plan.source.strategyVersion,
      configVersion: plan.source.configVersion,
      profileId: plan.source.profileId,
      profileName: plan.source.profileName,
      executionModelVersion: plan.source.executionModelVersion,
      executionAssumptionsHash: plan.source.executionAssumptionsHash,
    };
    const source = await this.sourceReader.loadForSource({
      scope,
      expectedSessions: plan.sessions,
    });
    const captures =
      source.status === "AVAILABLE" ? source.orderedCaptures : [];
    const rows = (stage: "TRAIN" | "VALIDATION" | "TEST") =>
      captures.filter((row) => row.stage === stage);
    const blockers =
      source.status === "AVAILABLE" ? [] : [...source.reasonCodes];
    if (source.status === "AVAILABLE") {
      if (
        source.sourceDigest !== plan.source.sourceDigest ||
        source.sourceBindingHash !== plan.source.sourceBindingHash ||
        source.orderedMembershipHash !== plan.source.orderedMembershipHash ||
        source.orderedMembershipCount !== plan.source.orderedMembershipCount
      )
        blockers.push("FROZEN_SOURCE_IDENTITY_MISMATCH");
      if (source.testMembershipHash !== plan.membership.TEST.membershipHash)
        blockers.push("FROZEN_TEST_MEMBERSHIP_MISMATCH");
      if (
        source.sourceRunIdentity.status !== "COMPLETED" ||
        source.sourceRunIdentity.runId !== plan.source.runId ||
        source.sourceRunIdentity.marketId !== plan.source.marketId ||
        source.sourceRunIdentity.strategyVersion !==
          plan.source.strategyVersion ||
        source.sourceRunIdentity.configVersion !== plan.source.configVersion ||
        source.sourceRunIdentity.executionModelVersion !==
          plan.source.executionModelVersion ||
        source.sourceRunIdentity.executionAssumptionsHash !==
          plan.source.executionAssumptionsHash
      )
        blockers.push("SOURCE_RUN_IDENTITY_MISMATCH");
      for (const stage of ["TRAIN", "VALIDATION", "TEST"] as const) {
        const actual = rows(stage).map((row) => row.opportunityId);
        const expectedIds = plan.membership[stage].opportunityIds;
        const expectedHash = contentHash({
          sourceRunId: plan.source.runId,
          marketId: plan.source.marketId,
          sessionDates: plan.sessions[stage],
          opportunityIds: expectedIds,
        });
        if (
          canonicalJson(actual) !== canonicalJson(expectedIds) ||
          plan.membership[stage].membershipHash !== expectedHash
        )
          blockers.push(`${stage}_MEMBERSHIP_MISMATCH`);
      }
    }
    const selectedTrain = rows("TRAIN").filter((row) => row.baselineSelected);
    const selectedValidation = rows("VALIDATION").filter(
      (row) => row.baselineSelected,
    );
    const usableTrainingRows = selectedTrain.filter(
      (row) =>
        row.outcome?.status === "CLOSED" && row.labelAvailableAt !== null,
    ).length;
    const independentSessions = new Set(
      selectedTrain
        .filter((row) => row.outcome?.status === "CLOSED")
        .map((row) => row.sessionDate),
    ).size;
    const validationSessions = new Set(
      selectedValidation
        .filter((row) => row.outcome !== null)
        .map((row) => row.sessionDate),
    ).size;
    const closedDevelopmentRows = [
      ...selectedTrain,
      ...selectedValidation,
    ].filter((row) => row.outcome?.status === "CLOSED").length;
    const estimatedPower = estimateSignalModelPower(
      selectedTrain,
      plan.comparison.minimumUsefulNetPnlPerSelectedOpportunity,
      plan.comparison.minimumIndependentSessions,
      plan.comparison.alpha,
    );
    if (source.status === "AVAILABLE") {
      if (usableTrainingRows < plan.model.minimumTrainingSamples)
        blockers.push("TRAINING_SAMPLE_FLOOR_NOT_MET");
      if (closedDevelopmentRows < plan.comparison.minimumClosedOutcomes)
        blockers.push("CLOSED_DEVELOPMENT_OUTCOME_FLOOR_NOT_MET");
      if (
        [...selectedTrain, ...selectedValidation].some(
          (row) => row.outcome?.status === "INVALID",
        )
      )
        blockers.push("INVALID_DEVELOPMENT_OUTCOME_PRESENT");
      if (independentSessions < plan.comparison.minimumIndependentSessions)
        blockers.push("INDEPENDENT_TRAINING_SESSION_FLOOR_NOT_MET");
      if (validationSessions < plan.comparison.minimumValidationSessions)
        blockers.push("VALIDATION_SESSION_FLOOR_NOT_MET");
      if (
        plan.sessions.TEST.length < plan.comparison.minimumIndependentSessions
      )
        blockers.push("TEST_SESSION_FLOOR_NOT_MET");
      if (estimatedPower === null)
        blockers.push("PREDECLARED_POWER_NOT_ESTIMABLE");
      else if (estimatedPower < plan.comparison.targetPower)
        blockers.push("PREDECLARED_POWER_TARGET_NOT_MET");
    }
    const status =
      source.status !== "AVAILABLE"
        ? "UNAVAILABLE"
        : blockers.length
          ? "WAITING"
          : "READY";
    return {
      status,
      marketId: plan.source.marketId,
      sourceRunId: plan.source.runId,
      sourceDigest: source.status === "AVAILABLE" ? source.sourceDigest : null,
      sourceBindingHash:
        source.status === "AVAILABLE" ? source.sourceBindingHash : null,
      stageCounts: {
        TRAIN: rows("TRAIN").length,
        VALIDATION: rows("VALIDATION").length,
        TEST: rows("TEST").length,
      },
      usableTrainingRows,
      independentSessions,
      estimatedPower,
      estimatedPowerMethod:
        estimatedPower === null
          ? null
          : "UNVALIDATED_TRAINING_SESSION_MEAN_PROXY",
      estimatedPowerLimitations: [
        "Proxy uses baseline-selected TRAIN session net outcomes and a normal approximation.",
        "It is not a paired candidate-minus-baseline variance estimate or a formal design power analysis.",
      ],
      blockers,
      missingFields:
        source.status === "AVAILABLE" ? [] : [...source.missingFields],
    };
  }

  async getAuthorization(
    id: string,
  ): Promise<SignalModelResearchAuthorizationRecord | null> {
    const result = await this.pool.query<AuthorizationDbRow>(
      "SELECT * FROM signal_model_research_authorization WHERE id=$1",
      [id],
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async getReadiness(id: string) {
    const result = await this.pool.query<{
      mode: string;
      revoked_at: Date | null;
      expires_at: Date;
      dispatched_job_id: string | null;
      job_status: string | null;
      check_status: "WAITING" | "READY" | "UNAVAILABLE" | null;
      report_status: string | null;
      blockers: string[] | null;
      pending_claims: string[] | null;
      checked_at: Date | null;
      next_action: string | null;
    }>(
      `SELECT a.mode,a.revoked_at,a.expires_at,a.dispatched_job_id,j.status AS job_status,r.status AS report_status,
        c.status AS check_status,c.blockers,c.checked_at,c.next_action,
        pending.stages AS pending_claims
       FROM signal_model_research_authorization a
       LEFT JOIN research_job j ON j.id=a.dispatched_job_id
       LEFT JOIN signal_model_research_report r ON r.authorization_id=a.id
       LEFT JOIN LATERAL (SELECT status,blockers,checked_at,next_action FROM signal_model_research_readiness_check WHERE authorization_id=a.id ORDER BY checked_at DESC,id DESC LIMIT 1) c ON true
       LEFT JOIN LATERAL (SELECT array_agg(s.stage || CASE WHEN s.consumed_at IS NULL THEN ':CLAIMED_WITHOUT_ATTEMPT' ELSE ':TEST_CONSUMED_WITHOUT_ATTEMPT' END ORDER BY s.stage) AS stages
         FROM signal_model_research_stage_claim s LEFT JOIN signal_model_research_attempt p ON p.authorization_id=s.authorization_id AND p.claim_id=s.claim_id
         WHERE s.authorization_id=a.id AND p.attempt_id IS NULL) pending ON true
       WHERE a.id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    let status:
      | "PREPARE_ONLY"
      | "WAITING"
      | "READY"
      | "DISPATCHED"
      | "REVOKED"
      | "EXPIRED"
      | "COMPLETED"
      | "INSUFFICIENT"
      | "FAILED";
    let nextAction: string;
    if (row.revoked_at) {
      status = "REVOKED";
      nextAction = "No action; authorization is revoked.";
    } else if (row.expires_at <= new Date()) {
      status = "EXPIRED";
      nextAction = "Create a new explicitly authorized frozen experiment.";
    } else if (
      row.dispatched_job_id &&
      row.job_status === "SUCCEEDED" &&
      row.report_status === "INSUFFICIENT"
    ) {
      status = "INSUFFICIENT";
      nextAction =
        "Review the insufficient inactive research report and blockers.";
    } else if (row.dispatched_job_id && row.job_status === "SUCCEEDED") {
      status = "COMPLETED";
      nextAction = "Review the inactive research report.";
    } else if (
      row.dispatched_job_id &&
      ["FAILED", "CANCELLED", "INTERRUPTED"].includes(row.job_status ?? "")
    ) {
      status = "FAILED";
      nextAction = "Review the failed job and immutable phase receipts.";
    } else if (row.dispatched_job_id) {
      status = "DISPATCHED";
      nextAction = "Wait for the bounded research job to finish.";
    } else if (row.mode === "PREPARE_ONLY") {
      status = "PREPARE_ONLY";
      nextAction =
        "An explicit EXECUTE_WHEN_READY authorization is required before automatic dispatch.";
    } else if (row.check_status === "READY") {
      status = "READY";
      nextAction = "The bounded scheduler will dispatch this authorized plan.";
    } else {
      status = "WAITING";
      nextAction = "The bounded scheduler will recheck exact source readiness.";
    }
    return {
      authorizationId: id,
      mode: row.mode as "PREPARE_ONLY" | "EXECUTE_WHEN_READY",
      status,
      blockers: [...(row.blockers ?? []), ...(row.pending_claims ?? [])],
      lastCheckedAt: row.checked_at?.toISOString() ?? null,
      nextAction,
    };
  }

  async getReport(id: string) {
    const result = await this.pool.query<{
      experiment_id: string;
      authorization_id: string;
      source_digest: string;
      plan_hash: string;
      status: string;
      selected_candidate_identity: string | null;
      selected_threshold: number | null;
      evaluation: unknown;
      reason_codes: string[];
      candidate_model_id: string | null;
    }>(
      `SELECT r.experiment_id,r.authorization_id,r.source_digest,r.plan_hash,r.status,
              r.selected_candidate_identity,r.selected_threshold,r.evaluation,r.reason_codes,
              m.id candidate_model_id
         FROM signal_model_research_report r
         LEFT JOIN statistical_model m ON m.signal_model_research_authorization_id=r.authorization_id
        WHERE r.authorization_id=$1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? signalModelResearchReportSchema.parse({
          experimentId: row.experiment_id,
          authorizationId: row.authorization_id,
          candidateModelId: row.candidate_model_id,
          sourceDigest: row.source_digest,
          planHash: row.plan_hash,
          status: row.status,
          selectedCandidateIdentity: row.selected_candidate_identity,
          selectedThreshold: row.selected_threshold,
          evaluation: row.evaluation,
          reasonCodes: row.reason_codes,
        })
      : null;
  }

  async dispatchAuthorizedReady(limit = 2): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error("SIGNAL_MODEL_DISPATCH_BATCH_INVALID");
    const pending = await this.pool.query<{ id: string }>(
      `SELECT id FROM signal_model_research_authorization
       WHERE mode='EXECUTE_WHEN_READY' AND revoked_at IS NULL AND dispatched_job_id IS NULL AND expires_at>clock_timestamp()
       ORDER BY granted_at,id LIMIT $1`,
      [limit],
    );
    let count = 0;
    for (const { id } of pending.rows) {
      try {
        const result = await this.dispatch(id, `signal-model-research:${id}`);
        if (result.state === "DISPATCHED") count++;
      } catch {
        /* One bad/stale authorization must not stop this bounded scan. */
      }
    }
    return count;
  }

  async assertJobAuthority(input: {
    authorizationId: string;
    planHash: string;
    plan: SignalModelResearchPlan;
    jobId: string;
  }): Promise<void> {
    const result = await this.pool.query<{ plan: unknown; plan_hash: string }>(
      `SELECT a.plan,a.plan_hash FROM signal_model_research_authorization a
       JOIN signal_model_research_execution_grant g ON g.authorization_id=a.id AND g.job_id=$3
       JOIN research_job j ON j.id=g.job_id
       WHERE a.id=$1 AND a.plan_hash=$2 AND a.dispatched_job_id=$3
         AND a.mode='EXECUTE_WHEN_READY' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
         AND j.job_type='SIGNAL_MODEL_RESEARCH' AND j.status='RUNNING' AND j.lease_expires_at>clock_timestamp() AND NOT j.cancellation_requested`,
      [input.authorizationId, input.planHash, input.jobId],
    );
    if (
      !result.rows[0] ||
      canonicalJson(result.rows[0].plan) !== canonicalJson(input.plan) ||
      result.rows[0].plan_hash !== input.planHash ||
      contentHash(input.plan) !== input.planHash
    )
      throw new Error("SIGNAL_MODEL_JOB_AUTHORITY_MISMATCH");
  }

  async listAuthorizations(
    marketId: SignalModelResearchAuthorization["marketId"],
    limit = 100,
  ): Promise<SignalModelResearchAuthorizationRecord[]> {
    const result = await this.pool.query<AuthorizationDbRow>(
      "SELECT * FROM signal_model_research_authorization WHERE market_id=$1 ORDER BY granted_at DESC LIMIT $2",
      [marketId, limit],
    );
    return result.rows.map(record);
  }

  async revoke(
    id: string,
    idempotencyKey: string,
  ): Promise<SignalModelResearchAuthorizationRecord | null> {
    if (!idempotencyKey.trim())
      throw new Error("SIGNAL_MODEL_REVOCATION_INVALID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query<AuthorizationDbRow>(
        "SELECT * FROM signal_model_research_authorization WHERE id=$1 FOR UPDATE",
        [id],
      );
      const row = prior.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      if (row.revoked_at) {
        const key = await client.query<{
          revoke_idempotency_key: string | null;
        }>(
          "SELECT revoke_idempotency_key FROM signal_model_research_authorization WHERE id=$1",
          [id],
        );
        if (key.rows[0]?.revoke_idempotency_key !== idempotencyKey)
          throw new Error("SIGNAL_MODEL_REVOCATION_CONFLICT");
        await client.query("COMMIT");
        return record(row);
      }
      const updated = await client.query<AuthorizationDbRow>(
        "UPDATE signal_model_research_authorization SET revoked_at=transaction_timestamp(),revoke_idempotency_key=$2 WHERE id=$1 RETURNING *",
        [id, idempotencyKey],
      );
      await client.query("COMMIT");
      return record(updated.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async dispatch(
    id: string,
    idempotencyKey: string,
  ): Promise<SignalModelResearchDispatch> {
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<AuthorizationDbRow>(
        "SELECT * FROM signal_model_research_authorization WHERE id=$1 FOR UPDATE",
        [id],
      );
      const auth = selected.rows[0];
      if (!auth) throw new Error("SIGNAL_MODEL_AUTHORIZATION_NOT_FOUND");
      if (auth.revoked_at) {
        await client.query("COMMIT");
        return { state: "REVOKED" };
      }
      if (auth.dispatched_job_id) {
        await client.query("COMMIT");
        return { state: "USED" };
      }
      if (auth.mode !== "EXECUTE_WHEN_READY") {
        await client.query("COMMIT");
        return { state: "PREPARE_ONLY" };
      }
      const clock = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      if (auth.expires_at <= clock.rows[0]!.now) {
        await client.query("COMMIT");
        return { state: "EXPIRED" };
      }
      // Serialize every dispatch path (API and periodic scheduler) before
      // counting outstanding work, so concurrent polls cannot exceed the cap.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('signal-model-research-global-dispatch-capacity',0))",
      );
      const outstanding = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM research_job
         WHERE job_type='SIGNAL_MODEL_RESEARCH' AND status IN ('QUEUED','RUNNING','CANCELLING')`,
      );
      if (outstanding.rows[0]!.count >= MAX_SIGNAL_MODEL_RESEARCH_OUTSTANDING) {
        await client.query(
          `INSERT INTO signal_model_research_readiness_check(authorization_id,status,blockers,next_action)
           VALUES($1,'WAITING','["RESEARCH_CAPACITY_FULL"]'::jsonb,'WAIT_FOR_RESEARCH_CAPACITY')`,
          [auth.id],
        );
        await client.query("COMMIT");
        return { state: "WAITING" };
      }
      const plan = signalModelResearchPlanSchema.parse(auth.plan);
      const readiness = await this.preflight(plan);
      await client.query(
        `INSERT INTO signal_model_research_readiness_check(authorization_id,status,blockers,next_action)
         VALUES($1,$2,$3::jsonb,$4)`,
        [
          auth.id,
          readiness.status,
          JSON.stringify(readiness.blockers),
          readiness.status === "READY"
            ? "BOUNDED_EXECUTION_READY"
            : "WAIT_FOR_ELIGIBILITY",
        ],
      );
      if (readiness.status !== "READY") {
        await client.query("COMMIT");
        return { state: "WAITING" };
      }
      const payload = {
        version: "signal-model-research-v1",
        authorizationId: auth.id,
        planHash: auth.plan_hash,
        plan,
      };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO research_job(job_type,idempotency_key,request_payload,priority)
         VALUES('SIGNAL_MODEL_RESEARCH',$1,$2::jsonb,0)
         ON CONFLICT(job_type,idempotency_key) DO NOTHING RETURNING id`,
        [idempotencyKey, JSON.stringify(payload)],
      );
      let jobId = inserted.rows[0]?.id;
      if (!jobId) {
        const old = await client.query<{
          id: string;
          request_payload: unknown;
        }>(
          "SELECT id,request_payload FROM research_job WHERE job_type='SIGNAL_MODEL_RESEARCH' AND idempotency_key=$1 FOR UPDATE",
          [idempotencyKey],
        );
        if (
          !old.rows[0] ||
          canonicalJson(old.rows[0].request_payload) !== canonicalJson(payload)
        )
          throw new Error("SIGNAL_MODEL_DISPATCH_IDEMPOTENCY_CONFLICT");
        jobId = old.rows[0].id;
      }
      await client.query(
        `INSERT INTO signal_model_research_execution_grant(authorization_id,job_id,market_id,source_run_id,source_digest,plan_hash)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          auth.id,
          jobId,
          auth.market_id,
          auth.source_run_id,
          auth.source_digest,
          auth.plan_hash,
        ],
      );
      await client.query(
        "UPDATE signal_model_research_authorization SET dispatched_job_id=$2 WHERE id=$1",
        [auth.id, jobId],
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

  private async assertCanonicalSource(
    plan: SignalModelResearchPlan,
  ): Promise<void> {
    const scope = {
      runId: plan.source.runId,
      marketId: plan.source.marketId,
      strategy: plan.source.strategy,
      strategyVersion: plan.source.strategyVersion,
      configVersion: plan.source.configVersion,
      profileId: plan.source.profileId,
      profileName: plan.source.profileName,
      executionModelVersion: plan.source.executionModelVersion,
      executionAssumptionsHash: plan.source.executionAssumptionsHash,
    };
    const result = await this.sourceReader.loadForSource({
      scope,
      expectedSessions: plan.sessions,
    });
    if (result.status !== "AVAILABLE")
      throw new Error(
        `SIGNAL_MODEL_SOURCE_UNAVAILABLE:${result.reasonCodes.join(",")}`,
      );
    if (
      result.sourceDigest !== plan.source.sourceDigest ||
      result.sourceBindingHash !== plan.source.sourceBindingHash ||
      result.orderedMembershipHash !== plan.source.orderedMembershipHash ||
      result.orderedMembershipCount !== plan.source.orderedMembershipCount ||
      result.testMembershipHash !== plan.membership.TEST.membershipHash ||
      result.sourceRunIdentity.status !== "COMPLETED" ||
      result.sourceRunIdentity.marketId !== plan.source.marketId ||
      result.sourceRunIdentity.executionAssumptionsHash !==
        plan.source.executionAssumptionsHash
    )
      throw new Error("SIGNAL_MODEL_SOURCE_IDENTITY_MISMATCH");
    const byStage = new Map(
      result.orderedCaptures.map((row) => [row.opportunityId, row]),
    );
    for (const stage of ["TRAIN", "VALIDATION", "TEST"] as const) {
      const membership = plan.membership[stage];
      const ids = result.orderedCaptures
        .filter((row) => row.stage === stage)
        .map((row) => row.opportunityId);
      const wanted = [...membership.opportunityIds];
      if (
        canonicalJson(ids) !== canonicalJson(wanted) ||
        membership.membershipHash !==
          contentHash({
            sourceRunId: plan.source.runId,
            marketId: plan.source.marketId,
            sessionDates: plan.sessions[stage],
            opportunityIds: wanted,
          })
      )
        throw new Error(`SIGNAL_MODEL_${stage}_MEMBERSHIP_MISMATCH`);
      for (const id of wanted) {
        const row = byStage.get(id);
        if (!row || row.stage !== stage)
          throw new Error(`SIGNAL_MODEL_${stage}_SOURCE_ROW_MISMATCH`);
        if (
          stage === "TRAIN" &&
          row.labelAvailableAt &&
          new Date(row.labelAvailableAt).toISOString().slice(0, 10) >=
            plan.sessions.VALIDATION[0]!
        )
          throw new Error("SIGNAL_MODEL_TRAIN_LABEL_CHRONOLOGY_INVALID");
        if (
          stage === "VALIDATION" &&
          row.labelAvailableAt &&
          new Date(row.labelAvailableAt).toISOString().slice(0, 10) >=
            plan.sessions.TEST[0]!
        )
          throw new Error("SIGNAL_MODEL_VALIDATION_LABEL_CHRONOLOGY_INVALID");
      }
    }
  }
}

export function estimateSignalModelPower(
  rows: readonly import("./signal-model-source-preflight.js").CanonicalSignalOpportunityCapture[],
  effect: number,
  sessions: number,
  alpha: number,
): number | null {
  const bySession = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.outcome) continue;
    const values = bySession.get(row.sessionDate) ?? [];
    values.push(row.outcome.status === "CLOSED" ? row.outcome.netPnl : 0);
    bySession.set(row.sessionDate, values);
  }
  const means = [...bySession.values()].map(
    (values) => values.reduce((a, b) => a + b, 0) / values.length,
  );
  if (means.length < sessions) return null;
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const sd = Math.sqrt(
    means.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (means.length - 1),
  );
  if (!Number.isFinite(sd)) return null;
  if (sd === 0) return null;
  return normalCdf(
    (effect * Math.sqrt(sessions)) / sd - normalQuantile(1 - alpha),
  );
}

function normalQuantile(p: number): number {
  let low = -8;
  let high = 8;
  for (let i = 0; i < 80; i++) {
    const middle = (low + high) / 2;
    if (normalCdf(middle) < p) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * value);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-value * value);
  return 0.5 * (1 + sign * erf);
}
