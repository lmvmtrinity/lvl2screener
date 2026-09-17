import { randomUUID } from "node:crypto";
import type {
  BacktestMetrics,
  BacktestQuoteExclusionCode,
  BacktestReplayResult,
  BacktestSignalReplayResult,
  BacktestSlice,
  BacktestTrade,
  ContextEvaluation,
  CreateBacktest,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { sampledExcursion } from "./sampled-excursions.js";
import {
  admitReplayQuotes,
  mergeInstrumentExclusions,
  mergeQuoteExclusionReasons,
  quoteExclusionWarning,
  sortedQuoteExclusionReasons,
} from "./replay-quote-admission.js";
import {
  applyCandleFacts,
  applyQuoteFact,
  createCandleExecution,
  createQuoteExecution,
  requestCandleSessionClose,
  requestQuoteSessionClose,
  type CandleExecutionState,
  type QuoteExecutionState,
} from "../paper-bot/execution-core.js";
import { zonedSessionBoundary } from "../paper-bot/session-time.js";
import type {
  AssumptionsSnapshot,
  CandleFact,
  QuoteFact,
  SignalFact,
} from "../paper-bot/types.js";
import { marketSessionTimezone } from "./execution-provenance.js";

interface ReplayInstrument {
  readonly instrumentId: string;
  readonly sector: string | null;
}

export interface HistoricalReplaySession {
  readonly session: {
    readonly timezone: string;
    readonly instruments: readonly ReplayInstrument[];
  };
  readonly quotes: readonly (QuoteFact & { readonly instrumentId: string })[];
  readonly candles: readonly (CandleFact & {
    readonly instrumentId: string;
    readonly timeframe: string;
    readonly isComplete: boolean;
  })[];
}

export interface HistoricalExecutionRecord {
  readonly event: StrategyStateEvent;
  readonly eligible: boolean;
  readonly quote: QuoteExecutionState | null;
  readonly candle: CandleExecutionState | null;
  readonly quoteMarks?: readonly (QuoteFact & {
    readonly instrumentId: string;
  })[];
}

export interface AuthoritativeBacktestResult {
  readonly output: BacktestReplayResult;
  readonly executions: readonly HistoricalExecutionRecord[];
}

export interface AuthoritativeBacktestInput {
  readonly runId: string;
  readonly configVersion: string;
  readonly request: CreateBacktest;
  readonly sessions: readonly HistoricalReplaySession[];
  readonly signalReplay: BacktestSignalReplayResult;
  readonly coverageVerified?: boolean;
  /**
   * Execution overrides for this replay. The cost, risk-budget, and
   * economic-gate fields let a chronological replay be run under an explicit
   * v3 cost contract (docs/paper-bot-performance-improvement-plan.md, Phase 6
   * sensitivity work). Omitting them keeps a replay bit-identical to the
   * cohort it is being compared against.
   */
  readonly assumptions?: Partial<
    Pick<
      AssumptionsSnapshot,
      | "stopMethod"
      | "atrStopMultiple"
      | "rewardRiskRatio"
      | "maxQuoteAgeSeconds"
      | "sessionTimezone"
      | "noonCloseTime"
      | "costs"
      | "riskBudget"
      | "maxNotional"
      | "economics"
      | "executionMode"
      | "latencyMs"
    >
  >;
}

type ExecutionOverrides = AuthoritativeBacktestInput["assumptions"];

export class AuthoritativeBacktestAccumulator {
  private readonly assumptions: AssumptionsSnapshot;
  private readonly executions: HistoricalExecutionRecord[] = [];
  private readonly events: StrategyStateEvent[] = [];
  private readonly contexts: ContextEvaluation[] = [];
  private readonly sectors = new Map<string, string | null>();
  private readonly seenReady = new Set<string>();
  private readonly warnings = new Set<string>();
  private readonly excludedReasons = new Map<
    BacktestQuoteExclusionCode,
    number
  >();
  private readonly excludedByInstrument = new Map<string, number>();
  private quoteSnapshots = 0;
  private admittedQuoteSnapshots = 0;
  private excludedQuoteCount = 0;
  private candleCount = 0;
  private sessionCount = 0;

  constructor(
    private readonly runId: string,
    private readonly configVersion: string,
    private readonly request: CreateBacktest,
    overrides?: ExecutionOverrides,
    private readonly coverageVerified = false,
  ) {
    this.assumptions = assumptionsFor(request, overrides);
  }

  ingestSession(
    session: HistoricalReplaySession,
    signalReplay: BacktestSignalReplayResult,
  ): void {
    this.sessionCount += 1;
    this.quoteSnapshots += session.quotes.length;
    const admission = admitReplayQuotes(session.quotes);
    this.admittedQuoteSnapshots += admission.admitted.length;
    this.excludedQuoteCount += admission.excludedQuotes;
    mergeQuoteExclusionReasons(this.excludedReasons, admission.reasons);
    mergeInstrumentExclusions(
      this.excludedByInstrument,
      admission.excludedByInstrument,
    );
    this.candleCount += session.candles.length;
    for (const warning of signalReplay.dataQuality.warnings)
      this.warnings.add(warning);
    for (const instrument of session.session.instruments)
      this.sectors.set(instrument.instrumentId, instrument.sector);
    this.resolvePendingQuotes(admission.admitted);
    this.events.push(...signalReplay.events);
    this.contexts.push(...signalReplay.contexts);

    const quotes = groupFacts(
      admission.admitted,
      (fact) => fact.instrumentId,
      (fact) => fact.timestamp,
    );
    const candles = groupFacts(
      session.candles.filter(
        (fact) => fact.timeframe === "OneMinute" && fact.isComplete,
      ),
      (fact) => fact.instrumentId,
      (fact) => fact.end,
    );
    for (const event of signalReplay.events) {
      if (event.state !== "READY") continue;
      const identity = readyIdentity(event);
      if (this.seenReady.has(identity)) continue;
      this.seenReady.add(identity);
      this.executions.push(
        executeEvent(
          event,
          event.score >= this.request.parameters.scoreCutoff,
          quotes.get(event.instrumentId) ?? [],
          candles.get(event.instrumentId) ?? [],
          this.assumptions,
        ),
      );
    }
  }

  addReplayWarnings(signalReplay: BacktestSignalReplayResult): void {
    for (const warning of signalReplay.dataQuality.warnings)
      this.warnings.add(warning);
  }

  finish(): AuthoritativeBacktestResult {
    const warnings = [...this.warnings];
    if (this.excludedQuoteCount > 0)
      warnings.push(
        quoteExclusionWarning(
          this.excludedQuoteCount,
          sortedQuoteExclusionReasons(this.excludedReasons),
        ),
      );
    const dataQuality: BacktestSignalReplayResult["dataQuality"] = {
      quoteSnapshots: this.quoteSnapshots,
      admittedQuotes: this.admittedQuoteSnapshots,
      excludedQuotes: this.excludedQuoteCount,
      exclusionReasons: sortedQuoteExclusionReasons(this.excludedReasons),
      candles: this.candleCount,
      sessions: this.sessionCount,
      spread: this.admittedQuoteSnapshots ? "CAPTURED" : "UNAVAILABLE",
      warnings,
    };
    return buildAuthoritativeResult(
      this.runId,
      this.configVersion,
      this.request,
      this.executions,
      this.events,
      this.contexts,
      this.sectors,
      dataQuality,
      this.coverageVerified,
      this.excludedByInstrument,
    );
  }

  private resolvePendingQuotes(
    quotes: HistoricalReplaySession["quotes"],
  ): void {
    const grouped = groupFacts(
      quotes,
      (fact) => fact.instrumentId,
      (fact) => fact.timestamp,
    );
    for (let index = 0; index < this.executions.length; index++) {
      const record = this.executions[index]!;
      if (record.quote?.status !== "CLOSE_PENDING") continue;
      let state: QuoteExecutionState = record.quote;
      const boundary = zonedSessionBoundary(
        localDate(record.event.timestamp, this.assumptions.sessionTimezone),
        this.assumptions.noonCloseTime,
        this.assumptions.sessionTimezone,
      );
      for (const quote of grouped.get(record.event.instrumentId) ?? []) {
        state = requestQuoteSessionClose(
          state,
          boundary,
          quote,
          this.assumptions,
        ).state;
        if (state.status === "CLOSED") break;
      }
      this.executions[index] = { ...record, quote: state };
    }
  }
}

export function executeAuthoritativeBacktest(
  input: AuthoritativeBacktestInput,
): AuthoritativeBacktestResult {
  const assumptions = assumptionsFor(input.request, {
    sessionTimezone: input.sessions[0]?.session.timezone,
    ...input.assumptions,
  });
  const excludedReasons = new Map<BacktestQuoteExclusionCode, number>();
  const excludedByInstrument = new Map<string, number>();
  let excludedQuoteCount = 0;
  let rawQuoteCount = 0;
  const admittedQuotes = input.sessions.flatMap((session) => {
    rawQuoteCount += session.quotes.length;
    const admission = admitReplayQuotes(session.quotes);
    excludedQuoteCount += admission.excludedQuotes;
    mergeQuoteExclusionReasons(excludedReasons, admission.reasons);
    mergeInstrumentExclusions(
      excludedByInstrument,
      admission.excludedByInstrument,
    );
    return admission.admitted;
  });
  const quotes = groupFacts(
    admittedQuotes,
    (fact) => fact.instrumentId,
    (fact) => fact.timestamp,
  );
  const candles = groupFacts(
    input.sessions.flatMap((session) =>
      session.candles.filter(
        (fact) => fact.timeframe === "OneMinute" && fact.isComplete,
      ),
    ),
    (fact) => fact.instrumentId,
    (fact) => fact.end,
  );
  const sectors = new Map(
    input.sessions.flatMap((session) =>
      session.session.instruments.map(
        (instrument) => [instrument.instrumentId, instrument.sector] as const,
      ),
    ),
  );
  const readyEvents = uniqueReadyEvents(input.signalReplay.events);
  const executions = readyEvents.map((event) =>
    executeEvent(
      event,
      event.score >= input.request.parameters.scoreCutoff,
      quotes.get(event.instrumentId) ?? [],
      candles.get(event.instrumentId) ?? [],
      assumptions,
    ),
  );
  const warnings = [...input.signalReplay.dataQuality.warnings];
  if (excludedQuoteCount > 0)
    warnings.push(
      quoteExclusionWarning(
        excludedQuoteCount,
        sortedQuoteExclusionReasons(excludedReasons),
      ),
    );
  return buildAuthoritativeResult(
    input.runId,
    input.configVersion,
    input.request,
    executions,
    input.signalReplay.events,
    input.signalReplay.contexts,
    sectors,
    {
      ...input.signalReplay.dataQuality,
      quoteSnapshots: rawQuoteCount,
      admittedQuotes: admittedQuotes.length,
      excludedQuotes: excludedQuoteCount,
      exclusionReasons: sortedQuoteExclusionReasons(excludedReasons),
      spread: admittedQuotes.length ? "CAPTURED" : "UNAVAILABLE",
      warnings,
    },
    input.coverageVerified ?? false,
    excludedByInstrument,
  );
}

function buildAuthoritativeResult(
  runId: string,
  configVersion: string,
  request: CreateBacktest,
  executions: readonly HistoricalExecutionRecord[],
  events: readonly StrategyStateEvent[],
  contexts: readonly ContextEvaluation[],
  sectors: ReadonlyMap<string, string | null>,
  dataQuality: BacktestSignalReplayResult["dataQuality"],
  coverageVerified: boolean,
  exclusionsByInstrument: ReadonlyMap<string, number> = new Map(),
): AuthoritativeBacktestResult {
  const trades = executions.flatMap((record) => {
    if (record.quote?.status !== "CLOSED") return [];
    return [
      tradeFrom(
        { ...record, quote: record.quote },
        runId,
        configVersion,
        sectors,
        contexts,
        coverageVerified,
        exclusionsByInstrument,
      ),
    ];
  });
  const metrics = metricsFor(
    trades,
    events,
    executions,
    request.startingCapital,
  );
  const warnings = [...dataQuality.warnings];
  if (executions.some((record) => record.quote?.status === "CLOSE_PENDING")) {
    warnings.push(
      "One or more canonical quote executions remain CLOSE_PENDING at the replay horizon.",
    );
  }
  return {
    executions,
    output: {
      metrics,
      analyses: analysesFor(trades),
      trades: [...trades].sort((left, right) =>
        left.entryTime.localeCompare(right.entryTime),
      ),
      timeline: events.map((event) => ({
        instrumentId: event.instrumentId,
        symbol: event.symbol,
        strategy: event.strategy,
        timestamp: event.timestamp,
        previousState: event.previousState,
        state: event.state,
        score: event.score,
        reasonCodes: event.reasonCodes,
        setupInstanceId: event.setupInstanceId,
      })),
      dataQuality: {
        ...dataQuality,
        warnings,
      },
    },
  };
}

function assumptionsFor(
  request: CreateBacktest,
  overrides?: ExecutionOverrides,
): AssumptionsSnapshot {
  return {
    positionSize: request.positionSize,
    slippageBps: request.slippageBps,
    feePerTrade: request.feePerTrade,
    // Left undefined unless explicitly overridden: a replay must reproduce the
    // cohort it is compared against, and v3 costs change both sizing and R.
    costs: overrides?.costs,
    riskBudget: overrides?.riskBudget,
    maxNotional: overrides?.maxNotional,
    economics: overrides?.economics,
    stopMethod: overrides?.stopMethod ?? "STRUCTURAL",
    atrStopMultiple: overrides?.atrStopMultiple ?? 1,
    rewardRiskRatio: overrides?.rewardRiskRatio ?? null,
    maxQuoteAgeSeconds: overrides?.maxQuoteAgeSeconds ?? 30,
    sessionTimezone:
      overrides?.sessionTimezone ?? marketSessionTimezone(request.marketId),
    noonCloseTime: overrides?.noonCloseTime ?? "16:00",
    executionMode: overrides?.executionMode,
    latencyMs: overrides?.latencyMs,
  };
}

export function executeEvent(
  event: StrategyStateEvent,
  eligible: boolean,
  quotes: readonly (QuoteFact & { readonly instrumentId: string })[],
  candles: readonly (CandleFact & { readonly instrumentId: string })[],
  assumptions: AssumptionsSnapshot,
): HistoricalExecutionRecord {
  if (!eligible)
    return {
      event,
      eligible: false,
      quote: null,
      candle: null,
      quoteMarks: quotes,
    };
  const signal: SignalFact = {
    entryReference: event.entryReference,
    stopReference: event.stopReference,
    targetReference: event.targetReference,
    atr14: event.featureSnapshot.atr14,
    signalTimestamp: event.timestamp,
  };
  const signalMs = Date.parse(event.timestamp);
  const entryQuote =
    [...quotes]
      .filter((quote) => Date.parse(quote.timestamp) <= signalMs)
      .at(-1) ?? null;
  let quoteState = createQuoteExecution(signal, entryQuote, assumptions);
  const boundary = zonedSessionBoundary(
    localDate(event.timestamp, assumptions.sessionTimezone),
    assumptions.noonCloseTime,
    assumptions.sessionTimezone,
  );
  const boundaryMs = Date.parse(boundary);
  if (quoteState.status === "OPEN") {
    for (const quote of quotes) {
      if (!("position" in quoteState)) break;
      if (
        Date.parse(quote.timestamp) <= Date.parse(quoteState.position.entryTime)
      )
        continue;
      const transition: { state: QuoteExecutionState; transitioned: boolean } =
        Date.parse(quote.timestamp) < boundaryMs &&
        quoteState.status !== "CLOSE_PENDING"
          ? applyQuoteFact(quoteState, quote, assumptions)
          : requestQuoteSessionClose(quoteState, boundary, quote, assumptions);
      quoteState = transition.state;
      if (quoteState.status === "CLOSED") break;
    }
    if (quoteState.status === "OPEN") {
      quoteState = requestQuoteSessionClose(
        quoteState,
        boundary,
        null,
        assumptions,
      ).state;
    }
  }

  let candleState = createCandleExecution(signal, assumptions);
  if (candleState.status === "OPEN") {
    const throughNoon = candles.filter(
      (candle) =>
        Date.parse(candle.start) >= signalMs &&
        Date.parse(candle.end) <= boundaryMs,
    );
    candleState = applyCandleFacts(candleState, throughNoon, assumptions).state;
    if (candleState.status === "OPEN") {
      const noonCandle =
        throughNoon.find((candle) => Date.parse(candle.end) === boundaryMs) ??
        null;
      candleState = requestCandleSessionClose(
        candleState,
        noonCandle,
        assumptions,
      ).state;
    }
  }
  return {
    event,
    eligible,
    quote: quoteState,
    candle: candleState,
    quoteMarks: quotes,
  };
}

function tradeFrom(
  record: HistoricalExecutionRecord & {
    quote: Extract<QuoteExecutionState, { status: "CLOSED" }>;
  },
  runId: string,
  configVersion: string,
  sectors: ReadonlyMap<string, string | null>,
  contexts: readonly ContextEvaluation[],
  coverageVerified: boolean,
  exclusionsByInstrument: ReadonlyMap<string, number>,
): BacktestTrade {
  const { event, quote } = record;
  const matchingContexts = contexts.filter(
    (context) =>
      context.instrumentId === event.instrumentId &&
      context.timestamp === event.timestamp,
  );
  const usable = matchingContexts.filter(
    (context) => context.status !== "UNAVAILABLE" && context.status !== "STALE",
  );
  const contextScore = usable.length
    ? Math.round(
        usable.reduce((sum, value) => sum + value.contextScore, 0) /
          usable.length,
      )
    : 50;
  const trade: BacktestTrade = {
    id: randomUUID(),
    runId,
    instrumentId: event.instrumentId,
    symbol: event.symbol,
    strategy: event.strategy,
    strategyVersion: event.strategyVersion,
    configVersion,
    signalTimestamp: event.timestamp,
    score: event.score,
    entryTime: quote.position.entryTime,
    entryPrice: quote.position.entryPrice,
    stopPrice: quote.position.stop,
    targetPrice: quote.position.target,
    exitTime: quote.exit.exitTime,
    exitPrice: quote.exit.financials.exitPrice,
    shares: quote.position.shares,
    exitReason: quote.exit.exitReason,
    grossPnl: quote.exit.financials.grossPnl,
    netPnl: quote.exit.financials.netPnl,
    rMultiple: quote.exit.financials.rMultiple,
    holdMinutes: Math.max(
      0,
      (Date.parse(quote.exit.exitTime) - Date.parse(quote.position.entryTime)) /
        60_000,
    ),
    reasonCodes: event.reasonCodes,
    sector: sectors.get(event.instrumentId) ?? null,
    atrPct: event.featureSnapshot.atrPct,
    rvolAtTime: event.featureSnapshot.rvolAtTime,
    contextScore,
    contexts: matchingContexts,
    setupInstanceId: event.setupInstanceId,
  };
  return {
    ...trade,
    sampledExcursion: sampledExcursion({
      entryAt: trade.entryTime,
      exitAt: trade.exitTime,
      entryPrice: trade.entryPrice,
      lotCount: quote.position.exitFills?.length ?? 1,
      coverageVerified,
      exclusionsPresent:
        (exclusionsByInstrument.get(event.instrumentId) ?? 0) > 0,
      marks: (record.quoteMarks ?? []).map((mark) => ({
        timestamp: mark.timestamp,
        bid: mark.bid,
        admissible: mark.actionable && mark.dataStatus === "REALTIME",
      })),
    }),
  };
}

function metricsFor(
  trades: readonly BacktestTrade[],
  events: readonly StrategyStateEvent[],
  executions: readonly HistoricalExecutionRecord[],
  startingCapital: number,
): BacktestMetrics {
  const pnl = trades.map((trade) => trade.netPnl);
  const winners = pnl.filter((value) => value > 0);
  const losers = pnl.filter((value) => value < 0);
  const rValues = trades.map((trade) => trade.rMultiple);
  const winRate = trades.length ? winners.length / trades.length : 0;
  const averageWin = average(winners);
  const averageLoss = Math.abs(average(losers));
  let equity = startingCapital;
  let peak = startingCapital;
  let maximumDrawdown = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }
  const eligible = executions.filter((record) => record.eligible);
  const noFills = eligible.filter(
    (record) => record.quote?.status === "NO_FILL",
  ).length;
  const closePending = eligible.filter(
    (record) => record.quote?.status === "CLOSE_PENDING",
  ).length;
  const fills = eligible.length - noFills;
  const grossProfit = winners.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losers.reduce((sum, value) => sum + value, 0));
  return {
    signalsGenerated: events.length,
    readySignals: executions.length,
    tradesSimulated: trades.length,
    wins: winners.length,
    losses: losers.length,
    winRate: round(winRate * 100, 4),
    averageWin: round(averageWin, 4),
    averageLoss: round(averageLoss, 4),
    averageR: round(average(rValues), 6),
    medianR: round(median(rValues), 6),
    profitFactor: grossLoss === 0 ? null : round(grossProfit / grossLoss, 6),
    expectancy: round(winRate * averageWin - (1 - winRate) * averageLoss, 4),
    netPnl: round(
      pnl.reduce((sum, value) => sum + value, 0),
      4,
    ),
    maximumDrawdown: round(maximumDrawdown, 4),
    maximumDrawdownPct: round((maximumDrawdown / startingCapital) * 100, 6),
    falseBreakoutRate: trades.length
      ? round(
          (trades.filter((trade) => trade.exitReason === "STOP").length /
            trades.length) *
            100,
          4,
        )
      : 0,
    signalToTradeConversion: executions.length
      ? round((trades.length / executions.length) * 100, 4)
      : 0,
    averageHoldMinutes: round(
      average(trades.map((trade) => trade.holdMinutes)),
      4,
    ),
    observations: executions.length,
    eligibleSignals: eligible.length,
    fills,
    noFills,
    closePending,
    closedTrades: trades.length,
  };
}

