import {
  applyExitSlippage,
  roundMoney,
  roundPrice,
  roundTripCosts,
} from "./financials.js";
import type {
  AssumptionsSnapshot,
  EntrySizingResult,
  LevelDerivationResult,
  SignalFact,
  SizingCap,
  SizingContext,
} from "./types.js";

/**
 * Shared level derivation (private development record, "Shared level and
 * sizing derivation"). Identical for the quote and candle models: only the
 * entry price and share count differ per model, computed separately by each
 * model's own entry logic via `sizeEntry` below.
 */
export function deriveStopAndTarget(
  signal: SignalFact,
  assumptions: AssumptionsSnapshot,
): LevelDerivationResult {
  if (signal.entryReference === null) {
    return { ok: false, noFillReason: "MISSING_REFERENCE" };
  }

  let stop: number | null;
  if (assumptions.stopMethod === "ATR") {
    if (signal.atr14 === null) {
      return { ok: false, noFillReason: "MISSING_REFERENCE" };
    }
    stop = signal.entryReference - signal.atr14 * assumptions.atrStopMultiple;
  } else {
    stop = signal.stopReference;
  }
  if (stop === null) {
    return { ok: false, noFillReason: "MISSING_REFERENCE" };
  }

  let target: number | null;
  if (assumptions.rewardRiskRatio !== null) {
    target =
      signal.entryReference +
      (signal.entryReference - stop) * assumptions.rewardRiskRatio;
  } else {
    target = signal.targetReference;
  }
  if (target === null) {
    return { ok: false, noFillReason: "MISSING_REFERENCE" };
  }

  return { ok: true, stop: roundPrice(stop), target: roundPrice(target) };
}

export interface SizeEntryInput {
  /** Model-specific executable entry, already including entry slippage. */
  readonly entryPrice: number;
  readonly stop: number;
  readonly target: number;
  readonly positionSize: number;
  readonly fixedCosts: number;
  /**
   * The price a stop-out is modeled to actually realize. Defaults to the stop
   * itself, which is what pre-v2 cohorts were generated with; v2 callers pass
   * the slippage-adjusted exit so size reflects the real loss per share.
   */
  readonly stopExitPrice?: number;
  readonly riskBudget?: number;
  readonly maxNotional?: number;
  readonly context?: SizingContext;
}

const floorNonNegative = (value: number, perShare: number): number =>
  perShare <= 0
    ? Number.POSITIVE_INFINITY
    : Math.floor(Math.max(0, value) / perShare);

/**
 * Sizes an entry against already-derived stop/target levels
 * (docs/paper-bot-performance-improvement-plan.md, Phase 3). Shares come from
 * a bounded dollar-risk budget and are then reduced by every configured cap;
 * each cap that actually bound the size is reported in `sizing.appliedCaps`,
 * in the order it applied, so a small position is explainable after the fact.
 */
