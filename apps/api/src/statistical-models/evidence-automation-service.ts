import {
  evidenceAutomationResponseSchema,
  evidenceAutomationStageSchema,
  evidenceWorkIdentitySchema,
  type EvidenceAutomationStage,
  type EvidenceWorkIdentity,
  type EvidenceWorkReceipt,
  type MarketId,
  type ResearchJob,
} from "@tsx-scanner/contracts";
import type { ResearchJobApi } from "../api-types.js";
import {
  evidenceWorkKey,
  type EvidenceAutomationRepository,
} from "./evidence-automation-repository.js";
import { researchJobMarket } from "../research-jobs/research-job-market.js";
import type {
  EvidenceStageFact,
  PostgresEvidenceAutomationReadRepository,
} from "./evidence-automation-read-repository.js";

const STAGES = [
  "COVERAGE",
  "QUALIFICATION",
  "STUDY",
  "TRAINING",
  "FORWARD_OBSERVATION",
  "DIAGNOSTICS",
] as const;

export class EvidenceAutomationService {
  constructor(
    private readonly repository: EvidenceAutomationRepository,
    private readonly researchJobs?: ResearchJobApi,
    private readonly now: () => Date = () => new Date(),
    private readonly readRepository?: Pick<
      PostgresEvidenceAutomationReadRepository,
      "listStageFacts"
    > &
      Partial<Pick<PostgresEvidenceAutomationReadRepository, "artifact">>,
  ) {}

  async artifact(
    kind: string,
    id: string,
    marketId: MarketId,
  ): Promise<unknown | undefined> {
    return this.readRepository?.artifact?.(kind, id, marketId);
  }

  async record(
    identity: EvidenceWorkIdentity,
    receipt: Omit<
      EvidenceWorkReceipt,
      "workKey" | "identity" | "recordedAt"
    > & {
      recordedAt?: string;
    },
  ): Promise<void> {
    const parsedIdentity = evidenceWorkIdentitySchema.parse(identity);
    await this.repository.record(parsedIdentity, {
      ...receipt,
      workKey: evidenceWorkKey(parsedIdentity),
      identity: parsedIdentity,
      recordedAt: receipt.recordedAt ?? this.now().toISOString(),
    });
  }

