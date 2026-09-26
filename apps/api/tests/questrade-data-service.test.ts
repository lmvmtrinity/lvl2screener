import { describe, expect, it, vi } from "vitest";
import { QuestradeCandleService } from "../src/market-data/candle-service.js";
import { QuestradeQuoteService } from "../src/market-data/quote-service.js";
import type {
  MarketDataRepository,
  PersistedInstrument,
} from "../src/market-data/repository.js";
import { QuestradeDataService } from "../src/market-data/service.js";
import { MarketSessionManager } from "../src/market-data/session-manager.js";
import { QuestradeAdapter } from "../src/questrade/adapter.js";
import { MockQuestradeTransport } from "../src/questrade/mock-transport.js";
import { QuestradeRateLimiter } from "../src/questrade/rate-limiter.js";
import { MockRequestBudget } from "../src/questrade/request-budget.js";
import { QuestradeHttpError } from "../src/questrade/live-transport.js";
import {
  InMemoryRefreshTokenStore,
  QuestradeReauthorizationRequiredError,
  QuestradeTokenManager,
} from "../src/questrade/token-manager.js";
import type {
  Candle,
  Instrument,
  MarketDataAdapter,
  Quote,
} from "../src/questrade/types.js";
import type {
  CandidatePasteReport,
  EngineResultBatch,
  MarketId,
  ScannerAlert,
  UniverseAutomation,
} from "@tsx-scanner/contracts";
import { DEFAULT_UNIVERSE_POLICY } from "../src/universe/universe-service.js";

class MemoryRepository implements MarketDataRepository {
  async markBenchmarks(): Promise<void> {}
  readonly instruments: PersistedInstrument[] = [];
  readonly quotes: Quote[] = [];
  readonly candles: Candle[] = [];

  async upsertInstruments(
    instruments: Instrument[],
  ): Promise<PersistedInstrument[]> {
    for (const instrument of instruments) {
      const existing = this.instruments.find(
        (candidate) => candidate.symbolId === instrument.symbolId,
      );
      if (existing) Object.assign(existing, instrument);
      else
        this.instruments.push({
          ...instrument,
          id: `instrument-${instrument.symbolId}`,
          active: true,
        });
    }
    return this.listActiveInstruments();
  }

  async listActiveInstruments(): Promise<PersistedInstrument[]> {
    return this.instruments.map((instrument) => ({ ...instrument }));
  }

  async saveQuotes(quotes: Quote[]): Promise<void> {
    this.quotes.push(...quotes);
  }

  async saveCandles(candles: Candle[]): Promise<void> {
    for (const candle of candles) {
      const index = this.candles.findIndex(
        (candidate) =>
          candidate.symbolId === candle.symbolId &&
          candidate.interval === candle.interval &&
          candidate.start.getTime() === candle.start.getTime(),
      );
      if (index >= 0) this.candles[index] = candle;
      else this.candles.push(candle);
    }
  }
}

class TestUniverseManager {
  constructor(
    private readonly adapter: MarketDataAdapter,
    private readonly repository: MarketDataRepository,
  ) {}

  async enrich(): Promise<PersistedInstrument[]> {
    const symbols = ["BTO.TO", "BAM.TO", "QBR.B.TO"];
    const instruments = await Promise.all(
      symbols.map(async (symbol) => {
        const matches = await this.adapter.searchSymbols(symbol);
        return matches.find((value) => value.symbol === symbol)!;
      }),
    );
    return this.repository.upsertInstruments(instruments);
  }

  getAutomation(): UniverseAutomation {
    const instruments = (this.repository as MemoryRepository).instruments;
    return {
      provider: "TEST",
      policy: DEFAULT_UNIVERSE_POLICY,
      latestRun: null,
      editable: true,
      configuredSymbols: ["BTO.TO", "BAM.TO", "QBR.B.TO"],
      members: instruments.map((value) => ({
        instrumentId: value.id,
        marketId: "CA_TSX" as const,
        symbol: value.symbol,
        description: value.description,
        exchange: value.exchange,
        normalizedExchange: "TSX" as const,
        rawExchange: value.exchange,
        currency: "CAD" as const,
        sector: null,
        eligible: true,
        reasons: [],
        price: null,
        marketCap: null,
        averageVolume20d: null,
        averageVolume90d: null,
        dollarVolume: null,
        atr14: null,
        atrPct: null,
        metricsAsOf: "2026-08-24T13:25:00.000Z",
      })),
    };
  }

  async updateCandidates(): Promise<CandidatePasteReport> {
    return {
      accepted: [
        {
          originalInput: "SHOP",
          normalizedSymbol: "SHOP.TO",
          reason: null,
        },
      ],
      normalized: [],
      duplicate: [],
      unsupported: [],
      failed: [],
    };
  }
}

