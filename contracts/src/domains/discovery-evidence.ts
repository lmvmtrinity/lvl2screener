import { z } from "zod";
import {
  marketIdSchema,
  marketCurrencySchema,
  normalizedExchangeSchema,
} from "./markets.js";
import {
  discoveryCoverageSchema,
  discoveryEvaluationStateSchema,
  discoveryMetricsSchema,
  discoveryModeSchema,
  discoveryReasonSchema,
} from "./discovery.js";

export const discoveryPolicyVersionSchema = z.enum([
  "ca-discovery-v1",
  "us-discovery-v1",
]);
const observationSourceSchema = z.enum(["QUESTRADE", "FIXTURE"]);
const historyValues = {
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite(),
  observedAt: z.string().datetime(),
  complete: z.boolean(),
  source: observationSourceSchema,
  adjustmentRevision: z.string().min(1),
};
export const discoveryDailyBarSchema = z
  .object({
    ...historyValues,
    tradingDate: z.string().date(),
  })
  .strict();
export const discoverySlotBarSchema = z
  .object({
    ...historyValues,
    start: z.string().datetime(),
    end: z.string().datetime(),
  })
  .strict();
export const discoveryCalendarSessionSchema = z
  .object({
    tradingDate: z.string().date(),
    open: z.string().datetime(),
    close: z.string().datetime(),
  })
  .strict();
export const discoveryEvaluationInputSchema = z
  .object({
    marketId: marketIdSchema,
    policyVersion: discoveryPolicyVersionSchema,
    providerCode: z.string().min(1).max(100),
    tradingDate: z.string().date(),
    providerExchange: z.string().min(1).max(100),
    evaluationAt: z.string().datetime(),
    completedBarEnd: z.string().datetime(),
    identity: z
      .object({
        marketId: marketIdSchema,
        symbolId: z.number().int().positive(),
        symbol: z.string().min(1),
        exchange: normalizedExchangeSchema,
        currency: marketCurrencySchema,
        classification: z.enum(["COMMON_STOCK_REVIEWED", "OTHER", "UNKNOWN"]),
        observedAt: z.string().datetime(),
        source: observationSourceSchema,
      })
      .strict(),
    marketCap: z
      .object({
        value: z.number().finite().nullable(),
        currency: marketCurrencySchema,
        observedAt: z.string().datetime(),
        source: observationSourceSchema,
      })
      .strict(),
    quote: z
      .object({
        price: z.number().finite().nullable(),
        open: z.number().finite().nullable(),
        priceAt: z.string().datetime().nullable(),
        observedAt: z.string().datetime(),
        delayed: z.boolean().nullable(),
        halted: z.boolean().nullable(),
        session: z.enum(["REGULAR", "EXTENDED", "UNKNOWN"]),
        source: observationSourceSchema,
      })
      .strict()
      .nullable(),
    calendar: z
      .object({
        marketId: marketIdSchema,
        verified: z.boolean(),
        revision: z.string().min(1),
        source: z.string().min(1),
        observedAt: z.string().datetime(),
        sessions: z.array(discoveryCalendarSessionSchema).max(400),
      })
      .strict(),
    adjustment: z
      .object({
        verified: z.boolean(),
        revision: z.string().min(1),
        source: z.string().min(1),
        convention: z.enum(["UNADJUSTED", "SPLIT_ADJUSTED", "UNKNOWN"]),
        hasUnresolvedCorporateAction: z.boolean(),
        observedAt: z.string().datetime(),
      })
      .strict(),
    dailyBars: z.array(discoveryDailyBarSchema).max(400),
    slotBars: z.array(discoverySlotBarSchema).max(2_000),
  })
  .strict();
export type DiscoveryEvaluationInput = z.infer<
  typeof discoveryEvaluationInputSchema
>;

export const discoveryEvaluationResultSchema = z
  .object({
    marketId: marketIdSchema,
    policyVersion: discoveryPolicyVersionSchema,
    providerCode: z.string().min(1).max(100),
    symbolId: z.number().int().positive().nullable(),
    providerExchange: z.string().min(1).max(100),
    tradingDate: z.string().date(),
    evaluationAt: z.string().datetime(),
    computedAt: z.string().datetime(),
    completedBarEnd: z.string().datetime(),
    state: discoveryEvaluationStateSchema,
    reasons: z.array(discoveryReasonSchema),
    metrics: discoveryMetricsSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    const policy =
      result.marketId === "CA_TSX" ? "ca-discovery-v1" : "us-discovery-v1";
    if (result.policyVersion !== policy)
      ctx.addIssue({
        code: "custom",
        message: "Discovery policy market mismatch",
      });
    if (
      result.state === "PASS" &&
      (result.reasons.length > 0 ||
        result.symbolId === null ||
        Date.parse(result.computedAt) < Date.parse(result.evaluationAt) ||
        Date.parse(result.computedAt) - Date.parse(result.evaluationAt) >
          120_000 ||
        Date.parse(result.evaluationAt) - Date.parse(result.completedBarEnd) <
          15_000 ||
        Date.parse(result.evaluationAt) - Date.parse(result.completedBarEnd) >=
          300_000 ||
        Object.values(result.metrics).some(
          (metric) =>
            metric.value === null ||
            metric.asOf === null ||
            Date.parse(metric.asOf) > Date.parse(result.evaluationAt),
        ))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Passing discovery requires complete point-in-time metrics and identity",
      });
    if (result.state !== "PASS" && result.reasons.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "Non-passing discovery requires reasons",
      });
  });
export type DiscoveryEvaluationResult = z.infer<
  typeof discoveryEvaluationResultSchema
>;

export const discoveryRunSchema = z
  .object({
    id: z.string().uuid(),
    marketId: marketIdSchema,
    tradingDate: z.string().date(),
    policyVersion: discoveryPolicyVersionSchema,
    mode: discoveryModeSchema,
    evaluationAt: z.string().datetime(),
    completedBarEnd: z.string().datetime(),
    catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["RUNNING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]),
    coverage: discoveryCoverageSchema,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    failure: z.string().max(500).nullable(),
  })
  .strict();
export type DiscoveryRun = z.infer<typeof discoveryRunSchema>;
export const discoveryEvidenceSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    result: discoveryEvaluationResultSchema,
    inputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    input: discoveryEvaluationInputSchema.nullable(),
    inputRetained: z.boolean(),
  })
  .strict();
export type DiscoveryEvidence = z.infer<typeof discoveryEvidenceSchema>;

export const discoveryRunListSchema = z
  .object({
    runs: z.array(discoveryRunSchema),
    nextBefore: z.string().datetime().nullable(),
  })
  .strict();

export const discoveryEvidenceListSchema = z
  .object({
    evaluations: z.array(discoveryEvidenceSchema),
    nextAfter: z
      .object({ exchange: z.string(), code: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
