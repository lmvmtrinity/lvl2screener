import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import { sessionPairSchema } from "./research-evidence.js";
import { createBacktestSchema, type CreateBacktest } from "./backtests.js";
import {
  FUNDED_EXECUTION_FEATURE_VERSION,
  type FundedExecutionModelIdentity,
} from "./funded-execution-training.js";

/**
 * Shared contracts for the primary funded historical comparison (FP03).
 *
 * FP03 is authority-disabled: none of these schemas carries an activation,
 * authority, veto-bypass, sizing, ranking or recommendation field. The
 * comparison artifact is descriptive evidence for a later, separately approved
 * gate evaluation; it never grants model output any funded control.
 *
 * Canonical hashing lives at the API persistence boundary
 * (`funded-comparison-digest.ts`), never in this browser-safe module.
 */

const isoDateTime = z.string().datetime({ offset: true });
const sessionDate = z.string().date();
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const nonnegative = finite.min(0);
const positive = finite.positive();
const safeCount = z.number().int().safe().nonnegative();

/** Market and native currency are paired, never inferred. */
const marketCurrency = {
  marketId: marketIdSchema,
  currency: z.enum(["CAD", "USD"]),
} as const;

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

export const FUNDED_COMPARISON_SPEC_VERSION = "funded-comparison-spec-v1";
export const FUNDED_COMPARISON_RESULT_VERSION = "funded-comparison-result-v1";
export const FUNDED_COMPARISON_VALUATION_POLICY_VERSION =
  "funded-comparison-valuation-v1";
export const FUNDED_COMPARISON_METRICS_POLICY_VERSION =
  "funded-comparison-metrics-v1";
export const FUNDED_COMPARISON_CHAMPION_POLICY_VERSION =
  "deterministic-funded-policy-v1";
export const FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION =
  "funded-comparison-execution-quality-ordering-v1";
export const FUNDED_COMPARISON_SESSION_ELIGIBILITY_VERSION =
  "funded-comparison-sessions-v1";
export const FUNDED_COMPARISON_OPPORTUNITY_ELIGIBILITY_VERSION =
  "funded-comparison-eligible-opportunities-v1";

/** ADR-016 §4.2 mark staleness bound for union-grid valuation. */
export const FUNDED_COMPARISON_MARK_AGE_MS = 30_000;

/** Immutable input chunks hold at most this many canonical ordered items. */
export const FUNDED_COMPARISON_INPUT_CHUNK_LIMIT = 1_000;

/** ADR-016 G2 requires at least this many comparable sessions. */
export const FUNDED_COMPARISON_MINIMUM_SESSIONS = 20;

export const fundedComparisonSideSchema = z.enum(["CHAMPION", "CHALLENGER"]);
export type FundedComparisonSide = z.infer<typeof fundedComparisonSideSchema>;

export const fundedComparisonStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "READY",
  "UNAVAILABLE",
  "CANCELLED",
]);
export type FundedComparisonStatus = z.infer<
  typeof fundedComparisonStatusSchema
>;

export const fundedComparisonVolumeStatusSchema = z.enum([
  "INSUFFICIENT_SESSIONS",
  "SUFFICIENT_FOR_LATER_G2",
]);
export type FundedComparisonVolumeStatus = z.infer<
  typeof fundedComparisonVolumeStatusSchema
>;

export const fundedComparisonFailureClassificationSchema = z.enum([
  "TERMINAL",
  "INTERRUPTION",
]);
export type FundedComparisonFailureClassification = z.infer<
  typeof fundedComparisonFailureClassificationSchema
>;

/**
 * Stable fail-closed reason codes. A partially proven comparison is never a
 * "successful" result: every missing, stale, unprovable, conflicting,
 * cancelled or unresolved case carries one of these codes.
 */
export const fundedComparisonFailureReasonSchema = z.enum([
  "BASELINE_LINEAGE_UNAVAILABLE",
  "REPLAY_LINEAGE_UNAVAILABLE",
  "SESSION_MEMBERSHIP_MISMATCH",
  "OPPORTUNITY_MEMBERSHIP_MISMATCH",
  "MARKET_CURRENCY_MISMATCH",
  "CHAMPION_POLICY_IDENTITY_MISMATCH",
  "CHALLENGER_POLICY_IDENTITY_MISMATCH",
  "MODEL_IDENTITY_MISMATCH",
  "ARTIFACT_IDENTITY_MISMATCH",
  "RUNTIME_IDENTITY_MISMATCH",
  "COST_IDENTITY_MISMATCH",
  "RISK_IDENTITY_MISMATCH",
  "SOURCE_CUTOFF_AFTER_FREEZE",
  "RETAINED_INPUT_MISSING",
  "QUOTE_COVERAGE_MISSING",
  "TRAINING_CHRONOLOGY_UNPROVEN",
  "TRAINING_WINDOW_OVERLAP",
  "COMPARISON_WINDOW_NOT_AFTER_TRAINING",
  "LIVE_ACCOUNT_REPLAY_TARGET",
  "ACCOUNT_IDENTITY_COLLISION",
  "CHAMPION_NOT_RETAINED",
  "PREDICTION_DECISION_UNAVAILABLE",
  "STALE_MARK",
  "UNPROVABLE_CAUSAL_ORDER",
  "UNRESOLVED_ORDER",
  "UNRESOLVED_RESERVATION",
  "UNRESOLVED_POSITION",
  "INCOMPLETE_SESSION",
  "CANCELLED",
  "LEASE_LOST",
  "CONFLICTING_RETRY",
  "RESULT_DIGEST_CONFLICT",
  "INTERNAL_ERROR",
]);
export type FundedComparisonFailureReason = z.infer<
  typeof fundedComparisonFailureReasonSchema
