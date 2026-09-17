import type { MarketDataAdapter } from "../questrade/types.js";
import { normalizeExchange } from "../questrade/exchange.js";
import type { MarketId } from "@tsx-scanner/contracts";
import type {
  MarketDataRepository,
  PersistedInstrument,
} from "./repository.js";

export interface BenchmarkReference {
  kind: "MARKET" | "SECTOR";
  symbol: string;
  sector: string | null;
  instrument?: PersistedInstrument;
}

export interface BenchmarkSnapshot {
  references: BenchmarkReference[];
  instruments: PersistedInstrument[];
  warnings: string[];
}

export interface BenchmarkManager {
  resolve(): Promise<BenchmarkSnapshot>;
}

export class ConfiguredBenchmarkService implements BenchmarkManager {
  constructor(
    private readonly adapter: MarketDataAdapter,
    private readonly repository: MarketDataRepository,
    private readonly marketSymbol: string,
    private readonly sectorSymbols: Record<string, string>,
    private readonly marketId: MarketId = "CA_TSX",
  ) {}

  async resolve(): Promise<BenchmarkSnapshot> {
    const configured: Omit<BenchmarkReference, "instrument">[] = [
      { kind: "MARKET", symbol: normalize(this.marketSymbol), sector: null },
      ...Object.entries(this.sectorSymbols).map(([sector, symbol]) => ({
        kind: "SECTOR" as const,
        symbol: normalize(symbol),
        sector,
      })),
    ];
    const uniqueSymbols = [...new Set(configured.map((value) => value.symbol))];
    const resolved = (
      await Promise.all(
        uniqueSymbols.map(async (symbol) => {
          const matches = await this.adapter.searchSymbols(symbol);
          const eligible = matches.filter((value) => {
            const exchange = normalizeExchange(value.exchange);
            return (
              value.symbol.toUpperCase() === symbol &&
              value.isQuotable &&
              value.currency === (this.marketId === "CA_TSX" ? "CAD" : "USD") &&
              (this.marketId === "CA_TSX"
                ? exchange === "TSX"
                : exchange !== "TSX" && exchange !== "UNKNOWN")
            );
          });
          // Provider result ordering is not a resolution rule.
          return eligible.length === 1 ? eligible[0] : undefined;
        }),
      )
    ).filter(
      (value): value is NonNullable<typeof value> => value !== undefined,
    );
    const persisted = await this.repository.upsertInstruments(
      resolved,
      this.marketId,
    );
    const bySymbol = new Map(
      persisted.map((value) => [value.symbol.toUpperCase(), value]),
    );
    const references = configured.map((value) => ({
      ...value,
      instrument: bySymbol.get(value.symbol),
    }));
    await this.repository.markBenchmarks(
      references.flatMap((value) =>
        value.instrument
          ? [
              {
                symbolId: value.instrument.symbolId,
                kind: value.kind,
                sector: value.sector,
              },
            ]
          : [],
      ),
      this.marketId,
    );
    const warnings = references
      .filter((value) => !value.instrument)
      .map(
        (value) =>
          `${value.kind} benchmark ${value.symbol} could not be resolved`,
      );
    return {
      references,
      instruments: [
        ...new Map(
          references.flatMap((value) =>
            value.instrument
              ? [[value.instrument.symbolId, value.instrument] as const]
              : [],
          ),
        ).values(),
      ],
      warnings,
    };
  }
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}
