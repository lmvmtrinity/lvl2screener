import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import { setupStrategyNameSchema } from "./strategies.js";
import { researchEvidenceBindingSchema } from "./research-evidence.js";

export const paperTrainingEvidenceCohortSchema = z.object({
  // Old CA-only evidence remains readable, but every newly materialized
  // cohort is populated explicitly by the training repository.
  marketId: marketIdSchema.default("CA_TSX"),
  strategy: setupStrategyNameSchema,
  strategyVersion: z.string().min(1),
  profileConfigId: z.string().uuid(),
  configVersion: z.string().min(1),
  executionModelVersion: z.string().min(1),
  assumptions: z.record(z.string(), z.unknown()),
  closedQuoteCount: z.number().int().nonnegative(),
  positives: z.number().int().nonnegative(),
  negatives: z.number().int().nonnegative(),
  firstSignalAt: z.string().datetime().nullable(),
  lastSignalAt: z.string().datetime().nullable(),
  missingFeatureCount: z.number().int().nonnegative(),
  /** Explicit signal-construction provenance; UNKNOWN never qualifies for research. */
  signalSemanticsVersion: z.string().min(1).optional(),
  /** FORWARD_LIVE or an explicit replay/regeneration scope. */
  replayScope: z.string().min(1).optional(),
});
export type PaperEvidenceCohort = z.infer<
  typeof paperTrainingEvidenceCohortSchema
>;

export const paperEvidenceTrainingRowSchema = z.object({
  marketId: marketIdSchema.default("CA_TSX"),
  sourceKey: z.string().min(1),
  executionId: z.string().uuid(),
  observationId: z.string().uuid(),
  /** Required for overlap purging; optional only to keep legacy snapshots readable. */
  instrumentId: z.string().uuid().optional(),
  signalTimestamp: z.string().datetime(),
  /** The first timestamp at which the outcome label was observable. */
  labelAvailableAt: z.string().datetime().optional(),
  deterministicScore: z.number().int().min(0).max(100),
  atrPct: z.number().nonnegative().nullable(),
  rvolAtTime: z.number().nonnegative().nullable(),
  rMultiple: z.number(),
});
export type PaperEvidenceTrainingRow = z.infer<
  typeof paperEvidenceTrainingRowSchema
>;

export const paperEvidenceWalkForwardWindowSchema = z.object({
  index: z.number().int().positive(),
  trainStart: z.string().date(),
  trainEnd: z.string().date(),
  testStart: z.string().date(),
  testEnd: z.string().date(),
  trainRows: z.number().int().nonnegative(),
  testRows: z.number().int().nonnegative(),
  testExpectancy: z.number(),
  testWinRate: z.number().min(0).max(1),
});
export type PaperEvidenceWalkForwardWindow = z.infer<
  typeof paperEvidenceWalkForwardWindowSchema
>;

export const paperEvidenceResearchQualificationSchema = z.object({
  policyVersion: z.string().min(1),
  qualified: z.boolean(),
  reasons: z.array(z.string()),
  sourceRowCount: z.number().int().nonnegative(),
  acceptedRowCount: z.number().int().nonnegative(),
  distinctSessionCount: z.number().int().nonnegative(),
  chronologicalSplitAt: z.string().datetime().nullable(),
  walkForwardWindows: z.array(paperEvidenceWalkForwardWindowSchema),
  excludedCounts: z.record(z.string(), z.number().int().nonnegative()),
  /** Frozen membership used by the actual model holdout.  Optional for legacy v1 snapshots. */
  chronologicalTrainSourceKeys: z.array(z.string().min(1)).optional(),
  chronologicalTestSourceKeys: z.array(z.string().min(1)).optional(),
});
export type PaperEvidenceResearchQualification = z.infer<
  typeof paperEvidenceResearchQualificationSchema
>;

/**
 * First-class, immutable derivation record for a materialized dataset. It
 * declares which runtime/feature version and which exact row membership
 * produced the frozen dataset, plus the verified source-coverage identities
 * when they exist. A record only binds when `complete` is true; missing
 * provider or feature-derivation evidence stays truthfully unproven.
 */
export const datasetResearchDerivationSchema = z.object({
  version: z.literal("dataset-derivation-v1"),
  complete: z.boolean(),
  featureVersion: z.string().min(1).nullable(),
  engineRevision: z.string().min(1).nullable(),
  runtimeFingerprint: z.string().min(1).nullable(),
  sourceDigest: z.string().min(1).nullable(),
  rowsDigest: z.string().min(1).nullable(),
  rowCount: z.number().int().nonnegative(),
  sessionPayloadHashes: z.record(z.string(), z.string()).nullable(),
  coverageManifestHash: z.string().min(1).nullable(),
  coverageReportHash: z.string().min(1).nullable(),
  reasons: z.array(z.string()),
  capturedAt: z.string().datetime(),
});
export type DatasetResearchDerivation = z.infer<
  typeof datasetResearchDerivationSchema
>;