>;

/** Interruption receipts do not poison a later authorized exact-spec retry. */
export function isResumableComparisonFailure(
  reason: FundedComparisonFailureReason,
): boolean {
  return reason === "CANCELLED" || reason === "LEASE_LOST";
}

/**
 * Closed classifier over the exact existing `FundedRiskVeto` messages. FP03
 * consumes the structured code; it never parses a message. An unrecognized
 * legacy row maps to `UNKNOWN_VETO_REASON` and makes the side's classification
 * `UNAVAILABLE` rather than dropping or merging the row.
 */
export const fundedComparisonVetoReasonSchema = z.enum([
  "MAX_OPEN_POSITIONS",
  "MAX_TOTAL_OPEN_RISK",
  "CONTEXT_UNAVAILABLE_OR_STALE",
  "WEAK_CONTEXT",
  "SYMBOL_EXPOSURE",
  "SECTOR_EXPOSURE",
  "POST_STOP_COOLDOWN",
  "CONSECUTIVE_STOP_LIMIT",
  "DAILY_LOSS_OR_BUYING_POWER",
  "FILL_EXCEEDS_RESERVATION",
  "UNKNOWN_VETO_REASON",
]);
export type FundedComparisonVetoReason = z.infer<
  typeof fundedComparisonVetoReasonSchema
>;

/** The stable structured funded risk-veto code carried alongside the message. */
export const FUNDED_RISK_VETO_CODES = fundedComparisonVetoReasonSchema.options;

/* ------------------------------------------------------------------ *
 * Baseline and policy identity
 * ------------------------------------------------------------------ */

export const fundedComparisonBaselineIdentitySchema = z
  .object({
    backtestRunId: z.string().min(1),
    configVersion: z.string().min(1),
    strategyKeys: z.array(z.string().min(1)).min(1),
    startDate: sessionDate,
    endDate: sessionDate,
    executionModelVersion: z.string().min(1),
    replayInputDigest: contentDigest,
    baselineResultDigest: contentDigest,
    completedAt: isoDateTime,
  })
  .strict();
export type FundedComparisonBaselineIdentity = z.infer<
  typeof fundedComparisonBaselineIdentitySchema
>;

export const fundedComparisonChampionPolicyIdentitySchema = z
  .object({
    kind: z.literal("DETERMINISTIC_FUNDED_POLICY"),
    fundedPolicyVersion: z.string().min(1),
    portfolioPolicyVersion: z.string().min(1),
    policyDigest: contentDigest,
    sourceLiveRunId: z.string().min(1),
    sourceAccountId: z.string().min(1),
    executionModelVersion: z.string().min(1),
    costPolicyVersion: z.string().min(1),
    participationVersion: z.string().min(1),
    runtimeVersion: z.string().min(1),
    accountAssumptionDigest: contentDigest,
    assumptionsDigest: contentDigest,
  })
  .strict();
export type FundedComparisonChampionPolicyIdentity = z.infer<
  typeof fundedComparisonChampionPolicyIdentitySchema
>;

export const fundedComparisonChallengerModelIdentitySchema = z
  .object({
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
    artifactDigest: contentDigest,
    datasetDigest: contentDigest,
    cohortDigest: contentDigest,
    featureVersion: z.literal(FUNDED_EXECUTION_FEATURE_VERSION),
    predictionPolicyVersion: z.string().min(1),
    trainingPartitionDigest: contentDigest,
    trainingEvidenceCutoffAt: isoDateTime,
    trainingSessionDigest: contentDigest,
  })
  .strict();
export type FundedComparisonChallengerModelIdentity = z.infer<
  typeof fundedComparisonChallengerModelIdentitySchema
>;

export const fundedComparisonChallengerPolicyIdentitySchema = z
  .object({
    kind: z.literal("FUNDED_EXECUTION_POLICY_V1"),
    policyVersion: z.literal(FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION),
    policyDigest: contentDigest,
    model: fundedComparisonChallengerModelIdentitySchema,
  })
  .strict();
export type FundedComparisonChallengerPolicyIdentity = z.infer<
  typeof fundedComparisonChallengerPolicyIdentitySchema
>;

export const fundedComparisonCapitalSchema = z
  .object({
    initialCash: positive,
    dailyLossLimit: positive,
    riskConfigurationDigest: contentDigest,
  })
  .strict();
export type FundedComparisonCapital = z.infer<
  typeof fundedComparisonCapitalSchema
>;

/* ------------------------------------------------------------------ *
 * Membership
 * ------------------------------------------------------------------ */

function datesAscendingUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! <= values[index - 1]!) return false;
  }
  return true;
}

export const fundedComparisonSessionMembershipSchema = z
  .object({
    orderedSessionDates: z.array(sessionDate).min(1),
    sessionMembershipDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!datesAscendingUnique(value.orderedSessionDates))
      ctx.addIssue({
        code: "custom",
        path: ["orderedSessionDates"],
        message: "Session membership must be unique and ascending",
      });
  });
export type FundedComparisonSessionMembership = z.infer<
  typeof fundedComparisonSessionMembershipSchema
>;

export const fundedComparisonOpportunityMembershipSchema = z
  .object({
    orderedOpportunityIds: z.array(z.string().min(1)).min(1),
    opportunityMembershipDigest: contentDigest,
    opportunityCount: safeCount.positive(),
    eligibilityVersion: z.literal(
      FUNDED_COMPARISON_OPPORTUNITY_ELIGIBILITY_VERSION,
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.orderedOpportunityIds).size !==
      value.orderedOpportunityIds.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["orderedOpportunityIds"],
        message: "Opportunity membership contains a duplicate source identity",
      });
    if (value.opportunityCount !== value.orderedOpportunityIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["opportunityCount"],
        message: "Opportunity count does not match the ordered membership",
      });
  });
