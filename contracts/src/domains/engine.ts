import { z } from "zod";
import { featureSnapshotBatchSchema } from "./market-data.js";
import {
  contextEvaluationSchema,
  strategyEvaluationSchema,
  strategyStateEventSchema,
} from "./scoring.js";

export const benchmarkReadinessItemSchema = z.object({
  kind: z.enum(["MARKET", "SECTOR"]),
  sector: z.string().nullable(),
  symbol: z.string(),
  status: z.enum(["READY", "UNAVAILABLE", "STALE"]),
  timestamp: z.string().datetime().nullable(),
  reason: z.string().nullable(),
});
export const benchmarkReadinessSchema = z.object({
  market: benchmarkReadinessItemSchema.nullable(),
  sectors: z.array(benchmarkReadinessItemSchema),
});
export type BenchmarkReadiness = z.infer<typeof benchmarkReadinessSchema>;
export const engineTimingsSchema = z
  .object({
    featureMs: z.number().nonnegative(),
    evaluationMs: z.number().nonnegative(),
  })
  .default({ featureMs: 0, evaluationMs: 0 });
export const engineResultBatchSchema = featureSnapshotBatchSchema.extend({
  evaluations: z.array(strategyEvaluationSchema),
  events: z.array(strategyStateEventSchema),
  contexts: z.array(contextEvaluationSchema),
  benchmarkReadiness: benchmarkReadinessSchema,
  timings: engineTimingsSchema,
});
export type EngineResultBatch = z.infer<typeof engineResultBatchSchema>;

export const chartCandleSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().int().nonnegative(),
  isComplete: z.boolean(),
});
export type ChartCandle = z.infer<typeof chartCandleSchema>;
