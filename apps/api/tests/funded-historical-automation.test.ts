import { describe, expect, it, vi } from "vitest";
import type {
  BacktestRun,
  FundedHistoricalAutomationPolicy,
  ScannerProfile,
} from "@tsx-scanner/contracts";
import type { BacktestAutomationWorkRecord } from "../src/backtests/backtest-automation.js";
import { BacktestAutomationService } from "../src/backtests/backtest-automation.js";
import { fundedReplayStage } from "../src/backtests/funded-replay-stage.js";
import {
  fundedPolicyIsActive,
  type FundedHistoricalAutomationService,
} from "../src/paper-bot/funded-historical-automation.js";
import { historicalAutomationAccountId } from "../src/paper-bot/funded-historical-config.js";
import { runFundedHistoricalRange } from "../src/paper-bot/funded-historical-runner.js";
import type { ApiConfig } from "../src/config.js";
import { FundedHistoricalReplayJobHandler } from "../src/worker/handlers/funded-historical-replay-job-handler.js";
import { CancelledError } from "../src/worker/research-worker.js";
import {
  InMemoryBacktestAutomationStore,
  RecordingBacktestAutomationDispatcher,
  RecordingBacktestAutomationInputs,
} from "./backtest-automation-fixtures.js";

const now = new Date("2026-09-10T21:00:00.000Z");

function policy(
  overrides: Partial<FundedHistoricalAutomationPolicy> = {},
): FundedHistoricalAutomationPolicy {
  return {
    policyId: "40000000-0000-4000-8000-000000000001",
    policyHash: "a".repeat(64),
    marketId: "CA_TSX",
    scope: {
      kind: "PROFILE_CONFIG",
      configId: "10000000-0000-4000-8000-000000000098",
      configVersion: "profile-bull-flag-v1",
    },
    maxSessions: 5,
    approvedBy: "operator",
    approvalNote:
      "Bounded funded replay comparison for the September experiment",
    approvedAt: "2026-09-10T20:00:00.000Z",
    expiresAt: "2026-10-10T20:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
    revokedReason: null,
    ...overrides,
  };
}

const run = {
  id: "20000000-0000-4000-8000-000000000001",
  status: "COMPLETED",
  marketId: "CA_TSX",
  configVersion: "profile-bull-flag-v1",
} as unknown as BacktestRun;

function work(overrides: Partial<BacktestAutomationWorkRecord> = {}) {
  return {
    workKey: "b".repeat(64),
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
    attemptKey: "c".repeat(64),
    inputFingerprint: "d".repeat(64),
    dispatchedFingerprint: "d".repeat(64),
    consumedFingerprint: "d".repeat(64),
    blockerReason: null,
    jobId: null,
    runId: run.id,
    retryCount: 0,
    nextAttemptAt: null,
    failureMessage: null,
    lastDispatchedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    waitingSince: null,
    updatedAt: now.toISOString(),
    ...overrides,
  } satisfies BacktestAutomationWorkRecord;
}

