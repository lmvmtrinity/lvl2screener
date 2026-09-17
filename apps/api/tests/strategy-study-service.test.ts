import { expect, it } from "vitest";
import {
  createBacktestSchema,
  type FrozenStudyPlan,
  type SessionPair,
  type StudySelection,
  type StudyStage,
  type StudyStageResult,
  type StrategyStudyReport,
} from "@tsx-scanner/contracts";
import {
  selectStudyChallenger,
  StrategyStudyService,
  type StudyPorts,
  type StudyStore,
} from "../src/backtests/strategy-study-service.js";

const binding = {
  manifestHash: "a".repeat(64),
  coverageReportHash: "b".repeat(64),
  inputHash: "c".repeat(64),
  engineRevision: "d".repeat(40),
  runtimeFingerprint: "e".repeat(64),
  verifiedAt: "2026-09-10T12:00:00.000Z",
};
const sessions: SessionPair[] = Array.from({ length: 20 }, (_, index) => ({
  sessionDate: new Date(Date.UTC(2026, 8, index + 1))
    .toISOString()
    .slice(0, 10),
  baseline: 1,
  challenger: 1.1,
  coverage: "VERIFIED",
}));
const validationSessions: SessionPair[] = Array.from(
  { length: 20 },
  (_, index) => ({
    sessionDate: new Date(Date.UTC(2026, 8, index + 22))
      .toISOString()
      .slice(0, 10),
    baseline: 1,
    challenger: 1.1,
    coverage: "VERIFIED" as const,
  }),
);
const testSessions: SessionPair[] = Array.from({ length: 20 }, (_, index) => ({
  sessionDate: new Date(Date.UTC(2026, 8, index + 43))
    .toISOString()
    .slice(0, 10),
  baseline: 1,
  challenger: 1.1,
  coverage: "VERIFIED" as const,
}));
const backtest = (name: string, startDate: string, endDate: string) =>
  createBacktestSchema.parse({
    name,
    marketId: "CA_TSX",
    startDate,
    endDate,
    strategies: ["ORB_RETEST"],
    symbols: ["ABC.TO"],
  });
const plan: FrozenStudyPlan = {
  experimentId: "10000000-0000-4000-8000-000000000090",
  binding,
  variant: "RETEST_CONTRACTION",
  baselineProfileConfigId: "10000000-0000-4000-8000-000000000091",
  challengerProfileConfigId: "10000000-0000-4000-8000-000000000092",
  inputs: {
    TRAIN: {
      baseline: backtest("train baseline", "2026-09-01", "2026-09-20"),
      challenger: backtest("train challenger", "2026-09-01", "2026-09-20"),
      binding,
    },
    VALIDATION: {
      baseline: backtest("validation baseline", "2026-09-22", "2026-10-11"),
      challenger: backtest("validation challenger", "2026-09-22", "2026-10-11"),
      binding,
    },
    TEST: {
      baseline: backtest("test baseline", "2026-10-13", "2026-11-01"),
      challenger: backtest("test challenger", "2026-10-13", "2026-11-01"),
      binding,
    },
  },
  comparison: {
    marketId: "CA_TSX",
    unit: "R",
    expectedSessions: testSessions.map((value) => value.sessionDate),
    minimumSessions: 20,
    blockLength: 2,
    bootstrapSamples: 1_000,
    seed: 7,
  },
  minimumClosedTradesPerDevelopmentSegment: 30,
  minimumValidationAverageR: 0,
};

function stageResult(stage: StudyStage): StudyStageResult {
  const stageSessions =
    stage === "TRAIN"
      ? sessions
      : stage === "VALIDATION"
        ? validationSessions
        : testSessions;
  return {
    stage,
    binding,
    baselineRunId: "10000000-0000-4000-8000-000000000093",
    challengerRunId: "10000000-0000-4000-8000-000000000094",
    baselineClosedTrades: 30,
    challengerClosedTrades: 30,
    challengerAverageR: stage === "VALIDATION" ? 0.1 : 0.2,
    sessions: stageSessions,
  };
}

class FakeStore implements StudyStore {
  readonly calls: string[] = [];
  readonly claims = new Set<StudyStage>();
  readonly results = new Map<StudyStage, StudyStageResult>();
  selection: StudySelection | null = null;
  savedReport: StrategyStudyReport | null = null;
  registerCount = 0;