/** Editable list whose edits go through the incremental path. */
class EditableTestUniverseManager extends TestUniverseManager {
  symbols = ["BTO.TO", "BAM.TO"];
  private listed = new Map<string, PersistedInstrument>();

  constructor(
    private readonly editAdapter: MarketDataAdapter,
    private readonly editRepository: MarketDataRepository,
  ) {
    super(editAdapter, editRepository);
  }

  override async enrich(): Promise<PersistedInstrument[]> {
    this.listed = new Map(
      (await this.resolve(this.symbols)).map((value) => [value.symbol, value]),
    );
    return [...this.listed.values()];
  }

  async replaceSymbols(symbols: string[]): Promise<void> {
    this.symbols = symbols;
  }

  async applyListEdit() {
    const added = this.symbols.filter((symbol) => !this.listed.has(symbol));
    const removed = [...this.listed.keys()].filter(
      (symbol) => !this.symbols.includes(symbol),
    );
    for (const symbol of removed) this.listed.delete(symbol);
    for (const instrument of await this.resolve(added))
      this.listed.set(instrument.symbol, instrument);
    return { instruments: [...this.listed.values()], added, removed };
  }

  private async resolve(symbols: string[]): Promise<PersistedInstrument[]> {
    if (!symbols.length) return [];
    const instruments = await Promise.all(
      symbols.map(async (symbol) => {
        const matches = await this.editAdapter.searchSymbols(symbol);
        return matches.find((value) => value.symbol === symbol)!;
      }),
    );
    const persisted = await this.editRepository.upsertInstruments(instruments);
    return persisted.filter((value) => symbols.includes(value.symbol));
  }
}

function fixture(
  initialNow = "2026-08-24T13:25:00Z",
  quoteBatchSize = 50,
  marketId: MarketId = "CA_TSX",
  editable = false,
) {
  let now = new Date(initialNow);
  const clock = () => new Date(now);
  const advance = (value: string) => {
    now = new Date(value);
  };
  const repository = new MemoryRepository();
  const transport = new MockQuestradeTransport();
  const limiter = new QuestradeRateLimiter(
    2,
    2,
    clock,
    new MockRequestBudget(),
  );
  const tokenManager = new QuestradeTokenManager(
    transport,
    new InMemoryRefreshTokenStore("mock-refresh-token-0"),
    clock,
    0,
    limiter,
  );
  const adapter = new QuestradeAdapter(
    tokenManager,
    transport,
    clock,
    "QUESTRADE_MOCK",
    limiter,
  );
  const metadata = editable
    ? new EditableTestUniverseManager(adapter, repository)
    : new TestUniverseManager(adapter, repository);
  const candleService = new QuestradeCandleService(adapter, repository);
  const service = new QuestradeDataService(
    adapter,
    metadata,
    new QuestradeQuoteService(adapter, repository, quoteBatchSize),
    candleService,
    new MarketSessionManager(adapter, clock, "TSX", undefined, marketId),
    clock,
  );
  return { advance, candleService, metadata, repository, service, transport };
}

function emptyEngineResult(): EngineResultBatch {
  return {
    snapshots: [],
    evaluations: [],
    events: [],
    contexts: [],
    benchmarkReadiness: { market: null, sectors: [] },
    timings: { featureMs: 0, evaluationMs: 0 },
  };
}

