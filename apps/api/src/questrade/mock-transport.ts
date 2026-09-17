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

const MOCK_SYMBOLS: RawSymbol[] = [
  {
    symbol: "BTO.TO",
    symbolId: 1001,
    description: "B2GOLD CORP",
    securityType: "Stock",
    listingExchange: "TSX",
    isQuotable: true,
    isTradable: true,
    currency: "CAD",
  },
  {
    symbol: "BAM.TO",
    symbolId: 1002,
    description: "BROOKFIELD ASSET MANAGEMENT LTD",
    securityType: "Stock",
    listingExchange: "TSX",
    isQuotable: true,
    isTradable: true,
    currency: "CAD",
  },
  {
    symbol: "QBR.B.TO",
    symbolId: 1003,
    description: "QUEBECOR INC CLASS B",
    securityType: "Stock",
    listingExchange: "TSX",
    isQuotable: true,
    isTradable: true,
    currency: "CAD",
  },
  {
    symbol: "XIU.TO",
    symbolId: 2001,
    description: "ISHARES S&P TSX 60 INDEX ETF",
    securityType: "ETF",
    listingExchange: "TSX",
    isQuotable: true,
    isTradable: true,
    currency: "CAD",
  },
  {
    symbol: "XMA.TO",
    symbolId: 2002,
    description: "ISHARES S&P TSX CAPPED MATERIALS INDEX ETF",
    securityType: "ETF",
    listingExchange: "TSX",
    isQuotable: true,
    isTradable: true,
    currency: "CAD",
  },
  {
    symbol: "XFN.TO",
    symbolId: 2003,
    description: "ISHARES S&P TSX CAPPED FINANCIALS INDEX ETF",
    securityType: "ETF",
    listingExchange: "TSX",
    isQuotable: true,
    isTradable: true,
    currency: "CAD",
  },
  {
    symbol: "XTL.TO",
    symbolId: 2004,
    description: "ISHARES S&P TSX CAPPED TELECOM INDEX ETF",
    securityType: "ETF",
    listingExchange: "TSX",
    isQuotable: true,
    isTradable: true,
    currency: "CAD",
  },
  {
    symbol: "AAPL",
    symbolId: 3001,
    description: "APPLE INC",
    securityType: "Stock",
    listingExchange: "NASDAQ",
    isQuotable: true,
    isTradable: true,
    currency: "USD",
  },
  {
    symbol: "NVDA",
    symbolId: 3002,
    description: "NVIDIA CORP",
    securityType: "Stock",
    listingExchange: "NASDAQ",
    isQuotable: true,
    isTradable: true,
    currency: "USD",
  },
  {
    symbol: "SPY",
    symbolId: 3101,
    description: "SPDR S&P 500 ETF TRUST",
    securityType: "ETF",
    listingExchange: "NYSE_ARCA",
    isQuotable: true,
    isTradable: true,
    currency: "USD",
  },
  {
    symbol: "XLK",
    symbolId: 3102,
    description: "TECHNOLOGY SELECT SECTOR SPDR FUND",
    securityType: "ETF",
    listingExchange: "NYSE_ARCA",
    isQuotable: true,
    isTradable: true,
    currency: "USD",
  },
];