export type FundedComparisonOpportunityMembership = z.infer<
  typeof fundedComparisonOpportunityMembershipSchema
>;

export const fundedComparisonSourceOpportunitySchema = z
  .object({
    sourceOpportunityId: z.string().min(1),
    sessionDate,
    sourceOrdinal: safeCount.positive(),
    sourceEventId: z.string().min(1),
    setupInstanceId: z.string().min(1),
    instrumentId: z.string().min(1),
    profileConfigId: z.string().min(1),
    signalTimestamp: isoDateTime,
    sourceContentDigest: contentDigest,
  })
  .strict();
export type FundedComparisonSourceOpportunity = z.infer<
  typeof fundedComparisonSourceOpportunitySchema
>;

/* ------------------------------------------------------------------ *
 * Frozen policy-neutral shared input
 * ------------------------------------------------------------------ */

export const fundedComparisonContextEntrySchema = z
  .object({
    signalKey: z.string().min(1),
    status: z.string().min(1),
    timestamp: isoDateTime,
    benchmarkTimestamp: isoDateTime.nullable(),
  })
  .strict();
export type FundedComparisonContextEntry = z.infer<
  typeof fundedComparisonContextEntrySchema
>;

const sessionBoundaryItem = z
  .object({
    kind: z.literal("SESSION_BOUNDARY"),
    sessionDate,
    sessionStartAt: isoDateTime,
    scheduledCloseAt: isoDateTime,
    sessionTimezone: z.enum(["America/Toronto", "America/New_York"]),
  })
  .strict();

const opportunityItem = z
  .object({
    kind: z.literal("OPPORTUNITY"),
    sourceOpportunityId: z.string().min(1),
    sessionDate,
    sourceOrdinal: safeCount.positive(),
    sourceEventId: z.string().min(1),
    setupInstanceId: z.string().min(1),
    instrumentId: z.string().min(1),
    symbol: z.string().min(1),
    profileConfigId: z.string().min(1),
    strategyKey: z.string().min(1),
    strategyVersion: z.string().min(1),
    score: z.number().int().min(0).max(100),
    eligibilityStatus: z.enum(["ELIGIBLE", "BELOW_SCORE_CUTOFF"]),
    eligibilityReason: z.string().min(1).nullable(),
    signalTimestamp: isoDateTime,
    signalSemanticsVersion: z.string().min(1),
    observationFeatureVersion: z.string().min(1),
    entryReference: finite.nullable(),
    stopReference: finite.nullable(),
    targetReference: finite.nullable(),
    atr14: finite.nullable(),
    reasonCodes: z.array(z.string().min(1)),
    sourceEventPayload: z.unknown(),
    featureSnapshot: z.unknown().nullable(),
    contexts: z.array(fundedComparisonContextEntrySchema),
  })
  .strict();

const quoteItem = z
  .object({
    kind: z.literal("QUOTE"),
    instrumentId: z.string().min(1),
    timestamp: isoDateTime,
    bid: positive,
    ask: positive,
    bidSize: nonnegative,
    askSize: nonnegative,
    sizeUnit: z.enum(["SHARES", "UNKNOWN"]),
    sizeMultiplier: nonnegative,
    dataStatus: z.enum(["REALTIME", "DELAYED", "HALTED"]),
    actionable: z.boolean(),
    source: z.string().min(1),
  })
  .strict();

const invalidationItem = z
  .object({
    kind: z.literal("INVALIDATION"),
    eventId: z.string().min(1),
    sourceOpportunityId: z.string().min(1),
    at: isoDateTime,
  })
  .strict();

export const fundedComparisonInputItemSchema = z.discriminatedUnion("kind", [
  sessionBoundaryItem,
  opportunityItem,
  quoteItem,
  invalidationItem,
]);
export type FundedComparisonInputItem = z.infer<
  typeof fundedComparisonInputItemSchema
>;

export const fundedComparisonInputItemEntrySchema = z
  .object({
    itemDigest: contentDigest,
    item: fundedComparisonInputItemSchema,
  })
  .strict();
export type FundedComparisonInputItemEntry = z.infer<
  typeof fundedComparisonInputItemEntrySchema
>;

export const fundedComparisonInputChunkSchema = z
  .object({
    sessionDate,
    chunkOrdinal: safeCount.positive(),
    itemCount: safeCount.min(1).max(FUNDED_COMPARISON_INPUT_CHUNK_LIMIT),
    firstEffectiveAt: isoDateTime,
    lastEffectiveAt: isoDateTime,
    chunkDigest: contentDigest,
    items: z
      .array(fundedComparisonInputItemEntrySchema)
      .min(1)
      .max(FUNDED_COMPARISON_INPUT_CHUNK_LIMIT),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.itemCount !== value.items.length)
      ctx.addIssue({
        code: "custom",
        path: ["itemCount"],
        message: "itemCount does not match the ordered item membership",
      });
    let previous = "";
    for (const [index, entry] of value.items.entries()) {
      const at = inputItemEffectiveAt(entry.item);
      if (index === 0 && at !== value.firstEffectiveAt)
        ctx.addIssue({
          code: "custom",
          path: ["firstEffectiveAt"],
          message: "firstEffectiveAt is not the first item effective time",
        });
      if (index === value.items.length - 1 && at !== value.lastEffectiveAt)
        ctx.addIssue({
          code: "custom",
          path: ["lastEffectiveAt"],
          message: "lastEffectiveAt is not the last item effective time",
        });
      const key = inputItemOrderKey(entry.item);
      if (index > 0 && key < previous)
        ctx.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Input items are not in canonical order",
        });
      previous = key;
    }
  });
