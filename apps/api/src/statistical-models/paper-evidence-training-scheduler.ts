import type { ResearchJobApi } from "../api-types.js";
import type { PaperEvidenceCohort } from "@tsx-scanner/contracts";
import type { PaperEvidenceTrainingService } from "./paper-evidence-training-service.js";
import { PAPER_EVIDENCE_RESEARCH_POLICY } from "./paper-evidence-qualification.js";

import type { LearningAutomationStore } from "./learning-automation-repository.js";

export const PAPER_EVIDENCE_TRAINING_POLICY = {
  version: "paper-evidence-v1",
  minimumClosedQuotes: PAPER_EVIDENCE_RESEARCH_POLICY.minimumRows,
  minimumNewOutcomes: 50,
  trainPct: 80,
  minimumSamples: PAPER_EVIDENCE_RESEARCH_POLICY.minimumRows,
  l2Penalty: 0.1,
} as const;

/** One cohort's disposition in a scheduler pass, retained for the durable audit. */
interface ExaminedCohort {
  strategy: string;
  marketId: PaperEvidenceCohort["marketId"];
  cohort: PaperEvidenceCohort;
  closedQuoteCount: number;
  qualifies: boolean;
  status: string;
  reason?: string;
}

/** Conservative scheduler: it can enqueue an inactive challenger, never activate one. */
export class PaperEvidenceTrainingScheduler {
  constructor(
    private readonly evidence: PaperEvidenceTrainingService,
    private readonly jobs: ResearchJobApi,
    private readonly now: () => Date = () => new Date(),
    private readonly automationStore?: LearningAutomationStore,
  ) {}
  async run(): Promise<number> {
    const startedAt = this.now();
    let queued = 0;
    const cohortsExamined: ExaminedCohort[] = [];
    let createdDatasetId: string | null = null;
    let createdJobId: string | null = null;
    let primaryNoopReason: string | null = null;
    let runError: string | null = null;

    try {
      const listedCohorts = await this.evidence.listCohorts();
      const pendingPreparations =
        typeof this.evidence.pendingPreparations === "function"
          ? await this.evidence.pendingPreparations()
          : [];
      const seenCohorts = new Set(listedCohorts.map(cohortIdentity));
      const cohorts = [
        ...listedCohorts,
        ...pendingPreparations
          .filter((preparation) => {
            const key = cohortIdentity(preparation.cohort);
            if (seenCohorts.has(key)) return false;
            seenCohorts.add(key);
            return true;
          })
          .map((preparation) => preparation.cohort),
      ];
      if (cohorts.length === 0) {
        primaryNoopReason = "NO_COHORTS_AVAILABLE";
      }

      for (const cohort of cohorts) {
        const pendingPreparation =
          typeof this.evidence.pendingPreparationFor === "function" &&
          (await this.evidence.pendingPreparationFor(cohort));
        if (!pendingPreparation && !this.qualifies(cohort)) {
          cohortsExamined.push({
            strategy: cohort.strategy,
            marketId: cohort.marketId,
            cohort,
            closedQuoteCount: cohort.closedQuoteCount,
            qualifies: false,
            status: "DISQUALIFIED",
            reason:
              cohort.closedQuoteCount <
              PAPER_EVIDENCE_TRAINING_POLICY.minimumClosedQuotes
                ? `INSUFFICIENT_CLOSED_QUOTES (${cohort.closedQuoteCount} < ${PAPER_EVIDENCE_TRAINING_POLICY.minimumClosedQuotes})`
                : "CLASS_IMBALANCE (requires both positive and negative outcomes)",
          });
          continue;
        }
        const previous = pendingPreparation
          ? undefined
          : await this.evidence.latestDatasetFor(cohort);
        const previousClosedQuoteCount =
          previous?.cohort?.closedQuoteCount ??
          previous?.sourceRowCount ??
          cohort.closedQuoteCount;
        if (
          previous &&
          cohort.closedQuoteCount - previousClosedQuoteCount <
            PAPER_EVIDENCE_TRAINING_POLICY.minimumNewOutcomes
        ) {
          cohortsExamined.push({
            strategy: cohort.strategy,
            marketId: cohort.marketId,
            cohort,
            closedQuoteCount: cohort.closedQuoteCount,
            qualifies: true,
            status: "SKIPPED",
            reason: `INSUFFICIENT_NEW_OUTCOMES (${cohort.closedQuoteCount - previousClosedQuoteCount} < ${PAPER_EVIDENCE_TRAINING_POLICY.minimumNewOutcomes})`,
          });
          continue;
        }
        const cutoff = this.now();
        const qualification = pendingPreparation
          ? undefined
          : await this.evidence.qualify(cohort, cutoff);
        if (qualification && !qualification.qualification.qualified) {
          cohortsExamined.push({
            strategy: cohort.strategy,
            marketId: cohort.marketId,
            cohort,
            closedQuoteCount: cohort.closedQuoteCount,
            qualifies: true,
            status: "SKIPPED",
            reason: `RESEARCH_QUALIFICATION: ${qualification.qualification.reasons.join(", ")}`,
          });
          continue;
        }
        const prepared =
          typeof this.evidence.prepareAndMaterialize === "function"
            ? await this.evidence.prepareAndMaterialize(
                cohort,
                cutoff,
                qualification,
              )
            : {
                dataset: await this.evidence.materialize(cohort, cutoff),
                pending: false,
              };
        if (prepared.pending || !prepared.dataset) {
          cohortsExamined.push({
            strategy: cohort.strategy,
            marketId: cohort.marketId,
            cohort,
            closedQuoteCount: cohort.closedQuoteCount,
            qualifies: true,
            status: "WAITING",
            reason: "COVERAGE_PENDING",
          });
          continue;
        }
        const dataset = prepared.dataset;
        if (!dataset.researchQualification?.qualified) {
          cohortsExamined.push({
            strategy: cohort.strategy,
            marketId: cohort.marketId,
            cohort,
            closedQuoteCount: cohort.closedQuoteCount,
            qualifies: true,
            status: "SKIPPED",
            reason: `RESEARCH_QUALIFICATION_SNAPSHOT: ${dataset.researchQualification?.reasons.join(", ") ?? "MISSING"}`,
          });
          continue;
        }
        const datasetCohort = dataset.cohort ?? cohort;
        const datasetMarketId = dataset.marketId ?? datasetCohort.marketId;
        createdDatasetId = dataset.id;
        const job = await this.jobs.createJob(
          "STATISTICAL_TRAINING",
          {
            sourceKind: "PAPER_EVIDENCE",
            name: `Paper evidence challenger · ${datasetCohort.strategy} · ${dataset.effectiveCutoff.slice(0, 10)}`,
            trainingDatasetId: dataset.id,
            sourceDigest: dataset.sourceDigest,
            strategy: datasetCohort.strategy,
            marketId: datasetMarketId,
            cohort: datasetCohort,
            trainPct: PAPER_EVIDENCE_TRAINING_POLICY.trainPct,
            minimumSamples: PAPER_EVIDENCE_TRAINING_POLICY.minimumSamples,
            l2Penalty: PAPER_EVIDENCE_TRAINING_POLICY.l2Penalty,
          },
          `paper-evidence:${dataset.sourceDigest}`,
        );
        createdJobId = job.id;
        if (job.status === "QUEUED") {
          queued += 1;
          cohortsExamined.push({
            strategy: cohort.strategy,
            marketId: cohort.marketId,
            cohort,
            closedQuoteCount: cohort.closedQuoteCount,
            qualifies: true,
            status: "JOB_QUEUED",
          });
        } else {
          cohortsExamined.push({
            strategy: cohort.strategy,
            marketId: cohort.marketId,
            cohort,
            closedQuoteCount: cohort.closedQuoteCount,
            qualifies: true,
            status: `JOB_${job.status}`,
            reason: `Job already in state ${job.status}`,
          });
        }
      }

      if (queued === 0 && !primaryNoopReason) {
        primaryNoopReason =
          cohortsExamined.length === 0
            ? "NO_COHORTS_AVAILABLE"
            : this.primaryNoopReason(cohortsExamined);
      }
      return queued;
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (this.automationStore) {
        try {
          await this.automationStore.recordRun({
            schedulerVersion: "paper-evidence-scheduler-v1",
            policyVersion: PAPER_EVIDENCE_TRAINING_POLICY.version,
            startedAt,
            completedAt: this.now(),
            state: runError ? "FAILED" : queued > 0 ? "SUCCESS" : "NOOP",
            cohortsExamined,
            noopReason: queued === 0 ? primaryNoopReason : null,
            createdDatasetId,
            createdJobId,
            error: runError,
          });
        } catch {
          // Idempotent and fail-safe: never throw from recordRun in scheduler
        }
      }
    }
  }
  private qualifies(cohort: PaperEvidenceCohort): boolean {
    return (
      cohort.closedQuoteCount >=
        PAPER_EVIDENCE_TRAINING_POLICY.minimumClosedQuotes &&
      cohort.positives > 0 &&
      cohort.negatives > 0
    );
  }

