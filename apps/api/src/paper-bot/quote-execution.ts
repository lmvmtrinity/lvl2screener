import {
  applyEntrySlippage,
  applyExitSlippage,
  computeClosingFinancials,
  roundTripCosts,
} from "./financials.js";
import { evaluateEconomics } from "./economics.js";
import {
  deriveStopAndTarget,
  sizeEntryWithAssumptions,
} from "./level-derivation.js";
import type {
  AssumptionsSnapshot,
  ExecutionMode,
  ExitOutcome,
  SizingContext,
  MarketSnapshot,
  NoFillReason,
  OpenPosition,
  QuoteEntryResult,
  QuoteExitResult,
  QuoteFact,
  SessionCloseResult,
  SignalFact,
} from "./types.js";

function snapshotOf(
  quote: QuoteFact,
  decisionTimestamp = quote.timestamp,
  signalTimestamp?: string,
  fillTimestamp?: string,
  latencyMs?: number,
  executionMode?: ExecutionMode,
): MarketSnapshot {
  return {
    bid: quote.bid,
    ask: quote.ask,
    bidSize: quote.bidSize,
    askSize: quote.askSize,
    spread: quote.ask - quote.bid,
    quoteTimestamp: quote.timestamp,
    dataStatus: quote.dataStatus,
    stalenessSeconds: Math.max(
      0,
      (new Date(decisionTimestamp).getTime() -
        new Date(quote.timestamp).getTime()) /
        1000,
    ),
    signalTimestamp,
    decisionTimestamp,
    fillTimestamp,
    latencyMs,
    executionMode,
  };
}

/**
 * Classifies why a quote cannot support an actionable decision right now.
 * Returns `null` when the quote is actionable and fresh enough to use.
 */
export function classifyQuoteAvailability(
  quote: QuoteFact | null,
  decisionTimestamp: string,
  maxQuoteAgeSeconds: number,
): NoFillReason | null {
  if (quote === null) return "MISSING_QUOTE";
  if (quote.dataStatus === "HALTED") return "HALTED";
  if (quote.dataStatus === "DELAYED" || !quote.actionable) return "DELAYED";
  if ((quote.sizeUnit ?? "SHARES") !== "SHARES") return "UNKNOWN_QUOTE_SIZE";
  if (quote.sizeMultiplier !== undefined && quote.sizeMultiplier !== 1)
    return "UNKNOWN_QUOTE_SIZE";
  if (
    ![quote.bid, quote.ask, quote.bidSize, quote.askSize].every(
      Number.isFinite,
    ) ||
    quote.bid <= 0 ||
    quote.ask < quote.bid ||
    quote.bidSize < 0 ||
    quote.askSize < 0 ||
    !Number.isFinite(Date.parse(quote.timestamp)) ||
    !Number.isFinite(Date.parse(decisionTimestamp)) ||
    Date.parse(quote.timestamp) > Date.parse(decisionTimestamp)
  )
    return "STALE";
  const ageSeconds =
    (new Date(decisionTimestamp).getTime() -
      new Date(quote.timestamp).getTime()) /
    1000;
  if (ageSeconds > maxQuoteAgeSeconds) return "STALE";
  return null;
}

/**
 * Canonical quote entry (private development record, "Canonical quote
 * model"). The quote that produced the READY evaluation is the only entry
 * opportunity: this function is evaluated once per observation, at the
 * signal's own decision-time quote.
 */
