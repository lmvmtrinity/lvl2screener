import { describe, expect, it } from "vitest";
import {
  FUNDED_SHADOW_GATE_POLICY_VERSION,
  FUNDED_SHADOW_MAX_PREDICTION_LAG_MS,
  FUNDED_SHADOW_QUALIFYING_REFERENCE_SESSIONS,
  FUNDED_SHADOW_REPORT_VERSION,
  FUNDED_SHADOW_WINDOW,
  fundedShadowAttemptResultSchema,
  fundedShadowAttemptSchema,
  fundedShadowBatchProjectionSchema,
  fundedShadowEnrollmentSchema,
  fundedShadowGatePolicySchema,
  fundedShadowLabelSchema,
  fundedShadowReportSchema,
  fundedShadowStatusSchema,
  nextFundedShadowState,
} from "../src/domains/funded-shadow-observation.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const digestD = "d".repeat(64);

const ENROLLMENT_ID = "11111111-1111-4111-8111-111111111111";
const GATE_POLICY_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const BATCH_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
const OBSERVATION_ID = "77777777-7777-4777-8777-777777777777";
const EXECUTION_ID = "88888888-8888-4888-8888-888888888888";
const PREDICTION_ID = "99999999-9999-4999-8999-999999999999";

const gatePolicy = {
  gatePolicyVersion: FUNDED_SHADOW_GATE_POLICY_VERSION,
  marketId: "CA_TSX",
  currency: "CAD",
  stageBApproval: {
    approvalRef: "stage-b-approval-2026-09-21-ca",
    approvedAt: "2026-09-21T12:00:00.000Z",
    approvedBy: "user",
    mMarket: 12.5,
    referenceSessionCount: FUNDED_SHADOW_QUALIFYING_REFERENCE_SESSIONS,
    referenceSessionDigest: digestD,
    referenceWindowStart: "2026-07-01",
    referenceWindowEnd: "2026-08-31",
    referenceEvidenceCutoffAt: "2026-09-01T00:00:00.000Z",
  },
  window: { ...FUNDED_SHADOW_WINDOW },
  challengerPolicyVersion: "funded-comparison-execution-quality-ordering-v1",
  maxPredictionLagMs: 30_000,
  gatePolicyDigest: digestA,
} as const;

const champion = {
  kind: "DETERMINISTIC_FUNDED_POLICY",
  fundedPolicyVersion: "funded-policy-v2",
  portfolioPolicyVersion: "funded-portfolio-v2",
  policyDigest: digestA,
  sourceLiveRunId: RUN_ID,
  sourceAccountId: ACCOUNT_ID,
  executionModelVersion: "quote-execution-v1",
  costPolicyVersion: "cost-policy-v1",
  participationVersion: "participation-v1",
  runtimeVersion: "runtime-v1",
  accountAssumptionDigest: digestB,
  assumptionsDigest: digestC,
} as const;

const challenger = {
  kind: "FUNDED_EXECUTION_POLICY_V1",
  policyVersion: "funded-comparison-execution-quality-ordering-v1",
  policyDigest: digestB,
  model: {
    modelId: "model-1",
    modelVersion: "1",
    artifactDigest: digestA,
    datasetDigest: digestB,
    cohortDigest: digestC,
    featureVersion: "funded-execution-features-v1",
    predictionPolicyVersion: "funded-execution-prediction-v1",
    trainingPartitionDigest: digestA,
    trainingEvidenceCutoffAt: "2026-09-01T00:00:00.000Z",
    trainingSessionDigest: digestB,
  },
} as const;

const enrollment = {
  enrollmentVersion: "funded-shadow-enrollment-v1",
  id: ENROLLMENT_ID,
  gatePolicyId: GATE_POLICY_ID,
  marketId: "CA_TSX",
  currency: "CAD",
  sourceKind: "LIVE_PAPER",
  champion,
  challenger,
  effectiveFrom: "2026-09-21T13:00:00.000Z",
  evidenceCutoffAt: "2026-09-01T00:00:00.000Z",
  registrationRequestId: "request-1",
  requestHash: digestA,
  enrollmentDigest: digestB,
  createdAt: "2026-09-21T13:00:00.000Z",
} as const;

const attempt = {
  attemptVersion: "funded-shadow-attempt-v1",
  id: ATTEMPT_ID,
  batchId: BATCH_ID,
  enrollmentId: ENROLLMENT_ID,
  marketId: "CA_TSX",
  currency: "CAD",
  runId: RUN_ID,
  accountId: ACCOUNT_ID,
  observationId: OBSERVATION_ID,
  sessionDate: "2026-09-21",
  decisionSequence: 7,
  decisionInputDigest: digestA,
  championAction: "SUBMIT",
  decisionAt: "2026-09-21T14:00:00.000Z",
  deadlineAt: "2026-09-21T14:00:30.000Z",
  recordedAt: "2026-09-21T14:00:00.100Z",
  attemptDigest: digestC,
} as const;