const MOCK_QUOTES: RawQuote[] = [
  {
    symbol: "BTO.TO",
    symbolId: 1001,
    bidPrice: 7.82,
    bidSize: 8_500,
    askPrice: 7.83,
    askSize: 7_200,
    lastTradePrice: 7.83,
    lastTradeSize: 1_100,
    volume: 1_845_300,
    openPrice: 7.74,
    highPrice: 7.87,
    lowPrice: 7.71,
    delay: 0,
    isHalted: false,
  },
  {
    symbol: "BAM.TO",
    symbolId: 1002,
    bidPrice: 72.8,
    bidSize: 1_300,
    askPrice: 72.82,
    askSize: 900,
    lastTradePrice: 72.81,
    lastTradeSize: 200,
    volume: 428_700,
    openPrice: 72.15,
    highPrice: 73.02,
    lowPrice: 72.08,
    delay: false,
    isHalted: false,
  },
  {
    symbol: "QBR.B.TO",
    symbolId: 1003,
    bidPrice: 35.42,
    bidSize: 600,
    askPrice: 35.44,
    askSize: 800,
    lastTradePrice: 35.44,
    lastTradeSize: 100,
    volume: 116_900,
    openPrice: 35.21,
    highPrice: 35.49,
    lowPrice: 35.18,
    delay: 15,
    isHalted: false,
  },
  {
    symbol: "XIU.TO",
    symbolId: 2001,
    bidPrice: 41.99,
    bidSize: 5000,
    askPrice: 42.01,
    askSize: 5000,
    lastTradePrice: 42,
    lastTradeSize: 500,
    volume: 2_000_000,
    openPrice: 41.8,
    highPrice: 42.1,
    lowPrice: 41.7,
    delay: 0,
    isHalted: false,
  },
  {
    symbol: "XMA.TO",
    symbolId: 2002,
    bidPrice: 20.09,
    bidSize: 2500,
    askPrice: 20.11,
    askSize: 2500,
    lastTradePrice: 20.1,
    lastTradeSize: 200,
    volume: 500_000,
    openPrice: 20,
    highPrice: 20.2,
    lowPrice: 19.9,
    delay: 0,
    isHalted: false,
  },
  {
    symbol: "XFN.TO",
    symbolId: 2003,
    bidPrice: 58.19,
    bidSize: 2500,
    askPrice: 58.21,
    askSize: 2500,
    lastTradePrice: 58.2,
    lastTradeSize: 200,
    volume: 600_000,
    openPrice: 58,
    highPrice: 58.4,
    lowPrice: 57.9,
    delay: 0,
    isHalted: false,
  },
  {
    symbol: "XTL.TO",
    symbolId: 2004,
    bidPrice: 34.04,
    bidSize: 2500,
    askPrice: 34.06,
    askSize: 2500,
    lastTradePrice: 34.05,
    lastTradeSize: 200,
    volume: 300_000,
    openPrice: 34,
    highPrice: 34.1,
    lowPrice: 33.9,
    delay: 0,
    isHalted: false,
  },
  {
    symbol: "AAPL",
    symbolId: 3001,
    bidPrice: 225.1,
    bidSize: 1200,
    askPrice: 225.12,
    askSize: 1000,
    lastTradePrice: 225.11,
    lastTradeSize: 100,
    volume: 8_000_000,
    openPrice: 223,
    highPrice: 226,
    lowPrice: 222.5,
    delay: 0,
    isHalted: false,
  },
  {
    symbol: "NVDA",
    symbolId: 3002,
    bidPrice: 130.2,
    bidSize: 1800,
    askPrice: 130.22,
    askSize: 1600,
    lastTradePrice: 130.21,
    lastTradeSize: 100,
    volume: 12_000_000,
    openPrice: 128.5,
    highPrice: 131,
    lowPrice: 128,
    delay: 0,
    isHalted: false,
  },
  {
    symbol: "SPY",
    symbolId: 3101,
    bidPrice: 580.1,
    bidSize: 5000,
    askPrice: 580.12,
    askSize: 5000,
    lastTradePrice: 580.11,
    lastTradeSize: 100,
    volume: 20_000_000,
    openPrice: 578,
    highPrice: 581,
    lowPrice: 577.5,
    delay: 0,
    isHalted: false,
  },
  {
    symbol: "XLK",
    symbolId: 3102,
    bidPrice: 230.1,
    bidSize: 2500,
    askPrice: 230.12,
    askSize: 2500,
    lastTradePrice: 230.11,
    lastTradeSize: 100,
    volume: 2_000_000,
    openPrice: 228,
    highPrice: 231,
    lowPrice: 227.5,
    delay: 0,
    isHalted: false,
  },
];

const BASE_PRICES = new Map([
  [1001, 7.74],
  [1002, 72.15],
  [1003, 35.21],
  [2001, 41.8],
  [2002, 20],
  [2003, 58],
  [2004, 34],
  [3001, 223],
  [3002, 128.5],
  [3101, 578],
  [3102, 228],
]);

