import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import {
  FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION,
  fundedCohortIdentitySchema,
  fundedOutcomeStatusSchema,
  fundedSourceKindSchema,
} from "./funded-learning-evidence.js";

/**
 * Shared contracts for funded-execution learning (FP02).
 *
 * This domain is deliberately separate from the signal-quality contracts in
 * `paper-evidence-training.ts` and from the Python-independent statistical
 * model contracts in `statistical-models.ts`. A funded-execution artifact
 * predicts execution quality only (fill probability, fill fraction, per-share
 * slippage and total entry execution cost). It contains no action, veto-bypass,
 * sizing, ranking, profile or authority field, and every schema is strict so an
 * unknown field fails validation.
 */

const isoDateTime = z.string().datetime({ offset: true });
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const nonnegative = finite.min(0);
const safeCount = z.number().int().safe().nonnegative();

export const FUNDED_EXECUTION_LABEL_MAPPING_VERSION =
  "funded-execution-labels-v1" as const;
export const FUNDED_EXECUTION_FEATURE_VERSION =
  "funded-execution-features-v1" as const;
export const FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION =
  "funded-execution-qualification-v1" as const;
export const FUNDED_EXECUTION_DATASET_POLICY_VERSION =
  "funded-execution-dataset-v1" as const;
export const FUNDED_EXECUTION_TRAINING_POLICY_VERSION =
  "funded-execution-training-v1" as const;
export const FUNDED_EXECUTION_ARTIFACT_VERSION = "funded-execution-v1" as const;
export const FUNDED_EXECUTION_MODEL_TYPE = "FUNDED_EXECUTION_QUALITY" as const;
export const FUNDED_EXECUTION_PREDICTION_VERSION =
  "funded-execution-prediction-v1" as const;

/** Immutable feature order. The Python trainer validates it and never reorders. */
export const FUNDED_EXECUTION_FEATURE_NAMES = [
  "deterministicScore",
  "spreadPct",
  "logDisplayedSize",
  "logRequestedNotional",
  "logRequestedRisk",
  "quoteAgeSeconds",
  "minutesFromOpen",
  "atrPct",
  "stopDistancePct",
  "targetDistancePct",
  "logCash",
  "logOpenRisk",
  "logReservedRisk",
  "positionCount",
  "participation",
  "contextStrength",
] as const;
export type FundedExecutionFeatureName =
  (typeof FUNDED_EXECUTION_FEATURE_NAMES)[number];

/** Immutable output order and units. */
export const FUNDED_EXECUTION_OUTPUT_NAMES = [
  "fillProbability",
  "expectedFillFraction",
  "expectedSlippagePerShare",
  "expectedTotalExecutionCost",
] as const;
export type FundedExecutionOutputName =
  (typeof FUNDED_EXECUTION_OUTPUT_NAMES)[number];

/**
 * A decision-only feature vector. Every value is nullable: an absent value is
 * imputed from training medians recorded in the artifact, never defaulted here.
 * Outcome fields, fills, costs, later quotes and portfolio state captured after
 * the decision do not exist in this schema.
 */
export const fundedExecutionFeatureVectorSchema = z
  .object({
    deterministicScore: nonnegative.max(100).nullable(),
    spreadPct: nonnegative.nullable(),
    logDisplayedSize: nonnegative.nullable(),
    logRequestedNotional: nonnegative.nullable(),
    logRequestedRisk: nonnegative.nullable(),
    quoteAgeSeconds: nonnegative.nullable(),
    minutesFromOpen: finite.nullable(),
    atrPct: nonnegative.nullable(),
    stopDistancePct: nonnegative.nullable(),
    targetDistancePct: nonnegative.nullable(),
    logCash: nonnegative.nullable(),
    logOpenRisk: nonnegative.nullable(),
    logReservedRisk: nonnegative.nullable(),
    positionCount: nonnegative.nullable(),
    participation: finite.nullable(),
    contextStrength: nonnegative.max(3).nullable(),
  })
  .strict();
export type FundedExecutionFeatureVector = z.infer<
  typeof fundedExecutionFeatureVectorSchema
>;

export const fundedExecutionVerdictSchema = z.enum(["INCLUDED", "EXCLUDED"]);
export type FundedExecutionVerdict = z.infer<
  typeof fundedExecutionVerdictSchema
>;

/**
 * Explicit, machine-readable exclusions. A risk veto or policy refusal is not
 * an execution failure; missing market evidence and unknown labels never become
 * losses, zero fills or zero costs.
 */
