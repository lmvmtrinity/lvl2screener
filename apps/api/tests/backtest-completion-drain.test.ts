import { describe, expect, it, vi } from "vitest";
import { drainBacktestCompletionMarkets } from "../src/worker/backtest-completion-drain.js";

describe("backtest completion drain", () => {
  it("continues to the second market when the first cycle fails", async () => {
    const runCycle = vi.fn(async (marketId: string) => {
      if (marketId === "CA_TSX") throw new Error("CA failure");
    });
    const logError = vi.fn();
    await drainBacktestCompletionMarkets(
      ["CA_TSX", "US_EQUITIES"],
      runCycle,
      logError,
    );
    expect(runCycle.mock.calls.map(([marketId]) => marketId)).toEqual([
      "CA_TSX",
      "US_EQUITIES",
    ]);
    expect(logError).toHaveBeenCalledWith({
      event: "BACKTEST_AUTOMATION_COMPLETION_DRAIN_FAILED",
      marketId: "CA_TSX",
      error: "CA failure",
    });
  });
});
