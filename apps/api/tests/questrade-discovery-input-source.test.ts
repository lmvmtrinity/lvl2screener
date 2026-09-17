import { describe, expect, it, vi } from "vitest";
import { discoveryEvaluationInputSchema } from "@tsx-scanner/contracts";
import {
  DiscoverySymbolMapper,
  type DiscoveryMappingStore,
  type MappingDecision,
} from "../src/universe/discovery-mapping.js";
import {
  normalizeMassiveTickers,
  parseMassiveCatalog,
} from "../src/universe/massive-catalog.js";
import { getRecentRegularSessions } from "../src/universe/market-calendar.js";
import { QuestradeDiscoveryInputSource } from "../src/universe/questrade-discovery-input-source.js";
import { DiscoveryAttemptDiagnosticsCollector } from "../src/universe/discovery-attempt-diagnostics.js";
import type {
  Candle,
  Instrument,
  InstrumentFundamentals,
  MarketDataAdapter,
  Quote,
  MarketDataRequestOptions,
} from "../src/questrade/types.js";

// 2026-09-11T15:30:00Z is 11:30 America/New_York during a regular US session.
const NOW = new Date("2026-09-11T15:30:00.000Z");
const TRADING_DATE = "2026-09-11";
const COMPLETED_BAR_END = "2026-09-11T15:30:00.000Z";
const MARKET_START = new Date("2026-09-11T13:30:00.000Z");
const MARKET_END = new Date("2026-09-11T20:00:00.000Z");
const SYMBOL_ID = 42;
const SECOND_SYMBOL_ID = 43;

const instrument: Instrument = {
  symbol: "AAL",
  symbolId: SYMBOL_ID,
  description: "American Airlines Group Inc.",
  securityType: "Stock",
  exchange: "NASDAQ",
  currency: "USD",
  isQuotable: true,
  isTradable: true,
};

const secondInstrument: Instrument = {
  ...instrument,
  symbol: "ALGT",
  symbolId: SECOND_SYMBOL_ID,
  description: "Allegiant Travel Company",
};

const member = () =>
  parseMassiveCatalog(
    normalizeMassiveTickers(
      [
        {
          ticker: "AAL",
          name: "American Airlines Group Inc.",
          primary_exchange: "XNAS",
          type: "CS",
          currency_name: "usd",
          cik: "0000006201",
          composite_figi: "BBG005P7Q881",
          share_class_figi: "BBG001S5N8V8",
        },
      ],
      { retrievedAt: NOW.toISOString(), responseDigest: "a".repeat(64) },
    ),
    "US_EQUITIES",
  )[0]!;

const secondMember = parseMassiveCatalog(
  normalizeMassiveTickers(
    [
      {
        ticker: "ALGT",
        name: "Allegiant Travel Company",
        primary_exchange: "XNAS",
        type: "CS",
        currency_name: "usd",
        cik: "0001579241",
        composite_figi: "BBG000BMSRR0",
        share_class_figi: "BBG001S5N6F3",
      },
    ],
    { retrievedAt: NOW.toISOString(), responseDigest: "b".repeat(64) },
  ),
  "US_EQUITIES",
)[0]!;

function candle(
  interval: "OneDay" | "FiveMinutes",
  startMs: number,
  endMs: number,
): Candle {
  return {
    symbolId: SYMBOL_ID,
    interval,
    start: new Date(startMs),
    end: new Date(endMs),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10_000,
    source: "QUESTRADE",
    isComplete: endMs <= NOW.getTime(),
  };
}

function slotRangeSessions() {
  return getRecentRegularSessions("US_EQUITIES", TRADING_DATE, 110).filter(
    (session) =>
      Date.parse(session.open) >= NOW.getTime() - 21 * 86_400_000 &&
      Date.parse(session.open) <= NOW.getTime(),
  );
}

const dailyCandles = getRecentRegularSessions("US_EQUITIES", TRADING_DATE, 110)
  .filter((session) => session.tradingDate < TRADING_DATE)
  .map((session) =>
    candle("OneDay", Date.parse(session.open), Date.parse(session.close)),
  );

