import { describe, expect, it, vi, afterEach } from "vitest";
import { AuthoritativeBacktestAccumulator } from "../src/backtests/authoritative-backtest-executor.js";
import {
  createCalibrationSchema,
  type BacktestMetrics,
  type BacktestReplayResult,
  type BacktestSignalReplayResult,
  type BacktestRun,
  type CalibrationRun,
  type CalibrationTrial,
  type CreateBacktest,
  type ReplayInputSnapshot,
} from "@tsx-scanner/contracts";
import type { BacktestStore } from "../src/backtests/backtest-service.js";
import {
  CalibrationService,
  combinationCount,
  combinations,
  robustScore,
  weaknessWarnings,
} from "../src/calibration/calibration-service.js";
import type { CalibrationStore } from "../src/calibration/calibration-repository.js";

const input = createCalibrationSchema.parse({
  name: "Robust ORB",
  startDate: "2026-01-01",
  endDate: "2026-06-30",
  strategy: "ORB_RETEST",
  minimumTradesPerSegment: 1,
  maxCombinations: 8,
  grid: {
    rvolAtTimeMin: [1.5, 2],
    spreadHardMaxPct: [0.25],
    atrPctMin: [1.5],
    openingRangeMinutes: [15],
    breakoutVolumeRatioMin: [1.5],
    retestTolerancePct: [0.15],
    scoreCutoff: [70],
    entryWindowEnd: ["11:30"],
    stopMethod: ["STRUCTURAL"],
    rewardRiskRatio: [2],
  },
});
const metrics: BacktestMetrics = {
  signalsGenerated: 3,
  readySignals: 2,
  tradesSimulated: 2,
  wins: 1,
  losses: 1,
  winRate: 50,
  averageWin: 100,
  averageLoss: 50,
  averageR: 0.5,
  medianR: 0.5,
  profitFactor: 2,
  expectancy: 25,
  netPnl: 50,
  maximumDrawdown: 50,
  maximumDrawdownPct: 0.05,
  falseBreakoutRate: 50,
  signalToTradeConversion: 100,
  averageHoldMinutes: 15,
  observations: 1,
  eligibleSignals: 1,
  fills: 1,
  noFills: 0,
  closePending: 0,
  closedTrades: 1,
};
const output: BacktestReplayResult = {
  metrics,
  analyses: [],
  trades: [],
  timeline: [],
  dataQuality: {
    quoteSnapshots: 10,
    candles: 10,
    sessions: 1,
    spread: "CAPTURED",
    warnings: [],
  },
};
const signalOutput: BacktestSignalReplayResult = {
  events: [],
  contexts: [],
  dataQuality: output.dataQuality,
};
const id = "10000000-0000-4000-8000-000000000099";
class Calibrations implements CalibrationStore {
  async getForJob(): Promise<CalibrationRun | undefined> {
    return this.value;
  }
  value = {
    id,
    marketId: "CA_TSX",
    name: input.name,
    status: "PENDING",
    startDate: input.startDate,
    endDate: input.endDate,
    strategy: input.strategy,
    symbols: [],
    dataSource: "CAPTURED_QUOTES",
    executionModelVersion: "paper-execution-v1",
    executionAssumptions: {},
    input,
    capturedHistoryAvailability: null,
    combinationsTested: 0,
    totalCombinations: 2,
    truncated: false,
    splitDates: null,
    recommendation: "",
    recommendedConfig: null,
    trials: [],
    holdoutSelection: null,
    error: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  } as CalibrationRun;
  async create(): Promise<CalibrationRun> {
    return this.value;
  }
  async markRunning(): Promise<boolean> {
    if (this.value.status !== "PENDING") return false;
    this.value.status = "RUNNING";
    return true;
  }
  async freezeSelection(
    ...args: Parameters<CalibrationStore["freezeSelection"]>
  ): Promise<void> {
    this.value.holdoutSelection = structuredClone(args[1]);
    this.value.trials = structuredClone(args[2]);
    this.value.splitDates = args[3];
  }
  async fail(): Promise<void> {
    this.value.status = "FAILED";
  }
  async complete(
    _id: string,
    value: {
      trials: CalibrationTrial[];
      splitDates: { trainEnd: string; validationEnd: string };
      recommendation: string;
      recommendedConfig: CalibrationTrial["parameters"] | null;
      combinationsTested: number;
    },
  ): Promise<CalibrationRun> {
    this.value = { ...this.value, ...value, status: "COMPLETED" };
    return this.value;
  }
  async list(): Promise<CalibrationRun[]> {
    return [this.value];
  }
  async get(): Promise<CalibrationRun> {
    return this.value;
  }
}
class History implements BacktestStore {
  async create(_input: CreateBacktest, _version: string): Promise<BacktestRun> {
    throw new Error("unused");
  }
  async markRunning(): Promise<void> {}
  async complete(): Promise<BacktestRun> {
    throw new Error("unused");
  }
  async fail(): Promise<void> {}
  async list(): Promise<BacktestRun[]> {
    return [];
  }
  async get(): Promise<BacktestRun | undefined> {
    return undefined;
  }
  async loadReplayData() {
    return {
      sessions: [
        {
          session: {
            startTime: "2026-02-01T14:30:00.000Z",
            timezone: "America/Toronto",
            instruments: [],
            openingRange: { start: "09:30", end: "09:45" },
            scanning: { start: "09:45", end: "12:00" },
            entries: {
              preferredStart: "10:00",
              preferredEnd: "11:30",
              hardEnd: "12:00",
            },
          },
          candles: [],
          quotes: [],
        },
      ],
    };
  }
  async resolveReplayInput(): Promise<ReplayInputSnapshot> {
    return {
      version: "replay-input-v1",
      marketId: "CA_TSX",
      resolvedAt: "2026-06-30T20:00:00.000Z",
      requestedSymbols: [],
      candidateInstruments: [],
      benchmarks: [],
      universeRefreshRunId: null,
      capturedHistoryAvailability: await this.getCapturedHistoryAvailability(),
      warnings: [],
      candidateProvenance: "CURRENT_ACTIVE_UNIVERSE",
      sessions: [],
      inputHash: "0".repeat(64),
    };
  }
  async getCapturedHistoryAvailability() {
    return {
      source: "CAPTURED_QUOTES" as const,
      observedAt: "2026-08-25T00:00:00.000Z",
      tables: {
        quoteSnapshot: {
          earliest: "2026-01-01T14:30:00.000Z",
          latest: "2026-06-30T20:00:00.000Z",
        },
        candle: { earliest: null, latest: null },
      },
      replay: { earliestDate: "2026-01-01", latestDate: "2026-06-30" },
    };
  }
}