describe("funded shadow gate policy", () => {
  it("accepts a complete market-scoped Stage B reference", () => {
    expect(fundedShadowGatePolicySchema.parse(gatePolicy).currency).toBe("CAD");
  });

  it("rejects a stage B reference below the 40-session floor", () => {
    expect(() =>
      fundedShadowGatePolicySchema.parse({
        ...gatePolicy,
        stageBApproval: {
          ...gatePolicy.stageBApproval,
          referenceSessionCount: 39,
        },
      }),
    ).toThrow();
  });

  it("rejects a non-chronological reference window", () => {
    expect(() =>
      fundedShadowGatePolicySchema.parse({
        ...gatePolicy,
        stageBApproval: {
          ...gatePolicy.stageBApproval,
          referenceWindowStart: "2026-08-31",
        },
      }),
    ).toThrow();
  });

  it("rejects an approval dated before its reference evidence cutoff", () => {
    expect(() =>
      fundedShadowGatePolicySchema.parse({
        ...gatePolicy,
        stageBApproval: {
          ...gatePolicy.stageBApproval,
          approvedAt: "2026-08-15T00:00:00.000Z",
        },
      }),
    ).toThrow();
  });

  it("rejects a prediction lag above the FP02 boundary ceiling", () => {
    expect(() =>
      fundedShadowGatePolicySchema.parse({
        ...gatePolicy,
        maxPredictionLagMs: FUNDED_SHADOW_MAX_PREDICTION_LAG_MS + 1,
      }),
    ).toThrow();
  });

  it("rejects a window below the ADR-016 SHADOW floor", () => {
    expect(() =>
      fundedShadowGatePolicySchema.parse({
        ...gatePolicy,
        window: { ...FUNDED_SHADOW_WINDOW, minDecisions: 1 },
      }),
    ).toThrow();
    expect(() =>
      fundedShadowGatePolicySchema.parse({
        ...gatePolicy,
        window: { ...FUNDED_SHADOW_WINDOW, horizonDays: 30 },
      }),
    ).toThrow();
  });

  it("rejects a market/currency mismatch and unknown fields", () => {
    expect(() =>
      fundedShadowGatePolicySchema.parse({ ...gatePolicy, currency: "USD" }),
    ).toThrow();
    expect(() =>
      fundedShadowGatePolicySchema.parse({ ...gatePolicy, authority: true }),
    ).toThrow();
  });
});

