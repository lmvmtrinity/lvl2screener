import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LearningDashboardService } from "../src/statistical-models/learning-dashboard-service.js";
import type { LearningAutomationStore } from "../src/statistical-models/learning-automation-repository.js";
import type { PaperEvidenceTrainingService } from "../src/statistical-models/paper-evidence-training-service.js";
import type {
  PaperReportingApi,
  PredictionMonitoringApi,
  StatisticalModelApi,
} from "../src/api-types.js";

const profileConfigId = randomUUID();
const datasetId = randomUUID();
const modelId = randomUUID();
const runId = randomUUID();
const decId = randomUUID();
const obsId = randomUUID();

describe("LearningDashboardService", () => {
  const mockAutomationStore: Partial<LearningAutomationStore> = {
    latestRun: async () => ({
      id: "run-001",
      schedulerVersion: "paper-evidence-scheduler-v1",
      policyVersion: "paper-evidence-v1",
      startedAt: "2026-09-02T12:00:00.000Z",
      completedAt: "2026-09-02T12:00:05.000Z",
      state: "NOOP",
      cohortsExamined: [
        {
          strategy: "ORB_RETEST",
          closedQuoteCount: 150,
          qualifies: false,
          reason: "INSUFFICIENT_CLOSED_QUOTES",
        },
      ],
      noopReason: "INSUFFICIENT_CLOSED_QUOTES",
      createdDatasetId: null,
      createdJobId: null,
      error: null,
      createdAt: "2026-09-02T12:00:05.000Z",
    }),
    listRuns: async () => [
      {
        id: "run-001",
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
      },
    ],
  };

  const mockEvidenceService: Partial<PaperEvidenceTrainingService> = {
    countDatasets: async () => 0,
    listCohorts: async () => [
      {
        marketId: "CA_TSX",
        strategy: "ORB_RETEST",
        strategyVersion: "v1",
        profileConfigId,
        configVersion: "1",
        executionModelVersion: "paper-model-v1",
        assumptions: {},
        closedQuoteCount: 220,
        positives: 120,
        negatives: 100,
        firstSignalAt: "2026-08-01T14:00:00.000Z",
        lastSignalAt: "2026-09-01T14:00:00.000Z",
        missingFeatureCount: 0,
      },
    ],
    latestDatasetFor: (async () => ({
      id: datasetId,
      effectiveCutoff: "2026-08-25T14:00:00.000Z",
      sourceRowCount: 160,
      sourceDigest: "digest-1",
      positiveCount: 90,
      negativeCount: 70,
      featureMetrics: {},
      createdAt: "2026-08-25T14:00:00.000Z",
    })) as any,
  };

  const mockModelService: Partial<StatisticalModelApi> = {
    list: (async () => [
      {
        id: modelId,
        modelVersion: "v1.0.0",
        strategy: "ORB_RETEST",
        artifact: null,
        active: true,
        activatedAt: "2026-08-26T14:00:00.000Z",
        deactivatedAt: null,
        createdAt: "2026-08-26T14:00:00.000Z",
      },
    ]) as any,
  };

  const mockMonitoringService: Partial<PredictionMonitoringApi> = {
    monitoring: async () => [
      {
        strategy: "ORB_RETEST",
        modelId,
        modelVersion: "v1.0.0",
        predictions: 45,
        closedOutcomes: 30,
        positives: 18,
        observedWinRate: 0.6,
        averagePredictedProbability: 0.58,
        brierScore: 0.22,
        firstPredictionAt: "2026-08-27T14:00:00.000Z",
        lastPredictionAt: "2026-09-02T14:00:00.000Z",
      },
    ],
  };

  const mockReportingService: Partial<PaperReportingApi> = {
    coordinationDecisions: async () => [
      {
        id: decId,
        runId,
        symbol: "SHOP.TO",
        decisionTimestamp: "2026-09-02T14:00:00.000Z",
        outcome: "APPROVED",
        reason: "SELECTED_PRIMARY",
        policyVersion: "paper-coordination-v3",
        selectedObservationId: obsId,
        selectedStrategyKey: "ORB_RETEST",
        confirmationObservationIds: [],
        candidateCount: 2,
        contexts: [],
        state: {},
        positionStatus: "CLOSED",
        exitReason: "TARGET",
        exitTime: "2026-09-02T15:00:00.000Z",
        netPnl: 150,
        rMultiple: 1.5,
        shadowDecision: {
          policyVersion: "paper-coordination-v4-shadow",
          outcome: "APPROVED",
          reason: "SELECTED_PRIMARY",
          selectedObservationId: obsId,
          selectedStrategyKey: "ORB_RETEST",
          differsFromPrimary: false,
          differenceReason: null,
        },
        createdAt: "2026-09-02T14:00:00.000Z",
      },
    ],
  };

  it("assembles overview satisfying learningDashboardOverviewSchema", async () => {
    const service = new LearningDashboardService(
      mockAutomationStore as LearningAutomationStore,
      mockEvidenceService as PaperEvidenceTrainingService,
      mockModelService as StatisticalModelApi,
      mockMonitoringService as PredictionMonitoringApi,
      mockReportingService as PaperReportingApi,
      true,
    );

    const overview = await service.overview();
    expect(overview.pipelineHealth.schedulerEnabled).toBe(true);
    expect(overview.pipelineHealth.lastState).toBe("NOOP");
    expect(overview.pipelineHealth.lastNoopReason).toBe(
      "INSUFFICIENT_CLOSED_QUOTES",
    );
    expect(overview.evidenceReadiness).toHaveLength(1);
    expect(overview.evidenceReadiness[0]?.closedQuoteCount).toBe(220);
    expect(overview.evidenceReadiness[0]?.qualifies).toBe(true);
    expect(overview.lifecycle.datasetsCount).toBe(0);
    expect(overview.pipelineHealth.scheduleDescription).toContain("5:00 p.m.");
    expect(overview.lifecycle.activeModelsCount).toBe(1);
    expect(overview.forwardMonitoring).toHaveLength(1);
    expect(overview.shadowExperiments.decisionsEvaluated).toBe(1);
    expect(overview.shadowExperiments.selectionChangesCount).toBe(0);
    expect(overview.shadowExperiments.primaryNetPnl).toBe(150);
    expect(overview.shadowExperiments.hypotheticalNetPnl).toBe(150);
    expect(overview.pipelineHealth.nextCheckAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(overview.pipelineHealth.nextCheckAt!))).toBe(
      false,
    );
    expect(overview.pipelineHealth.nextCheckIsEstimate).toBe(true);
  });

  function serviceWithLatest(
    latestRun: NonNullable<
      Awaited<ReturnType<LearningAutomationStore["latestRun"]>>
    > | null,
    trainingCheckMs: number | null = null,
  ) {
    const store = {
      latestRun: async () => latestRun,
      listRuns: async () => [],
    } as unknown as LearningAutomationStore;
    return new LearningDashboardService(
      store,
      mockEvidenceService as PaperEvidenceTrainingService,
      mockModelService as StatisticalModelApi,
      mockMonitoringService as PredictionMonitoringApi,
      mockReportingService as PaperReportingApi,
      true,
      undefined,
      "test schedule",
      undefined,
      trainingCheckMs,
    );
  }

  it("treats a recent check as on schedule and an old one as overdue", async () => {
    const base = (await mockAutomationStore.latestRun!())!;
    const recent = serviceWithLatest({
      ...base,
      completedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const recentHealth = (await recent.overview()).pipelineHealth;
    expect(recentHealth.nextCheckIsEstimate).toBe(true);
    expect(recentHealth.checkOverdue).toBe(false);

    const stale = serviceWithLatest({
      ...base,
      completedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    });
    expect((await stale.overview()).pipelineHealth.checkOverdue).toBe(true);
  });

  it("reports an unknown next check for an interval schedule without a prior check, and anchors otherwise", async () => {
    const base = (await mockAutomationStore.latestRun!())!;
    const unknown = serviceWithLatest(null, 3_600_000);
    const unknownHealth = (await unknown.overview()).pipelineHealth;
    expect(unknownHealth.nextCheckAt).toBeNull();
    expect(unknownHealth.nextCheckIsEstimate).toBe(true);
    expect(unknownHealth.checkOverdue).toBe(false);

    const completedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const overdue = serviceWithLatest({ ...base, completedAt }, 3_600_000);
    const overdueHealth = (await overdue.overview()).pipelineHealth;
    expect(overdueHealth.nextCheckAt).toBe(
      new Date(Date.parse(completedAt) + 3_600_000).toISOString(),
    );
    expect(overdueHealth.checkOverdue).toBe(true);
  });

  it("reports no next check when scheduling is disabled, and an interval override when set", async () => {
    const disabled = new LearningDashboardService(
      mockAutomationStore as LearningAutomationStore,
      mockEvidenceService as PaperEvidenceTrainingService,
      mockModelService as StatisticalModelApi,
      mockMonitoringService as PredictionMonitoringApi,
      mockReportingService as PaperReportingApi,
      false,
    );
    expect((await disabled.overview()).pipelineHealth.nextCheckAt).toBeNull();

    const override = new LearningDashboardService(
      mockAutomationStore as LearningAutomationStore,
      mockEvidenceService as PaperEvidenceTrainingService,
      mockModelService as StatisticalModelApi,
      mockMonitoringService as PredictionMonitoringApi,
      mockReportingService as PaperReportingApi,
      true,
      undefined,
      "Every 1 hours, plus worker startup",
      undefined,
      3_600_000,
    );
    const next = (await override.overview()).pipelineHealth.nextCheckAt;
    // Interval schedules are anchored to the last completed check. The mock's
    // last check is in the past, so this is honestly overdue rather than
    // resetting the countdown on every read.
    expect(next).toBe(
      new Date(
        Date.parse("2026-09-02T12:00:05.000Z") + 3_600_000,
      ).toISOString(),
    );
    expect((await override.overview()).pipelineHealth.checkOverdue).toBe(true);
  });
});
