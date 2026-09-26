import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import type {
  LearningDashboardApi,
  PaperReportingApi,
} from "../src/api-types.js";
import type {
  LearningAutomationRun,
  LearningDashboardOverview,
} from "@tsx-scanner/contracts";

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });

const runId = randomUUID();
const mockRun: LearningAutomationRun = {
  id: runId,
  schedulerVersion: "paper-evidence-scheduler-v1",
  policyVersion: "paper-evidence-v1",
  startedAt: "2026-09-02T12:00:00.000Z",
  completedAt: "2026-09-02T12:00:05.000Z",
  state: "NOOP",
  cohortsExamined: [],
  noopReason: "INSUFFICIENT_CLOSED_QUOTES",
  createdDatasetId: null,
  createdJobId: null,
  error: null,
  createdAt: "2026-09-02T12:00:05.000Z",
};

const mockOverview: LearningDashboardOverview = {
  pipelineHealth: {
    schedulerEnabled: true,
    schedulerPolicyVersion: "paper-evidence-v1",
    lastCheckAt: "2026-09-02T12:00:05.000Z",
    lastState: "NOOP",
    lastNoopReason: "INSUFFICIENT_CLOSED_QUOTES",
    activeJobs: 0,
    durableErrors: 0,
    explanation: "Scheduler idle",
  },
  evidenceReadiness: [],
  lifecycle: {
    datasetsCount: 1,
    modelsCount: 1,
    activeModelsCount: 1,
  },
  forwardMonitoring: [],
  shadowExperiments: {
    policyVersion: "paper-coordination-v4-shadow",
    comparatorPolicyVersion: "paper-coordination-v3",
    decisionsEvaluated: 10,
    selectionChangesCount: 2,
    selectionChangeRate: 0.2,
    differenceReasons: {
      V4_SHADOW_HIGHER_EXPECTED_R: 2,
    },
    hypotheticalNetPnl: 250,
    primaryNetPnl: 180,
    hypotheticalCumulativeR: 2.5,
    primaryCumulativeR: 1.8,
  },
};

describe("Learning API routes", () => {
  it("resolves readiness from a selected backtest run and strategy", async () => {
    const readiness = { sourceKind: "BACKTEST_RUN", distinctClosedTrades: 4 };
    const learningDashboardService: LearningDashboardApi = {
      overview: async () => mockOverview,
      automationRuns: async () => [mockRun],
      backtestStrategyLearningReadiness: async (id, strategyKey, marketId) => {
        expect(id).toBe(runId);
        expect(strategyKey).toBe("ORB_RETEST");
        expect(marketId).toBe("CA_TSX");
        return readiness as never;
      },
    };
    const app = await buildApp({
      statusService: status(),
      learningDashboardService,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/learning/backtest-runs/${runId}/strategy-readiness?strategyKey=ORB_RETEST&marketId=CA_TSX`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(readiness);
    await app.close();
  });

  it("serves GET /api/learning/overview", async () => {
    const learningDashboardService: LearningDashboardApi = {
      overview: async () => mockOverview,
      automationRuns: async () => [mockRun],
    };

    const app = await buildApp({
      statusService: status(),
      learningDashboardService,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/learning/overview",
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.pipelineHealth.schedulerEnabled).toBe(true);
    expect(body.shadowExperiments.decisionsEvaluated).toBe(10);
    expect(body.shadowExperiments.selectionChangesCount).toBe(2);
    await app.close();
  });

  it("serves market-scoped BACKTEST_RUN readiness without changing paper overview", async () => {
    const learningDashboardService: LearningDashboardApi = {
      overview: async () => mockOverview,
      automationRuns: async () => [mockRun],
      strategyLearningReadiness: async (input) => ({
        sourceKind: "BACKTEST_RUN",
        scope: input,
        state: "WAITING_FOR_EVIDENCE",
        targetDistinctTrades: 30,
        verifiedSessions: 1,
        distinctClosedTrades: 1,
        usableModelRows: 1,
        qualificationCounts: { EVIDENCE_QUALIFIED: 1, EXPLORATORY: 0 },
        exclusions: {},
        strata: { time: {}, atr: {}, rvol: {} },
        blockers: [],
        shortfall: 29,
        feasibility: {
          state: "UNAVAILABLE",
          reason: "MISSING_PREDECLARED_EXPERIMENT_CRITERIA",
        },
        collectionEstimate: {
          state: "UNAVAILABLE",
          reason: "NO_VERIFIED_SESSIONS",
          observedRateMin: null,
          observedRateMax: null,
          observedSessions: 0,
        },
      }),
    };
    const app = await buildApp({
      statusService: status(),
      learningDashboardService,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/learning/strategy-readiness?marketId=CA_TSX&strategyKey=ORB_RETEST&profileConfigId=00000000-0000-4000-8000-000000000001&strategyVersion=v3&configVersion=cfg-1&executionModelVersion=execution-v2&executionAssumptions=%7B%22feePerTrade%22%3A1%7D",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().sourceKind).toBe("BACKTEST_RUN");
    expect(response.json().distinctClosedTrades).toBe(1);
    expect(response.json().scope.marketId).toBe("CA_TSX");
    await app.close();
  });

  it("serves GET /api/learning/automation-runs", async () => {
    const learningDashboardService: LearningDashboardApi = {
      overview: async () => mockOverview,
      automationRuns: async () => [mockRun],
    };

    const app = await buildApp({
      statusService: status(),
      learningDashboardService,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/learning/automation-runs?limit=10",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe(runId);
    await app.close();
  });

  it("serves GET /api/learning/coordination-decisions", async () => {
    const decId = randomUUID();
    const paperReportingService: Partial<PaperReportingApi> = {
      coordinationDecisions: async () => [
        {
          id: decId,
          runId: randomUUID(),
          symbol: "SHOP.TO",
          decisionTimestamp: "2026-09-02T14:00:00.000Z",
          outcome: "APPROVED",
          reason: "SELECTED_PRIMARY",
          policyVersion: "paper-coordination-v3",
          selectedObservationId: randomUUID(),
          selectedStrategyKey: "ORB_RETEST",
          confirmationObservationIds: [],
          candidateCount: 1,
          contexts: [],
          state: {},
          positionStatus: null,
          exitReason: null,
          exitTime: null,
          netPnl: null,
          rMultiple: null,
          shadowDecision: null,
          createdAt: "2026-09-02T14:00:00.000Z",
        },
      ],
    };

    const app = await buildApp({
      statusService: status(),
      paperReportingService: paperReportingService as PaperReportingApi,
      learningDashboardService: {
        overview: async () => mockOverview,
        automationRuns: async () => [mockRun],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/learning/coordination-decisions",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].id).toBe(decId);
    await app.close();
  });
});
