import { z } from "zod";
import { chartCandleSchema } from "./engine.js";
import { featureSnapshotSchema } from "./market-data.js";
import {
  contextEvaluationSchema,
  strategyEvaluationSchema,
  strategyStateEventSchema,
} from "./scoring.js";
import { candidateCoverageSchema, universeMemberSchema } from "./universe.js";

export const candidateListSchema = z.object({
  candidates: z.array(strategyEvaluationSchema),
});
export type CandidateList = z.infer<typeof candidateListSchema>;
export const candidateDetailSchema = z.object({
  symbol: z.string().min(1),
  strategies: z.array(strategyEvaluationSchema),
  contexts: z.array(contextEvaluationSchema),
  feature: featureSnapshotSchema.nullable(),
  candles: z.array(chartCandleSchema),
  events: z.array(strategyStateEventSchema),
  member: z
    .lazy(() => universeMemberSchema)
    .nullable()
    .optional(),
  coverage: z
    .lazy(() => candidateCoverageSchema)
    .nullable()
    .optional(),
});
export type CandidateDetail = z.infer<typeof candidateDetailSchema>;
