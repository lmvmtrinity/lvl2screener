import {
  fastFunnelStatusSchema,
  type FastFunnelStatus,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { CatalogMember } from "./eodhd-catalog.js";
import type { TradingViewScannerClient } from "./tradingview-scanner-client.js";

export interface FastFunnelOptions {
  marketId: MarketId;
  tvClient: TradingViewScannerClient;
  enabled?: boolean;
  topMoversLimit?: number;
  cacheTtlMs?: number;
  clock?: () => Date;
  logger?: {
    info(fields: Record<string, unknown>): void;
    warn(fields: Record<string, unknown>): void;
    error(fields: Record<string, unknown>): void;
  };
}

const DEFAULT_MOVERS_LIMIT = 50;
const DEFAULT_CACHE_TTL_MS = 60_000;

export class FastFunnelAccelerator {
  private readonly marketId: MarketId;
  private readonly tvClient: TradingViewScannerClient;
  private readonly enabled: boolean;
  private readonly topMoversLimit: number;
  private readonly cacheTtlMs: number;
  private readonly clock: () => Date;
  private readonly logger?: FastFunnelOptions["logger"];

  private cachedTopMovers: string[] = [];
  private cacheTimestamp = 0;
  private lastAcceleratedAt: string | null = null;
  private acceleratedCandidatesCount = 0;
  private acceleratedEvaluatedCount = 0;
  private acceleratedPassedCount = 0;

  constructor(options: FastFunnelOptions) {
    this.marketId = options.marketId;
    this.tvClient = options.tvClient;
    this.enabled = options.enabled ?? false;
    this.topMoversLimit = options.topMoversLimit ?? DEFAULT_MOVERS_LIMIT;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Fetches top active movers across the exchange in a single bulk request,
   * caching the result for 60 seconds to avoid duplicate network round trips.
   */
  async getTopMovers(): Promise<string[]> {
    if (!this.enabled) return [];

    const now = this.clock().getTime();
    if (
      this.cacheTimestamp > 0 &&
      now - this.cacheTimestamp < this.cacheTtlMs
    ) {
      return this.cachedTopMovers;
    }

    try {
      const candidates = await this.tvClient.fetchTopMovers(this.marketId, {
        limit: this.topMoversLimit,
      });

      const symbols = candidates.map((c) => c.symbol.toUpperCase());
      this.cachedTopMovers = symbols;
      this.cacheTimestamp = now;
      this.lastAcceleratedAt = this.clock().toISOString();

      this.logger?.info({
        event: "FAST_FUNNEL_TOP_MOVERS_FETCHED",
        marketId: this.marketId,
        count: symbols.length,
        symbols: symbols.slice(0, 10),
      });

      return symbols;
    } catch (error) {
      this.logger?.warn({
        event: "FAST_FUNNEL_TOP_MOVERS_FETCH_FAILED",
        marketId: this.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.cachedTopMovers;
    }
  }

  /**
   * Reorders catalog members so that active movers identified by the screener
   * are placed at the front of the queue, solving the Questrade rate limit
   * and 120s queue timeout bottlenecks while preserving full broker verification.
   */
  prioritizeCatalogMembers(
    members: readonly CatalogMember[],
    topMoverSymbols: readonly string[],
  ): CatalogMember[] {
    if (topMoverSymbols.length === 0) return [...members];

    const memberByCode = new Map<string, CatalogMember>();

    for (const member of members) {
      memberByCode.set(member.providerCode.toUpperCase(), member);
    }

    const prioritized: CatalogMember[] = [];
    const addedCodes = new Set<string>();

    // 1. Add top movers in order of momentum/RVOL
    for (const mover of topMoverSymbols) {
      const code = mover.toUpperCase();
      const member = memberByCode.get(code);
      if (member && !addedCodes.has(code)) {
        prioritized.push(member);
        addedCodes.add(code);
      }
    }

    this.acceleratedCandidatesCount = prioritized.length;

    // 2. Append remaining catalog members in standard order
    for (const member of members) {
      const code = member.providerCode.toUpperCase();
      if (!addedCodes.has(code)) {
        prioritized.push(member);
      }
    }

    return prioritized;
  }

  recordCycleResults(results: {
    acceleratedCount: number;
    evaluatedCount: number;
    passedCount: number;
  }): void {
    // All three counters describe the same cycle so the dashboard never mixes
    // a per-cycle candidate count with lifetime evaluation totals.
    this.acceleratedCandidatesCount = results.acceleratedCount;
    this.acceleratedEvaluatedCount = results.evaluatedCount;
    this.acceleratedPassedCount = results.passedCount;
  }

  getStatus(): FastFunnelStatus {
    return fastFunnelStatusSchema.parse({
      marketId: this.marketId,
      enabled: this.enabled,
      lastAcceleratedAt: this.lastAcceleratedAt,
      topMoversCount: this.cachedTopMovers.length,
      topMoverSymbols: this.cachedTopMovers,
      acceleratedCandidatesCount: this.acceleratedCandidatesCount,
      acceleratedEvaluatedCount: this.acceleratedEvaluatedCount,
      acceleratedPassedCount: this.acceleratedPassedCount,
    });
  }
}
