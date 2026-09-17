import { describe, expect, it } from "vitest";
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
import {
  InMemoryRefreshTokenStore,
  QuestradeTokenManager,
} from "../src/questrade/token-manager.js";
import type {
  Candle,
  Instrument,
  MarketDataAdapter,
  Quote,
} from "../src/questrade/types.js";
import type { UniverseAutomation } from "@tsx-scanner/contracts";
import { DEFAULT_UNIVERSE_POLICY } from "../src/universe/universe-service.js";

/**
 * Phase 9 soak test: runs the real scan-cycle loop for far longer than any
 * single vitest example does elsewhere, to catch what only shows up under
 * sustained operation -- unbounded in-memory growth and cycle-latency
 * budget regressions -- rather than proving correctness of one cycle.
 */
class MemoryRepository implements MarketDataRepository {
  async markBenchmarks(): Promise<void> {}
  readonly instruments: PersistedInstrument[] = [];
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
  async saveQuotes(_quotes: Quote[]): Promise<void> {}
  async saveCandles(_candles: Candle[]): Promise<void> {}
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
}

function fixture(initialNow = "2026-08-24T13:31:00Z") {
  let now = new Date(initialNow);
  const clock = () => new Date(now);
  const advance = (deltaMs: number) => {
    now = new Date(now.getTime() + deltaMs);
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
  const metadata = new TestUniverseManager(adapter, repository);
  const service = new QuestradeDataService(
    adapter,
    metadata,
    new QuestradeQuoteService(adapter, repository, 50),
    new QuestradeCandleService(adapter, repository),
    new MarketSessionManager(adapter, clock),
    clock,
  );
  return { advance, service };
}

describe("Phase 9 soak test", () => {
  it("keeps cycle latency within budget and in-memory state bounded across a long run", async () => {
    const { advance, service } = fixture();
    await service.initialize();

    const CYCLES = 300;
    const CYCLE_LATENCY_BUDGET_MS = 500;
    const durations: number[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      advance(2_000);
      await service.runCycle();
      const observability = service.getObservability();
      if (observability.cycleLatencyMs !== null)
        durations.push(observability.cycleLatencyMs);
    }

    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...durations)).toBeLessThan(CYCLE_LATENCY_BUDGET_MS);
    const activeMonitoring = service.getObservability();
    expect(activeMonitoring.activeMonitoringCycleSampleCount).toBe(100);
    expect(activeMonitoring.activeMonitoringCycleP95Ms).not.toBeNull();
    expect(activeMonitoring.activeMonitoringCycleP95Ms!).toBeLessThan(
      CYCLE_LATENCY_BUDGET_MS,
    );

    // The signal timeline must not grow without bound across a long-running session.
    expect(service.getSignals().length).toBeLessThanOrEqual(2_000);
    // The alert feed is deliberately capped, independent of how many cycles ran.
    expect(service.getAlerts().length).toBeLessThanOrEqual(200);
  }, 30_000);
});
