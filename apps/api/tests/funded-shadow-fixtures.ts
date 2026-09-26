import {
  FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION,
  FUNDED_EXECUTION_FEATURE_NAMES,
  fundedDecisionTimeInputSchema,
} from "@tsx-scanner/contracts";
import type { FundedExecutionModelArtifact } from "@tsx-scanner/contracts";
import {
  fundedShadowAttemptDigest,
  fundedShadowBatchDigest,
  fundedShadowEnrollmentDigest,
  fundedShadowGatePolicyDigest,
  fundedShadowLabelDigest,
  fundedShadowProjectionDigest,
  fundedShadowReportDigest,
  fundedShadowResultDigest,
} from "../src/statistical-models/funded-shadow-digest.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";
import { fundedComparisonChallengerPolicyDigest } from "../src/paper-bot/funded-comparison-challenger-policy.js";
import type {
  FundedShadowActiveEnrollment,
  FundedShadowAttempt,
  FundedShadowAttemptResult,
  FundedShadowAvailabilityReceipt,
  FundedShadowBatch,
  FundedShadowBatchProjection,
  FundedShadowEnrollment,
  FundedShadowEnrollmentDraft,
  FundedShadowEnrollmentTransition,
  FundedShadowFailureReason,
  FundedShadowGatePolicy,
  FundedShadowGatePolicyDraft,
  FundedShadowLabel,
  FundedShadowReport,
  FundedShadowReportDraft,
  FundedShadowStatus,
  FundedShadowTransitionAction,
  MarketId,
} from "@tsx-scanner/contracts";
import type {
  FundedShadowCanonicalOutcome,
  FundedShadowChampionRun,
  FundedShadowDecisionGroup,
  FundedShadowLabelCandidate,
  FundedShadowPendingAttempt,
  FundedShadowProjectableBatch,
  FundedShadowStore,
} from "../src/statistical-models/funded-shadow-repository.js";

/**
 * Deterministic in-memory FP04 store for focused unit tests. It mirrors the
 * append-only identity semantics of the PostgreSQL store (including exact
 * retries) without a database clock.
 */

export const SHADOW_RUN_ID = "55555555-5555-4555-8555-555555555555";
export const SHADOW_ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
export const SHADOW_MODEL_ID = "99999999-9999-4999-8999-999999999999";

export function shadowGatePolicyDraft(
  marketId: MarketId = "CA_TSX",
): FundedShadowGatePolicyDraft {
  return {
    gatePolicyVersion: "funded-shadow-gate-policy-v1",
    marketId,
    currency: marketId === "CA_TSX" ? "CAD" : "USD",
    stageBApproval: {
      approvalRef: "stage-b-fixture",
      approvedAt: "2026-09-21T12:00:00.000Z",
      approvedBy: "user",
      mMarket: 12.5,
      referenceSessionCount: 40,
      referenceSessionDigest: "d".repeat(64),
      referenceWindowStart: "2026-07-01",
      referenceWindowEnd: "2026-08-31",
      referenceEvidenceCutoffAt: "2026-09-01T00:00:00.000Z",
    },
    window: {
      minDecisions: 40,
      minSessions: 20,
      horizonSessions: 40,
      horizonDays: 90,
    },
    challengerPolicyVersion: "funded-comparison-execution-quality-ordering-v1",
    maxPredictionLagMs: 30_000,
  };
}

export function shadowChallengerIdentity() {
  return {
    kind: "FUNDED_EXECUTION_POLICY_V1" as const,
    policyVersion: "funded-comparison-execution-quality-ordering-v1" as const,
    policyDigest: fundedComparisonChallengerPolicyDigest(),
    model: {
      modelId: SHADOW_MODEL_ID,
      modelVersion: "1",
      artifactDigest: "a".repeat(64),
      datasetDigest: "b".repeat(64),
      cohortDigest: "c".repeat(64),
      featureVersion: "funded-execution-features-v1" as const,
      predictionPolicyVersion: "funded-execution-prediction-v1",
      trainingPartitionDigest: "d".repeat(64),
      trainingEvidenceCutoffAt: "2026-09-01T00:00:00.000Z",
      trainingSessionDigest: "e".repeat(64),
    },
  };
}

export function shadowChampionIdentity() {
  return {
    kind: "DETERMINISTIC_FUNDED_POLICY" as const,
    fundedPolicyVersion: "funded-policy-v1",
    portfolioPolicyVersion: "funded-portfolio-v2",
    policyDigest: contentHash({ champion: "fixture" }),
    sourceLiveRunId: SHADOW_RUN_ID,
    sourceAccountId: SHADOW_ACCOUNT_ID,
    executionModelVersion: "paper-execution-v3",
    costPolicyVersion: "cost-v1",
    participationVersion: "participation-v1",
    runtimeVersion: "runtime-v1",
    accountAssumptionDigest: "f".repeat(64),
    assumptionsDigest: "1".repeat(64),
  };
}

