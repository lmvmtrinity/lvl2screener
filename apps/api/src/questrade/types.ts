import type { QuestradeRequestObservationContext } from "./request-observation.js";

export type CandleInterval = "OneMinute" | "FiveMinutes" | "OneDay";

export interface RawTokenGrant {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  api_server: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  apiServer: URL;
}

export interface RawSymbol {
  symbol: string;
  symbolId: number;
  description: string;
  securityType: string;
  listingExchange: string;
  isQuotable: boolean;
  isTradable: boolean;
  currency: string;
}

export interface RawSymbolDetail {
  symbol: string;
  symbolId: number;
  marketCap: number | null;
  industrySector: string | null;
}

export interface InstrumentFundamentals {
  symbol: string;
  symbolId: number;
  marketCap: number | null;
  sector: string | null;
}

export interface RawQuote {
  symbol: string;
  symbolId: number;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  lastTradePrice: number;
  lastTradeSize: number;
  lastTradeTime?: string | null;
  volume: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  // Questrade documents this as boolean, while its example payload uses 0/1.
  delay: boolean | number;
  isHalted: boolean;
}

export interface RawCandle {
  start: string;
  end: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RawMarket {
  name: string;
  tradingVenues: string[];
  defaultTradingVenue: string;
  startTime: string;
  endTime: string;
  extendedStartTime: string;
  extendedEndTime: string;
  currency: string;
  snapQuotesLimit: number;
}

export interface Instrument {
  symbol: string;
  symbolId: number;
  description: string;
  securityType: string;
  exchange: string;
  currency: string;
  isQuotable: boolean;
  isTradable: boolean;
}

export type MarketDataStatus = "REALTIME" | "DELAYED" | "HALTED";
export type QuoteSizeUnit = "SHARES" | "BOARD_LOTS" | "UNKNOWN";

export interface Quote {
  symbol: string;
  symbolId: number;
  bid: number;
  /** Normalized displayed shares, used for sizing and coverage. */
  bidSize: number;
  bidSizeRaw?: number;
  ask: number;
  /** Normalized displayed shares, used for sizing and coverage. */
  askSize: number;
  askSizeRaw?: number;
  sizeUnit?: QuoteSizeUnit;
  sizeMultiplier?: number;
  last: number;
  lastSize: number;
  volume: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  mid: number;
  spreadAbsolute: number;
  spreadPct: number;
  delaySeconds: number | null;
  isDelayed: boolean;
  isHalted: boolean;
  dataStatus: MarketDataStatus;
  actionable: boolean;
  receivedAt: Date;
  /** Provider last-trade time; missing is unknown, never retrieval time. */
  lastTradeAt?: Date | null;
  source: "QUESTRADE_MOCK" | "QUESTRADE";
}

export interface Candle {
  symbolId: number;
  interval: CandleInterval;
  start: Date;
  end: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: "QUESTRADE_MOCK" | "QUESTRADE";
  isComplete: boolean;
}

export type MarketSessionStatus =
  "PRE_MARKET" | "OPEN" | "AFTER_HOURS" | "CLOSED";

export interface Market {
  name: string;
  currency: string;
  startTime: Date;
  endTime: Date;
  extendedStartTime: Date;
  extendedEndTime: Date;
  status: MarketSessionStatus;
}

export interface CandleRange {
  startTime: Date;
  endTime: Date;
}

export interface TokenTransport {
  redeemRefreshToken(refreshToken: string): Promise<RawTokenGrant>;
}

export interface QuestradeTransport {
  searchSymbols(
    apiServer: URL,
    accessToken: string,
    prefix: string,
  ): Promise<RawSymbol[]>;
  getSymbolDetails(
    apiServer: URL,
    accessToken: string,
    symbolIds: number[],
  ): Promise<RawSymbolDetail[]>;
  getQuotes(
    apiServer: URL,
    accessToken: string,
    symbolIds: number[],
  ): Promise<RawQuote[]>;
  getCandles(
    apiServer: URL,
    accessToken: string,
    symbolId: number,
    interval: CandleInterval,
    range: CandleRange,
  ): Promise<RawCandle[]>;
  getMarkets(apiServer: URL, accessToken: string): Promise<RawMarket[]>;
}

export interface MarketDataAdapter {
  initialize(): Promise<AuthSession>;
  searchSymbols(
    prefix: string,
    options?: MarketDataRequestOptions,
  ): Promise<Instrument[]>;
  getFundamentals?(
    symbolIds: number[],
    options?: MarketDataRequestOptions,
  ): Promise<InstrumentFundamentals[]>;
  getQuotes(
    symbolIds: number[],
    options?: MarketDataRequestOptions,
  ): Promise<Quote[]>;
  getCandles(
    symbolId: number,
    interval: CandleInterval,
    range: CandleRange,
    options?: MarketDataRequestOptions,
  ): Promise<Candle[]>;
  getMarket(name: string): Promise<Market | undefined>;
}

export interface MarketDataRequestOptions {
  signal?: AbortSignal;
  expiresAt?: Date;
  observation?: QuestradeRequestObservationContext;
}
