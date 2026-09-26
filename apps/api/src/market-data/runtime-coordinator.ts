import type { MarketId } from "@tsx-scanner/contracts";
import type { QuestradeDataService } from "./service.js";

export interface MarketRuntime {
  marketId: MarketId;
  service: QuestradeDataService;
}

/**
 * Lifecycle owner for independent market runtimes. It deliberately shares no
 * scanner state: shared Questrade authentication/rate limiting is injected
 * into each service by composition, while sessions, universe state,
 * benchmarks, and recovery lifecycles remain per-market.
 */
export class MarketRuntimeCoordinator {
  private readonly runtimes = new Map<MarketId, QuestradeDataService>();
  private readonly initialized = new Set<MarketId>();

  constructor(values: readonly MarketRuntime[]) {
    for (const value of values) {
      if (this.runtimes.has(value.marketId))
        throw new Error(`Duplicate market runtime: ${value.marketId}`);
      this.runtimes.set(value.marketId, value.service);
    }
  }

  get(marketId: MarketId): QuestradeDataService {
    const runtime = this.runtimes.get(marketId);
    if (!runtime) throw new Error(`Market runtime is not enabled: ${marketId}`);
    return runtime;
  }

  enabledMarkets(): MarketId[] {
    return [...this.runtimes.keys()];
  }

  /** Markets that have successfully initialized and are safe to start. */
  initializedMarkets(): MarketId[] {
    return [...this.initialized];
  }

  /**
   * Initializes every enabled runtime. A single market failure is never
   * reported as global success: any failure throws an aggregated error naming
   * each failed market, while successful markets remain marked initialized and
   * isolated. Retry failed markets explicitly via {@link initializeMarket}.
   */
  async initialize(): Promise<void> {
    const entries = [...this.runtimes.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([marketId, runtime]) => {
        try {
          await runtime.initialize();
          this.initialized.add(marketId);
        } catch (error) {
          this.initialized.delete(marketId);
          throw new Error(
            `Failed to initialize runtime for ${marketId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (rejected.length > 0) {
      const detail = rejected
        .map((result) =>
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        )
        .join("; ");
      throw new Error(
        `Market initialization incomplete (${rejected.length}/${entries.length} failed): ${detail}`,
      );
    }
  }

  /**
   * Explicit recovery path for one market. Retries only the requested runtime
   * so a healthy market is never re-initialized as a side effect.
   */
  async initializeMarket(marketId: MarketId): Promise<void> {
    const runtime = this.runtimes.get(marketId);
    if (!runtime) throw new Error(`Market runtime is not enabled: ${marketId}`);
    try {
      await runtime.initialize();
      this.initialized.add(marketId);
    } catch (error) {
      this.initialized.delete(marketId);
      throw new Error(
        `Failed to initialize runtime for ${marketId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Starts only initialized runtimes; failed markets require explicit recovery. */
  start(): void {
    for (const [marketId, runtime] of this.runtimes.entries()) {
      if (this.initialized.has(marketId)) runtime.start();
    }
  }

  /** Starts one initialized runtime explicitly. */
  startMarket(marketId: MarketId): void {
    if (!this.initialized.has(marketId))
      throw new Error(
        `Cannot start uninitialized runtime for ${marketId}: call initializeMarket first`,
      );
    this.runtimes.get(marketId)!.start();
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => runtime.stop()),
    );
  }
}
