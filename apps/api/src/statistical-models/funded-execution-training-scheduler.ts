import type { ResearchJobApi } from "../api-types.js";
import type {
  FundedCohortIdentity,
  FundedExecutionChallenger,
} from "@tsx-scanner/contracts";
import type { FundedExecutionMaterialization } from "./funded-execution-training-service.js";
import type { FundedExecutionCohortSummary } from "./funded-execution-training-repository.js";

/**
 * The narrow evidence surface the scheduler needs. `FundedExecutionTrainingService`
 * satisfies it; tests can substitute a deterministic fake without a database.
 */
export interface FundedExecutionTrainingEvidence {
  listCohorts(): Promise<FundedExecutionCohortSummary[]>;
  materialize(
    cohort: FundedCohortIdentity,
    requestedCutoff: Date,
  ): Promise<FundedExecutionMaterialization>;
  findChallengerByDatasetDigest(
    datasetDigest: string,
  ): Promise<FundedExecutionChallenger | undefined>;
}

/**
 * Conservative funded-execution scheduler (FP02). It can materialize a
 * qualified dataset and enqueue one inactive challenger training attempt; it
 * can never activate a model, modify a profile or change funded policy.
 *
 * Idempotency:
 *
 * - one job per frozen dataset digest, enforced by the research-job
 *   idempotency key and by checking for an existing challenger first;
 * - no job is enqueued below the qualification floors, because a non-qualified
 *   receipt returns no dataset;
 * - replay-only cohorts are skipped entirely and never auto-train;
 * - a restart repeats the same checks and returns the existing job/challenger.
 */

export const FUNDED_EXECUTION_SCHEDULER_VERSION =
  "funded-execution-scheduler-v1" as const;

interface ExaminedCohort {
  marketId: FundedCohortIdentity["marketId"];
  sourceKind: FundedCohortIdentity["sourceKind"];
  status: string;
  reason?: string;
}

export interface FundedExecutionSchedulerResult {
  queued: number;
  examined: ExaminedCohort[];
}

export class FundedExecutionTrainingScheduler {
  constructor(
    private readonly evidence: FundedExecutionTrainingEvidence,
    private readonly jobs: ResearchJobApi,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(): Promise<FundedExecutionSchedulerResult> {
    const cohorts = await this.evidence.listCohorts();
    let queued = 0;
    const examined: ExaminedCohort[] = [];
    for (const summary of cohorts) {
      // Historical-replay datasets are isolated research artifacts and never
      // automatically trainable or activation-eligible.
      if (summary.sourceKind !== "LIVE_PAPER") continue;
      if (summary.completedLiveCount === 0) {
        examined.push({
          marketId: summary.cohort.marketId,
          sourceKind: summary.sourceKind,
          status: "SKIPPED",
          reason: "NO_COMPLETED_LIVE_RUNS",
        });
        continue;
      }
      const materialization: FundedExecutionMaterialization =
        await this.evidence.materialize(summary.cohort, this.now());
      if (!materialization.dataset) {
        examined.push({
          marketId: summary.cohort.marketId,
          sourceKind: summary.sourceKind,
          status: "SKIPPED",
          reason: materialization.receipt.reasons.join(", ") || "NOT_QUALIFIED",
        });
        continue;
      }
      const dataset = materialization.dataset;
      const existing = await this.evidence.findChallengerByDatasetDigest(
        dataset.datasetDigest,
      );
      if (existing) {
        examined.push({
          marketId: summary.cohort.marketId,
          sourceKind: summary.sourceKind,
          status: `CHALLENGER_${existing.status}`,
        });
        continue;
      }
      const job = await this.jobs.createJob(
        "FUNDED_EXECUTION_TRAINING",
        {
          sourceKind: "FUNDED_EXECUTION",
          datasetId: dataset.id,
          marketId: summary.cohort.marketId,
          cohort: summary.cohort,
        },
        `funded-execution:${dataset.datasetDigest}`,
      );
      if (job.status === "QUEUED") {
        queued += 1;
        examined.push({
          marketId: summary.cohort.marketId,
          sourceKind: summary.sourceKind,
          status: "JOB_QUEUED",
        });
      } else {
        examined.push({
          marketId: summary.cohort.marketId,
          sourceKind: summary.sourceKind,
          status: `JOB_${job.status}`,
        });
      }
    }
    return { queued, examined };
  }
}