function analysesFor(trades: readonly BacktestTrade[]): BacktestSlice[] {
  const groups = new Map<
    string,
    {
      dimension: BacktestSlice["dimension"];
      bucket: string;
      trades: BacktestTrade[];
    }
  >();
  const add = (
    dimension: BacktestSlice["dimension"],
    bucket: string,
    trade: BacktestTrade,
  ) => {
    const key = `${dimension}:${bucket}`;
    const group = groups.get(key) ?? { dimension, bucket, trades: [] };
    group.trades.push(trade);
    groups.set(key, group);
  };
  for (const trade of trades) {
    add("STRATEGY", trade.strategy, trade);
    add("SCORE_BUCKET", scoreBucket(trade.score), trade);
    add("TIME_OF_DAY", timeBucket(trade.entryTime), trade);
    add("SECTOR", trade.sector ?? "UNKNOWN", trade);
    add("ATR_REGIME", atrBucket(trade.atrPct), trade);
    add("RVOL_REGIME", rvolBucket(trade.rvolAtTime), trade);
  }
  return [...groups.values()]
    .sort((left, right) =>
      `${left.dimension}:${left.bucket}`.localeCompare(
        `${right.dimension}:${right.bucket}`,
      ),
    )
    .map((group) => {
      const wins = group.trades.filter((trade) => trade.netPnl > 0);
      const losses = group.trades.filter((trade) => trade.netPnl < 0);
      const rate = group.trades.length ? wins.length / group.trades.length : 0;
      const averageWin = average(wins.map((trade) => trade.netPnl));
      const averageLoss = Math.abs(
        average(losses.map((trade) => trade.netPnl)),
      );
      return {
        dimension: group.dimension,
        bucket: group.bucket,
        trades: group.trades.length,
        wins: wins.length,
        winRate: round(rate * 100, 4),
        averageR: round(
          average(group.trades.map((trade) => trade.rMultiple)),
          6,
        ),
        expectancy: round(rate * averageWin - (1 - rate) * averageLoss, 4),
        netPnl: round(
          group.trades.reduce((sum, trade) => sum + trade.netPnl, 0),
          4,
        ),
      };
    });
}

