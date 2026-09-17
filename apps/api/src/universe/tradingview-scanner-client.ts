import {
  discoveryPolicyForMarket,
  type DiscoveryPolicy,
  type MarketId,
  type TradingViewCandidate,
} from "@tsx-scanner/contracts";

export interface TradingViewScannerOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  baseUrlCanada?: string;
  baseUrlAmerica?: string;
  clock?: () => Date;
  logger?: {
    info(fields: Record<string, unknown>): void;
    warn(fields: Record<string, unknown>): void;
    error(fields: Record<string, unknown>): void;
  };
}

const DEFAULT_SCANNER_URL_CANADA =
  "https://scanner.tradingview.com/canada/scan";
const DEFAULT_SCANNER_URL_AMERICA =
  "https://scanner.tradingview.com/america/scan";
const DEFAULT_TIMEOUT_MS = 10_000;
// The scan response is paginated by `range`. Request a generous page and fail
// visibly when the provider reports more matches so parity never compares
// against a silently truncated candidate list.
const DEFAULT_SCAN_LIMIT = 500;

const SCAN_COLUMNS = [
  "name",
  "description",
  "close",
  "change_from_open",
  "relative_volume_10d_calc",
  "average_volume_90d_calc",
  "market_cap_basic",
  "exchange",
  "type",
] as const;

interface RawTradingViewRow {
  s: string;
  d: unknown[];
}

interface RawTradingViewResponse {
  totalCount?: number;
  data?: RawTradingViewRow[];
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeSymbol(rawTicker: string): {
  exchange: string;
  symbol: string;
  fullSymbol: string;
} {
  const parts = rawTicker.split(":");
  if (parts.length >= 2) {
    const exchange = parts[0]!.trim().toUpperCase();
    const symbol = parts[1]!.trim().toUpperCase();
    return { exchange, symbol, fullSymbol: `${exchange}:${symbol}` };
  }
  return {
    exchange: "",
    symbol: rawTicker.trim().toUpperCase(),
    fullSymbol: rawTicker.trim().toUpperCase(),
  };
}

export class TradingViewScannerClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrlCanada: string;
  private readonly baseUrlAmerica: string;
  private readonly clock: () => Date;
  private readonly logger?: TradingViewScannerOptions["logger"];

  constructor(options: TradingViewScannerOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrlCanada = options.baseUrlCanada ?? DEFAULT_SCANNER_URL_CANADA;
    this.baseUrlAmerica = options.baseUrlAmerica ?? DEFAULT_SCANNER_URL_AMERICA;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger;
  }

  getEndpointForMarket(marketId: MarketId): string {
    return marketId === "CA_TSX" ? this.baseUrlCanada : this.baseUrlAmerica;
  }

  /**
   * Performs a shadow scan matching the user's discovery policy:
   * CA_TSX: TSX common stocks, price 5-150, mcap > 400M, avgVol90d > 400k, RVOL > 1.5, chgFromOpen > 0.75%
   * US_EQUITIES: NYSE/NASDAQ common stocks, price 10-200, mcap > 1B, avgVol90d > 1M, RVOL > 1.75, chgFromOpen > 1%
   */
  async scan(
    marketId: MarketId,
    options: {
      policy?: DiscoveryPolicy;
      limit?: number;
    } = {},
  ): Promise<TradingViewCandidate[]> {
    const policy = options.policy ?? discoveryPolicyForMarket(marketId);
    const limit = options.limit ?? DEFAULT_SCAN_LIMIT;
    const url = this.getEndpointForMarket(marketId);

    const filter: Array<{ left: string; operation: string; right: unknown }> = [
      {
        left: "exchange",
        operation: marketId === "CA_TSX" ? "equal" : "in_range",
        right: marketId === "CA_TSX" ? "TSX" : ["NYSE", "NASDAQ"],
      },
      {
        left: "type",
        operation: "equal",
        right: "stock",
      },
      {
        left: "close",
        operation: "in_range",
        right: [policy.minimumPrice, policy.maximumPrice],
      },
      {
        left: "market_cap_basic",
        operation: "greater",
        right: policy.minimumMarketCap,
      },
      {
        left: "average_volume_90d_calc",
        operation: "greater",
        right: policy.minimumAverageVolume90d,
      },
      {
        left: "relative_volume_10d_calc",
        operation: "greater",
        right: policy.minimumRelativeVolume,
      },
      {
        left: "change_from_open",
        operation: "greater",
        right: policy.minimumChangeFromOpenPct,
      },
    ];

    const body = {
      filter,
      options: { lang: "en" },
      symbols: { query: { types: [] }, tickers: [] },
      columns: [...SCAN_COLUMNS],
      sort: { sortBy: "relative_volume_10d_calc", sortOrder: "desc" },
      range: [0, limit],
    };

    const page = await this.postScan(url, body, marketId);
    if (page.truncated)
      throw new Error(
        `TradingView scan returned ${page.candidates.length} of ${page.totalCount} matching symbols; parity evidence would be truncated`,
      );
    return page.candidates;
  }