export const fundedExecutionExclusionReasonSchema = z.enum([
  "POLICY_DECLINED",
  "POLICY_DEFERRED",
  "RISK_VETOED",
  "UNRESOLVED",
  "DECISION_ACCEPTED_NOT_EXECUTED",
  "NO_EXECUTABLE_QUOTE_MISSING_MARKET",
  "INTERMEDIATE_PARTIAL_FILL",
  "COST_EVIDENCE_MISSING",
  "EVIDENCE_SCHEMA_VERSION_UNSUPPORTED",
  "LABEL_NOT_AVAILABLE_AT_CUTOFF",
  "REPLAY_CHRONOLOGY_UNPROVEN",
  "OVERLAPPING_EXPOSURE",
  "LABEL_AFTER_CHRONOLOGICAL_BOUNDARY",
  "SOURCE_RUN_NOT_ELIGIBLE",
  "MARKET_MISMATCH",
  "DUPLICATE_DECISION_IDENTITY",
  "INVALID_FEATURE_VALUE",
  "INSUFFICIENT_PARTITION_CLASS_COVERAGE",
]);
export type FundedExecutionExclusionReason = z.infer<
  typeof fundedExecutionExclusionReasonSchema
>;

export const fundedExecutionPartitionSchema = z.enum(["TRAIN", "TEST"]);
export type FundedExecutionPartition = z.infer<
  typeof fundedExecutionPartitionSchema
>;

/** Identity of one frozen row, bound to its funded decision evidence. */
export const fundedExecutionRowIdentitySchema = z
  .object({
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    accountId: z.string().min(1),
    runId: z.string().min(1),
    observationId: z.string().min(1),
    decisionSequence: safeCount.positive(),
    decisionContentDigest: contentDigest,
    cohortDigest: contentDigest,
    evidenceSchemaVersion: z.literal(FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION),
    outcomeSequences: z.array(safeCount.positive()),
    outcomeSourceDigests: z.array(contentDigest),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.marketId === "CA_TSX" && value.currency !== "CAD") ||
      (value.marketId === "US_EQUITIES" && value.currency !== "USD")
    )
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency does not match the funded market",
      });
    if (value.outcomeSequences.length !== value.outcomeSourceDigests.length)
      ctx.addIssue({
        code: "custom",
        path: ["outcomeSourceDigests"],
        message: "Outcome identity and digests must correspond one to one",
      });
  });
export type FundedExecutionRowIdentity = z.infer<
  typeof fundedExecutionRowIdentitySchema
>;

/**
 * The immutable entry-order revision that proved whether further entry
 * execution was possible at the dataset cutoff. `revision` is the durable order
 * revision, `stateDigest` the canonical digest of its exact persisted state,
 * `factAt` the revision's fact time and `recordedAt` the database clock at
 * which the revision was recorded. A revision is usable only when both its fact
 * time and its recorded time are at or before the cutoff, so a later close,
 * recovery or reconciliation cannot change an earlier cutoff's label or row
 * identity. Missing or unprovable terminality stays
 * `INTERMEDIATE_PARTIAL_FILL`.
 */
export const fundedExecutionTerminalityProofSchema = z
  .object({
    orderId: z.string().min(1),
    revision: safeCount,
    stateDigest: contentDigest,
    factAt: isoDateTime,
    recordedAt: isoDateTime,
  })
  .strict();
export type FundedExecutionTerminalityProof = z.infer<
  typeof fundedExecutionTerminalityProofSchema
>;

/**
 * The knowledge coordinate that ordered a label on its own chronology. Live
 * capture uses the true database knowledge time (`DATABASE_CAPTURE`). A
 * historical replay cannot use wall-clock capture time for chronology: it binds
 * the `applied_sequence` of the last proven funded fact applied at or before the
 * label's simulated evidence time, so only evidence that had become available
 * at that replay point can influence a replay dataset. The run identity and the
 * provenance are part of the label and therefore of the row, membership and
 * dataset identity; a replay coordinate whose run does not own the row, whose
 * applied-fact sequence is missing, or whose sequence is not monotone with its
 * fact time is unprovable and the row fails closed.
 */
export const fundedExecutionKnowledgeCoordinateSchema = z
  .object({
    provenance: z.enum(["DATABASE_CAPTURE", "HISTORICAL_REPLAY_FACT_SEQUENCE"]),
    /** Replay run owning the applied-fact sequence; null for live capture. */
    runId: z.string().min(1).nullable(),
    /** Proven applied-fact sequence at the label's knowledge point. */
    sequence: safeCount.nullable(),
    /** Chronology point: database knowledge time (live) or replay time. */
    at: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provenance === "DATABASE_CAPTURE") {
      if (value.runId !== null || value.sequence !== null)
        ctx.addIssue({
          code: "custom",
          path: ["provenance"],
          message:
            "Database capture knowledge carries no replay run or sequence",
        });
      return;
    }
    if (value.runId === null || value.sequence === null)
      ctx.addIssue({
        code: "custom",
        path: ["provenance"],
        message:
          "A replay fact-sequence coordinate requires its run and sequence",
      });
  });