export function evaluateQuoteEntry(
  signal: SignalFact,
  quoteAtSignal: QuoteFact | null,
  assumptions: AssumptionsSnapshot,
  context?: SizingContext,
  decisionTimestamp?: string,
): QuoteEntryResult {
  const effectiveDecisionTime = decisionTimestamp ?? signal.signalTimestamp;
  const executionMode =
    context?.executionMode ?? assumptions.executionMode ?? "UNCONSTRAINED";
  const latencyMs = context?.latencyMs ?? assumptions.latencyMs ?? 0;

  if (!Number.isFinite(latencyMs) || latencyMs !== 0) {
    throw new Error(
      "Non-zero latency is unsupported: execution requires a contemporaneous quote",
    );
  }
  const availability = classifyQuoteAvailability(
    quoteAtSignal,
    effectiveDecisionTime,
    assumptions.maxQuoteAgeSeconds,
  );
  if (availability !== null) {
    return {
      status: "NO_FILL",
      noFillReason: availability,
      entryMarketSnapshot: quoteAtSignal
        ? snapshotOf(
            quoteAtSignal,
            effectiveDecisionTime,
            signal.signalTimestamp,
            undefined,
            latencyMs,
            executionMode,
          )
        : null,
    };
  }
  const quote = quoteAtSignal as QuoteFact;

  // In capacity-constrained execution, a quote with 0 or negative size cannot support any fill
  if (executionMode === "CAPACITY_CONSTRAINED" && quote.askSize < 1) {
    return {
      status: "NO_FILL",
      noFillReason: "SHARES_BELOW_ONE",
      entryMarketSnapshot: snapshotOf(
        quote,
        effectiveDecisionTime,
        signal.signalTimestamp,
        undefined,
        latencyMs,
        executionMode,
      ),
    };
  }

  const levels = deriveStopAndTarget(signal, assumptions);
  if (!levels.ok) {
    return {
      status: "NO_FILL",
      noFillReason: levels.noFillReason,
      entryMarketSnapshot: snapshotOf(
        quote,
        effectiveDecisionTime,
        signal.signalTimestamp,
        undefined,
        latencyMs,
        executionMode,
      ),
    };
  }

  const executableEntryPrice = applyEntrySlippage(
    quote.ask,
    assumptions.slippageBps,
  );
  const effectiveSizingContext: SizingContext | undefined =
    context === undefined
      ? executionMode === "CAPACITY_CONSTRAINED"
        ? { displayedSize: quote.askSize, executionMode, latencyMs }
        : undefined
      : { displayedSize: quote.askSize, executionMode, latencyMs, ...context };

  const sized = sizeEntryWithAssumptions(
    executableEntryPrice,
    levels.stop,
    levels.target,
    assumptions,
    effectiveSizingContext,
  );
  if (!sized.ok) {
    return {
      status: "NO_FILL",
      noFillReason: sized.noFillReason,
      entryMarketSnapshot: snapshotOf(
        quote,
        effectiveDecisionTime,
        signal.signalTimestamp,
        undefined,
        latencyMs,
        executionMode,
      ),
    };
  }

  // Economics are deliberately evaluated after the executable price and share
  // count are known: a setup may be structurally valid yet still unable to pay
  // for its own friction at the size the risk budget allows.
  const economics = evaluateEconomics({
    marketId: assumptions.costs?.currency === "USD" ? "US_EQUITIES" : "CA_TSX",
    executableEntryPrice: sized.executableEntryPrice,
    stop: levels.stop,
    target: levels.target,
    shares: sized.shares,
    spread: quote.ask - quote.bid,
    assumptions,
  });
  const economicsReason = economics.rejections[0];
  if (economicsReason !== undefined) {
    return {
      status: "REJECTED_ECONOMICS",
      economicsReason,
      economics,
      entryMarketSnapshot: snapshotOf(
        quote,
        effectiveDecisionTime,
        signal.signalTimestamp,
        undefined,
        latencyMs,
        executionMode,
      ),
    };
  }

  // Calculate simulated fill time: never earlier than signal time or decision time, plus modeled latency
  const quoteMs = new Date(quote.timestamp).getTime();
  const signalMs = new Date(signal.signalTimestamp).getTime();
  const decisionMs = new Date(effectiveDecisionTime).getTime();
  const fillMs = Math.max(quoteMs, signalMs, decisionMs) + latencyMs;
  const fillTime = new Date(fillMs).toISOString();

  return {
    status: "OPEN",
    economics,
    sizing: sized.sizing,
    entryTime: fillTime,
    stop: levels.stop,
    target: levels.target,
    shares: sized.shares,
    initialRisk: sized.initialRisk,
    executableEntryPrice: sized.executableEntryPrice,
    entrySizeCoverage: quote.askSize / sized.shares,
    entryMarketSnapshot: snapshotOf(
      quote,
      effectiveDecisionTime,
      signal.signalTimestamp,
      fillTime,
      latencyMs,
      executionMode,
    ),
    quoteTime: quote.timestamp,
    signalTime: signal.signalTimestamp,
    decisionTime: effectiveDecisionTime,
    fillTime,
    latencyMs,
    executionMode,
  };
}

