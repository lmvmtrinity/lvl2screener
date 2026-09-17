import type {
  Candle,
  CandleInterval,
  Instrument,
  Market,
  MarketSessionStatus,
  Quote,
  RawCandle,
  RawMarket,
  RawQuote,
  RawSymbol,
  QuoteSizeUnit,
} from "./types.js";

function requireFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric quote field: ${field}`);
  }
  return value;
}

export function normalizeSymbol(raw: RawSymbol): Instrument {
  return {
    symbol: raw.symbol,
    symbolId: raw.symbolId,
    description: raw.description,
    securityType: raw.securityType,
    exchange: raw.listingExchange,
    currency: raw.currency,
    isQuotable: raw.isQuotable,
    isTradable: raw.isTradable,
  };
}

export function normalizeQuote(
  raw: RawQuote,
  receivedAt: Date,
  source: Quote["source"] = "QUESTRADE_MOCK",
  sizeUnit: QuoteSizeUnit = "SHARES",
  sizeMultiplier = 1,
): Quote {
  if (sizeUnit === "UNKNOWN") {
    throw new Error(
      `Quote-size unit is unknown for ${raw.symbol}; refusing to produce actionable sizing data`,
    );
  }
  const bid = requireFinite(raw.bidPrice, "bidPrice");
  const ask = requireFinite(raw.askPrice, "askPrice");
  if (bid <= 0 || ask <= 0 || ask < bid) {
    throw new Error(`Invalid bid/ask for ${raw.symbol}`);
  }
  if (!Number.isInteger(sizeMultiplier) || sizeMultiplier < 1) {
    throw new Error("quote size multiplier must be a positive whole number");
  }

  const mid = (ask + bid) / 2;
  const spreadAbsolute = ask - bid;
  const isDelayed =
    raw.delay === true || (typeof raw.delay === "number" && raw.delay > 0);
  const delaySeconds = typeof raw.delay === "number" ? raw.delay : null;
  const dataStatus = raw.isHalted
    ? "HALTED"
    : isDelayed
      ? "DELAYED"
      : "REALTIME";

  return {
    symbol: raw.symbol,
    symbolId: raw.symbolId,
    bid,
    bidSize: raw.bidSize * sizeMultiplier,
    bidSizeRaw: raw.bidSize,
    ask,
    askSize: raw.askSize * sizeMultiplier,
    askSizeRaw: raw.askSize,
    sizeUnit,
    sizeMultiplier,
    last: requireFinite(raw.lastTradePrice, "lastTradePrice"),
    lastSize: raw.lastTradeSize,
    volume: raw.volume,
    dayOpen: requireFinite(raw.openPrice, "openPrice"),
    dayHigh: requireFinite(raw.highPrice, "highPrice"),
    dayLow: requireFinite(raw.lowPrice, "lowPrice"),
    mid,
    spreadAbsolute,
    spreadPct: (spreadAbsolute / mid) * 100,
    delaySeconds,
    isDelayed,
    isHalted: raw.isHalted,
    dataStatus,
    actionable: !isDelayed && !raw.isHalted,
    receivedAt,
    lastTradeAt:
      raw.lastTradeTime && Number.isFinite(Date.parse(raw.lastTradeTime))
        ? new Date(raw.lastTradeTime)
        : null,
    source,
  };
}

export function normalizeCandle(
  raw: RawCandle,
  symbolId: number,
  interval: CandleInterval,
  now: Date,
  source: Candle["source"],
): Candle {
  const start = new Date(raw.start);
  const end = new Date(raw.end);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start
  ) {
    throw new Error(`Invalid candle time range for symbol ${symbolId}`);
  }
  if (
    raw.low > raw.high ||
    raw.open < raw.low ||
    raw.open > raw.high ||
    raw.close < raw.low ||
    raw.close > raw.high
  ) {
    throw new Error(`Invalid OHLC values for symbol ${symbolId}`);
  }

  return {
    symbolId,
    interval,
    start,
    end,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: raw.volume,
    source,
    isComplete: now >= end,
  };
}

function getMarketStatus(raw: RawMarket, now: Date): MarketSessionStatus {
  const extendedStart = new Date(raw.extendedStartTime);
  const start = new Date(raw.startTime);
  const end = new Date(raw.endTime);
  const extendedEnd = new Date(raw.extendedEndTime);

  if (now >= start && now < end) return "OPEN";
  if (now >= extendedStart && now < start) return "PRE_MARKET";
  if (now >= end && now < extendedEnd) return "AFTER_HOURS";
  return "CLOSED";
}

export function normalizeMarket(raw: RawMarket, now: Date): Market {
  return {
    name: raw.name,
    currency: raw.currency,
    startTime: new Date(raw.startTime),
    endTime: new Date(raw.endTime),
    extendedStartTime: new Date(raw.extendedStartTime),
    extendedEndTime: new Date(raw.extendedEndTime),
    status: getMarketStatus(raw, now),
  };
}
