import { describe, expect, it } from "vitest";
import type { ScannerProfile } from "@tsx-scanner/contracts";
import {
  BacktestAutomationService,
  type BacktestAutomationStageDefinition,
} from "../src/backtests/backtest-automation.js";
import { RESEARCH_JOB_PRIORITY } from "../src/research-jobs/research-job-repository.js";
import { costPolicyForMarket } from "../src/paper-bot/cost-policy.js";
import {
  InMemoryBacktestAutomationStore,
  RecordingBacktestAutomationDispatcher,
  RecordingBacktestAutomationInputs,
} from "./backtest-automation-fixtures.js";

const parameters = { flagpoleMinAtr: 0.5 };

function profile(overrides: Record<string, unknown> = {}): ScannerProfile {
  return {
    id: "10000000-0000-4000-8000-000000000088",
    name: "Bull Flag",
    analysisKind: "SETUP",
    configId: "10000000-0000-4000-8000-000000000098",
    configVersion: "profile-bull-flag-v1",
    strategyKey: "BULL_FLAG",
    marketId: "CA_TSX",
    parameters,
    ...overrides,
  } as unknown as ScannerProfile;
}

function jobIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function setup(
  options: {
    enabled?: boolean;
    maxOutstanding?: number;
    profiles?: ScannerProfile[];
    stageDefinitions?: readonly BacktestAutomationStageDefinition[];
    now?: Date;
  } = {},
) {
  let now = options.now ?? new Date("2026-09-10T21:00:00.000Z");
  const store = new InMemoryBacktestAutomationStore();
  const inputs = new RecordingBacktestAutomationInputs();
  const jobs = new RecordingBacktestAutomationDispatcher(store);
  const profiles = options.profiles ?? [profile()];
  const service = new BacktestAutomationService({
    store,
    inputs,
    profiles: { listProfiles: async () => profiles },
    jobs,
    clock: () => now,
    retry: { maxRetries: 2, baseBackoffMs: 900_000, maxBackoffMs: 3_600_000 },
    ...(options.stageDefinitions
      ? { stageDefinitions: options.stageDefinitions }
      : {}),
  });
  return {
    service,
    store,
    inputs,
    jobs,
    profiles,
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    setNow: (value: Date) => {
      now = value;
    },
  };
}

function onlyWork(store: InMemoryBacktestAutomationStore) {
  const works = [...store.works.values()];
  expect(works).toHaveLength(1);
  return works[0]!;
}

function finishJob(
  store: InMemoryBacktestAutomationStore,
  jobId: string,
  status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED",
  extra: Partial<{
    error: string;
    errorCategory:
      "UPSTREAM_ENGINE" | "LEASE_EXPIRED" | "VALIDATION" | "UNKNOWN";
    resultRefId: string;
    completedAt: string;
  }> = {},
) {
  store.jobs.set(jobId, {
    id: jobId,
    status,
    resultRefId: extra.resultRefId ?? null,
    error: extra.error ?? null,
    errorCategory: extra.errorCategory ?? null,
    completedAt: extra.completedAt ?? "2026-09-10T21:05:00.000Z",
  });
}

