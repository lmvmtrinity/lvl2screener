import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import {
  fundedComparisonChampionPolicyIdentitySchema,
  fundedComparisonChallengerPolicyIdentitySchema,
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
} from "./funded-comparison.js";

/**
 * Shared contracts for prospective funded champion/challenger SHADOW
 * observation (FP04).
 *
 * FP04 is authority-disabled. None of these schemas carries an activation,
 * promotion, canary, rollback, active-policy, authority, sizing, veto-bypass or
 * recommendation field, and none is an input to a LIVE funded order/risk
 * decision. The report's `promotionAuthorized` is always `false` and its
 * `authorityEffect` is always `NONE`.
 *
 * Canonical hashing lives at the API persistence boundary
 * (`funded-shadow-digest.ts`), never in this browser-safe module.
 */

const isoDateTime = z.string().datetime({ offset: true });
const sessionDate = z.string().date();
const uuid = z.string().uuid();
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const positive = finite.positive();
const safeCount = z.number().int().safe().nonnegative();
const rate = finite.min(0).max(1);

export const FUNDED_SHADOW_GATE_POLICY_VERSION = "funded-shadow-gate-policy-v1";
export const FUNDED_SHADOW_ENROLLMENT_VERSION = "funded-shadow-enrollment-v1";
export const FUNDED_SHADOW_ATTEMPT_VERSION = "funded-shadow-attempt-v1";
export const FUNDED_SHADOW_PROJECTION_VERSION = "funded-shadow-projection-v1";
export const FUNDED_SHADOW_LABEL_VERSION = "funded-shadow-label-v1";
export const FUNDED_SHADOW_REPORT_VERSION = "funded-shadow-report-v1";
export const FUNDED_SHADOW_OBSERVER_EVENT_VERSION =
  "funded-shadow-observer-event-v1";

/** ADR-016 SHADOW window: 40 decisions, 20 unseen sessions, 40/90 horizon. */
export const FUNDED_SHADOW_WINDOW = {
  minDecisions: 40,
  minSessions: 20,
  horizonSessions: 40,
  horizonDays: 90,
} as const;

/** The gate policy may not exceed the FP02 forward-prediction lag ceiling. */
export const FUNDED_SHADOW_MAX_PREDICTION_LAG_MS = 30_000;
export const FUNDED_SHADOW_MIN_PREDICTION_LAG_MS = 1_000;

/** A simultaneous batch closes after this grace beyond its final decision. */
export const FUNDED_SHADOW_BATCH_SEAL_GRACE_MS = 5_000;

/** Stage B requires at least this many prior non-overlapping reference sessions. */
export const FUNDED_SHADOW_QUALIFYING_REFERENCE_SESSIONS = 40;

/** Market and native currency are paired, never inferred. */
function marketCurrencyMatches(value: {
  marketId: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
}): boolean {
  return value.marketId === "CA_TSX"
    ? value.currency === "CAD"
    : value.currency === "USD";
}