function uniqueReadyEvents(
  events: readonly StrategyStateEvent[],
): StrategyStateEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (event.state !== "READY") return false;
    const identity = readyIdentity(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function readyIdentity(event: StrategyStateEvent): string {
  return event.setupInstanceId
    ? `${event.profileId}:${event.configVersion}:${event.setupInstanceId}`
    : event.eventId;
}

function groupFacts<T>(
  facts: readonly T[],
  keyOf: (fact: T) => string,
  timestampOf: (fact: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const fact of facts) {
    const values = grouped.get(keyOf(fact)) ?? [];
    values.push(fact);
    grouped.set(keyOf(fact), values);
  }
  for (const values of grouped.values())
    values.sort((left, right) =>
      timestampOf(left).localeCompare(timestampOf(right)),
    );
  return grouped;
}

function localDate(timestamp: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

const average = (values: readonly number[]): number =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const scoreBucket = (score: number): string =>
  score < 70 ? "0-69" : score < 80 ? "70-79" : score < 90 ? "80-89" : "90-100";

function timeBucket(timestamp: string): string {
  const time = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
  return time < "10:00"
    ? "09:30-09:59"
    : time < "11:00"
      ? "10:00-10:59"
      : "11:00+";
}

const atrBucket = (value: number | null): string =>
  value === null
    ? "UNKNOWN"
    : value < 1.5
      ? "<1.5%"
      : value < 2.5
        ? "1.5-2.49%"
        : "2.5%+";
const rvolBucket = (value: number | null): string =>
  value === null
    ? "UNKNOWN"
    : value < 1.5
      ? "<1.5x"
      : value < 2.5
        ? "1.5-2.49x"
        : "2.5x+";
