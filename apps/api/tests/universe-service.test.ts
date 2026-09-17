import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  UniverseMember,
  UniversePolicy,
  UniverseRefreshRun,
} from "@tsx-scanner/contracts";
import {
  AutomatedUniverseService,
  ConfiguredUsUniverseProvider,
  ConfiguredTsxUniverseProvider,
  DEFAULT_UNIVERSE_POLICY,
  DEFAULT_US_UNIVERSE_POLICY,
  MockUsUniverseProvider,
  parseMarketCandidateInput,
  MockTsxUniverseProvider,
  type UniverseEvaluation,
  type UniverseStore,
  type UniverseWatchlistStore,
} from "../src/universe/universe-service.js";
import { QuestradeAdapter } from "../src/questrade/adapter.js";
import { MockQuestradeTransport } from "../src/questrade/mock-transport.js";
import {
  InMemoryRefreshTokenStore,
  QuestradeTokenManager,
} from "../src/questrade/token-manager.js";
import type { PersistedInstrument } from "../src/market-data/repository.js";

class MemoryUniverseStore implements UniverseStore {
  readonly runs: UniverseRefreshRun[] = [];

  async begin(
    provider: string,
    policy: UniversePolicy,
    startedAt: Date,
  ): Promise<UniverseRefreshRun> {
    const run: UniverseRefreshRun = {
      id: randomUUID(),
      marketId: policy.marketId,
      provider,
      policyVersion: policy.version,
      status: "RUNNING",
      discoveredCount: 0,
      evaluatedCount: 0,
      eligibleCount: 0,
      activatedCount: 0,
      warnings: [],
      error: null,
      startedAt: startedAt.toISOString(),
      completedAt: null,
    };
    this.runs.unshift(run);
    return run;
  }

  async complete(
    runId: string,
    evaluations: UniverseEvaluation[],
    warnings: string[],
    completedAt: Date,
    minimumSize: number,
  ) {
    const eligible = evaluations.filter(
      (value) => value.member.eligible && value.instrument,
    );
    if (eligible.length < minimumSize) throw new Error("minimum safe size");
    const members: UniverseMember[] = evaluations.map((value) => ({
      ...value.member,
      instrumentId: value.instrument ? randomUUID() : null,
    }));
    const instruments: PersistedInstrument[] = eligible.map((value) => ({
      ...value.instrument!,
      id: members.find((member) => member.symbol === value.member.symbol)!
        .instrumentId!,
      active: true,
    }));
    const run = this.runs.find((value) => value.id === runId)!;
    Object.assign(run, {
      status: "COMPLETED",
      discoveredCount: evaluations.length,
      evaluatedCount: evaluations.length,
      eligibleCount: eligible.length,
      activatedCount: instruments.length,
      warnings,
      completedAt: completedAt.toISOString(),
    });
    return { run: { ...run }, instruments, members };
  }

  async fail(
    runId: string,
    error: string,
    completedAt: Date,
  ): Promise<UniverseRefreshRun> {
    const run = this.runs.find((value) => value.id === runId)!;
    Object.assign(run, {
      status: "FAILED",
      error,
      completedAt: completedAt.toISOString(),
    });
    return { ...run };
  }

  async listRuns(limit = 20): Promise<UniverseRefreshRun[]> {
    return this.runs.slice(0, limit).map((value) => ({ ...value }));
  }

  async loadLastCompleted(): Promise<null> {
    return null;
  }
}

describe("universe history routing", () => {
  it.each([DEFAULT_UNIVERSE_POLICY, DEFAULT_US_UNIVERSE_POLICY])(
    "passes the $marketId policy to persisted history queries",
    async (policy) => {
      const store = new MemoryUniverseStore();
      const listRuns = vi.spyOn(store, "listRuns");
      const service = new AutomatedUniverseService(
        new MockUsUniverseProvider(),
        {} as never,
        store,
        policy,
      );
      await service.listRuns(3);
      expect(listRuns).toHaveBeenCalledWith(3, policy.marketId);
    },
  );
});

