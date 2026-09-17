import { describe, expect, it, vi } from "vitest";
import type {
  BacktestReplayResult,
  BacktestRun,
  CreateBacktest,
  ReplayInputSnapshot,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { BacktestJobHandler } from "../src/worker/handlers/backtest-job-handler.js";
import { CancelledError } from "../src/worker/research-worker.js";
import type {
  ClaimedResearchJob,
  JobContext,
} from "../src/worker/research-worker.js";

const input: CreateBacktest = {
  name: "test",
  marketId: "CA_TSX",
  startDate: "2026-08-01",
  endDate: "2026-08-02",
  strategies: ["ORB_RETEST"],
  symbols: [],
  dataSource: "CAPTURED_QUOTES",
  startingCapital: 100_000,
  positionSize: 10_000,
  slippageBps: 2,
  feePerTrade: 9.95,
  parameters: {
    rvolAtTimeMin: 1.5,
    spreadHardMaxPct: 0.25,
    atrPctMin: 0,
    breakoutVolumeRatioMin: 1.5,
    retestTolerancePct: 0.15,
    scoreCutoff: 0,
    breakoutBufferPct: 0.05,
    relativeStrengthMinPct: 0.5,
    flagpoleMinAtr: 0.5,
    flagRetracementMaxPct: 50,
    setupTimeoutMinutes: 20,
    consolidationBarsMin: 3,
    consolidationRangeMaxPct: 0.75,
    flagDurationBarsMin: 1,
    flagDurationBarsMax: 2,
    flagpoleMinSlopeAtrPerBar: 0,
    volumeContractionMaxPct: 100,
  },
};
const run = {
  id: "10000000-0000-4000-8000-000000000080",
  ...input,
  status: "PENDING",
  strategyVersion: "1.0.0",
  configVersion: "phase8-test",
  executionModelVersion: "legacy-python-v1",
  executionAssumptions: {},
  supersedesBacktestRunId: null,
  metrics: null,
  analyses: [],
  dataQuality: null,
  capturedHistoryAvailability: null,
  replayInput: null,
  evidence: null,
  error: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  trades: [],
} as BacktestRun;
const replayInput: ReplayInputSnapshot = {
  version: "replay-input-v1",
  marketId: "CA_TSX",
  resolvedAt: "2026-08-25T00:00:00.000Z",
  requestedSymbols: [],
  candidateInstruments: [
    {
      instrumentId: "10000000-0000-4000-8000-00000000008a",
      symbol: "HIST.TO",
      sector: "Materials",
    },
  ],
  benchmarks: [],
  universeRefreshRunId: null,
  capturedHistoryAvailability: {
    source: "CAPTURED_QUOTES",
    observedAt: "2026-08-25T00:00:00.000Z",
    tables: {
      quoteSnapshot: {
        earliest: "2026-08-01T13:30:00.000Z",
        latest: "2026-08-25T20:00:00.000Z",
      },
      candle: { earliest: null, latest: null },
    },
    replay: { earliestDate: "2026-08-01", latestDate: "2026-08-25" },
  },
  warnings: [],
  candidateProvenance: "CURRENT_ACTIVE_UNIVERSE",
  sessions: [],
  inputHash: "0".repeat(64),
};
const availability = replayInput.capturedHistoryAvailability;
const finalResult = {
  metrics: { tradesSimulated: 0 },
  trades: [],
  timeline: [],
  analyses: [],
  dataQuality: {
    quoteSnapshots: 0,
    candles: 0,
    sessions: 2,
    spread: "CAPTURED",
    warnings: [],
  },
} as unknown as BacktestReplayResult;
const signalResult = {
  events: [],
  contexts: [],
  dataQuality: finalResult.dataQuality,
};

const policy = {
  timezone: "America/Toronto" as const,
  openingRange: { start: "09:30", end: "09:45" },
  scanning: { start: "09:45", end: "12:00" },
  entries: { preferredStart: "10:00", preferredEnd: "11:30", hardEnd: "12:00" },
};

function fakeSessionPayload(date: string, quotes: unknown[] = []) {
  return {
    session: {
      startTime: date,
      timezone: "America/Toronto",
      instruments: [],
    },
    candles: [],
    quotes,
  };
}

function fakeStore(dates: string[], quotes: unknown[] = []) {
  return {
    getCapturedHistoryAvailability: vi.fn(async () => availability),
    resolveReplayInput: vi.fn(async () => replayInput),
    create: vi.fn(async () => run),
    markRunning: vi.fn(async () => {}),
    loadReplaySessionDates: vi.fn(async () => dates),
    loadReplaySession: vi.fn(
      async (_replayInput: unknown, _policy: unknown, date: string) =>
        fakeSessionPayload(date, quotes),
    ),
    loadVerifiedReplaySession: vi.fn(async (_hash: string, date: string) =>
      fakeSessionPayload(date, quotes),
    ),
    complete: vi.fn(
      async () => ({ ...run, id: run.id, status: "COMPLETED" }) as BacktestRun,
    ),
    fail: vi.fn(async () => {}),
  };
}

function fakeJob(): ClaimedResearchJob {
  return {
    id: "job-1",
    jobType: "BACKTEST",
    status: "RUNNING",
    resultRefId: null,
    progress: {},
    error: null,
    errorCategory: null,
    attemptCount: 1,
    maxAttempts: 3,
    cancellationRequested: false,
    createdAt: "2026-08-28T00:00:00.000Z",
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: null,
    requestPayload: input,
    leaseOwner: "worker-a",
  };
}

describe("BacktestJobHandler (W8 chunked session-cursor execution)", () => {
  it("streams one chunk per session, heartbeating between them, and persists the final result", async () => {
    const store = fakeStore(["2026-08-01", "2026-08-02"]);
    const chunkCalls: {
      chunkId: string;
      isFinal: boolean;
      marketId: unknown;
    }[] = [];
    const scanner = {
      runBacktestSignals: vi.fn(),
      runBacktestSignalChunk: vi.fn(
        async (
          chunkId: string,
          meta: { marketId?: unknown },
          _session,
          isFinal: boolean,
        ) => {
          chunkCalls.push({ chunkId, isFinal, marketId: meta.marketId });
          return signalResult;
        },
      ),
    };
    const heartbeats: unknown[] = [];
    const context: JobContext = {
      jobId: "job-1",
      heartbeat: vi.fn(async (progress) => {
        heartbeats.push(progress);
        return { cancellationRequested: false };
      }),
    };
    const handler = new BacktestJobHandler(
      store as never,
      scanner as never,
      policy,
    );
    const result = await handler.execute(fakeJob(), context);

    expect(result.resultRefId).toBe(run.id);
    expect(chunkCalls).toEqual([
      { chunkId: run.id, isFinal: false, marketId: "CA_TSX" },
      { chunkId: run.id, isFinal: true, marketId: "CA_TSX" },
    ]);
    expect(scanner.runBacktestSignals).not.toHaveBeenCalled();
    expect(heartbeats).toEqual([
      {
        totalSessions: 2,
        completedSessions: 0,
        message: "Loading session 2026-08-01",
      },
      {
        totalSessions: 2,
        completedSessions: 1,
        message: "Loading session 2026-08-02",
      },
    ]);
    expect(store.complete).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ trades: [], timeline: [] }),
      expect.anything(),
    );
    expect(store.markRunning).toHaveBeenCalledWith(run.id);
  });

  it("stops between sessions and marks the run failed with a cancellation message when cancellation is observed", async () => {
    const store = fakeStore(["2026-08-01", "2026-08-02"]);
    const scanner = {
      runBacktestSignals: vi.fn(),
      runBacktestSignalChunk: vi.fn(async () => signalResult),
    };
    let calls = 0;
    const context: JobContext = {
      jobId: "job-1",
      heartbeat: vi.fn(async () => {
        calls++;
        return { cancellationRequested: calls > 1 };
      }),
    };
    const handler = new BacktestJobHandler(
      store as never,
      scanner as never,
      policy,
    );
    await expect(handler.execute(fakeJob(), context)).rejects.toBeInstanceOf(
      CancelledError,
    );
    // Only the first session's chunk was sent before cancellation was observed.
    expect(scanner.runBacktestSignalChunk).toHaveBeenCalledTimes(1);
    expect(store.fail).toHaveBeenCalledWith(run.id, "Cancelled by request");
  });

  it("calls the unchunked engine once (sessions: []) when the range has no captured sessions", async () => {
    const store = fakeStore([]);
    const scanner = {
      runBacktestSignals: vi.fn(async () => signalResult),
      runBacktestSignalChunk: vi.fn(),
    };
    const context: JobContext = { jobId: "job-1", heartbeat: vi.fn() };
    const handler = new BacktestJobHandler(
      store as never,
      scanner as never,
      policy,
    );
    const result = await handler.execute(fakeJob(), context);
    expect(result.resultRefId).toBe(run.id);
    expect(scanner.runBacktestSignals).toHaveBeenCalledWith(
      expect.objectContaining({ sessions: [] }),
    );
    expect(scanner.runBacktestSignalChunk).not.toHaveBeenCalled();
  });

  it("categorizes a captured-history-unavailable rejection instead of throwing an opaque error", async () => {
    const store = fakeStore([]);
    store.getCapturedHistoryAvailability = vi.fn(async () => ({
      source: "CAPTURED_QUOTES" as const,
      observedAt: "2026-08-25T00:00:00.000Z",
      tables: {
        quoteSnapshot: { earliest: null, latest: null },
        candle: { earliest: null, latest: null },
      },
      replay: { earliestDate: null, latestDate: null },
    }));
    const scanner = {
      runBacktestSignals: vi.fn(),
      runBacktestSignalChunk: vi.fn(),
    };
    const context: JobContext = { jobId: "job-1", heartbeat: vi.fn() };
    const handler = new BacktestJobHandler(
      store as never,
      scanner as never,
      policy,
    );
    await expect(handler.execute(fakeJob(), context)).rejects.toMatchObject({
      category: "HISTORY_UNAVAILABLE",
    });
  });

  it("sends only admitted quotes to the scanner and reports exclusions", async () => {
    const instrumentId = "10000000-0000-4000-8000-000000000081";
    const store = fakeStore(
      ["2026-08-01"],
      [
        {
          instrumentId,
          timestamp: "2026-08-01T13:30:00.000Z",
          bid: 10,
          ask: 10.01,
          bidSize: 100,
          askSize: 100,
          spread: 0.01,
          last: 10,
          dayOpen: 0,
          dataStatus: "REALTIME",
          actionable: true,
        },
        {
          instrumentId,
          timestamp: "2026-08-01T13:31:00.000Z",
          bid: 10,
          ask: 10.01,
          bidSize: 100,
          askSize: 100,
          spread: 0.01,
          last: 10,
          dayOpen: 10,
          dataStatus: "REALTIME",
          actionable: true,
        },
      ],
    );
    let dispatchedQuotes: unknown[] | undefined;
    const scanner = {
      runBacktestSignals: vi.fn(),
      runBacktestSignalChunk: vi.fn(
        async (
          _chunkId: string,
          _meta: unknown,
          session: { quotes?: unknown[] },
        ) => {
          dispatchedQuotes = session.quotes;
          return signalResult;
        },
      ),
    };
    const context: JobContext = {
      jobId: "job-1",
      heartbeat: vi.fn(async () => ({ cancellationRequested: false })),
    };
    const handler = new BacktestJobHandler(
      store as never,
      scanner as never,
      policy,
    );
    await handler.execute(fakeJob(), context);

    expect(dispatchedQuotes).toHaveLength(1);
    expect(store.complete).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({
        dataQuality: expect.objectContaining({
          quoteSnapshots: 2,
          admittedQuotes: 1,
          excludedQuotes: 1,
        }),
      }),
      expect.anything(),
    );
  });

  it("asserts coverage only from a resolved verified binding", async () => {
    const instrumentId = "10000000-0000-4000-8000-000000000081";
    const at = (time: string) => `2026-08-01T${time}:00.000Z`;
    const store = fakeStore(
      ["2026-08-01"],
      [
        ["14:00", 9.99, 10, 9.9],
        ["14:10", 10, 10.01, 9.9],
        ["14:20", 10.5, 10.51, 9.9],
        ["14:30", 11, 11.01, 9.9],
      ].map(([time, bid, ask, dayOpen]) => ({
        instrumentId,
        timestamp: at(time as string),
        bid,
        ask,
        bidSize: 500,
        askSize: 500,
        spread: 0.01,
        last: bid,
        dayOpen,
        dataStatus: "REALTIME",
        actionable: true,
      })),
    );
    const readyEvent = {
      kind: "SETUP",
      marketId: "CA_TSX",
      eventId: "10000000-0000-4000-8000-000000000083",
      eventType: "STRATEGY_STATE_CHANGED",
      previousState: "FORMING",
      state: "READY",
      instrumentId,
      symbol: "ABC.TO",
      timestamp: at("14:00"),
      profileId: "10000000-0000-4000-8000-000000000082",
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
    } as unknown as StrategyStateEvent;
    const scanner = {
      runBacktestSignals: vi.fn(),
      runBacktestSignalChunk: vi.fn(async () => ({
        ...signalResult,
        events: [readyEvent],
      })),
    };
    const context: JobContext = {
      jobId: "job-1",
      heartbeat: vi.fn(async () => ({ cancellationRequested: false })),
    };
    const handler = new BacktestJobHandler(
      store as never,
      scanner as never,
      policy,
      undefined,
      {
        resolve: async () =>
          ({
            coverageReportHash: "report-hash",
          }) as never,
      },
    );
    await handler.execute(fakeJob(), context);

    const [, output] = store.complete.mock.calls[0] as unknown as [
      string,
      BacktestReplayResult,
      unknown,
    ];
    expect(output.trades[0]?.sampledExcursion).toMatchObject({
      status: "AVAILABLE",
      samples: 2,
    });
  });

  it("keeps sampled diagnostics unverified when no binding resolves", async () => {
    const instrumentId = "10000000-0000-4000-8000-000000000081";
    const store = fakeStore(
      ["2026-08-01"],
      [
        ["14:00", 9.99, 10],
        ["14:10", 10, 10.01],
        ["14:20", 10.5, 10.51],
        ["14:30", 11, 11.01],
      ].map(([time, bid, ask]) => ({
        instrumentId,
        timestamp: `2026-08-01T${time}:00.000Z`,
        bid,
        ask,
        bidSize: 500,
        askSize: 500,
        spread: 0.01,
        last: bid,
        dayOpen: 9.9,
        dataStatus: "REALTIME",
        actionable: true,
      })),
    );
    const readyEvent = {
      kind: "SETUP",
      marketId: "CA_TSX",
      eventId: "10000000-0000-4000-8000-000000000083",
      eventType: "STRATEGY_STATE_CHANGED",
      previousState: "FORMING",
      state: "READY",
      instrumentId,
      symbol: "ABC.TO",
      timestamp: "2026-08-01T14:00:00.000Z",
      profileId: "10000000-0000-4000-8000-000000000082",
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
    } as unknown as StrategyStateEvent;
    const scanner = {
      runBacktestSignals: vi.fn(),
      runBacktestSignalChunk: vi.fn(async () => ({
        ...signalResult,
        events: [readyEvent],
      })),
    };
    const context: JobContext = {
      jobId: "job-1",
      heartbeat: vi.fn(async () => ({ cancellationRequested: false })),
    };
    const handler = new BacktestJobHandler(
      store as never,
      scanner as never,
      policy,
    );
    await handler.execute(fakeJob(), context);

    const [, output] = store.complete.mock.calls[0] as unknown as [
      string,
      BacktestReplayResult,
      unknown,
    ];
    expect(output.trades[0]?.sampledExcursion).toMatchObject({
      status: "UNAVAILABLE",
    });
    expect(output.trades[0]?.sampledExcursion?.reasonCodes).toContain(
      "COVERAGE_UNVERIFIED",
    );
  });

  it("rejects a replay input with no candidate-bearing session", async () => {
    const store = {
      ...fakeStore(["2026-08-01"]),
      resolveReplayInput: vi.fn(async () => ({
        ...replayInput,
        candidateInstruments: [],
      })),
    };
    const scanner = {
      runBacktestSignals: vi.fn(),
      runBacktestSignalChunk: vi.fn(),
    };
    const context: JobContext = {
      jobId: "job-1",
      heartbeat: vi.fn(async () => ({ cancellationRequested: false })),
    };
    const handler = new BacktestJobHandler(
      store as never,
      scanner as never,
      policy,
    );

    await expect(handler.execute(fakeJob(), context)).rejects.toThrow(
      "NO_REPLAY_CANDIDATES",
    );
    expect(store.create).not.toHaveBeenCalled();
    expect(scanner.runBacktestSignalChunk).not.toHaveBeenCalled();
  });
});