export type FundedExecutionKnowledgeCoordinate = z.infer<
  typeof fundedExecutionKnowledgeCoordinateSchema
>;

/**
 * Bind the label's source kind to its knowledge provenance. A live label is
 * database capture at its own audit knowledge time and carries no replay
 * identity; a historical-replay label binds its own run and a proven applied
 * fact sequence. Every mismatched combination is rejected at the member,
 * request and persisted-member boundary.
 */
function enforceKnowledgeSourceBinding(
  value: {
    readonly sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
    readonly runId: string;
    readonly labelAvailableAt: string;
    readonly knowledge: FundedExecutionKnowledgeCoordinate;
  },
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (value.sourceKind === "LIVE_PAPER") {
    if (
      value.knowledge.provenance !== "DATABASE_CAPTURE" ||
      value.knowledge.runId !== null ||
      value.knowledge.sequence !== null ||
      value.knowledge.at !== value.labelAvailableAt
    )
      ctx.addIssue({
        code: "custom",
        path: [...path, "knowledge"],
        message:
          "LIVE_PAPER labels use database capture at the audit knowledge time",
      });
    return;
  }
  if (
    value.knowledge.provenance !== "HISTORICAL_REPLAY_FACT_SEQUENCE" ||
    value.knowledge.runId !== value.runId ||
    value.knowledge.sequence === null
  )
    ctx.addIssue({
      code: "custom",
      path: [...path, "knowledge"],
      message:
        "HISTORICAL_REPLAY labels bind their own run and applied-fact sequence",
    });
}

/**
 * Point-in-time labels. Fill labels may be proven without cost evidence; cost
 * labels require retained fill evidence and stay null otherwise. `fill=0` is
 * only produced from a proven terminal zero-fill outcome.
 *
 * `economicOutcomeAt` preserves the original economic time of the terminal
 * execution event, while `labelAvailableAt` is the audit knowledge time: the
 * latest time at which every piece of evidence needed to finalize the label
 * (the terminal outcome version and, when the disposition depends on entry
 * terminality, the immutable order-revision proof) had actually been recorded.
 * `knowledge` is the chronology coordinate: for live capture it equals the
 * audit knowledge time, while a historical replay binds its proven applied-fact
 * sequence so a wall-clock capture time can never leak backward into an earlier
 * replay point. Effective cutoffs, watermarks and digests use the audit
 * knowledge time; partition chronology uses the coordinate. `terminalityProof`
 * is bound into the label so the row identity changes only while the same proof
 * was provable at the cutoff.
 */
export const fundedExecutionLabelsSchema = z
  .object({
    fillProbability: z.union([z.literal(0), z.literal(1)]).nullable(),
    fillFraction: finite.min(0).max(1).nullable(),
    slippagePerShare: nonnegative.nullable(),
    totalExecutionCost: nonnegative.nullable(),
    /** Audit knowledge time at which all evidence needed for the label existed. */
    labelAvailableAt: isoDateTime,
    /** Chronology coordinate that ordered this label (live or replay). */
    knowledge: fundedExecutionKnowledgeCoordinateSchema,
    /** Economic time of the terminal execution event itself. */
    economicOutcomeAt: isoDateTime,
    /**
     * The order revision whose terminal state finalized a partial fill, zero
     * fill or closed entry. Null when the label did not depend on an order-state
     * proof or no provable revision existed at the cutoff.
     */
    terminalityProof: fundedExecutionTerminalityProofSchema.nullable(),
    terminalOutcomeStatus: fundedOutcomeStatusSchema,
    terminalOutcomeSequence: safeCount.positive(),
    terminalOutcomeSourceDigest: contentDigest,
    fillLabelAvailable: z.boolean(),
    costLabelAvailable: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.fillLabelAvailable !== (value.fillProbability !== null))
      ctx.addIssue({
        code: "custom",
        path: ["fillLabelAvailable"],
        message: "Fill label availability must match the fill label",
      });
    if (value.fillProbability !== null && value.fillFraction === null)
      ctx.addIssue({
        code: "custom",
        path: ["fillFraction"],
        message: "A proven fill label requires a fill fraction",
      });
    if (value.fillProbability === 0 && value.fillFraction !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["fillFraction"],
        message: "A terminal zero fill must carry fill fraction 0",
      });
    if (value.fillProbability === 1 && value.fillFraction === 0)
      ctx.addIssue({
        code: "custom",
        path: ["fillFraction"],
        message: "A filled outcome cannot carry fill fraction 0",
      });
    if (
      value.terminalOutcomeStatus === "PARTIAL_FILL" &&
      value.terminalityProof === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["terminalityProof"],
        message:
          "A final partial fill requires the immutable order revision that established terminality",
      });
    if (
      value.knowledge.provenance === "DATABASE_CAPTURE" &&
      value.knowledge.at !== value.labelAvailableAt
    )
      ctx.addIssue({
        code: "custom",
        path: ["knowledge", "at"],
        message:
          "Database capture knowledge must equal the audit knowledge time",
      });
    if (value.costLabelAvailable) {
      if (value.slippagePerShare === null || value.totalExecutionCost === null)
        ctx.addIssue({
          code: "custom",
          path: ["costLabelAvailable"],
          message: "Cost availability requires both cost labels",
        });
      if (value.fillProbability !== 1)
        ctx.addIssue({
          code: "custom",
          path: ["costLabelAvailable"],
          message: "Cost labels require a proven fill",
        });
    } else if (
      value.slippagePerShare !== null ||
      value.totalExecutionCost !== null
    )
      ctx.addIssue({
        code: "custom",
        path: ["costLabelAvailable"],
        message: "Unavailable cost labels must stay null",
      });
  });
