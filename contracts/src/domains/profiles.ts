import { z } from "zod";
import {
  contextEvaluationSchema,
  strategyEvaluationSchema,
} from "./scoring.js";
import {
  analysisKindSchema,
  strategyNameSchema,
  strategyParametersSchema,
} from "./strategies.js";
import { marketIdSchema } from "./markets.js";

export const strategyDefinitionSchema = z.object({
  id: z.string().uuid(),
  strategyKey: strategyNameSchema,
  version: z.string().min(1),
  name: z.string().min(1),
  analysisKind: analysisKindSchema,
  description: z.string(),
  enabled: z.boolean(),
  parameterSchema: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type StrategyDefinition = z.infer<typeof strategyDefinitionSchema>;
export const strategyDefinitionListSchema = z.object({
  strategies: z.array(strategyDefinitionSchema),
});

export const scannerProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  /** A profile belongs to one market for its entire lifetime. */
  marketId: marketIdSchema,
  strategyDefinitionId: z.string().uuid(),
  analysisKind: analysisKindSchema,
  strategyKey: strategyNameSchema,
  strategyVersion: z.string().min(1),
  configId: z.string().uuid(),
  configVersion: z.string().min(1),
  sourceCalibrationRunId: z.string().uuid().nullable().optional(),
  parameters: strategyParametersSchema,
  enabled: z.boolean(),
  qualification: z
    .enum(["EXPLORATORY", "PAPER_QUALIFIED", "EVIDENCE_QUALIFIED"])
    .default("EXPLORATORY"),
  qualificationReason: z
    .string()
    .default(
      "No qualifying paper or holdout evidence is linked to this profile configuration.",
    ),
  qualificationEvidence: z
    .object({
      id: z.string().uuid(),
      profileConfigId: z.string().uuid(),
      backtestRunId: z.string().uuid(),
      strategy: strategyNameSchema,
      strategyVersion: z.string().min(1),
      qualification: z.enum(["EXPLORATORY", "EVIDENCE_QUALIFIED"]),
      createdAt: z.string().datetime(),
    })
    .nullable()
    .optional(),
  displayOrder: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ScannerProfile = z.infer<typeof scannerProfileSchema>;
export const scannerProfileListSchema = z.object({
  profiles: z.array(scannerProfileSchema),
});
export const createScannerProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  marketId: marketIdSchema,
  strategyDefinitionId: z.string().uuid(),
  parameters: strategyParametersSchema.default({
    rvolAtTimeMin: 1.5,
    spreadHardMaxPct: 0.25,
    atrPctMin: 0,
    breakoutVolumeRatioMin: 1.5,
    retestTolerancePct: 0.15,
    scoreCutoff: 0,
    breakoutBufferPct: 0.05,
    relativeStrengthMinPct: 0.5,
    flagpoleMinAtr: 0.5,
    flagRetracementMaxPct: 50,
    setupTimeoutMinutes: 20,
    consolidationBarsMin: 3,
    consolidationRangeMaxPct: 0.75,
    flagDurationBarsMin: 1,
    flagDurationBarsMax: 2,
    flagpoleMinSlopeAtrPerBar: 0,
    volumeContractionMaxPct: 100,
    retestVolumeContractionEnabled: 0,
    retestHighBreakEnabled: 0,
    retestRejectionEnabled: 0,
    retestVolumeContractionMaxRatio: 0.8,
    rejectionLowerWickBodyMin: 2,
    rejectionUpperWickRangeMaxPct: 20,
    rejectionCloseLocationMinPct: 65,
    rsiPeriod: 14,
    rsiPivotLeftBars: 2,
    rsiPivotRightBars: 2,
    rsiPivotMinSpacingBars: 3,
    rsiPivotMaxSpacingBars: 12,
    rsiDivergenceMinPoints: 3,
    rsiDivergenceVolumeContractionMaxRatio: 0.8,
    rsiSetupTimeoutMinutes: 30,
    dailyEmaFilterEnabled: 0,
  }),
  enabled: z.boolean().default(true),
  displayOrder: z.number().int().nonnegative().optional(),
});
export type CreateScannerProfile = z.infer<typeof createScannerProfileSchema>;
export const updateScannerProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    parameters: strategyParametersSchema.optional(),
    enabled: z.boolean().optional(),
    displayOrder: z.number().int().nonnegative().optional(),
    sourceCalibrationRunId: z.string().uuid().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  )
  .refine(
    (value) => !value.sourceCalibrationRunId || !!value.parameters,
    "A calibration source can only be attached to a parameter update",
  );
export type UpdateScannerProfile = z.infer<typeof updateScannerProfileSchema>;
export const duplicateScannerProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sourceCalibrationRunId: z.string().uuid().optional(),
});
export type DuplicateScannerProfile = z.infer<
  typeof duplicateScannerProfileSchema
>;

export const opportunityListSchema = z.object({
  opportunities: z.array(strategyEvaluationSchema),
});
export const contextEvaluationListSchema = z.object({
  contexts: z.array(contextEvaluationSchema),
});
export const profileEvaluationListSchema = z.object({
  evaluations: z.array(strategyEvaluationSchema),
});
export const comparisonSourceSchema = z.enum(["LIVE", "PAPER", "BACKTEST"]);
export const profileComparisonStatusSchema = z.enum([
  "CONTROLLED",
  "UNCONTROLLED",
  "UNVERIFIED",
]);
export const profileComparisonMetricSchema = z.object({
  profileId: z.string().uuid(),
  profileName: z.string(),
  setupCount: z.number().int().nonnegative(),
  trades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRate: z.number(),
  averageWinner: z.number(),
  averageLoser: z.number(),
  averageR: z.number(),
  profitFactor: z.number().nullable(),
  expectancy: z.number(),
  maximumDrawdown: z.number().nullable(),
  drawdownBasis: z.literal("REALIZED_CLOSED_OUTCOMES"),
  drawdownStatus: z.enum(["AVAILABLE", "NO_CLOSED_OUTCOMES", "UNAVAILABLE"]),
  averageHoldMinutes: z.number(),
  falsePositiveRate: z.number(),
});
export type ProfileComparisonMetric = z.infer<
  typeof profileComparisonMetricSchema
>;
export const comparisonCohortSchema = z.object({
  profileId: z.string().uuid(),
  cohortKey: z.string().regex(/^[a-f0-9]{64}$/),
  executionModelVersion: z.string().nullable(),
  executionAssumptionsHash: z.string().nullable(),
  outcomeCount: z.number().int().nonnegative(),
});
export type ComparisonCohort = z.infer<typeof comparisonCohortSchema>;
export const comparisonCohortSelectionSchema = z.record(
  z.string().uuid(),
  z.string().regex(/^[a-f0-9]{64}$/),
);
export type ComparisonCohortSelection = z.infer<
  typeof comparisonCohortSelectionSchema
>;
export const profileComparisonSchema = z.object({
  marketId: marketIdSchema.default("CA_TSX"),
  source: comparisonSourceSchema,
  startDate: z.string().date(),
  endDate: z.string().date(),
  timeStart: z.string(),
  timeEnd: z.string(),
  status: profileComparisonStatusSchema,
  controlled: z.boolean(),
  differences: z.array(z.string()),
  availableCohorts: z.array(comparisonCohortSchema).optional(),
  metrics: z.array(profileComparisonMetricSchema),
});
export type ProfileComparison = z.infer<typeof profileComparisonSchema>;