const TARGET_PRICES = new Map(
  MOCK_QUOTES.map((quote) => [quote.symbolId, quote.lastTradePrice]),
);
const TARGET_VOLUMES = new Map(
  MOCK_QUOTES.map((quote) => [quote.symbolId, quote.volume]),
);
const DAILY_BASE_VOLUMES = new Map([
  [1001, 3_200_000],
  [1002, 650_000],
  [1003, 600_000],
  [2001, 5_000_000],
  [2002, 800_000],
  [2003, 1_200_000],
  [2004, 500_000],
  [3001, 15_000_000],
  [3002, 22_000_000],
  [3101, 45_000_000],
  [3102, 4_000_000],
]);

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildOneMinuteCandles(symbolId: number): RawCandle[] {
  const base = BASE_PRICES.get(symbolId);
  const target = TARGET_PRICES.get(symbolId);
  const targetVolume = TARGET_VOLUMES.get(symbolId);
  if (base === undefined || target === undefined || targetVolume === undefined)
    return [];

  const sessionStart = Date.parse("2026-08-24T13:30:00.000Z");
  const candles: RawCandle[] = [];
  let previousClose = base;
  let allocatedVolume = 0;
  const volumeWeightTotal = Array.from(
    { length: 30 },
    (_, minute) => 100 + minute,
  ).reduce((total, weight) => total + weight, 0);

  for (let minute = 0; minute < 30; minute += 1) {
    const open = previousClose;
    const progress = (minute + 1) / 30;
    const noise =
      Math.sin(progress * Math.PI * 6) * Math.max(0.01, base * 0.0005);
    const close =
      minute === 29 ? target : round(base + (target - base) * progress + noise);
    const wick = Math.max(0.01, round(base * 0.00025));
    const start = new Date(sessionStart + minute * 60_000);
    const end = new Date(start.getTime() + 60_000);
    const volume =
      minute === 29
        ? targetVolume - allocatedVolume
        : Math.floor((targetVolume * (100 + minute)) / volumeWeightTotal);

    candles.push({
      start: start.toISOString(),
      end: end.toISOString(),
      open: round(open),
      high: round(Math.max(open, close) + wick),
      low: round(Math.min(open, close) - wick),
      close,
      volume,
    });
    previousClose = close;
    allocatedVolume += volume;
  }

  return candles;
}

function priorWeekdays(count: number): Date[] {
  const result: Date[] = [];
  const cursor = new Date("2026-08-24T13:30:00.000Z");
  while (result.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) result.push(new Date(cursor));
  }
  return result.reverse();
}

function buildHistoricalOneMinuteCandles(symbolId: number): RawCandle[] {
  const base = BASE_PRICES.get(symbolId);
  const targetVolume = TARGET_VOLUMES.get(symbolId);
  if (base === undefined || targetVolume === undefined) return [];

  return priorWeekdays(10).flatMap((sessionStart, index) => {
    const sessionBase = base * (0.96 + index * 0.003);
    const sessionTarget = sessionBase * (1 + ((index % 3) - 1) * 0.002);
    const sessionVolume = Math.floor(targetVolume * (0.48 + index * 0.025));
    return buildSyntheticMinuteSession(
      symbolId,
      sessionStart,
      sessionBase,
      sessionTarget,
      sessionVolume,
    );
  });
}

function buildSyntheticMinuteSession(
  symbolId: number,
  sessionStart: Date,
  base: number,
  target: number,
  targetVolume: number,
): RawCandle[] {
  const candles: RawCandle[] = [];
  let previousClose = round(base);
  let allocatedVolume = 0;
  const volumeWeightTotal = Array.from(
    { length: 30 },
    (_, minute) => 100 + minute,
  ).reduce((total, weight) => total + weight, 0);
  for (let minute = 0; minute < 30; minute += 1) {
    const open = previousClose;
    const progress = (minute + 1) / 30;
    const noise =
      Math.sin(progress * Math.PI * 4 + symbolId) *
      Math.max(0.01, base * 0.0005);
    const close =
      minute === 29
        ? round(target)
        : round(base + (target - base) * progress + noise);
    const wick = Math.max(0.01, round(base * 0.00025));
    const start = new Date(sessionStart.getTime() + minute * 60_000);
    const end = new Date(start.getTime() + 60_000);
    const volume =
      minute === 29
        ? targetVolume - allocatedVolume
        : Math.floor((targetVolume * (100 + minute)) / volumeWeightTotal);
    candles.push({
      start: start.toISOString(),
      end: end.toISOString(),
      open,
      high: round(Math.max(open, close) + wick),
      low: round(Math.min(open, close) - wick),
      close,
      volume,
    });
    previousClose = close;
    allocatedVolume += volume;
  }
  return candles;
}