describe("funded shadow enrollment lifecycle", () => {
  it("is SHADOW-only and append-only", () => {
    expect(nextFundedShadowState("SHADOW", "PAUSE")).toBe("PAUSED");
    expect(nextFundedShadowState("PAUSED", "RESUME")).toBe("SHADOW");
    expect(nextFundedShadowState("SHADOW", "REVOKE")).toBe("REVOKED");
    expect(nextFundedShadowState("REVOKED", "RESUME")).toBe("REVOKED");
  });

  it("rejects an enrollment beginning before the challenger evidence cutoff", () => {
    expect(() =>
      fundedShadowEnrollmentSchema.parse({
        ...enrollment,
        effectiveFrom: "2026-08-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a mismatch between the champion source and the market currency", () => {
    expect(() =>
      fundedShadowEnrollmentSchema.parse({
        ...enrollment,
        currency: "USD",
      }),
    ).toThrow();
  });
});

describe("funded shadow attempts", () => {
  it("requires the exact champion decision or an explicit unavailable input", () => {
    expect(fundedShadowAttemptSchema.parse(attempt).decisionSequence).toBe(7);
    const unavailable = fundedShadowAttemptSchema.parse({
      ...attempt,
      decisionSequence: null,
      decisionInputDigest: null,
      championAction: "UNAVAILABLE",
    });
    expect(unavailable.championAction).toBe("UNAVAILABLE");
    expect(() =>
      fundedShadowAttemptSchema.parse({
        ...attempt,
        decisionSequence: null,
      }),
    ).toThrow();
    expect(() =>
      fundedShadowAttemptSchema.parse({
        ...attempt,
        championAction: "UNAVAILABLE",
      }),
    ).toThrow();
  });

  it("requires the deadline to follow the decision", () => {
    expect(() =>
      fundedShadowAttemptSchema.parse({
        ...attempt,
        deadlineAt: attempt.decisionAt,
      }),
    ).toThrow();
  });
});

describe("funded shadow attempt results", () => {
  it("binds a timely prediction to its durable prediction identity", () => {
    const result = fundedShadowAttemptResultSchema.parse({
      attemptId: ATTEMPT_ID,
      enrollmentId: ENROLLMENT_ID,
      marketId: "CA_TSX",
      currency: "CAD",
      disposition: "TIMELY_PREDICTION",
      predictionId: PREDICTION_ID,
      predictionDigest: digestA,
      failureReason: null,
      recordedAt: "2026-09-21T14:00:01.000Z",
      resultDigest: digestB,
    });
    expect(result.disposition).toBe("TIMELY_PREDICTION");
  });

  it("rejects a non-timely result without a stable reason or with a prediction", () => {
    const base = {
      attemptId: ATTEMPT_ID,
      enrollmentId: ENROLLMENT_ID,
      marketId: "CA_TSX",
      currency: "CAD",
      disposition: "MISSED_DEADLINE",
      predictionId: null,
      predictionDigest: null,
      failureReason: "DEADLINE_EXPIRED",
      recordedAt: "2026-09-21T14:01:00.000Z",
      resultDigest: digestB,
    } as const;
    expect(fundedShadowAttemptResultSchema.parse(base).failureReason).toBe(
      "DEADLINE_EXPIRED",
    );
    expect(() =>
      fundedShadowAttemptResultSchema.parse({ ...base, failureReason: null }),
    ).toThrow();
    expect(() =>
      fundedShadowAttemptResultSchema.parse({
        ...base,
        predictionId: PREDICTION_ID,
        predictionDigest: digestA,
      }),
    ).toThrow();
  });
});

describe("funded shadow batch projections", () => {
  const base = {
    projectionVersion: "funded-shadow-projection-v1",
    batchId: BATCH_ID,
    enrollmentId: ENROLLMENT_ID,
    marketId: "CA_TSX",
    currency: "CAD",
    batchDisposition: "CHALLENGER_ORDER",
    fallbackReason: null,
    orderedAttemptIds: [ATTEMPT_ID],
    predictionCoverage: 1,
    orderChanges: 0,
    recordedAt: "2026-09-21T14:01:00.000Z",
    projectionDigest: digestC,
  } as const;

  it("requires exactly one stable fallback reason", () => {
    expect(fundedShadowBatchProjectionSchema.parse(base).batchDisposition).toBe(
      "CHALLENGER_ORDER",
    );
    expect(() =>
      fundedShadowBatchProjectionSchema.parse({
        ...base,
        fallbackReason: "PREDICTION_MISSING",
      }),
    ).toThrow();
    expect(() =>
      fundedShadowBatchProjectionSchema.parse({
        ...base,
        batchDisposition: "FALLBACK_CHAMPION_ORDER",
      }),
    ).toThrow();
    expect(
      fundedShadowBatchProjectionSchema.parse({
        ...base,
        batchDisposition: "FALLBACK_CHAMPION_ORDER",
        fallbackReason: "PREDICTION_MISSING",
      }).fallbackReason,
    ).toBe("PREDICTION_MISSING");
  });

  it("requires at least one ordered attempt", () => {
    expect(() =>
      fundedShadowBatchProjectionSchema.parse({
        ...base,
        orderedAttemptIds: [],
      }),
    ).toThrow();
  });
});

describe("funded shadow labels", () => {
  it("accepts a resolved independent label and rejects contradictory sign", () => {
    const resolved = {
      labelVersion: "funded-shadow-label-v1",
      attemptId: ATTEMPT_ID,
      enrollmentId: ENROLLMENT_ID,
      marketId: "CA_TSX",
      currency: "CAD",
      status: "POSITIVE",
      rMultiple: 1.2,
      labelAvailableAt: "2026-09-21T15:00:00.000Z",
      unresolvedReason: null,
      evidenceExecutionId: EXECUTION_ID,
      recordedAt: "2026-09-21T15:00:01.000Z",
      labelDigest: digestA,
    } as const;
    expect(fundedShadowLabelSchema.parse(resolved).status).toBe("POSITIVE");
    expect(() =>
      fundedShadowLabelSchema.parse({ ...resolved, rMultiple: -0.5 }),
    ).toThrow();
    expect(() =>
      fundedShadowLabelSchema.parse({ ...resolved, evidenceExecutionId: null }),
    ).toThrow();
  });

  it("requires an unresolved label to retain its reason and no value", () => {
    const unresolved = {
      labelVersion: "funded-shadow-label-v1",
      attemptId: ATTEMPT_ID,
      enrollmentId: ENROLLMENT_ID,
      marketId: "CA_TSX",
      currency: "CAD",
      status: "UNRESOLVED",
      rMultiple: null,
      labelAvailableAt: null,
      unresolvedReason: "CANONICAL_QUOTE_OUTCOME_NOT_RETAINED",
      evidenceExecutionId: null,
      recordedAt: "2026-09-22T00:00:00.000Z",
      labelDigest: digestB,
    } as const;
    expect(fundedShadowLabelSchema.parse(unresolved).status).toBe("UNRESOLVED");
    expect(() =>
      fundedShadowLabelSchema.parse({ ...unresolved, rMultiple: 0.5 }),
    ).toThrow();
  });
});

const emptyDistribution = {
  positive: 0,
  negative: 0,
  unresolved: 0,
  pending: 0,
  meanRMultiple: null,
} as const;

const report = {
  reportVersion: FUNDED_SHADOW_REPORT_VERSION,
  enrollmentId: ENROLLMENT_ID,
  marketId: "CA_TSX",
  currency: "CAD",
  enrollmentState: "SHADOW",
  gatePolicyDigest: digestA,
  challengerPolicyVersion: "funded-comparison-execution-quality-ordering-v1",
  challengerPolicyDigest: digestB,
  maxPredictionLagMs: 30_000,
  champion,
  challenger,
  evidenceBoundary: {
    asOf: "2026-09-21T23:00:00.000Z",
    firstDecisionAt: "2026-09-21T14:00:00.000Z",
    lastDecisionAt: "2026-09-21T14:00:00.000Z",
    sealedBatches: 1,
    closedBatches: 1,
    attempts: 1,
    terminalAttempts: 1,
  },
  coverage: {
    eligibleObservations: 1,
    attemptedObservations: 1,
    inputCoverage: 1,
    sealedBatches: 1,
    closedBatches: 1,
    fallbackBatches: 0,
    fallbackRate: 0,
    timelyPredictions: 1,
    missedDeadline: 0,
    invalidIdentity: 0,
    inferenceFailure: 0,
    inputUnavailable: 0,
    pendingAttempts: 0,
    predictionCoverage: 1,
    labelsAvailable: 1,
    labelsPending: 0,
    labelsPermanentlyUnresolved: 0,
    labelCompleteness: 1,
  },
  championActions: { submit: 1, decline: 0, defer: 0, unavailable: 0 },
  championMetrics: {
    decisions: 1,
    firstRank: emptyDistribution,
    allDecisions: emptyDistribution,
  },
  challengerMetrics: {
    decisions: 1,
    firstRank: emptyDistribution,
    allDecisions: emptyDistribution,
  },
  deltas: {
    firstRankPositiveRate: null,
    firstRankNegativeRate: null,
    firstRankMeanRMultiple: null,
    allDecisionsMeanRMultiple: null,
  },
  orderAgreement: { batches: 1, changedBatches: 0, orderChangeRate: 0 },
  window: {
    ...FUNDED_SHADOW_WINDOW,
    decisions: 1,
    sessions: 1,
    minimumsMet: false,
    gateEligible: false,
  },
  fundedEconomics: {
    status: "NOT_PROJECTED_IN_V1",
    reason: "DECISION_LEVEL_SHADOW_OBSERVATION",
  },
  promotionAuthorized: false,
  authorityEffect: "NONE",
  reportDigest: digestC,
} as const;

describe("funded shadow report", () => {
  it("accepts a decision-level report and rejects authority claims", () => {
    expect(fundedShadowReportSchema.parse(report).promotionAuthorized).toBe(
      false,
    );
    expect(() =>
      fundedShadowReportSchema.parse({ ...report, promotionAuthorized: true }),
    ).toThrow();
    expect(() =>
      fundedShadowReportSchema.parse({ ...report, authorityEffect: "ACTIVE" }),
    ).toThrow();
    expect(() =>
      fundedShadowReportSchema.parse({ ...report, unexpected: 1 }),
    ).toThrow();
  });

  it("rejects a market/currency mismatch in the report", () => {
    expect(() =>
      fundedShadowReportSchema.parse({ ...report, currency: "USD" }),
    ).toThrow();
  });
});

describe("funded shadow operational status", () => {
  it("is market-scoped and carries no authority state", () => {
    const status = fundedShadowStatusSchema.parse({
      marketId: "CA_TSX",
      currency: "CAD",
      enrollmentState: null,
      activeEnrollments: 0,
      sealedBatches: 0,
      pendingAttempts: 0,
      oldestPendingAttemptAgeMs: null,
      timelyPredictions: 0,
      missedDeadline: 0,
      invalidIdentity: 0,
      inferenceFailure: 0,
      inputUnavailable: 0,
      fallbackBatches: 0,
      predictionCoverage: null,
      labelCompleteness: null,
      reportsAvailable: 0,
      latestReportAgeMs: null,
      observerFailures: 0,
      reconcileFailures: 0,
      leaseContention: 0,
      ownershipRefusals: 0,
      lateInputs: 0,
      readAt: "2026-09-21T23:00:00.000Z",
    });
    expect(Object.keys(status)).not.toContain("authorityEffect");
    expect(() =>
      fundedShadowStatusSchema.parse({
        ...status,
        currency: "USD",
      }),
    ).toThrow();
  });
});
