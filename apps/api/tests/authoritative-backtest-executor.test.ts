import { describe, expect, it } from "vitest";
import type {
  BacktestSignalReplayResult,
  CreateBacktest,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import {
  AuthoritativeBacktestAccumulator,
  executeAuthoritativeBacktest,
  type HistoricalReplaySession,
} from "../src/backtests/authoritative-backtest-executor.js";

const runId = "10000000-0000-4000-8000-000000000080";
const instrumentId = "10000000-0000-4000-8000-000000000081";
const profileId = "10000000-0000-4000-8000-000000000082";

const request = {
  name: "authoritative",
  startDate: "2026-08-25",
  endDate: "2026-08-26",
  strategies: ["ORB_RETEST"],
  symbols: ["ABC.TO"],
  dataSource: "CAPTURED_QUOTES",
  startingCapital: 100_000,
  positionSize: 1_000,
  slippageBps: 10,
  feePerTrade: 1,
  parameters: { scoreCutoff: 70 },
} as CreateBacktest;

const event = (overrides: Partial<StrategyStateEvent> = {}) =>
  ({
    kind: "SETUP",
    eventId: "10000000-0000-4000-8000-000000000083",
    eventType: "STRATEGY_STATE_CHANGED",
    previousState: "FORMING",
    state: "READY",
    instrumentId,
    symbol: "ABC.TO",
    timestamp: "2026-08-25T14:00:00.000Z",
    profileId,
    profileName: "ORB",
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configVersion: "config-v1",
    score: 85,
    setupScore: 85,
    scoreVersion: "v2",
    scoreComponents: {},
    scoreExplanation: [],
    setupInstanceId: "10000000-0000-4000-8000-000000000084",
    reasonCodes: [],
    entryReference: 10,
    stopReference: 9.5,
    targetReference: 11,
    estimatedRr: 2,
    featureSnapshot: { atr14: 0.25, atrPct: 2.5, rvolAtTime: 2 },
    ...overrides,
  }) as StrategyStateEvent;

const quote = (
  timestamp: string,
  bid: number,
  ask = bid + 0.01,
  overrides: Record<string, unknown> = {},
) => ({
  instrumentId,
  timestamp,
  bid,
  ask,
  bidSize: 500,
  askSize: 500,
  dataStatus: "REALTIME" as const,
  actionable: true,
  ...overrides,
});

function session(
  quotes: HistoricalReplaySession["quotes"],
  candles: HistoricalReplaySession["candles"] = [],
): HistoricalReplaySession {
  return {
    session: {
      timezone: "America/Toronto",
      instruments: [{ instrumentId, sector: "Technology" }],
    },
    quotes,
    candles,
  };
}

function signals(events: StrategyStateEvent[]): BacktestSignalReplayResult {
  return {
    events,
    contexts: [],
    dataQuality: {
      quoteSnapshots: 1,
      candles: 0,
      sessions: 1,
      spread: "CAPTURED",
      warnings: [],
    },
  };
}

describe("authoritative historical backtest executor", () => {
  it("uses captured ask entry and later bid target execution for canonical trades", () => {
    const result = executeAuthoritativeBacktest({
      runId,
      configVersion: "config-v1",
      request,
      sessions: [
        session([
          quote("2026-08-25T14:00:00.000Z", 9.99, 10),
          quote("2026-08-25T14:30:00.000Z", 11, 11.01),
        ]),
      ],
      signalReplay: signals([event()]),
    });

    expect(result.output.trades[0]).toMatchObject({
      entryPrice: 10.01,
      exitPrice: 11,
      exitReason: "TARGET",
      shares: 99,
    });
    expect(result.output.metrics).toMatchObject({
      observations: 1,
      eligibleSignals: 1,
      fills: 1,
      noFills: 0,
      closedTrades: 1,
    });
  });

  it("adds sampled bid diagnostics without changing the canonical trade", () => {
    const result = executeAuthoritativeBacktest({
      runId,
      configVersion: "config-v1",
      request,
      coverageVerified: true,
      sessions: [
        session([
          quote("2026-08-25T14:00:00.000Z", 9.99, 10),
          quote("2026-08-25T14:10:00.000Z", 10, 10.01),
          quote("2026-08-25T14:20:00.000Z", 10.5, 10.51),
          quote("2026-08-25T14:30:00.000Z", 11, 11.01),
        ]),
      ],
      signalReplay: signals([event()]),
    });

    expect(result.output.trades[0]?.sampledExcursion).toMatchObject({
      status: "AVAILABLE",
      samples: 2,
    });
    expect(result.output.trades[0]).toMatchObject({
      entryPrice: 10.01,
      exitPrice: 11,
      netPnl: expect.any(Number),
    });
  });

  it("records below-cutoff observations without creating executions", () => {
    const result = executeAuthoritativeBacktest({
      runId,
      configVersion: "config-v1",
      request,
      sessions: [session([quote("2026-08-25T14:00:00.000Z", 9.99, 10)])],
      signalReplay: signals([event({ score: 69 })]),
    });

    expect(result.executions[0]).toMatchObject({
      eligible: false,
      quote: null,
      candle: null,
    });
    expect(result.output.metrics).toMatchObject({
      observations: 1,
      eligibleSignals: 0,
      fills: 0,
      closedTrades: 0,
    });
  });

  it("carries CLOSE_PENDING into the next session and records the delayed duration", () => {
    const result = executeAuthoritativeBacktest({
      runId,
      configVersion: "config-v1",
      request,
      sessions: [
        session([
          quote("2026-08-25T14:00:00.000Z", 9.99, 10),
          quote("2026-08-25T16:00:00.000Z", 10.2, 10.21, {
            dataStatus: "HALTED",
            actionable: false,
          }),
        ]),
        session([quote("2026-08-26T13:30:00.000Z", 10.2, 10.21)]),
      ],
      signalReplay: signals([event()]),
    });

    expect(result.output.trades[0]).toMatchObject({
      exitReason: "SESSION_CLOSE_DELAYED",
      exitTime: "2026-08-26T13:30:00.000Z",
    });
    expect(result.executions[0]?.quote).toMatchObject({
      status: "CLOSED",
      exit: { sessionCloseDelayMs: 63_000_000 },
    });
  });

  it("streams the same delayed close across bounded session chunks", () => {
    const accumulator = new AuthoritativeBacktestAccumulator(
      runId,
      "config-v1",
      request,
    );
    accumulator.ingestSession(
      session([
        quote("2026-08-25T14:00:00.000Z", 9.99, 10),
        quote("2026-08-25T16:00:00.000Z", 10.2, 10.21, {
          dataStatus: "HALTED",
          actionable: false,
        }),
      ]),
      signals([event()]),
    );
    accumulator.ingestSession(
      session([quote("2026-08-26T13:30:00.000Z", 10.2, 10.21)]),
      signals([]),
    );

    expect(accumulator.finish().output.trades[0]).toMatchObject({
      exitReason: "SESSION_CLOSE_DELAYED",
      exitTime: "2026-08-26T13:30:00.000Z",
    });
  });

  it("reports canonical no-fill and supplementary same-bar stop outcomes separately", () => {
    const noQuote = executeAuthoritativeBacktest({
      runId,
      configVersion: "config-v1",
      request,
      sessions: [session([])],
      signalReplay: signals([event()]),
    });
    expect(noQuote.executions[0]?.quote).toMatchObject({
      status: "NO_FILL",
      noFillReason: "MISSING_QUOTE",
    });

    const withCandle = executeAuthoritativeBacktest({
      runId,
      configVersion: "config-v1",
      request,
      sessions: [
        session(
          [quote("2026-08-25T14:00:00.000Z", 9.99, 10)],
          [
            {
              instrumentId,
              timeframe: "OneMinute",
              isComplete: true,
              start: "2026-08-25T14:01:00.000Z",
              end: "2026-08-25T14:02:00.000Z",
              open: 10,
              high: 11.1,
              low: 9.4,
              close: 10.5,
            },
          ],
        ),
      ],
      signalReplay: signals([event()]),
    });
    expect(withCandle.executions[0]?.candle).toMatchObject({
      status: "CLOSED",
      exit: { exitReason: "STOP" },
    });
  });

  it("excludes an invalid captured quote from entry and reports exclusion accounting", () => {
    const result = executeAuthoritativeBacktest({
      runId,
      configVersion: "config-v1",
      request,
      coverageVerified: true,
      sessions: [
        session([
          quote("2026-08-25T14:00:00.000Z", 9.99, 10, {
            last: 10,
            dayOpen: 0,
          }),
          quote("2026-08-25T14:20:00.000Z", 11, 11.01, {
            last: 11,
            dayOpen: 10,
          }),
        ]),
      ],
      signalReplay: signals([event()]),
    });

    expect(result.executions[0]?.quote).toMatchObject({
      status: "NO_FILL",
      noFillReason: "MISSING_QUOTE",
    });
    expect(result.output.dataQuality).toMatchObject({
      quoteSnapshots: 2,
      admittedQuotes: 1,
      excludedQuotes: 1,
      exclusionReasons: [{ code: "INVALID_DAY_OPEN", count: 1 }],
    });
    expect(result.output.dataQuality?.warnings.join(" ")).toContain(
      "excluded from replay",
    );
  });

  it("refuses sampled diagnostics when an excluded quote touches the traded instrument", () => {
    const result = executeAuthoritativeBacktest({
      runId,
      configVersion: "config-v1",
      request,
      coverageVerified: true,
      sessions: [
        session([
          quote("2026-08-25T13:59:00.000Z", 9.9, 9.91, {
            last: 9.9,
            dayOpen: 0,
          }),
          quote("2026-08-25T14:00:00.000Z", 9.99, 10, {
            last: 10,
            dayOpen: 9.9,
          }),
          quote("2026-08-25T14:20:00.000Z", 11, 11.01, {
            last: 11,
            dayOpen: 9.9,
          }),
        ]),
      ],
      signalReplay: signals([event()]),
    });

    expect(result.output.trades[0]?.sampledExcursion).toMatchObject({
      status: "UNAVAILABLE",
      reasonCodes: ["INPUT_EXCLUSIONS_PRESENT"],
    });
    expect(result.output.trades[0]).toMatchObject({ exitReason: "TARGET" });
  });

  it("does not resolve a close-pending position from an excluded quote in a later chunk", () => {
    const accumulator = new AuthoritativeBacktestAccumulator(
      runId,
      "config-v1",
      request,
    );
    accumulator.ingestSession(
      session([
        quote("2026-08-25T14:00:00.000Z", 9.99, 10, {
          last: 10,
          dayOpen: 10,
        }),
      ]),
      signals([event()]),
    );
    accumulator.ingestSession(
      session([
        quote("2026-08-26T13:30:00.000Z", 10.2, 10.21, {
          last: 10.2,
          dayOpen: 0,
        }),
        quote("2026-08-26T13:31:00.000Z", 10.3, 10.31, {
          last: 10.3,
          dayOpen: 10,
        }),
      ]),
      signals([]),
    );

    const output = accumulator.finish().output;
    expect(output.trades[0]).toMatchObject({
      exitReason: "SESSION_CLOSE_DELAYED",
      exitTime: "2026-08-26T13:31:00.000Z",
    });
    expect(output.dataQuality).toMatchObject({
      admittedQuotes: 2,
      excludedQuotes: 1,
    });
  });
});