export type FundedComparisonInputChunk = z.infer<
  typeof fundedComparisonInputChunkSchema
>;

/** Effective time of one shared input item. Database insertion time never orders. */
export function inputItemEffectiveAt(item: FundedComparisonInputItem): string {
  switch (item.kind) {
    case "SESSION_BOUNDARY":
      return item.sessionStartAt;
    case "OPPORTUNITY":
      return item.signalTimestamp;
    case "QUOTE":
      return item.timestamp;
    case "INVALIDATION":
      return item.at;
  }
}

/**
 * Canonical total order key: (effective time, kind rank, stable identity).
 * ADR-016 material equal-time precedence is `CANCEL < CLOCK < SIGNAL < QUOTE`:
 * a pre-submission invalidation is applied before the clock, the signal before
 * any same-time quote, and the quote last.
 */
export function inputItemOrderKey(item: FundedComparisonInputItem): string {
  const rank =
    item.kind === "INVALIDATION"
      ? "0"
      : item.kind === "SESSION_BOUNDARY"
        ? "1"
        : item.kind === "OPPORTUNITY"
          ? "2"
          : "3";
  const identity =
    item.kind === "SESSION_BOUNDARY"
      ? item.sessionDate
      : item.kind === "OPPORTUNITY"
        ? `${item.sourceOrdinal.toString().padStart(10, "0")}:${item.sourceOpportunityId}`
        : item.kind === "QUOTE"
          ? `${item.instrumentId}:${item.timestamp}:${item.source}`
          : `${item.eventId}`;
  return `${inputItemEffectiveAt(item)}|${rank}|${identity}`;
}

/* ------------------------------------------------------------------ *
 * Frozen shared-input membership and replay configuration
 * ------------------------------------------------------------------ */

/**
 * One frozen session's ordered shared-input identity. `itemCount`, `chunkCount`
 * and `sessionInputDigest` are recomputed from the persisted chunks, so a
 * changed chunk boundary or count changes `comparisonSpecDigest`.
 */
export const fundedComparisonSharedInputSessionSchema = z
  .object({
    sessionDate,
    itemCount: safeCount.positive(),
    chunkCount: safeCount.positive(),
    sessionInputDigest: contentDigest,
  })
  .strict();
export type FundedComparisonSharedInputSession = z.infer<
  typeof fundedComparisonSharedInputSessionSchema
>;

export const fundedComparisonSharedInputSchema = z
  .object({
    orderedSessions: z.array(fundedComparisonSharedInputSessionSchema).min(1),
    sharedInputDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !datesAscendingUnique(
        value.orderedSessions.map((session) => session.sessionDate),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["orderedSessions"],
        message: "Shared-input session entries must be unique and ascending",
      });
  });
export type FundedComparisonSharedInput = z.infer<
  typeof fundedComparisonSharedInputSchema
>;

/** The frozen profile/config identity a comparison replay materializes. */
export const fundedComparisonReplayProfileSchema = z
  .object({
    strategyKey: z.string().min(1),
    profileId: z.string().min(1),
    profileName: z.string().min(1),
    profileConfigId: z.string().min(1),
    configVersion: z.string().min(1),
  })
  .strict();
export type FundedComparisonReplayProfile = z.infer<
  typeof fundedComparisonReplayProfileSchema
>;

/**
 * Comparison-owned immutable replay configuration. Replay reads only this
 * payload; it never re-reads mutable `backtest_run` strategies/parameters or
 * any other current configuration.
 */
export const fundedComparisonReplayConfigurationSchema = z
  .object({
    request: createBacktestSchema,
    requestDigest: contentDigest,
    profiles: z.array(fundedComparisonReplayProfileSchema).min(1),
    profilesDigest: contentDigest,
  })
  .strict();
export type FundedComparisonReplayConfiguration = z.infer<
  typeof fundedComparisonReplayConfigurationSchema
>;

/** The payload a frozen replay request must carry, for typing convenience. */
export type FundedComparisonReplayRequest = CreateBacktest;

/* ------------------------------------------------------------------ *
 * Specification
 * ------------------------------------------------------------------ */

export const fundedComparisonSpecificationSchema = z
  .object({
    specVersion: z.literal(FUNDED_COMPARISON_SPEC_VERSION),
    ...marketCurrency,
    baseline: fundedComparisonBaselineIdentitySchema,
    sessionMembership: fundedComparisonSessionMembershipSchema,
    sharedInput: fundedComparisonSharedInputSchema,
    replay: fundedComparisonReplayConfigurationSchema,
    opportunityMembership: fundedComparisonOpportunityMembershipSchema,
    champion: fundedComparisonChampionPolicyIdentitySchema,
    challenger: fundedComparisonChallengerPolicyIdentitySchema,
    capital: fundedComparisonCapitalSchema,
    valuationPolicyVersion: z.literal(
      FUNDED_COMPARISON_VALUATION_POLICY_VERSION,
    ),
    metricsPolicyVersion: z.literal(FUNDED_COMPARISON_METRICS_POLICY_VERSION),
    evidenceCutoffAt: isoDateTime,
    specificationFrozenAt: isoDateTime,
    comparisonSpecDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    if (value.sessionMembership.orderedSessionDates.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["sessionMembership"],
        message: "A comparison requires at least one session",
      });
    if (value.evidenceCutoffAt > value.specificationFrozenAt)
      ctx.addIssue({
        code: "custom",
        path: ["evidenceCutoffAt"],
        message:
          "Evidence cutoff cannot be after the specification freeze time",
      });
    const sharedDates = value.sharedInput.orderedSessions.map(
      (session) => session.sessionDate,
    );
    if (
      sharedDates.length !==
        value.sessionMembership.orderedSessionDates.length ||
      sharedDates.some(
        (date, index) =>
          date !== value.sessionMembership.orderedSessionDates[index],
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["sharedInput", "orderedSessions"],
        message:
          "Frozen shared input must cover exactly the session membership in order",
      });
    if (value.replay.request.marketId !== value.marketId)
      ctx.addIssue({
        code: "custom",
        path: ["replay", "request", "marketId"],
        message: "The frozen replay request belongs to another market",
      });
  });
