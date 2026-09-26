import { z } from "zod";
import { marketIdSchema } from "./markets.js";

export const strategyLearningScopeSchema = z.object({
  marketId: marketIdSchema,
  strategyKey: z.string().min(1),
  profileConfigId: z.string().uuid(),
  strategyVersion: z.string().min(1),
  configVersion: z.string().min(1),
  executionModelVersion: z.string().min(1),
  executionAssumptions: z.record(z.string(), z.unknown()),
});
export type StrategyLearningScope = z.infer<typeof strategyLearningScopeSchema>;

export const strategyLearningReadinessSchema = z.object({
  sourceKind: z.literal("BACKTEST_RUN"),
  scope: strategyLearningScopeSchema,
  state: z.enum([
    "SAMPLE_THRESHOLD_MET",
    "WAITING_FOR_EVIDENCE",
    "UNVERIFIED_INPUT",
  ]),
  targetDistinctTrades: z.number().int().positive(),
  verifiedSessions: z.number().int().nonnegative(),
  distinctClosedTrades: z.number().int().nonnegative(),
  usableModelRows: z.number().int().nonnegative(),
  qualificationCounts: z.object({
    EVIDENCE_QUALIFIED: z.number().int().nonnegative(),
    EXPLORATORY: z.number().int().nonnegative(),
  }),
  exclusions: z.record(z.string(), z.number().int().nonnegative()),
  strata: z.object({
    time: z.record(z.string(), z.number().int().nonnegative()),
    atr: z.record(z.string(), z.number().int().nonnegative()),
    rvol: z.record(z.string(), z.number().int().nonnegative()),
  }),
  blockers: z.array(z.string()),
  shortfall: z.number().int().nonnegative(),
  feasibility: z.object({
    state: z.literal("UNAVAILABLE"),
    reason: z.literal("MISSING_PREDECLARED_EXPERIMENT_CRITERIA"),
  }),
  collectionEstimate: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("AVAILABLE_RANGE"),
      minSessions: z.number().int().nonnegative(),
      maxSessions: z.number().int().nonnegative(),
      observedRateMin: z.number().nonnegative(),
      observedRateMax: z.number().nonnegative(),
      observedSessions: z.number().int().positive(),
    }),
    z.object({
      state: z.literal("UNAVAILABLE"),
      reason: z.enum(["NO_VERIFIED_SESSIONS", "ZERO_OUTCOME_SESSION"]),
      observedRateMin: z.number().nonnegative().nullable(),
      observedRateMax: z.number().nonnegative().nullable(),
      observedSessions: z.number().int().nonnegative(),
    }),
  ]),
});
export type StrategyLearningReadiness = z.infer<
  typeof strategyLearningReadinessSchema
>;