  /**
   * One reason is stored per NOOP run. Reporting the first examined cohort made
   * the shortfall misleading: an arbitrary young cohort hid the cohort that is
   * actually accumulating. Report the cohort closest to training -- one that
   * already passes the closed-quote gate but is blocked later, otherwise the
   * largest closed-quote count -- and name it so the operator can see which
   * cohort is progressing.
   */
  private primaryNoopReason(
    cohortsExamined: readonly ExaminedCohort[],
  ): string {
    const leading = cohortsExamined.reduce((best, entry) => {
      if (entry.qualifies !== best.qualifies)
        return entry.qualifies ? entry : best;
      return entry.closedQuoteCount > best.closedQuoteCount ? entry : best;
    });
    const base = leading.reason ?? "NO_QUALIFYING_NEW_DATA";
    return `${base} · leading ${leading.marketId}/${leading.strategy} · ${cohortsExamined.length} cohorts examined`;
  }
}

function cohortIdentity(cohort: PaperEvidenceCohort): string {
  return JSON.stringify({
    marketId: cohort.marketId,
    strategy: cohort.strategy,
    strategyVersion: cohort.strategyVersion,
    profileConfigId: cohort.profileConfigId,
    configVersion: cohort.configVersion,
    executionModelVersion: cohort.executionModelVersion,
    assumptions: cohort.assumptions,
    signalSemanticsVersion: cohort.signalSemanticsVersion ?? "UNKNOWN",
    replayScope: cohort.replayScope ?? "UNKNOWN",
  });
}