export type FundedExecutionLabels = z.infer<typeof fundedExecutionLabelsSchema>;

/** One ordered dataset member: an included, labeled row at a frozen cutoff. */
export const fundedExecutionDatasetMemberSchema = z
  .object({
    ordinal: safeCount,
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    identity: fundedExecutionRowIdentitySchema,
    instrumentId: z.string().uuid().nullable(),
    decisionAt: isoDateTime,
    sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    partition: fundedExecutionPartitionSchema,
    features: fundedExecutionFeatureVectorSchema,
    labels: fundedExecutionLabelsSchema,
    sourceKind: fundedSourceKindSchema,
    labelMappingVersion: z.literal(FUNDED_EXECUTION_LABEL_MAPPING_VERSION),
    featureVersion: z.literal(FUNDED_EXECUTION_FEATURE_VERSION),
    rowDigest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    enforceKnowledgeSourceBinding(
      {
        sourceKind: value.sourceKind,
        runId: value.identity.runId,
        labelAvailableAt: value.labels.labelAvailableAt,
        knowledge: value.labels.knowledge,
      },
      ctx,
      ["labels"],
    );
  });
export type FundedExecutionDatasetMember = z.infer<
  typeof fundedExecutionDatasetMemberSchema
>;

export const fundedExecutionDatasetCountsSchema = z
  .object({
    sourceRowCount: safeCount,
    usableRowCount: safeCount,
    includedRowCount: safeCount,
    trainRowCount: safeCount,
    testRowCount: safeCount,
    excludedCounts: z.record(z.string(), safeCount),
    unknownCounts: z.record(z.string(), safeCount),
  })
  .strict();
export type FundedExecutionDatasetCounts = z.infer<
  typeof fundedExecutionDatasetCountsSchema
>;

/**
 * Qualification receipt. It records the frozen floors, the observed counts and
 * every reason a NOOP was returned so a verdict can be audited without
 * rerunning qualification. Gates are never weakened to obtain a dataset.
 */
export const fundedExecutionQualificationReceiptSchema = z
  .object({
    policyVersion: z.literal(FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION),
    qualified: z.boolean(),
    reasons: z.array(z.string().min(1)),
    minimumRows: safeCount,
    minimumNewRows: safeCount,
    /**
     * Qualified decision identities in this materialization that are absent
     * from the prior dataset's frozen member identities. Corrections or changed
     * row content for an existing decision are not new outcomes, and removed
     * prior members never subtract from the count.
     */
    newOutcomesSincePrior: safeCount,
    priorDatasetId: z.string().uuid().nullable(),
    priorDatasetRowCount: safeCount.nullable(),
    liveRunRequired: z.boolean(),
    distinctSessionCount: safeCount,
    chronologicalSplitAt: isoDateTime.nullable(),
    trainFillPositives: safeCount,
    trainFillNegatives: safeCount,
    testFillPositives: safeCount,
    testFillNegatives: safeCount,
    trainCostLabelCount: safeCount,
    testCostLabelCount: safeCount,
    counts: fundedExecutionDatasetCountsSchema,
  })
  .strict();
export type FundedExecutionQualificationReceipt = z.infer<
  typeof fundedExecutionQualificationReceiptSchema
>;

export const fundedExecutionSourceWatermarkSchema = z
  .object({
    latestDecisionAt: isoDateTime.nullable(),
    /** Latest label knowledge time captured in the dataset. */
    latestLabelAvailableAt: isoDateTime.nullable(),
    /** Latest economic terminal-outcome time captured in the dataset. */
    latestEconomicOutcomeAt: isoDateTime.nullable(),
    decisionCount: safeCount,
    outcomeVersionCount: safeCount,
  })
  .strict();