export type FundedComparisonSpecification = z.infer<
  typeof fundedComparisonSpecificationSchema
>;

/* ------------------------------------------------------------------ *
 * Per-session run binding and policy evaluation
 * ------------------------------------------------------------------ */

export const fundedComparisonRunBindingSchema = z
  .object({
    specId: z.string().min(1),
    side: fundedComparisonSideSchema,
    sessionDate,
    runId: z.string().min(1),
    accountId: z.string().min(1),
    ...marketCurrency,
    policyDigest: contentDigest,
    executionModelVersion: z.string().min(1),
    accountAssumptionDigest: contentDigest,
    boundAt: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
  });
export type FundedComparisonRunBinding = z.infer<
  typeof fundedComparisonRunBindingSchema
>;

/** One immutable binding per `(specification, side, session)`. */
export function fundedComparisonRunBindingKey(binding: {
  specId: string;
  side: FundedComparisonSide;
  sessionDate: string;
}): string {
  return `${binding.specId}:${binding.side}:${binding.sessionDate}`;
}

export const fundedComparisonDispositionSchema = z.enum([
  "CHAMPION_ORDER",
  "PREDICTED",
  "FALLBACK_CHAMPION_ORDER",
]);
export type FundedComparisonDisposition = z.infer<
  typeof fundedComparisonDispositionSchema
>;

export const fundedComparisonPredictionIdentitySchema = z
  .object({
    runId: z.string().min(1),
    observationId: z.string().min(1),
    decisionSequence: safeCount.positive(),
    decisionInputDigest: contentDigest,
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
    modelType: z.literal("FUNDED_EXECUTION_QUALITY"),
    artifactDigest: contentDigest,
    cohortDigest: contentDigest,
    featureVersion: z.literal(FUNDED_EXECUTION_FEATURE_VERSION),
    inputDigest: contentDigest,
    outputDigest: contentDigest,
  })
  .strict();
export type FundedComparisonPredictionIdentity = z.infer<
  typeof fundedComparisonPredictionIdentitySchema
>;

export const fundedComparisonPolicyEvaluationSchema = z
  .object({
    specId: z.string().min(1),
    side: fundedComparisonSideSchema,
    sessionDate,
    sourceOpportunityId: z.string().min(1),
    sourceOrdinal: safeCount.positive(),
    signalTimestamp: isoDateTime,
    batchKey: z.string().min(1),
    championRank: safeCount.positive(),
    appliedRank: safeCount.positive(),
    destinationRunId: z.string().min(1),
    destinationObservationId: z.string().min(1),
    disposition: fundedComparisonDispositionSchema,
    fallbackReason: z.string().min(1).nullable(),
    prediction: fundedComparisonPredictionIdentitySchema.nullable(),
    evaluationDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.side === "CHAMPION" && value.disposition !== "CHAMPION_ORDER")
      ctx.addIssue({
        code: "custom",
        path: ["disposition"],
        message: "The champion side always applies champion order",
      });
    if (value.side === "CHAMPION" && value.prediction !== null)
      ctx.addIssue({
        code: "custom",
        path: ["prediction"],
        message: "The champion side carries no model prediction",
      });
    if (value.disposition === "PREDICTED") {
      if (value.prediction === null)
        ctx.addIssue({
          code: "custom",
          path: ["prediction"],
          message:
            "A predicted row requires its exact model input/output identity",
        });
      if (value.fallbackReason !== null)
        ctx.addIssue({
          code: "custom",
          path: ["fallbackReason"],
          message: "A predicted row carries no fallback reason",
        });
    }
    if (value.disposition === "FALLBACK_CHAMPION_ORDER") {
      if (value.prediction !== null)
        ctx.addIssue({
          code: "custom",
          path: ["prediction"],
          message: "A fallback row invents no prediction output",
        });
      if (value.fallbackReason === null)
        ctx.addIssue({
          code: "custom",
          path: ["fallbackReason"],
          message: "A fallback row requires a stable fallback reason",
        });
      if (value.appliedRank !== value.championRank)
        ctx.addIssue({
          code: "custom",
          path: ["appliedRank"],
          message: "Fallback restores champion order for the complete batch",
        });
    }
    if (value.prediction && value.side !== "CHALLENGER")
      ctx.addIssue({
        code: "custom",
        path: ["prediction"],
        message: "Only the challenger side carries comparison predictions",
      });
  });
export type FundedComparisonPolicyEvaluation = z.infer<
  typeof fundedComparisonPolicyEvaluationSchema
>;

/* ------------------------------------------------------------------ *
 * Failure and availability receipts
 * ------------------------------------------------------------------ */

