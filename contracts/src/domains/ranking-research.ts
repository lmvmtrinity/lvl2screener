import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import { setupStrategyNameSchema } from "./strategies.js";

export const rankingResearchFormulaVersionSchema = z.enum([
  "ranking-bounded-context-research-v1",
  "ranking-setup-interaction-research-v1",
]);
export type RankingResearchFormulaVersion = z.infer<
  typeof rankingResearchFormulaVersionSchema
>;
export const rankingResearchContextHorizonSchema = z.enum([
  "SESSION_ONLY",
  "MULTI_HORIZON",
]);
export const createRankingResearchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  marketId: marketIdSchema.default("CA_TSX"),
  backtestRunId: z.string().uuid(),
  formulaVersions: z
    .array(rankingResearchFormulaVersionSchema)
    .min(1)
    .max(2)
    .refine(
      (values) => new Set(values).size === values.length,
      "Formula versions must be unique",
    )
    .default([
      "ranking-bounded-context-research-v1",
      "ranking-setup-interaction-research-v1",
    ]),
  contextHorizon: rankingResearchContextHorizonSchema.default("MULTI_HORIZON"),
  strategyWeights: z
    .partialRecord(setupStrategyNameSchema, z.number().min(-0.5).max(0.5))
    .default({}),
  trainPct: z.number().int().min(50).max(85).default(70),
  topPerSession: z.number().int().min(1).max(20).default(3),
  minimumSamplesPerSlice: z.number().int().min(1).max(10_000).default(30),
  slippageStressBps: z.number().nonnegative().max(1000).default(5),
  feeStressPerTrade: z.number().nonnegative().max(10_000).default(5),
  maximumDrawdownDegradationPct: z.number().nonnegative().max(100).default(10),
  sensitivityMultipliers: z
    .array(z.number().min(0.25).max(2))
    .min(3)
    .max(9)
    .refine(
      (values) =>
        new Set(values).size === values.length &&
        values.includes(1) &&
        values.some((value) => value < 1) &&
        values.some((value) => value > 1),
      "Sensitivity multipliers must be unique and span both sides of 1",
    )
    .default([0.75, 1, 1.25]),
});
export type CreateRankingResearch = z.infer<typeof createRankingResearchSchema>;
export const rankingResearchMetricsSchema = z.object({
  samples: z.number().int().nonnegative(),
  averageR: z.number(),
  expectancyR: z.number(),
  falseBreakoutRate: z.number(),
  maximumDrawdownR: z.number(),
  netR: z.number(),
  contextEvidenceSamples: z.number().int().nonnegative(),
});
export type RankingResearchMetrics = z.infer<
  typeof rankingResearchMetricsSchema
>;
export const rankingResearchSliceSchema = rankingResearchMetricsSchema.extend({
  dimension: z.enum(["STRATEGY", "MARKET_REGIME"]),
  bucket: z.string(),
});
export type RankingResearchSlice = z.infer<typeof rankingResearchSliceSchema>;
export const rankingResearchSegmentSchema = z.object({
  start: z.string().datetime().nullable(),
  end: z.string().datetime().nullable(),
  baseline: rankingResearchMetricsSchema,
  candidate: rankingResearchMetricsSchema,
  baselineSlices: z.array(rankingResearchSliceSchema),
  candidateSlices: z.array(rankingResearchSliceSchema),
});
export const rankingResearchSensitivitySchema = z.object({
  multiplier: z.number(),
  metrics: rankingResearchMetricsSchema,
});
export const rankingResearchGateSchema = z.object({
  adequateSamples: z.boolean(),
  contextEvidenceAvailable: z.boolean(),
  expectancyStableOrImproved: z.boolean(),
  falseBreakoutStableOrReduced: z.boolean(),
  drawdownAcceptable: z.boolean(),
  strategyGeneralizes: z.boolean(),
  sensitivityStable: z.boolean(),
  costsAcceptable: z.boolean(),
  eligibleForActivation: z.boolean(),
  reasons: z.array(z.string()),
});
export const rankingResearchFormulaResultSchema = z.object({
  formulaVersion: rankingResearchFormulaVersionSchema,
  mode: z.enum(["BOUNDED_CONTEXT", "SETUP_INTERACTION"]),
  train: rankingResearchSegmentSchema,
  holdout: rankingResearchSegmentSchema,
  sensitivity: z.array(rankingResearchSensitivitySchema),
  costStressedCandidate: rankingResearchMetricsSchema,
  costStressedBaseline: rankingResearchMetricsSchema,
  correlatedInputFlags: z.array(z.string()),
  gate: rankingResearchGateSchema,
});
export type RankingResearchFormulaResult = z.infer<
  typeof rankingResearchFormulaResultSchema
>;
export const rankingResearchStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
]);
export const rankingResearchRunSchema = z.object({
  id: z.string().uuid(),
  marketId: marketIdSchema.default("CA_TSX"),
  name: z.string(),
  status: rankingResearchStatusSchema,
  backtestRunId: z.string().uuid(),
  executionModelVersion: z.string().nullable().default(null),
  input: createRankingResearchSchema,
  activeFormulaVersionAtStart: z.string(),
  chronologicalSplitAt: z.string().datetime().nullable(),
  results: z.array(rankingResearchFormulaResultSchema),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type RankingResearchRun = z.infer<typeof rankingResearchRunSchema>;
export const rankingResearchRunListSchema = z.object({
  studies: z.array(rankingResearchRunSchema),
});
