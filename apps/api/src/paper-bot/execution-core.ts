/**
 * Idempotent orchestration over the quote and candle models (docs/
 * private development record, Phase 2 "Core operations"). Each function is a
 * pure `(state, fact) -> state` transition: reprocessing an already-seen fact
 * or an out-of-order fact returns `transitioned: false` and an unchanged
 * state rather than re-deriving or overwriting a prior outcome. There is no
 * database, clock, or network access anywhere in this module.
 */
import {
  evaluateCandleBars,
  evaluateCandleEntry,
  resolveCandleSessionClose,
} from "./candle-execution.js";
import {
  roundMoney,
  roundPrice,
  roundR,
  roundTripCosts,
} from "./financials.js";
import {
  classifyQuoteAvailability,
  evaluateQuoteEntry,
  evaluateQuoteExit,
  resolveQuoteTimeStop,
  resolveSessionClose,
} from "./quote-execution.js";
import type {
  AssumptionsSnapshot,
  CandleExitOutcome,
  CandleFact,
  EconomicsRejectionReason,
  ExecutionEconomics,
  ExitOutcome,
  NoFillReason,
  MarketSnapshot,
  OpenPosition,
  QuoteFact,
  SignalFact,
  SizingBreakdown,
  SizingContext,
} from "./types.js";

interface Transition<TState> {
  readonly state: TState;
  readonly transitioned: boolean;
}

// ---------------------------------------------------------------------------
// Quote model
// ---------------------------------------------------------------------------

export type QuoteExecutionState =
  | {
      readonly status: "NO_FILL";
      readonly noFillReason: NoFillReason;
      readonly entryMarketSnapshot: MarketSnapshot | null;
    }
  | {
      readonly status: "REJECTED_ECONOMICS";
      readonly economicsReason: EconomicsRejectionReason;
      readonly economics: ExecutionEconomics;
      readonly entryMarketSnapshot: MarketSnapshot | null;
    }
  | {
      readonly status: "OPEN" | "CLOSE_PENDING";
      readonly position: OpenPosition;
      readonly entryMarketSnapshot: MarketSnapshot;
      readonly entrySizeCoverage: number;
      readonly economics?: ExecutionEconomics;
      readonly sizing?: SizingBreakdown;
      readonly lastFactTimestamp: string;
    }
  | {
      readonly status: "CLOSED";
      readonly position: OpenPosition;
      readonly entryMarketSnapshot: MarketSnapshot;
      readonly entrySizeCoverage: number;
      readonly economics?: ExecutionEconomics;
      readonly sizing?: SizingBreakdown;
      readonly exit: ExitOutcome;
    };

export function createQuoteExecution(
  signal: SignalFact,
  quoteAtSignal: QuoteFact | null,
  assumptions: AssumptionsSnapshot,
  context?: SizingContext,
  decisionTimestamp?: string,
): QuoteExecutionState {
  const result = evaluateQuoteEntry(
    signal,
    quoteAtSignal,
    assumptions,
    context,
    decisionTimestamp,
  );
  if (result.status === "NO_FILL") {
    return {
      status: "NO_FILL",
      noFillReason: result.noFillReason,
      entryMarketSnapshot: result.entryMarketSnapshot,
    };
  }
  if (result.status === "REJECTED_ECONOMICS") {
    return {
      status: "REJECTED_ECONOMICS",
      economicsReason: result.economicsReason,
      economics: result.economics,
      entryMarketSnapshot: result.entryMarketSnapshot,
    };
  }
  return {
    status: "OPEN",
    economics: result.economics,
    sizing: result.sizing,
    position: {
      entryPrice: result.executableEntryPrice,
      entryTime: result.entryTime,
      stop: result.stop,
      target: result.target,
      shares: result.shares,
      initialRisk: result.initialRisk,
      quoteTime: result.quoteTime,
      signalTime: result.signalTime,
      decisionTime: result.decisionTime,
      fillTime: result.fillTime,
      latencyMs: result.latencyMs,
      executionMode: result.executionMode,
    },
    entryMarketSnapshot: result.entryMarketSnapshot,
    entrySizeCoverage: result.entrySizeCoverage,
    lastFactTimestamp: result.entryTime,
  };
}

/** Evaluates one later quote against an OPEN execution. */
export function applyQuoteFact(
  state: QuoteExecutionState,
  quote: QuoteFact,
  assumptions: Pick<AssumptionsSnapshot, "slippageBps" | "feePerTrade">,
): Transition<QuoteExecutionState> {
  if (
    state.status === "NO_FILL" ||
    state.status === "REJECTED_ECONOMICS" ||
    state.status === "CLOSED" ||
    state.status === "CLOSE_PENDING"
  ) {
    return { state, transitioned: false };
  }
  if (
    new Date(quote.timestamp).getTime() <=
    new Date(state.lastFactTimestamp).getTime()
  ) {
    return { state, transitioned: false };
  }
  if (classifyQuoteAvailability(quote, quote.timestamp, 0) !== null)
    return { state, transitioned: false };
  const result = evaluateQuoteExit(state.position, quote, assumptions);
  if (!result.triggered) {
    return {
      state: {
        ...state,
        position: {
          ...state.position,
          pendingExitReason:
            state.position.pendingExitReason ??
            (quote.actionable &&
            quote.dataStatus === "REALTIME" &&
            quote.bid <= state.position.stop
              ? "STOP"
              : undefined),
        },
        lastFactTimestamp: quote.timestamp,
      },
      transitioned: false,
    };
  }
  return {
    state: settleQuoteFill(state, result, assumptions),
    transitioned: true,
  };
}

