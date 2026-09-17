import { describe, expect, it } from "vitest";
import type {
  BacktestReplayResult,
  BacktestRun,
  CreateBacktest,
  ReplayInputSnapshot,
} from "@tsx-scanner/contracts";
import {
  BacktestError,
  BacktestService,
  versionFor,
  type BacktestSignalEngine,
  type BacktestStore,
} from "../src/backtests/backtest-service.js";

const input: CreateBacktest = {
  name: "test",
  marketId: "CA_TSX",
  startDate: "2026-08-01",
  endDate: "2026-08-25",
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
      instrumentId: "10000000-0000-4000-8000-000000000081",
      symbol: "HIST.TO",
      sector: "Materials",
    },
  ],
  benchmarks: [
    {
      instrumentId: "10000000-0000-4000-8000-000000000082",
      symbol: "XIU.TO",
      sector: null,
      kind: "MARKET",
      benchmarkSector: null,
    },
  ],
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
const output = {
  metrics: { tradesSimulated: 0 },
  trades: [],
  timeline: [],
  analyses: [],
  dataQuality: {
    quoteSnapshots: 0,
    candles: 0,
    sessions: 0,
    spread: "UNAVAILABLE",
    warnings: [],
  },
} as unknown as BacktestReplayResult;
const signalOutput = {
  events: [],
  contexts: [],
  dataQuality: output.dataQuality,
};

class Store implements BacktestStore {
  runs = [run];
  failed = false;
  evidenceQualification?: string;
  createdReplayInput?: ReplayInputSnapshot;
  loadedReplayInput?: ReplayInputSnapshot;
  supersedesBacktestRunId?: string;
  async create(
    _input: CreateBacktest,
    _version: string,
    _availability: Parameters<BacktestStore["create"]>[2],
    inputSnapshot: ReplayInputSnapshot,
    supersedesBacktestRunId?: string,
  ): Promise<BacktestRun> {
    this.createdReplayInput = inputSnapshot;
    this.supersedesBacktestRunId = supersedesBacktestRunId;
    return {
      ...run,
      executionModelVersion: "paper-execution-v1",
      supersedesBacktestRunId: supersedesBacktestRunId ?? null,
      replayInput: inputSnapshot,
    };
  }
  async markRunning(): Promise<void> {}
  async complete(
    _id: string,
    _output: BacktestReplayResult,
    evidence: Parameters<BacktestStore["complete"]>[2],
  ): Promise<BacktestRun> {
    this.evidenceQualification = evidence.qualification;
    return { ...run, status: "COMPLETED", evidence };
  }
  async fail(): Promise<void> {
    this.failed = true;
  }
  async list(): Promise<BacktestRun[]> {
    return this.runs;
  }
  async get(id: string): Promise<BacktestRun | undefined> {
    return this.runs.find((value) => value.id === id);
  }
  async loadReplayData(
    _input: CreateBacktest,
    inputSnapshot: ReplayInputSnapshot,
  ): Promise<Record<string, unknown>> {
    this.loadedReplayInput = inputSnapshot;
    return {
      sessions: [
        {
          session: { timezone: "America/Toronto", instruments: [] },
          quotes: [],
          candles: [],
        },
      ],
    };
  }
  async resolveReplayInput(): Promise<ReplayInputSnapshot> {
    return replayInput;
  }
  async getCapturedHistoryAvailability() {
    return {
      source: "CAPTURED_QUOTES" as const,
      observedAt: "2026-08-25T00:00:00.000Z",
      tables: {
        quoteSnapshot: {
          earliest: "2026-08-01T13:30:00.000Z",
          latest: "2026-08-25T20:00:00.000Z",
        },
        candle: { earliest: null, latest: null },
      },
      replay: { earliestDate: "2026-08-01", latestDate: "2026-08-25" },
    };
  }
}
const policy = {
  timezone: "America/Toronto" as const,
  openingRange: { start: "09:30", end: "09:45" },
  scanning: { start: "09:45", end: "12:00" },
  entries: { preferredStart: "10:00", preferredEnd: "11:30", hardEnd: "12:00" },
};