export const fundedComparisonFailureReceiptSchema = z
  .object({
    specId: z.string().min(1),
    attemptId: z.string().min(1),
    side: fundedComparisonSideSchema.nullable(),
    sessionDate: sessionDate.nullable(),
    reason: fundedComparisonFailureReasonSchema,
    classification: fundedComparisonFailureClassificationSchema,
    detail: z.string().min(1),
    failureDigest: contentDigest,
    recordedAt: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    const resumable = isResumableComparisonFailure(value.reason);
    if (resumable && value.classification !== "INTERRUPTION")
      ctx.addIssue({
        code: "custom",
        path: ["classification"],
        message: "Cancellation and lease loss are interruption receipts",
      });
    if (!resumable && value.classification !== "TERMINAL")
      ctx.addIssue({
        code: "custom",
        path: ["classification"],
        message: "Only cancellation and lease loss are resumable",
      });
  });
export type FundedComparisonFailureReceipt = z.infer<
  typeof fundedComparisonFailureReceiptSchema
>;

export const fundedComparisonAvailabilityReceiptSchema = z
  .object({
    specificationId: z.string().min(1),
    ...marketCurrency,
    comparisonSpecDigest: contentDigest,
    status: fundedComparisonStatusSchema,
    sessionCount: safeCount,
    historicalVolumeStatus: fundedComparisonVolumeStatusSchema.nullable(),
    resultDigest: contentDigest.nullable(),
    resultAvailable: z.boolean(),
    failures: z.array(
      z
        .object({
          reason: fundedComparisonFailureReasonSchema,
          classification: fundedComparisonFailureClassificationSchema,
          side: fundedComparisonSideSchema.nullable(),
          sessionDate: sessionDate.nullable(),
          detail: z.string().min(1),
          recordedAt: isoDateTime,
        })
        .strict(),
    ),
    createdAt: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    if (value.resultAvailable && value.resultDigest === null)
      ctx.addIssue({
        code: "custom",
        path: ["resultDigest"],
        message: "An available result requires its canonical digest",
      });
  });
export type FundedComparisonAvailabilityReceipt = z.infer<
  typeof fundedComparisonAvailabilityReceiptSchema
>;

/* ------------------------------------------------------------------ *
 * Per-side/session metric row
 * ------------------------------------------------------------------ */

export const fundedComparisonSessionMetricSchema = z
  .object({
    specId: z.string().min(1),
    side: fundedComparisonSideSchema,
    sessionDate,
    ...marketCurrency,
    valuation: z.enum(["UNION_GRID_MTM", "UNAVAILABLE"]),
    valuationReason: fundedComparisonFailureReasonSchema.nullable(),
    netReturn: finite.nullable(),
    maxDrawdown: nonnegative.nullable(),
    tradeCount: safeCount,
    unrealizedPositionCount: safeCount,
    unresolvedOrderCount: safeCount,
    unresolvedReservationCount: safeCount,
    staleMarkCount: safeCount,
    valuationPointCount: safeCount,
    metricDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    const proven = value.valuation === "UNION_GRID_MTM";
    if (proven !== (value.valuationReason === null))
      ctx.addIssue({
        code: "custom",
        path: ["valuationReason"],
        message: proven
          ? "A proven metric carries no valuation failure reason"
          : "An unavailable metric requires its exact valuation failure reason",
      });
    if (proven !== (value.netReturn !== null && value.maxDrawdown !== null))
      ctx.addIssue({
        code: "custom",
        path: ["netReturn"],
        message: proven
          ? "A proven metric requires return and drawdown"
          : "An unavailable metric reports no derived return or drawdown",
      });
  });
export type FundedComparisonSessionMetric = z.infer<
  typeof fundedComparisonSessionMetricSchema
>;

/* ------------------------------------------------------------------ *
 * Metrics and the immutable result artifact
 * ------------------------------------------------------------------ */

export const fundedComparisonReturnMetricsSchema = z
  .object({
    totalNetReturn: finite,
    returnPctOfInitialCash: finite,
    sessions: z.array(z.object({ sessionDate, netReturn: finite }).strict()),
  })
  .strict();
export type FundedComparisonReturnMetrics = z.infer<
  typeof fundedComparisonReturnMetricsSchema
>;

export const fundedComparisonDrawdownMetricsSchema = z
  .object({
    maxDrawdown: nonnegative,
    maxDrawdownPctOfInitialCash: nonnegative,
  })
  .strict();
export type FundedComparisonDrawdownMetrics = z.infer<
  typeof fundedComparisonDrawdownMetricsSchema
>;

export const fundedComparisonDailyLossMetricsSchema = z
  .object({
    limitHits: safeCount,
    mostNegativeDailyPnl: finite,
    sessionsBlocked: safeCount,
  })
  .strict();
export type FundedComparisonDailyLossMetrics = z.infer<
  typeof fundedComparisonDailyLossMetricsSchema
>;

export const fundedComparisonRiskMetricsSchema = z
  .object({
    maxOpenRisk: nonnegative,
    maxGrossNotional: nonnegative,
    maxOpenPositions: safeCount,
  })
  .strict();
export type FundedComparisonRiskMetrics = z.infer<
  typeof fundedComparisonRiskMetricsSchema
>;

export const fundedComparisonActivityMetricsSchema = z
  .object({
    turnover: nonnegative,
    requested: safeCount,
    partialFills: safeCount,
    fullFills: safeCount,
    zeroFills: safeCount,
  })
  .strict();
export type FundedComparisonActivityMetrics = z.infer<
  typeof fundedComparisonActivityMetricsSchema
>;

export const fundedComparisonExecutionMetricsSchema = z
  .object({
    fillFraction: z.number().finite().min(0).max(1),
    averageSlippagePerShare: finite,
    totalModeledCosts: nonnegative,
  })
  .strict();