  async dispatchCoverage(
    identity: EvidenceWorkIdentity,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ResearchJob> {
    if (identity.kind !== "COVERAGE")
      throw new Error("EVIDENCE_DISPATCH_KIND_MISMATCH");
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    if (!this.researchJobs) throw new Error("RESEARCH_JOB_SERVICE_UNAVAILABLE");
    const job = this.researchJobs.createStrictJob
      ? await this.researchJobs.createStrictJob(
          "COVERAGE_VERIFICATION",
          payload,
          idempotencyKey,
        )
      : await this.researchJobs.createJob(
          "COVERAGE_VERIFICATION",
          payload,
          idempotencyKey,
        );
    await this.record(identity, {
      state: "DISPATCHED",
      jobId: job.id,
      reasonCodes: [],
    });
    return job;
  }

  async catchUp(marketId: MarketId): Promise<number> {
    return (await this.repository.catchUp?.(marketId, 100, 1_000)) ?? 0;
  }

  async stages(marketId: MarketId): Promise<EvidenceAutomationStage[]> {
    const [work, jobs, facts] = await Promise.all([
      this.repository.list(marketId),
      this.researchJobs?.list?.(undefined, 200) ?? Promise.resolve([]),
      this.readRepository?.listStageFacts(marketId) ?? Promise.resolve([]),
    ]);
    const linkedJobs = this.researchJobs?.get
      ? await Promise.all(
          work
            .map((value) => value.jobId)
            .filter((value): value is string => Boolean(value))
            .map((id) => this.researchJobs!.get(id)),
        )
      : [];
    const allJobs = [
      ...jobs,
      ...linkedJobs.filter((value): value is ResearchJob => Boolean(value)),
    ].filter(
      (value, index, values) =>
        values.findIndex((candidate) => candidate.id === value.id) === index,
    );
    const asOf = this.now().toISOString();
    const stages = STAGES.map((key) => {
      const candidates = facts
        .filter((fact) => fact.key === key && fact.marketId === marketId)
        .map((fact) => stageFromFact(fact, asOf));
      const representedJobs = new Set(candidates.map((value) => value.jobId));
      for (const item of work.filter((value) => value.identity.kind === key)) {
        if (item.jobId && representedJobs.has(item.jobId)) continue;
        const job = allJobs.find((value) => value.id === item.jobId);
        candidates.push(
          stageFor(
            key,
            marketId,
            asOf,
            item.receipt,
            job,
            job?.resultRefId ?? null,
          ),
        );
        if (item.jobId) representedJobs.add(item.jobId);
      }
      for (const job of allJobs) {
        if (representedJobs.has(job.id)) continue;
        const expected = {
          COVERAGE: "COVERAGE_VERIFICATION",
          STUDY: "STRATEGY_STUDY",
          TRAINING: "STATISTICAL_TRAINING",
          DIAGNOSTICS: "EXECUTION_DIAGNOSTICS",
        }[key as "COVERAGE" | "STUDY" | "TRAINING" | "DIAGNOSTICS"];
        if (job.jobType !== expected) continue;
        try {
          if (researchJobMarket(job.jobType, job.requestPayload) !== marketId)
            continue;
        } catch {
          continue;
        }
        candidates.push(
          stageFor(key, marketId, asOf, undefined, job, job.resultRefId),
        );
      }
      if (!candidates.length)
        return stageFor(key, marketId, asOf, undefined, undefined, null);
      candidates.sort(
        (a, b) =>
          stagePriority(a.state) - stagePriority(b.state) ||
          (b.lastAttemptAt ?? "").localeCompare(a.lastAttemptAt ?? "") ||
          a.scopeId.localeCompare(b.scopeId),
      );
      const latest = (values: (string | null)[]) =>
        values
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1) ?? null;
      const selected = candidates[0]!;
      const latestSavedSuccess = [...candidates]
        .filter((value) => value.reportId && value.lastSuccessAt)
        .sort((a, b) => b.lastSuccessAt!.localeCompare(a.lastSuccessAt!))[0];
      // Retained identity is the work/job/artifact the candidate describes.
      // Fallback scope labels (for example the job read-model's
      // `${market}:${lane}:job`) can be shared by distinct jobs, so scope alone
      // must not hide failures, successes or their saved reports.
      const retainedIdentity = (value: EvidenceAutomationStage) =>
        JSON.stringify([value.jobId, value.reportId, value.scopeId]);
      const seenIdentities = new Set<string>([retainedIdentity(selected)]);
      const relatedScopes: NonNullable<
        EvidenceAutomationStage["relatedScopes"]
      > = [];
      for (const value of candidates.slice(1)) {
        const identity = retainedIdentity(value);
        if (seenIdentities.has(identity)) continue;
        seenIdentities.add(identity);
        if (!(
          // Priority ranks the primary state; retained-history visibility is
          // separate. A meaningful UNKNOWN report (with its retained report
          // ID) stays inspectable even though it is not a success.
          stagePriority(value.state) < 4 ||
          (value.state === "UNKNOWN" && Boolean(value.reportId)) ||
          value === latestSavedSuccess
        ))
          continue;
        relatedScopes.push({
          scopeId: value.scopeId,
          state: value.state,
          lastAttemptAt: value.lastAttemptAt,
          progress: value.progress,
          reasonCodes: value.reasonCodes,
          jobId: value.jobId,
          reportId: value.reportId,
        });
      }
      return {
        ...selected,
        // State, job and attempt time describe the same selected work item.
        // A newer unrelated receipt must not re-date an older failure.
        lastAttemptAt: selected.lastAttemptAt,
        lastSuccessAt: latest(candidates.map((value) => value.lastSuccessAt)),
        relatedScopes,
      };
    });
    return evidenceAutomationResponseSchema.parse({ stages }).stages;
  }
}

function stageFromFact(
  fact: EvidenceStageFact,
  asOf: string,
): EvidenceAutomationStage {
  return evidenceAutomationStageSchema.parse({
    key: fact.key,
    marketId: fact.marketId,
    scopeId: fact.scopeId,
    state: fact.state,
    asOf,
    lastAttemptAt: fact.attemptedAt,
    lastSuccessAt: fact.succeededAt,
    nextCheckAt: fact.nextCheckAt,
    progress: fact.progress,
    reasonCodes: fact.reasonCodes,
    nextAction: nextActionFor(fact.state),
    jobId: fact.jobId,
    reportId: fact.reportId,
  });
}