export type FundedExecutionSourceWatermark = z.infer<
  typeof fundedExecutionSourceWatermarkSchema
>;

/**
 * Immutable funded-execution dataset manifest. `datasetDigest` is the canonical
 * digest of the complete frozen materialization; the same cutoff and evidence
 * reproduce the same ordered membership and digest.
 */
export const fundedExecutionDatasetManifestSchema = z
  .object({
    id: z.string().uuid(),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    cohort: fundedCohortIdentitySchema,
    sourceKind: fundedSourceKindSchema,
    requestedCutoff: isoDateTime,
    effectiveCutoff: isoDateTime,
    datasetPolicyVersion: z.literal(FUNDED_EXECUTION_DATASET_POLICY_VERSION),
    labelMappingVersion: z.literal(FUNDED_EXECUTION_LABEL_MAPPING_VERSION),
    featureVersion: z.literal(FUNDED_EXECUTION_FEATURE_VERSION),
    qualificationPolicyVersion: z.literal(
      FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
    ),
    membershipDigest: contentDigest,
    datasetDigest: contentDigest,
    qualificationReceipt: fundedExecutionQualificationReceiptSchema,
    sourceWatermark: fundedExecutionSourceWatermarkSchema,
    activationEligible: z.boolean(),
    createdAt: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.marketId === "CA_TSX" && value.currency !== "CAD") ||
      (value.marketId === "US_EQUITIES" && value.currency !== "USD")
    )
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency does not match the funded market",
      });
  });
export type FundedExecutionDatasetManifest = z.infer<
  typeof fundedExecutionDatasetManifestSchema
>;

export const fundedExecutionCalibrationBinSchema = z
  .object({
    lower: finite.min(0).max(1),
    upper: finite.min(0).max(1),
    samples: safeCount.positive(),
    predictedRate: finite.min(0).max(1),
    observedRate: finite.min(0).max(1),
  })
  .strict();

export const fundedExecutionLogisticMetricsSchema = z
  .object({
    kind: z.literal("LOGISTIC"),
    samples: safeCount,
    positives: safeCount,
    negatives: safeCount,
    baseRate: finite.min(0).max(1),
    brierScore: nonnegative,
    baselineBrierScore: nonnegative,
    logLoss: nonnegative,
    rocAuc: finite.min(0).max(1).nullable(),
    calibration: z.array(fundedExecutionCalibrationBinSchema),
  })
  .strict();

export const fundedExecutionLinearMetricsSchema = z
  .object({
    kind: z.literal("LINEAR"),
    samples: safeCount,
    meanPredicted: finite,
    meanActual: finite,
    meanAbsoluteError: nonnegative,
    rootMeanSquaredError: nonnegative,
  })
  .strict();

export const fundedExecutionModelMetricsSchema = z.discriminatedUnion("kind", [
  fundedExecutionLogisticMetricsSchema,
  fundedExecutionLinearMetricsSchema,
]);
export type FundedExecutionModelMetrics = z.infer<
  typeof fundedExecutionModelMetricsSchema
>;

const boundedOutputSchema = z
  .object({
    output: z.literal("fillProbability"),
    kind: z.literal("LOGISTIC"),
    unit: z.literal("PROBABILITY"),
    lowerBound: z.literal(0),
    upperBound: z.literal(1),
    trainingSamples: safeCount,
    intercept: finite,
    coefficients: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    means: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    scales: z
      .array(finite.positive())
      .length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    medians: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    trainMetrics: fundedExecutionLogisticMetricsSchema,
    testMetrics: fundedExecutionLogisticMetricsSchema,
  })
  .strict();

const fillFractionOutputSchema = z
  .object({
    output: z.literal("expectedFillFraction"),
    kind: z.literal("LINEAR"),
    unit: z.literal("FRACTION"),
    lowerBound: z.literal(0),
    upperBound: z.literal(1),
    trainingSamples: safeCount,
    intercept: finite,
    coefficients: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    means: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    scales: z
      .array(finite.positive())
      .length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    medians: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    trainMetrics: fundedExecutionLinearMetricsSchema,
    testMetrics: fundedExecutionLinearMetricsSchema,
  })
  .strict();

const slippageOutputSchema = z
  .object({
    output: z.literal("expectedSlippagePerShare"),
    kind: z.literal("LINEAR"),
    unit: z.literal("CURRENCY_PER_SHARE"),
    lowerBound: z.literal(0),
    upperBound: z.null(),
    trainingSamples: safeCount,
    intercept: finite,
    coefficients: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    means: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    scales: z
      .array(finite.positive())
      .length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    medians: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    trainMetrics: fundedExecutionLinearMetricsSchema,
    testMetrics: fundedExecutionLinearMetricsSchema,
  })
  .strict();