export type FundedComparisonExecutionMetrics = z.infer<
  typeof fundedComparisonExecutionMetricsSchema
>;

export const fundedComparisonCountByReasonSchema = z
  .object({
    reason: z.string().min(1),
    count: safeCount,
  })
  .strict();
export type FundedComparisonCountByReason = z.infer<
  typeof fundedComparisonCountByReasonSchema
>;

export const fundedComparisonVetoMetricsSchema = z
  .object({
    classification: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    counts: z.array(
      z
        .object({ reason: fundedComparisonVetoReasonSchema, count: safeCount })
        .strict(),
    ),
  })
  .strict();
export type FundedComparisonVetoMetrics = z.infer<
  typeof fundedComparisonVetoMetricsSchema
>;

export const fundedComparisonOpportunityCostMetricsSchema = z
  .object({
    declinedOrVetoedCount: safeCount,
    forgoneRequestedNotional: nonnegative.nullable(),
    forgoneRequestedRisk: nonnegative.nullable(),
    requestedCapitalAvailableCount: safeCount,
    requestedCapitalUnavailableCount: safeCount,
    realizedValue: finite.nullable(),
    provableCount: safeCount,
    unprovableCount: safeCount,
  })
  .strict()
  .superRefine((value, ctx) => {
    const unavailable = value.requestedCapitalUnavailableCount > 0;
    const bothNull =
      value.forgoneRequestedNotional === null &&
      value.forgoneRequestedRisk === null;
    if (unavailable !== bothNull)
      ctx.addIssue({
        code: "custom",
        path: ["forgoneRequestedNotional"],
        message: unavailable
          ? "A missing requested-capital value is reported as null, never zero"
          : "A fully available requested-capital set reports its sums",
      });
    if (
      value.requestedCapitalAvailableCount +
        value.requestedCapitalUnavailableCount !==
      value.declinedOrVetoedCount
    )
      ctx.addIssue({
        code: "custom",
        path: ["declinedOrVetoedCount"],
        message:
          "Requested-capital availability must cover every declined or vetoed decision",
      });
  });
export type FundedComparisonOpportunityCostMetrics = z.infer<
  typeof fundedComparisonOpportunityCostMetricsSchema
>;

export const fundedComparisonStabilityMetricsSchema = z
  .object({
    sessionCount: safeCount,
    zeroTradeSessions: safeCount,
    longestReturnSignRun: safeCount,
  })
  .strict();
export type FundedComparisonStabilityMetrics = z.infer<
  typeof fundedComparisonStabilityMetricsSchema
>;

export const fundedComparisonIntegrityMetricsSchema = z
  .object({
    unresolvedExposure: safeCount,
    fallbackDecisionCount: safeCount,
    predictionAvailableCount: safeCount,
    predictionRequiredCount: safeCount,
    findings: z.array(z.string().min(1)),
  })
  .strict();
export type FundedComparisonIntegrityMetrics = z.infer<
  typeof fundedComparisonIntegrityMetricsSchema
>;

const fundedComparisonSideMetricsSchema = z
  .object({
    return: fundedComparisonReturnMetricsSchema,
    drawdown: fundedComparisonDrawdownMetricsSchema,
    dailyLoss: fundedComparisonDailyLossMetricsSchema,
    risk: fundedComparisonRiskMetricsSchema,
    activity: fundedComparisonActivityMetricsSchema,
    execution: fundedComparisonExecutionMetricsSchema,
    veto: fundedComparisonVetoMetricsSchema,
    declines: z.array(fundedComparisonCountByReasonSchema),
    opportunityCost: fundedComparisonOpportunityCostMetricsSchema,
    stability: fundedComparisonStabilityMetricsSchema,
    integrity: fundedComparisonIntegrityMetricsSchema,
  })
  .strict();
export type FundedComparisonSideMetrics = z.infer<
  typeof fundedComparisonSideMetricsSchema
>;

/** Every value is `challenger − champion`. */
export const fundedComparisonDeltaMetricsSchema = z
  .object({
    totalNetReturn: finite,
    returnPctOfInitialCash: finite,
    maxDrawdown: finite,
    maxDrawdownPctOfInitialCash: finite,
    limitHits: finite,
    mostNegativeDailyPnl: finite,
    sessionsBlocked: finite,
    maxOpenRisk: finite,
    maxGrossNotional: finite,
    maxOpenPositions: finite,
    turnover: finite,
    requested: finite,
    partialFills: finite,
    fullFills: finite,
    zeroFills: finite,
    fillFraction: finite,
    averageSlippagePerShare: finite,
    totalModeledCosts: finite,
    vetoCount: finite.nullable(),
    declineCount: finite.nullable(),
    declinedOrVetoedCount: finite,
    forgoneRequestedNotional: finite.nullable(),
    forgoneRequestedRisk: finite.nullable(),
    zeroTradeSessions: finite,
    longestReturnSignRun: finite,
    sessionCount: finite,
    challengerOutperformedSessions: finite,
    unavailable: z.array(z.string().min(1)),
  })
  .strict();
export type FundedComparisonDeltaMetrics = z.infer<
  typeof fundedComparisonDeltaMetricsSchema
>;