export const statisticalTrainingDatasetSchema = z.object({
  id: z.string().uuid(),
  sourceKind: z.literal("PAPER_EVIDENCE"),
  marketId: marketIdSchema.default("CA_TSX"),
  policyVersion: z.string().min(1),
  cohort: paperTrainingEvidenceCohortSchema,
  requestedCutoff: z.string().datetime(),
  effectiveCutoff: z.string().datetime(),
  sourceDigest: z.string().min(1),
  sourceRowCount: z.number().int().nonnegative(),
  excludedCounts: z.record(z.string(), z.number().int().nonnegative()),
  /** Immutable research gate computed when this dataset was materialized. */
  researchQualification: paperEvidenceResearchQualificationSchema.optional(),
  createdAt: z.string().datetime(),
  researchEvidence: researchEvidenceBindingSchema.nullable().optional(),
  /** Immutable manifest-defined derivation; absent on legacy datasets. */
  researchDerivation: datasetResearchDerivationSchema.nullable().optional(),
});
export type StatisticalTrainingDataset = z.infer<
  typeof statisticalTrainingDatasetSchema
>;

export const paperEvidenceCohortListSchema = z.object({
  cohorts: z.array(paperTrainingEvidenceCohortSchema),
});

export const paperModelForwardMonitoringSchema = z.object({
  modelId: z.string().uuid(),
  modelVersion: z.string(),
  strategy: setupStrategyNameSchema,
  predictions: z.number().int().nonnegative(),
  closedOutcomes: z.number().int().nonnegative(),
  positives: z.number().int().nonnegative(),
  observedWinRate: z.number().min(0).max(1).nullable(),
  averagePredictedProbability: z.number().min(0).max(1).nullable(),
  brierScore: z.number().nonnegative().nullable(),
  firstPredictionAt: z.string().datetime().nullable(),
  lastPredictionAt: z.string().datetime().nullable(),
});
export type PaperModelForwardMonitoring = z.infer<
  typeof paperModelForwardMonitoringSchema
>;
export const paperModelForwardMonitoringListSchema = z.object({
  monitoring: z.array(paperModelForwardMonitoringSchema),
});

export const learningAutomationRunStateSchema = z.enum([
  "SUCCESS",
  "NOOP",
  "FAILED",
]);
export type LearningAutomationRunState = z.infer<
  typeof learningAutomationRunStateSchema
>;

export const learningAutomationRunSchema = z.object({
  id: z.string().uuid(),
  schedulerVersion: z.string(),
  policyVersion: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  state: learningAutomationRunStateSchema,
  cohortsExamined: z.array(z.record(z.string(), z.unknown())),
  noopReason: z.string().nullable(),
  createdDatasetId: z.string().uuid().nullable(),
  createdJobId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type LearningAutomationRun = z.infer<typeof learningAutomationRunSchema>;

export const learningAutomationRunListSchema = z.object({
  runs: z.array(learningAutomationRunSchema),
});

export const learningDashboardOverviewSchema = z.object({
  pipelineHealth: z.object({
    schedulerEnabled: z.boolean(),
    scheduleDescription: z.string().optional(),
    schedulerPolicyVersion: z.string(),
    lastCheckAt: z.string().datetime().nullable(),
    /** The next configured check time, derived from the same schedule function
     * the worker uses. Null when scheduling is disabled or no prior check
     * exists to anchor an interval schedule. */
    nextCheckAt: z.string().datetime().nullable().optional(),
    /** True because the worker's own timer is not persisted; the value is the
     * configured schedule, not a worker-recorded next action. */
    nextCheckIsEstimate: z.boolean().optional(),
    /** True when the previous check is past its configured cadence plus grace,
     * i.e. the worker may not be running. */
    checkOverdue: z.boolean().optional(),
    lastState: z.string().nullable(),
    lastNoopReason: z.string().nullable(),
    activeJobs: z.number().int().nonnegative(),
    durableErrors: z.number().int().nonnegative(),
    explanation: z.string(),
  }),
  evidenceReadiness: z.array(
    z.object({
      cohort: paperTrainingEvidenceCohortSchema,
      closedQuoteCount: z.number().int().nonnegative(),
      threshold: z.number().int().nonnegative(),
      progressPct: z.number().min(0).max(100),
      newOutcomesSinceLastDataset: z.number().int().nonnegative(),
      newOutcomeThreshold: z.number().int().nonnegative(),
      qualifies: z.boolean(),
      disqualificationReason: z.string().nullable(),
    }),
  ),
  lifecycle: z.object({
    datasetsCount: z.number().int().nonnegative(),
    modelsCount: z.number().int().nonnegative(),
    activeModelsCount: z.number().int().nonnegative(),
  }),
  forwardMonitoring: z.array(paperModelForwardMonitoringSchema),
  shadowExperiments: z.object({
    policyVersion: z.literal("paper-coordination-v4-shadow"),
    comparatorPolicyVersion: z.string(),
    decisionsEvaluated: z.number().int().nonnegative(),
    selectionChangesCount: z.number().int().nonnegative(),
    selectionChangeRate: z.number().min(0).max(1),
    differenceReasons: z.record(z.string(), z.number().int().nonnegative()),
    hypotheticalNetPnl: z.number(),
    primaryNetPnl: z.number(),
    hypotheticalCumulativeR: z.number(),
    primaryCumulativeR: z.number(),
  }),
});
export type LearningDashboardOverview = z.infer<
  typeof learningDashboardOverviewSchema
>;
