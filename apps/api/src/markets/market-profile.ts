import type {
  MarketId,
  MarketCurrency,
  NormalizedExchange,
} from "@tsx-scanner/contracts";
import type { ApiConfig } from "../config.js";

export interface MarketProfile {
  id: MarketId;
  currency: MarketCurrency;
  timezone: "America/Toronto" | "America/New_York";
  providerMarketKey: string;
  allowedExchangeCodes: readonly Exclude<NormalizedExchange, "UNKNOWN">[];
  benchmarkSymbol: string;
  sectorBenchmarkSymbols: Readonly<Record<string, string>>;
  enabled: boolean;
  marketDataEnabled: boolean;
  paperTradingEnabled: boolean;
}

/**
 * The sole registry for domain-level market facts. Raw broker exchange aliases
 * are intentionally not inferred here; they are normalized at the adapter
 * boundary and unknown values fail closed.
 */
export function createMarketProfiles(
  config: ApiConfig,
): Readonly<Record<MarketId, MarketProfile>> {
  const usEnabled = config.ENABLED_MARKETS.includes("US_EQUITIES");
  return {
    CA_TSX: {
      id: "CA_TSX",
      currency: "CAD",
      timezone: "America/Toronto",
      providerMarketKey: "TSX",
      allowedExchangeCodes: ["TSX"],
      benchmarkSymbol: config.MARKET_BENCHMARK_SYMBOL,
      sectorBenchmarkSymbols: config.SECTOR_BENCHMARK_SYMBOLS,
      enabled: config.ENABLED_MARKETS.includes("CA_TSX"),
      marketDataEnabled: true,
      paperTradingEnabled: true,
    },
    US_EQUITIES: {
      id: "US_EQUITIES",
      currency: "USD",
      timezone: "America/New_York",
      providerMarketKey: "US",
      allowedExchangeCodes: [
        "NASDAQ",
        "NYSE",
        "NYSE_AMERICAN",
        "NYSE_ARCA",
        "CBOE_BZX",
      ],
      benchmarkSymbol: config.US_MARKET_BENCHMARK_SYMBOL,
      sectorBenchmarkSymbols: config.US_SECTOR_BENCHMARK_SYMBOLS,
      enabled: usEnabled,
      marketDataEnabled: usEnabled && config.US_MARKET_DATA_ENABLED,
      paperTradingEnabled: usEnabled && config.US_PAPER_TRADING_ENABLED,
    },
  };
}