const totalCostOutputSchema = z
  .object({
    output: z.literal("expectedTotalExecutionCost"),
    kind: z.literal("LINEAR"),
    unit: z.literal("CURRENCY"),
    lowerBound: z.literal(0),
    upperBound: z.null(),
    trainingSamples: safeCount,
    intercept: finite,
    coefficients: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    means: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    scales: z
      .array(finite.positive())
      .length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    medians: z.array(finite).length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    trainMetrics: fundedExecutionLinearMetricsSchema,
    testMetrics: fundedExecutionLinearMetricsSchema,
  })
  .strict();

/**
 * Deterministic model artifact. It contains only feature contract,
 * normalization/imputation values, coefficients and metrics. It intentionally
 * has no timestamp, no randomness and no action, veto-bypass, sizing, ranking or
 * authority field, so identical frozen inputs serialize to identical bytes.
 */
export const fundedExecutionModelArtifactSchema = z
  .object({
    artifactVersion: z.literal(FUNDED_EXECUTION_ARTIFACT_VERSION),
    modelType: z.literal(FUNDED_EXECUTION_MODEL_TYPE),
    featureVersion: z.literal(FUNDED_EXECUTION_FEATURE_VERSION),
    featureNames: z
      .array(z.string().min(1))
      .length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    sourceDatasetDigest: contentDigest,
    trainingPartitionDigest: contentDigest,
    trainingRowCount: safeCount,
    trainingFillRowCount: safeCount,
    trainingCostRowCount: safeCount,
    outputs: z.tuple([
      boundedOutputSchema,
      fillFractionOutputSchema,
      slippageOutputSchema,
      totalCostOutputSchema,
    ]),
    warnings: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.featureNames.forEach((name, index) => {
      if (name !== FUNDED_EXECUTION_FEATURE_NAMES[index])
        ctx.addIssue({
          code: "custom",
          path: ["featureNames", index],
          message: `Feature order is frozen: expected ${FUNDED_EXECUTION_FEATURE_NAMES[index]}`,
        });
    });
    const outputs = value.outputs.map((output) => output.output);
    FUNDED_EXECUTION_OUTPUT_NAMES.forEach((name, index) => {
      if (outputs[index] !== name)
        ctx.addIssue({
          code: "custom",
          path: ["outputs", index, "output"],
          message: `Output order is frozen: expected ${name}`,
        });
    });
  });
export type FundedExecutionModelArtifact = z.infer<
  typeof fundedExecutionModelArtifactSchema
>;

export const fundedExecutionTrainingResultSchema = z
  .object({
    status: z.enum(["COMPLETED", "INSUFFICIENT_DATA"]),
    artifact: fundedExecutionModelArtifactSchema.nullable(),
    artifactDigest: contentDigest.nullable(),
    warnings: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "COMPLETED" && !value.artifact)
      ctx.addIssue({
        code: "custom",
        path: ["artifact"],
        message: "A completed training result requires an artifact",
      });
    if (value.artifact && !value.artifactDigest)
      ctx.addIssue({
        code: "custom",
        path: ["artifactDigest"],
        message: "An artifact requires its canonical digest",
      });
  });
export type FundedExecutionTrainingResult = z.infer<
  typeof fundedExecutionTrainingResultSchema
>;

export const fundedExecutionTrainingRowSchema = z
  .object({
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    runId: z.string().min(1),
    observationId: z.string().min(1),
    decisionSequence: safeCount.positive(),
    decisionContentDigest: contentDigest,
    decisionAt: isoDateTime,
    sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    partition: fundedExecutionPartitionSchema,
    features: fundedExecutionFeatureVectorSchema,
    labels: fundedExecutionLabelsSchema,
    rowDigest: contentDigest,
  })
  .strict();
export type FundedExecutionTrainingRow = z.infer<
  typeof fundedExecutionTrainingRowSchema
>;