  /**
   * Phase 2 Opportunity: Fast Funnel Accelerator
   * Queries top active market movers across the exchange in a single request,
   * sorted by relative volume and momentum within the allowed price and market cap bounds.
   */
  async fetchTopMovers(
    marketId: MarketId,
    options: {
      limit?: number;
      policy?: DiscoveryPolicy;
    } = {},
  ): Promise<TradingViewCandidate[]> {
    const policy = options.policy ?? discoveryPolicyForMarket(marketId);
    const limit = options.limit ?? 50;
    const url = this.getEndpointForMarket(marketId);

    const filter: Array<{ left: string; operation: string; right: unknown }> = [
      {
        left: "exchange",
        operation: marketId === "CA_TSX" ? "equal" : "in_range",
        right: marketId === "CA_TSX" ? "TSX" : ["NYSE", "NASDAQ"],
      },
      {
        left: "type",
        operation: "equal",
        right: "stock",
      },
      {
        left: "close",
        operation: "in_range",
        right: [policy.minimumPrice, policy.maximumPrice],
      },
      {
        left: "market_cap_basic",
        operation: "greater",
        right: policy.minimumMarketCap,
      },
      {
        left: "relative_volume_10d_calc",
        operation: "greater",
        right: 1.0,
      },
    ];

    const body = {
      filter,
      options: { lang: "en" },
      symbols: { query: { types: [] }, tickers: [] },
      columns: [...SCAN_COLUMNS],
      sort: { sortBy: "relative_volume_10d_calc", sortOrder: "desc" },
      range: [0, limit],
    };

    return (await this.postScan(url, body, marketId)).candidates;
  }

  private async postScan(
    url: string,
    body: Record<string, unknown>,
    marketId: MarketId,
  ): Promise<{
    candidates: TradingViewCandidate[];
    totalCount: number;
    truncated: boolean;
  }> {
    const observedAt = this.clock().toISOString();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "TSX-Intraday-Scanner/1.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.logger?.error({
        event: "TRADINGVIEW_SCAN_NETWORK_ERROR",
        marketId,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `TradingView scan request failed: ${error instanceof Error ? error.message : "network error"}`,
      );
    }

    if (!response.ok) {
      this.logger?.warn({
        event: "TRADINGVIEW_SCAN_HTTP_ERROR",
        marketId,
        url,
        status: response.status,
      });
      throw new Error(`TradingView scanner returned HTTP ${response.status}`);
    }

    let payload: RawTradingViewResponse;
    try {
      payload = (await response.json()) as RawTradingViewResponse;
    } catch (error) {
      this.logger?.error({
        event: "TRADINGVIEW_SCAN_PARSE_ERROR",
        marketId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("TradingView scanner returned malformed JSON");
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.totalCount !== "number" ||
      !Number.isInteger(payload.totalCount) ||
      payload.totalCount < 0 ||
      !Array.isArray(payload.data)
    )
      throw new Error("TradingView scanner returned malformed response");

    const rows = payload.data;
    if (
      rows.some(
        (row) =>
          !row ||
          typeof row.s !== "string" ||
          row.s.trim().length === 0 ||
          !Array.isArray(row.d) ||
          row.d.length < 8,
      ) ||
      rows.length > payload.totalCount
    )
      throw new Error("TradingView scanner returned malformed response");
    const candidates: TradingViewCandidate[] = [];

    for (const row of rows) {
      const {
        symbol,
        exchange: symExchange,
        fullSymbol,
      } = normalizeSymbol(row.s);
      const close = parseNumber(row.d[2]);
      const changeFromOpenPct = parseNumber(row.d[3]);
      const relativeVolume = parseNumber(row.d[4]);
      const averageVolume90d = parseNumber(row.d[5]);
      const marketCap = parseNumber(row.d[6]);
      const exchangeFromCol =
        typeof row.d[7] === "string" ? row.d[7].trim().toUpperCase() : "";
      const exchange = symExchange || exchangeFromCol || "UNKNOWN";

      candidates.push({
        symbol,
        exchange,
        fullSymbol,
        price: close,
        changeFromOpenPct,
        relativeVolume,
        averageVolume90d,
        marketCap,
        observedAt,
      });
    }

    const totalCount = payload.totalCount;
    const truncated = rows.length < totalCount;

    this.logger?.info({
      event: "TRADINGVIEW_SCAN_SUCCESS",
      marketId,
      resultCount: candidates.length,
      totalCount,
      truncated,
    });

    return { candidates, totalCount, truncated };
  }
}
