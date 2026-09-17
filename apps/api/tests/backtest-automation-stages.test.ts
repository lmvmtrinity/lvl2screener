import { describe, expect, it } from "vitest";
import type { BacktestRun, ScannerProfile } from "@tsx-scanner/contracts";
import {
  BacktestAutomationService,
  type BacktestAutomationStageDefinition,
  type BacktestAutomationWorkRecord,
} from "../src/backtests/backtest-automation.js";
import { standardBacktestAutomationStages } from "../src/backtests/backtest-automation-stages.js";
import { RESEARCH_JOB_PRIORITY } from "../src/research-jobs/research-job-repository.js";
import {
  InMemoryBacktestAutomationStore,
  RecordingBacktestAutomationDispatcher,
  RecordingBacktestAutomationInputs,
} from "./backtest-automation-fixtures.js";

function profile(overrides: Record<string, unknown> = {}): ScannerProfile {
  return {
    id: "10000000-0000-4000-8000-000000000088",
    name: "Bull Flag",
    analysisKind: "SETUP",
    configId: "10000000-0000-4000-8000-000000000098",
    configVersion: "profile-bull-flag-v1",
    strategyKey: "BULL_FLAG",
    marketId: "CA_TSX",
    parameters: { flagpoleMinAtr: 0.5 },
    qualification: "EXPLORATORY",
    ...overrides,
  } as unknown as ScannerProfile;
}

function jobIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function setup(
  definitions: readonly BacktestAutomationStageDefinition[],
  options: { now?: Date; maxRetries?: number } = {},
) {
  let now = options.now ?? new Date("2026-09-10T21:00:00.000Z");
  const store = new InMemoryBacktestAutomationStore();
  const inputs = new RecordingBacktestAutomationInputs();
  const jobs = new RecordingBacktestAutomationDispatcher(store);
  const target = profile();
  const service = new BacktestAutomationService({
    store,
    inputs,
    profiles: { listProfiles: async () => [target] },
    jobs,
    clock: () => now,
    retry: {
      maxRetries: options.maxRetries ?? 2,
      baseBackoffMs: 900_000,
      maxBackoffMs: 3_600_000,
    },
    stageDefinitions: definitions,
  });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const completeBaseline = async () => {
    await service.triggerProfile(target, "PROFILE_SAVE");
    store.jobs.set(jobIdFor(1), {
      id: jobIdFor(1),
      status: "SUCCEEDED",
      resultRefId: "20000000-0000-4000-8000-000000000001",
      error: null,
      errorCategory: null,
      completedAt: now.toISOString(),
    });
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 5,
    });
    await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
    return store.works.get(
      BacktestAutomationService.workKeyFor(
        BacktestAutomationService.workIdentityFor(target),
      ),
    )!;
  };
  return { service, store, inputs, jobs, target, advance, completeBaseline };
}

