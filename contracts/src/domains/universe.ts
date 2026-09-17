import { z } from "zod";
import {
  marketCurrencySchema,
  marketIdSchema,
  normalizedExchangeSchema,
} from "./markets.js";

export const universeExclusionReasonSchema = z.enum([
  "NOT_TSX",
  "NOT_CAD",
  "EXCHANGE_NOT_ALLOWED",
  "CURRENCY_NOT_ALLOWED",
  "NOT_COMMON_STOCK",
  "NOT_QUOTABLE",
  "NOT_TRADABLE",
  "PRICE_BELOW_MINIMUM",
  "PRICE_ABOVE_MAXIMUM",
  "MARKET_CAP_BELOW_MINIMUM",
  "AVERAGE_VOLUME_BELOW_MINIMUM",
  "DOLLAR_VOLUME_BELOW_MINIMUM",
  "ATR_BELOW_MINIMUM",
  "INSUFFICIENT_HISTORY",
  "METADATA_UNAVAILABLE",
  "QUOTE_UNAVAILABLE",
]);
export type UniverseExclusionReason = z.infer<
  typeof universeExclusionReasonSchema
>;

export const universePolicySchema = z
  .object({
    version: z.string().min(1),
    /** Explicit from Phase 1 onward; the default keeps historical TSX payloads readable. */
    marketId: marketIdSchema.default("CA_TSX"),
    /** Legacy compatibility fields. New callers should use allowedExchanges/currencies. */
    exchange: z.enum(["TSX"]).optional(),
    currency: z.enum(["CAD"]).optional(),
    allowedExchanges: z
      .array(normalizedExchangeSchema.exclude(["UNKNOWN"]))
      .min(1)
      .default(["TSX"]),
    allowedCurrencies: z.array(marketCurrencySchema).min(1).default(["CAD"]),
    securityTypes: z.array(z.string().min(1)).min(1),
    minimumPrice: z.number().nonnegative(),
    maximumPrice: z.number().positive(),
    minimumMarketCap: z.number().nonnegative(),
    minimumAverageVolume90d: z.number().int().nonnegative(),
    minimumDollarVolume: z.number().nonnegative(),
    minimumAtrPct: z.number().nonnegative(),
    minimumHistoryDays: z.number().int().min(14).max(90),
  })
  .refine((value) => value.maximumPrice > value.minimumPrice, {
    message: "maximumPrice must exceed minimumPrice",
  });
export type UniversePolicy = z.infer<typeof universePolicySchema>;

export const universeMemberSchema = z.object({
  instrumentId: z.string().uuid().nullable(),
  marketId: marketIdSchema.default("CA_TSX"),
  symbol: z.string().min(1),
  description: z.string(),
  exchange: z.string(),
  normalizedExchange: normalizedExchangeSchema.default("TSX"),
  rawExchange: z.string().min(1).nullable().default(null),
  currency: marketCurrencySchema.default("CAD"),
  sector: z.string().nullable(),
  eligible: z.boolean(),
  reasons: z.array(universeExclusionReasonSchema),
  price: z.number().positive().nullable(),
  marketCap: z.number().nonnegative().nullable(),
  averageVolume20d: z.number().nonnegative().nullable(),
  averageVolume90d: z.number().nonnegative().nullable(),
  dollarVolume: z.number().nonnegative().nullable(),
  atr14: z.number().nonnegative().nullable(),
  atrPct: z.number().nonnegative().nullable(),
  metricsAsOf: z.string().datetime(),
});
export type UniverseMember = z.infer<typeof universeMemberSchema>;

export const universeRefreshStatusSchema = z.enum([
  "RUNNING",
  "COMPLETED",
  "FAILED",
]);
export const universeRefreshRunSchema = z.object({
  id: z.string().uuid(),
  marketId: marketIdSchema.default("CA_TSX"),
  provider: z.string().min(1),
  policyVersion: z.string().min(1),
  status: universeRefreshStatusSchema,
  discoveredCount: z.number().int().nonnegative(),
  evaluatedCount: z.number().int().nonnegative(),
  eligibleCount: z.number().int().nonnegative(),
  activatedCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type UniverseRefreshRun = z.infer<typeof universeRefreshRunSchema>;

export const candidateSourceSchema = z.enum([
  "TRADINGVIEW",
  "MANUAL",
  "DISCOVERY",
]);
export type CandidateSource = z.infer<typeof candidateSourceSchema>;

export const candidateIntakeEntrySchema = z.object({
  source: candidateSourceSchema,
  tradingDate: z.string().date(),
  addedAt: z.string().datetime(),
  originalInput: z.string().min(1),
  marketId: marketIdSchema.default("CA_TSX"),
  requestedExchange: normalizedExchangeSchema.nullable().default(null),
  normalizedSymbol: z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,19}(\.TO)?$/),
  resolvedInstrumentId: z.string().uuid().nullable().default(null),
  resolvedSymbol: z.string().min(1).nullable().default(null),
  resolutionStatus: z
    .enum(["PENDING", "RESOLVED", "AMBIGUOUS", "UNSUPPORTED", "NOT_FOUND"])
    .default("PENDING"),
  note: z.string().max(500).nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20),
  provenanceSources: z.array(candidateSourceSchema).min(1).optional(),
  discoveryRunId: z.string().uuid().nullable().default(null),
  discoveryEvaluationId: z.string().uuid().nullable().default(null),
  discoveredAt: z.string().datetime().nullable().default(null),
  intakeAt: z.string().datetime().nullable().default(null),
  strategyReadyAt: z.string().datetime().nullable().default(null),
});
export type CandidateIntakeEntry = z.infer<typeof candidateIntakeEntrySchema>;