function enforceMarketCurrency(
  value: { marketId: "CA_TSX" | "US_EQUITIES"; currency: "CAD" | "USD" },
  ctx: z.RefinementCtx,
  path: (string | number)[] = ["currency"],
): void {
  if (!marketCurrencyMatches(value))
    ctx.addIssue({
      code: "custom",
      path,
      message: "Currency does not match the funded market",
    });
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export const fundedShadowEnrollmentStateSchema = z.enum([
  "SHADOW",
  "PAUSED",
  "REVOKED",
]);
export type FundedShadowEnrollmentState = z.infer<
  typeof fundedShadowEnrollmentStateSchema
>;

export const fundedShadowTransitionActionSchema = z.enum([
  "PAUSE",
  "RESUME",
  "REVOKE",
]);
export type FundedShadowTransitionAction = z.infer<
  typeof fundedShadowTransitionActionSchema
>;

/** The durable latest state implied by an append-only transition history. */
export function nextFundedShadowState(
  current: FundedShadowEnrollmentState,
  action: FundedShadowTransitionAction,
): FundedShadowEnrollmentState {
  switch (current) {
    case "SHADOW":
      if (action === "PAUSE") return "PAUSED";
      if (action === "REVOKE") return "REVOKED";
      return "SHADOW";
    case "PAUSED":
      if (action === "RESUME") return "SHADOW";
      if (action === "REVOKE") return "REVOKED";
      return "PAUSED";
    case "REVOKED":
      return "REVOKED";
  }
}

/* ------------------------------------------------------------------ *
 * Gate policy and Stage B evidence
 * ------------------------------------------------------------------ */

/**
 * Operator-supplied reference to the Stage B per-market automatic-policy
 * approval that ADR-016 requires before any enrollment. FP04 validates and
 * freezes this evidence; it can never create or infer the approval itself.
 */
export const fundedShadowStageBApprovalSchema = z
  .object({
    approvalRef: z.string().min(1).max(500),
    approvedAt: isoDateTime,
    approvedBy: z.string().min(1).max(200),
    /** Frozen numeric practical-effect threshold, recorded for the boundary. */
    mMarket: positive,
    referenceSessionCount: z
      .number()
      .int()
      .safe()
      .min(FUNDED_SHADOW_QUALIFYING_REFERENCE_SESSIONS),
    referenceSessionDigest: contentDigest,
    referenceWindowStart: sessionDate,
    referenceWindowEnd: sessionDate,
    referenceEvidenceCutoffAt: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.referenceWindowStart >= value.referenceWindowEnd)
      ctx.addIssue({
        code: "custom",
        path: ["referenceWindowEnd"],
        message: "The Stage B reference window must be chronological",
      });
    if (
      Number.isFinite(Date.parse(value.approvedAt)) &&
      Number.isFinite(Date.parse(value.referenceEvidenceCutoffAt)) &&
      Date.parse(value.approvedAt) < Date.parse(value.referenceEvidenceCutoffAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["approvedAt"],
        message:
          "The Stage B approval cannot precede its reference evidence cutoff",
      });
  });
export type FundedShadowStageBApproval = z.infer<
  typeof fundedShadowStageBApprovalSchema
>;

/**
 * The ADR-016 SHADOW window is a floor: an enrollment may widen but never
 * weaken the frozen minimums or horizons.
 */
export const fundedShadowGateWindowSchema = z
  .object({
    minDecisions: z
      .number()
      .int()
      .safe()
      .min(FUNDED_SHADOW_WINDOW.minDecisions),
    minSessions: z.number().int().safe().min(FUNDED_SHADOW_WINDOW.minSessions),
    horizonSessions: z
      .number()
      .int()
      .safe()
      .min(FUNDED_SHADOW_WINDOW.horizonSessions),
    horizonDays: z.number().int().safe().min(FUNDED_SHADOW_WINDOW.horizonDays),
  })
  .strict();
export type FundedShadowGateWindow = z.infer<
  typeof fundedShadowGateWindowSchema
>;

/**
 * Immutable, market-scoped gate-policy specification. It freezes the window,
 * the approved challenger policy identity, the prediction lag and the Stage B
 * approval reference before any eligible observation exists.
 */