describe("backtest automation work identity and dispatch", () => {
  it("queues one exact-configuration replay with a deterministic idempotency key", async () => {
    const { service, store, jobs } = setup();
    const result = await service.triggerProfile(profile(), "PROFILE_SAVE");
    expect(result.kind).toBe("DISPATCHED");
    expect(jobs.calls).toHaveLength(1);
    expect(jobs.calls[0]).toMatchObject({
      type: "BACKTEST",
      priority: RESEARCH_JOB_PRIORITY.REQUESTED,
      payload: expect.objectContaining({
        strategies: ["BULL_FLAG"],
        parameters,
        startDate: "2026-09-01",
        endDate: "2026-09-10",
        slippageBps: 2,
      }),
    });
    expect(jobs.calls[0]!.idempotencyKey).toMatch(
      /^backtest-automation:[a-f0-9]{64}$/,
    );
    const work = onlyWork(store);
    expect(work.state).toBe("QUEUED");
    expect(work.jobId).toBe(jobIdFor(1));
    expect(work.dispatchedFingerprint).toBe(work.inputFingerprint);
  });

  it("coalesces equivalent triggers onto the same durable job", async () => {
    const { service, jobs } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    const second = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(second.kind).toBe("COALESCED");
    expect(jobs.calls).toHaveLength(1);
  });

  it("uses the market cost policy floor and market-scoped inputs", async () => {
    const { service, inputs, jobs } = setup();
    const us = profile({ marketId: "US_EQUITIES" });
    await service.triggerProfile(us, "PROFILE_SAVE");
    expect(inputs.fingerprintCalls).toEqual(["US_EQUITIES"]);
    expect(inputs.availabilityCalls).toEqual(["US_EQUITIES"]);
    expect(jobs.calls[0]!.payload).toEqual(
      expect.objectContaining({
        marketId: "US_EQUITIES",
        slippageBps: costPolicyForMarket("US_EQUITIES").slippageBps,
      }),
    );
  });

  it("blocks a payload the shared validator rejects instead of enqueueing it", async () => {
    const { service, inputs, jobs, store } = setup();
    inputs.availability = {
      ...inputs.availability,
      replay: { earliestDate: "2026-09-10", latestDate: "2026-09-01" },
    };
    const result = await service.triggerProfile(profile(), "PROFILE_SAVE");
    expect(result).toMatchObject({
      kind: "BLOCKED",
      reason: "POLICY_VIOLATION",
    });
    expect(jobs.calls).toHaveLength(0);
    expect(onlyWork(store).state).toBe("BLOCKED");
  });

  it("blocks empty captured history and reopens only when the fingerprint changes", async () => {
    const { service, inputs, jobs, store } = setup();
    inputs.availability = {
      ...inputs.availability,
      replay: { earliestDate: null, latestDate: null },
    };
    const blocked = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(blocked).toMatchObject({
      kind: "BLOCKED",
      reason: "NO_CAPTURED_HISTORY",
    });
    expect(jobs.calls).toHaveLength(0);

    const unchanged = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(unchanged.kind).toBe("BLOCKED");

    inputs.availability = new RecordingBacktestAutomationInputs().availability;
    inputs.fingerprint = "b".repeat(64);
    const reopened = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(reopened.kind).toBe("DISPATCHED");
    expect(jobs.calls).toHaveLength(1);
    expect(onlyWork(store).blockerReason).toBeNull();
  });

  it("does not redispatch an unchanged consumed fingerprint", async () => {
    const { service, store, jobs } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    finishJob(store, jobIdFor(1), "SUCCEEDED", {
      resultRefId: "20000000-0000-4000-8000-000000000001",
    });

    const unchanged = await service.triggerProfile(profile(), "PROFILE_SAVE");
    expect(unchanged.kind).toBe("UNCHANGED");
    expect(jobs.calls).toHaveLength(1);
    const work = onlyWork(store);
    expect(work.state).toBe("SUCCEEDED");
    expect(work.runId).toBe("20000000-0000-4000-8000-000000000001");
    expect(work.consumedFingerprint).toBe(work.inputFingerprint);
  });

  it("reopens work when late-arriving data changes the fingerprint", async () => {
    const { service, store, inputs, jobs } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    finishJob(store, jobIdFor(1), "SUCCEEDED");

    inputs.fingerprint = "c".repeat(64);
    const changed = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(changed.kind).toBe("DISPATCHED");
    expect(jobs.calls).toHaveLength(2);
    expect(jobs.calls[1]!.idempotencyKey).not.toBe(
      jobs.calls[0]!.idempotencyKey,
    );
    expect(onlyWork(store).consumedFingerprint).toBe("a".repeat(64));
  });

  it("records the dispatched fingerprint, not a newer coalesced observation", async () => {
    const { service, store, inputs, jobs } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    inputs.fingerprint = "d".repeat(64);
    const coalesced = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(coalesced.kind).toBe("COALESCED");
    finishJob(store, jobIdFor(1), "SUCCEEDED");

    const changed = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(changed.kind).toBe("DISPATCHED");
    expect(jobs.calls).toHaveLength(2);
    const work = onlyWork(store);
    expect(work.consumedFingerprint).toBe("a".repeat(64));
    expect(work.inputFingerprint).toBe("d".repeat(64));
  });

  it("bounds outstanding automated jobs per market", async () => {
    const second = profile({
      configId: "10000000-0000-4000-8000-000000000099",
      configVersion: "profile-second-v1",
      name: "Second",
    });
    const { service, store, jobs } = setup({
      maxOutstanding: 1,
      profiles: [profile(), second],
    });
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 1,
    });
    const first = await service.triggerProfile(profile(), "PROFILE_SAVE");
    expect(first.kind).toBe("DISPATCHED");
    const waiting = await service.triggerProfile(second, "PROFILE_SAVE");
    expect(waiting).toMatchObject({
      kind: "WAITING",
      reason: "CAPACITY_LIMIT",
    });
    expect(jobs.calls).toHaveLength(1);

    finishJob(store, jobIdFor(1), "SUCCEEDED");
    const retried = await service.triggerProfile(second, "PROFILE_SAVE");
    expect(retried.kind).toBe("DISPATCHED");
    expect(jobs.calls).toHaveLength(2);
  });

  it("schedules bounded retries after a transient terminal failure", async () => {
    const { service, store, jobs, advance } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    finishJob(store, jobIdFor(1), "FAILED", {
      error: "engine down",
      errorCategory: "UPSTREAM_ENGINE",
    });
    advance(60_000);

    const waiting = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(waiting).toMatchObject({ kind: "RETRY_SCHEDULED" });
    const work = onlyWork(store);
    expect(work.state).toBe("RETRY_SCHEDULED");
    expect(work.retryCount).toBe(1);
    expect(work.nextAttemptAt).toBe("2026-09-10T21:16:00.000Z");
    expect(jobs.calls).toHaveLength(1);

    advance(16 * 60_000);
    const retried = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(retried.kind).toBe("DISPATCHED");
    expect(jobs.calls).toHaveLength(2);
    expect(jobs.calls[1]!.idempotencyKey).not.toBe(
      jobs.calls[0]!.idempotencyKey,
    );
  });

  it("stops after the retry budget and stays failed until inputs change or refresh", async () => {
    const { service, store, jobs, advance } = setup();
    const failCurrent = () => {
      const work = onlyWork(store);
      expect(work.state).toBe("QUEUED");
      finishJob(store, work.jobId!, "FAILED", {
        error: "engine down",
        errorCategory: "UPSTREAM_ENGINE",
      });
    };
    const trigger = async () => {
      advance(60 * 60_000);
      return service.triggerProfile(profile(), "SCHEDULED_CATCH_UP");
    };

    await service.triggerProfile(profile(), "PROFILE_SAVE");
    failCurrent();
    expect((await trigger()).kind).toBe("RETRY_SCHEDULED");
    expect(onlyWork(store).retryCount).toBe(1);

    advance(60 * 60_000);
    expect(
      (await service.triggerProfile(profile(), "SCHEDULED_CATCH_UP")).kind,
    ).toBe("DISPATCHED");
    failCurrent();
    expect((await trigger()).kind).toBe("RETRY_SCHEDULED");
    expect(onlyWork(store).retryCount).toBe(2);

    advance(60 * 60_000);
    expect(
      (await service.triggerProfile(profile(), "SCHEDULED_CATCH_UP")).kind,
    ).toBe("DISPATCHED");
    failCurrent();
    expect((await trigger()).kind).toBe("UNCHANGED");
    const failed = onlyWork(store);
    expect(failed.state).toBe("FAILED");
    expect(failed.retryCount).toBe(2);
    expect(jobs.calls).toHaveLength(3);

    advance(60 * 60_000);
    const unchanged = await service.triggerProfile(
      profile(),
      "SCHEDULED_CATCH_UP",
    );
    expect(unchanged.kind).toBe("UNCHANGED");
    expect(jobs.calls).toHaveLength(3);

    const refreshed = await service.triggerProfile(profile(), "REFRESH_NOW", {
      force: true,
    });
    expect(refreshed.kind).toBe("DISPATCHED");
    expect(jobs.calls).toHaveLength(4);
  });

  it("forces a fresh attempt for explicit refresh and experiment identities", async () => {
    const { service, store, jobs } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    finishJob(store, jobIdFor(1), "SUCCEEDED");

    const refreshed = await service.triggerProfile(profile(), "REFRESH_NOW", {
      force: true,
    });
    expect(refreshed.kind).toBe("DISPATCHED");
    finishJob(store, jobIdFor(2), "SUCCEEDED");

    const experiment = await service.triggerProfile(
      profile(),
      "EXPLICIT_EXPERIMENT",
      { experimentAttemptId: "experiment-1" },
    );
    expect(experiment).toMatchObject({ kind: "DISPATCHED" });
    finishJob(store, jobIdFor(3), "SUCCEEDED");
    expect(new Set(jobs.calls.map((call) => call.idempotencyKey)).size).toBe(3);

    // The same experiment identity is the same attempt: a repeat is idempotent.
    const repeated = await service.triggerProfile(
      profile(),
      "EXPLICIT_EXPERIMENT",
      { experimentAttemptId: "experiment-1" },
    );
    expect(repeated.kind).toBe("UNCHANGED");
    expect(jobs.calls).toHaveLength(3);

    const secondExperiment = await service.triggerProfile(
      profile(),
      "EXPLICIT_EXPERIMENT",
      { experimentAttemptId: "experiment-2" },
    );
    expect(secondExperiment).toMatchObject({ kind: "DISPATCHED" });
    expect(jobs.calls).toHaveLength(4);
    expect(
      jobs.calls[3]!.idempotencyKey === jobs.calls[2]!.idempotencyKey,
    ).toBe(false);
  });

  it("evaluates explicit triggers even when scheduled automation is disabled", async () => {
    const { service, jobs } = setup();
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: false,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 2,
    });
    const scheduled = await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
    expect(scheduled.outcome).toBe("DISABLED");
    expect(jobs.calls).toHaveLength(0);

    await service.triggerProfile(profile(), "PROFILE_SAVE");
    expect(jobs.calls).toHaveLength(1);
  });

  it("drains waiting capacity work on job completion", async () => {
    const second = profile({
      configId: "10000000-0000-4000-8000-000000000099",
      configVersion: "profile-second-v1",
      name: "Second",
    });
    const { service, store, jobs, profiles } = setup({
      profiles: [profile(), second],
    });
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 1,
    });
    await service.triggerProfile(profiles[0]!, "SCHEDULED_CATCH_UP");
    const waiting = await service.triggerProfile(
      profiles[1]!,
      "SCHEDULED_CATCH_UP",
    );
    expect(waiting).toMatchObject({
      kind: "WAITING",
      reason: "CAPACITY_LIMIT",
    });
    expect(jobs.calls).toHaveLength(1);

    finishJob(store, jobIdFor(1), "SUCCEEDED");
    const drain = await service.runCycle("CA_TSX", "JOB_COMPLETION");
    expect(drain.triggerOrigin).toBe("JOB_COMPLETION");
    expect(drain.dispatched).toBe(1);
    expect(jobs.calls).toHaveLength(2);
    const secondWork = [...store.works.values()].find(
      (work) => work.identity.configId === second.configId,
    )!;
    expect(secondWork.state).toBe("QUEUED");
    expect(secondWork.waitingSince).toBeNull();
  });

  it("materializes follow-on stages on completion without waiting for the daily cycle", async () => {
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
    ];
    const { service, store } = setup({ stageDefinitions: definitions });
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 2,
    });
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    finishJob(store, jobIdFor(1), "SUCCEEDED");
    expect(await store.listStages("CA_TSX")).toHaveLength(0);

    await service.runCycle("CA_TSX", "JOB_COMPLETION");
    const stages = await store.listStages("CA_TSX");
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      stageKey: "COVERAGE",
      state: "COMPLETED",
    });
  });

  it("reconciles completion but never dispatches when scheduled automation is off", async () => {
    const second = profile({
      configId: "10000000-0000-4000-8000-000000000099",
      configVersion: "profile-second-v1",
      name: "Second",
    });
    const definitions: BacktestAutomationStageDefinition[] = [
      {
        key: "FUNDED_REPLAY",
        authorizationScope: "POLICY_REQUIRED",
        async evaluate() {
          return {
            kind: "DISPATCH",
            reasonCodes: ["FUNDED_AUTOMATION_POLICY_APPROVED"],
            inputIdentityHash: "b".repeat(64),
            jobType: "FUNDED_HISTORICAL_REPLAY",
            payload: { version: "funded-historical-replay-v1" },
            idempotencyKey: "stage-disabled-test",
          };
        },
      },
    ];
    const { service, store, jobs, profiles } = setup({
      profiles: [profile(), second],
      stageDefinitions: definitions,
    });
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: false,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 1,
    });
    await service.triggerProfile(profiles[0]!, "PROFILE_SAVE");
    await service.triggerProfile(profiles[1]!, "PROFILE_SAVE");
    finishJob(store, jobIdFor(1), "SUCCEEDED");

    const drain = await service.runCycle("CA_TSX", "JOB_COMPLETION");
    expect(drain.outcome).toBe("DISABLED");
    expect(jobs.calls).toHaveLength(1);
    const first = [...store.works.values()].find(
      (work) => work.identity.configId === profiles[0]!.configId,
    )!;
    expect(first.state).toBe("SUCCEEDED");
    const stage = await store.getStage("FUNDED_REPLAY", first.workKey);
    expect(stage).toMatchObject({
      state: "NOT_ELIGIBLE",
      reasonCodes: ["SCHEDULED_AUTOMATION_DISABLED"],
    });
  });
});

