import { z } from "zod";
import type {
  CandleInterval,
  CandleRange,
  QuestradeTransport,
  RawCandle,
  RawMarket,
  RawQuote,
  RawSymbol,
  RawSymbolDetail,
  RawTokenGrant,
  TokenTransport,
} from "./types.js";

const TOKEN_URL = "https://login.questrade.com/oauth2/token";
const REQUEST_TIMEOUT_MS = 15_000;

const tokenGrantSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  api_server: z.string().url(),
});

const rawSymbolSchema = z.object({
  symbol: z.string().min(1),
  symbolId: z.number().int().positive(),
  description: z.string(),
  securityType: z.string(),
  listingExchange: z.string(),
  isQuotable: z.boolean(),
  isTradable: z.boolean(),
  currency: z.string(),
});
const symbolSearchSchema = z.object({
  symbols: z.array(rawSymbolSchema).optional(),
  symbol: z.array(rawSymbolSchema).optional(),
});
const rawSymbolDetailSchema = z.object({
  symbol: z.string().min(1),
  symbolId: z.number().int().positive(),
  marketCap: z.number().nullable().optional(),
  industrySector: z.string().nullable().optional(),
});
const symbolDetailsSchema = z.object({
  symbols: z.array(rawSymbolDetailSchema),
});
const rawQuoteSchema = z.object({
  symbol: z.string().min(1),
  symbolId: z.number().int().positive(),
  // Questrade returns null price fields when a listed symbol has no usable
  // snapshot. Keep the envelope valid so one unavailable symbol does not
  // reject every other quote in the batch; getQuotes filters these records.
  bidPrice: z.number().nullable(),
  bidSize: z.number().int(),
  askPrice: z.number().nullable(),
  askSize: z.number().int(),
  lastTradePrice: z.number().nullable(),
  lastTradeSize: z.number().int(),
  lastTradeTime: z.string().datetime({ offset: true }).nullish(),
  volume: z.number().int(),
  openPrice: z.number().nullable(),
  highPrice: z.number().nullable(),
  lowPrice: z.number().nullable(),
  delay: z.union([z.boolean(), z.number()]),
  isHalted: z.boolean(),
});
const quotesSchema = z.object({ quotes: z.array(rawQuoteSchema) });
const rawCandleSchema = z.object({
  start: z.string(),
  end: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().int(),
});
const candlesSchema = z.object({ candles: z.array(rawCandleSchema) });
const rawMarketSchema = z.object({
  name: z.string(),
  tradingVenues: z.array(z.string()).default([]),
  defaultTradingVenue: z.string().default("AUTO"),
  startTime: z.string(),
  endTime: z.string(),
  extendedStartTime: z.string().optional(),
  extendedEndTime: z.string().optional(),
  currency: z.string().optional(),
  snapQuotesLimit: z.number().int(),
});
const marketsSchema = z.object({ markets: z.array(rawMarketSchema) });

export class QuestradeHttpError extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`Questrade ${operation} request failed with HTTP ${status}`);
    this.name = "QuestradeHttpError";
  }
}

export type QuestradeFetch = typeof fetch;