describe("Questrade candle service", () => {
  it("fetches from a two-bar watermark and emits only new or corrected bars", async () => {
    const start = new Date("2026-08-25T13:30:00Z");
    const candle: Candle = {
      symbolId: 1,
      interval: "OneMinute",
      start,
      end: new Date(start.getTime() + 60_000),
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 100,
      source: "QUESTRADE",
      isComplete: true,
    };
    const initial = Array.from({ length: 4 }, (_, minute) => ({
      ...candle,
      start: new Date(start.getTime() + minute * 60_000),
      end: new Date(start.getTime() + (minute + 1) * 60_000),
    }));
    let rows = initial;
    const getCandles = vi.fn(
      async (
        _symbolId: number,
        _interval: string,
        _range: { startTime: Date },
      ) => rows,
    );
    const saveCandles = vi.fn(async (_candles: Candle[]) => undefined);
    const service = new QuestradeCandleService(
      { getCandles } as unknown as MarketDataAdapter,
      { saveCandles } as unknown as MarketDataRepository,
    );
    const instrument = {
      symbolId: 1,
    } as PersistedInstrument;
    const market = {
      startTime: start,
      endTime: new Date(start.getTime() + 6 * 60_000),
    } as Parameters<typeof service.collect>[1];

    expect(
      await service.collect([instrument], market, market.endTime, [
        "OneMinute",
      ]),
    ).toEqual(initial);
    expect(
      await service.collect([instrument], market, market.endTime, [
        "OneMinute",
      ]),
    ).toEqual([]);
    expect(getCandles.mock.calls[1]?.[2].startTime).toEqual(initial[1]!.start);
    rows = [{ ...initial[3]!, close: 12 }];
    expect(
      await service.collect([instrument], market, market.endTime, [
        "OneMinute",
      ]),
    ).toEqual(rows);
    expect(saveCandles.mock.calls.map(([value]) => value.length)).toEqual([
      4, 0, 1,
    ]);
    service.reset();
    expect(
      await service.collect([instrument], market, market.endTime, [
        "OneMinute",
      ]),
    ).toEqual(rows);
  });

  it("re-reads the whole session every 15 minutes and emits only late or revised bars", async () => {
    const start = new Date("2026-08-25T13:30:00Z");
    const bar = (minute: number, close = 10): Candle => ({
      symbolId: 1,
      interval: "OneMinute",
      start: new Date(start.getTime() + minute * 60_000),
      end: new Date(start.getTime() + (minute + 1) * 60_000),
      open: 10,
      high: 11,
      low: 9,
      close,
      volume: 100,
      source: "QUESTRADE",
      isComplete: true,
    });
    // Minute 2 is missing at first and published only after the watermark
    // has moved past it.
    let rows = [0, 1, 3, 4, 5].map((minute) => bar(minute));
    const getCandles = vi.fn(
      async (
        _symbolId: number,
        _interval: string,
        range: { startTime: Date },
      ) => rows.filter((value) => value.start >= range.startTime),
    );
    const service = new QuestradeCandleService(
      { getCandles } as unknown as MarketDataAdapter,
      {
        saveCandles: vi.fn(async () => undefined),
      } as unknown as MarketDataRepository,
    );
    const instrument = { symbolId: 1 } as PersistedInstrument;
    const market = {
      startTime: start,
      endTime: new Date(start.getTime() + 390 * 60_000),
    } as Parameters<typeof service.collect>[1];
    const at = (minute: number) => new Date(start.getTime() + minute * 60_000);

    await service.collect([instrument], market, at(6), ["OneMinute"]);
    rows = [0, 1, 2, 3, 4, 5, 6].map((minute) => bar(minute));
    expect(
      await service.collect([instrument], market, at(7), ["OneMinute"]),
    ).toEqual([bar(6)]);
    expect(getCandles.mock.calls[1]?.[2].startTime).toEqual(at(3));
    expect(
      await service.collect([instrument], market, at(21), ["OneMinute"]),
    ).toEqual([bar(2)]);
    expect(getCandles.mock.calls[2]?.[2].startTime).toEqual(start);
  });

  it("bounds collection concurrency and retries transient provider failures", async () => {
    let active = 0;
    let maximumActive = 0;
    const attempts = new Map<number, number>();
    const getCandles = vi.fn(async (symbolId: number) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const attempt = (attempts.get(symbolId) ?? 0) + 1;
      attempts.set(symbolId, attempt);
      if (symbolId === 1 && attempt === 1) {
        throw new QuestradeHttpError(429, "candles");
      }
      return [];
    });
    const adapter = { getCandles } as unknown as MarketDataAdapter;
    const repository = new MemoryRepository();
    const sleep = vi.fn(async () => undefined);
    const service = new QuestradeCandleService(adapter, repository, {
      maxConcurrentRequests: 2,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      sleep,
    });
    const instruments = [1, 2, 3, 4].map((symbolId): PersistedInstrument => ({
      id: `instrument-${symbolId}`,
      symbolId,
      symbol: `TEST${symbolId}.TO`,
      description: `Test ${symbolId}`,
      securityType: "Stock",
      exchange: "TSX",
      currency: "CAD",
      isQuotable: true,
      isTradable: true,
      active: true,
    }));

    await service.collectRange(
      instruments,
      {
        startTime: new Date("2026-08-01T00:00:00Z"),
        endTime: new Date("2026-08-02T00:00:00Z"),
      },
      ["OneDay"],
    );

    expect(maximumActive).toBe(2);
    expect(getCandles).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledWith(10);
  });
});

