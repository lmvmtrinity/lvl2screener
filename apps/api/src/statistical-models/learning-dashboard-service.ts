import {
  learningDashboardOverviewSchema,
  type LearningAutomationRun,
  type LearningDashboardOverview,
  type PaperEvidenceCohort,
  type EvidenceAutomationStage,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { LearningAutomationStore } from "./learning-automation-repository.js";
import type { PaperEvidenceTrainingService } from "./paper-evidence-training-service.js";
import type {
  LearningDashboardApi,
  PaperReportingApi,
  PredictionMonitoringApi,
  ResearchJobApi,
  StatisticalModelApi,
} from "../api-types.js";
import { PAPER_EVIDENCE_TRAINING_POLICY } from "./paper-evidence-training-scheduler.js";
import { nextLearningCheck } from "./daily-learning-schedule.js";
import type { EvidenceAutomationService } from "./evidence-automation-service.js";

export class LearningDashboardService implements LearningDashboardApi {
  constructor(
    private readonly automationStore: LearningAutomationStore,
    private readonly evidenceTrainingService: PaperEvidenceTrainingService,
    private readonly statisticalModelService: StatisticalModelApi,
    private readonly predictionMonitoringService: PredictionMonitoringApi,
    private readonly paperReportingService: PaperReportingApi,
    private readonly schedulerEnabled: boolean,
    private readonly researchJobService?: ResearchJobApi,
    private readonly scheduleDescription: string = "Daily at 5:00 p.m. Eastern, plus worker startup",
    private readonly evidenceAutomationService?: EvidenceAutomationService,
    /** Explicit interval override; null uses the daily Eastern schedule. */
    private readonly trainingCheckMs: number | null = null,
  ) {}

  /** Configured next check plus an honest estimate/overdue verdict.
   *
   * The worker does not persist its timer. For the daily Eastern schedule the
   * value is the next wall-clock boundary from "now"; for an interval override
   * it is anchored to the last completed check, so a stopped worker reports a
   * past time instead of a countdown that resets on every read. `checkOverdue`
   * uses the same anchor: a check past its expected time plus grace means the
   * schedule has been missed, not that everything is fine. */
  private nextCheckState(lastCheckAt: string | null): {
    nextCheckAt: string | null;
    nextCheckIsEstimate: boolean;
    checkOverdue: boolean;
  } {
    if (!this.schedulerEnabled)
      return {
        nextCheckAt: null,
        nextCheckIsEstimate: false,
        checkOverdue: false,
      };
    const now = Date.now();
    const graceMs = 15 * 60_000;
    if (this.trainingCheckMs) {
      const base = lastCheckAt ? Date.parse(lastCheckAt) : Number.NaN;
      if (!Number.isFinite(base))
        return {
          nextCheckAt: null,
          nextCheckIsEstimate: true,
          checkOverdue: false,
        };
      const next = base + this.trainingCheckMs;
      return {
        nextCheckAt: new Date(next).toISOString(),
        nextCheckIsEstimate: true,
        checkOverdue: now > next + graceMs,
      };
    }
    const next = nextLearningCheck(new Date()).toISOString();
    const expectedFromLast = lastCheckAt
      ? nextLearningCheck(new Date(lastCheckAt)).getTime()
      : null;
    return {
      nextCheckAt: next,
      nextCheckIsEstimate: true,
      checkOverdue:
        expectedFromLast !== null && now > expectedFromLast + graceMs,
    };
  }

  async evidenceArtifact(
    kind: string,
    id: string,
    marketId: MarketId,
  ): Promise<unknown | undefined> {
    return this.evidenceAutomationService?.artifact(kind, id, marketId);
  }

  async automationRuns(limit = 50): Promise<LearningAutomationRun[]> {
    return this.automationStore.listRuns(limit);
  }

  async evidenceAutomation(
    marketId: MarketId,
  ): Promise<EvidenceAutomationStage[]> {
    if (!this.evidenceAutomationService) return [];
    return this.evidenceAutomationService.stages(marketId);
  }

  async overview(): Promise<LearningDashboardOverview> {
    const [
      latestRun,
      recentRuns,
      cohorts,
      models,
      monitoring,
      decisions,
      jobs,
      datasetsCount,
    ] = await Promise.all([
      this.automationStore.latestRun(),
      this.automationStore.listRuns(20),
      this.evidenceTrainingService.listCohorts(),
      this.statisticalModelService.list(100),
      this.predictionMonitoringService.monitoring(),
      this.paperReportingService.coordinationDecisions({}, 500),
      this.researchJobService?.list?.("STATISTICAL_TRAINING", 100) ?? [],
      this.evidenceTrainingService.countDatasets(),
    ]);

    const durableErrors = recentRuns.filter(
      (run) => run.state === "FAILED",
    ).length;
    let explanation = "Scheduler active; waiting for scheduled check";
    if (latestRun) {
      if (latestRun.state === "SUCCESS") {
        explanation = `Scheduler ran successfully at ${latestRun.completedAt}`;
      } else if (latestRun.state === "NOOP") {
        explanation = `Scheduler idle: ${latestRun.noopReason ?? "No qualifying new outcomes"}`;
      } else if (latestRun.state === "FAILED") {
        explanation = `Scheduler failure: ${latestRun.error ?? "Execution error"}`;
      }
    }

    const evidenceReadiness = await Promise.all(
      cohorts.map(async (cohort: PaperEvidenceCohort) => {
        const latestDataset =
          await this.evidenceTrainingService.latestDatasetFor(cohort);
        const threshold = PAPER_EVIDENCE_TRAINING_POLICY.minimumClosedQuotes;
        const newOutcomeThreshold =
          PAPER_EVIDENCE_TRAINING_POLICY.minimumNewOutcomes;
        const progressPct = Math.min(
          100,
          Math.round((cohort.closedQuoteCount / threshold) * 100),
        );
        const newOutcomesSinceLastDataset = latestDataset
          ? Math.max(0, cohort.closedQuoteCount - latestDataset.sourceRowCount)
          : cohort.closedQuoteCount;
        const qualifies =
          cohort.closedQuoteCount >= threshold &&
          cohort.positives > 0 &&
          cohort.negatives > 0 &&
          newOutcomesSinceLastDataset >= newOutcomeThreshold;

        let disqualificationReason: string | null = null;
        if (!qualifies) {
          if (cohort.closedQuoteCount < threshold) {
            disqualificationReason = `INSUFFICIENT_CLOSED_QUOTES (${cohort.closedQuoteCount} < ${threshold})`;
          } else if (cohort.positives === 0 || cohort.negatives === 0) {
            disqualificationReason = "CLASS_IMBALANCE";
          } else if (newOutcomesSinceLastDataset < newOutcomeThreshold) {
            disqualificationReason = `INSUFFICIENT_NEW_OUTCOMES (${newOutcomesSinceLastDataset} < ${newOutcomeThreshold})`;
          }
        }

        return {
          cohort,
          closedQuoteCount: cohort.closedQuoteCount,
          threshold,
          progressPct,
          newOutcomesSinceLastDataset,
          newOutcomeThreshold,
          qualifies,
          disqualificationReason,
        };
      }),
    );

    const activeModels = models.filter((model) => model.active);

    const evaluated = decisions.filter(
      (decision) => decision.shadowDecision != null,
    );
    const changes = evaluated.filter(
      (decision) =>
        (decision.shadowDecision as { differsFromPrimary?: boolean })
          ?.differsFromPrimary === true,
    );

    const differenceReasons: Record<string, number> = {};
    let primaryNetPnl = 0;
    let primaryCumulativeR = 0;
    let hypotheticalNetPnl = 0;
    let hypotheticalCumulativeR = 0;

    for (const decision of evaluated) {
      const shadow = decision.shadowDecision as
        | {
            differsFromPrimary?: boolean;
            differenceReason?: string | null;
            outcome?: string;
            selectedObservationId?: string | null;
            sizing?: { multiplier?: number } | null;
          }
        | undefined;

      if (shadow?.differsFromPrimary && shadow.differenceReason) {
        differenceReasons[shadow.differenceReason] =
          (differenceReasons[shadow.differenceReason] ?? 0) + 1;
      }

      if (decision.outcome === "APPROVED") {
        primaryNetPnl += decision.netPnl ?? 0;
        primaryCumulativeR += decision.rMultiple ?? 0;
      }

      if (shadow?.outcome === "APPROVED" && shadow.selectedObservationId) {
        const multiplier = shadow.sizing?.multiplier ?? 1;
        if (
          shadow.selectedObservationId === decision.selectedObservationId &&
          decision.outcome === "APPROVED"
        ) {
          hypotheticalNetPnl += (decision.netPnl ?? 0) * multiplier;
          hypotheticalCumulativeR += (decision.rMultiple ?? 0) * multiplier;
          continue;
        }
        const candidateOutcome =
          decision.candidateOutcomes?.[shadow.selectedObservationId];
        // Every candidate has an independent QUOTE execution. Use that
        // untouched result when v4 chose a different candidate; using the v3
        // position here would silently turn every divergence into zero.
        if (candidateOutcome?.status === "CLOSED") {
          hypotheticalNetPnl += (candidateOutcome.netPnl ?? 0) * multiplier;
          hypotheticalCumulativeR +=
            (candidateOutcome.rMultiple ?? 0) * multiplier;
        }
      }
      // A shadow veto contributes 0 by definition; open/unfilled candidates
      // are excluded until their independent outcome is complete.
    }

    const shadowExperiments = {
      policyVersion: "paper-coordination-v4-shadow" as const,
      comparatorPolicyVersion: "paper-coordination-v3",
      decisionsEvaluated: evaluated.length,
      selectionChangesCount: changes.length,
      selectionChangeRate:
        evaluated.length > 0 ? changes.length / evaluated.length : 0,
      differenceReasons,
      hypotheticalNetPnl: Math.round(hypotheticalNetPnl * 100) / 100,
      primaryNetPnl: Math.round(primaryNetPnl * 100) / 100,
      hypotheticalCumulativeR:
        Math.round(hypotheticalCumulativeR * 1000) / 1000,
      primaryCumulativeR: Math.round(primaryCumulativeR * 1000) / 1000,
    };

    return learningDashboardOverviewSchema.parse({
      pipelineHealth: {
        schedulerEnabled: this.schedulerEnabled,
        scheduleDescription: this.scheduleDescription,
        schedulerPolicyVersion: PAPER_EVIDENCE_TRAINING_POLICY.version,
        lastCheckAt: latestRun?.completedAt ?? null,
        ...this.nextCheckState(latestRun?.completedAt ?? null),
        lastState: latestRun?.state ?? null,
        lastNoopReason: latestRun?.noopReason ?? null,
        activeJobs: jobs.filter(
          (job) => job.status === "QUEUED" || job.status === "RUNNING",
        ).length,
        durableErrors,
        explanation,
      },
      evidenceReadiness,
      lifecycle: {
        datasetsCount,
        modelsCount: models.length,
        activeModelsCount: activeModels.length,
      },
      forwardMonitoring: monitoring,
      shadowExperiments,
    });
  }
}