describe("A3 funded replay policy gate", () => {
  it("keeps the stage not eligible without an approved policy", async () => {
    const stage = fundedReplayStage({
      policies: {
        activePolicyFor: async () => null,
      } as unknown as FundedHistoricalAutomationService,
      runs: { get: async () => run },
    });
    await expect(stage.evaluate({ work: work(), now })).resolves.toMatchObject({
      kind: "NOT_ELIGIBLE",
      reasonCodes: ["FUNDED_AUTOMATION_POLICY_NOT_APPROVED"],
    });
  });

  it("dispatches the funded job only for an active policy and completed run", async () => {
    const active = policy();
    const stage = fundedReplayStage({
      policies: {
        activePolicyFor: async () => active,
      } as unknown as FundedHistoricalAutomationService,
      runs: { get: async () => run },
    });
    const decision = await stage.evaluate({ work: work(), now });
    expect(decision).toMatchObject({
      kind: "DISPATCH",
      jobType: "FUNDED_HISTORICAL_REPLAY",
      idempotencyKey: `funded-historical-replay:${active.policyHash}:${run.id}`,
      payload: {
        version: "funded-historical-replay-v1",
        policyId: active.policyId,
        policyHash: active.policyHash,
        backtestRunId: run.id,
      },
    });

    const missingRun = fundedReplayStage({
      policies: {
        activePolicyFor: async () => active,
      } as unknown as FundedHistoricalAutomationService,
      runs: { get: async () => undefined },
    });
    await expect(
      missingRun.evaluate({ work: work(), now }),
    ).resolves.toMatchObject({
      kind: "WAITING_FOR_EVIDENCE",
      reasonCodes: ["COMPLETED_RUN_UNAVAILABLE"],
    });

    const wrongConfig = fundedReplayStage({
      policies: {
        activePolicyFor: async () => active,
      } as unknown as FundedHistoricalAutomationService,
      runs: { get: async () => ({ ...run, configVersion: "other" }) },
    });
    await expect(
      wrongConfig.evaluate({ work: work(), now }),
    ).resolves.toMatchObject({
      kind: "NOT_ELIGIBLE",
      reasonCodes: ["BASELINE_CONFIG_MISMATCH"],
    });
  });

  it("dispatches through the automation engine with scheduled priority", async () => {
    const active = policy();
    const nowValue = new Date(now);
    const store = new InMemoryBacktestAutomationStore();
    const jobs = new RecordingBacktestAutomationDispatcher(store);
    const target = {
      id: "10000000-0000-4000-8000-000000000088",
      name: "Bull Flag",
      analysisKind: "SETUP",
      configId: "10000000-0000-4000-8000-000000000098",
      configVersion: "profile-bull-flag-v1",
      strategyKey: "BULL_FLAG",
      marketId: "CA_TSX",
      parameters: { flagpoleMinAtr: 0.5 },
      qualification: "EXPLORATORY",
    } as unknown as ScannerProfile;
    const service = new BacktestAutomationService({
      store,
      inputs: new RecordingBacktestAutomationInputs(),
      profiles: { listProfiles: async () => [target] },
      jobs,
      clock: () => nowValue,
      stageDefinitions: [
        fundedReplayStage({
          policies: {
            activePolicyFor: async () => active,
          } as unknown as FundedHistoricalAutomationService,
          runs: { get: async () => run },
        }),
      ],
    });
    await service.configureMarket({
      marketId: "CA_TSX",
      enabled: true,
      cadence: "DAILY_POST_SESSION",
      maxOutstanding: 5,
    });
    await service.triggerProfile(target, "PROFILE_SAVE");
    store.jobs.set("00000000-0000-4000-8000-000000000001", {
      id: "00000000-0000-4000-8000-000000000001",
      status: "SUCCEEDED",
      resultRefId: run.id,
      error: null,
      errorCategory: null,
      completedAt: nowValue.toISOString(),
    });
    await service.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
    expect(jobs.calls).toHaveLength(2);
    expect(jobs.calls[1]!.type).toBe("FUNDED_HISTORICAL_REPLAY");
    const workKey = BacktestAutomationService.workKeyFor(
      BacktestAutomationService.workIdentityFor(target),
    );
    const stage = await store.getStage("FUNDED_REPLAY", workKey);
    expect(stage).toMatchObject({ state: "QUEUED" });
  });

  it("never derives a policy account id from another policy", () => {
    expect(historicalAutomationAccountId("a".repeat(64))).toBe(
      historicalAutomationAccountId("a".repeat(64)),
    );
    expect(historicalAutomationAccountId("a".repeat(64))).not.toBe(
      historicalAutomationAccountId("b".repeat(64)),
    );
    expect(historicalAutomationAccountId("a".repeat(64))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("classifies active, expired and revoked policies", () => {
    expect(fundedPolicyIsActive(policy(), now)).toBe(true);
    expect(
      fundedPolicyIsActive(
        policy({ expiresAt: "2026-09-10T20:59:00.000Z" }),
        now,
      ),
    ).toBe(false);
    expect(
      fundedPolicyIsActive(
        policy({
          revokedAt: "2026-09-10T20:30:00.000Z",
          revokedBy: "operator",
          revokedReason: "Superseded",
        }),
        now,
      ),
    ).toBe(false);
  });
});

describe("A3 funded replay range runner bounds", () => {
  const baseline = {
    id: "20000000-0000-4000-8000-000000000001",
    status: "COMPLETED",
    marketId: "CA_TSX",
    name: "Baseline",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
    strategies: ["ORB_RETEST"],
    symbols: [],
    startingCapital: 100_000,
    positionSize: 10_000,
    slippageBps: 2,
    feePerTrade: 0,
    replayInput: {
      version: "replay-input-v1",
      marketId: "CA_TSX",
      resolvedAt: "2026-09-05T20:00:00.000Z",
      requestedSymbols: [],
      candidateInstruments: [],
      benchmarks: [],
      universeRefreshRunId: null,
      capturedHistoryAvailability: {
        source: "CAPTURED_QUOTES",
        observedAt: "2026-09-05T20:00:00.000Z",
        tables: {
          quoteSnapshot: {
            earliest: "2026-09-01T13:30:00.000Z",
            latest: "2026-09-05T20:00:00.000Z",
          },
          candle: {
            earliest: "2026-08-01T13:30:00.000Z",
            latest: "2026-09-05T20:00:00.000Z",
          },
        },
        replay: { earliestDate: "2026-09-01", latestDate: "2026-09-05" },
      },
      warnings: [],
      inputHash: "d".repeat(64),
    },
  } as unknown as BacktestRun;
  const runnerConfig = {
    OPENING_RANGE_START: "09:30",
    OPENING_RANGE_END: "09:45",
    SCANNING_START: "09:45",
    SCANNING_END: "16:00",
    ENTRY_PREFERRED_START: "10:00",
    ENTRY_PREFERRED_END: "11:30",
    ENTRY_HARD_END: "16:00",
    BENCHMARK_MAX_STALENESS_SECONDS: 30,
    SESSION_TIMEZONE: "America/Toronto",
    US_SESSION_TIMEZONE: "America/New_York",
    PAPER_BOT_RISK_BUDGET_CAD: 50,
    PAPER_COORDINATION_MAX_SYMBOL_NOTIONAL_CAD: 3_000,
    PAPER_COORDINATION_MAX_SECTOR_NOTIONAL_CAD: 5_000,
    PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_CAD: 150,
    PAPER_FUNDED_INITIAL_CASH_CAD: 10_000,
    PAPER_FUNDED_DAILY_LOSS_LIMIT_CAD: 200,
  } as unknown as ApiConfig;

  function deps(dates: string[], runValue: BacktestRun | null = baseline) {
    return {
      pool: {} as never,
      config: runnerConfig,
      engine: {} as never,
      reporting: {} as never,
      store: {
        get: async () => runValue ?? undefined,
        loadReplaySessionDates: async () => dates,
      } as never,
    };
  }

  it("enforces the approved session bound before any provisioning", async () => {
    await expect(
      runFundedHistoricalRange(
        {
          backtestRunId: baseline.id,
          accountId: historicalAutomationAccountId("a".repeat(64)),
          apply: true,
          maxSessions: 2,
        },
        deps(["2026-09-01", "2026-09-02", "2026-09-03"]),
      ),
    ).rejects.toThrow(/exceeds 2 captured sessions/);
  });

  it("refuses a multi-session preview and missing baselines", async () => {
    await expect(
      runFundedHistoricalRange(
        {
          backtestRunId: baseline.id,
          accountId: historicalAutomationAccountId("a".repeat(64)),
          apply: false,
        },
        deps(["2026-09-01", "2026-09-02"]),
      ),
    ).rejects.toThrow(/requires apply/);

    await expect(
      runFundedHistoricalRange(
        {
          backtestRunId: baseline.id,
          accountId: historicalAutomationAccountId("a".repeat(64)),
          apply: true,
        },
        deps(["2026-09-01"], null),
      ),
    ).rejects.toThrow(/COMPLETED backtest run/);

    await expect(
      runFundedHistoricalRange(
        {
          backtestRunId: baseline.id,
          accountId: historicalAutomationAccountId("a".repeat(64)),
          apply: true,
        },
        deps(["2026-09-01"], {
          ...baseline,
          replayInput: null,
        } as unknown as BacktestRun),
      ),
    ).rejects.toThrow(/immutable replay input/);
  });
});

describe("A3 funded replay job handler", () => {
  function job(payload: unknown) {
    return {
      id: "50000000-0000-4000-8000-000000000001",
      requestPayload: payload,
    };
  }
  const context = {
    jobId: "50000000-0000-4000-8000-000000000001",
    heartbeat: async () => ({ cancellationRequested: false }),
  };

  function handler(
    active: FundedHistoricalAutomationPolicy | null,
    executor = vi.fn(async () => ({
      backtestRunId: run.id,
      marketId: "CA_TSX",
      accountId: "derived",
      currency: "CAD" as const,
      applied: true,
      sessionCount: 1,
      sessions: [{ fundedRunId: "60000000-0000-4000-8000-000000000001" }],
    })),
  ) {
    return {
      executor,
      instance: new FundedHistoricalReplayJobHandler(
        {
          getPolicy: async () => active,
        } as unknown as FundedHistoricalAutomationService,
        { get: async () => run },
        executor as never,
        () => now,
      ),
    };
  }

  const validPayload = {
    version: "funded-historical-replay-v1",
    policyId: policy().policyId,
    policyHash: policy().policyHash,
    backtestRunId: run.id,
  };

  it("refuses missing, mismatched, expired and revoked policies without executing", async () => {
    const missing = handler(null);
    await expect(
      missing.instance.execute(job(validPayload) as never, context),
    ).rejects.toThrow(/POLICY_NOT_FOUND/);
    expect(missing.executor).not.toHaveBeenCalled();

    const mismatch = handler(policy({ policyHash: "b".repeat(64) }));
    await expect(
      mismatch.instance.execute(job(validPayload) as never, context),
    ).rejects.toThrow(/HASH_MISMATCH/);

    const expired = handler(policy({ expiresAt: "2026-09-10T20:59:00.000Z" }));
    await expect(
      expired.instance.execute(job(validPayload) as never, context),
    ).rejects.toThrow(/NOT_ACTIVE/);

    const revoked = handler(
      policy({
        revokedAt: "2026-09-10T20:30:00.000Z",
        revokedBy: "operator",
        revokedReason: "Superseded",
      }),
    );
    await expect(
      revoked.instance.execute(job(validPayload) as never, context),
    ).rejects.toThrow(/NOT_ACTIVE/);
    expect(revoked.executor).not.toHaveBeenCalled();
  });

  it("executes the bounded range on the policy-derived account", async () => {
    const active = policy();
    const { instance, executor } = handler(active);
    const result = await instance.execute(job(validPayload) as never, context);
    expect(result.resultRefId).toBe("60000000-0000-4000-8000-000000000001");
    expect(executor).toHaveBeenCalledTimes(1);
    const [input, betweenSessions] = executor.mock.calls[0]! as unknown as [
      {
        backtestRunId: string;
        accountId: string;
        apply: boolean;
        maxSessions: number;
      },
      () => Promise<void>,
    ];
    expect(input).toEqual({
      backtestRunId: run.id,
      accountId: historicalAutomationAccountId(active.policyHash),
      apply: true,
      maxSessions: 5,
    });
    await expect(betweenSessions()).resolves.toBeUndefined();
  });

  it("propagates cancellation between sessions", async () => {
    const active = policy();
    const { instance } = handler(
      active,
      vi.fn(async (_input, betweenSessions: () => Promise<void>) => {
        await betweenSessions();
        throw new Error("unreachable");
      }) as never,
    );
    const cancelling = {
      jobId: context.jobId,
      heartbeat: async () => ({ cancellationRequested: true }),
    };
    await expect(
      instance.execute(job(validPayload) as never, cancelling),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it("rejects an invalid payload before any policy lookup", async () => {
    const { instance, executor } = handler(policy());
    await expect(
      instance.execute(job({ version: "wrong" }) as never, context),
    ).rejects.toThrow(/payload failed validation/);
    expect(executor).not.toHaveBeenCalled();
  });
});
