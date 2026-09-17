/**
 * Economic-viability evaluation for a candidate paper entry
 * (docs/paper-bot-performance-improvement-plan.md, Phase 2). Pure: no clock,
 * database, or network access, so live execution and chronological replay
 * reach the same decision from the same facts.
 *
 * The mandatory invariant is that a trade must be able to make money at its
 * own modeled target after modeled friction. Everything else is a configured
 * threshold recorded alongside its inputs, so a rejection can be audited and
 * re-derived rather than merely believed.
 */
import {
  applyExitSlippage,
  costSnapshotOf,
  roundMoney,
  roundPrice,
  roundTripCosts,
} from "./financials.js";
import { tickSizeForMarket } from "../market-data/tick-policy.js";
import type { MarketId } from "@tsx-scanner/contracts";
import type {
  AssumptionsSnapshot,
  DistanceMeasures,
  EconomicsGates,
  EconomicsRejectionReason,
  ExecutionEconomics,
} from "./types.js";

export const ECONOMICS_POLICY_VERSION = "paper-economics-v1";

/**
 * Applied when a run's immutable assumptions carry no gate configuration:
 * every legacy cohort keeps exactly the behaviour it was generated under,
 * except for the mandatory positive-target invariant, which is unconditional.
 */
export const MANDATORY_ECONOMICS_GATES: EconomicsGates = {
  minNetRewardRisk: 0,
  minStopFrictionMultiple: 0,
  minTargetFrictionMultiple: 0,
  maxSpreadPct: Number.MAX_VALUE,
};

/** TSX trading increments: half a cent below $0.50, a cent at or above it. */
export function tickSize(price: number, marketId: MarketId = "CA_TSX"): number {
  const size = tickSizeForMarket(marketId, price);
  if (size === null)
    throw new Error("Cannot derive tick size for an invalid price");
  return size;
}

export interface EconomicsInput {
  readonly marketId?: MarketId;
  readonly executableEntryPrice: number;
  readonly stop: number;
  readonly target: number;
  readonly shares: number;
  /** Quoted spread at the decision; null for the candle model. */
  readonly spread: number | null;
  readonly assumptions: Pick<
    AssumptionsSnapshot,
    "feePerTrade" | "slippageBps" | "costs" | "economics"
  >;
}

function distance(
  dollarsPerShare: number,
  entryPrice: number,
  spread: number | null,
  frictionPerShare: number,
  marketId: MarketId,
): DistanceMeasures {
  return {
    dollars: roundMoney(dollarsPerShare),
    percent: roundMoney((dollarsPerShare / entryPrice) * 100),
    ticks: roundMoney(dollarsPerShare / tickSize(entryPrice, marketId)),
    spreadMultiples:
      spread === null || spread <= 0
        ? null
        : roundMoney(dollarsPerShare / spread),
    frictionMultiples:
      frictionPerShare <= 0
        ? Number.POSITIVE_INFINITY
        : roundMoney(dollarsPerShare / frictionPerShare),
  };
}

/**
 * Evaluates one candidate entry and returns its full economic picture,
 * including every threshold it failed. The caller decides what to do with a
 * non-empty `rejections`; this function never throws on an unviable trade.
 */
export function evaluateEconomics(input: EconomicsInput): ExecutionEconomics {
  const { executableEntryPrice: entry, stop, target, shares, spread } = input;
  const costs = costSnapshotOf(input.assumptions);
  const fixedCosts = roundTripCosts(input.assumptions);
  const gates = input.assumptions.economics ?? MANDATORY_ECONOMICS_GATES;

  // Entry slippage is already inside `entry`; the exit side is charged again
  // here so a stop is measured at the price a market sell would realistically
  // receive rather than at the trigger price itself.
  const conservativeStopExitPrice = applyExitSlippage(stop, costs.slippageBps);
  const slippagePerShare = roundPrice(stop * (costs.slippageBps / 10_000));
  // Per-share friction is what the trade must clear before any distance is
  // real profit: the spread it crosses plus both slippage legs. It is defined
  // for the candle model too, which has no book but does model slippage.
  const frictionPerShare =
    (spread ?? 0) +
    slippagePerShare +
    roundPrice(entry * (costs.slippageBps / 10_000)) +
    (shares > 0 ? fixedCosts / shares : 0);

  const expectedTargetNetPnl = roundMoney(
    (target - entry) * shares - fixedCosts,
  );
  const expectedStopNetPnl = roundMoney(
    (conservativeStopExitPrice - entry) * shares - fixedCosts,
  );
  const netRewardRisk =
    expectedStopNetPnl >= 0
      ? null
      : roundMoney(expectedTargetNetPnl / -expectedStopNetPnl);

  const marketId =
    input.marketId ??
    (input.assumptions.costs?.currency === "USD" ? "US_EQUITIES" : "CA_TSX");
  const stopDistance = distance(
    entry - stop,
    entry,
    spread,
    frictionPerShare,
    marketId,
  );
  const targetDistance = distance(
    target - entry,
    entry,
    spread,
    frictionPerShare,
    marketId,
  );
  const spreadPct = spread === null ? null : roundMoney((spread / entry) * 100);

  // Stable priority order: the mandatory invariant first, then the market
  // condition, then structure, then the composite ratio. Reports and tests
  // depend on the first element being the primary reason.
  const rejections: EconomicsRejectionReason[] = [];
  if (expectedTargetNetPnl <= 0) rejections.push("NET_TARGET_NON_POSITIVE");
  if (spreadPct !== null && spreadPct > gates.maxSpreadPct)
    rejections.push("SPREAD_COST_TOO_HIGH");
  if (stopDistance.frictionMultiples < gates.minStopFrictionMultiple)
    rejections.push("STOP_DISTANCE_TOO_SMALL");
  if (targetDistance.frictionMultiples < gates.minTargetFrictionMultiple)
    rejections.push("TARGET_DISTANCE_TOO_SMALL");
  if (netRewardRisk === null || netRewardRisk < gates.minNetRewardRisk)
    rejections.push("NET_REWARD_RISK_TOO_LOW");

  return {
    policyVersion: ECONOMICS_POLICY_VERSION,
    executableEntryPrice: entry,
    shares,
    stop,
    target,
    expectedTargetExitPrice: roundPrice(target),
    expectedTargetExitValue: roundMoney(target * shares),
    conservativeStopExitPrice,
    conservativeStopExitValue: roundMoney(conservativeStopExitPrice * shares),
    expectedTargetNetPnl,
    expectedStopNetPnl,
    netRewardRisk,
    stopDistance,
    targetDistance,
    spread,
    spreadPct,
    frictionPerShare: roundMoney(frictionPerShare),
    fixedCosts,
    costs,
    gates,
    rejections,
  };
}

/** The reason a caller should persist, or `null` when the entry is viable. */
export function primaryRejection(
  economics: ExecutionEconomics,
): EconomicsRejectionReason | null {
  return economics.rejections[0] ?? null;
}
