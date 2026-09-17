import { z } from "zod";

/**
 * A trading domain, deliberately distinct from a broker's market name or a
 * listing exchange.  This is the boundary used for calendars, currency,
 * benchmarks, portfolios, and research evidence.
 */
export const marketIdSchema = z.enum(["CA_TSX", "US_EQUITIES"]);
export type MarketId = z.infer<typeof marketIdSchema>;

/** `ALL` is a read-query scope only. It must never be persisted as a market. */
export const marketFilterSchema = z.enum(["CA_TSX", "US_EQUITIES", "ALL"]);
export type MarketFilter = z.infer<typeof marketFilterSchema>;

export const marketCurrencySchema = z.enum(["CAD", "USD"]);
export type MarketCurrency = z.infer<typeof marketCurrencySchema>;

export const normalizedExchangeSchema = z.enum([
  "TSX",
  "NASDAQ",
  "NYSE",
  "NYSE_AMERICAN",
  "NYSE_ARCA",
  "CBOE_BZX",
  "UNKNOWN",
]);
export type NormalizedExchange = z.infer<typeof normalizedExchangeSchema>;

export const marketSessionPhaseSchema = z.enum([
  "PRE_MARKET",
  "OPENING_RANGE",
  "SCANNING",
  "ENTRY_PREFERRED",
  "ENTRY_CUTOFF",
  "AFTER_HOURS",
  "CLOSED",
  "UNKNOWN",
]);
export type MarketSessionPhase = z.infer<typeof marketSessionPhaseSchema>;

export const marketSessionSchema = z.object({
  marketId: marketIdSchema,
  providerMarketKey: z.string().min(1),
  timezone: z.enum(["America/Toronto", "America/New_York"]),
  phase: marketSessionPhaseSchema,
  startTime: z.string().datetime().nullable(),
  endTime: z.string().datetime().nullable(),
  refreshedAt: z.string().datetime(),
});
export type MarketSession = z.infer<typeof marketSessionSchema>;

export const marketSummarySchema = z.object({
  marketId: marketIdSchema,
  currency: marketCurrencySchema,
  enabled: z.boolean(),
  marketDataEnabled: z.boolean(),
  paperTradingEnabled: z.boolean(),
});
export type MarketSummary = z.infer<typeof marketSummarySchema>;