describe("A2 stage evaluation on completed baselines", () => {
  it("records stage states without changing the parent work item", async () => {
    const definitions: BacktestAutomationStageDefinition[] = [
      {
        key: "COVERAGE",
        authorizationScope: "AUTOMATIC",
        async evaluate() {
          return {
            kind: "COMPLETED",
            reasonCodes: ["RESEARCH_EVIDENCE_VERIFIED"],
            inputIdentityHash: "a".repeat(64),
          };
        },
      },
      {
        key: "CALIBRATION",
        authorizationScope: "AUTHORIZATION_REQUIRED",
        async evaluate() {
          return {
            kind: "NOT_ELIGIBLE",
            reasonCodes: ["EXPLICIT_AUTHORIZATION_REQUIRED"],
            inputIdentityHash: null,
          };
        },
      },
    ];
    const { store, jobs, completeBaseline } = setup(definitions);
    const work = await completeBaseline();

    expect(work.state).toBe("SUCCEEDED");
    expect(jobs.calls).toHaveLength(1);
    const coverage = await store.getStage("COVERAGE", work.workKey);
    const calibration = await store.getStage("CALIBRATION", work.workKey);
    expect(coverage).toMatchObject({
      state: "COMPLETED",
      authorizationScope: "AUTOMATIC",
      reasonCodes: ["RESEARCH_EVIDENCE_VERIFIED"],
    });
    expect(calibration).toMatchObject({
      state: "NOT_ELIGIBLE",
      authorizationScope: "AUTHORIZATION_REQUIRED",
    });
  });

  it("isolates the parent baseline from a failing stage and bounds retries", async () => {
    const definitions: BacktestAutomationStageDefinition[] = [
      {
        key: "COVERAGE",
        authorizationScope: "AUTOMATIC",
        async evaluate() {
          throw new Error("coverage source unavailable");
        },
      },
    ];
    const { service, store, completeBaseline, advance } = setup(definitions, {
      maxRetries: 1,
    });
    const work = await completeBaseline();
    const retried = await store.getStage("COVERAGE", work.workKey);
    expect(retried?.state).toBe("RETRY_SCHEDULED");
    expect(retried?.retryCount).toBe(1);
    expect(work.state).toBe("SUCCEEDED");

    advance(20 * 60_000);
    await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
    const failed = await store.getStage("COVERAGE", work.workKey);
    expect(failed?.state).toBe("FAILED");
    expect(failed?.retryCount).toBe(1);
    expect((await service.status("CA_TSX")).interventionRequired).toBe(true);
    expect((await store.getWork(work.workKey))?.state).toBe("SUCCEEDED");
  });

  it("clears derived stages when a new baseline attempt is dispatched", async () => {
    const definitions: BacktestAutomationStageDefinition[] = [
      {
        key: "COVERAGE",
        authorizationScope: "AUTOMATIC",
        async evaluate() {
          return {
            kind: "WAITING_FOR_EVIDENCE",
            reasonCodes: ["RESEARCH_EVIDENCE_PENDING"],
            inputIdentityHash: null,
          };
        },
      },
    ];
    const { service, store, inputs, target, completeBaseline } =
      setup(definitions);
    const work = await completeBaseline();
    expect(await store.getStage("COVERAGE", work.workKey)).toBeDefined();

    inputs.fingerprint = "b".repeat(64);
    const redispatched = await service.triggerProfile(target, "PROFILE_SAVE");
    expect(redispatched.kind).toBe("DISPATCHED");
    expect(await store.getStage("COVERAGE", work.workKey)).toBeUndefined();
    expect(await store.listStages("CA_TSX")).toHaveLength(0);
  });

  it("dispatches an eligible stage once and reconciles its job to completed", async () => {
    const definitions: BacktestAutomationStageDefinition[] = [
      {
        key: "FUNDED_REPLAY",
        authorizationScope: "POLICY_REQUIRED",
        async evaluate() {
          return {
            kind: "DISPATCH",
            reasonCodes: ["POLICY_APPROVED"],
            inputIdentityHash: "c".repeat(64),
            jobType: "COVERAGE_VERIFICATION",
            payload: { version: "stage-test-v1" },
            idempotencyKey: "stage-dispatch:test",
          };
        },
      },
    ];
    const { service, store, jobs, completeBaseline } = setup(definitions);
    const work = await completeBaseline();
    const queued = await store.getStage("FUNDED_REPLAY", work.workKey);
    expect(queued).toMatchObject({ state: "QUEUED", jobId: jobIdFor(2) });
    expect(jobs.calls).toHaveLength(2);
    expect(jobs.calls[1]).toMatchObject({
      type: "COVERAGE_VERIFICATION",
      priority: RESEARCH_JOB_PRIORITY.SCHEDULED,
      idempotencyKey: "stage-dispatch:test",
    });

    store.jobs.set(jobIdFor(2), {
      id: jobIdFor(2),
      status: "SUCCEEDED",
      resultRefId: null,
      error: null,
      errorCategory: null,
      completedAt: "2026-09-10T21:05:00.000Z",
    });
    await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
    const completed = await store.getStage("FUNDED_REPLAY", work.workKey);
    expect(completed?.state).toBe("COMPLETED");
    expect(jobs.calls).toHaveLength(2);

    await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
    expect(jobs.calls).toHaveLength(2);
  });

  it("exposes stages on the status surface", async () => {
    const definitions: BacktestAutomationStageDefinition[] = [
      {
        key: "TRAINING",
        authorizationScope: "QUALIFICATION_OWNED",
        async evaluate() {
          return {
            kind: "WAITING_FOR_EVIDENCE",
            reasonCodes: ["PAPER_QUALIFICATION_REQUIRED"],
            inputIdentityHash: null,
          };
        },
      },
    ];
    const { service, completeBaseline } = setup(definitions);
    await completeBaseline();
    const status = await service.status("CA_TSX");
    expect(status.stages).toHaveLength(1);
    expect(status.stages[0]).toMatchObject({
      stageKey: "TRAINING",
      state: "WAITING_FOR_EVIDENCE",
      authorizationScope: "QUALIFICATION_OWNED",
      reasonCodes: ["PAPER_QUALIFICATION_REQUIRED"],
      configName: "Bull Flag",
    });
  });
});