// Questrade also returns extended-hours bars. With roughly 15 sessions in the
// 21-day slot window this fixture is well over the 2,000-bar contract cap.
const fiveMinuteCandles = slotRangeSessions().flatMap((session) => {
  const open = Date.parse(session.open);
  const close = Date.parse(session.close);
  const bars: Candle[] = [];
  for (
    let start = open - 4 * 3_600_000;
    start < close + 4 * 3_600_000;
    start += 300_000
  )
    bars.push(candle("FiveMinutes", start, start + 300_000));
  return bars;
});

const quote: Quote = {
  symbol: "AAL",
  symbolId: SYMBOL_ID,
  bid: 99.9,
  bidSize: 100,
  ask: 100.1,
  askSize: 100,
  last: 100,
  lastSize: 100,
  volume: 1_000_000,
  dayOpen: 99,
  dayHigh: 101,
  dayLow: 98,
  mid: 100,
  spreadAbsolute: 0.2,
  spreadPct: 0.2,
  delaySeconds: null,
  isDelayed: false,
  isHalted: false,
  dataStatus: "REALTIME",
  actionable: true,
  receivedAt: new Date(NOW.getTime() - 5_000),
  lastTradeAt: new Date(NOW.getTime() - 5_000),
  source: "QUESTRADE",
};

function source(adapterOverride?: MarketDataAdapter) {
  const adapter =
    adapterOverride ??
    ({
      searchSymbols: async () => [instrument],
      getFundamentals: async (): Promise<InstrumentFundamentals[]> => [
        {
          symbol: "AAL",
          symbolId: SYMBOL_ID,
          marketCap: 1_000_000_000,
          sector: "Industrials",
        },
      ],
      getQuotes: async () => [quote],
      getCandles: async (
        _symbolId: number,
        interval: "OneDay" | "FiveMinutes",
      ) => (interval === "OneDay" ? dailyCandles : fiveMinuteCandles),
    } as unknown as MarketDataAdapter);
  const store: DiscoveryMappingStore = {
    load: async () => null,
    save: async () => {},
  };
  return new QuestradeDiscoveryInputSource(
    adapter,
    new DiscoverySymbolMapper(adapter, store, () => NOW),
    "US_EQUITIES",
    {
      getMarket: () => ({ startTime: MARKET_START, endTime: MARKET_END }),
      getSnapshot: () => ({ observedAt: NOW }),
    },
    () => NOW,
  );
}