function buildDailyCandles(symbolId: number): RawCandle[] {
  const base = BASE_PRICES.get(symbolId);
  const baseVolume = DAILY_BASE_VOLUMES.get(symbolId);
  if (base === undefined || baseVolume === undefined) return [];
  let previousClose = base * 0.9;
  return priorWeekdays(30).map((start, index) => {
    const drift = base * (0.9 + index * 0.003);
    const open = round((previousClose + drift) / 2);
    const range = Math.max(0.08, base * (0.014 + (index % 4) * 0.002));
    const close = round(open + ((index % 5) - 1.5) * range * 0.15);
    const candle = {
      start: start.toISOString(),
      end: new Date(start.getTime() + 6.5 * 60 * 60_000).toISOString(),
      open,
      high: round(Math.max(open, close) + range),
      low: round(Math.min(open, close) - range),
      close,
      volume: Math.floor(baseVolume * (0.86 + index * 0.01)),
    };
    previousClose = close;
    return candle;
  });
}

function aggregateFiveMinutes(oneMinuteCandles: RawCandle[]): RawCandle[] {
  const result: RawCandle[] = [];
  for (let index = 0; index < oneMinuteCandles.length; index += 5) {
    const group = oneMinuteCandles.slice(index, index + 5);
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last || group.length < 5) continue;

    result.push({
      start: first.start,
      end: last.end,
      open: first.open,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      close: last.close,
      volume: group.reduce((total, candle) => total + candle.volume, 0),
    });
  }
  return result;
}