export const fundedComparisonPairedSessionSchema = z
  .object({
    sessionDate,
    baselineNetReturn: finite.nullable(),
    challengerNetReturn: finite.nullable(),
    baselineMaxDrawdown: finite.nullable(),
    challengerMaxDrawdown: finite.nullable(),
    valuation: z.enum(["UNION_GRID_MTM", "UNAVAILABLE"]),
    coverage: z.enum(["VERIFIED", "MISSING"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const proven = value.valuation === "UNION_GRID_MTM";
    const verified = value.coverage === "VERIFIED";
    if (proven !== verified)
      ctx.addIssue({
        code: "custom",
        path: ["coverage"],
        message:
          "A proven union-grid valuation is VERIFIED; an unavailable valuation is MISSING",
      });
    const required: [string, number | null][] = [
      ["baselineNetReturn", value.baselineNetReturn],
      ["challengerNetReturn", value.challengerNetReturn],
      ["baselineMaxDrawdown", value.baselineMaxDrawdown],
      ["challengerMaxDrawdown", value.challengerMaxDrawdown],
    ];
    for (const [field, observed] of required) {
      if (proven !== (observed !== null))
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: proven
            ? "A proven session requires both sides' return and drawdown"
            : "An unavailable valuation reports no derived return or drawdown",
        });
    }
  });
export type FundedComparisonPairedSession = z.infer<
  typeof fundedComparisonPairedSessionSchema
>;

export const fundedComparisonResultSchema = z
  .object({
    resultVersion: z.literal(FUNDED_COMPARISON_RESULT_VERSION),
    comparisonSpecDigest: contentDigest,
    ...marketCurrency,
    sessionCount: safeCount.positive(),
    historicalVolumeStatus: fundedComparisonVolumeStatusSchema,
    pairedSessions: z.array(fundedComparisonPairedSessionSchema).min(1),
    champion: fundedComparisonSideMetricsSchema,
    challenger: fundedComparisonSideMetricsSchema,
    deltas: fundedComparisonDeltaMetricsSchema,
    challengerOutperformedSessions: z
      .object({
        count: safeCount,
        proportion: z.number().finite().min(0).max(1),
      })
      .strict(),
    championEvaluationDigest: contentDigest,
    challengerEvaluationDigest: contentDigest,
    championMetricsDigest: contentDigest,
    challengerMetricsDigest: contentDigest,
    resultDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
    within(value, ctx, ["sessionCount"], value.pairedSessions.length);
    if (
      value.deltas.challengerOutperformedSessions !==
      value.challengerOutperformedSessions.count
    )
      ctx.addIssue({
        code: "custom",
        path: ["challengerOutperformedSessions", "count"],
        message:
          "Outperformed-session count does not match the challenger-minus-champion delta",
      });
    if (value.challenger.return.sessions.length !== value.pairedSessions.length)
      ctx.addIssue({
        code: "custom",
        path: ["champion", "return", "sessions"],
        message: "Per-session returns must cover the complete paired vector",
      });
    if (
      value.challenger.return.sessions.length !==
      value.champion.return.sessions.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["challenger", "return", "sessions"],
        message: "Both sides report the same session membership",
      });
    const pairedDates = value.pairedSessions.map((row) => row.sessionDate);
    if (
      !sameOrderedDates(
        pairedDates,
        value.champion.return.sessions.map((row) => row.sessionDate),
      ) ||
      !sameOrderedDates(
        pairedDates,
        value.challenger.return.sessions.map((row) => row.sessionDate),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["pairedSessions"],
        message:
          "The paired vector must cover exactly both sides' ordered session returns",
      });
    const expected =
      value.sessionCount >= FUNDED_COMPARISON_MINIMUM_SESSIONS
        ? "SUFFICIENT_FOR_LATER_G2"
        : "INSUFFICIENT_SESSIONS";
    if (value.historicalVolumeStatus !== expected)
      ctx.addIssue({
        code: "custom",
        path: ["historicalVolumeStatus"],
        message: `A ${value.sessionCount}-session comparison is ${expected}`,
      });
    if (
      !datesAscendingUnique(value.pairedSessions.map((row) => row.sessionDate))
    )
      ctx.addIssue({
        code: "custom",
        path: ["pairedSessions"],
        message: "The paired session vector is ordered by session date",
      });
  });
export type FundedComparisonResult = z.infer<
  typeof fundedComparisonResultSchema
>;

function within(
  value: { sessionCount: number },
  ctx: z.RefinementCtx,
  path: (string | number)[],
  observed: number,
): void {
  if (value.sessionCount !== observed)
    ctx.addIssue({
      code: "custom",
      path,
      message: "Session count does not match the retained paired membership",
    });
}

function sameOrderedDates(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Lossless projection of the retained paired vector into the later,
 * separately approved G3 evaluation's `SessionPair[]` shape. FP03 itself never
 * computes a confidence bound, reads `M_market` or claims a gate pass.
 */
export function toSessionPairVector(
  result: Pick<FundedComparisonResult, "pairedSessions">,
): z.infer<typeof sessionPairSchema>[] {
  return result.pairedSessions.map((session) =>
    sessionPairSchema.parse({
      sessionDate: session.sessionDate,
      baseline: session.baselineNetReturn,
      challenger: session.challengerNetReturn,
      coverage: session.coverage,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Job payload
 * ------------------------------------------------------------------ */

export const fundedComparisonJobPayloadSchema = z
  .object({
    specificationId: z.string().min(1),
    comparisonSpecDigest: contentDigest,
    ...marketCurrency,
    maxSessions: safeCount.positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceMarketCurrency(value, ctx);
  });
export type FundedComparisonJobPayload = z.infer<
  typeof fundedComparisonJobPayloadSchema
>;

/**
 * The FP02 model identity consumed by comparison prediction. It is the exact
 * frozen FP02 identity plus the comparison-owned dataset/cohort bindings.
 */
export type FundedComparisonModelBinding = FundedExecutionModelIdentity;
