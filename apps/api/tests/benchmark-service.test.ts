import { describe, expect, it } from "vitest";
import { ConfiguredBenchmarkService } from "../src/market-data/benchmark-service.js";
import type {
  BenchmarkRole,
  MarketDataRepository,
  PersistedInstrument,
} from "../src/market-data/repository.js";
import type {
  AuthSession,
  Candle,
  Instrument,
  MarketDataAdapter,
  Quote,
} from "../src/questrade/types.js";

const instruments: Instrument[] = [
  {
    symbol: "XIU.TO",
    symbolId: 2001,
    description: "Market",
    securityType: "ETF",
    exchange: "TSX",
    currency: "CAD",
    isQuotable: true,
    isTradable: true,
  },
  {
    symbol: "XMA.TO",
    symbolId: 2002,
    description: "Materials",
    securityType: "ETF",
    exchange: "TSX",
    currency: "CAD",
    isQuotable: true,
    isTradable: true,
  },
];

class Adapter implements MarketDataAdapter {
  async initialize(): Promise<AuthSession> {
    throw new Error("not used");
  }
  async searchSymbols(prefix: string) {
    return instruments.filter((value) => value.symbol === prefix);
  }
  async getQuotes(): Promise<Quote[]> {
    return [];
  }
  async getCandles(): Promise<Candle[]> {
    return [];
  }
  async getMarket() {
    return undefined;
  }
}

class Repository implements MarketDataRepository {
  readonly marked: BenchmarkRole[][] = [];
  readonly upsertMarkets: Array<"CA_TSX" | "US_EQUITIES" | undefined> = [];
  async upsertInstruments(
    values: Instrument[],
    marketId?: "CA_TSX" | "US_EQUITIES",
  ): Promise<PersistedInstrument[]> {
    this.upsertMarkets.push(marketId);
    return values.map((value) => ({
      ...value,
      id: `id-${value.symbolId}`,
      active: true,
    }));
  }
  async listActiveInstruments(): Promise<PersistedInstrument[]> {
    return [];
  }
  async markBenchmarks(roles: BenchmarkRole[]): Promise<void> {
    this.marked.push(roles);
  }
  async saveQuotes(): Promise<void> {}
  async saveCandles(): Promise<void> {}
}

describe("stable benchmark service", () => {
  it.each(["ambiguous", "wrong currency", "unknown venue", "not quotable"])(
    "leaves an %s US benchmark unresolved instead of choosing an unsafe match",
    async (condition) => {
      const repository = new Repository();
      const adapter = new Adapter();
      const value = {
        ...instruments[0]!,
        symbol: "SPY",
        exchange: "ARCA",
        currency: "USD",
      };
      adapter.searchSymbols = async () =>
        condition === "ambiguous"
          ? [value, { ...value, symbolId: 9999 }]
          : [
              {
                ...value,
                ...(condition === "wrong currency"
                  ? { currency: "CAD" }
                  : condition === "unknown venue"
                    ? { exchange: "UNKNOWN" }
                    : { isQuotable: false }),
              },
            ];
      const result = await new ConfiguredBenchmarkService(
        adapter,
        repository,
        "SPY",
        {},
        "US_EQUITIES",
      ).resolve();
      expect(result.instruments).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(repository.marked.at(-1)).toEqual([]);
    },
  );
  it("resolves a catalog independent from the daily candidate list", async () => {
    const repository = new Repository();
    const service = new ConfiguredBenchmarkService(
      new Adapter(),
      repository,
      "XIU.TO",
      { "Basic Materials": "XMA.TO" },
    );
    const first = await service.resolve();
    const second = await service.resolve();
    expect(
      first.references.map((value) => [value.kind, value.symbol, value.sector]),
    ).toEqual([
      ["MARKET", "XIU.TO", null],
      ["SECTOR", "XMA.TO", "Basic Materials"],
    ]);
    expect(second.references).toEqual(first.references);
    expect(first.instruments.map((value) => value.symbol)).toEqual([
      "XIU.TO",
      "XMA.TO",
    ]);
    expect(first.warnings).toEqual([]);
    expect(repository.marked.at(-1)).toEqual([
      { symbolId: 2001, kind: "MARKET", sector: null },
      { symbolId: 2002, kind: "SECTOR", sector: "Basic Materials" },
    ]);
  });

  it("reports an unresolved benchmark without substituting a candidate", async () => {
    const repository = new Repository();
    const result = await new ConfiguredBenchmarkService(
      new Adapter(),
      repository,
      "MISSING.TO",
      {},
    ).resolve();
    expect(repository.marked.at(-1)).toEqual([]);
    expect(result.instruments).toEqual([]);
    expect(result.references[0]).toMatchObject({
      kind: "MARKET",
      symbol: "MISSING.TO",
      instrument: undefined,
    });
    expect(result.warnings).toEqual([
      "MARKET benchmark MISSING.TO could not be resolved",
    ]);
  });

  it("persists US benchmarks only in the US market namespace", async () => {
    const repository = new Repository();
    const usInstruments: Instrument[] = [
      {
        symbol: "SPY",
        symbolId: 3101,
        description: "US market",
        securityType: "ETF",
        exchange: "NYSE_ARCA",
        currency: "USD",
        isQuotable: true,
        isTradable: true,
      },
    ];
    const adapter = new Adapter();
    adapter.searchSymbols = async (prefix: string) =>
      usInstruments.filter((instrument) => instrument.symbol === prefix);
    const result = await new ConfiguredBenchmarkService(
      adapter,
      repository,
      "SPY",
      {},
      "US_EQUITIES",
    ).resolve();
    expect(repository.upsertMarkets).toEqual(["US_EQUITIES"]);
    expect(result.instruments).toMatchObject([
      { symbol: "SPY", exchange: "NYSE_ARCA", currency: "USD" },
    ]);
  });
});