export class MockQuestradeTransport
  implements TokenTransport, QuestradeTransport
{
  readonly apiServersSeen: string[] = [];
  readonly quoteBatches: number[][] = [];
  authCallCount = 0;

  // A fresh mock process accepts the persisted generation once, then enforces
  // strict single-use rotation for the rest of that process lifetime.
  private validRefreshToken: string | undefined;
  private readonly redeemedRefreshTokens = new Set<string>();
  private validAccessToken = "";
  private apiServer = "";

  async redeemRefreshToken(refreshToken: string): Promise<RawTokenGrant> {
    const match = /^mock-refresh-token-(\d+)$/.exec(refreshToken);
    if (
      !match ||
      this.redeemedRefreshTokens.has(refreshToken) ||
      (this.validRefreshToken !== undefined &&
        refreshToken !== this.validRefreshToken)
    ) {
      throw new Error("Mock refresh token was already redeemed or is invalid");
    }

    this.redeemedRefreshTokens.add(refreshToken);
    this.authCallCount += 1;
    const generation = Number(match[1]) + 1;
    this.validRefreshToken = `mock-refresh-token-${generation}`;
    this.validAccessToken = `mock-access-token-${generation}`;
    this.apiServer = `https://mock-api0${(generation % 2) + 1}.iq.questrade.test/`;

    return {
      access_token: this.validAccessToken,
      refresh_token: this.validRefreshToken,
      token_type: "Bearer",
      expires_in: 1_800,
      api_server: this.apiServer,
    };
  }

  async searchSymbols(
    apiServer: URL,
    accessToken: string,
    prefix: string,
  ): Promise<RawSymbol[]> {
    this.verifySession(apiServer, accessToken);
    const query = prefix.toUpperCase();
    return MOCK_SYMBOLS.filter(
      (symbol) =>
        symbol.symbol.toUpperCase().startsWith(query) ||
        symbol.description.includes(query),
    );
  }

  async getSymbolDetails(
    apiServer: URL,
    accessToken: string,
    symbolIds: number[],
  ): Promise<RawSymbolDetail[]> {
    this.verifySession(apiServer, accessToken);
    const requested = new Set(symbolIds);
    const details = new Map<
      number,
      Omit<RawSymbolDetail, "symbol" | "symbolId">
    >([
      [1001, { marketCap: 14_000_000_000, industrySector: "Basic Materials" }],
      [
        1002,
        { marketCap: 103_000_000_000, industrySector: "Financial Services" },
      ],
      [
        1003,
        { marketCap: 8_200_000_000, industrySector: "Communication Services" },
      ],
      [2001, { marketCap: null, industrySector: null }],
      [2002, { marketCap: null, industrySector: "Basic Materials" }],
      [2003, { marketCap: null, industrySector: "Financial Services" }],
      [2004, { marketCap: null, industrySector: "Communication Services" }],
      [3001, { marketCap: 3_000_000_000_000, industrySector: "Technology" }],
      [3002, { marketCap: 3_000_000_000_000, industrySector: "Technology" }],
      [3101, { marketCap: null, industrySector: null }],
      [3102, { marketCap: null, industrySector: "Technology" }],
    ]);
    return MOCK_SYMBOLS.filter((symbol) => requested.has(symbol.symbolId)).map(
      (symbol) => ({
        symbol: symbol.symbol,
        symbolId: symbol.symbolId,
        marketCap: details.get(symbol.symbolId)?.marketCap ?? null,
        industrySector: details.get(symbol.symbolId)?.industrySector ?? null,
      }),
    );
  }

  async getQuotes(
    apiServer: URL,
    accessToken: string,
    symbolIds: number[],
  ): Promise<RawQuote[]> {
    this.verifySession(apiServer, accessToken);
    this.quoteBatches.push([...symbolIds]);
    const requested = new Set(symbolIds);
    return MOCK_QUOTES.filter((quote) => requested.has(quote.symbolId));
  }

  async getCandles(
    apiServer: URL,
    accessToken: string,
    symbolId: number,
    interval: CandleInterval,
    range: CandleRange,
  ): Promise<RawCandle[]> {
    this.verifySession(apiServer, accessToken);
    const oneMinute = [
      ...buildHistoricalOneMinuteCandles(symbolId),
      ...buildOneMinuteCandles(symbolId),
    ];
    const candles =
      interval === "OneDay"
        ? buildDailyCandles(symbolId)
        : interval === "OneMinute"
          ? oneMinute
          : aggregateFiveMinutes(oneMinute);
    return candles.filter(
      (candle) =>
        new Date(candle.start) >= range.startTime &&
        new Date(candle.end) <= range.endTime,
    );
  }

  async getMarkets(apiServer: URL, accessToken: string): Promise<RawMarket[]> {
    this.verifySession(apiServer, accessToken);
    return [
      {
        name: "TSX",
        tradingVenues: ["TSX", "ALPH", "CHIC", "OMGA", "PURE"],
        defaultTradingVenue: "AUTO",
        extendedStartTime: "2026-08-24T11:00:00.000Z",
        startTime: "2026-08-24T13:30:00.000Z",
        endTime: "2026-08-24T20:00:00.000Z",
        extendedEndTime: "2026-08-24T21:00:00.000Z",
        currency: "CAD",
        snapQuotesLimit: 99_999,
      },
      {
        name: "US",
        tradingVenues: ["NASDAQ", "NYSE", "NYSE_ARCA"],
        defaultTradingVenue: "AUTO",
        extendedStartTime: "2026-08-24T11:00:00.000Z",
        startTime: "2026-08-24T13:30:00.000Z",
        endTime: "2026-08-24T20:00:00.000Z",
        extendedEndTime: "2026-08-24T21:00:00.000Z",
        currency: "USD",
        snapQuotesLimit: 99_999,
      },
    ];
  }

  private verifySession(apiServer: URL, accessToken: string): void {
    if (
      accessToken !== this.validAccessToken ||
      apiServer.href !== this.apiServer
    ) {
      throw new Error(
        "Mock request did not use the current access token and dynamic API server",
      );
    }
    this.apiServersSeen.push(apiServer.href);
  }
}
