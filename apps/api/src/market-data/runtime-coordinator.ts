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

  async initialize(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.runtimes.entries()].map(async ([marketId, runtime]) => {
        try {
          await runtime.initialize();
        } catch (error) {
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
    if (rejected.length === this.runtimes.size && this.runtimes.size > 0) {
      throw rejected[0]!.reason;
    }
  }

  start(): void {
    for (const runtime of this.runtimes.values()) runtime.start();
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => runtime.stop()),
    );
  }
}
