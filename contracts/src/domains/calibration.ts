import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import { researchEvidenceBindingSchema } from "./research-evidence.js";
import {
  backtestMetricsSchema,
  backtestSliceSchema,
  capturedHistoryAvailabilitySchema,
} from "./backtests.js";
import {
  setupStrategyNameSchema,
  strategyParametersSchema,
} from "./strategies.js";

export const calibrationGridSchema = z.object({
  rvolAtTimeMin: z
    .array(z.number().nonnegative().max(20))
    .min(1)
    .max(12)
    .default([1.5]),
  spreadHardMaxPct: z
    .array(z.number().positive().max(5))
    .min(1)
    .max(12)
    .default([0.25]),
  atrPctMin: z
    .array(z.number().nonnegative().max(20))
    .min(1)
    .max(12)
    .default([1.5]),
  openingRangeMinutes: z
    .array(z.number().int().min(5).max(60))
    .min(1)
    .max(12)
    .default([15]),
  breakoutVolumeRatioMin: z
    .array(z.number().positive().max(20))
    .min(1)
    .max(12)
    .default([1.5]),
  retestTolerancePct: z
    .array(z.number().nonnegative().max(5))
    .min(1)
    .max(12)
    .default([0.15]),
  scoreCutoff: z
    .array(z.number().int().min(0).max(100))
    .min(1)
    .max(12)
    .default([0]),
  entryWindowEnd: z
    .array(z.string().regex(/^\d{2}:\d{2}$/))
    .min(1)
    .max(12)
    .default(["11:30"]),
  stopMethod: z
    .array(z.enum(["STRUCTURAL", "ATR"]))
    .min(1)
    .max(2)
    .default(["STRUCTURAL"]),
  rewardRiskRatio: z
    .array(z.number().positive().max(20))
    .min(1)
    .max(12)
    .default([2]),
});
export type CalibrationGrid = z.infer<typeof calibrationGridSchema>;
export const createCalibrationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    marketId: marketIdSchema.default("CA_TSX"),
    startDate: z.string().date(),
    endDate: z.string().date(),
    strategy: setupStrategyNameSchema,
    symbols: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(32)
          .transform((value) => value.toUpperCase()),
      )
      .max(500)
      .default([]),
    dataSource: z.literal("CAPTURED_QUOTES").default("CAPTURED_QUOTES"),
    startingCapital: z.number().positive().max(1_000_000_000).default(100_000),
    positionSize: z.number().positive().max(100_000_000).default(10_000),
    slippageBps: z.number().nonnegative().max(1_000).default(2),
    feePerTrade: z.number().nonnegative().max(10_000).default(0),
    atrStopMultiple: z.number().positive().max(10).default(1),
    trainPct: z.number().int().min(40).max(80).default(60),
    validationPct: z.number().int().min(10).max(30).default(20),
    minimumTradesPerSegment: z.number().int().min(1).max(10_000).default(30),
    maxCombinations: z.number().int().min(1).max(256).default(128),
    grid: calibrationGridSchema.default({
      rvolAtTimeMin: [1.5],
      spreadHardMaxPct: [0.25],
      atrPctMin: [1.5],
      openingRangeMinutes: [15],
      breakoutVolumeRatioMin: [1.5],
      retestTolerancePct: [0.15],
      scoreCutoff: [0],
      entryWindowEnd: ["11:30"],
      stopMethod: ["STRUCTURAL"],
      rewardRiskRatio: [2],
    }),
  })
  .refine((value) => value.trainPct + value.validationPct <= 90, {
    message: "trainPct + validationPct must be at most 90",
  })
  .refine(
    (value) =>
      value.marketId !== "US_EQUITIES" ||
      (value.trainPct === 60 &&
        value.validationPct === 20 &&
        value.minimumTradesPerSegment >= 30),
    {
      message:
        "US_EQUITIES calibration requires a 60/20/20 chronological split and at least 30 trades per segment",
    },
  );
export type CreateCalibration = z.infer<typeof createCalibrationSchema>;
export const calibrationSegmentSchema = z.enum([
  "TRAIN",
  "VALIDATION",
  "TEST",
  "ALL",
]);
export const calibrationTrialParametersSchema = strategyParametersSchema.extend(
  {
    openingRangeMinutes: z.number().int(),
    entryWindowEnd: z.string(),
    stopMethod: z.enum(["STRUCTURAL", "ATR"]),
    rewardRiskRatio: z.number().positive(),
  },
);
export const calibrationTrialSchema = z.object({
  rank: z.number().int().positive(),
  configVersion: z.string(),
  parameters: calibrationTrialParametersSchema,
  segments: z.object({
    TRAIN: backtestMetricsSchema,
    VALIDATION: backtestMetricsSchema,
    TEST: backtestMetricsSchema.nullable(),
    ALL: backtestMetricsSchema.nullable(),
  }),
  robustScore: z.number(),
  plateauSize: z.number().int().nonnegative(),
  sufficientSample: z.boolean(),
  outOfSamplePositive: z.boolean(),
  warnings: z.array(z.string()),
  analyses: z.array(backtestSliceSchema),
  analysesScope: z.enum(["ALL", "VALIDATION"]).default("ALL"),
});
export type CalibrationTrial = z.infer<typeof calibrationTrialSchema>;
export const calibrationSelectionSchema = z.object({
  version: z.literal("selected-holdout-v1"),
  configVersion: z.string().nullable(),
  replayInputHash: z.string(),
});
export type CalibrationSelection = z.infer<typeof calibrationSelectionSchema>;
export const calibrationStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
]);
export const calibrationRunSchema = z.object({
  id: z.string().uuid(),
  marketId: marketIdSchema.default("CA_TSX"),
  name: z.string(),
  status: calibrationStatusSchema,
  startDate: z.string().date(),
  endDate: z.string().date(),
  strategy: setupStrategyNameSchema,
  symbols: z.array(z.string()),
  dataSource: z.literal("CAPTURED_QUOTES"),
  executionModelVersion: z.string().nullable().default(null),
  executionAssumptions: z
    .record(z.string(), z.unknown())
    .nullable()
    .default(null),
  input: createCalibrationSchema,
  capturedHistoryAvailability: capturedHistoryAvailabilitySchema
    .nullable()
    .default(null),
  combinationsTested: z.number().int().nonnegative(),
  totalCombinations: z.number().int().nonnegative(),
  truncated: z.boolean(),
  splitDates: z
    .object({ trainEnd: z.string().date(), validationEnd: z.string().date() })
    .nullable(),
  recommendation: z.string(),
  recommendedConfig: calibrationTrialParametersSchema.nullable(),
  trials: z.array(calibrationTrialSchema),
  holdoutSelection: calibrationSelectionSchema.nullable().default(null),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  researchEvidence: researchEvidenceBindingSchema.nullable().optional(),
});
export type CalibrationRun = z.infer<typeof calibrationRunSchema>;
export const calibrationRunListSchema = z.object({
  calibrations: z.array(calibrationRunSchema),
});