export const fundedShadowGatePolicySchema = z
  .object({
    gatePolicyVersion: z.literal(FUNDED_SHADOW_GATE_POLICY_VERSION),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    stageBApproval: fundedShadowStageBApprovalSchema,
    window: fundedShadowGateWindowSchema,
    challengerPolicyVersion: z.literal(
      FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
    ),
    maxPredictionLagMs: z
      .number()
      .int()
      .safe()
      .min(FUNDED_SHADOW_MIN_PREDICTION_LAG_MS)
      .max(FUNDED_SHADOW_MAX_PREDICTION_LAG_MS),
    gatePolicyDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => enforceMarketCurrency(value, ctx));
export type FundedShadowGatePolicy = z.infer<
  typeof fundedShadowGatePolicySchema
>;

/** The gate-policy payload that is hashed; the digest itself is excluded. */
export type FundedShadowGatePolicyDraft = Omit<
  FundedShadowGatePolicy,
  "gatePolicyDigest"
>;

/* ------------------------------------------------------------------ *
 * Enrollment
 * ------------------------------------------------------------------ */

export const fundedShadowSourceKindSchema = z.literal("LIVE_PAPER");
export type FundedShadowSourceKind = z.infer<
  typeof fundedShadowSourceKindSchema
>;

export const fundedShadowEnrollmentSchema = z
  .object({
    enrollmentVersion: z.literal(FUNDED_SHADOW_ENROLLMENT_VERSION),
    id: uuid,
    gatePolicyId: uuid,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    sourceKind: fundedShadowSourceKindSchema,
    /** Frozen FP03 policy identities: the champion and the inactive challenger. */
    champion: fundedComparisonChampionPolicyIdentitySchema,
    challenger: fundedComparisonChallengerPolicyIdentitySchema,
    /** No attempt may exist before this database-owned enrollment time. */
    effectiveFrom: isoDateTime,
    /** The challenger's training evidence must precede the enrollment window. */
    evidenceCutoffAt: isoDateTime,
    registrationRequestId: z.string().min(1),
    requestHash: contentDigest,
    enrollmentDigest: contentDigest,
    createdAt: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    if (
      Number.isFinite(Date.parse(value.effectiveFrom)) &&
      Number.isFinite(Date.parse(value.evidenceCutoffAt)) &&
      Date.parse(value.effectiveFrom) < Date.parse(value.evidenceCutoffAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["effectiveFrom"],
        message:
          "An enrollment cannot begin before its challenger training evidence cutoff",
      });
  });
export type FundedShadowEnrollment = z.infer<
  typeof fundedShadowEnrollmentSchema
>;

export type FundedShadowEnrollmentDraft = Omit<
  FundedShadowEnrollment,
  "id" | "effectiveFrom" | "createdAt" | "enrollmentDigest"
>;

export const fundedShadowEnrollmentTransitionSchema = z
  .object({
    enrollmentId: uuid,
    sequence: z.number().int().safe().positive(),
    action: fundedShadowTransitionActionSchema,
    state: fundedShadowEnrollmentStateSchema,
    requestId: z.string().min(1),
    requestHash: contentDigest,
    effectiveAt: isoDateTime,
  })
  .strict();
export type FundedShadowEnrollmentTransition = z.infer<
  typeof fundedShadowEnrollmentTransitionSchema
>;

/** Enrollment plus its latest append-only state, as read by the observer. */
export const fundedShadowActiveEnrollmentSchema = z
  .object({
    enrollment: fundedShadowEnrollmentSchema,
    gatePolicy: fundedShadowGatePolicySchema,
    state: fundedShadowEnrollmentStateSchema,
  })
  .strict();
export type FundedShadowActiveEnrollment = z.infer<
  typeof fundedShadowActiveEnrollmentSchema
>;

/* ------------------------------------------------------------------ *
 * Batches, attempts, results
 * ------------------------------------------------------------------ */

export const fundedShadowBatchSchema = z
  .object({
    id: uuid,
    enrollmentId: uuid,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    runId: uuid,
    accountId: uuid,
    sessionDate: sessionDate,
    decisionAt: isoDateTime,
    championIdentityDigest: contentDigest,
    sealedAt: isoDateTime,
    batchDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => enforceMarketCurrency(value, ctx));
export type FundedShadowBatch = z.infer<typeof fundedShadowBatchSchema>;

export const fundedShadowChampionActionSchema = z.enum([
  "SUBMIT",
  "DECLINE",
  "DEFER",
  "UNAVAILABLE",
]);
export type FundedShadowChampionAction = z.infer<
  typeof fundedShadowChampionActionSchema
>;

export const fundedShadowAttemptSchema = z
  .object({
    attemptVersion: z.literal(FUNDED_SHADOW_ATTEMPT_VERSION),
    id: uuid,
    batchId: uuid,
    enrollmentId: uuid,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    runId: uuid,
    accountId: uuid,
    observationId: uuid,
    sessionDate: sessionDate,
    /** Null only when the champion decision input is unavailable. */
    decisionSequence: z.number().int().safe().positive().nullable(),
    decisionInputDigest: contentDigest.nullable(),
    championAction: fundedShadowChampionActionSchema,
    decisionAt: isoDateTime,
    deadlineAt: isoDateTime,
    recordedAt: isoDateTime,
    attemptDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    const hasInput =
      value.decisionSequence !== null && value.decisionInputDigest !== null;
    if (hasInput !== (value.championAction !== "UNAVAILABLE"))
      ctx.addIssue({
        code: "custom",
        path: ["decisionSequence"],
        message:
          "An attempt either retains its exact champion decision or records it unavailable",
      });
    if (
      Number.isFinite(Date.parse(value.deadlineAt)) &&
      Number.isFinite(Date.parse(value.decisionAt)) &&
      Date.parse(value.deadlineAt) <= Date.parse(value.decisionAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "An attempt deadline follows its decision time",
      });
  });
export type FundedShadowAttempt = z.infer<typeof fundedShadowAttemptSchema>;

export const fundedShadowAttemptResultDispositionSchema = z.enum([
  "TIMELY_PREDICTION",
  "MISSED_DEADLINE",
  "INVALID_IDENTITY",
  "INFERENCE_FAILURE",
  "INPUT_UNAVAILABLE",
]);
export type FundedShadowAttemptResultDisposition = z.infer<
  typeof fundedShadowAttemptResultDispositionSchema
>;

/**
 * Stable failure reason codes. They are descriptive only: no reason code
 * grants, restores or bypasses any funded authority.
 */
export const fundedShadowFailureReasonSchema = z.enum([
  "DECISION_MISSING",
  "DECISION_NOT_V2",
  "DECISION_CONTENT_INVALID",
  "DECISION_DIGEST_MISMATCH",
  "DECISION_SEQUENCE_MISMATCH",
  "MARKET_CURRENCY_MISMATCH",
  "MODEL_IDENTITY_MISMATCH",
  "MODEL_NOT_INACTIVE",
  "MODEL_NOT_FOUND",
  "PREDICTION_CONFLICT",
  "PREDICTION_MISSING",
  "PREDICTION_LATE",
  "PREDICTION_INVALID_IDENTITY",
  "PREDICTION_INFERENCE_FAILED",
  "PREDICTION_INPUT_UNAVAILABLE",
  "PREDICTION_NOT_RETAINED",
  "DEADLINE_EXPIRED",
  "ENGINE_FAILED",
  "INVALID_DIAGNOSTIC",
  "OWNERSHIP_REFUSAL",
  "BATCH_ALREADY_CLOSED",
  "LATE_INPUT",
  "INTERNAL_ERROR",
]);
export type FundedShadowFailureReason = z.infer<
  typeof fundedShadowFailureReasonSchema
>;

export const fundedShadowAttemptResultSchema = z
  .object({
    attemptId: uuid,
    enrollmentId: uuid,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    disposition: fundedShadowAttemptResultDispositionSchema,
    /** Present only for a timely prediction. */
    predictionId: uuid.nullable(),
    predictionDigest: contentDigest.nullable(),
    /** Present for every non-timely disposition. */
    failureReason: fundedShadowFailureReasonSchema.nullable(),
    recordedAt: isoDateTime,
    resultDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    if (value.disposition === "TIMELY_PREDICTION") {
      if (value.predictionId === null || value.predictionDigest === null)
        ctx.addIssue({
          code: "custom",
          path: ["predictionId"],
          message:
            "A timely prediction retains its durable prediction identity",
        });
      if (value.failureReason !== null)
        ctx.addIssue({
          code: "custom",
          path: ["failureReason"],
          message: "A timely prediction has no failure reason",
        });
      return;
    }
    if (
      value.predictionId !== null ||
      value.predictionDigest !== null ||
      value.failureReason === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["failureReason"],
        message:
          "A non-timely attempt retains no prediction and one stable failure reason",
      });
  });
export type FundedShadowAttemptResult = z.infer<
  typeof fundedShadowAttemptResultSchema
>;

export const fundedShadowBatchDispositionSchema = z.enum([
  "CHALLENGER_ORDER",
  "FALLBACK_CHAMPION_ORDER",
]);
export type FundedShadowBatchDisposition = z.infer<
  typeof fundedShadowBatchDispositionSchema
>;

export const fundedShadowBatchProjectionSchema = z
  .object({
    projectionVersion: z.literal(FUNDED_SHADOW_PROJECTION_VERSION),
    batchId: uuid,
    enrollmentId: uuid,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    batchDisposition: fundedShadowBatchDispositionSchema,
    fallbackReason: fundedShadowFailureReasonSchema.nullable(),
    /** Ordered attempt identities in the applied challenger order. */
    orderedAttemptIds: z.array(uuid).min(1).max(500),
    predictionCoverage: rate,
    /** Members whose applied rank differs from champion order. */
    orderChanges: safeCount,
    recordedAt: isoDateTime,
    projectionDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    if (
      (value.batchDisposition === "CHALLENGER_ORDER" &&
        value.fallbackReason !== null) ||
      (value.batchDisposition === "FALLBACK_CHAMPION_ORDER" &&
        value.fallbackReason === null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["fallbackReason"],
        message: "A fallback batch names exactly one stable reason",
      });
  });
export type FundedShadowBatchProjection = z.infer<
  typeof fundedShadowBatchProjectionSchema
>;

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

export const fundedShadowLabelStatusSchema = z.enum([
  "POSITIVE",
  "NEGATIVE",
  "UNRESOLVED",
]);
export type FundedShadowLabelStatus = z.infer<
  typeof fundedShadowLabelStatusSchema
>;

export const fundedShadowLabelSchema = z
  .object({
    labelVersion: z.literal(FUNDED_SHADOW_LABEL_VERSION),
    attemptId: uuid,
    enrollmentId: uuid,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    status: fundedShadowLabelStatusSchema,
    rMultiple: finite.nullable(),
    /** The canonical QUOTE execution's exit time, never a later wall clock. */
    labelAvailableAt: isoDateTime.nullable(),
    unresolvedReason: z
      .enum(["CANONICAL_QUOTE_OUTCOME_NOT_RETAINED", "R_MULTIPLE_NOT_RETAINED"])
      .nullable(),
    evidenceExecutionId: uuid.nullable(),
    recordedAt: isoDateTime,
    labelDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    if (value.status === "UNRESOLVED") {
      if (
        value.rMultiple !== null ||
        value.unresolvedReason === null ||
        value.evidenceExecutionId !== null
      )
        ctx.addIssue({
          code: "custom",
          path: ["unresolvedReason"],
          message:
            "An unresolved label retains its reason and no outcome value",
        });
      return;
    }
    if (
      value.rMultiple === null ||
      value.labelAvailableAt === null ||
      value.evidenceExecutionId === null ||
      value.unresolvedReason !== null
    )
      ctx.addIssue({
        code: "custom",
        path: ["rMultiple"],
        message:
          "A resolved label retains its independent canonical outcome and availability time",
      });
    if (
      value.status === "POSITIVE" &&
      value.rMultiple !== null &&
      value.rMultiple <= 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A positive label retains a positive net R multiple",
      });
    if (
      value.status === "NEGATIVE" &&
      value.rMultiple !== null &&
      value.rMultiple > 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A negative label retains a non-positive net R multiple",
      });
  });