export const fundedExecutionTrainingRequestSchema = z
  .object({
    requestVersion: z.literal("funded-execution-training-v1"),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    cohortDigest: contentDigest,
    datasetDigest: contentDigest,
    membershipDigest: contentDigest,
    trainingPartitionDigest: contentDigest,
    featureVersion: z.literal(FUNDED_EXECUTION_FEATURE_VERSION),
    labelMappingVersion: z.literal(FUNDED_EXECUTION_LABEL_MAPPING_VERSION),
    featureNames: z
      .array(z.string().min(1))
      .length(FUNDED_EXECUTION_FEATURE_NAMES.length),
    sourceKind: fundedSourceKindSchema,
    rows: z.array(fundedExecutionTrainingRowSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.marketId === "CA_TSX" && value.currency !== "CAD") ||
      (value.marketId === "US_EQUITIES" && value.currency !== "USD")
    )
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency does not match the funded market",
      });
    value.featureNames.forEach((name, index) => {
      if (name !== FUNDED_EXECUTION_FEATURE_NAMES[index])
        ctx.addIssue({
          code: "custom",
          path: ["featureNames", index],
          message: `Feature order is frozen: expected ${FUNDED_EXECUTION_FEATURE_NAMES[index]}`,
        });
    });
    const seenTrain = new Set<string>();
    const seenTest = new Set<string>();
    for (const [index, row] of value.rows.entries()) {
      if (row.marketId !== value.marketId || row.currency !== value.currency)
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "marketId"],
          message: "A training row cannot cross market or currency ownership",
        });
      enforceKnowledgeSourceBinding(
        {
          sourceKind: value.sourceKind,
          runId: row.runId,
          labelAvailableAt: row.labels.labelAvailableAt,
          knowledge: row.labels.knowledge,
        },
        ctx,
        ["rows", index, "labels"],
      );
      const key = `${row.runId}:${row.observationId}`;
      const seen = row.partition === "TRAIN" ? seenTrain : seenTest;
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["rows", index],
          message: "Training membership contains a duplicate row identity",
        });
      seen.add(key);
    }
    if (seenTrain.size === 0 || seenTest.size === 0)
      ctx.addIssue({
        code: "custom",
        path: ["rows"],
        message: "Training requires frozen train and test membership",
      });
  });
export type FundedExecutionTrainingRequest = z.infer<
  typeof fundedExecutionTrainingRequestSchema
>;

const outputUnitSchema = z.enum([
  "PROBABILITY",
  "FRACTION",
  "CURRENCY_PER_SHARE",
  "CURRENCY",
]);

const diagnosticValueSchema = z
  .object({
    value: finite,
    unit: outputUnitSchema,
    lowerBound: finite,
    upperBound: finite.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lowerBound > value.value)
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Output value is below its declared lower bound",
      });
    if (value.upperBound !== null && value.value > value.upperBound)
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Output value is above its declared upper bound",
      });
  });

export const fundedExecutionPredictionOutputSchema = z
  .object({
    fillProbability: diagnosticValueSchema.superRefine((value, ctx) => {
      if (value.unit !== "PROBABILITY")
        ctx.addIssue({
          code: "custom",
          path: ["unit"],
          message: "fillProbability uses PROBABILITY",
        });
    }),
    expectedFillFraction: diagnosticValueSchema.superRefine((value, ctx) => {
      if (value.unit !== "FRACTION")
        ctx.addIssue({
          code: "custom",
          path: ["unit"],
          message: "expectedFillFraction uses FRACTION",
        });
    }),
    expectedSlippagePerShare: diagnosticValueSchema.superRefine(
      (value, ctx) => {
        if (value.unit !== "CURRENCY_PER_SHARE")
          ctx.addIssue({
            code: "custom",
            path: ["unit"],
            message: "expectedSlippagePerShare uses CURRENCY_PER_SHARE",
          });
      },
    ),
    expectedTotalExecutionCost: diagnosticValueSchema.superRefine(
      (value, ctx) => {
        if (value.unit !== "CURRENCY")
          ctx.addIssue({
            code: "custom",
            path: ["unit"],
            message: "expectedTotalExecutionCost uses CURRENCY",
          });
      },
    ),
  })
  .strict();
export type FundedExecutionPredictionOutput = z.infer<
  typeof fundedExecutionPredictionOutputSchema
>;

export const fundedExecutionModelIdentitySchema = z
  .object({
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
    modelType: z.literal(FUNDED_EXECUTION_MODEL_TYPE),
    artifactDigest: contentDigest,
    cohortDigest: contentDigest,
    featureVersion: z.literal(FUNDED_EXECUTION_FEATURE_VERSION),
  })
  .strict();
export type FundedExecutionModelIdentity = z.infer<
  typeof fundedExecutionModelIdentitySchema
>;

export const fundedExecutionInferenceInputSchema = z
  .object({
    requestVersion: z.literal("funded-execution-inference-v1"),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    model: fundedExecutionModelIdentitySchema,
    artifact: fundedExecutionModelArtifactSchema,
    inputs: z
      .array(
        z
          .object({
            runId: z.string().min(1),
            observationId: z.string().min(1),
            decisionSequence: safeCount.positive(),
            decisionInputDigest: contentDigest,
            features: fundedExecutionFeatureVectorSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.marketId === "CA_TSX" && value.currency !== "CAD") ||
      (value.marketId === "US_EQUITIES" && value.currency !== "USD")
    )
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency does not match the funded market",
      });
    if (value.artifact.featureVersion !== value.model.featureVersion)
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "featureVersion"],
        message: "Artifact feature version does not match the model identity",
      });
  });
