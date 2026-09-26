import type { MarketId } from "@tsx-scanner/contracts";

/** A failed market must not prevent completion reconciliation for another market. */
export async function drainBacktestCompletionMarkets(
  markets: readonly MarketId[],
  runCycle: (marketId: MarketId) => Promise<unknown>,
  logError: (fields: Record<string, unknown>) => void,
): Promise<void> {
  for (const marketId of markets) {
    try {
      await runCycle(marketId);
    } catch (error) {
      logError({
        event: "BACKTEST_AUTOMATION_COMPLETION_DRAIN_FAILED",
        marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
