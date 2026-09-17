import type { MarketStatus } from "../types.js";

/**
 * Optional keys the API omits while healthy (getSnapshot omits lastError,
 * lastQuoteAt and lastCandleAt instead of sending null). A shallow merge must
 * clear them when the incoming snapshot is silent, otherwise a recovered error
 * keeps rendering from the previous snapshot forever.
 *
 * Per-cycle telemetry fields that WebSocket frames strip on purpose are *not*
 * cleared: a REST status check fills those, and a live frame arriving after it
 * must not erase them.
 */
const CLEARED_WHEN_OMITTED = [
  "lastError",
  "lastQuoteAt",
  "lastCandleAt",
] as const;

export function mergeMarketStatus(
  current: MarketStatus | undefined,
  incoming: MarketStatus,
): MarketStatus {
  const merged: MarketStatus = { ...current, ...incoming };
  for (const key of CLEARED_WHEN_OMITTED) {
    if (!(key in incoming)) delete merged[key];
  }
  return merged;
}