export function requestQuoteTimeStop(
  state: QuoteExecutionState,
  quote: QuoteFact,
  assumptions: Pick<
    AssumptionsSnapshot,
    "slippageBps" | "feePerTrade" | "costs"
  >,
): Transition<QuoteExecutionState> {
  if (state.status !== "OPEN") return { state, transitioned: false };
  if (Date.parse(quote.timestamp) <= Date.parse(state.lastFactTimestamp))
    return { state, transitioned: false };
  const result = resolveQuoteTimeStop(state.position, quote, assumptions);
  if (!result.triggered) return { state, transitioned: false };
  return {
    state: settleQuoteFill(state, result, assumptions),
    transitioned: true,
  };
}

/**
 * Requests the session-close boundary. Pass `null` for `candidateQuote` when no
 * quote has arrived yet at or after the boundary; the result is
 * CLOSE_PENDING and the caller retries on later cycles or after a restart.
 */
export function requestQuoteSessionClose(
  state: QuoteExecutionState,
  noonBoundaryTimestamp: string,
  candidateQuote: QuoteFact | null,
  assumptions: Pick<
    AssumptionsSnapshot,
    "slippageBps" | "feePerTrade" | "maxQuoteAgeSeconds"
  >,
): Transition<QuoteExecutionState> {
  if (
    state.status === "NO_FILL" ||
    state.status === "REJECTED_ECONOMICS" ||
    state.status === "CLOSED"
  ) {
    return { state, transitioned: false };
  }
  if (
    candidateQuote !== null &&
    new Date(candidateQuote.timestamp).getTime() <=
      new Date(state.lastFactTimestamp).getTime()
  ) {
    return { state, transitioned: false };
  }
  const result = resolveSessionClose(
    state.position,
    candidateQuote,
    noonBoundaryTimestamp,
    assumptions,
  );
  if (result.status === "CLOSE_PENDING") {
    if (state.status === "CLOSE_PENDING") return { state, transitioned: false };
    return { state: { ...state, status: "CLOSE_PENDING" }, transitioned: true };
  }
  return {
    state: settleQuoteFill(
      { ...state, status: "CLOSE_PENDING" },
      result.exit as ExitOutcome,
      assumptions,
    ),
    transitioned: true,
  };
}

// ---------------------------------------------------------------------------
// Candle model
// ---------------------------------------------------------------------------

function settleQuoteFill(
  state: Extract<QuoteExecutionState, { status: "OPEN" | "CLOSE_PENDING" }>,
  exit: ExitOutcome,
  assumptions: Pick<
    AssumptionsSnapshot,
    "feePerTrade" | "slippageBps" | "costs"
  >,
): QuoteExecutionState {
  const filledShares = exit.filledShares ?? state.position.shares;
  const remainingShares =
    (state.position.remainingShares ?? state.position.shares) - filledShares;
  const exitFills = [...(state.position.exitFills ?? []), exit];
  const position = {
    ...state.position,
    remainingShares,
    exitFills,
    pendingExitReason:
      exit.exitReason === "TARGET" ? undefined : exit.exitReason,
  };
  if (remainingShares > 0)
    return { ...state, position, lastFactTimestamp: exit.exitTime };
  const grossPnl = roundMoney(
    exitFills.reduce((total, fill) => total + fill.financials.grossPnl, 0),
  );
  const netPnl = roundMoney(grossPnl - roundTripCosts(assumptions));
  const exitPrice = roundPrice(
    exitFills.reduce(
      (total, fill) =>
        total +
        fill.financials.exitPrice *
          (fill.filledShares ?? state.position.shares),
      0,
    ) / state.position.shares,
  );
  return {
    ...state,
    position,
    status: "CLOSED",
    exit: {
      ...exit,
      unfilledShares: 0,
      financials: {
        exitPrice,
        grossPnl,
        netPnl,
        rMultiple: roundR(netPnl / position.initialRisk),
      },
    },
  };
}

export type CandleExecutionState =
  | {
      readonly status: "NO_FILL";
      readonly noFillReason: NoFillReason;
    }
  | {
      readonly status: "REJECTED_ECONOMICS";
      readonly economicsReason: EconomicsRejectionReason;
      readonly economics: ExecutionEconomics;
    }
  | {
      readonly status: "OPEN" | "CLOSE_PENDING";
      readonly position: OpenPosition;
      readonly economics?: ExecutionEconomics;
      readonly sizing?: SizingBreakdown;
      readonly lastFactTimestamp: string;
    }
  | {
      readonly status: "CLOSED";
      readonly position: OpenPosition;
      readonly economics?: ExecutionEconomics;
      readonly sizing?: SizingBreakdown;
      readonly exit: CandleExitOutcome;
    };

