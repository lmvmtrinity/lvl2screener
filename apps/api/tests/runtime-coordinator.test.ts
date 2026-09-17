import { describe, expect, it, vi } from "vitest";
import { MarketRuntimeCoordinator } from "../src/market-data/runtime-coordinator.js";

function runtime() {
  return {
    initialize: vi.fn(async () => undefined),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
}

describe("MarketRuntimeCoordinator", () => {
  it("starts and stops independent market runtimes without cross-market lookup", async () => {
    const ca = runtime();
    const us = runtime();
    const coordinator = new MarketRuntimeCoordinator([
      { marketId: "CA_TSX", service: ca as never },
      { marketId: "US_EQUITIES", service: us as never },
    ]);
    await coordinator.initialize();
    coordinator.start();
    await coordinator.stop();

    expect(coordinator.enabledMarkets()).toEqual(["CA_TSX", "US_EQUITIES"]);
    expect(coordinator.get("CA_TSX")).toBe(ca);
    expect(ca.initialize).toHaveBeenCalledOnce();
    expect(us.initialize).toHaveBeenCalledOnce();
    expect(ca.start).toHaveBeenCalledOnce();
    expect(us.start).toHaveBeenCalledOnce();
    expect(ca.stop).toHaveBeenCalledOnce();
    expect(us.stop).toHaveBeenCalledOnce();
  });
});