export class FakeFundedShadowStore implements FundedShadowStore {
  private sequence = 0;
  private readonly gatePolicies = new Map<
    string,
    { id: string; policy: FundedShadowGatePolicy }
  >();
  private readonly gatePolicyIdsByDigest = new Map<string, string>();
  private readonly enrollments = new Map<string, FundedShadowEnrollment>();
  private readonly states = new Map<string, "SHADOW" | "PAUSED" | "REVOKED">();
  private readonly transitions: Array<{
    enrollmentId: string;
    sequence: number;
    action: FundedShadowTransitionAction;
    state: "SHADOW" | "PAUSED" | "REVOKED";
    requestId: string;
  }> = [];
  readonly batches: FundedShadowBatch[] = [];
  readonly attempts: FundedShadowAttempt[] = [];
  readonly results: FundedShadowAttemptResult[] = [];
  readonly projections: FundedShadowBatchProjection[] = [];
  readonly labels: FundedShadowLabel[] = [];
  readonly reports: FundedShadowReport[] = [];
  readonly events: Array<{
    marketId: MarketId;
    kind: string;
    detail?: string;
  }> = [];
  readonly predictionIds = new Map<string, string>();
  readonly predictionTimes = new Map<string, string>();
  championRuns: FundedShadowChampionRun[] = [];
  decisionGroups: FundedShadowDecisionGroup[] = [];
  canonicalOutcomes = new Map<string, FundedShadowCanonicalOutcome>();
  lateInputs = 0;
  nowMs: () => number = () => Date.now();
  observeCalls = 0;

  id(): string {
    this.sequence += 1;
    return `00000000-0000-4000-8000-${String(this.sequence).padStart(12, "0")}`;
  }