describe("A2 standard stage catalog", () => {
  const run = {
    id: "20000000-0000-4000-8000-000000000001",
    status: "COMPLETED",
    executionModelVersion: "paper-execution-v7",
    configVersion: "profile-bull-flag-v1",
    replayInput: { inputHash: "d".repeat(64) },
  } as unknown as BacktestRun;

  function work(runId: string | null = run.id): BacktestAutomationWorkRecord {
    return {
      workKey: "e".repeat(64),
      marketId: "CA_TSX",
      identity: {
        kind: "PROFILE_QUALIFICATION",
        marketId: "CA_TSX",
        configId: "10000000-0000-4000-8000-000000000098",
        configVersion: "profile-bull-flag-v1",
        strategyKey: "BULL_FLAG",
        executionModelVersion: "paper-execution-v7",
        rangePolicy: "FULL_CAPTURED_RANGE",
      },
      state: "SUCCEEDED",
      triggerOrigin: "SCHEDULED_CATCH_UP",
      attemptKey: "f".repeat(64),
      inputFingerprint: "a".repeat(64),
      dispatchedFingerprint: "a".repeat(64),
      consumedFingerprint: "a".repeat(64),
      blockerReason: null,
      jobId: null,
      runId,
      retryCount: 0,
      nextAttemptAt: null,
      failureMessage: null,
      lastDispatchedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      waitingSince: null,
      updatedAt: "2026-09-10T21:00:00.000Z",
    };
  }

  function catalog(
    overrides: {
      runValue?: BacktestRun | undefined;
      qualification?: ScannerProfile["qualification"];
    } = {},
  ) {
    return standardBacktestAutomationStages({
      backtests: {
        get: async () => ("runValue" in overrides ? overrides.runValue : run),
      },
      profiles: {
        listProfiles: async () => [
          profile({ qualification: overrides.qualification ?? "EXPLORATORY" }),
        ],
      },
    });
  }

  it("marks coverage completed only when the run carries verified evidence", async () => {
    const withEvidence = catalog({
      runValue: { ...run, researchEvidence: {} } as BacktestRun,
    });
    const coverage = withEvidence.find((stage) => stage.key === "COVERAGE")!;
    await expect(
      coverage.evaluate({ work: work(), now: new Date() }),
    ).resolves.toMatchObject({ kind: "COMPLETED" });

    const withoutEvidence = catalog({ runValue: run });
    const waiting = withoutEvidence.find((stage) => stage.key === "COVERAGE")!;
    await expect(
      waiting.evaluate({ work: work(), now: new Date() }),
    ).resolves.toMatchObject({
      kind: "WAITING_FOR_EVIDENCE",
      reasonCodes: ["RESEARCH_EVIDENCE_PENDING"],
    });

    const missingRun = catalog({ runValue: undefined });
    await expect(
      missingRun
        .find((stage) => stage.key === "COVERAGE")!
        .evaluate({
          work: work("20000000-0000-4000-8000-000000000099"),
          now: new Date(),
        }),
    ).resolves.toMatchObject({
      kind: "WAITING_FOR_EVIDENCE",
      reasonCodes: ["COMPLETED_RUN_UNAVAILABLE"],
    });
  });

  it("keeps training qualification-owned and never launches it", async () => {
    const pending = catalog();
    await expect(
      pending
        .find((stage) => stage.key === "TRAINING")!
        .evaluate({ work: work(), now: new Date() }),
    ).resolves.toMatchObject({
      kind: "WAITING_FOR_EVIDENCE",
      reasonCodes: ["PAPER_QUALIFICATION_REQUIRED"],
    });

    const qualified = catalog({ qualification: "EVIDENCE_QUALIFIED" });
    await expect(
      qualified
        .find((stage) => stage.key === "TRAINING")!
        .evaluate({ work: work(), now: new Date() }),
    ).resolves.toMatchObject({
      kind: "NOT_ELIGIBLE",
      reasonCodes: ["TRAINING_SCHEDULER_OWNED"],
    });
  });

  it("keeps calibration and study authorization-required with no dispatch", async () => {
    const stages = catalog();
    for (const key of ["CALIBRATION", "STRATEGY_STUDY"] as const) {
      const decision = await stages
        .find((stage) => stage.key === key)!
        .evaluate({ work: work(), now: new Date() });
      expect(decision.kind).toBe("NOT_ELIGIBLE");
      expect(decision.kind === "DISPATCH").toBe(false);
    }
    expect(stages.some((stage) => stage.key === "FUNDED_REPLAY")).toBe(false);
  });
});
