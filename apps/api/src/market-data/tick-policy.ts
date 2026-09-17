import type { MarketId } from "@tsx-scanner/contracts";

/**
 * Versioned, market-scoped price increment policy.  Callers must supply the
 * market when it is known; the CA default preserves immutable legacy replay.
 * Unknown/non-positive prices intentionally fail closed rather than creating
 * a fictitious executable price.
 */
export const TICK_POLICY_VERSION = "market-ticks-v1";

export function tickSizeForMarket(
  marketId: MarketId,
  price: number,
): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  switch (marketId) {
    case "CA_TSX":
      return price < 0.5 ? 0.005 : 0.01;
    case "US_EQUITIES":
      return 0.01;
  }
}