export function createCandleExecution(
  signal: SignalFact,
  assumptions: AssumptionsSnapshot,
): CandleExecutionState {
  const result = evaluateCandleEntry(signal, assumptions);
  if (result.status === "NO_FILL") {
    return { status: "NO_FILL", noFillReason: result.noFillReason };
  }
  if (result.status === "REJECTED_ECONOMICS") {
    return {
      status: "REJECTED_ECONOMICS",
      economicsReason: result.economicsReason,
      economics: result.economics,
    };
  }
  return {
    status: "OPEN",
    economics: result.economics,
    sizing: result.sizing,
    position: {
      entryPrice: result.syntheticEntryPrice,
      entryTime: result.entryTime,
      stop: result.stop,
      target: result.target,
      shares: result.shares,
      initialRisk: result.initialRisk,
    },
    lastFactTimestamp: result.entryTime,
  };
}

/**
 * Evaluates newly completed candles against an OPEN execution.
 *
 * Admissibility invariants centralized here:
 * 1. Chronological order & deduplication: input batches may be unsorted or contain
 *    duplicate intervals across retries/reconciliation; they are normalized here.
 * 2. Pre-entry exclusion: OHLC bars cannot establish intrabar ordering. If a trade
 *    entered at 14:00:30, a 14:00-14:01 candle's low/high may have occurred before
 *    entry. To prevent lookback contamination and ensure live/replay parity, any bar
 *    starting before `position.entryTime` is excluded.
 *    (Note: this creates an unobservable interval between entryTime and the start
 *    of the next complete candle).
 * 3. Watermark advancement: candles ending at or before `lastFactTimestamp` are
 *    dropped so re-delivering overlapping batches is safe and idempotent.
 */
export function applyCandleFacts(
  state: CandleExecutionState,
  candles: readonly CandleFact[],
  assumptions: Pick<AssumptionsSnapshot, "slippageBps" | "feePerTrade">,
): Transition<CandleExecutionState> {
  if (
    state.status === "NO_FILL" ||
    state.status === "REJECTED_ECONOMICS" ||
    state.status === "CLOSED" ||
    state.status === "CLOSE_PENDING"
  ) {
    return { state, transitioned: false };
  }

  const entryMs = new Date(state.position.entryTime).getTime();
  const lastMs = new Date(state.lastFactTimestamp).getTime();

  // Deduplicate by end timestamp and sort chronologically by start timestamp
  const sorted = [...candles].sort(
    (a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime() ||
      new Date(a.end).getTime() - new Date(b.end).getTime(),
  );
  const deduped: CandleFact[] = [];
  const seenEnds = new Set<string>();
  for (const c of sorted) {
    if (!seenEnds.has(c.end)) {
      seenEnds.add(c.end);
      deduped.push(c);
    }
  }

  // Enforce admissibility: bar start must be at or after entry time, and
  // bar end must be strictly after the previous watermark.
  const newCandles = deduped.filter(
    (candle) =>
      new Date(candle.start).getTime() >= entryMs &&
      new Date(candle.end).getTime() > lastMs,
  );
  if (newCandles.length === 0) {
    return { state, transitioned: false };
  }
  const result = evaluateCandleBars(state.position, newCandles, assumptions);
  const latestEnd =
    newCandles[newCandles.length - 1]?.end ?? state.lastFactTimestamp;
  if (!result.triggered) {
    return {
      state: { ...state, lastFactTimestamp: latestEnd },
      transitioned: false,
    };
  }
  return {
    state: {
      status: "CLOSED",
      position: state.position,
      economics: state.economics,
      sizing: state.sizing,
      exit: result,
    },
    transitioned: true,
  };
}

/**
 * Closes at the completed session-close candle. `noonCandle` is `null` until that bar
 * is ingested; the result then stays CLOSE_PENDING for the caller to retry.
 */
export function requestCandleSessionClose(
  state: CandleExecutionState,
  noonCandle: CandleFact | null,
  assumptions: Pick<AssumptionsSnapshot, "slippageBps" | "feePerTrade">,
): Transition<CandleExecutionState> {
  if (
    state.status === "NO_FILL" ||
    state.status === "REJECTED_ECONOMICS" ||
    state.status === "CLOSED"
  ) {
    return { state, transitioned: false };
  }
  if (
    noonCandle !== null &&
    new Date(noonCandle.end).getTime() <
      new Date(state.lastFactTimestamp).getTime()
  ) {
    return { state, transitioned: false };
  }
  const result = resolveCandleSessionClose(
    state.position,
    noonCandle,
    assumptions,
  );
  if (result.status === "CLOSE_PENDING") {
    if (state.status === "CLOSE_PENDING") return { state, transitioned: false };
    return { state: { ...state, status: "CLOSE_PENDING" }, transitioned: true };
  }
  return {
    state: {
      status: "CLOSED",
      position: state.position,
      economics: state.economics,
      sizing: state.sizing,
      exit: result.exit as CandleExitOutcome,
    },
    transitioned: true,
  };
}