/**
 * Evaluates one later quote against an open position. Only quotes strictly
 * later than the entry observation may trigger an exit; the caller is
 * responsible for that ordering guarantee (see Phase 2 "reject out-of-order
 * or duplicate facts").
 */
export function evaluateQuoteExit(
  position: OpenPosition,
  quote: QuoteFact,
  assumptions: Pick<AssumptionsSnapshot, "slippageBps" | "feePerTrade">,
): QuoteExitResult {
  // A halted or delayed book is not a price the simulator may transact
  // against: its bid is a stale or non-executable print, and letting one
  // trigger a stop would manufacture a fill that no resting order could have
  // received. The same actionability rule already governs entry
  // (`classifyQuoteAvailability`) and the noon close (`resolveSessionClose`).
  if (!quote.actionable || quote.dataStatus !== "REALTIME") {
    return { triggered: false };
  }
  const remaining = position.remainingShares ?? position.shares;
  const filledShares = availableExitShares(position, quote);
  if (filledShares < 1) return { triggered: false };
  const unfilledShares = remaining - filledShares;
  if (!position.pendingExitReason && quote.bid >= position.target) {
    const financials = computeClosingFinancials(
      position.entryPrice,
      position.target,
      filledShares,
      position.initialRisk,
      (roundTripCosts(assumptions) * filledShares) / position.shares,
    );
    return {
      triggered: true,
      exitReason: "TARGET",
      exitTime: quote.timestamp,
      exitSizeCoverage: quote.bidSize / position.shares,
      exitMarketSnapshot: snapshotOf(
        quote,
        quote.timestamp,
        position.signalTime,
        quote.timestamp,
        position.latencyMs,
        position.executionMode,
      ),
      financials,
      sessionCloseDelayMs: null,
      unfilledShares,
      filledShares,
    };
  }
  if (position.pendingExitReason || quote.bid <= position.stop) {
    const exitPrice = applyExitSlippage(quote.bid, assumptions.slippageBps);
    const financials = computeClosingFinancials(
      position.entryPrice,
      exitPrice,
      filledShares,
      position.initialRisk,
      (roundTripCosts(assumptions) * filledShares) / position.shares,
    );
    return {
      triggered: true,
      exitReason: position.pendingExitReason ?? "STOP",
      exitTime: quote.timestamp,
      exitSizeCoverage: quote.bidSize / position.shares,
      exitMarketSnapshot: snapshotOf(
        quote,
        quote.timestamp,
        position.signalTime,
        quote.timestamp,
        position.latencyMs,
        position.executionMode,
      ),
      financials,
      sessionCloseDelayMs: null,
      unfilledShares,
      filledShares,
    };
  }
  return { triggered: false };
}

/** Closes an otherwise-open position at the first actionable quote after its
 * configured holding horizon. This is deliberately separate from a STOP: it
 * is a time/risk control, not a strategy signal. */