export const candidatePipelineStatusSchema = z.enum([
  "QUALIFIED",
  "ADDED",
  "WARMING",
  "READY",
  "EXCLUDED",
  "FAILED",
]);
export type CandidatePipelineStatus = z.infer<
  typeof candidatePipelineStatusSchema
>;
export const candidateIntakeStatusSchema = z.object({
  symbol: z.string().min(1),
  status: candidatePipelineStatusSchema,
  source: candidateSourceSchema,
  discoveredAt: z.string().datetime().nullable(),
  intakeAt: z.string().datetime().nullable(),
  strategyReadyAt: z.string().datetime().nullable(),
  reason: z.string().max(500).nullable(),
  attemptCount: z.number().int().nonnegative(),
});
export type CandidateIntakeStatus = z.infer<typeof candidateIntakeStatusSchema>;

export const candidatePasteItemSchema = z.object({
  originalInput: z.string(),
  marketId: marketIdSchema.optional(),
  normalizedSymbol: z.string().nullable(),
  reason: z.string().nullable(),
});
export type CandidatePasteItem = z.infer<typeof candidatePasteItemSchema>;

export const candidatePasteReportSchema = z.object({
  accepted: z.array(candidatePasteItemSchema),
  normalized: z.array(candidatePasteItemSchema),
  duplicate: z.array(candidatePasteItemSchema),
  unsupported: z.array(candidatePasteItemSchema),
  failed: z.array(candidatePasteItemSchema),
});
export type CandidatePasteReport = z.infer<typeof candidatePasteReportSchema>;

export const candidateCoverageStatusSchema = z.enum([
  "WARMING",
  "ANALYZABLE",
  "FORMING",
  "READY",
  "INVALIDATED",
  "UNAVAILABLE",
]);
export type CandidateCoverageStatus = z.infer<
  typeof candidateCoverageStatusSchema
>;
export const dataReadinessSchema = z.enum([
  "READY",
  "WARMING",
  "UNAVAILABLE",
  "STALE",
  "DELAYED",
  "HALTED",
]);
export type DataReadiness = z.infer<typeof dataReadinessSchema>;
export const candidateCoverageSchema = z.object({
  symbol: z.string().min(1),
  status: candidateCoverageStatusSchema,
  dataReadiness: dataReadinessSchema,
  warmupPending: z.array(z.string()),
  setupCount: z.number().int().nonnegative(),
  contextCount: z.number().int().nonnegative(),
  latestAnalysisAt: z.string().datetime().nullable(),
  reasons: z.array(z.string()),
});
export type CandidateCoverage = z.infer<typeof candidateCoverageSchema>;

export const updateCandidateIntakeSchema = z.object({
  operation: z.enum(["ADD", "REPLACE"]),
  source: candidateSourceSchema.default("TRADINGVIEW"),
  inputs: z.array(z.string().max(100)).min(1).max(200),
  note: z.string().max(500).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
});
export type UpdateCandidateIntake = z.infer<typeof updateCandidateIntakeSchema>;

export const universeAutomationSchema = z.object({
  provider: z.string().min(1),
  policy: universePolicySchema,
  latestRun: universeRefreshRunSchema.nullable(),
  members: z.array(universeMemberSchema),
  editable: z.boolean().optional(),
  configuredSymbols: z.array(z.string().min(1)).optional(),
  candidates: z.array(candidateIntakeEntrySchema).optional(),
  candidateStatuses: z.array(candidateIntakeStatusSchema).optional(),
  coverage: z.array(candidateCoverageSchema).optional(),
  watchlistDate: z.string().date().optional(),
});
export type UniverseAutomation = z.infer<typeof universeAutomationSchema>;
export const universeResponseSchema = z.object({
  instruments: z.array(z.unknown()),
  automation: universeAutomationSchema,
  pasteReport: candidatePasteReportSchema.optional(),
  // Candidate metadata is committed before the external market-data refresh.
  // Surface a refresh failure without misreporting the committed paste as failed.
  refreshError: z.string().min(1).optional(),
});
export const universeRefreshRunListSchema = z.object({
  runs: z.array(universeRefreshRunSchema),
});