  async register(): Promise<void> {
    this.registerCount++;
    this.calls.push("register");
  }
  async report(): Promise<StrategyStudyReport | null> {
    this.calls.push("report");
    return this.savedReport;
  }
  async claim(_id: string, stage: StudyStage): Promise<boolean> {
    this.calls.push(`${stage}_CLAIM`);
    if (this.claims.has(stage)) return false;
    this.claims.add(stage);
    return true;
  }
  async result(
    _id: string,
    stage: StudyStage,
  ): Promise<StudyStageResult | null> {
    this.calls.push(`${stage}_RESULT_READ`);
    return this.results.get(stage) ?? null;
  }
  async saveResult(_id: string, value: StudyStageResult): Promise<void> {
    this.calls.push(`${value.stage}_RESULT_WRITE`);
    this.results.set(value.stage, value);
  }
  async select(): Promise<void> {
    this.calls.push("SELECTION");
    this.selection = {
      selected: true,
      baselineProfileConfigId: plan.baselineProfileConfigId,
      challengerProfileConfigId: plan.challengerProfileConfigId,
      developmentResultHashes: ["f".repeat(64), "0".repeat(64)],
    };
  }
  async saveReport(value: StrategyStudyReport): Promise<void> {
    this.calls.push("REPORT");
    this.savedReport = value;
  }
}

function ports(store: FakeStore, verify = true): StudyPorts {
  return {
    store,
    runner: {
      async run(_plan, stage) {
        store.calls.push(`${stage}_RUN`);
        return stageResult(stage);
      },
    },
    verify: async () => verify,
    checkpoint: async () => undefined,
  };
}

it("never selects an underpowered or nonpositive validation result", () => {
  const train = { baselineClosedTrades: 30, challengerClosedTrades: 30 };
  const validation = { ...train, challengerAverageR: 0.1 };
  expect(selectStudyChallenger(train, validation, 30, 0)).toBe(true);
  expect(
    selectStudyChallenger(
      train,
      { ...validation, challengerClosedTrades: 29 },
      30,
      0,
    ),
  ).toBe(false);
  expect(
    selectStudyChallenger(
      train,
      { ...validation, challengerAverageR: 0 },
      30,
      0,
    ),
  ).toBe(false);
});

it("records a coverage refusal without calling the runner", async () => {
  const store = new FakeStore();
  const result = await new StrategyStudyService(ports(store, false)).evaluate(
    plan,
  );
  expect(result).toMatchObject({
    status: "INSUFFICIENT_EVIDENCE",
    reasonCodes: ["COVERAGE_NOT_VERIFIED"],
  });
  expect(store.calls).not.toContain("TRAIN_RUN");
});

it("runs development before selection and TEST, then persists the report", async () => {
  const store = new FakeStore();
  const result = await new StrategyStudyService(ports(store)).evaluate(plan);
  expect(result.status).toBe("COMPLETE");
  expect(store.calls).toEqual([
    "register",
    "report",
    "TRAIN_RESULT_READ",
    "TRAIN_CLAIM",
    "TRAIN_RUN",
    "TRAIN_RESULT_WRITE",
    "VALIDATION_RESULT_READ",
    "VALIDATION_CLAIM",
    "VALIDATION_RUN",
    "VALIDATION_RESULT_WRITE",
    "SELECTION",
    "TEST_RESULT_READ",
    "TEST_CLAIM",
    "TEST_RUN",
    "TEST_RESULT_WRITE",
    "REPORT",
  ]);
});

it("returns interrupted rather than replaying a claimed TEST", async () => {
  const store = new FakeStore();
  store.results.set("TRAIN", stageResult("TRAIN"));
  store.results.set("VALIDATION", stageResult("VALIDATION"));
  store.claims.add("TEST");
  const result = await new StrategyStudyService(ports(store)).evaluate(plan);
  expect(result.status).toBe("INTERRUPTED");
  expect(store.calls).not.toContain("TEST_RUN");
});

it("returns a durable prior report without re-running any stage", async () => {
  const store = new FakeStore();
  store.savedReport = {
    experimentId: plan.experimentId,
    binding,
    status: "NOT_SELECTED",
    results: [],
    comparison: null,
    reasonCodes: ["DEVELOPMENT_SELECTION_FAILED"],
  };
  const result = await new StrategyStudyService(ports(store)).evaluate(plan);
  expect(result).toBe(store.savedReport);
  expect(store.registerCount).toBe(1);
  expect(store.calls).toEqual(["register", "report"]);
});
