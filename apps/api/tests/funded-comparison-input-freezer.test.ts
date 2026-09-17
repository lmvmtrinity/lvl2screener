import { describe, expect, it } from "vitest";
import type {
  BacktestRun,
  BacktestSignalReplayResult,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import {
  chunkFundedComparisonItems,
  freezeFundedComparisonSharedInput,
  projectFundedComparisonSessionItems,
  sessionInputDigestOf,
  type FundedComparisonBaselineStore,
  type FundedComparisonQuoteRow,
} from "../src/paper-bot/funded-comparison-input-freezer.js";
import { inputItemOrderKey } from "@tsx-scanner/contracts";
import { FundedComparisonSpecificationError } from "../src/paper-bot/funded-comparison-specification.js";
import { fundedHistoricalProfiles } from "../src/paper-bot/funded-historical-signal-bridge.js";
import type { InsertObservationInput } from "../src/paper-bot/paper-bot-repository.js";

const digestA = "a".repeat(64);
const realQuote = {
  timestamp: "2026-09-15T13:30:00.000Z",
  bid: 100,
  ask: 100.05,
  bidSize: 500,
  askSize: 300,
  sizeUnit: "SHARES" as const,
  sizeMultiplier: 1,
  dataStatus: "REALTIME" as const,
  actionable: true,
};

function observation(
  ordinal: number,
  overrides: Partial<InsertObservationInput> = {},
): InsertObservationInput {
  return {
    runId: "baseline-1",
    sourceEventId: `source-event-${ordinal}`,
    sourceSignalId: null,
    setupInstanceId: `setup-${ordinal}`,
    instrumentId: `instrument-${ordinal}`,
    symbol: `SYM${ordinal}`,
    profileId: "profile-1",
    profileName: "profile",
    profileConfigId: "profile-config-1",
    configVersion: "config-1",
    profileParameters: {},
    strategyKey: "ORB_RETEST",
    strategyVersion: "1.0.0",
    signalTimestamp: `2026-09-15T13:${(30 + ordinal).toString().padStart(2, "0")}:00.000Z`,
    score: 70 + ordinal,
    entryReference: 100,
    stopReference: 99,
    targetReference: 102,
    atr14: 0.5,
    featureSnapshot: { featureVersion: "features-v1", atr14: 0.5 },
    reasonCodes: ["BREAKOUT"],
    sourceEventPayload: { signalSemanticsVersion: "signal-v1" },
    eligibilityStatus: "ELIGIBLE",
    eligibilityReason: null,
    ...overrides,
  };
}

function quoteRow(
  at: string,
  instrumentId = "instrument-1",
): FundedComparisonQuoteRow {
  return {
    instrumentId,
    timestamp: at,
    bid: 100,
    ask: 100.05,
    bidSize: 500,
    askSize: 300,
    sizeUnit: "SHARES",
    sizeMultiplier: null,
    isDelayed: false,
    isHalted: false,
    source: "QUESTRADE",
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return projectFundedComparisonSessionItems({
    baselineRunId: "baseline-1",
    sessionDate: "2026-09-15",
    sessionStartAt: "2026-09-15T13:30:00.000Z",
    scheduledCloseAt: "2026-09-15T20:00:00.000Z",
    sessionTimezone: "America/Toronto",
    observations: [observation(2), observation(1)],
    quotes: [quoteRow("2026-09-15T13:35:00.000Z")],
    invalidations: [
      {
        eventId: "event-1",
        instrumentId: "instrument-1",
        setupInstanceId: "setup-1",
        at: "2026-09-15T13:40:00.000Z",
      },
    ],
    contextsFor: () => [
      {
        signalKey: "MARKET_RELATIVE_STRENGTH",
        status: "STRONG",
        timestamp: "2026-09-15T13:29:00.000Z",
        benchmarkTimestamp: null,
      },
    ],
    ...overrides,
  });
}

function baselineRun(): BacktestRun {
  return {
    id: "baseline-1",
    marketId: "CA_TSX",
    name: "baseline",
    status: "COMPLETED",
    startDate: "2026-09-10",
    endDate: "2026-09-15",
    strategies: ["ORB_RETEST"],
    symbols: ["SYM1"],
    dataSource: "CAPTURED_QUOTES",
    strategyVersion: "1.0.0",
    configVersion: "config-1",
    executionModelVersion: "execution-v1",
    executionAssumptions: null,
    supersedesBacktestRunId: null,
    startingCapital: 25_000,
    positionSize: 1_000,
    slippageBps: 5,
    feePerTrade: 1,
    parameters: { scoreCutoff: 60 } as BacktestRun["parameters"],
    metrics: {
      trades: 4,
      wins: 2,
      losses: 2,
      winRate: 0.5,
      netPnl: 100,
      expectancyR: 0.1,
      profitFactor: 1.1,
      maxDrawdown: 50,
      averageR: 0.1,
    } as unknown as BacktestRun["metrics"],
    analyses: [],
    dataQuality: { warnings: [] } as unknown as BacktestRun["dataQuality"],
    capturedHistoryAvailability: null,
    replayInput: {
      version: "replay-input-v1",
      marketId: "CA_TSX",
      resolvedAt: "2026-09-15T20:00:00.000Z",
      requestedSymbols: ["SYM1"],
      candidateInstruments: [],
      benchmarks: [],
      universeRefreshRunId: null,
      capturedHistoryAvailability: {
        source: "CAPTURED_QUOTES",
        observedAt: "2026-09-15T20:00:00.000Z",
        tables: {
          quoteSnapshot: { earliest: null, latest: null },
          candle: { earliest: null, latest: null },
        },
        replay: { earliestDate: null, latestDate: null },
      },
      warnings: [],
      candidateProvenance: "EXPLICIT_CAPTURED_COHORT",
      sessions: [],
      inputHash: digestA,
    } as unknown as BacktestRun["replayInput"],
    evidence: undefined,
    error: null,
    createdAt: "2026-09-15T19:00:00.000Z",
    startedAt: "2026-09-15T19:00:00.000Z",
    completedAt: "2026-09-15T20:00:00.000Z",
    trades: [],
    researchEvidence: undefined,
  } as unknown as BacktestRun;
}

function event(ordinal: number): StrategyStateEvent {
  return {
    eventId: `event-${ordinal}`,
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    instrumentId: `instrument-${ordinal}`,
    symbol: `SYM${ordinal}`,
    timestamp: `2026-09-15T13:${(30 + ordinal).toString().padStart(2, "0")}:00.000Z`,
    state: "READY",
    score: 70 + ordinal,
    reasonCodes: ["BREAKOUT"],
    setupInstanceId: `setup-${ordinal}`,
    signalSemanticsVersion: "signal-v1",
    featureSnapshot: { featureVersion: "features-v1", atr14: 0.5 },
    entryReference: 100,
    stopReference: 99,
    targetReference: 102,
  } as unknown as StrategyStateEvent;
}

describe("funded comparison session projection", () => {
  it("orders items canonically and keeps source identity independent", () => {
    const { items, opportunities } = project();
    const chunks = chunkFundedComparisonItems("2026-09-15", items);
    const ordered = chunks.flatMap((chunk) => chunk.items.map((e) => e.item));
    expect(ordered[0]!.kind).toBe("SESSION_BOUNDARY");
    expect(ordered[ordered.length - 1]!.kind).toBe("SESSION_BOUNDARY");
    const keys = ordered.map((item) => inputItemOrderKey(item));
    expect([...keys].sort()).toEqual(keys);
    const kinds = ordered.map((item) => item.kind);
    const firstQuote = kinds.indexOf("QUOTE");
    const lastOpportunity = kinds.lastIndexOf("OPPORTUNITY");
    expect(lastOpportunity).toBeLessThan(firstQuote);
    expect(opportunities.map((value) => value.sourceOrdinal)).toEqual([1, 2]);
    expect(opportunities[0]!.sourceOpportunityId).not.toBe(
      opportunities[0]!.sourceEventId,
    );
    for (const item of items) {
      if (item.kind !== "OPPORTUNITY") continue;
      expect(item.sourceOpportunityId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it("orders equal-time CANCEL before CLOCK before SIGNAL before QUOTE", () => {
    const timestamp = "2026-09-15T13:31:00.000Z";
    const { items } = project({
      observations: [observation(1, { signalTimestamp: timestamp })],
      quotes: [quoteRow(timestamp)],
      invalidations: [
        {
          eventId: "event-equal",
          instrumentId: "instrument-1",
          setupInstanceId: "setup-1",
          at: timestamp,
        },
      ],
    });
    const ordered = chunkFundedComparisonItems("2026-09-15", items).flatMap(
      (chunk) => chunk.items.map((entry) => entry.item),
    );
    const at = ordered.filter(
      (item) =>
        (item.kind === "OPPORTUNITY" && item.signalTimestamp === timestamp) ||
        (item.kind === "QUOTE" && item.timestamp === timestamp) ||
        (item.kind === "INVALIDATION" && item.at === timestamp),
    );
    expect(at.map((item) => item.kind)).toEqual([
      "INVALIDATION",
      "OPPORTUNITY",
      "QUOTE",
    ]);
  });

  it("places a same-time signal before a quote supplied first", () => {
    const timestamp = "2026-09-15T13:31:00.000Z";
    const { items } = project({
      observations: [observation(1, { signalTimestamp: timestamp })],
      quotes: [quoteRow(timestamp)],
      invalidations: [],
    });
    const kinds = chunkFundedComparisonItems("2026-09-15", items)
      .flatMap((chunk) => chunk.items.map((entry) => entry.item))
      .filter(
        (item) =>
          (item.kind === "OPPORTUNITY" && item.signalTimestamp === timestamp) ||
          (item.kind === "QUOTE" && item.timestamp === timestamp),
      )
      .map((item) => item.kind);
    expect(kinds).toEqual(["OPPORTUNITY", "QUOTE"]);
  });

  it("normalizes identical equal-time quote sources to one deterministic economic quote", () => {
    const timestamp = "2026-09-15T13:35:00.000Z";
    const questrade = quoteRow(timestamp);
    const mock = { ...questrade, source: "QUESTRADE_MOCK" };
    const forward = project({ quotes: [mock, questrade] });
    const reversed = project({ quotes: [questrade, mock] });
    const forwardQuotes = forward.items.filter((item) => item.kind === "QUOTE");
    const reversedQuotes = reversed.items.filter(
      (item) => item.kind === "QUOTE",
    );
    expect(forwardQuotes).toHaveLength(1);
    expect(forwardQuotes[0]).toMatchObject({ source: "QUESTRADE" });
    expect(reversedQuotes).toEqual(forwardQuotes);
    expect(
      sessionInputDigestOf(
        "2026-09-15",
        chunkFundedComparisonItems("2026-09-15", forward.items),
      ),
    ).toBe(
      sessionInputDigestOf(
        "2026-09-15",
        chunkFundedComparisonItems("2026-09-15", reversed.items),
      ),
    );
  });

  it("rejects conflicting equal-time retained quote sources", () => {
    const timestamp = "2026-09-15T13:35:00.000Z";
    const questrade = quoteRow(timestamp);
    expect(() =>
      project({
        quotes: [
          questrade,
          { ...questrade, source: "QUESTRADE_MOCK", ask: 100.06 },
        ],
      }),
    ).toThrow(/conflicting retained quote sources/i);
  });

  it("keeps canonical order monotone across chunk boundaries", () => {
    const many = Array.from({ length: 2_500 }, (_, index) =>
      observation(index + 1, {
        signalTimestamp: `2026-09-15T13:${(index % 60)
          .toString()
          .padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}.000Z`,
      }),
    );
    const quotes = many
      .slice(0, 1_200)
      .map((row, index) =>
        quoteRow(
          `2026-09-15T14:${(index % 60).toString().padStart(2, "0")}:${(
            index % 60
          )
            .toString()
            .padStart(2, "0")}.000Z`,
          row.instrumentId,
        ),
      );
    const { items } = project({
      observations: many,
      quotes,
      invalidations: [],
    });
    const chunks = chunkFundedComparisonItems("2026-09-15", items);
    expect(chunks.length).toBeGreaterThan(1);
    const keys = chunks.flatMap((chunk) =>
      chunk.items.map((entry) => inputItemOrderKey(entry.item)),
    );
    expect([...keys].sort()).toEqual(keys);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!;
      const next = chunks[index]!;
      const previousLast = inputItemOrderKey(
        previous.items[previous.items.length - 1]!.item,
      );
      const nextFirst = inputItemOrderKey(next.items[0]!.item);
      expect(previousLast <= nextFirst).toBe(true);
    }
  });

  it("maps invalidations to their source opportunity and drops orphans", () => {
    const { items } = project({
      invalidations: [
        {
          eventId: "event-orphan",
          instrumentId: "instrument-9",
          setupInstanceId: "setup-9",
          at: "2026-09-15T13:40:00.000Z",
        },
      ],
    });
    expect(items.some((item) => item.kind === "INVALIDATION")).toBe(false);
    const withMatch = project();
    const invalidation = withMatch.items.find(
      (item) => item.kind === "INVALIDATION",
    );
    expect(invalidation).toMatchObject({
      eventId: "event-1",
      sourceOpportunityId: withMatch.opportunities[0]!.sourceOpportunityId,
    });
  });

  it("chunks at 1,000 items and digests deterministically", () => {
    const many = Array.from({ length: 2_300 }, (_, index) =>
      observation(index + 1, {
        signalTimestamp: `2026-09-15T${(13 + Math.floor(index / 3_600))
          .toString()
          .padStart(
            2,
            "0",
          )}:${(index % 60).toString().padStart(2, "0")}:00.000Z`,
      }),
    );
    const { items } = project({
      observations: many,
      invalidations: [],
      quotes: [],
    });
    const chunks = chunkFundedComparisonItems("2026-09-15", items);
    expect(chunks.map((chunk) => chunk.itemCount)).toEqual([1_000, 1_000, 302]);
    expect(chunks.every((chunk) => chunk.itemCount <= 1_000)).toBe(true);
    const digest = sessionInputDigestOf("2026-09-15", chunks);
    const again = sessionInputDigestOf(
      "2026-09-15",
      chunkFundedComparisonItems("2026-09-15", items),
    );
    expect(again).toBe(digest);
    const mutated = items.map((item) =>
      item.kind === "OPPORTUNITY" && item.sourceOrdinal === 1
        ? { ...item, score: 99 }
        : item,
    );
    const mutatedChunks = chunkFundedComparisonItems("2026-09-15", mutated);
    expect(sessionInputDigestOf("2026-09-15", mutatedChunks)).not.toBe(digest);
  });
});

describe("freezeFundedComparisonSharedInput", () => {
  function deps() {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("context_evaluation"))
          return {
            rows: [
              {
                signalKey: "MARKET_RELATIVE_STRENGTH",
                status: "STRONG",
                timestamp: "2026-09-15T13:29:00.000Z",
                benchmarkTimestamp: null,
              },
            ],
          };
        if (text.includes("quote_snapshot"))
          return {
            rows: [quoteRow("2026-09-15T13:35:00.000Z", "instrument-1")],
          };
        if (text.includes("strategy_state_event"))
          return {
            rows: [
              {
                eventId: "invalidation-1",
                instrumentId: "instrument-1",
                setupInstanceId: "setup-1",
                at: "2026-09-15T13:40:00.000Z",
              },
            ],
          };
        throw new Error(`Unexpected query: ${text}`);
      },
    } as unknown as Pool;
    const store: FundedComparisonBaselineStore = {
      get: async () => baselineRun(),
      loadReplaySessionDates: async () => ["2026-09-15"],
      loadReplaySession: async () => ({
        session: { instruments: [] },
        candles: [],
        quotes: [
          {
            instrumentId: "instrument-1",
            ...realQuote,
          },
        ],
      }),
    };
    const engine = {
      runBacktestSignals: async () =>
        ({ events: [event(2), event(1)] }) as BacktestSignalReplayResult,
    };
    return { pool, store, engine, queries };
  }

  it("materializes the complete shared stream from the retained baseline", async () => {
    const { pool, store, engine } = deps();
    const frozen = await freezeFundedComparisonSharedInput(
      {
        baselineRunId: "baseline-1",
        marketId: "CA_TSX",
        evidenceCutoffAt: "2026-09-15T20:00:00.000Z",
        maxSessions: 20,
        replayPolicy: {
          timezone: "America/Toronto",
          openingRange: { start: "09:30", end: "09:45" },
          scanning: { start: "09:45", end: "16:00" },
          entries: {
            preferredStart: "09:45",
            preferredEnd: "15:30",
            hardEnd: "15:45",
          },
        },
      },
      { pool, store, engine },
    );
    expect(frozen.baseline.backtestRunId).toBe("baseline-1");
    expect(frozen.sessions).toHaveLength(1);
    const session = frozen.sessions[0]!;
    expect(session.chunks).toHaveLength(1);
    expect(session.chunkCount).toBe(1);
    expect(session.opportunities).toHaveLength(2);
    expect(frozen.opportunities).toHaveLength(2);
    expect(frozen.lastInputEffectiveAt).toBe("2026-09-15T20:00:00.000Z");
    expect(session.sessionInputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen.baseline.baselineResultDigest).toMatch(/^[a-f0-9]{64}$/);
    // The immutable replay configuration is part of the frozen output; replay
    // never re-reads mutable backtest_run strategies/parameters.
    expect(frozen.replay.request.marketId).toBe("CA_TSX");
    expect(frozen.replay.request.parameters).toMatchObject({ scoreCutoff: 60 });
    expect(frozen.replay.profiles).toHaveLength(1);
    expect(frozen.replay.profiles[0]).toMatchObject({
      strategyKey: "ORB_RETEST",
    });
    expect(frozen.replay.profiles[0]!.configVersion).toMatch(
      /^funded-historical:/,
    );
  });

  it("rejects retained input after the requested cutoff", async () => {
    const { pool, store, engine } = deps();
    await expect(
      freezeFundedComparisonSharedInput(
        {
          baselineRunId: "baseline-1",
          marketId: "CA_TSX",
          evidenceCutoffAt: "2026-09-15T14:00:00.000Z",
          maxSessions: 20,
          replayPolicy: {
            timezone: "America/Toronto",
            openingRange: { start: "09:30", end: "09:45" },
            scanning: { start: "09:45", end: "16:00" },
            entries: {
              preferredStart: "09:45",
              preferredEnd: "15:30",
              hardEnd: "15:45",
            },
          },
        },
        { pool, store, engine },
      ),
    ).rejects.toThrow(FundedComparisonSpecificationError);
  });

  it("rejects an incomplete baseline", async () => {
    const { pool, store, engine } = deps();
    const incomplete: FundedComparisonBaselineStore = {
      ...store,
      get: async () => ({ ...baselineRun(), status: "RUNNING" }) as BacktestRun,
    };
    await expect(
      freezeFundedComparisonSharedInput(
        {
          baselineRunId: "baseline-1",
          marketId: "CA_TSX",
          evidenceCutoffAt: "2026-09-15T20:00:00.000Z",
          maxSessions: 20,
          replayPolicy: {
            timezone: "America/Toronto",
            openingRange: { start: "09:30", end: "09:45" },
            scanning: { start: "09:45", end: "16:00" },
            entries: {
              preferredStart: "09:45",
              preferredEnd: "15:30",
              hardEnd: "15:45",
            },
          },
        },
        { pool, store: incomplete, engine },
      ),
    ).rejects.toThrow(/not a completed/i);
  });

  it("derives a different session digest when one frozen item changes", async () => {
    const first = deps();
    const frozen = await freezeFundedComparisonSharedInput(
      {
        baselineRunId: "baseline-1",
        marketId: "CA_TSX",
        evidenceCutoffAt: "2026-09-15T20:00:00.000Z",
        maxSessions: 20,
        replayPolicy: {
          timezone: "America/Toronto",
          openingRange: { start: "09:30", end: "09:45" },
          scanning: { start: "09:45", end: "16:00" },
          entries: {
            preferredStart: "09:45",
            preferredEnd: "15:30",
            hardEnd: "15:45",
          },
        },
      },
      { ...first, engine: first.engine },
    );
    const second = deps();
    const changed = await freezeFundedComparisonSharedInput(
      {
        baselineRunId: "baseline-1",
        marketId: "CA_TSX",
        evidenceCutoffAt: "2026-09-15T20:00:00.000Z",
        maxSessions: 20,
        replayPolicy: {
          timezone: "America/Toronto",
          openingRange: { start: "09:30", end: "09:45" },
          scanning: { start: "09:45", end: "16:00" },
          entries: {
            preferredStart: "09:45",
            preferredEnd: "15:30",
            hardEnd: "15:45",
          },
        },
      },
      {
        ...second,
        engine: {
          runBacktestSignals: async () =>
            ({
              events: [
                { ...event(2), score: 99 } as StrategyStateEvent,
                event(1),
              ],
            }) as BacktestSignalReplayResult,
        },
      },
    );
    expect(changed.sessions[0]!.sessionInputDigest).not.toBe(
      frozen.sessions[0]!.sessionInputDigest,
    );
    const changedAt = JSON.parse(
      JSON.stringify(changed.sessions[0]!.chunks),
    ) as unknown;
    expect(
      createHash("sha256").update(JSON.stringify(changedAt)).digest("hex"),
    ).not.toBe(
      createHash("sha256")
        .update(JSON.stringify(frozen.sessions[0]!.chunks))
        .digest("hex"),
    );
  });

  it("exposes verification-ready digests for the specification builder", async () => {
    const { pool, store, engine } = deps();
    const frozen = await freezeFundedComparisonSharedInput(
      {
        baselineRunId: "baseline-1",
        marketId: "CA_TSX",
        evidenceCutoffAt: "2026-09-15T20:00:00.000Z",
        maxSessions: 20,
        replayPolicy: {
          timezone: "America/Toronto",
          openingRange: { start: "09:30", end: "09:45" },
          scanning: { start: "09:45", end: "16:00" },
          entries: {
            preferredStart: "09:45",
            preferredEnd: "15:30",
            hardEnd: "15:45",
          },
        },
      },
      { pool, store, engine },
    );
    const profileConfigIds = new Set(
      frozen.opportunities.map((value) => value.profileConfigId),
    );
    expect(profileConfigIds.size).toBe(1);
    expect(frozen.profiles).toHaveLength(1);
    expect(
      fundedHistoricalProfiles(
        "CA_TSX",
        ["ORB_RETEST"],
        frozen.baseline.configVersion === "config-1"
          ? frozen.profiles[0]!.configVersion.split(":")[0]!
          : "unused",
      ),
    ).toHaveLength(1);
  });
});