export type FundedExecutionInferenceInput = z.infer<
  typeof fundedExecutionInferenceInputSchema
>;

export const fundedExecutionInferenceOutputSchema = z
  .object({
    requestVersion: z.literal("funded-execution-inference-v1"),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    model: fundedExecutionModelIdentitySchema,
    predictions: z.array(
      z
        .object({
          runId: z.string().min(1),
          observationId: z.string().min(1),
          decisionSequence: safeCount.positive(),
          decisionInputDigest: contentDigest,
          output: fundedExecutionPredictionOutputSchema,
          warnings: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    warnings: z.array(z.string().min(1)),
  })
  .strict();
export type FundedExecutionInferenceOutput = z.infer<
  typeof fundedExecutionInferenceOutputSchema
>;

/** An inactive, non-activatable funded-execution challenger. */
export const fundedExecutionChallengerSchema = z
  .object({
    id: z.string().uuid(),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    cohort: fundedCohortIdentitySchema,
    datasetId: z.string().uuid(),
    datasetDigest: contentDigest,
    modelVersion: z.string().min(1),
    modelType: z.literal(FUNDED_EXECUTION_MODEL_TYPE),
    artifactDigest: contentDigest,
    featureVersion: z.literal(FUNDED_EXECUTION_FEATURE_VERSION),
    labelMappingVersion: z.literal(FUNDED_EXECUTION_LABEL_MAPPING_VERSION),
    qualificationPolicyVersion: z.literal(
      FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
    ),
    trainingPolicyVersion: z.literal(FUNDED_EXECUTION_TRAINING_POLICY_VERSION),
    trainingCodeVersion: z.string().min(1),
    runtimeFingerprint: z.string().min(1).nullable(),
    status: z.enum(["INACTIVE", "FAILED"]),
    eligibleForActivation: z.literal(false),
    active: z.literal(false),
    artifact: fundedExecutionModelArtifactSchema.nullable(),
    metrics: z.record(z.string(), z.unknown()).nullable(),
    sampleCounts: z.record(z.string(), safeCount),
    failureReceipt: z.string().min(1).nullable(),
    createdAt: isoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.marketId === "CA_TSX" && value.currency !== "CAD") ||
      (value.marketId === "US_EQUITIES" && value.currency !== "USD")
    )
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency does not match the funded market",
      });
    if (
      value.status === "INACTIVE" &&
      (!value.artifact || value.failureReceipt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "An inactive challenger retains its artifact and no failure receipt",
      });
    if (value.status === "FAILED" && !value.failureReceipt)
      ctx.addIssue({
        code: "custom",
        path: ["failureReceipt"],
        message: "A failed challenger retains its failure receipt",
      });
  });
export type FundedExecutionChallenger = z.infer<
  typeof fundedExecutionChallengerSchema
>;

/**
 * One forward prediction record for later FP04 shadow observation. The record
 * binds the exact model, artifact, observation and decision input digest, and
 * `predictionAt` may never follow the declared deadline. It carries no funded
 * action, reservation, order or authority field.
 */
export const fundedExecutionPredictionRecordSchema = z
  .object({
    predictionVersion: z.literal(FUNDED_EXECUTION_PREDICTION_VERSION),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    model: fundedExecutionModelIdentitySchema,
    runId: z.string().min(1),
    observationId: z.string().min(1),
    decisionSequence: safeCount.positive(),
    decisionInputDigest: contentDigest,
    sourceKind: fundedSourceKindSchema,
    predictionAt: isoDateTime,
    deadlineAt: isoDateTime,
    output: fundedExecutionPredictionOutputSchema,
    warnings: z.array(z.string().min(1)),
    digest: contentDigest,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.marketId === "CA_TSX" && value.currency !== "CAD") ||
      (value.marketId === "US_EQUITIES" && value.currency !== "USD")
    )
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency does not match the funded market",
      });
    if (
      Number.isFinite(Date.parse(value.predictionAt)) &&
      Number.isFinite(Date.parse(value.deadlineAt)) &&
      Date.parse(value.predictionAt) > Date.parse(value.deadlineAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["predictionAt"],
        message: "A prediction cannot be recorded after its deadline",
      });
  });
export type FundedExecutionPredictionRecord = z.infer<
  typeof fundedExecutionPredictionRecordSchema
>;