describe("Phase 9 calibration service", () => {
  afterEach(() => vi.restoreAllMocks());

  async function holdoutFixture(testFails = false) {
    const store = new Calibrations();
    const history = new History();
    const seed = (await history.loadReplayData()).sessions[0]!;
    history.loadReplayData = async () => ({
      sessions: ["2026-02-01", "2026-05-01", "2026-06-15"].map((date) => ({
        ...seed,
        session: { ...seed.session, startTime: `${date}T14:30:00.000Z` },
      })),
    });
    let finishes = 0;
    const finish = AuthoritativeBacktestAccumulator.prototype.finish;
    vi.spyOn(
      AuthoritativeBacktestAccumulator.prototype,
      "finish",
    ).mockImplementation(function (this: AuthoritativeBacktestAccumulator) {
      const actual = finish.call(this);
      finishes++;
      return {
        ...actual,
        output: {
          ...output,
          metrics:
            testFails && finishes === 5
              ? { ...metrics, expectancy: -25, averageR: -0.5 }
              : metrics,
        },
      };
    });
    const calls: Array<{ date: string; configVersion: string }> = [];
    const engine = {
      runBacktestSignals: vi.fn(async (request: unknown) => {
        const value = request as {
          configVersion: string;
          sessions: Array<{ session: { startTime: string } }>;
        };
        for (const session of value.sessions) {
          const date = session.session.startTime.slice(0, 10);
          if (date === "2026-06-15") {
            expect(store.value.holdoutSelection?.configVersion).toBe(
              value.configVersion,
            );
            expect(store.value.trials).toHaveLength(2);
            expect(
              store.value.trials.every((trial) => trial.segments.TEST === null),
            ).toBe(true);
          }
          calls.push({ date, configVersion: value.configVersion });
        }
        return signalOutput;
      }),
    };
    const service = new CalibrationService(store, history, engine, {
      timezone: "America/Toronto",
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:45", end: "12:00" },
      entries: {
        preferredStart: "10:00",
        preferredEnd: "11:30",
        hardEnd: "12:00",
      },
    });
    return { store, service, engine, calls, history };
  }

  it.each([false, true])(
    "freezes selection before one TEST execution, with no fallback after failure=%s",
    async (testFails) => {
      const { service, calls } = await holdoutFixture(testFails);
      const result = await service.create(input, id);
      expect(calls.map((value) => value.date)).toEqual([
        "2026-02-01",
        "2026-05-01",
        "2026-02-01",
        "2026-05-01",
        "2026-06-15",
      ]);
      expect(
        result.trials.filter((trial) => trial.segments.TEST !== null),
      ).toHaveLength(1);
      expect(result.trials.every((trial) => trial.segments.ALL === null)).toBe(
        true,
      );
      expect(result.recommendedConfig === null).toBe(testFails);
      expect(await service.create(input, id)).toEqual(result);
      expect(calls).toHaveLength(5);
    },
  );

  it("never exposes TEST if persisting the selection fails, and refuses a failed-job restart", async () => {
    const { store, service, calls } = await holdoutFixture();
    store.freezeSelection = async () => {
      throw new Error("database unavailable");
    };
    await expect(service.create(input, id)).rejects.toThrow(
      "database unavailable",
    );
    expect(calls).toHaveLength(4);
    await expect(service.create(input, id)).rejects.toThrow("cannot repeat");
    expect(calls).toHaveLength(4);
  });

  it("refuses an uncertain running-job retry without selecting again", async () => {
    const { store, service, calls } = await holdoutFixture();
    store.value.status = "RUNNING";
    await expect(service.create(input, id)).rejects.toThrow("cannot repeat");
    expect(calls).toEqual([]);
  });

  it("refuses a retry with no linked run, including jobs started before the migration", async () => {
    const { store, service, calls } = await holdoutFixture();
    store.getForJob = async () => undefined;
    await expect(service.create(input, id, 2)).rejects.toThrow(
      "unlinked prior attempt",
    );
    expect(calls).toEqual([]);
  });

  it("returns a completed retry even after captured history is unavailable", async () => {
    const { service, history, calls } = await holdoutFixture();
    const result = await service.create(input, id);
    history.getCapturedHistoryAvailability = async () => {
      throw new Error("retained data unavailable");
    };
    expect(await service.create(input, id, 2)).toEqual(result);
    expect(calls).toHaveLength(5);
  });

  it("does not repeat a holdout whose engine call failed after selection", async () => {
    const { service, engine, calls, store } = await holdoutFixture();
    const execute = engine.runBacktestSignals.getMockImplementation()!;
    engine.runBacktestSignals.mockImplementation(async (request) => {
      const result = await execute(request);
      if (calls.at(-1)?.date === "2026-06-15")
        throw new Error("scanner response lost");
      return result;
    });
    await expect(service.create(input, id)).rejects.toThrow(
      "scanner response lost",
    );
    expect(store.value.holdoutSelection?.configVersion).not.toBeNull();
    await expect(service.create(input, id, 2)).rejects.toThrow("cannot repeat");
    expect(calls).toHaveLength(5);
  });

  it("builds a bounded grid and recommends an adjacent out-of-sample plateau", async () => {
    let calls = 0;
    const markets = new Set<string>();
    const engine = {
      runBacktestSignals: async (request: {
        marketId?: string;
      }): Promise<BacktestSignalReplayResult> => {
        calls++;
        markets.add(request.marketId ?? "missing");
        return {
          events: [],
          contexts: [],
          dataQuality: output.dataQuality,
        };
      },
    };
    const service = new CalibrationService(
      new Calibrations(),
      new History(),
      engine,
      {
        timezone: "America/Toronto",
        openingRange: { start: "09:30", end: "09:45" },
        scanning: { start: "09:45", end: "12:00" },
        entries: {
          preferredStart: "10:00",
          preferredEnd: "11:30",
          hardEnd: "12:00",
        },
      },
    );
    const result = await service.create(input);
    expect(result.status).toBe("COMPLETED");
    expect(result.trials).toHaveLength(2);
    expect(result.trials[0]?.plateauSize).toBe(1);
    expect(result.recommendedConfig).toBeNull();
    expect(calls).toBe(4);
    expect(
      result.trials.every(
        (trial) => trial.segments.TEST === null && trial.segments.ALL === null,
      ),
    ).toBe(true);
    expect(markets).toEqual(new Set(["CA_TSX"]));
  });
  it("counts and deterministically caps Cartesian combinations", () => {
    expect(combinationCount(input.grid)).toBe(2);
    expect(combinations(input.grid, 1)).toHaveLength(1);
  });

  it("requires the US paper-policy slippage floor for calibration", async () => {
    const service = new CalibrationService(
      new Calibrations(),
      new History(),
      { runBacktestSignals: async () => signalOutput },
      {
        timezone: "America/Toronto",
        openingRange: { start: "09:30", end: "09:45" },
        scanning: { start: "09:45", end: "12:00" },
        entries: {
          preferredStart: "10:00",
          preferredEnd: "11:30",
          hardEnd: "12:00",
        },
      },
    );
    await expect(
      service.create({ ...input, marketId: "US_EQUITIES", slippageBps: 2 }),
    ).rejects.toMatchObject({ code: "INVALID_RANGE" });
  });

  it("surfaces negative sector and volatility-regime slices", () => {
    expect(
      weaknessWarnings([
        {
          dimension: "SECTOR",
          bucket: "Technology",
          trades: 4,
          wins: 1,
          winRate: 25,
          averageR: -0.2,
          expectancy: -0.1,
          netPnl: -40,
        },
        {
          dimension: "ATR_REGIME",
          bucket: "HIGH",
          trades: 2,
          wins: 1,
          winRate: 50,
          averageR: 0.1,
          expectancy: 0.1,
          netPnl: 20,
        },
      ]),
    ).toEqual([
      "Negative SECTOR bucket Technology: expectancy -0.1000 over 4 trade(s); review this weakness separately from the combined average.",
    ]);
  });

  it("does not let held-out TEST metrics change the ranking score", () => {
    const segment = {
      signalsGenerated: 1,
      readySignals: 1,
      tradesSimulated: 10,
      wins: 5,
      losses: 5,
      winRate: 50,
      averageWin: 1,
      averageLoss: 1,
      averageR: 0.2,
      medianR: 0.2,
      profitFactor: 1,
      expectancy: 0.2,
      netPnl: 2,
      maximumDrawdown: 1,
      maximumDrawdownPct: 0.1,
      falseBreakoutRate: 0,
      signalToTradeConversion: 100,
      averageHoldMinutes: 10,
      observations: 10,
      eligibleSignals: 10,
      fills: 10,
      noFills: 0,
      closePending: 0,
      closedTrades: 10,
    } satisfies BacktestMetrics;
    const baseline = robustScore({
      TRAIN: segment,
      VALIDATION: segment,
      TEST: segment,
      ALL: segment,
    });
    const changedTest = {
      ...segment,
      averageR: -9,
      expectancy: -9,
      maximumDrawdownPct: 99,
    } satisfies BacktestMetrics;
    expect(
      robustScore({
        TRAIN: segment,
        VALIDATION: segment,
        TEST: changedTest,
        ALL: changedTest,
      }),
    ).toBe(baseline);
  });
});