export type FundedShadowLabel = z.infer<typeof fundedShadowLabelSchema>;

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

export const fundedShadowOutcomeDistributionSchema = z
  .object({
    positive: safeCount,
    negative: safeCount,
    unresolved: safeCount,
    pending: safeCount,
    meanRMultiple: finite.nullable(),
  })
  .strict();
export type FundedShadowOutcomeDistribution = z.infer<
  typeof fundedShadowOutcomeDistributionSchema
>;

export const fundedShadowSideMetricsSchema = z
  .object({
    decisions: safeCount,
    /** Outcome distribution of each batch's first-ranked decision. */
    firstRank: fundedShadowOutcomeDistributionSchema,
    /** Outcome distribution over every decision in the population. */
    allDecisions: fundedShadowOutcomeDistributionSchema,
  })
  .strict();
export type FundedShadowSideMetrics = z.infer<
  typeof fundedShadowSideMetricsSchema
>;

export const fundedShadowChampionActionCountsSchema = z
  .object({
    submit: safeCount,
    decline: safeCount,
    defer: safeCount,
    unavailable: safeCount,
  })
  .strict();
export type FundedShadowChampionActionCounts = z.infer<
  typeof fundedShadowChampionActionCountsSchema
>;

export const fundedShadowDeltaMetricsSchema = z
  .object({
    firstRankPositiveRate: finite.nullable(),
    firstRankNegativeRate: finite.nullable(),
    firstRankMeanRMultiple: finite.nullable(),
    allDecisionsMeanRMultiple: finite.nullable(),
  })
  .strict();