describe("Phase 8 backtest service", () => {
  it("versions parameters deterministically and completes a replay", async () => {
    expect(versionFor(input.parameters)).toBe(
      versionFor({ ...input.parameters }),
    );
    const engine: BacktestSignalEngine = {
      runBacktestSignals: async (payload) => {
        expect(payload).toMatchObject({
          runId: run.id,
          marketId: "CA_TSX",
          strategies: ["ORB_RETEST"],
        });
        return signalOutput;
      },
    };
    const store = new Store(),
      completed = await new BacktestService(store, engine, policy).createRun(
        input,
      );
    expect(completed.status).toBe("COMPLETED");
    expect(store.evidenceQualification).toBe("EXPLORATORY");
    expect(store.createdReplayInput).toEqual(replayInput);
    expect(store.loadedReplayInput).toEqual(replayInput);
  });
  it("rejects reversed ranges before creating a run", async () => {
    const service = new BacktestService(
      new Store(),
      { runBacktestSignals: async () => signalOutput },
      policy,
    );
    await expect(
      service.createRun({
        ...input,
        startDate: "2026-08-26",
        endDate: "2026-08-25",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RANGE",
    } satisfies Partial<BacktestError>);
  });

  it("requires the US paper-policy slippage floor for new backtests", async () => {
    await expect(
      new BacktestService(
        new Store(),
        { runBacktestSignals: async () => signalOutput },
        policy,
      ).createRun({ ...input, marketId: "US_EQUITIES", slippageBps: 2 }),
    ).rejects.toMatchObject({
      code: "INVALID_RANGE",
    } satisfies Partial<BacktestError>);
  });

  it("rejects a replay snapshot from a different market before persistence", async () => {
    const store = new Store();
    store.resolveReplayInput = async () => ({
      ...replayInput,
      marketId: "US_EQUITIES",
    });
    await expect(
      new BacktestService(
        store,
        { runBacktestSignals: async () => signalOutput },
        policy,
      ).createRun(input),
    ).rejects.toMatchObject({
      code: "REPLAY_INPUT_UNAVAILABLE",
    } satisfies Partial<BacktestError>);
  });
  it("replays an immutable legacy snapshot and records replacement lineage", async () => {
    const store = new Store();
    let swapped = false;
    const source = {
      ...run,
      replayInput,
      dataQuality: output.dataQuality,
    };
    const completed = await new BacktestService(
      store,
      { runBacktestSignals: async () => signalOutput },
      policy,
      {
        async linkBacktestEvidence() {},
        async replaceBacktestEvidence(oldRun, replacement) {
          expect(oldRun.id).toBe(source.id);
          expect(replacement.status).toBe("COMPLETED");
          swapped = true;
        },
      },
    ).createReplacementRun(source);
    expect(completed.status).toBe("COMPLETED");
    expect(store.createdReplayInput).toEqual(replayInput);
    expect(store.supersedesBacktestRunId).toBe(source.id);
    expect(swapped).toBe(true);
  });

  it("marks legacy evidence unreplayable before creating a replacement", async () => {
    const service = new BacktestService(
      new Store(),
      { runBacktestSignals: async () => signalOutput },
      policy,
    );
    await expect(service.createReplacementRun(run)).rejects.toMatchObject({
      code: "REPLAY_INPUT_UNAVAILABLE",
    } satisfies Partial<BacktestError>);
    await expect(
      service.createReplacementRun({
        ...run,
        replayInput,
        dataQuality: {
          ...output.dataQuality,
          quoteSnapshots: 1,
          sessions: 2,
        },
      }),
    ).rejects.toMatchObject({
      code: "REPLAY_COVERAGE_INCOMPLETE",
    } satisfies Partial<BacktestError>);
  });
  it("rejects a range outside captured quote history before creating a run", async () => {
    const store = new Store();
    store.getCapturedHistoryAvailability = async () => ({
      source: "CAPTURED_QUOTES",
      observedAt: "2026-08-25T00:00:00.000Z",
      tables: {
        quoteSnapshot: {
          earliest: "2026-08-10T13:30:00.000Z",
          latest: "2026-08-25T20:00:00.000Z",
        },
        candle: { earliest: null, latest: null },
      },
      replay: { earliestDate: "2026-08-10", latestDate: "2026-08-25" },
    });
    await expect(
      new BacktestService(
        store,
        { runBacktestSignals: async () => signalOutput },
        policy,
      ).createRun(input),
    ).rejects.toMatchObject({
      code: "HISTORY_UNAVAILABLE",
    } satisfies Partial<BacktestError>);
  });
  it("does not compare runs whose resolved universes differ", async () => {
    const alternate = {
      ...run,
      id: "10000000-0000-4000-8000-000000000083",
      replayInput: { ...replayInput, inputHash: "1".repeat(64) },
    };
    const store = new Store();
    store.runs = [{ ...run, replayInput }, alternate];
    await expect(
      new BacktestService(
        store,
        { runBacktestSignals: async () => signalOutput },
        policy,
      ).compare([run.id, alternate.id]),
    ).resolves.toMatchObject({
      comparable: false,
      differences: ["universe"],
    });
  });

  it("refuses comparisons with missing or mixed execution provenance", async () => {
    const secondId = "10000000-0000-4000-8000-000000000084";
    const store = new Store();
    store.runs = [
      { ...run, executionModelVersion: null, executionAssumptions: null },
      {
        ...run,
        id: secondId,
        executionModelVersion: null,
        executionAssumptions: null,
      },
    ];
    const service = new BacktestService(
      store,
      { runBacktestSignals: async () => signalOutput },
      policy,
    );
    await expect(service.compare([run.id, secondId])).resolves.toMatchObject({
      comparable: false,
      differences: ["execution model provenance"],
    });

    store.runs = [
      run,
      { ...run, id: secondId, executionModelVersion: "paper-execution-v1" },
    ];
    await expect(service.compare([run.id, secondId])).resolves.toMatchObject({
      comparable: false,
      differences: ["execution model"],
    });

    store.runs = [
      run,
      {
        ...run,
        id: secondId,
        executionAssumptions: { latencyPolicy: "CAPTURED_PER_ORDER" },
      },
    ];
    await expect(service.compare([run.id, secondId])).resolves.toMatchObject({
      comparable: false,
      differences: ["execution assumptions"],
    });
  });
});
