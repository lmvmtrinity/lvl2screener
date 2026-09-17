import {
  applyEntrySlippage,
  applyExitSlippage,
  computeClosingFinancials,
} from "./financials.js";
import { evaluateEconomics } from "./economics.js";
import {
  deriveStopAndTarget,
  sizeEntryWithAssumptions,
} from "./level-derivation.js";
import type {
  AssumptionsSnapshot,
  CandleEntryResult,
  CandleExitOutcome,
  CandleExitResult,
  CandleFact,
  CandleOpenPosition,
  CandleSessionCloseResult,
  SignalFact,
} from "./types.js";

/**
 * Supplementary one-minute candle entry (private development record,
 * "Supplementary one-minute candle model"). Unlike the quote model, the
 * synthetic entry never depends on a decision-time quote, so the only NO_FILL
 * reasons here come from shared level derivation and sizing.
 */
export function evaluateCandleEntry(
  signal: SignalFact,
  assumptions: AssumptionsSnapshot,
): CandleEntryResult {
  const levels = deriveStopAndTarget(signal, assumptions);
  if (!levels.ok) {
    return {
      status: "NO_FILL",
      noFillReason: levels.noFillReason,
      entryMarketSnapshot: null,
    };
  }

  const syntheticEntryPrice = applyEntrySlippage(
    signal.entryReference as number,
    assumptions.slippageBps,
  );
  const sized = sizeEntryWithAssumptions(
    syntheticEntryPrice,
    levels.stop,
    levels.target,
    assumptions,
  );
  if (!sized.ok) {
    return {
      status: "NO_FILL",
      noFillReason: sized.noFillReason,
      entryMarketSnapshot: null,
    };
  }

  // The candle model has no book, so its economics carry a null spread and
  // gate on modeled slippage alone. Everything else matches the quote model,
  // which is what keeps the two projections comparable.
  const economics = evaluateEconomics({
    marketId: assumptions.costs?.currency === "USD" ? "US_EQUITIES" : "CA_TSX",
    executableEntryPrice: sized.executableEntryPrice,
    stop: levels.stop,
    target: levels.target,
    shares: sized.shares,
    spread: null,
    assumptions,
  });
  const economicsReason = economics.rejections[0];
  if (economicsReason !== undefined) {
    return {
      status: "REJECTED_ECONOMICS",
      economicsReason,
      economics,
      entryMarketSnapshot: null,
    };
  }

  return {
    status: "OPEN",
    economics,
    sizing: sized.sizing,
    entryTime: signal.signalTimestamp,
    stop: levels.stop,
    target: levels.target,
    shares: sized.shares,
    initialRisk: sized.initialRisk,
    syntheticEntryPrice: sized.executableEntryPrice,
  };
}

/**
 * Scans completed candles strictly after the signal (the caller must already
 * have excluded the partially elapsed bar containing the signal, and any bar
 * not yet fully ingested) for the first stop or target trigger. OHLC cannot
 * establish intrabar ordering, so a same-bar collision resolves to STOP.
 */
export function evaluateCandleBars(
  position: CandleOpenPosition,
  candles: readonly CandleFact[],
  assumptions: Pick<AssumptionsSnapshot, "slippageBps" | "feePerTrade">,
): CandleExitResult {
  for (const candle of candles) {
    if (candle.low <= position.stop) {
      // When a candle opens through/below the stop, exit executes at the adverse open
      // price rather than the unattainable higher stop level.
      const triggerPrice = Math.min(candle.open, position.stop);
      const exitPrice = applyExitSlippage(
        triggerPrice,
        assumptions.slippageBps,
      );
      const financials = computeClosingFinancials(
        position.entryPrice,
        exitPrice,
        position.shares,
        position.initialRisk,
        assumptions,
      );
      const exit: CandleExitOutcome = {
        triggered: true,
        exitReason: "STOP",
        exitTime: candle.end,
        financials,
      };
      return exit;
    }
    if (candle.high >= position.target) {
      const financials = computeClosingFinancials(
        position.entryPrice,
        position.target,
        position.shares,
        position.initialRisk,
        assumptions,
      );
      const exit: CandleExitOutcome = {
        triggered: true,
        exitReason: "TARGET",
        exitTime: candle.end,
        financials,
      };
      return exit;
    }
  }
  return { triggered: false };
}

/**
 * Closes at the completed candle ending at the session close. When that candle is not yet
 * ingested, the caller must retry later (across restarts) rather than
 * synthesizing a close from a stale bar.
 */
export function resolveCandleSessionClose(
  position: CandleOpenPosition,
  noonCandle: CandleFact | null,
  assumptions: Pick<AssumptionsSnapshot, "slippageBps" | "feePerTrade">,
): CandleSessionCloseResult {
  if (noonCandle === null) {
    return { status: "CLOSE_PENDING" };
  }
  const exitPrice = applyExitSlippage(
    noonCandle.close,
    assumptions.slippageBps,
  );
  const financials = computeClosingFinancials(
    position.entryPrice,
    exitPrice,
    position.shares,
    position.initialRisk,
    assumptions,
  );
  const exit: CandleExitOutcome = {
    triggered: true,
    exitReason: "SESSION_CLOSE",
    exitTime: noonCandle.end,
    financials,
  };
  return { status: "CLOSED", exit };
}