export type FundedShadowDeltaMetrics = z.infer<
  typeof fundedShadowDeltaMetricsSchema
>;

export const fundedShadowCoverageSchema = z
  .object({
    eligibleObservations: safeCount,
    attemptedObservations: safeCount,
    inputCoverage: rate.nullable(),
    sealedBatches: safeCount,
    closedBatches: safeCount,
    fallbackBatches: safeCount,
    fallbackRate: rate.nullable(),
    timelyPredictions: safeCount,
    missedDeadline: safeCount,
    invalidIdentity: safeCount,
    inferenceFailure: safeCount,
    inputUnavailable: safeCount,
    pendingAttempts: safeCount,
    predictionCoverage: rate.nullable(),
    labelsAvailable: safeCount,
    labelsPending: safeCount,
    labelsPermanentlyUnresolved: safeCount,
    labelCompleteness: rate.nullable(),
  })
  .strict();
export type FundedShadowCoverage = z.infer<typeof fundedShadowCoverageSchema>;

export const fundedShadowReportSchema = z
  .object({
    reportVersion: z.literal(FUNDED_SHADOW_REPORT_VERSION),
    enrollmentId: uuid,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    enrollmentState: fundedShadowEnrollmentStateSchema,
    gatePolicyDigest: contentDigest,
    challengerPolicyVersion: z.string().min(1),
    challengerPolicyDigest: contentDigest,
    maxPredictionLagMs: z.number().int().safe().positive(),
    champion: fundedComparisonChampionPolicyIdentitySchema,
    challenger: fundedComparisonChallengerPolicyIdentitySchema,
    evidenceBoundary: z
      .object({
        asOf: isoDateTime,
        firstDecisionAt: isoDateTime.nullable(),
        lastDecisionAt: isoDateTime.nullable(),
        sealedBatches: safeCount,
        closedBatches: safeCount,
        attempts: safeCount,
        terminalAttempts: safeCount,
      })
      .strict(),
    coverage: fundedShadowCoverageSchema,
    championActions: fundedShadowChampionActionCountsSchema,
    championMetrics: fundedShadowSideMetricsSchema,
    challengerMetrics: fundedShadowSideMetricsSchema,
    deltas: fundedShadowDeltaMetricsSchema,
    orderAgreement: z
      .object({
        batches: safeCount,
        changedBatches: safeCount,
        orderChangeRate: rate.nullable(),
      })
      .strict(),
    window: z
      .object({
        minDecisions: z.number().int().safe().positive(),
        minSessions: z.number().int().safe().positive(),
        horizonSessions: z.number().int().safe().positive(),
        horizonDays: z.number().int().safe().positive(),
        decisions: safeCount,
        sessions: safeCount,
        minimumsMet: z.boolean(),
        /**
         * Volume minimums met with zero fallbacks, zero missed deadlines and no
         * pending attempts. This is FP04 evidence eligibility only; it is not a
         * promotion verdict, and FP05 owns every gate verdict and transition.
         */
        gateEligible: z.boolean(),
      })
      .strict(),
    /**
     * FP04 v1 observes decisions and shared independent labels. It does not
     * simulate a funded shadow account and never derives a challenger value
     * from the champion's funded results.
     */
    fundedEconomics: z
      .object({
        status: z.literal("NOT_PROJECTED_IN_V1"),
        reason: z.literal("DECISION_LEVEL_SHADOW_OBSERVATION"),
      })
      .strict(),
    promotionAuthorized: z.literal(false),
    authorityEffect: z.literal("NONE"),
    reportDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => enforceMarketCurrency(value, ctx));
export type FundedShadowReport = z.infer<typeof fundedShadowReportSchema>;

export type FundedShadowReportDraft = Omit<FundedShadowReport, "reportDigest">;

/** Read-only availability projection for one enrollment. */
export const fundedShadowAvailabilityReceiptSchema = z
  .object({
    enrollmentId: uuid,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    state: fundedShadowEnrollmentStateSchema,
    sealedBatches: safeCount,
    attempts: safeCount,
    terminalAttempts: safeCount,
    reportsAvailable: safeCount,
    latestReportDigest: contentDigest.nullable(),
    latestReportAsOf: isoDateTime.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => enforceMarketCurrency(value, ctx));
export type FundedShadowAvailabilityReceipt = z.infer<
  typeof fundedShadowAvailabilityReceiptSchema
>;

/* ------------------------------------------------------------------ *
 * Operational status (metrics source)
 * ------------------------------------------------------------------ */

export const fundedShadowObserverEventKindSchema = z.enum([
  "LEASE_CONTENDED",
  "LEASE_ACQUIRED",
  "OBSERVER_FAILURE",
  "RECONCILE_FAILURE",
  "OWNERSHIP_REFUSAL",
  "LATE_INPUT",
]);
export type FundedShadowObserverEventKind = z.infer<
  typeof fundedShadowObserverEventKindSchema
>;

export const fundedShadowStatusSchema = z
  .object({
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    /** Latest state across the market's enrollments, null when none exist. */
    enrollmentState: fundedShadowEnrollmentStateSchema.nullable(),
    activeEnrollments: safeCount,
    sealedBatches: safeCount,
    pendingAttempts: safeCount,
    oldestPendingAttemptAgeMs: safeCount.nullable(),
    timelyPredictions: safeCount,
    missedDeadline: safeCount,
    invalidIdentity: safeCount,
    inferenceFailure: safeCount,
    inputUnavailable: safeCount,
    fallbackBatches: safeCount,
    predictionCoverage: rate.nullable(),
    labelCompleteness: rate.nullable(),
    reportsAvailable: safeCount,
    latestReportAgeMs: safeCount.nullable(),
    observerFailures: safeCount,
    reconcileFailures: safeCount,
    leaseContention: safeCount,
    ownershipRefusals: safeCount,
    lateInputs: safeCount,
    readAt: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => enforceMarketCurrency(value, ctx));
export type FundedShadowStatus = z.infer<typeof fundedShadowStatusSchema>;