describe("backtest automation cycles and status", () => {
  it("persists a bounded cycle receipt and uses scheduled priority", async () => {
    const { service, store, jobs } = setup();
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 2,
    });
    const cycle = await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
    expect(cycle).toMatchObject({
      outcome: "CHANGED",
      dispatched: 1,
      evaluated: 1,
    });
    expect(cycle.finishedAt).not.toBeNull();
    expect(store.cycles).toHaveLength(1);
    expect(jobs.calls[0]!.priority).toBe(RESEARCH_JOB_PRIORITY.SCHEDULED);
  });

  it("reports blocked work, intervention and the last cycle on the status surface", async () => {
    const second = profile({
      configId: "10000000-0000-4000-8000-000000000099",
      configVersion: "profile-second-v1",
      name: "Second",
    });
    const { service, inputs, jobs } = setup({
      profiles: [profile(), second],
    });
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 1,
    });
    inputs.availability = {
      ...inputs.availability,
      replay: { earliestDate: "2026-09-10", latestDate: "2026-09-01" },
    };
    await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");

    const status = await service.status("CA_TSX", {
      nextCheckAt: "2026-09-11T21:00:00.000Z",
    });
    expect(status).toMatchObject({
      marketId: "CA_TSX",
      enabled: true,
      maxOutstanding: 1,
      nextCheckAt: "2026-09-11T21:00:00.000Z",
      interventionRequired: true,
      lastCycle: expect.objectContaining({
        outcome: "BLOCKED",
        blocked: 2,
      }),
    });
    expect(status.works).toHaveLength(2);
    expect(status.works.every((work) => work.state === "BLOCKED")).toBe(true);
    expect(
      status.works.every((work) => work.blockerReason === "POLICY_VIOLATION"),
    ).toBe(true);
    expect(jobs.calls).toHaveLength(0);

    inputs.availability = new RecordingBacktestAutomationInputs().availability;
    inputs.fingerprint = "e".repeat(64);
    await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
    const after = await service.status("CA_TSX");
    expect(after.interventionRequired).toBe(false);
    expect(after.lastCycle?.outcome).toBe("CHANGED");
    expect(after.works.map((work) => work.state).sort()).toEqual([
      "QUEUED",
      "WAITING",
    ]);
  });

  it("reports evaluated-through coverage beside result time and runtime", async () => {
    const { service, store } = setup();
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 2,
    });
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    const runId = "30000000-0000-4000-8000-000000000001";
    store.runEnds.set(runId, "2026-09-10");
    finishJob(store, jobIdFor(1), "SUCCEEDED", { resultRefId: runId });

    await service.runCycle("CA_TSX", "JOB_COMPLETION");
    const status = await service.status("CA_TSX");
    expect(status.lastSuccessDurationMs).toBe(300_000);
    expect(status.lastSuccessEvaluatedThrough).toBe("2026-09-10");
    expect(status.works[0]!.evaluatedThrough).toBe("2026-09-10");
  });

  it("exposes measurable session progress and heartbeat for an in-flight job", async () => {
    const { service, store } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    const jobId = jobIdFor(1);
    store.jobs.set(jobId, {
      id: jobId,
      status: "RUNNING",
      resultRefId: null,
      error: null,
      errorCategory: null,
      completedAt: null,
      startedAt: "2026-09-10T20:58:00.000Z",
      heartbeatAt: "2026-09-10T20:59:48.000Z",
      progress: {
        totalSessions: 9,
        completedSessions: 8,
        message: "Loading session 2026-09-10",
      },
    });

    const status = await service.status("CA_TSX");
    expect(status.works[0]).toMatchObject({
      state: "QUEUED",
      jobStatus: "RUNNING",
      startedAt: "2026-09-10T20:58:00.000Z",
      heartbeatAt: "2026-09-10T20:59:48.000Z",
      progress: {
        totalSessions: 9,
        completedSessions: 8,
        message: "Loading session 2026-09-10",
      },
    });
  });

  it("checks for newly due work without forcing unchanged configurations", async () => {
    const { service, store, inputs, jobs } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    expect(jobs.calls).toHaveLength(1);
    const runId = "30000000-0000-4000-8000-000000000009";
    store.runEnds.set(runId, "2026-09-10");
    finishJob(store, jobIdFor(1), "SUCCEEDED", { resultRefId: runId });
    await service.runCycle("CA_TSX", "JOB_COMPLETION");

    const unchanged = await service.checkNow("CA_TSX");
    expect(unchanged.outcome).toBe("NO_CHANGES");
    expect(jobs.calls).toHaveLength(1);

    // Explicit refresh still forces an attempt for an unchanged configuration.
    expect((await service.refreshNow("CA_TSX")).dispatched).toBe(1);
    expect(jobs.calls).toHaveLength(2);
    finishJob(store, jobIdFor(2), "SUCCEEDED", { resultRefId: runId });
    await service.runCycle("CA_TSX", "JOB_COMPLETION");

    // A newly captured input fingerprint makes the next check dispatch.
    inputs.fingerprint = "f".repeat(64);
    const due = await service.checkNow("CA_TSX");
    expect(due.outcome).toBe("CHANGED");
    expect(jobs.calls).toHaveLength(3);
  });

  it("hides the next check when scheduled automation is disabled", async () => {
    const { service } = setup();
    const status = await service.status("CA_TSX", {
      nextCheckAt: "2026-09-11T21:00:00.000Z",
    });
    expect(status.enabled).toBe(false);
    expect(status.nextCheckAt).toBeNull();
    expect(status.works).toEqual([]);
  });

  it("keeps markets isolated in the work registry", async () => {
    const us = profile({
      marketId: "US_EQUITIES",
      configId: "10000000-0000-4000-8000-000000000097",
      configVersion: "profile-us-v1",
    });
    const { service, store } = setup({ profiles: [profile(), us] });
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    await service.triggerProfile(us, "PROFILE_SAVE");
    const ca = await service.status("CA_TSX");
    const usStatus = await service.status("US_EQUITIES");
    expect(ca.works).toHaveLength(1);
    expect(usStatus.works).toHaveLength(1);
    expect(ca.works[0]!.marketId).toBe("CA_TSX");
    expect(usStatus.works[0]!.marketId).toBe("US_EQUITIES");
    expect(store.works.size).toBe(2);
  });

  it("waits for replay candidates without dispatching or spending capacity", async () => {
    const { service, inputs, jobs, store } = setup();
    inputs.candidatePlan = {
      ...inputs.candidatePlan,
      candidateInstruments: [],
      digest: "c".repeat(64),
      warnings: [
        "No session in the requested range has retained membership candidates; nothing can be replayed.",
      ],
    };

    const result = await service.triggerProfile(profile(), "PROFILE_SAVE");

    expect(result).toMatchObject({
      kind: "WAITING",
      reason: "NO_REPLAY_CANDIDATES",
    });
    expect(jobs.calls).toHaveLength(0);
    expect(inputs.fingerprintMembership).toEqual(["c".repeat(64)]);
    const work = onlyWork(store);
    expect(work.state).toBe("WAITING");
    expect(work.blockerReason).toBe("NO_REPLAY_CANDIDATES");
    expect(work.failureMessage).toContain("retained membership candidates");
    expect(work.waitingSince).not.toBeNull();
  });

  it("keeps unresolved membership a stable waiting state across checks", async () => {
    const { service, inputs, jobs, store, advance } = setup();
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 2,
    });
    inputs.candidatePlan = {
      ...inputs.candidatePlan,
      candidateInstruments: [],
      digest: "c".repeat(64),
    };
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    const firstWaitingSince = onlyWork(store).waitingSince;

    advance(30 * 60_000);
    const cycle = await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");

    expect(cycle.outcome).toBe("BLOCKED");
    expect(jobs.calls).toHaveLength(0);
    const work = onlyWork(store);
    expect(work.state).toBe("WAITING");
    expect(work.blockerReason).toBe("NO_REPLAY_CANDIDATES");
    expect(work.waitingSince).toBe(firstWaitingSince);
  });

  it("reopens candidate-waiting work when membership resolves", async () => {
    const { service, inputs, jobs, store } = setup();
    inputs.candidatePlan = {
      ...inputs.candidatePlan,
      candidateInstruments: [],
      digest: "c".repeat(64),
    };
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    expect(onlyWork(store).state).toBe("WAITING");

    inputs.candidatePlan = {
      ...inputs.candidatePlan,
      candidateInstruments: [
        {
          instrumentId: "11111111-1111-4111-8111-111111111111",
          symbol: "TEST.TO",
          sector: null,
        },
      ],
      digest: "d".repeat(64),
    };
    const resolved = await service.triggerProfile(profile(), "PROFILE_SAVE");

    expect(resolved.kind).toBe("DISPATCHED");
    expect(jobs.calls).toHaveLength(1);
    expect(inputs.fingerprintMembership).toEqual([
      "c".repeat(64),
      "d".repeat(64),
    ]);
    expect(onlyWork(store).state).toBe("QUEUED");
  });

  it("does not report an empty replay as the latest successful baseline", async () => {
    const { service, store } = setup();
    await service.triggerProfile(profile(), "PROFILE_SAVE");
    const runId = "30000000-0000-4000-8000-000000000010";
    store.runEnds.set(runId, "2026-09-10");
    store.runCandidates.set(runId, 0);
    finishJob(store, jobIdFor(1), "SUCCEEDED", { resultRefId: runId });

    await service.runCycle("CA_TSX", "JOB_COMPLETION");
    const status = await service.status("CA_TSX");

    expect(status.lastSuccessAt).toBeNull();
    expect(status.lastSuccessEvaluatedThrough).toBeNull();
    expect(status.works[0]!.evaluatedThrough).toBeNull();
    expect(status.works[0]!.lastSuccessAt).not.toBeNull();
  });
});