export function resolveQuoteTimeStop(
  position: OpenPosition,
  quote: QuoteFact,
  assumptions: Pick<
    AssumptionsSnapshot,
    "slippageBps" | "feePerTrade" | "costs"
  >,
): QuoteExitResult {
  if (!quote.actionable || quote.dataStatus !== "REALTIME")
    return { triggered: false };
  const exitPrice = applyExitSlippage(quote.bid, assumptions.slippageBps);
  const remaining = position.remainingShares ?? position.shares;
  const filledShares = availableExitShares(position, quote);
  if (filledShares < 1) return { triggered: false };
  const unfilledShares = remaining - filledShares;
  return {
    triggered: true,
    exitReason: "TIME_STOP",
    exitTime: quote.timestamp,
    exitSizeCoverage: quote.bidSize / position.shares,
    exitMarketSnapshot: snapshotOf(
      quote,
      quote.timestamp,
      position.signalTime,
      quote.timestamp,
      position.latencyMs,
      position.executionMode,
    ),
    financials: computeClosingFinancials(
      position.entryPrice,
      exitPrice,
      filledShares,
      position.initialRisk,
      (roundTripCosts(assumptions) * filledShares) / position.shares,
    ),
    sessionCloseDelayMs: null,
    unfilledShares,
    filledShares,
  };
}

/**
 * Resolves the noon session-close boundary for a still-open position. Pass
 * the first quote at or after the boundary; when it is not actionable the
 * result is CLOSE_PENDING and the caller must retry with later quotes
 * (including across restarts) until one resolves it or the replay horizon
 * ends.
 */
export function resolveSessionClose(
  position: OpenPosition,
  candidateQuote: QuoteFact | null,
  noonBoundaryTimestamp: string,
  assumptions: Pick<
    AssumptionsSnapshot,
    "slippageBps" | "feePerTrade" | "maxQuoteAgeSeconds"
  >,
): SessionCloseResult {
  if (
    candidateQuote !== null &&
    new Date(candidateQuote.timestamp).getTime() <
      new Date(noonBoundaryTimestamp).getTime()
  ) {
    return { status: "CLOSE_PENDING" };
  }
  const decisionTimestamp = candidateQuote?.timestamp ?? noonBoundaryTimestamp;
  const availability = classifyQuoteAvailability(
    candidateQuote,
    decisionTimestamp,
    assumptions.maxQuoteAgeSeconds,
  );
  if (availability !== null) {
    return { status: "CLOSE_PENDING" };
  }
  const quote = candidateQuote as QuoteFact;

  const remaining = position.remainingShares ?? position.shares;
  const filledShares = availableExitShares(position, quote);
  if (filledShares < 1) return { status: "CLOSE_PENDING" };
  const unfilledShares = remaining - filledShares;
  const exitPrice = applyExitSlippage(quote.bid, assumptions.slippageBps);
  const financials = computeClosingFinancials(
    position.entryPrice,
    exitPrice,
    filledShares,
    position.initialRisk,
    (roundTripCosts(assumptions) * filledShares) / position.shares,
  );
  const delayMs =
    new Date(quote.timestamp).getTime() -
    new Date(noonBoundaryTimestamp).getTime();
  const isDelayed = delayMs > 0;

  const exit: ExitOutcome = {
    triggered: true,
    exitReason: isDelayed ? "SESSION_CLOSE_DELAYED" : "SESSION_CLOSE",
    exitTime: quote.timestamp,
    exitSizeCoverage: quote.bidSize / position.shares,
    exitMarketSnapshot: snapshotOf(
      quote,
      decisionTimestamp,
      position.signalTime,
      quote.timestamp,
      position.latencyMs,
      position.executionMode,
    ),
    financials,
    sessionCloseDelayMs: isDelayed ? delayMs : null,
    unfilledShares,
    filledShares,
  };
  return { status: "CLOSED", exit };
}

function availableExitShares(position: OpenPosition, quote: QuoteFact): number {
  if (classifyQuoteAvailability(quote, quote.timestamp, 0) !== null) return 0;
  const remaining = position.remainingShares ?? position.shares;
  if (
    !Number.isFinite(quote.bid) ||
    quote.bid <= 0 ||
    !Number.isFinite(quote.bidSize) ||
    quote.bidSize < 0
  )
    return 0;
  if (position.executionMode !== "CAPACITY_CONSTRAINED") return remaining;
  if (
    (quote.sizeUnit ?? "SHARES") !== "SHARES" ||
    (quote.sizeMultiplier ?? 1) !== 1
  )
    return 0;
  return Math.min(remaining, Math.floor(quote.bidSize));
}
