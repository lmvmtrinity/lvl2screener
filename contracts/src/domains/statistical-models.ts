import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import { setupStrategyNameSchema } from "./strategies.js";
import { researchEvidenceBindingSchema } from "./research-evidence.js";

export const statisticalModelStatusSchema = z.enum([
  "PENDING",
  "TRAINING",
  "COMPLETED",
  "INSUFFICIENT_DATA",
  "FAILED",
  "INTERRUPTED",
]);
export const statisticalDatasetMetricsSchema = z.object({
  samples: z.number().int().nonnegative(),
  positives: z.number().int().nonnegative(),
  negatives: z.number().int().nonnegative(),
  baseRate: z.number().min(0).max(1),
  brierScore: z.number().nonnegative(),
  baselineBrierScore: z.number().nonnegative(),
  logLoss: z.number().nonnegative(),
  rocAuc: z.number().min(0).max(1).nullable(),
});
export type StatisticalDatasetMetrics = z.infer<
  typeof statisticalDatasetMetricsSchema
>;
export const statisticalCalibrationBinSchema = z.object({
  lower: z.number().min(0).max(1),
  upper: z.number().min(0).max(1),
  samples: z.number().int().positive(),
  predictedRate: z.number().min(0).max(1),
  observedRate: z.number().min(0).max(1),
});
export const statisticalModelArtifactSchema = z.object({
  artifactVersion: z.literal("1.0.0"),
  modelType: z.literal("LOGISTIC_SETUP_QUALITY"),
  featureNames: z.array(z.string()).length(4),
  intercept: z.number(),
  coefficients: z.array(z.number()).length(4),
  means: z.array(z.number()).length(4),
  scales: z.array(z.number().positive()).length(4),
  medians: z.array(z.number()).length(4),
  atrMedian: z.number().nonnegative(),
  rvolMedian: z.number().nonnegative(),
});
export type StatisticalModelArtifact = z.infer<
  typeof statisticalModelArtifactSchema
>;
const statisticalModelTrainingOptionsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  strategy: setupStrategyNameSchema,
  trainPct: z.number().int().min(60).max(90).default(80),
  minimumSamples: z.number().int().min(20).max(100_000).default(200),
  l2Penalty: z.number().nonnegative().max(100).default(0.1),
});
export const createBacktestStatisticalModelSchema =
  statisticalModelTrainingOptionsSchema.extend({
    sourceKind: z.literal("BACKTEST_RUN").optional(),
    backtestRunId: z.string().uuid(),
  });
export const createPaperEvidenceStatisticalModelSchema =
  statisticalModelTrainingOptionsSchema.extend({
    sourceKind: z.literal("PAPER_EVIDENCE"),
    trainingDatasetId: z.string().uuid(),
  });
export const createStatisticalModelSchema = z.union([
  createBacktestStatisticalModelSchema,
  createPaperEvidenceStatisticalModelSchema,
]);
export type CreateStatisticalModel = z.infer<
  typeof createStatisticalModelSchema
>;
export const statisticalModelSchema = z.object({
  id: z.string().uuid(),
  marketId: marketIdSchema.default("CA_TSX"),
  name: z.string(),
  status: statisticalModelStatusSchema,
  modelType: z.literal("LOGISTIC_SETUP_QUALITY"),
  modelVersion: z.string(),
  sourceKind: z.enum(["BACKTEST_RUN", "PAPER_EVIDENCE"]),
  backtestRunId: z.string().uuid().nullable(),
  trainingDatasetId: z.string().uuid().nullable(),
  strategy: setupStrategyNameSchema,
  input: createStatisticalModelSchema,
  artifact: statisticalModelArtifactSchema.nullable(),
  trainMetrics: statisticalDatasetMetricsSchema.nullable(),
  testMetrics: statisticalDatasetMetricsSchema.nullable(),
  calibration: z.array(statisticalCalibrationBinSchema),
  eligibleForActivation: z.boolean(),
  active: z.boolean(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  trainingStart: z.string().datetime().nullable(),
  trainingEnd: z.string().datetime().nullable(),
  testStart: z.string().datetime().nullable(),
  testEnd: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  researchEvidence: researchEvidenceBindingSchema.nullable().optional(),
});
export type StatisticalModel = z.infer<typeof statisticalModelSchema>;
export const statisticalModelListSchema = z.object({
  models: z.array(statisticalModelSchema),
});
export const statisticalTrainingResultSchema = z.object({
  status: z.enum(["COMPLETED", "INSUFFICIENT_DATA"]),
  artifact: statisticalModelArtifactSchema.nullable(),
  train: statisticalDatasetMetricsSchema.nullable(),
  test: statisticalDatasetMetricsSchema.nullable(),
  calibration: z.array(statisticalCalibrationBinSchema),
  eligibleForActivation: z.boolean(),
  warnings: z.array(z.string()),
  trainingStart: z.string().datetime().nullable(),
  trainingEnd: z.string().datetime().nullable(),
  testStart: z.string().datetime().nullable(),
  testEnd: z.string().datetime().nullable(),
});
export type StatisticalTrainingResult = z.infer<
  typeof statisticalTrainingResultSchema
>;
export const statisticalPredictionInputSchema = z.object({
  marketId: marketIdSchema.default("CA_TSX"),
  instrumentId: z.string().uuid(),
  symbol: z.string(),
  timestamp: z.string().datetime(),
  profileId: z.string().uuid(),
  profileName: z.string(),
  strategy: setupStrategyNameSchema,
  deterministicScore: z.number().int().min(0).max(100),
  atrPct: z.number().nonnegative().nullable(),
  rvolAtTime: z.number().nonnegative().nullable(),
});
export type StatisticalPredictionInput = z.infer<
  typeof statisticalPredictionInputSchema
>;
export const statisticalPredictionSchema = z.object({
  marketId: marketIdSchema.default("CA_TSX"),
  instrumentId: z.string().uuid(),
  symbol: z.string(),
  timestamp: z.string().datetime(),
  profileId: z.string().uuid(),
  profileName: z.string(),
  strategy: setupStrategyNameSchema,
  deterministicScore: z.number().int().min(0).max(100),
  setupProbability: z.number().min(0).max(1),
  falseBreakoutProbability: z.number().min(0).max(1),
  rankingScore: z.number().int().min(0).max(100),
  regime: z.object({
    atr: z.enum(["LOW", "HIGH", "UNKNOWN"]),
    rvol: z.enum(["LOW", "HIGH", "UNKNOWN"]),
    combined: z.string(),
  }),
  contributions: z.record(z.string(), z.number()),
  warnings: z.array(z.string()),
});
export type StatisticalPrediction = z.infer<typeof statisticalPredictionSchema>;
export const statisticalPredictionBatchSchema = z.object({
  modelId: z.string().uuid().optional(),
  modelVersion: z.string().optional(),
  predictions: z.array(statisticalPredictionSchema),
});
export type StatisticalPredictionBatch = z.infer<
  typeof statisticalPredictionBatchSchema
>;
export const activeStatisticalPredictionsSchema = z.object({
  models: z.array(statisticalPredictionBatchSchema),
});
export type ActiveStatisticalPredictions = z.infer<
  typeof activeStatisticalPredictionsSchema
>;