export function sizeEntry(input: SizeEntryInput): EntrySizingResult {
  const { entryPrice, stop, target, positionSize, fixedCosts } = input;
  if (!(stop < entryPrice && entryPrice < target)) {
    return { ok: false, noFillReason: "EXECUTABLE_PRICE_OUTSIDE_LEVELS" };
  }
  const stopExitPrice = input.stopExitPrice ?? stop;
  const costInclusiveLossPerShare = entryPrice - stopExitPrice;
  const context = input.context ?? {};

  const limits: { readonly cap: SizingCap; readonly shares: number }[] = [];
  if (input.riskBudget !== undefined) {
    limits.push({
      cap: "RISK_BUDGET",
      shares: floorNonNegative(
        input.riskBudget - fixedCosts,
        costInclusiveLossPerShare,
      ),
    });
  }
  limits.push({
    cap: "POSITION_NOTIONAL",
    shares: Math.floor(positionSize / entryPrice),
  });
  if (input.maxNotional !== undefined) {
    limits.push({
      cap: "MAX_NOTIONAL",
      shares: Math.floor(input.maxNotional / entryPrice),
    });
  }
  const participation =
    context.maxDisplayedSizeParticipation ??
    (context.executionMode === "CAPACITY_CONSTRAINED" ? 1.0 : undefined);
  if (context.displayedSize !== undefined && participation !== undefined) {
    limits.push({
      cap: "DISPLAYED_SIZE_PARTICIPATION",
      shares: Math.floor(context.displayedSize * participation),
    });
  }
  if (context.maxSymbolNotional !== undefined) {
    limits.push({
      cap: "SYMBOL_EXPOSURE",
      shares: floorNonNegative(
        context.maxSymbolNotional - (context.openSymbolNotional ?? 0),
        entryPrice,
      ),
    });
  }
  if (context.maxSectorNotional !== undefined) {
    limits.push({
      cap: "SECTOR_EXPOSURE",
      shares: floorNonNegative(
        context.maxSectorNotional - (context.openSectorNotional ?? 0),
        entryPrice,
      ),
    });
  }
  if (context.maxPortfolioRisk !== undefined) {
    limits.push({
      cap: "PORTFOLIO_RISK",
      shares: floorNonNegative(
        context.maxPortfolioRisk -
          (context.openPortfolioRisk ?? 0) -
          fixedCosts,
        costInclusiveLossPerShare,
      ),
    });
  }

  const appliedCaps: SizingCap[] = [];
  let shares = Number.POSITIVE_INFINITY;
  for (const limit of limits) {
    if (limit.shares < shares) {
      shares = limit.shares;
      appliedCaps.push(limit.cap);
    }
  }
  const uncappedShares =
    input.riskBudget === undefined
      ? Math.floor(positionSize / entryPrice)
      : floorNonNegative(
          input.riskBudget - fixedCosts,
          costInclusiveLossPerShare,
        );
  if (shares < 1) {
    return { ok: false, noFillReason: "SHARES_BELOW_ONE" };
  }
  return {
    ok: true,
    executableEntryPrice: roundPrice(entryPrice),
    shares,
    initialRisk: roundMoney(costInclusiveLossPerShare * shares),
    sizing: {
      requestedRisk: roundMoney(
        input.riskBudget ?? uncappedShares * costInclusiveLossPerShare,
      ),
      estimatedRisk: roundMoney(costInclusiveLossPerShare * shares),
      costInclusiveLossPerShare: roundPrice(costInclusiveLossPerShare),
      uncappedShares,
      shares,
      unfilledShares: Math.max(0, uncappedShares - shares),
      appliedCaps,
    },
  };
}

/**
 * v2 wrapper that maps explicit costs and bounded dollar risk into the
 * deterministic sizing primitive above. Legacy snapshots (no `costs`) keep
 * their original stop-price risk basis so historic cohorts stay comparable;
 * v2 snapshots size against the slippage-adjusted stop exit and carry fixed
 * costs inside initial risk, which is also the R denominator.
 */
export function sizeEntryWithAssumptions(
  entryPrice: number,
  stop: number,
  target: number,
  assumptions: AssumptionsSnapshot,
  context?: SizingContext,
): EntrySizingResult {
  const fixedCosts = roundTripCosts(assumptions);
  const effectiveContext: SizingContext | undefined =
    context ||
    assumptions.executionMode !== undefined ||
    assumptions.latencyMs !== undefined
      ? {
          executionMode: assumptions.executionMode,
          latencyMs: assumptions.latencyMs,
          ...context,
        }
      : undefined;
  const result = sizeEntry({
    entryPrice,
    stop,
    target,
    positionSize: assumptions.positionSize,
    fixedCosts,
    stopExitPrice:
      assumptions.costs === undefined
        ? stop
        : applyExitSlippage(stop, assumptions.costs.slippageBps),
    riskBudget: assumptions.riskBudget,
    maxNotional: assumptions.maxNotional,
    context: effectiveContext,
  });
  if (!result.ok || assumptions.costs === undefined) return result;
  const initialRisk = roundMoney(result.initialRisk + fixedCosts);
  return {
    ...result,
    initialRisk,
    sizing: { ...result.sizing, estimatedRisk: initialRisk },
  };
}