describe("questrade discovery input source", () => {
  it("counts shared mapping wait for both members and distinct enrichment IDs once", async () => {
    let monotonic = 0;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mappingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const inputSource = source({
      searchSymbols: async () => {
        started();
        await gate;
        return [instrument];
      },
      getFundamentals: async () => [],
      getQuotes: async () => [],
    } as unknown as MarketDataAdapter);
    const diagnostics = new DiscoveryAttemptDiagnosticsCollector(
      {
        attemptId: "shared-mapping-attempt",
        attemptKind: "FRESH",
        marketId: "US_EQUITIES",
        startedAt: NOW,
        collectionDeadlineAt: new Date(NOW.getTime() + 120_000),
      },
      () => monotonic,
    );
    const context = {
      attemptId: "shared-mapping-attempt",
      diagnostics,
      marketId: "US_EQUITIES" as const,
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
    };
    const builds = [
      inputSource.build(member(), context),
      inputSource.build(member(), context),
    ];
    await mappingStarted;
    monotonic = 40;
    release();
    await Promise.all(builds);
    expect(diagnostics.snapshot().stages).toMatchObject({
      MAPPING: { wallMs: 40, cumulativeMs: 80 },
      ENRICHMENT: { batches: { count: 1, members: 2, uniqueSymbols: 1 } },
    });
  });
  it("attributes cold, partial and warm candle caches to their own attempts", async () => {
    let cachedMapping: MappingDecision | null = null;
    const calls: Array<{ interval: string; attemptId?: string }> = [];
    const adapter = {
      searchSymbols: async () => [instrument],
      getFundamentals: async () => [
        {
          symbol: "AAL",
          symbolId: SYMBOL_ID,
          marketCap: 1_000_000_000,
          sector: "Industrials",
        },
      ],
      getQuotes: async () => [quote],
      getCandles: async (
        _id: number,
        interval: "OneDay" | "FiveMinutes",
        range: { startTime: Date; endTime: Date },
        options?: MarketDataRequestOptions,
      ) => {
        calls.push({ interval, attemptId: options?.observation?.attemptId });
        return interval === "OneDay"
          ? [
              candle(
                interval,
                range.startTime.getTime(),
                range.startTime.getTime() + 86_400_000,
              ),
              ...dailyCandles,
              candle(
                interval,
                range.endTime.getTime() - 300_000,
                range.endTime.getTime(),
              ),
            ]
          : [
              candle(
                interval,
                range.startTime.getTime(),
                range.endTime.getTime(),
              ),
            ];
      },
    } as unknown as MarketDataAdapter;
    const inputSource = new QuestradeDiscoveryInputSource(
      adapter,
      new DiscoverySymbolMapper(
        adapter,
        {
          load: async () => cachedMapping,
          save: async (value) => {
            cachedMapping = value;
          },
        },
        () => NOW,
      ),
      "US_EQUITIES",
      {
        getMarket: () => ({ startTime: MARKET_START, endTime: MARKET_END }),
        getSnapshot: () => ({ observedAt: NOW }),
      },
      () => NOW,
    );
    const snapshots = [];
    for (let index = 0; index < 3; index++) {
      const attemptId = `cache-attempt-${index}`;
      const diagnostics = new DiscoveryAttemptDiagnosticsCollector({
        attemptId,
        attemptKind: "FRESH",
        marketId: "US_EQUITIES",
        startedAt: NOW,
        collectionDeadlineAt: new Date(NOW.getTime() + 120_000),
      });
      const prepared = await inputSource.build(member(), {
        attemptId,
        diagnostics,
        marketId: "US_EQUITIES",
        tradingDate: TRADING_DATE,
        evaluationAt: new Date(
          NOW.getTime() + (index > 0 ? 1000 : 0),
        ).toISOString(),
        completedBarEnd: COMPLETED_BAR_END,
        evaluationAtFrozen: false,
      });
      expect(prepared.input?.adjustment.verified).toBe(false);
      snapshots.push(diagnostics.finish());
    }
    expect(snapshots[0]?.stages).toMatchObject({
      MAPPING: { cache: { miss: 1 } },
      DAILY_HISTORY: { cache: { miss: 1 }, loadedBars: 111 },
      SLOT_HISTORY: { cache: { miss: 1 }, loadedBars: 1 },
    });
    expect(snapshots[1]?.stages).toMatchObject({
      MAPPING: { cache: { hit: 1 } },
      DAILY_HISTORY: { cache: { partialHit: 1 } },
      SLOT_HISTORY: { cache: { partialHit: 1 } },
    });
    expect(snapshots[2]?.stages).toMatchObject({
      MAPPING: { cache: { hit: 1 } },
      DAILY_HISTORY: { cache: { hit: 1 }, loadedBars: 0 },
      SLOT_HISTORY: { cache: { hit: 1 }, loadedBars: 0 },
    });
    expect(calls).toEqual([
      { interval: "OneDay", attemptId: "cache-attempt-0" },
      { interval: "FiveMinutes", attemptId: "cache-attempt-0" },
      { interval: "OneDay", attemptId: "cache-attempt-1" },
      { interval: "FiveMinutes", attemptId: "cache-attempt-1" },
    ]);
  });
  it("never coalesces enrichment across attempts with an equal deadline", async () => {
    const requests: Array<{ ids: number[]; attemptId?: string }> = [];
    const inputSource = source({
      searchSymbols: async (prefix: string) =>
        prefix === "AAL" ? [instrument] : [secondInstrument],
      getFundamentals: async () => [],
      getQuotes: async (ids: number[], options?: MarketDataRequestOptions) => {
        requests.push({ ids, attemptId: options?.observation?.attemptId });
        return [];
      },
    } as unknown as MarketDataAdapter);
    const context = {
      marketId: "US_EQUITIES" as const,
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      deadlineAt: new Date(NOW.getTime() + 120_000),
    };
    await Promise.all([
      inputSource.build(member(), { ...context, attemptId: "attempt-one" }),
      inputSource.build(secondMember, { ...context, attemptId: "attempt-two" }),
    ]);
    expect(requests).toEqual([
      { ids: [SYMBOL_ID], attemptId: "attempt-one" },
      { ids: [SECOND_SYMBOL_ID], attemptId: "attempt-two" },
    ]);
  });
  it("keeps slotBars inside regular sessions and within the contract cap", async () => {
    const slotStart = NOW.getTime() - 21 * 86_400_000;
    expect(
      fiveMinuteCandles.filter(
        (bar) =>
          bar.start.getTime() >= slotStart &&
          bar.start.getTime() < NOW.getTime(),
      ).length,
    ).toBeGreaterThan(2_000);

    const prepared = await source().build(member(), {
      marketId: "US_EQUITIES",
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      evaluationAtFrozen: false,
    });

    expect(prepared).toMatchObject({ symbolId: SYMBOL_ID, reasons: [] });
    const input = discoveryEvaluationInputSchema.parse(prepared.input);
    expect(input.slotBars.length).toBeGreaterThan(0);
    expect(input.slotBars.length).toBeLessThanOrEqual(2_000);

    const bounds = getRecentRegularSessions(
      "US_EQUITIES",
      TRADING_DATE,
      110,
    ).map((session) => ({
      open: Date.parse(session.open),
      close: Date.parse(session.close),
    }));
    for (const bar of input.slotBars) {
      const start = Date.parse(bar.start);
      const end = Date.parse(bar.end);
      expect(
        bounds.some((bound) => start >= bound.open && end <= bound.close),
      ).toBe(true);
    }

    // The evaluator compares one slot per prior session; those slots must survive
    // the regular-session filter.
    const offset =
      Date.parse(COMPLETED_BAR_END) - Date.parse(MARKET_START.toISOString());
    const requiredStarts = getRecentRegularSessions(
      "US_EQUITIES",
      TRADING_DATE,
      110,
    )
      .slice(-11)
      .map((session) => Date.parse(session.open) + offset - 300_000);
    const starts = new Set(input.slotBars.map((bar) => Date.parse(bar.start)));
    for (const start of requiredStarts) expect(starts.has(start)).toBe(true);
  });

  it("batches concurrent enrichment while preserving a missing quote as a per-symbol outcome", async () => {
    const fundamentals = vi.fn(async (ids: number[]) =>
      ids.map((symbolId) => ({
        symbol: symbolId === SYMBOL_ID ? "AAL" : "ALGT",
        symbolId,
        marketCap: 1_000_000_000,
        sector: "Industrials",
      })),
    );
    const quotes = vi.fn(async () => [quote]);
    const adapter = {
      searchSymbols: async (prefix: string) =>
        prefix === "AAL" ? [instrument] : [secondInstrument],
      getFundamentals: fundamentals,
      getQuotes: quotes,
      getCandles: async (
        _symbolId: number,
        interval: "OneDay" | "FiveMinutes",
      ) => (interval === "OneDay" ? dailyCandles : fiveMinuteCandles),
    } as unknown as MarketDataAdapter;
    const context = {
      marketId: "US_EQUITIES" as const,
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      evaluationAtFrozen: false,
    };

    const inputSource = source(adapter);
    const [first, second] = await Promise.all([
      inputSource.build(member(), context),
      inputSource.build(secondMember, context),
    ]);

    expect(fundamentals).toHaveBeenCalledOnce();
    expect(fundamentals).toHaveBeenCalledWith(
      [SYMBOL_ID, secondInstrument.symbolId],
      undefined,
    );
    expect(quotes).toHaveBeenCalledOnce();
    expect(quotes).toHaveBeenCalledWith(
      [SYMBOL_ID, secondInstrument.symbolId],
      undefined,
    );
    expect(first).toMatchObject({ symbolId: SYMBOL_ID, reasons: [] });
    expect(second).toEqual({
      input: null,
      symbolId: secondInstrument.symbolId,
      reasons: ["QUOTE_UNAVAILABLE"],
    });
  });

  it("splits 51 concurrent enrichments at the application batch size", async () => {
    const fixture = Array.from({ length: 51 }, (_, index) => {
      const code = `S${String(index).padStart(3, "0")}`;
      return {
        code,
        instrument: { ...instrument, symbol: code, symbolId: 100 + index },
        ticker: {
          ticker: code,
          name: `Symbol ${index}`,
          primary_exchange: "XNAS",
          type: "CS" as const,
          currency_name: "usd",
          cik: "0001579241",
          composite_figi: "BBG000BMSRR0",
          share_class_figi: "BBG001S5N6F3",
        },
      };
    });
    const members = parseMassiveCatalog(
      normalizeMassiveTickers(
        fixture.map((value) => value.ticker),
        { retrievedAt: NOW.toISOString(), responseDigest: "d".repeat(64) },
      ),
      "US_EQUITIES",
    );
    const instruments = new Map(
      fixture.map((value) => [value.code, value.instrument]),
    );
    let searched = 0;
    let releaseSearch!: () => void;
    const searchesReleased = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const fundamentals = vi.fn(async (ids: number[]) =>
      ids.map((symbolId) => ({
        symbol: fixture.find((value) => value.instrument.symbolId === symbolId)!
          .code,
        symbolId,
        marketCap: 1_000_000_000,
        sector: "Industrials",
      })),
    );
    const quotes = vi.fn(async (_ids: number[]): Promise<Quote[]> => []);
    const getCandles = vi.fn(async () => {
      throw new Error("history must not be requested for an unavailable quote");
    });
    const adapter = {
      searchSymbols: async (prefix: string) => {
        searched++;
        await searchesReleased;
        return [instruments.get(prefix)!];
      },
      getFundamentals: fundamentals,
      getQuotes: quotes,
      getCandles,
    } as unknown as MarketDataAdapter;
    const context = {
      marketId: "US_EQUITIES" as const,
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      evaluationAtFrozen: false,
    };
    const inputSource = source(adapter);
    const preparing = members.map((candidate) =>
      inputSource.build(candidate, context),
    );

    await vi.waitFor(() => expect(searched).toBe(51));
    releaseSearch();
    const prepared = await Promise.all(preparing);

    expect(fundamentals.mock.calls.map(([ids]) => ids.length)).toEqual([50, 1]);
    expect(quotes.mock.calls.map(([ids]) => ids.length)).toEqual([50, 1]);
    expect(prepared).toHaveLength(51);
    for (const result of prepared)
      expect(result).toMatchObject({
        input: null,
        reasons: ["QUOTE_UNAVAILABLE"],
      });
    expect(getCandles).not.toHaveBeenCalled();
  });

  it("propagates a shared enrichment transport failure to each member", async () => {
    const failure = new Error("broker unavailable");
    const fundamentals = vi.fn(async () => {
      throw failure;
    });
    const quotes = vi.fn(async () => [quote]);
    const adapter = {
      searchSymbols: async (prefix: string) =>
        prefix === "AAL" ? [instrument] : [secondInstrument],
      getFundamentals: fundamentals,
      getQuotes: quotes,
      getCandles: vi.fn(async () => dailyCandles),
    } as unknown as MarketDataAdapter;
    const context = {
      marketId: "US_EQUITIES" as const,
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      evaluationAtFrozen: false,
    };
    const inputSource = source(adapter);

    const results = await Promise.allSettled([
      inputSource.build(member(), context),
      inputSource.build(secondMember, context),
    ]);

    expect(fundamentals).toHaveBeenCalledOnce();
    expect(quotes).toHaveBeenCalledOnce();
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
  });

  it("settles an aborted member without cancelling another member in its enrichment batch", async () => {
    let startEnrichment!: () => void;
    const enrichmentStarted = new Promise<void>((resolve) => {
      startEnrichment = resolve;
    });
    let finishFundamentals!: (value: InstrumentFundamentals[]) => void;
    const fundamentals = new Promise<InstrumentFundamentals[]>((resolve) => {
      finishFundamentals = resolve;
    });
    let finishQuotes!: (value: Quote[]) => void;
    const quotes = new Promise<Quote[]>((resolve) => {
      finishQuotes = resolve;
    });
    const fundamentalCalls = vi.fn(
      (_ids: number[], _options?: MarketDataRequestOptions) => {
        startEnrichment();
        return fundamentals;
      },
    );
    const quoteCalls = vi.fn(
      (_ids: number[], _options?: MarketDataRequestOptions) => quotes,
    );
    const adapter = {
      searchSymbols: async (prefix: string) =>
        prefix === "AAL" ? [instrument] : [secondInstrument],
      getFundamentals: fundamentalCalls,
      getQuotes: quoteCalls,
      getCandles: async (
        _symbolId: number,
        interval: "OneDay" | "FiveMinutes",
      ) => (interval === "OneDay" ? dailyCandles : fiveMinuteCandles),
    } as unknown as MarketDataAdapter;
    const cancelledController = new AbortController();
    const survivorController = new AbortController();
    const deadlineAt = new Date(NOW.getTime() + 120_000);
    const diagnostics = new DiscoveryAttemptDiagnosticsCollector({
      attemptId: "cancellation-attempt",
      attemptKind: "FRESH",
      marketId: "US_EQUITIES",
      startedAt: NOW,
      collectionDeadlineAt: deadlineAt,
    });
    const context = {
      attemptId: "cancellation-attempt",
      diagnostics,
      marketId: "US_EQUITIES" as const,
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      evaluationAtFrozen: false,
    };
    const inputSource = source(adapter);
    const cancelled = inputSource.build(member(), {
      ...context,
      signal: cancelledController.signal,
      deadlineAt,
    });
    const survivor = inputSource.build(secondMember, {
      ...context,
      signal: survivorController.signal,
      deadlineAt: new Date(deadlineAt),
    });
    let cancelledError: unknown;
    void cancelled.catch((error: unknown) => {
      cancelledError = error;
    });

    await enrichmentStarted;
    expect(fundamentalCalls).toHaveBeenCalledOnce();
    expect(quoteCalls).toHaveBeenCalledOnce();
    const compositeSignal = fundamentalCalls.mock.calls[0]?.[1]?.signal;
    expect(compositeSignal).toBeInstanceOf(AbortSignal);
    expect(quoteCalls.mock.calls[0]?.[1]?.signal).toBe(compositeSignal);
    expect(compositeSignal).not.toBe(cancelledController.signal);
    expect(compositeSignal).not.toBe(survivorController.signal);
    expect(fundamentalCalls.mock.calls[0]?.[1]?.observation).toEqual({
      attemptId: "cancellation-attempt",
      observer: diagnostics,
    });
    expect(quoteCalls.mock.calls[0]?.[1]?.observation).toEqual({
      attemptId: "cancellation-attempt",
      observer: diagnostics,
    });
    cancelledController.abort();
    try {
      await vi.waitFor(() => expect(cancelledError).toBeDefined());
      expect(compositeSignal?.aborted).toBe(false);
    } finally {
      finishFundamentals([
        {
          symbol: "AAL",
          symbolId: SYMBOL_ID,
          marketCap: 1_000_000_000,
          sector: "Industrials",
        },
        {
          symbol: "ALGT",
          symbolId: secondInstrument.symbolId,
          marketCap: 1_000_000_000,
          sector: "Industrials",
        },
      ]);
      finishQuotes([
        quote,
        { ...quote, symbol: "ALGT", symbolId: secondInstrument.symbolId },
      ]);
    }

    await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(survivor).resolves.toMatchObject({
      symbolId: secondInstrument.symbolId,
      reasons: [],
    });
    survivorController.abort();
    expect(compositeSignal?.aborted).toBe(false);
  });

  it("stops before requesting history when metadata finishes after its deadline", async () => {
    const controller = new AbortController();
    let finishFundamentals!: (value: InstrumentFundamentals[]) => void;
    let started!: () => void;
    const metadataStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fundamentals = new Promise<InstrumentFundamentals[]>((resolve) => {
      finishFundamentals = resolve;
    });
    const optionsSeen: unknown[] = [];
    const getCandles = vi.fn(async () => dailyCandles);
    const adapter = {
      searchSymbols: async () => [instrument],
      getFundamentals: (_ids: number[], options?: unknown) => {
        optionsSeen.push(options);
        started();
        return fundamentals;
      },
      getQuotes: async (_ids: number[], options?: unknown) => {
        optionsSeen.push(options);
        return [quote];
      },
      getCandles,
    } as unknown as MarketDataAdapter;
    const building = source(adapter).build(member(), {
      marketId: "US_EQUITIES",
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      evaluationAtFrozen: false,
      signal: controller.signal,
      deadlineAt: new Date(NOW.getTime() + 120_000),
    });

    await metadataStarted;
    controller.abort();
    finishFundamentals([
      {
        symbol: "AAL",
        symbolId: SYMBOL_ID,
        marketCap: 1_000_000_000,
        sector: "Industrials",
      },
    ]);

    await expect(building).rejects.toMatchObject({ code: "CANCELLED" });
    expect(optionsSeen).toHaveLength(2);
    expect(
      optionsSeen.every(
        (value) =>
          (value as { signal?: AbortSignal; expiresAt?: Date }).signal ===
          controller.signal,
      ),
    ).toBe(true);
    expect(getCandles).not.toHaveBeenCalled();
  });

  it("passes the fixed deadline into a cold mapping lookup", async () => {
    const controller = new AbortController();
    let finishSearch!: (value: Instrument[]) => void;
    let started!: () => void;
    const searchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const search = new Promise<Instrument[]>((resolve) => {
      finishSearch = resolve;
    });
    const searchOptions: unknown[] = [];
    const getFundamentals = vi.fn(async () => []);
    const adapter = {
      searchSymbols: (_prefix: string, options?: unknown) => {
        searchOptions.push(options);
        started();
        return search;
      },
      getFundamentals,
      getQuotes: vi.fn(async () => [quote]),
      getCandles: vi.fn(async () => dailyCandles),
    } as unknown as MarketDataAdapter;
    const deadlineAt = new Date(NOW.getTime() + 120_000);
    const building = source(adapter).build(member(), {
      marketId: "US_EQUITIES",
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      evaluationAtFrozen: false,
      signal: controller.signal,
      deadlineAt,
    });

    await searchStarted;
    expect(searchOptions[0]).toMatchObject({
      signal: controller.signal,
      expiresAt: deadlineAt,
    });
    controller.abort();
    finishSearch([instrument]);

    await expect(building).rejects.toMatchObject({ code: "CANCELLED" });
    expect(getFundamentals).not.toHaveBeenCalled();
  });

  it("does not request five-minute history after daily history returns late", async () => {
    const controller = new AbortController();
    let finishDaily!: (value: Candle[]) => void;
    let started!: () => void;
    const dailyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const daily = new Promise<Candle[]>((resolve) => {
      finishDaily = resolve;
    });
    const getCandles = vi.fn(
      async (_symbolId: number, interval: "OneDay" | "FiveMinutes") => {
        if (interval === "OneDay") {
          started();
          return daily;
        }
        return fiveMinuteCandles;
      },
    );
    const adapter = {
      searchSymbols: async () => [instrument],
      getFundamentals: async () => [
        {
          symbol: "AAL",
          symbolId: SYMBOL_ID,
          marketCap: 1_000_000_000,
          sector: "Industrials",
        },
      ],
      getQuotes: async () => [quote],
      getCandles,
    } as unknown as MarketDataAdapter;
    const building = source(adapter).build(member(), {
      marketId: "US_EQUITIES",
      tradingDate: TRADING_DATE,
      evaluationAt: NOW.toISOString(),
      completedBarEnd: COMPLETED_BAR_END,
      evaluationAtFrozen: false,
      signal: controller.signal,
      deadlineAt: new Date(NOW.getTime() + 120_000),
    });

    await dailyStarted;
    controller.abort();
    finishDaily(dailyCandles);

    await expect(building).rejects.toMatchObject({ code: "CANCELLED" });
    expect(getCandles).toHaveBeenCalledTimes(1);
    expect(getCandles).toHaveBeenCalledWith(
      SYMBOL_ID,
      "OneDay",
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
