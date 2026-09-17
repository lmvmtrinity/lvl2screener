import type {
  AssumptionsSnapshot,
  ClosingFinancials,
  ExecutionCostSnapshot,
} from "./types.js";

/**
 * Rounding matches the existing Python backtester
 * (services/scanner/app/backtest.py): prices to 6 decimals, money to 4
 * decimals, R-multiple to 6 decimals. Historical and forward evidence must
 * agree bit-for-bit on these rules or they cease to be comparable.
 */
const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export const roundPrice = (value: number): number => roundTo(value, 6);
export const roundMoney = (value: number): number => roundTo(value, 4);
export const roundR = (value: number): number => roundTo(value, 6);

/** Maps legacy immutable snapshots into the explicit v2 cost contract. */
export function costSnapshotOf(
  assumptions: Pick<
    AssumptionsSnapshot,
    "feePerTrade" | "slippageBps" | "costs"
  >,
): ExecutionCostSnapshot {
  return (
    assumptions.costs ?? {
      entryCommission: 0,
      exitCommission: assumptions.feePerTrade,
      estimatedRegulatoryFees: 0,
      slippageBps: assumptions.slippageBps,
      currency: "CAD",
      brokerPricingVersion: "legacy-fee-per-trade-v1",
    }
  );
}

/**
 * Maximum cash debit reserved for a funded entry when the caller did not
 * supply an explicit replay value. Notional caps remain notional caps; the
 * fixed entry commission is reserved in addition to the tighter cap so a
 * full-capacity fill cannot be vetoed merely because its fee was omitted from
 * the reservation.
 */
export function fundedReservationDebit(
  assumptions: Pick<
    AssumptionsSnapshot,
    "positionSize" | "maxNotional" | "feePerTrade" | "slippageBps" | "costs"
  >,
): number {
  const effectiveNotional = Math.min(
    assumptions.positionSize,
    assumptions.maxNotional ?? Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(effectiveNotional) || effectiveNotional <= 0)
    throw new Error("Invalid funded notional cap");
  return roundMoney(
    effectiveNotional + costSnapshotOf(assumptions).entryCommission,
  );
}

export function roundTripCosts(
  assumptions: Pick<
    AssumptionsSnapshot,
    "feePerTrade" | "slippageBps" | "costs"
  >,
): number {
  const costs = costSnapshotOf(assumptions);
  return roundMoney(
    costs.entryCommission +
      costs.exitCommission +
      costs.estimatedRegulatoryFees,
  );
}

/** `ask * (1 + slippageBps / 10_000)` for a buy, or the bid-side mirror for a sell. */
export function applyEntrySlippage(
  askPrice: number,
  slippageBps: number,
): number {
  return roundPrice(askPrice * (1 + slippageBps / 10_000));
}

export function applyExitSlippage(
  bidPrice: number,
  slippageBps: number,
): number {
  return roundPrice(bidPrice * (1 - slippageBps / 10_000));
}

/**
 * Net P&L subtracts `feePerTrade` exactly once per closed trade (round-trip
 * fee), matching the assumptions contract used by the existing backtester.
 */
export function computeClosingFinancials(
  entryPrice: number,
  exitPrice: number,
  shares: number,
  initialRisk: number,
  costs:
    number | Pick<AssumptionsSnapshot, "feePerTrade" | "slippageBps" | "costs">,
): ClosingFinancials {
  const grossPnl = roundMoney((exitPrice - entryPrice) * shares);
  const netPnl = roundMoney(
    grossPnl - (typeof costs === "number" ? costs : roundTripCosts(costs)),
  );
  const rMultiple = roundR(netPnl / initialRisk);
  return { exitPrice: roundPrice(exitPrice), grossPnl, netPnl, rMultiple };
}
