import { describe, expect, it, vi } from "vitest";
import { MarketRuntimeCoordinator } from "../src/market-data/runtime-coordinator.js";

function runtime(impl?: { initialize?: () => Promise<void> }) {
  return {
    initialize: vi.fn(impl?.initialize ?? (async () => undefined)),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
}

describe("MarketRuntimeCoordinator partial initialization", () => {
  it("a single failed market is not reported as globally started", async () => {
    const ca = runtime();
    const us = runtime({
      initialize: async () => {
        throw new Error("US universe refresh failed");
      },
    });
    const coordinator = new MarketRuntimeCoordinator([
      { marketId: "CA_TSX", service: ca as never },
      { marketId: "US_EQUITIES", service: us as never },
    ]);

    await expect(coordinator.initialize()).rejects.toThrow(/US_EQUITIES/);
  });

  it("preserves market isolation and offers an explicit recovery path", async () => {
    const ca = runtime();
    const us = runtime({
      initialize: async () => {
        throw new Error("US auth failed");
      },
    });
    const coordinator = new MarketRuntimeCoordinator([
      { marketId: "CA_TSX", service: ca as never },
      { marketId: "US_EQUITIES", service: us as never },
    ]);

    await expect(coordinator.initialize()).rejects.toThrow();
    // The failed runtime must be retryable without re-running the healthy one.
    expect(
      typeof (coordinator as unknown as Record<string, unknown>)[
        "initializeMarket"
      ],
    ).toBe("function");
    const typed = coordinator as unknown as {
      initializeMarket: (marketId: "CA_TSX" | "US_EQUITIES") => Promise<void>;
      initializedMarkets: () => Array<"CA_TSX" | "US_EQUITIES">;
    };
    expect(typed.initializedMarkets()).toEqual(["CA_TSX"]);

    us.initialize.mockImplementation(async () => undefined);
    await typed.initializeMarket("US_EQUITIES");
    expect(typed.initializedMarkets().sort()).toEqual([
      "CA_TSX",
      "US_EQUITIES",
    ]);
    expect(ca.initialize).toHaveBeenCalledTimes(1);
    expect(us.initialize).toHaveBeenCalledTimes(2);
  });

  it("succeeds only when every runtime initializes", async () => {
    const ca = runtime();
    const us = runtime();
    const coordinator = new MarketRuntimeCoordinator([
      { marketId: "CA_TSX", service: ca as never },
      { marketId: "US_EQUITIES", service: us as never },
    ]);
    await coordinator.initialize();
    const typed = coordinator as unknown as {
      initializedMarkets: () => string[];
    };
    expect(typed.initializedMarkets().sort()).toEqual([
      "CA_TSX",
      "US_EQUITIES",
    ]);
  });
});