  private active(enrollmentId: string): FundedShadowActiveEnrollment {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment) throw new Error("missing enrollment");
    const gatePolicy = this.gatePolicies.get(enrollment.gatePolicyId);
    if (!gatePolicy) throw new Error("missing gate policy");
    return {
      enrollment,
      gatePolicy: gatePolicy.policy,
      state: this.states.get(enrollmentId) ?? "SHADOW",
    };
  }

  async saveGatePolicy(draft: FundedShadowGatePolicyDraft): Promise<{
    id: string;
    policy: FundedShadowGatePolicy;
    reused: boolean;
  }> {
    const digest = fundedShadowGatePolicyDigest(draft);
    const existingId = this.gatePolicyIdsByDigest.get(digest);
    if (existingId) {
      const existing = this.gatePolicies.get(existingId)!;
      return { ...existing, reused: true };
    }
    const policy = {
      ...draft,
      gatePolicyDigest: digest,
    } as FundedShadowGatePolicy;
    const id = this.id();
    this.gatePolicies.set(id, { id, policy });
    this.gatePolicyIdsByDigest.set(digest, id);
    return { id, policy, reused: false };
  }

  async getGatePolicy(
    digest: string,
  ): Promise<{ id: string; policy: FundedShadowGatePolicy } | undefined> {
    const id = this.gatePolicyIdsByDigest.get(digest);
    return id ? this.gatePolicies.get(id) : undefined;
  }

  async saveEnrollment(
    draft: FundedShadowEnrollmentDraft,
  ): Promise<{ enrollment: FundedShadowEnrollment; reused: boolean }> {
    const existing = [...this.enrollments.values()].find(
      (row) =>
        row.registrationRequestId === draft.registrationRequestId ||
        row.enrollmentDigest ===
          fundedShadowEnrollmentDigest({
            ...draft,
          }),
    );
    const digest = fundedShadowEnrollmentDigest(draft);
    if (existing) {
      if (existing.enrollmentDigest !== digest)
        throw new Error("CONFLICTING_FUNDED_SHADOW_ENROLLMENT");
      return { enrollment: existing, reused: true };
    }
    const enrollment: FundedShadowEnrollment = {
      ...draft,
      id: this.id(),
      effectiveFrom: new Date(this.nowMs()).toISOString(),
      createdAt: new Date(this.nowMs()).toISOString(),
      enrollmentDigest: digest,
    };
    this.enrollments.set(enrollment.id, enrollment);
    this.states.set(enrollment.id, "SHADOW");
    return { enrollment, reused: false };
  }

  async transitionEnrollment(
    enrollmentId: string,
    action: FundedShadowTransitionAction,
    requestId: string,
  ): Promise<FundedShadowEnrollmentTransition> {
    const existing = this.transitions.find(
      (row) => row.enrollmentId === enrollmentId && row.requestId === requestId,
    );
    if (existing) {
      return {
        enrollmentId,
        sequence: existing.sequence,
        action: existing.action,
        state: existing.state,
        requestId,
        requestHash: contentHash({ action }),
        effectiveAt: new Date(this.nowMs()).toISOString(),
      };
    }
    const current = this.states.get(enrollmentId) ?? "SHADOW";
    const state: "SHADOW" | "PAUSED" | "REVOKED" =
      current === "REVOKED"
        ? "REVOKED"
        : action === "REVOKE"
          ? "REVOKED"
          : action === "PAUSE"
            ? "PAUSED"
            : "SHADOW";
    const sequence =
      this.transitions.filter((row) => row.enrollmentId === enrollmentId)
        .length + 1;
    this.transitions.push({ enrollmentId, sequence, action, state, requestId });
    this.states.set(enrollmentId, state);
    return {
      enrollmentId,
      sequence,
      action,
      state,
      requestId,
      requestHash: contentHash({ action }),
      effectiveAt: new Date(this.nowMs()).toISOString(),
    };
  }

  async listActiveEnrollments(
    marketId: MarketId,
  ): Promise<FundedShadowActiveEnrollment[]> {
    return [...this.enrollments.values()]
      .filter((row) => row.marketId === marketId)
      .filter((row) => (this.states.get(row.id) ?? "SHADOW") === "SHADOW")
      .map((row) => this.active(row.id));
  }

  async getEnrollment(
    enrollmentId: string,
  ): Promise<FundedShadowActiveEnrollment | undefined> {
    return this.enrollments.has(enrollmentId)
      ? this.active(enrollmentId)
      : undefined;
  }

  async listEnrollmentIds(marketId: MarketId): Promise<string[]> {
    return [...this.enrollments.values()]
      .filter((row) => row.marketId === marketId)
      .map((row) => row.id);
  }

  async listChampionRuns(): Promise<FundedShadowChampionRun[]> {
    return this.championRuns;
  }

  async countLateDecisionInputs(): Promise<number> {
    return this.lateInputs;
  }

  async durablePredictionFor(input: {
    modelId: string;
    runId: string;
    observationId: string;
    decisionSequence: number;
  }): Promise<
    { id: string; digest: string; predictionAt: string } | undefined
  > {
    const key = `${input.modelId}:${input.runId}:${input.observationId}:${input.decisionSequence}`;
    const id = this.predictionIds.get(key);
    if (!id) return undefined;
    return {
      id,
      digest: contentHash(this.predictionOutputs.get(id) ?? { output: id }),
      predictionAt:
        this.predictionTimes.get(key) ?? new Date(this.nowMs()).toISOString(),
    };
  }

  async lateDecisionInputCount(): Promise<number> {
    return this.lateInputs;
  }

  async lastLateInputEventCount(): Promise<number> {
    let max = 0;
    for (const event of this.events) {
      if (event.kind !== "LATE_INPUT") continue;
      const match = /late-decision-inputs:(\d+)/.exec(event.detail ?? "");
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  async listUnsealedDecisionGroups(
    enrollment: FundedShadowEnrollment,
    runIds: readonly string[],
    limit: number,
  ): Promise<FundedShadowDecisionGroup[]> {
    return this.decisionGroups
      .filter((group) => runIds.includes(group.runId))
      .filter((group) => group.decisionAt >= enrollment.effectiveFrom)
      .filter(
        (group) =>
          !this.batches.some(
            (batch) =>
              batch.enrollmentId === enrollment.id &&
              batch.runId === group.runId &&
              batch.decisionAt === group.decisionAt,
          ),
      )
      .slice(0, limit);
  }

  async sealBatch(
    enrollment: FundedShadowEnrollment,
    group: FundedShadowDecisionGroup,
  ): Promise<{
    batch: FundedShadowBatch;
    attempts: readonly FundedShadowAttempt[];
  }> {
    const batchDigest = fundedShadowBatchDigest({
      enrollmentId: enrollment.id,
      runId: group.runId,
      accountId: group.accountId,
      marketId: group.marketId,
      currency: group.currency,
      sessionDate: group.sessionDate,
      decisionAt: group.decisionAt,
      championIdentityDigest: enrollment.champion.policyDigest,
      observationIds: group.members.map((member) => member.observationId),
    });
    let batch = this.batches.find(
      (row) =>
        row.enrollmentId === enrollment.id &&
        row.runId === group.runId &&
        row.decisionAt === group.decisionAt,
    );
    if (!batch) {
      batch = {
        id: this.id(),
        enrollmentId: enrollment.id,
        marketId: group.marketId,
        currency: group.currency,
        runId: group.runId,
        accountId: group.accountId,
        sessionDate: group.sessionDate,
        decisionAt: group.decisionAt,
        championIdentityDigest: enrollment.champion.policyDigest,
        sealedAt: new Date(this.nowMs()).toISOString(),
        batchDigest,
      };
      this.batches.push(batch);
    } else if (batch.batchDigest !== batchDigest) {
      throw new Error("CONFLICTING_FUNDED_SHADOW_BATCH");
    }
    const attempts: FundedShadowAttempt[] = [];
    for (const [index, member] of group.members.entries()) {
      const attemptDigest = fundedShadowAttemptDigest({
        enrollmentId: enrollment.id,
        runId: group.runId,
        observationId: member.observationId,
        decisionSequence: member.sequence,
        decisionInputDigest: member.contentDigest,
        championAction: member.action,
        decisionAt: group.decisionAt,
        sessionDate: group.sessionDate,
      });
      let attempt = this.attempts.find(
        (row) =>
          row.enrollmentId === enrollment.id &&
          row.runId === group.runId &&
          row.observationId === member.observationId,
      );
      if (!attempt) {
        attempt = {
          attemptVersion: "funded-shadow-attempt-v1",
          id: this.id(),
          batchId: batch.id,
          enrollmentId: enrollment.id,
          marketId: group.marketId,
          currency: group.currency,
          runId: group.runId,
          accountId: group.accountId,
          observationId: member.observationId,
          sessionDate: group.sessionDate,
          decisionSequence: member.sequence,
          decisionInputDigest: member.contentDigest,
          championAction: member.action,
          decisionAt: group.decisionAt,
          deadlineAt: new Date(
            Date.parse(group.decisionAt) +
              (this.active(enrollment.id).gatePolicy.maxPredictionLagMs ??
                30_000),
          ).toISOString(),
          recordedAt: new Date(this.nowMs()).toISOString(),
          attemptDigest,
        };
        this.attempts.push(attempt);
      } else if (attempt.attemptDigest !== attemptDigest) {
        throw new Error("CONFLICTING_FUNDED_SHADOW_ATTEMPT");
      }
      attempts.push(attempt);
      void index;
      void member;
    }
    return { batch, attempts };
  }

  async listPendingAttempts(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowPendingAttempt[]> {
    this.observeCalls += 1;
    return this.attempts
      .filter((attempt) => attempt.enrollmentId === enrollmentId)
      .filter(
        (attempt) =>
          !this.results.some((result) => result.attemptId === attempt.id),
      )
      .slice(0, limit)
      .map((attempt) => {
        const group = this.decisionGroups.find(
          (candidate) =>
            candidate.runId === attempt.runId &&
            candidate.decisionAt === attempt.decisionAt,
        );
        const member = group?.members.find(
          (candidate) => candidate.observationId === attempt.observationId,
        );
        return {
          attempt,
          evidenceSchemaVersion: member?.evidenceSchemaVersion ?? null,
          cohortDigest: member?.cohortDigest ?? null,
          sourceKind: member?.sourceKind ?? null,
          decisionContent: member?.decisionContent ?? null,
        };
      });
  }

  async appendResult(
    input: Omit<FundedShadowAttemptResult, "recordedAt" | "resultDigest">,
  ): Promise<{ result: FundedShadowAttemptResult; reused: boolean }> {
    const digest = fundedShadowResultDigest(input);
    const existing = this.results.find(
      (result) => result.attemptId === input.attemptId,
    );
    if (existing) {
      if (existing.resultDigest !== digest)
        throw new Error("CONFLICTING_FUNDED_SHADOW_ATTEMPT_RESULT");
      return { result: existing, reused: true };
    }
    const result: FundedShadowAttemptResult = {
      ...input,
      recordedAt: new Date(this.nowMs()).toISOString(),
      resultDigest: digest,
    };
    this.results.push(result);
    return { result, reused: false };
  }

  private batchClosed(batch: FundedShadowBatch): boolean {
    const enrollment = this.enrollments.get(batch.enrollmentId);
    if (!enrollment) return false;
    const gate = this.gatePolicies.get(enrollment.gatePolicyId);
    const lag = gate?.policy.maxPredictionLagMs ?? 30_000;
    const later = this.decisionGroups.some(
      (group) =>
        group.runId === batch.runId && group.decisionAt > batch.decisionAt,
    );
    return later || this.nowMs() >= Date.parse(batch.decisionAt) + lag;
  }

  async listProjectableBatches(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowProjectableBatch[]> {
    return this.batches
      .filter((batch) => batch.enrollmentId === enrollmentId)
      .filter(
        (batch) => !this.projections.some((row) => row.batchId === batch.id),
      )
      .filter((batch) => this.batchClosed(batch))
      .filter((batch) =>
        this.attempts
          .filter((attempt) => attempt.batchId === batch.id)
          .every((attempt) =>
            this.results.some((result) => result.attemptId === attempt.id),
          ),
      )
      .slice(0, limit)
      .map((batch) => ({
        batch,
        members: this.attempts
          .filter((attempt) => attempt.batchId === batch.id)
          .map((attempt, ordinal) => {
            const result = this.results.find(
              (row) => row.attemptId === attempt.id,
            )!;
            return {
              attempt,
              ordinal: ordinal + 1,
              disposition: result.disposition,
              failureReason:
                result.failureReason as FundedShadowFailureReason | null,
              predictionId: result.predictionId,
              predictionOutput: result.predictionId
                ? (this.predictionOutputs.get(result.predictionId) ?? null)
                : null,
              decisionContent:
                this.decisionGroups
                  .find(
                    (group) =>
                      group.runId === attempt.runId &&
                      group.decisionAt === attempt.decisionAt,
                  )
                  ?.members.find(
                    (member) => member.observationId === attempt.observationId,
                  )?.decisionContent ?? null,
            };
          }),
      }));
  }

  readonly predictionOutputs = new Map<string, unknown>();

  async appendProjection(
    input: Omit<FundedShadowBatchProjection, "recordedAt" | "projectionDigest">,
  ): Promise<{ projection: FundedShadowBatchProjection; reused: boolean }> {
    const digest = fundedShadowProjectionDigest(input);
    const existing = this.projections.find(
      (row) => row.batchId === input.batchId,
    );
    if (existing) {
      if (existing.projectionDigest !== digest)
        throw new Error("CONFLICTING_FUNDED_SHADOW_PROJECTION");
      return { projection: existing, reused: true };
    }
    const projection: FundedShadowBatchProjection = {
      ...input,
      recordedAt: new Date(this.nowMs()).toISOString(),
      projectionDigest: digest,
    };
    this.projections.push(projection);
    return { projection, reused: false };
  }

  async listLabelCandidates(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowLabelCandidate[]> {
    return this.attempts
      .filter((attempt) => attempt.enrollmentId === enrollmentId)
      .filter((attempt) =>
        this.results.some((result) => result.attemptId === attempt.id),
      )
      .filter(
        (attempt) =>
          !this.labels.some((label) => label.attemptId === attempt.id),
      )
      .slice(0, limit)
      .map((attempt) => ({
        attemptId: attempt.id,
        enrollmentId: attempt.enrollmentId,
        runId: attempt.runId,
        observationId: attempt.observationId,
        marketId: attempt.marketId,
        currency: attempt.currency,
      }));
  }

  async canonicalOutcome(
    runId: string,
    observationId: string,
  ): Promise<FundedShadowCanonicalOutcome> {
    return (
      this.canonicalOutcomes.get(observationId) ?? {
        executionId: null,
        exitTime: null,
        rMultiple: null,
        runStatus: "RUNNING",
      }
    );
  }

  async appendLabel(
    input: Omit<FundedShadowLabel, "recordedAt" | "labelDigest">,
  ): Promise<{ label: FundedShadowLabel; reused: boolean }> {
    const digest = fundedShadowLabelDigest(input);
    const existing = this.labels.find(
      (row) => row.attemptId === input.attemptId,
    );
    if (existing) {
      if (existing.labelDigest !== digest)
        throw new Error("CONFLICTING_FUNDED_SHADOW_LABEL");
      return { label: existing, reused: true };
    }
    const label: FundedShadowLabel = {
      ...input,
      recordedAt: new Date(this.nowMs()).toISOString(),
      labelDigest: digest,
    };
    this.labels.push(label);
    return { label, reused: false };
  }

  async saveReport(
    draft: FundedShadowReportDraft,
  ): Promise<{ report: FundedShadowReport; reused: boolean }> {
    const digest = fundedShadowReportDigest(draft);
    const existing = this.reports.find((row) => row.reportDigest === digest);
    if (existing) return { report: existing, reused: true };
    const report: FundedShadowReport = { ...draft, reportDigest: digest };
    this.reports.push(report);
    return { report, reused: false };
  }

  async loadReportInputs(
    enrollmentId: string,
  ): Promise<Awaited<ReturnType<FundedShadowStore["loadReportInputs"]>>> {
    if (!this.enrollments.has(enrollmentId)) return undefined;
    return {
      active: this.active(enrollmentId),
      batches: this.batches.filter(
        (batch) => batch.enrollmentId === enrollmentId,
      ),
      attempts: this.attempts.filter(
        (attempt) => attempt.enrollmentId === enrollmentId,
      ),
      results: this.results.filter((result) =>
        this.attempts.some(
          (attempt) =>
            attempt.id === result.attemptId &&
            attempt.enrollmentId === enrollmentId,
        ),
      ),
      predictions: new Map(
        [...this.predictionOutputs.entries()].map(([id, output]) => [
          id,
          { id, output },
        ]),
      ),
      projections: this.projections.filter((projection) =>
        this.batches.some(
          (batch) =>
            batch.id === projection.batchId &&
            batch.enrollmentId === enrollmentId,
        ),
      ),
      labels: this.labels.filter((label) =>
        this.attempts.some(
          (attempt) =>
            attempt.id === label.attemptId &&
            attempt.enrollmentId === enrollmentId,
        ),
      ),
      eligibleObservations:
        this.attempts.filter((attempt) => attempt.enrollmentId === enrollmentId)
          .length + this.lateInputs,
    };
  }

  async availability(
    enrollmentId: string,
  ): Promise<FundedShadowAvailabilityReceipt | undefined> {
    if (!this.enrollments.has(enrollmentId)) return undefined;
    const active = this.active(enrollmentId);
    const attempts = this.attempts.filter(
      (attempt) => attempt.enrollmentId === enrollmentId,
    );
    const latest = this.reports.filter(
      (report) => report.enrollmentId === enrollmentId,
    );
    return {
      enrollmentId,
      marketId: active.enrollment.marketId,
      currency: active.enrollment.currency,
      state: active.state,
      sealedBatches: this.batches.filter(
        (batch) => batch.enrollmentId === enrollmentId,
      ).length,
      attempts: attempts.length,
      terminalAttempts: this.results.filter((result) =>
        attempts.some((attempt) => attempt.id === result.attemptId),
      ).length,
      reportsAvailable: latest.length,
      latestReportDigest: latest.at(-1)?.reportDigest ?? null,
      latestReportAsOf: latest.at(-1)?.evidenceBoundary.asOf ?? null,
    };
  }

  async recordObserverEvent(input: {
    marketId: MarketId;
    currency: "CAD" | "USD";
    kind: string;
    detail?: string | null;
  }): Promise<void> {
    this.events.push({
      marketId: input.marketId,
      kind: input.kind,
      detail: input.detail ?? undefined,
    });
  }

  async status(marketId: MarketId): Promise<FundedShadowStatus> {
    const active = await this.listActiveEnrollments(marketId);
    return {
      marketId,
      currency: marketId === "CA_TSX" ? "CAD" : "USD",
      enrollmentState: active.length > 0 ? "SHADOW" : null,
      activeEnrollments: active.length,
      sealedBatches: this.batches.filter((batch) => batch.marketId === marketId)
        .length,
      pendingAttempts: this.attempts.filter(
        (attempt) =>
          attempt.marketId === marketId &&
          !this.results.some((result) => result.attemptId === attempt.id),
      ).length,
      oldestPendingAttemptAgeMs: null,
      timelyPredictions: this.results.filter(
        (result) =>
          result.marketId === marketId &&
          result.disposition === "TIMELY_PREDICTION",
      ).length,
      missedDeadline: 0,
      invalidIdentity: 0,
      inferenceFailure: 0,
      inputUnavailable: 0,
      fallbackBatches: this.projections.filter(
        (projection) =>
          projection.marketId === marketId &&
          projection.batchDisposition === "FALLBACK_CHAMPION_ORDER",
      ).length,
      predictionCoverage: null,
      labelCompleteness: null,
      reportsAvailable: this.reports.filter(
        (report) => report.marketId === marketId,
      ).length,
      latestReportAgeMs: null,
      observerFailures: this.events.filter(
        (event) => event.kind === "OBSERVER_FAILURE",
      ).length,
      reconcileFailures: 0,
      leaseContention: 0,
      ownershipRefusals: 0,
      lateInputs: this.lateInputs,
      readAt: new Date(this.nowMs()).toISOString(),
    };
  }
}

export function shadowDecisionContent(input: {
  observationId: string;
  decisionAt: string;
  marketId?: MarketId;
  currency?: "CAD" | "USD";
  accountId?: string;
  runId?: string;
  score?: number;
  action?: "SUBMIT" | "DECLINE" | "DEFER";
  sourceKind?: string;
}) {
  const marketId = input.marketId ?? "CA_TSX";
  const action = input.action ?? "SUBMIT";
  return fundedDecisionTimeInputSchema.parse({
    marketId,
    currency: input.currency ?? (marketId === "CA_TSX" ? "CAD" : "USD"),
    accountId: input.accountId ?? SHADOW_ACCOUNT_ID,
    runId: input.runId ?? SHADOW_RUN_ID,
    observationId: input.observationId,
    evidenceSchemaVersion: FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION,
    fundedPolicyVersion: "funded-policy-v1",
    executionModelVersion: "paper-execution-v3",
    featureVersion: "1.2.0",
    sourceKind: input.sourceKind ?? "LIVE_PAPER",
    action,
    policyReason: action === "SUBMIT" ? null : "SIGNAL_NOT_EXECUTABLE",
    decisionAt: input.decisionAt,
    strategyKey: "ORB_STANDARD",
    strategyVersion: "2026-09-01",
    score: input.score ?? 70,
    reasonCodes: ["BREAKOUT"],
    requestedCapital:
      action === "SUBMIT"
        ? { status: "AVAILABLE", maximumDebit: 1_000, maximumRisk: 100 }
        : { status: "UNAVAILABLE", reason: "No submission was requested" },
    quote: {
      status: "AVAILABLE",
      snapshot: {
        timestamp: input.decisionAt,
        bid: 10.01,
        ask: 10.03,
        bidSize: 500,
        askSize: 400,
        sizeUnit: "SHARES",
        sizeMultiplier: 1,
        dataStatus: "REALTIME",
        actionable: true,
      },
    },
    model: { status: "UNAVAILABLE", reason: "No signal model was active" },
    portfolio: {
      status: "AVAILABLE",
      cash: 10_000,
      reservedCash: 0,
      openRisk: 0,
      reservedRisk: 0,
      positionCount: 0,
      sectorExposure: {},
      dailyPnl: 0,
      entriesAllowed: true,
      cooldownActive: false,
      consecutiveStops: 0,
    },
    context: { status: "UNAVAILABLE", reason: "No context captured" },
    execution: {
      positionSize: 1_000,
      slippageBps: 2,
      feePerTrade: 1,
      costs: null,
      riskBudget: 100,
      maxNotional: 3_000,
      economics: null,
      stopMethod: "STRUCTURAL",
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
      executionMode: "CAPACITY_CONSTRAINED",
      latencyMs: 0,
      evidenceScope: null,
    },
    sizingContext: null,
    policy: {
      projectionVersion: "funded-cash-v1",
      participation: 0.25,
      impactBps: 2,
      latencyPolicy: "CAPTURED_PER_ORDER",
      portfolio: null,
    },
    signal: {
      signalTimestamp: input.decisionAt,
      entryReference: 10.02,
      stopReference: 9.8,
      targetReference: 10.6,
      atr14: 0.22,
    },
  });
}

export function shadowDecisionGroup(input: {
  runId?: string;
  accountId?: string;
  marketId?: MarketId;
  decisionAt: string;
  sessionDate?: string;
  members: Array<{
    observationId: string;
    sequence: number;
    action?: "SUBMIT" | "DECLINE" | "DEFER";
    score?: number;
    schemaVersion?: number;
    cohortDigest?: string;
    sourceKind?: string;
  }>;
}): FundedShadowDecisionGroup {
  const marketId = input.marketId ?? "CA_TSX";
  const currency = marketId === "CA_TSX" ? ("CAD" as const) : ("USD" as const);
  const cohortDigest = input.members[0]?.cohortDigest ?? "c".repeat(64);
  return {
    runId: input.runId ?? SHADOW_RUN_ID,
    accountId: input.accountId ?? SHADOW_ACCOUNT_ID,
    marketId,
    currency,
    decisionAt: input.decisionAt,
    sessionDate: input.sessionDate ?? input.decisionAt.slice(0, 10),
    members: input.members.map((member) => {
      const action = member.action ?? "SUBMIT";
      const decisionContent = shadowDecisionContent({
        observationId: member.observationId,
        decisionAt: input.decisionAt,
        marketId,
        currency,
        accountId: input.accountId ?? SHADOW_ACCOUNT_ID,
        runId: input.runId ?? SHADOW_RUN_ID,
        score: member.score ?? 70,
        action,
        sourceKind: member.sourceKind ?? "LIVE_PAPER",
      });
      return {
        observationId: member.observationId,
        sequence: member.sequence,
        contentDigest: contentHash({
          observationId: member.observationId,
          sequence: member.sequence,
        }),
        action,
        decisionContent,
        evidenceSchemaVersion: member.schemaVersion ?? 2,
        cohortDigest: member.cohortDigest ?? cohortDigest,
        sourceKind: member.sourceKind ?? "LIVE_PAPER",
      };
    }),
  };
}

export function shadowChampionRun(
  overrides: Partial<FundedShadowChampionRun> = {},
): FundedShadowChampionRun {
  return {
    runId: SHADOW_RUN_ID,
    status: "RUNNING",
    accountId: SHADOW_ACCOUNT_ID,
    currency: "CAD",
    policy: {},
    policyDigest: shadowChampionIdentity().policyDigest,
    ...overrides,
  };
}

export function shadowArtifact(
  datasetDigest = "b".repeat(64),
  partitionDigest = "d".repeat(64),
): FundedExecutionModelArtifact {
  const head = (output: string, kind: "LOGISTIC" | "LINEAR", unit: string) => {
    const metrics =
      kind === "LOGISTIC"
        ? {
            kind,
            samples: 100,
            positives: 50,
            negatives: 50,
            baseRate: 0.5,
            brierScore: 0.2,
            baselineBrierScore: 0.25,
            logLoss: 0.6,
            rocAuc: 0.6,
            calibration: [],
          }
        : {
            kind,
            samples: 100,
            meanPredicted: 0.5,
            meanActual: 0.5,
            meanAbsoluteError: 0.1,
            rootMeanSquaredError: 0.2,
          };
    return {
      output,
      kind,
      unit,
      lowerBound: 0,
      upperBound: unit === "PROBABILITY" || unit === "FRACTION" ? 1 : null,
      trainingSamples: 100,
      intercept: 0.1,
      coefficients: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0.01),
      means: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0),
      scales: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 1),
      medians: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0),
      trainMetrics: metrics,
      testMetrics: metrics,
    };
  };
  return {
    artifactVersion: "funded-execution-v1",
    modelType: "FUNDED_EXECUTION_QUALITY",
    featureVersion: "funded-execution-features-v1",
    featureNames: [...FUNDED_EXECUTION_FEATURE_NAMES],
    sourceDatasetDigest: datasetDigest,
    trainingPartitionDigest: partitionDigest,
    trainingRowCount: 100,
    trainingFillRowCount: 100,
    trainingCostRowCount: 50,
    outputs: [
      head("fillProbability", "LOGISTIC", "PROBABILITY"),
      head("expectedFillFraction", "LINEAR", "FRACTION"),
      head("expectedSlippagePerShare", "LINEAR", "CURRENCY_PER_SHARE"),
      head("expectedTotalExecutionCost", "LINEAR", "CURRENCY"),
    ] as unknown as FundedExecutionModelArtifact["outputs"],
    warnings: [],
  };
}

