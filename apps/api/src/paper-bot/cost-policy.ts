import type { MarketId } from "@tsx-scanner/contracts";
import type { ExecutionCostSnapshot } from "./types.js";

/** Effective-dated immutable defaults used only for paper assumptions. */
export const PAPER_COST_POLICY_VERSION = "paper-cost-policy-2026-09-04";

export function costPolicyForMarket(marketId: MarketId): ExecutionCostSnapshot {
  if (marketId === "US_EQUITIES") {
    return {
      entryCommission: 0,
      exitCommission: 0,
      estimatedRegulatoryFees: 0,
      slippageBps: 10,
      currency: "USD",
      brokerPricingVersion: PAPER_COST_POLICY_VERSION,
    };
  }
  return {
    entryCommission: 0,
    exitCommission: 0,
    estimatedRegulatoryFees: 0,
    slippageBps: 10,
    currency: "CAD",
    brokerPricingVersion: PAPER_COST_POLICY_VERSION,
  };
}