export class LiveQuestradeTransport
  implements TokenTransport, QuestradeTransport
{
  constructor(
    private readonly fetchImpl: QuestradeFetch = fetch,
    private readonly observeHeaders?: (
      headers: Headers,
      status?: number,
    ) => void | Promise<void>,
  ) {}

  async redeemRefreshToken(refreshToken: string): Promise<RawTokenGrant> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return this.request(TOKEN_URL, tokenGrantSchema, "authentication", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
  }

  async searchSymbols(
    apiServer: URL,
    accessToken: string,
    prefix: string,
  ): Promise<RawSymbol[]> {
    const url = apiEndpoint(apiServer, "symbols/search");
    url.searchParams.set("prefix", prefix);
    const response = await this.authorizedRequest(
      url,
      accessToken,
      symbolSearchSchema,
      "symbol search",
    );
    return response.symbols ?? response.symbol ?? [];
  }

  async getSymbolDetails(
    apiServer: URL,
    accessToken: string,
    symbolIds: number[],
  ): Promise<RawSymbolDetail[]> {
    const url = apiEndpoint(apiServer, "symbols");
    url.searchParams.set("ids", symbolIds.join(","));
    const response = await this.authorizedRequest(
      url,
      accessToken,
      symbolDetailsSchema,
      "symbol details",
    );
    return response.symbols.map((symbol) => ({
      symbol: symbol.symbol,
      symbolId: symbol.symbolId,
      marketCap: symbol.marketCap ?? null,
      industrySector: symbol.industrySector ?? null,
    }));
  }

  async getQuotes(
    apiServer: URL,
    accessToken: string,
    symbolIds: number[],
  ): Promise<RawQuote[]> {
    const url = apiEndpoint(apiServer, "markets/quotes");
    url.searchParams.set("ids", symbolIds.join(","));
    const quotes = (
      await this.authorizedRequest(url, accessToken, quotesSchema, "quotes")
    ).quotes;
    return quotes.filter(isCompleteQuote);
  }

  async getCandles(
    apiServer: URL,
    accessToken: string,
    symbolId: number,
    interval: CandleInterval,
    range: CandleRange,
  ): Promise<RawCandle[]> {
    const url = apiEndpoint(apiServer, `markets/candles/${symbolId}`);
    url.searchParams.set("startTime", range.startTime.toISOString());
    url.searchParams.set("endTime", range.endTime.toISOString());
    url.searchParams.set("interval", interval);
    return (
      await this.authorizedRequest(url, accessToken, candlesSchema, "candles")
    ).candles;
  }

  async getMarkets(apiServer: URL, accessToken: string): Promise<RawMarket[]> {
    const url = apiEndpoint(apiServer, "markets");
    const response = await this.authorizedRequest(
      url,
      accessToken,
      marketsSchema,
      "markets",
    );
    return response.markets.map((market) => ({
      ...market,
      extendedStartTime: market.extendedStartTime ?? market.startTime,
      extendedEndTime: market.extendedEndTime ?? market.endTime,
      currency:
        market.currency ??
        (["TSX", "TSXV", "CNSX", "NEO", "MX"].includes(
          market.name.toUpperCase(),
        )
          ? "CAD"
          : ["NASDAQ", "NYSE", "NYSEAM", "ARCA", "BATS", "US"].includes(
                market.name.toUpperCase(),
              )
            ? "USD"
            : "UNKNOWN"),
    }));
  }

  private authorizedRequest<T>(
    url: URL,
    accessToken: string,
    schema: z.ZodType<T>,
    operation: string,
  ): Promise<T> {
    return this.request(url, schema, operation, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
  }

  private async request<T>(
    input: string | URL,
    schema: z.ZodType<T>,
    operation: string,
    init: RequestInit,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
      // Token redemption has a different quota and irreversible rotating credentials.
      // A failed metrics/budget write must never discard a successful token grant.
      if (operation !== "authentication")
        await this.observeHeaders?.(response.headers, response.status);
      if (!response.ok)
        throw new QuestradeHttpError(response.status, operation);
      return schema.parse(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }
}

function isCompleteQuote(
  quote: z.infer<typeof rawQuoteSchema>,
): quote is RawQuote {
  return (
    quote.bidPrice !== null &&
    quote.askPrice !== null &&
    quote.lastTradePrice !== null &&
    quote.openPrice !== null &&
    quote.highPrice !== null &&
    quote.lowPrice !== null
  );
}

function apiEndpoint(apiServer: URL, path: string): URL {
  if (
    apiServer.protocol !== "https:" ||
    !/(^|\.)iq\.questrade\.com$/i.test(apiServer.hostname)
  ) {
    throw new Error(
      "Refusing to send a Questrade access token to an untrusted API server",
    );
  }
  const base = new URL(apiServer);
  if (base.pathname === "/" || base.pathname === "") base.pathname = "/v1/";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL(path.replace(/^\//, ""), base);
}