function stageFor(
  key: EvidenceAutomationStage["key"],
  marketId: MarketId,
  asOf: string,
  receipt: EvidenceWorkReceipt | null | undefined,
  job: ResearchJob | undefined,
  reportId: string | null,
): EvidenceAutomationStage {
  if (!receipt && !job) {
    return evidenceAutomationStageSchema.parse({
      key,
      marketId,
      scopeId: `${marketId}:unresolved`,
      state: "UNKNOWN",
      asOf,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextCheckAt: null,
      progress: null,
      reasonCodes: ["NO_DURABLE_HISTORY"],
      nextAction: {
        kind: "AUTOMATIC",
        label: "Awaiting the next evidence check",
      },
      jobId: null,
      reportId: null,
    });
  }
  if (!receipt && job) {
    const state = stateFor(
      {
        workKey: "0".repeat(64),
        identity: {
          kind: "COVERAGE",
          marketId,
          scopeHash: "0".repeat(64),
          inputIdentityHash: "0".repeat(64),
          processorVersion: "job-read-model",
        },
        state: "DISPATCHED",
        jobId: job.id,
        reasonCodes: [],
        recordedAt: job.createdAt,
      },
      job,
    );
    return evidenceAutomationStageSchema.parse({
      key,
      marketId,
      scopeId: `${marketId}:${key.toLowerCase()}:job`,
      state,
      asOf,
      lastAttemptAt: job.startedAt ?? job.createdAt,
      lastSuccessAt: job.status === "SUCCEEDED" ? job.completedAt : null,
      nextCheckAt: null,
      progress:
        job.progress.totalSessions &&
        job.progress.completedSessions !== undefined
          ? {
              completed: Math.min(
                job.progress.completedSessions,
                job.progress.totalSessions,
              ),
              total: job.progress.totalSessions,
              unit: "sessions",
            }
          : null,
      reasonCodes: job.error
        ? [job.errorCategory ?? "RESEARCH_JOB_FAILED"]
        : [],
      nextAction: nextActionFor(state),
      jobId: job.id,
      reportId: job.resultRefId,
    });
  }
  if (!receipt) throw new Error("EVIDENCE_AUTOMATION_RECEIPT_UNAVAILABLE");
  const state = stateFor(receipt, job);
  return evidenceAutomationStageSchema.parse({
    key,
    marketId,
    scopeId: `${marketId}:${key.toLowerCase()}`,
    state,
    asOf,
    lastAttemptAt: job?.startedAt ?? receipt.recordedAt,
    lastSuccessAt:
      job?.status === "SUCCEEDED"
        ? job.completedAt
        : receipt.state === "DISPATCHED" ||
            receipt.state === "WAITING" ||
            receipt.state === "FAILED" ||
            receipt.state === "NO_NEW_EVIDENCE"
          ? null
          : receipt.recordedAt,
    nextCheckAt: null,
    progress:
      job?.progress.totalSessions &&
      job.progress.completedSessions !== undefined
        ? {
            completed: Math.min(
              job.progress.completedSessions,
              job.progress.totalSessions,
            ),
            total: job.progress.totalSessions,
            unit: "sessions",
          }
        : null,
    reasonCodes: job?.error
      ? [job.errorCategory ?? "RESEARCH_JOB_FAILED", ...receipt.reasonCodes]
      : receipt.reasonCodes,
    nextAction: receipt.reasonCodes.includes("DATASET_DERIVATION_UNPROVEN")
      ? {
          kind: "USER_REVIEW",
          label:
            "Feature version and source-input provenance must be captured before dataset lineage can be verified",
        }
      : receipt.reasonCodes.includes("DATASET_COVERAGE_SCOPE_MISMATCH")
        ? {
            kind: "USER_REVIEW",
            label:
              "Review the coverage request against the original immutable dataset",
          }
        : nextActionFor(state),
    jobId: receipt.jobId,
    reportId,
  });
}

function stateFor(
  receipt: EvidenceWorkReceipt,
  job: ResearchJob | undefined,
): EvidenceAutomationStage["state"] {
  if (job) {
    if (job.status === "QUEUED") return "QUEUED";
    if (job.status === "RUNNING" || job.status === "CANCELLING")
      return "RUNNING";
    if (job.status === "SUCCEEDED") return "SUCCEEDED";
    if (job.status === "CANCELLED") return "CANCELLED";
    if (job.status === "INTERRUPTED") return "INTERRUPTED";
    if (job.status === "FAILED") return "FAILED";
  }
  return receipt.state === "NO_NEW_EVIDENCE"
    ? "NO_NEW_EVIDENCE"
    : receipt.state === "WAITING"
      ? "WAITING"
      : receipt.state === "FAILED"
        ? "FAILED"
        : "UNKNOWN";
}

function nextActionFor(
  state: EvidenceAutomationStage["state"],
): EvidenceAutomationStage["nextAction"] {
  if (state === "FAILED" || state === "INTERRUPTED" || state === "CANCELLED")
    return { kind: "USER_REVIEW", label: "Review the retained failure" };
  if (state === "UNKNOWN")
    return {
      kind: "USER_REVIEW",
      label: "Review the retained provenance boundary",
    };
  if (state === "SUCCEEDED" || state === "NO_NEW_EVIDENCE")
    return { kind: "NONE", label: "No action required" };
  return { kind: "AUTOMATIC", label: "The worker will check again" };
}

function stagePriority(state: EvidenceAutomationStage["state"]): number {
  if (state === "RUNNING") return 0;
  if (state === "QUEUED") return 1;
  if (["FAILED", "INTERRUPTED", "CANCELLED"].includes(state)) return 2;
  if (["WAITING", "PAUSED"].includes(state)) return 3;
  if (state === "UNKNOWN") return 4;
  return 5;
}