describe("Questrade data service", () => {
  it("reports a committed candidate paste separately from a failed refresh", async () => {
    const { metadata, service } = fixture();
    vi.spyOn(metadata, "enrich").mockRejectedValueOnce(
      new Error("quote unavailable"),
    );

    const result = await service.updateUniverseCandidates({
      operation: "ADD",
      source: "TRADINGVIEW",
      inputs: ["SHOP"],
      note: null,
      tags: [],
    });

    expect(result.pasteReport.accepted).toHaveLength(1);
    expect(result.refreshError).toBe("quote unavailable");
  });

  it("keeps warm-up consistent when the universe changes during startup", async () => {
    const { candleService, service } = fixture();
    const ingested: { symbols: number[]; known: number[] }[] = [];
    const engine = {
      startSession: vi.fn(async () => undefined),
      ingestCandles: vi.fn(
        async (candles: Candle[], instruments: PersistedInstrument[]) => {
          ingested.push({
            symbols: candles.map((candle) => candle.symbolId),
            known: instruments.map((instrument) => instrument.symbolId),
          });
        },
      ),
      ingestQuotes: vi.fn(async () => emptyEngineResult()),
    };
    service.setFeatureEngine(engine, {
      saveFeatureSnapshots: async () => undefined,
    });
    const collectRange = candleService.collectRange.bind(candleService);
    let swapped = false;
    vi.spyOn(candleService, "collectRange").mockImplementation(
      async (...args) => {
        const candles = await collectRange(...args);
        if (!swapped) {
          swapped = true;
          // A concurrent universe refresh deactivates yesterday's candidates.
          (
            service as unknown as { instruments: PersistedInstrument[] }
          ).instruments = [];
        }
        return candles;
      },
    );

    await service.initialize();

    expect(ingested.length).toBeGreaterThan(0);
    for (const { symbols, known } of ingested)
      for (const symbol of symbols) expect(known).toContain(symbol);
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(false);
  });

  it("applies a list edit by retiring and warming only the changed symbols", async () => {
    const { candleService, service } = fixture(
      undefined,
      undefined,
      undefined,
      true,
    );
    const engine = {
      startSession: vi.fn(async () => undefined),
      ingestCandles: vi.fn(async () => undefined),
      ingestQuotes: vi.fn(async () => emptyEngineResult()),
      warmInstrument: vi.fn(async (instrument: PersistedInstrument) => ({
        instrumentId: instrument.id,
        ready: true,
        dailyHistoryCount: 20,
        historicalIntradaySessionCount: 5,
        currentSessionOneMinuteCount: 0,
        openingRangeComplete: false,
        benchmarkReady: true,
        reasons: [],
      })),
      retireInstruments: vi.fn(async (instruments: PersistedInstrument[]) =>
        instruments.map((value) => value.id),
      ),
    };
    service.setFeatureEngine(engine, {
      saveFeatureSnapshots: async () => undefined,
    });
    await service.initialize();
    expect(engine.startSession).toHaveBeenCalledTimes(1);
    const history = vi.spyOn(candleService, "collectRange");

    await service.replaceUniverseSymbols(["BTO.TO", "QBR.B.TO"]);

    // No session restart and no full warm-up: only the added symbol's history.
    expect(engine.startSession).toHaveBeenCalledTimes(1);
    expect(history.mock.calls.length).toBeGreaterThan(0);
    for (const [instruments] of history.mock.calls)
      expect(instruments.map((value) => value.symbol)).toEqual(["QBR.B.TO"]);
    expect(
      engine.retireInstruments.mock.calls.flatMap(([values]) =>
        values.map((value) => value.symbol),
      ),
    ).toEqual(["BAM.TO"]);
    expect(
      engine.warmInstrument.mock.calls.map(([instrument]) => instrument.symbol),
    ).toEqual(["QBR.B.TO"]);
    expect(
      service
        .getInstruments()
        .map((value) => value.symbol)
        .filter((symbol) => ["BTO.TO", "BAM.TO", "QBR.B.TO"].includes(symbol))
        .sort(),
    ).toEqual(["BTO.TO", "QBR.B.TO"]);
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(true);
  });

  it("falls back to a full refresh when the engine cannot edit a live session", async () => {
    const { service } = fixture(undefined, undefined, undefined, true);
    const engine = {
      startSession: vi.fn(async () => undefined),
      ingestCandles: vi.fn(async () => undefined),
      ingestQuotes: vi.fn(async () => emptyEngineResult()),
    };
    service.setFeatureEngine(engine, {
      saveFeatureSnapshots: async () => undefined,
    });
    await service.initialize();

    await service.replaceUniverseSymbols(["BTO.TO", "QBR.B.TO"]);

    expect(engine.startSession).toHaveBeenCalledTimes(2);
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(true);
  });

  it("keeps a failed warm-up out of sync until the recovery delay expires", async () => {
    const { advance, candleService, service } = fixture();
    const engine = {
      startSession: vi.fn(async () => undefined),
      ingestCandles: vi.fn(async () => undefined),
      ingestQuotes: vi.fn(async () => {
        throw new Error("not exercised before the market opens");
      }),
    };
    service.setFeatureEngine(engine, {
      saveFeatureSnapshots: async () => undefined,
    });
    await service.initialize();
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(true);

    vi.spyOn(candleService, "collectRange").mockRejectedValueOnce(
      new QuestradeHttpError(429, "candles"),
    );
    await expect(service.refreshUniverse()).rejects.toThrow("HTTP 429");

    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(false);
    expect(engine.startSession).toHaveBeenCalledTimes(1);

    await service.runCycle();

    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(false);
    expect(engine.startSession).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().lastError).toContain(
      "2026-08-24T13:25:30.000Z",
    );

    advance("2026-08-24T13:25:30Z");
    await service.runCycle();

    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(true);
    expect(engine.startSession).toHaveBeenCalledTimes(2);
  });

  it("caps repeated scanner recovery at three full history loads per rolling hour", async () => {
    const { advance, candleService, service, transport } = fixture(
      "2026-08-24T14:01:00Z",
    );
    const history = vi.spyOn(candleService, "collectRange");
    const engine = {
      startSession: vi.fn(async () => undefined),
      ingestCandles: async () => undefined,
      ingestQuotes: vi.fn(async () => {
        throw new Error(
          "Scanner /internal/v1/quotes/batch returned HTTP 400: invalid quote",
        );
      }),
    };
    service.setFeatureEngine(engine, {
      saveFeatureSnapshots: async () => undefined,
    });
    await service.initialize();
    await service.runCycle();
    expect(history).toHaveBeenCalledTimes(2);

    for (let second = 2; second < 30; second += 2) {
      advance(`2026-08-24T14:01:${String(second).padStart(2, "0")}Z`);
      await service.runCycle();
    }
    expect(history).toHaveBeenCalledTimes(2);
    expect(transport.quoteBatches).toHaveLength(1);

    advance("2026-08-24T14:01:30Z");
    await service.runCycle();
    expect(history).toHaveBeenCalledTimes(4);
    // Uploading history succeeded, but the quote evaluation failed again: backoff doubles.
    advance("2026-08-24T14:02:00Z");
    await service.runCycle();
    expect(history).toHaveBeenCalledTimes(4);
    advance("2026-08-24T14:02:30Z");
    await service.runCycle();
    expect(history).toHaveBeenCalledTimes(6);

    advance("2026-08-24T14:59:59Z");
    await service.runCycle();
    expect(history).toHaveBeenCalledTimes(6);
    expect(transport.quoteBatches).toHaveLength(3);
    expect(service.getSnapshot()).toMatchObject({ state: "DEGRADED" });
    expect(service.getSnapshot().lastError).toContain("3 full history reloads");
    expect(service.getSnapshot().lastError).toContain(
      "2026-08-24T15:01:00.000Z",
    );
    expect(service.getSnapshot().lastError).toContain("invalid quote");

    advance("2026-08-24T15:00:59Z");
    await service.runCycle();
    expect(history).toHaveBeenCalledTimes(6);
    advance("2026-08-24T15:01:00Z");
    await service.runCycle();
    expect(history).toHaveBeenCalledTimes(8);
    expect(engine.startSession).toHaveBeenCalledTimes(4);
  });

  it("prevents startup and explicit refresh from bypassing the warm-up allowance", async () => {
    const { candleService, service, transport } = fixture();
    const history = vi.spyOn(candleService, "collectRange");
    service.setFeatureEngine(
      {
        startSession: async () => undefined,
        ingestCandles: async () => undefined,
        ingestQuotes: async () => {
          throw new Error("not exercised");
        },
      },
      { saveFeatureSnapshots: async () => undefined },
    );
    await service.initialize();
    await service.refreshUniverse();
    await service.refreshUniverse();
    expect(history).toHaveBeenCalledTimes(6);
    const searches = vi.spyOn(transport, "searchSymbols");

    await expect(service.initialize()).rejects.toThrow(
      "3 full history reloads",
    );
    await expect(service.refreshUniverse()).rejects.toThrow(
      "3 full history reloads",
    );
    expect(history).toHaveBeenCalledTimes(6);
    expect(searches).not.toHaveBeenCalled();
  });

  it("resets recovery backoff only after a complete scan succeeds without refunding warm-ups", async () => {
    const { advance, candleService, service } = fixture("2026-08-24T14:01:00Z");
    let rejectQuotes = true;
    const engine = {
      startSession: vi.fn(async () => undefined),
      ingestCandles: async () => undefined,
      ingestQuotes: async () => {
        if (rejectQuotes) throw new Error("scanner unavailable");
        return emptyEngineResult();
      },
    };
    service.setFeatureEngine(engine, {
      saveFeatureSnapshots: async () => undefined,
    });
    await service.initialize();
    await service.runCycle();
    rejectQuotes = false;
    advance("2026-08-24T14:01:30Z");
    await service.runCycle();
    expect(service.getSnapshot().lastError).toBeUndefined();
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(true);

    rejectQuotes = true;
    advance("2026-08-24T14:01:32Z");
    await service.runCycle();
    expect(service.getSnapshot().lastError).toContain(
      "2026-08-24T14:02:02.000Z",
    );
    const history = vi.spyOn(candleService, "collectRange");
    advance("2026-08-24T14:02:01Z");
    await service.runCycle();
    expect(history).not.toHaveBeenCalled();
    advance("2026-08-24T14:02:02Z");
    await service.runCycle();
    expect(engine.startSession).toHaveBeenCalledTimes(3);
    expect(history).toHaveBeenCalledTimes(2);
    advance("2026-08-24T14:30:00Z");
    await service.runCycle();
    expect(history).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().lastError).toContain("3 full history reloads");
  });

  it("charges failed history fetches and leaves the other market's recovery allowance available", async () => {
    const ca = fixture("2026-08-24T14:01:00Z");
    const us = fixture("2026-08-24T14:01:00Z", 50, "US_EQUITIES");
    const engine = () => ({
      startSession: async () => undefined,
      ingestCandles: async () => undefined,
      ingestQuotes: async () => emptyEngineResult(),
    });
    ca.service.setFeatureEngine(engine(), {
      saveFeatureSnapshots: async () => undefined,
    });
    us.service.setFeatureEngine(engine(), {
      saveFeatureSnapshots: async () => undefined,
    });
    const caHistory = vi
      .spyOn(ca.candleService, "collectRange")
      .mockRejectedValue(new Error("history unavailable"));
    for (const at of ["14:01:00", "14:01:30", "14:02:30"]) {
      ca.advance(`2026-08-24T${at}Z`);
      await expect(ca.service.initialize()).rejects.toThrow(
        "history unavailable",
      );
    }
    ca.advance("2026-08-24T14:10:00Z");
    await expect(ca.service.initialize()).rejects.toThrow(
      "3 full history reloads",
    );
    expect(caHistory).toHaveBeenCalledTimes(3);

    await us.service.initialize();
    await us.service.runCycle();
    expect(us.service.getSnapshot().lastError).toBeUndefined();
    expect(us.service.getSnapshot().session?.marketId).toBe("US_EQUITIES");
    expect(us.service.getOperationalStatusInput().scannerSynchronized).toBe(
      true,
    );
  });

  it("retries a blocked universe refresh before scanning the changed membership", async () => {
    const { advance, metadata, repository, service } = fixture();
    service.setFeatureEngine(
      {
        startSession: async () => undefined,
        ingestCandles: async () => undefined,
        ingestQuotes: async () => emptyEngineResult(),
      },
      { saveFeatureSnapshots: async () => undefined },
    );
    await service.initialize();
    await service.refreshUniverse();
    await service.refreshUniverse();
    const reload = vi
      .spyOn(metadata, "enrich")
      .mockResolvedValue([repository.instruments[0]!]);

    await expect(service.refreshUniverse()).rejects.toThrow(
      "3 full history reloads",
    );
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(false);
    advance("2026-08-24T14:00:00Z");
    await service.runCycle();
    expect(reload).not.toHaveBeenCalled();
    advance("2026-08-24T14:25:00Z");
    await service.runCycle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(service.getInstruments().map((value) => value.symbol)).toEqual([
      "BTO.TO",
    ]);
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(true);
  });

  it("retries deferred session-rollover metadata after the warm-up allowance reopens", async () => {
    const { advance, metadata, repository, service, transport } = fixture(
      "2026-08-24T14:01:00Z",
    );
    service.setFeatureEngine(
      {
        startSession: async () => undefined,
        ingestCandles: async () => undefined,
        ingestQuotes: async () => emptyEngineResult(),
      },
      { saveFeatureSnapshots: async () => undefined },
    );
    await service.initialize();
    await service.refreshUniverse();
    await service.refreshUniverse();
    const originalMarkets = transport.getMarkets.bind(transport);
    vi.spyOn(transport, "getMarkets").mockImplementation(async (...args) => {
      const markets = await originalMarkets(...args);
      return markets.map((market) => ({
        ...market,
        startTime: "2026-08-24T13:31:00Z",
      }));
    });
    const reload = vi
      .spyOn(metadata, "enrich")
      .mockResolvedValue([repository.instruments[0]!]);
    advance("2026-08-24T15:00:00Z");
    await service.runCycle();
    expect(reload).not.toHaveBeenCalled();
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(false);
    advance("2026-08-24T15:01:00Z");
    await service.runCycle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(service.getInstruments().map((value) => value.symbol)).toEqual([
      "BTO.TO",
    ]);
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(true);
  });

  it("reports warm-up coverage for every submitted Phase 7 candidate", async () => {
    const { service } = fixture();
    await service.initialize();

    expect(service.getUniverseAutomation()?.coverage).toEqual([
      expect.objectContaining({
        symbol: "BTO.TO",
        status: "WARMING",
        dataReadiness: "WARMING",
        setupCount: 0,
        contextCount: 0,
      }),
      expect.objectContaining({
        symbol: "BAM.TO",
        status: "WARMING",
        dataReadiness: "WARMING",
        setupCount: 0,
        contextCount: 0,
      }),
      expect.objectContaining({
        symbol: "QBR.B.TO",
        status: "WARMING",
        dataReadiness: "WARMING",
        setupCount: 0,
        contextCount: 0,
      }),
    ]);
  });

  it("does not acknowledge discovery intake when scanner warm-up is not strategy-ready", async () => {
    const { service, candleService, repository } = fixture();
    const engine = {
      startSession: vi.fn(async () => undefined),
      ingestCandles: vi.fn(async () => undefined),
      warmInstrument: vi.fn(async (instrument: PersistedInstrument) => ({
        instrumentId: instrument.id,
        ready: false,
        dailyHistoryCount: 0,
        historicalIntradaySessionCount: 0,
        currentSessionOneMinuteCount: 0,
        openingRangeComplete: false,
        benchmarkReady: false,
        reasons: ["DAILY_HISTORY_UNAVAILABLE", "BENCHMARK_UNAVAILABLE"],
      })),
      ingestQuotes: vi.fn(async () => {
        throw new Error("not exercised before the market opens");
      }),
    };
    service.setFeatureEngine(engine, {
      saveFeatureSnapshots: async () => undefined,
    });
    await service.initialize();
    vi.spyOn(candleService, "collectRange").mockResolvedValue([]);

    await expect(
      service.synchronizeDiscoveryCandidate(repository.instruments[0]!),
    ).rejects.toThrow("Discovery candidate warm-up is not ready");
    expect(engine.warmInstrument).toHaveBeenCalledTimes(1);
    expect(service.getOperationalStatusInput().scannerSynchronized).toBe(true);
  });

  it("reports Toronto scanning and preferred-entry boundaries", async () => {
    const { advance, service } = fixture("2026-08-24T13:44:00Z");
    await service.initialize();
    expect(service.getSnapshot().session).toMatchObject({
      phase: "OPENING_RANGE",
      scanningEnabled: false,
      newEntriesAllowed: false,
    });

    advance("2026-08-24T13:45:00Z");
    expect(service.getSnapshot().session).toMatchObject({
      phase: "ACTIVE_SCAN",
      scanningEnabled: true,
      preferredEntriesEnabled: false,
      newEntriesAllowed: true,
    });
    advance("2026-08-24T14:00:00Z");
    expect(service.getSnapshot().session).toMatchObject({
      phase: "PREFERRED_ENTRIES",
      preferredEntriesEnabled: true,
      newEntriesAllowed: true,
    });
    advance("2026-08-24T16:00:00Z");
    expect(service.getSnapshot().session).toMatchObject({
      phase: "ACTIVE_SCAN",
      scanningEnabled: true,
      preferredEntriesEnabled: false,
      newEntriesAllowed: true,
    });
    advance("2026-08-24T20:00:00Z");
    expect(service.getSnapshot().session).toMatchObject({
      phase: "AFTER_HOURS",
      scanningEnabled: false,
      preferredEntriesEnabled: false,
      newEntriesAllowed: false,
    });
  });

  it("runs an unattended simulated session with automatic token rotation and persistence", async () => {
    const { advance, repository, service, transport } = fixture();
    await service.initialize();

    expect(service.getSnapshot()).toMatchObject({
      state: "MARKET_CLOSED",
      auth: "CONNECTED",
      instrumentCount: 3,
      session: { phase: "PRE_OPEN" },
    });

    advance("2026-08-24T13:31:00Z");
    await service.runCycle();
    expect(repository.quotes).toHaveLength(3);
    expect(repository.candles.length).toBeGreaterThan(0);
    expect(service.getSnapshot()).toMatchObject({
      state: "DATA_DELAYED",
      dataStatus: "DELAYED",
    });

    advance("2026-08-24T14:01:00Z");
    await service.runCycle();
    expect(transport.authCallCount).toBe(2);
    expect(transport.quoteBatches).toEqual([
      [1001, 1002, 1003],
      [1001, 1002, 1003],
    ]);
    expect(repository.quotes).toHaveLength(6);

    advance("2026-08-24T20:01:00Z");
    await service.runCycle();
    expect(service.getSnapshot()).toMatchObject({
      state: "MARKET_CLOSED",
      session: { phase: "AFTER_HOURS" },
    });
  });

  it("splits a watchlist according to the configured quote batch size", async () => {
    const { advance, service, transport } = fixture("2026-08-24T13:25:00Z", 2);
    await service.initialize();
    advance("2026-08-24T13:31:00Z");
    await service.runCycle();

    expect(transport.quoteBatches).toEqual([[1001, 1002], [1003]]);
  });

  it("does not duplicate durably loaded alerts when initialize() is retried after a mid-startup failure", async () => {
    const { service } = fixture();
    const persistedAlerts: ScannerAlert[] = [
      {
        alertId: "1a2b3c4d-0000-4000-8000-000000000001",
        eventId: "1a2b3c4d-0000-4000-8000-000000000002",
        type: "READY",
        symbol: "BTO.TO",
        strategy: "ORB_RETEST",
        profileId: "1a2b3c4d-0000-4000-8000-000000000003",
        profileName: "Legacy",
        strategyVersion: "1.0.0",
        configVersion: "1.0.0",
        timestamp: "2026-08-24T13:00:00.000Z",
        previousState: "FORMING",
        state: "READY",
        score: 80,
        title: "BTO.TO ready",
        message: "BTO.TO ORB retest ready",
        reasonCodes: [],
        setupInstanceId: null,
        entryReference: null,
        stopReference: null,
        targetReference: null,
      },
    ];
    const alertStore = {
      saveAlerts: async (alerts: ScannerAlert[]) => alerts,
      listRecent: async () => persistedAlerts,
      loadPolicy: async () => ({
        cooldownMinutes: 5,
        rearmRule: "NEW_SETUP_INSTANCE" as const,
        contextNotificationsEnabled: false as const,
      }),
      savePolicy: async (policy: unknown) => policy as never,
    };
    const engine = {
      startSession: async () => undefined,
      ingestCandles: async () => undefined,
      ingestQuotes: async () => {
        throw new Error("not exercised in this test");
      },
    };
    const featureStore = { saveFeatureSnapshots: async () => undefined };
    service.setFeatureEngine(engine, featureStore, undefined, alertStore);

    await service.initialize();
    expect(service.getAlerts()).toHaveLength(1);

    // A retried initialize() (e.g. after a transient failure during warm-up) re-lists the same
    // durable rows; it must replace/dedupe rather than append a second copy.
    await service.initialize();
    expect(service.getAlerts()).toHaveLength(1);
    expect(service.getAlerts()[0]?.alertId).toBe(
      "1a2b3c4d-0000-4000-8000-000000000001",
    );
  });

  it("transitions to a paused AUTH_REQUIRED state after repeated authentication failures", async () => {
    const failingAdapter: MarketDataAdapter = {
      initialize: () =>
        Promise.reject(
          new QuestradeReauthorizationRequiredError(new Error("no token")),
        ),
      searchSymbols: () => Promise.resolve([]),
      getQuotes: () => Promise.resolve([]),
      getCandles: () => Promise.resolve([]),
      getMarket: () => Promise.resolve(undefined),
    };
    const repository = new MemoryRepository();
    const metadata = new TestUniverseManager(failingAdapter, repository);
    const clock = () => new Date("2026-08-24T13:25:00Z");
    const service = new QuestradeDataService(
      failingAdapter,
      metadata,
      new QuestradeQuoteService(failingAdapter, repository, 50),
      new QuestradeCandleService(failingAdapter, repository),
      new MarketSessionManager(failingAdapter, clock),
      clock,
    );

    await expect(service.initialize()).rejects.toBeInstanceOf(
      QuestradeReauthorizationRequiredError,
    );
    expect(service.getSnapshot().state).toBe("DEGRADED");

    await expect(service.initialize()).rejects.toBeInstanceOf(
      QuestradeReauthorizationRequiredError,
    );
    expect(service.getSnapshot().state).toBe("AUTH_REQUIRED");
    expect(service.getSnapshot().auth).toBe("AUTH_REQUIRED");
  });

  it("exposes operational-status primitives reflecting universe resolution and evaluation counts", async () => {
    const { service, advance } = fixture();
    await service.initialize();

    let input = service.getOperationalStatusInput();
    expect(input.universeConfigured).toBe(3);
    expect(input.universeResolved).toBe(3);
    expect(input.universeEvaluated).toBe(0);
    expect(input.marketStatus).toBe("PRE_MARKET");
    expect(input.auth).toBe("CONNECTED");

    advance("2026-08-24T13:31:00Z");
    await service.runCycle();
    input = service.getOperationalStatusInput();
    expect(input.marketStatus).toBe("OPEN");
  });
});
