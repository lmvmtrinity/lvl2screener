import { describe, expect, it } from "vitest";
import type {
  BacktestAutomationCycle,
  BacktestAutomationStatus,
  BacktestComparison,
  BacktestRun,
  CreateBacktest,
  CreateFundedHistoricalAutomationPolicy,
  FundedHistoricalAutomationPolicy,
  MarketId,
  ResearchJob,
  ResearchJobType,
  RevokeFundedHistoricalAutomationPolicy,
} from "@tsx-scanner/contracts";
import {
  buildApp,
  type BacktestApi,
  type BacktestAutomationApi,
  type FundedHistoricalPolicyApi,
  type ResearchJobApi,
} from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

const jobId = "10000000-0000-4000-8000-000000000090";

class FakeResearchJobs implements ResearchJobApi {
  created?: {
    jobType: ResearchJobType;
    payload: unknown;
    idempotencyKey?: string | null;
  };
  async createJob(
    jobType: ResearchJobType,
    payload: unknown,
    idempotencyKey?: string | null,
  ): Promise<ResearchJob> {
    this.created = { jobType, payload, idempotencyKey };
    return {
      id: jobId,
      jobType,
      status: "QUEUED",
      resultRefId: null,
      progress: {},
      error: null,
      errorCategory: null,
      attemptCount: 0,
      maxAttempts: 3,
      cancellationRequested: false,
      createdAt: "2026-08-25T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    };
  }
  async get(): Promise<ResearchJob | undefined> {
    return undefined;
  }
  async requestCancellation(): Promise<ResearchJob | undefined> {
    return undefined;
  }
}

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
const id = "10000000-0000-4000-8000-000000000080";
const run = {
  id,
  name: "Baseline",
  status: "COMPLETED",
  startDate: "2026-08-01",
  endDate: "2026-08-25",
  trades: [],
} as unknown as BacktestRun;

class FakeBacktests implements BacktestApi {
  created?: CreateBacktest;
  async listRuns(): Promise<BacktestRun[]> {
    return [run];
  }
  async getRun(): Promise<BacktestRun> {
    return run;
  }
  async getCapturedHistoryAvailability(marketId: "CA_TSX" | "US_EQUITIES") {
    return {
      source: "CAPTURED_QUOTES" as const,
      observedAt: "2026-08-25T00:00:00.000Z",
      tables: {
        quoteSnapshot: {
          earliest: "2026-08-01T13:30:00.000Z",
          latest: "2026-08-25T20:00:00.000Z",
        },
        candle: {
          earliest: "2026-06-15T13:30:00.000Z",
          latest: "2026-08-25T20:00:00.000Z",
        },
      },
      replay: { earliestDate: "2026-08-01", latestDate: "2026-08-25" },
      limitations:
        marketId === "US_EQUITIES"
          ? [
              {
                marketId,
                kind: "INTERIOR_NO_QUOTE" as const,
                basis: "QUOTE_GAP_WITH_BACKFILLED_CANDLES" as const,
                startAt: "2026-09-14T13:39:00.000Z",
                endAt: "2026-09-14T15:25:00.000Z",
                sessionDates: ["2026-09-14"],
                detail:
                  "No forward quotes were retained through this interval although completed candles exist inside it.",
                evaluatedFrom: "2026-08-15T00:00:00.000Z",
                evaluatedThrough: "2026-09-15T00:00:00.000Z",
              },
            ]
          : [],
    };
  }
  async createRun(input: CreateBacktest): Promise<BacktestRun> {
    this.created = input;
    return run;
  }
  async compare(): Promise<BacktestComparison> {
    return { comparable: true, differences: [], runs: [run, run] };
  }
}

const automationStatus = {
  marketId: "CA_TSX",
  enabled: false,
  cadence: "DAILY_POST_SESSION",
  maxOutstanding: 2,
  asOf: "2026-09-10T21:00:00.000Z",
  nextCheckAt: null,
  interventionRequired: false,
  lastCycle: null,
  works: [],
  stages: [],
  outstandingWork: 2,
  oldestOutstandingAt: "2026-09-10T20:00:00.000Z",
  oldestWaitingAt: "2026-09-10T19:00:00.000Z",
  lastSuccessAt: "2026-09-10T20:05:00.000Z",
  lastSuccessDurationMs: 1_560_000,
  retryScheduled: 1,
  blockerCounts: [],
  recentCycles: [],
} as unknown as BacktestAutomationStatus;

class FakeBacktestAutomation implements BacktestAutomationApi {
  readonly statusCalls: MarketId[] = [];
  readonly refreshCalls: MarketId[] = [];
  readonly checkCalls: MarketId[] = [];
  async status(marketId: MarketId): Promise<BacktestAutomationStatus> {
    this.statusCalls.push(marketId);
    return { ...automationStatus, marketId };
  }
  async refreshNow(marketId: MarketId): Promise<BacktestAutomationCycle> {
    this.refreshCalls.push(marketId);
    return {
      cycleId: "10000000-0000-4000-8000-000000000070",
      marketId,
      triggerOrigin: "REFRESH_NOW",
      outcome: "NO_CHANGES",
      startedAt: "2026-09-10T21:00:00.000Z",
      finishedAt: "2026-09-10T21:00:01.000Z",
      evaluated: 1,
      dispatched: 0,
      coalesced: 0,
      blocked: 0,
      retried: 0,
      succeeded: 0,
      failed: 0,
      changes: [],
    };
  }
  async checkNow(marketId: MarketId): Promise<BacktestAutomationCycle> {
    this.checkCalls.push(marketId);
    return {
      cycleId: "10000000-0000-4000-8000-000000000071",
      marketId,
      triggerOrigin: "REFRESH_NOW",
      outcome: "CHANGED",
      startedAt: "2026-09-10T21:00:00.000Z",
      finishedAt: "2026-09-10T21:00:01.000Z",
      evaluated: 2,
      dispatched: 1,
      coalesced: 0,
      blocked: 0,
      retried: 0,
      succeeded: 0,
      failed: 0,
      changes: [],
    };
  }
}

const policy: FundedHistoricalAutomationPolicy = {
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
  approvalNote: "Bounded funded replay comparison",
  approvedAt: "2026-09-10T20:00:00.000Z",
  expiresAt: "2026-10-10T20:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
};

class FakeFundedPolicies implements FundedHistoricalPolicyApi {
  requested?: CreateFundedHistoricalAutomationPolicy;
  revoked?: { id: string; input: RevokeFundedHistoricalAutomationPolicy };
  async listPolicies(): Promise<FundedHistoricalAutomationPolicy[]> {
    return [policy];
  }
  async requestPolicy(
    input: CreateFundedHistoricalAutomationPolicy,
  ): Promise<FundedHistoricalAutomationPolicy> {
    this.requested = input;
    return policy;
  }
  async revokePolicy(
    id: string,
    input: RevokeFundedHistoricalAutomationPolicy,
  ): Promise<FundedHistoricalAutomationPolicy | null> {
    this.revoked = { id, input };
    return id === policy.policyId
      ? {
          ...policy,
          revokedAt: "2026-09-11T12:00:00.000Z",
          revokedBy: input.revokedBy,
          revokedReason: input.reason,
        }
      : null;
  }
}

describe("Phase 8 backtest API", () => {
  it("creates and lists managed replay runs", async () => {
    const service = new FakeBacktests(),
      jobs = new FakeResearchJobs(),
      app = await buildApp({
        statusService: status(),
        backtestService: service,
        researchJobService: jobs,
      });
    expect(
      (await app.inject({ method: "GET", url: "/api/backtests" })).json(),
    ).toEqual({ runs: [run] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/captured-history/availability",
        })
      ).json(),
    ).toMatchObject({ replay: { earliestDate: "2026-08-01" } });
    const usAvailability = (
      await app.inject({
        method: "GET",
        url: "/api/captured-history/availability?marketId=US_EQUITIES",
      })
    ).json();
    expect(usAvailability.limitations).toEqual([
      expect.objectContaining({
        marketId: "US_EQUITIES",
        kind: "INTERIOR_NO_QUOTE",
        startAt: "2026-09-14T13:39:00.000Z",
        endAt: "2026-09-14T15:25:00.000Z",
        sessionDates: ["2026-09-14"],
      }),
    ]);
    const caAvailability = (
      await app.inject({
        method: "GET",
        url: "/api/captured-history/availability?marketId=CA_TSX",
      })
    ).json();
    expect(caAvailability.limitations).toEqual([]);
    const response = await app.inject({
      method: "POST",
      url: "/api/backtests",
      payload: {
        name: "RVOL test",
        startDate: "2026-08-01",
        endDate: "2026-08-25",
        strategies: ["ORB_RETEST"],
        parameters: { rvolAtTimeMin: 2 },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ id: jobId, status: "QUEUED" });
    expect(jobs.created?.jobType).toBe("BACKTEST");
    expect(jobs.created?.payload).toMatchObject({
      name: "RVOL test",
      parameters: { rvolAtTimeMin: 2, scoreCutoff: 0 },
      slippageBps: 2,
    });
    expect(
      (await app.inject({ method: "GET", url: `/api/backtests/${id}` }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });

  it("validates ranges, identifiers, and comparisons", async () => {
    const app = await buildApp({
      statusService: status(),
      backtestService: new FakeBacktests(),
      researchJobService: new FakeResearchJobs(),
    });
    expect(
      (await app.inject({ method: "POST", url: "/api/backtests", payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/backtests/nope" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/backtests/compare?ids=${id}`,
        })
      ).statusCode,
    ).toBe(400);
    const comparison = await app.inject({
      method: "GET",
      url: `/api/backtests/compare?ids=${id},${id}`,
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json().comparable).toBe(true);
    await app.close();
  });

  it("exposes research job status and cancellation, and forwards Idempotency-Key", async () => {
    const jobs = new FakeResearchJobs();
    const app = await buildApp({
      statusService: status(),
      backtestService: new FakeBacktests(),
      researchJobService: jobs,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/backtests",
      headers: { "idempotency-key": "client-retry-1" },
      payload: {
        name: "RVOL test",
        startDate: "2026-08-01",
        endDate: "2026-08-25",
        strategies: ["ORB_RETEST"],
      },
    });
    expect(response.statusCode).toBe(202);
    expect(jobs.created?.idempotencyKey).toBe("client-retry-1");
    expect(
      (await app.inject({ method: "GET", url: `/api/research-jobs/${jobId}` }))
        .statusCode,
    ).toBe(404); // FakeResearchJobs.get() returns undefined for this id
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/research-jobs/${jobId}/cancel`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/research-jobs/not-a-uuid",
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("serves market-scoped automation status and explicit refresh", async () => {
    const automation = new FakeBacktestAutomation();
    const app = await buildApp({
      statusService: status(),
      backtestService: new FakeBacktests(),
      researchJobService: new FakeResearchJobs(),
      backtestAutomationService: automation,
    });
    const usStatus = await app.inject({
      method: "GET",
      url: "/api/backtest-automation/status?marketId=US_EQUITIES",
    });
    expect(usStatus.statusCode, usStatus.body).toBe(200);
    expect(usStatus.json()).toMatchObject({
      marketId: "US_EQUITIES",
      enabled: false,
    });
    expect(automation.statusCalls).toEqual(["US_EQUITIES"]);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/backtest-automation/status?marketId=TSX",
    });
    expect(invalid.statusCode).toBe(400);

    const refresh = await app.inject({
      method: "POST",
      url: "/api/backtest-automation/refresh?marketId=CA_TSX",
    });
    expect(refresh.statusCode, refresh.body).toBe(202);
    expect(refresh.json()).toMatchObject({
      marketId: "CA_TSX",
      triggerOrigin: "REFRESH_NOW",
    });
    expect(automation.refreshCalls).toEqual(["CA_TSX"]);

    const check = await app.inject({
      method: "POST",
      url: "/api/backtest-automation/check?marketId=CA_TSX",
    });
    expect(check.statusCode, check.body).toBe(202);
    expect(check.json()).toMatchObject({
      marketId: "CA_TSX",
      triggerOrigin: "REFRESH_NOW",
      outcome: "CHANGED",
    });
    expect(automation.checkCalls).toEqual(["CA_TSX"]);
    expect(automation.refreshCalls).toEqual(["CA_TSX"]);

    await app.close();
  });

  it("returns 503 when automation is not wired", async () => {
    const app = await buildApp({
      statusService: status(),
      backtestService: new FakeBacktests(),
      researchJobService: new FakeResearchJobs(),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/backtest-automation/status",
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("exposes backtest automation gauges on /metrics", async () => {
    const app = await buildApp({
      statusService: status(),
      backtestAutomationService: new FakeBacktestAutomation(),
    });
    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
    });
    expect(metrics.statusCode, metrics.body).toBe(200);
    expect(metrics.body).toContain("scanner_backtest_automation_enabled 0");
    expect(metrics.body).toContain("scanner_backtest_automation_outstanding 2");
    expect(metrics.body).toContain(
      "scanner_backtest_automation_retry_scheduled 1",
    );
    expect(metrics.body).toContain(
      "scanner_backtest_automation_status_latency_ms",
    );
    expect(metrics.body).toContain(
      "scanner_backtest_automation_oldest_waiting_age_ms",
    );
    expect(metrics.body).toContain(
      "scanner_backtest_automation_last_result_duration_ms 1560000",
    );
    await app.close();
  });

  it("records, lists and revokes explicit funded replay policies", async () => {
    const policies = new FakeFundedPolicies();
    const app = await buildApp({
      statusService: status(),
      backtestService: new FakeBacktests(),
      researchJobService: new FakeResearchJobs(),
      fundedHistoricalPolicyService: policies,
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/funded-historical-policies?marketId=CA_TSX",
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().policies).toHaveLength(1);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/funded-historical-policies",
      payload: { marketId: "CA_TSX" },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/funded-historical-policies",
      payload: {
        marketId: "CA_TSX",
        scope: {
          kind: "PROFILE_CONFIG",
          configId: "10000000-0000-4000-8000-000000000098",
          configVersion: "profile-bull-flag-v1",
        },
        maxSessions: 5,
        approvedBy: "operator",
        approvalNote: "Bounded funded replay comparison",
        expiresAt: "2026-10-10T20:00:00.000Z",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(policies.requested?.maxSessions).toBe(5);

    const badRevoke = await app.inject({
      method: "POST",
      url: "/api/funded-historical-policies/not-a-uuid/revoke",
      payload: { revokedBy: "operator", reason: "Superseded" },
    });
    expect(badRevoke.statusCode).toBe(400);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/funded-historical-policies/${policy.policyId}/revoke`,
      payload: { revokedBy: "operator", reason: "Superseded" },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toMatchObject({
      policyId: policy.policyId,
      revokedBy: "operator",
      revokedReason: "Superseded",
    });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/funded-historical-policies/40000000-0000-4000-8000-000000000099/revoke",
      payload: { revokedBy: "operator", reason: "Superseded" },
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });
});