function fixture(policy = DEFAULT_UNIVERSE_POLICY, minimumSize = 1) {
  const now = new Date("2026-08-24T13:25:00.000Z");
  const clock = () => new Date(now);
  const transport = new MockQuestradeTransport();
  const tokenManager = new QuestradeTokenManager(
    transport,
    new InMemoryRefreshTokenStore("mock-refresh-token-0"),
    clock,
    0,
  );
  const adapter = new QuestradeAdapter(tokenManager, transport, clock);
  const store = new MemoryUniverseStore();
  return {
    service: new AutomatedUniverseService(
      new MockTsxUniverseProvider(),
      adapter,
      store,
      policy,
      minimumSize,
      clock,
    ),
    store,
    adapter,
  };
}

describe("Phase 10 universe automation", () => {
  it("preserves explicit market and exchange intent for mixed candidate input", () => {
    expect(parseMarketCandidateInput("TSX:SHOP")).toMatchObject({
      status: "VALID",
      marketId: "CA_TSX",
      requestedExchange: "TSX",
      normalizedSymbol: "SHOP.TO",
    });
    expect(parseMarketCandidateInput("NASDAQ:AAPL")).toMatchObject({
      status: "VALID",
      marketId: "US_EQUITIES",
      requestedExchange: "NASDAQ",
      normalizedSymbol: "AAPL",
    });
    expect(parseMarketCandidateInput("NYSE:BAM")).toMatchObject({
      status: "VALID",
      marketId: "US_EQUITIES",
      requestedExchange: "NYSE",
      normalizedSymbol: "BAM",
    });
    expect(parseMarketCandidateInput("AAPL")).toMatchObject({
      status: "VALID",
      marketId: "US_EQUITIES",
      requestedExchange: null,
    });
    expect(parseMarketCandidateInput("NASDAQ:LULU")).toMatchObject({
      status: "VALID",
      marketId: "US_EQUITIES",
      requestedExchange: "NASDAQ",
      normalizedSymbol: "LULU",
    });
  });

  it("persists edits to the configured live watchlist", async () => {
    let now = new Date("2026-08-24T13:25:00.000Z");
    let persisted: { symbols: string[]; tradingDate: string } | null = null;
    const watchlistStore: UniverseWatchlistStore = {
      loadConfiguredSymbols: async () => persisted,
      saveConfiguredSymbols: async (_provider, symbols, tradingDate) => {
        persisted = { symbols: [...symbols], tradingDate };
      },
    };
    const provider = new ConfiguredTsxUniverseProvider(
      [" bto.to ", "BAM.TO"],
      watchlistStore,
      () => new Date(now),
    );

    expect((await provider.listSymbols()).map((value) => value.symbol)).toEqual(
      ["BAM.TO", "BTO.TO"],
    );
    await provider.replaceSymbols(["TSX:shop", "BTO", "shop.to"]);

    expect(provider.getConfiguredSymbols()).toEqual(["BTO.TO", "SHOP.TO"]);
    expect(persisted).toEqual({
      symbols: ["BTO.TO", "SHOP.TO"],
      tradingDate: "2026-08-24",
    });

    now = new Date("2026-08-25T13:25:00.000Z");
    expect(await provider.listSymbols()).toEqual([]);
    expect(provider.getWatchlistDate()).toBe("2026-08-25");
    expect(persisted).toEqual({ symbols: [], tradingDate: "2026-08-25" });
  });

  it("classifies a TradingView paste and retains source metadata for the Toronto trading date", async () => {
    const now = new Date("2026-08-24T13:25:00.000Z");
    let persisted: Awaited<
      ReturnType<UniverseWatchlistStore["loadConfiguredSymbols"]>
    > = null;
    const watchlistStore: UniverseWatchlistStore = {
      loadConfiguredSymbols: async () => persisted,
      saveConfiguredSymbols: async (
        _provider,
        symbols,
        tradingDate,
        candidates,
      ) => {
        persisted = {
          symbols: [...symbols],
          tradingDate,
          candidates: candidates?.map((value) => ({
            ...value,
            tags: [...value.tags],
          })),
        };
      },
    };
    const provider = new ConfiguredTsxUniverseProvider(
      ["BTO.TO"],
      watchlistStore,
      () => now,
    );
    await provider.listSymbols();

    const report = await provider.updateCandidates({
      operation: "ADD",
      source: "TRADINGVIEW",
      inputs: ["BTO", "TSX:SHOP", "SHOP", "NASDAQ:AAPL", "not a symbol"],
      note: "Morning gap scan",
      tags: [" gap-up ", "liquid", "gap-up"],
    });

    expect(report).toMatchObject({
      accepted: [],
      normalized: [{ originalInput: "TSX:SHOP", normalizedSymbol: "SHOP.TO" }],
      duplicate: [
        { originalInput: "BTO", normalizedSymbol: "BTO.TO" },
        { originalInput: "SHOP", normalizedSymbol: "SHOP.TO" },
      ],
      unsupported: [{ originalInput: "NASDAQ:AAPL", normalizedSymbol: null }],
      failed: [{ originalInput: "not a symbol", normalizedSymbol: null }],
    });
    expect(provider.getConfiguredCandidates()).toEqual([
      expect.objectContaining({ normalizedSymbol: "BTO.TO", source: "MANUAL" }),
      expect.objectContaining({
        normalizedSymbol: "SHOP.TO",
        originalInput: "TSX:SHOP",
        source: "TRADINGVIEW",
        tradingDate: "2026-08-24",
        addedAt: now.toISOString(),
        note: "Morning gap scan",
        tags: ["gap-up", "liquid"],
      }),
    ]);
    expect(
      (await watchlistStore.loadConfiguredSymbols("TEST"))?.symbols,
    ).toEqual(["BTO.TO", "SHOP.TO"]);

    const rejectedReplacement = await provider.updateCandidates({
      operation: "REPLACE",
      source: "TRADINGVIEW",
      inputs: ["NASDAQ:AAPL"],
      note: null,
      tags: [],
    });
    expect(rejectedReplacement.unsupported).toHaveLength(1);
    expect(provider.getConfiguredSymbols()).toEqual(["BTO.TO", "SHOP.TO"]);
  });

  it("analyzes manually selected symbols without applying the old Level-1 discovery thresholds", async () => {
    const now = new Date("2026-08-24T13:25:00.000Z");
    const transport = new MockQuestradeTransport();
    const tokenManager = new QuestradeTokenManager(
      transport,
      new InMemoryRefreshTokenStore("mock-refresh-token-0"),
      () => now,
      0,
    );
    const adapter = new QuestradeAdapter(tokenManager, transport, () => now);
    const store = new MemoryUniverseStore();
    const strict = {
      ...DEFAULT_UNIVERSE_POLICY,
      version: "strict",
      minimumMarketCap: 1_000_000_000_000,
    };
    const provider = new ConfiguredTsxUniverseProvider(
      ["BTO.TO"],
      undefined,
      () => now,
    );
    const service = new AutomatedUniverseService(
      provider,
      adapter,
      store,
      strict,
      1,
      () => now,
    );
    await adapter.initialize();

    expect((await service.enrich()).map((value) => value.symbol)).toEqual([
      "BTO.TO",
    ]);
    expect(service.getAutomation().members[0]).toMatchObject({
      symbol: "BTO.TO",
      eligible: true,
      reasons: [],
    });

    await service.replaceSymbols([]);
    expect(await service.enrich()).toEqual([]);
    expect(service.getAutomation().latestRun).toMatchObject({
      status: "COMPLETED",
      activatedCount: 0,
    });
  });

  it("derives and activates the liquid TSX universe without a manual watchlist", async () => {
    const { service, adapter } = fixture();
    await adapter.initialize();
    const instruments = await service.enrich();
    const snapshot = service.getAutomation();

    expect(instruments.map((value) => value.symbol)).toEqual([
      "BAM.TO",
      "BTO.TO",
      "QBR.B.TO",
    ]);
    expect(snapshot.latestRun).toMatchObject({
      status: "COMPLETED",
      discoveredCount: 3,
      eligibleCount: 3,
      activatedCount: 3,
    });
    expect(snapshot.members).toHaveLength(3);
    expect(
      snapshot.members.every(
        (value) =>
          value.eligible &&
          value.price &&
          value.marketCap &&
          value.averageVolume90d &&
          value.dollarVolume &&
          value.atrPct,
      ),
    ).toBe(true);
  });

  it("derives a USD US mock universe without weakening TSX eligibility rules", async () => {
    const now = new Date("2026-08-24T13:25:00.000Z");
    const transport = new MockQuestradeTransport();
    const tokenManager = new QuestradeTokenManager(
      transport,
      new InMemoryRefreshTokenStore("mock-refresh-token-0"),
      () => now,
      0,
    );
    const adapter = new QuestradeAdapter(tokenManager, transport, () => now);
    const service = new AutomatedUniverseService(
      new MockUsUniverseProvider(),
      adapter,
      new MemoryUniverseStore(),
      DEFAULT_US_UNIVERSE_POLICY,
      1,
      () => now,
    );
    await adapter.initialize();

    const instruments = await service.enrich();
    expect(instruments.map((value) => value.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(service.getAutomation().members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          marketId: "US_EQUITIES",
          currency: "USD",
          normalizedExchange: "NASDAQ",
          eligible: true,
        }),
      ]),
    );
  });

  it("records explainable exclusions and rejects an unsafe empty activation", async () => {
    const strict = {
      ...DEFAULT_UNIVERSE_POLICY,
      version: "strict",
      minimumMarketCap: 1_000_000_000_000,
    };
    const { service, store, adapter } = fixture(strict, 1);
    await adapter.initialize();

    await expect(service.enrich()).rejects.toThrow("minimum safe size");
    expect(store.runs[0]).toMatchObject({ status: "FAILED" });
  });

  it("keeps live US watchlist symbols in the US namespace", async () => {
    const provider = new ConfiguredUsUniverseProvider(["NASDAQ:AAPL", "NVDA"]);
    expect((await provider.listSymbols()).map((value) => value.symbol)).toEqual(
      ["AAPL", "NVDA"],
    );
    await expect(provider.getCandidateIntakeStatuses()).resolves.toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        status: "ADDED",
        source: "MANUAL",
      }),
      expect.objectContaining({
        symbol: "NVDA",
        status: "ADDED",
        source: "MANUAL",
      }),
    ]);
    await expect(provider.replaceSymbols(["TSX:SHOP"])).rejects.toThrow(
      "US_EQUITIES",
    );
  });

  it("populates candidates with marketId and passes marketId to watchlist store", async () => {
    const saved: {
      provider: string;
      symbols: string[];
      tradingDate: string;
      candidates?: unknown[];
      marketId?: string;
    }[] = [];
    const store: UniverseWatchlistStore = {
      async loadConfiguredSymbols() {
        return null;
      },
      async saveConfiguredSymbols(
        provider,
        symbols,
        tradingDate,
        candidates,
        marketId,
      ) {
        saved.push({ provider, symbols, tradingDate, candidates, marketId });
      },
    };
    const now = new Date("2026-09-04T12:00:00.000Z");
    const usProvider = new ConfiguredUsUniverseProvider([], store, () => now);

    const report = await usProvider.updateCandidates({
      operation: "REPLACE",
      source: "TRADINGVIEW",
      inputs: ["NYSE:JHX", "NYSE:TRU", "NYSE:EFX", "NYSE:ROL", "NASDAQ:AEHR"],
      tags: [],
    });

    expect(report.normalized).toHaveLength(5);
    expect(report.accepted).toHaveLength(0);
    expect(report.unsupported).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
    expect(saved).toHaveLength(2); // hydrate + updateCandidates
    const updateCall = saved[1]!;
    expect(updateCall.provider).toBe("CONFIGURED_US_LIVE_WATCHLIST");
    expect(updateCall.marketId).toBe("US_EQUITIES");
    expect(updateCall.symbols).toEqual(["AEHR", "EFX", "JHX", "ROL", "TRU"]);
    const candidates = usProvider.getConfiguredCandidates();
    expect(candidates).toHaveLength(5);
    expect(candidates.every((c) => c.marketId === "US_EQUITIES")).toBe(true);
    expect(
      candidates.find((c) => c.normalizedSymbol === "AEHR")?.requestedExchange,
    ).toBe("NASDAQ");
    expect(
      candidates.find((c) => c.normalizedSymbol === "JHX")?.requestedExchange,
    ).toBe("NYSE");
  });
});