export function shadowChallengerRecord() {
  const identity = shadowChallengerIdentity();
  return {
    challengerId: identity.model.modelId,
    modelVersion: identity.model.modelVersion,
    artifactDigest: identity.model.artifactDigest,
    cohortDigest: identity.model.cohortDigest,
    datasetDigest: identity.model.datasetDigest,
    featureVersion: identity.model.featureVersion,
    artifact: shadowArtifact(
      identity.model.datasetDigest,
      identity.model.trainingPartitionDigest,
    ),
    training: {
      trainingSessionDates: ["2026-08-31"],
      trainingKnowledgeCutoffAt: identity.model.trainingEvidenceCutoffAt,
      trainingPartitionDigest: identity.model.trainingPartitionDigest,
      trainingSessionDigest: identity.model.trainingSessionDigest,
    },
  };
}

export function shadowPredictionOutput(fillFraction = 0.7, cost = 1.2) {
  return {
    fillProbability: {
      value: 0.8,
      unit: "PROBABILITY" as const,
      lowerBound: 0,
      upperBound: 1,
    },
    expectedFillFraction: {
      value: fillFraction,
      unit: "FRACTION" as const,
      lowerBound: 0,
      upperBound: 1,
    },
    expectedSlippagePerShare: {
      value: 0.01,
      unit: "CURRENCY_PER_SHARE" as const,
      lowerBound: 0,
      upperBound: null,
    },
    expectedTotalExecutionCost: {
      value: cost,
      unit: "CURRENCY" as const,
      lowerBound: 0,
      upperBound: null,
    },
  };
}
