import { randomUUID } from "node:crypto";
import {
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  type BacktestAutomationAuthorizationScope,
  type BacktestAutomationBlockerReason,
  type BacktestAutomationCycleOutcome,
  type BacktestAutomationCycle,
  type BacktestAutomationJobProgress,
  type BacktestAutomationStage,
  type BacktestAutomationStageKey,
  type BacktestAutomationStageState,
  type BacktestAutomationStatus,
  type BacktestAutomationTriggerOrigin,
  type BacktestAutomationWork,
  type BacktestAutomationWorkIdentity,
  type BacktestAutomationWorkState,
  type CapturedHistoryAvailability,
  type CreateBacktest,
  type MarketId,
  type ResearchJobErrorCategory,
  type ResearchJobStatus,
  type ResearchJobType,
  type ScannerProfile,
} from "@tsx-scanner/contracts";
import { RESEARCH_JOB_PRIORITY } from "../research-jobs/research-job-repository.js";
import type { ProfileStore } from "../profiles/profile-repository.js";
import { profileQualificationInput } from "./profile-backtest-input.js";
import { contentHash } from "./research-coverage.js";
import {
  replayCandidateCount,
  type ReplayCandidatePlan,
} from "./replay-candidate-plan.js";

/** Mutating store contract for the durable automation registry. The Postgres
 * implementation lives in backtest-automation-repository.ts; tests use an
 * in-memory fake to exercise scheduling semantics deterministically. */
export interface BacktestAutomationStore {
  getControl(
    marketId: MarketId,
  ): Promise<BacktestAutomationControlRecord | undefined>;
  upsertControl(control: BacktestAutomationControlRecord): Promise<void>;
  getWork(workKey: string): Promise<BacktestAutomationWorkRecord | undefined>;
  listWork(marketId: MarketId): Promise<BacktestAutomationWorkRecord[]>;
  saveWork(record: BacktestAutomationWorkRecord): Promise<void>;
  /** Live outstanding automated jobs for the market (QUEUED/RUNNING/CANCELLING
   * durable jobs), used for the per-market completion-aware bound. */
  countLiveWork(marketId: MarketId): Promise<number>;
  jobSnapshots(
    jobIds: readonly string[],
  ): Promise<Map<string, BacktestAutomationJobSnapshot>>;
  /** Market-local session dates (YYYY-MM-DD) for completed replay runs, keyed
   * by run id. Read time only: coverage belongs to the durable run evidence. */
  runEndDates(runIds: readonly string[]): Promise<Map<string, string>>;
  /** Candidate-instrument counts for completed runs, keyed by run id. Used to
   * keep empty replays out of baseline freshness. */
  runCandidateCounts(runIds: readonly string[]): Promise<Map<string, number>>;
  listCycles(
    marketId: MarketId,
    limit: number,
  ): Promise<BacktestAutomationCycleRecord[]>;
  insertCycle(record: BacktestAutomationCycleRecord): Promise<void>;
  getStage(
    stageKey: BacktestAutomationStageKey,
    workKey: string,
  ): Promise<BacktestAutomationStageRecord | undefined>;
  listStages(marketId: MarketId): Promise<BacktestAutomationStageRecord[]>;
  saveStage(record: BacktestAutomationStageRecord): Promise<void>;
  /** Removes derived stage rows when a work item gets a new attempt. */
  clearStages(workKey: string): Promise<void>;
}

export interface BacktestAutomationControlRecord {
  readonly marketId: MarketId;
  readonly enabled: boolean;
  readonly cadence: "DAILY_POST_SESSION";
  readonly maxOutstanding: number;
  readonly updatedAt: string;
}

export interface BacktestAutomationWorkRecord {
  readonly workKey: string;
  readonly marketId: MarketId;
  readonly identity: BacktestAutomationWorkIdentity;
  readonly state: BacktestAutomationWorkState;
  readonly triggerOrigin: BacktestAutomationTriggerOrigin;
  readonly attemptKey: string;
  readonly inputFingerprint: string;
  readonly dispatchedFingerprint: string | null;
  readonly consumedFingerprint: string | null;
  readonly blockerReason: BacktestAutomationBlockerReason | null;
  readonly jobId: string | null;
  readonly runId: string | null;
  readonly retryCount: number;
  readonly nextAttemptAt: string | null;
  readonly failureMessage: string | null;
  readonly lastDispatchedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  /** When this item entered WAITING/RETRY, preserved across re-evaluations. */
  readonly waitingSince: string | null;
  readonly updatedAt: string;
}

export interface BacktestAutomationCycleRecord {
  readonly cycleId: string;
  readonly marketId: MarketId;
  readonly triggerOrigin: BacktestAutomationTriggerOrigin;
  readonly outcome: BacktestAutomationCycleOutcome;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly evaluated: number;
  readonly dispatched: number;
  readonly coalesced: number;
  readonly blocked: number;
  readonly retried: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly changes: readonly string[];
}

export interface BacktestAutomationJobSnapshot {
  readonly id: string;
  readonly status: ResearchJobStatus;
  readonly resultRefId: string | null;
  readonly error: string | null;
  readonly errorCategory: ResearchJobErrorCategory | null;
  readonly completedAt: string | null;
  /** Read-only live fields for the automation surface; older fixtures may omit. */
  readonly startedAt?: string | null;
  readonly heartbeatAt?: string | null;
  readonly progress?: BacktestAutomationJobProgress | null;
}

export interface BacktestAutomationStageRecord {
  readonly stageKey: BacktestAutomationStageKey;
  readonly workKey: string;
  readonly marketId: MarketId;
  readonly state: BacktestAutomationStageState;
  readonly authorizationScope: BacktestAutomationAuthorizationScope;
  readonly inputIdentityHash: string | null;
  readonly reasonCodes: readonly string[];
  readonly jobId: string | null;
  readonly retryCount: number;
  readonly nextAttemptAt: string | null;
  readonly failureMessage: string | null;
  readonly lastEvaluatedAt: string;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

/** One stage's eligibility decision for a completed baseline. Only DISPATCH
 * enqueues work, and every dispatcher owns its own authorization check. */
export type BacktestAutomationStageDecision =
  | {
      readonly kind: "COMPLETED";
      readonly reasonCodes: readonly string[];
      readonly inputIdentityHash: string | null;
    }
  | {
      readonly kind: "SKIPPED" | "WAITING_FOR_EVIDENCE" | "NOT_ELIGIBLE";
      readonly reasonCodes: readonly string[];
      readonly inputIdentityHash: string | null;
    }
  | {
      readonly kind: "DISPATCH";
      readonly reasonCodes: readonly string[];
      readonly inputIdentityHash: string;
      readonly jobType: ResearchJobType;
      readonly payload: unknown;
      readonly idempotencyKey: string;
    };

export interface BacktestAutomationStageDefinition {
  readonly key: BacktestAutomationStageKey;
  readonly authorizationScope: BacktestAutomationAuthorizationScope;
  evaluate(input: {
    readonly work: BacktestAutomationWorkRecord;
    readonly now: Date;
  }): Promise<BacktestAutomationStageDecision>;
}

/** Read-only captured-input access the automation cycle needs. */
export interface BacktestAutomationInputs {
  getCapturedHistoryAvailability(
    marketId: MarketId,
  ): Promise<CapturedHistoryAvailability>;
  /** `now` anchors the regular-session closed gate so intraday capture cannot
   * churn work into re-replaying after a successful completion. `membership` is
   * the frozen candidate-plan digest; it participates in the fingerprint so
   * resolved membership reopens work and unresolved membership stays stable. */
  captureInputFingerprint(
    marketId: MarketId,
    now?: Date,
    membership?: string,
  ): Promise<string>;
  /** Frozen candidate selection for one replay range. Its digest participates
   * in input freshness, so resolving missing membership reopens affected work
   * and repeated unresolved membership stays a stable waiting state. */
  resolveReplayCandidatePlan(
    input: Pick<
      CreateBacktest,
      "marketId" | "startDate" | "endDate" | "symbols"
    >,
  ): Promise<ReplayCandidatePlan>;
}

/** Durable job queue as the automation sees it (idempotency key is required). */
export interface BacktestAutomationDispatcher {
  createJob(
    type: ResearchJobType,
    payload: unknown,
    idempotencyKey: string,
    priority?: number,
  ): Promise<{ id: string }>;
}

export interface BacktestAutomationRetryPolicy {
  /** Additional work-level attempts after a terminal job failure. */
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export const DEFAULT_BACKTEST_AUTOMATION_RETRY: BacktestAutomationRetryPolicy =
  {
    maxRetries: 2,
    baseBackoffMs: 15 * 60_000,
    maxBackoffMs: 6 * 60 * 60_000,
  };

const RETRYABLE_JOB_CATEGORIES: ReadonlySet<ResearchJobErrorCategory> = new Set(
  ["UPSTREAM_ENGINE", "LEASE_EXPIRED", "UNKNOWN"],
);

export interface BacktestAutomationOptions {
  readonly store: BacktestAutomationStore;
  readonly inputs: BacktestAutomationInputs;
  readonly profiles: Pick<ProfileStore, "listProfiles">;
  readonly jobs: BacktestAutomationDispatcher;
  readonly clock?: () => Date;
  readonly retry?: BacktestAutomationRetryPolicy;
  /** A2 follow-on catalog. Only workers pass definitions; API reads persisted
   * stage state without evaluating anything. */
  readonly stageDefinitions?: readonly BacktestAutomationStageDefinition[];
  readonly logger?: {
    info(fields: Record<string, unknown>): void;
    error(fields: Record<string, unknown>): void;
  };
}

export interface BacktestAutomationEvaluationOptions {
  readonly force?: boolean;
  /** Explicit experiment reruns get a distinct attempt identity. */
  readonly experimentAttemptId?: string;
}

export type BacktestAutomationEvaluation =
  | { kind: "SKIPPED"; reason: string }
  | { kind: "UNCHANGED"; workKey: string }
  | { kind: "COALESCED"; workKey: string; jobId: string | null }
  | {
      kind: "WAITING";
      workKey: string;
      reason: BacktestAutomationBlockerReason;
    }
  | {
      kind: "BLOCKED";
      workKey: string;
      reason: BacktestAutomationBlockerReason;
    }
  | {
      kind: "RETRY_SCHEDULED";
      workKey: string;
      nextAttemptAt: string | null;
    }
  | { kind: "DISPATCHED"; workKey: string; jobId: string; attemptKey: string };

/**
 * A1 automation engine. One canonical work key per immutable profile
 * configuration; trigger origin and input fingerprint are tracked separately so
 * equivalent triggers coalesce, newly captured sessions or late-arriving rows
 * reopen the same work item, and explicit refresh/experiment triggers can force
 * a new attempt with its own identity. It only enqueues existing BACKTEST jobs.
 */
export class BacktestAutomationService {
  private readonly clock: () => Date;
  private readonly retry: BacktestAutomationRetryPolicy;

  constructor(private readonly options: BacktestAutomationOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.retry = options.retry ?? DEFAULT_BACKTEST_AUTOMATION_RETRY;
  }

  /** Computation identity, stable for the immutable profile configuration. */
  static workIdentityFor(
    profile: ScannerProfile,
  ): BacktestAutomationWorkIdentity {
    return {
      kind: "PROFILE_QUALIFICATION",
      marketId: profile.marketId,
      configId: profile.configId,
      configVersion: profile.configVersion,
      strategyKey: profile.strategyKey,
      executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      rangePolicy: "FULL_CAPTURED_RANGE",
    };
  }

  static workKeyFor(identity: BacktestAutomationWorkIdentity): string {
    return contentHash(identity);
  }

  /** Profile-save and explicit triggers: register intent and dispatch if due. */
  async triggerProfile(
    profile: ScannerProfile,
    origin: BacktestAutomationTriggerOrigin,
    options: BacktestAutomationEvaluationOptions = {},
  ): Promise<BacktestAutomationEvaluation> {
    return this.evaluateProfile(profile, origin, options);
  }

  /**
   * One completion-aware cycle: reconcile durable job outcomes, then evaluate
   * every SETUP profile for the market. Scheduled cycles respect the persisted
   * enabled flag (routine automation stays opt-in); explicit triggers do not.
   */
  async runCycle(
    marketId: MarketId,
    origin: BacktestAutomationTriggerOrigin,
    options: { force?: boolean; limit?: number } = {},
  ): Promise<BacktestAutomationCycle> {
    const now = this.clock();
    const startedAt = now.toISOString();
    const control = await this.controlFor(marketId);
    const changes: string[] = [];
    const counts = {
      evaluated: 0,
      dispatched: 0,
      coalesced: 0,
      blocked: 0,
      retried: 0,
      succeeded: 0,
      failed: 0,
    };
    if (origin === "SCHEDULED_CATCH_UP" && !control.enabled) {
      const receipt: BacktestAutomationCycleRecord = {
        cycleId: randomUUID(),
        marketId,
        triggerOrigin: origin,
        outcome: "DISABLED",
        startedAt,
        finishedAt: this.clock().toISOString(),
        ...counts,
        changes: ["Scheduled automation is disabled for this market."],
      };
      await this.options.store.insertCycle(receipt);
      return this.cycleContract(receipt);
    }

    // Reconcile terminal job outcomes before deciding what is due.
    const reconciled = await this.reconcileMarket(marketId, now);
    counts.succeeded += reconciled.succeeded;
    counts.failed += reconciled.failed;
    counts.retried += reconciled.retried;
    changes.push(...reconciled.changes);

    // Completion drains still reconcile and materialize stage state when
    // scheduled automation is off, but they never dispatch new routine work.
    if (origin === "JOB_COMPLETION" && !control.enabled) {
      const disabledStageChanges = await this.evaluateStages(marketId, now, {
        allowDispatch: false,
      });
      changes.push(...disabledStageChanges);
      const disabledReceipt: BacktestAutomationCycleRecord = {
        cycleId: randomUUID(),
        marketId,
        triggerOrigin: origin,
        outcome: "DISABLED",
        startedAt,
        finishedAt: this.clock().toISOString(),
        ...counts,
        changes: changes.slice(0, 100),
      };
      await this.options.store.insertCycle(disabledReceipt);
      return this.cycleContract(disabledReceipt);
    }

    const profiles = (await this.options.profiles.listProfiles()).filter(
      (profile) =>
        profile.marketId === marketId && profile.analysisKind === "SETUP",
    );
    const bounded = options.limit ? profiles.slice(0, options.limit) : profiles;
    for (const profile of bounded) {
      counts.evaluated += 1;
      const result = await this.evaluateProfile(profile, origin, options);
      switch (result.kind) {
        case "DISPATCHED":
          counts.dispatched += 1;
          changes.push(
            `${profile.name}: dispatched ${result.attemptKey.slice(0, 12)}`,
          );
          break;
        case "COALESCED":
          counts.coalesced += 1;
          break;
        case "WAITING":
          counts.blocked += 1;
          changes.push(`${profile.name}: waiting (${result.reason})`);
          break;
        case "BLOCKED":
          counts.blocked += 1;
          changes.push(`${profile.name}: blocked (${result.reason})`);
          break;
        case "RETRY_SCHEDULED":
          counts.retried += 1;
          changes.push(
            `${profile.name}: retry scheduled for ${result.nextAttemptAt ?? "unknown"}`,
          );
          break;
        default:
          break;
      }
    }

    // A2: evaluate prerequisite-driven stages for completed baselines. A stage
    // failure or wait never changes the parent work state.
    const stageChanges = await this.evaluateStages(marketId, now, {
      allowDispatch: true,
    });
    changes.push(...stageChanges);

    const outcome: BacktestAutomationCycleOutcome = counts.dispatched
      ? "CHANGED"
      : counts.blocked
        ? "BLOCKED"
        : "NO_CHANGES";
    const receipt: BacktestAutomationCycleRecord = {
      cycleId: randomUUID(),
      marketId,
      triggerOrigin: origin,
      outcome,
      startedAt,
      finishedAt: this.clock().toISOString(),
      ...counts,
      changes: changes.slice(0, 100),
    };
    await this.options.store.insertCycle(receipt);
    this.options.logger?.info({
      event: "BACKTEST_AUTOMATION_CYCLE",
      marketId,
      triggerOrigin: origin,
      outcome,
      dispatched: counts.dispatched,
      coalesced: counts.coalesced,
      blocked: counts.blocked,
    });
    return this.cycleContract(receipt);
  }

  /** Explicit user refresh (A1.2 corrected-input escape hatch). */
  async refreshNow(marketId: MarketId): Promise<BacktestAutomationCycle> {
    return this.runCycle(marketId, "REFRESH_NOW", { force: true });
  }

  /**
   * Explicit check for newly due work. Unlike `refreshNow` it never forces an
   * attempt: only work the captured-input watermark, a pending retry or a
   * reopened blocker says is due. It stays explicit, so it is evaluated even
   * when scheduled catch-up is off.
   */
  async checkNow(marketId: MarketId): Promise<BacktestAutomationCycle> {
    return this.runCycle(marketId, "REFRESH_NOW");
  }

  /** Market-scoped read model for the Backtest & Studies automation surface. */
  async status(
    marketId: MarketId,
    options: { nextCheckAt?: string | null } = {},
  ): Promise<BacktestAutomationStatus> {
    const control = await this.controlFor(marketId);
    const works = await this.options.store.listWork(marketId);
    const stages = await this.options.store.listStages(marketId);
    const runEndDates = await this.options.store.runEndDates(
      works.flatMap((work) => (work.runId ? [work.runId] : [])),
    );
    const runCandidateCounts = await this.options.store.runCandidateCounts(
      works.flatMap((work) => (work.runId ? [work.runId] : [])),
    );
    const snapshots = await this.options.store.jobSnapshots([
      ...works.flatMap((work) => (work.jobId ? [work.jobId] : [])),
      ...stages.flatMap((stage) => (stage.jobId ? [stage.jobId] : [])),
    ]);
    const profiles = await this.options.profiles.listProfiles();
    const names = new Map(
      profiles.map((profile) => [profile.configId, profile.name]),
    );
    const worksByKey = new Map(works.map((work) => [work.workKey, work]));
    const cycles = await this.options.store.listCycles(marketId, 10);
    const contractWorks: BacktestAutomationWork[] = works
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100)
      .map((work) => ({
        workKey: work.workKey,
        marketId: work.marketId,
        kind: work.identity.kind,
        configId: work.identity.configId,
        configName: names.get(work.identity.configId) ?? null,
        configVersion: work.identity.configVersion,
        strategyKey: work.identity.strategyKey,
        state: work.state,
        triggerOrigin: work.triggerOrigin,
        blockerReason: work.blockerReason,
        inputFingerprint: work.inputFingerprint,
        consumedFingerprint: work.consumedFingerprint,
        attemptKey: work.attemptKey,
        jobId: work.jobId,
        jobStatus: work.jobId
          ? (snapshots.get(work.jobId)?.status ?? null)
          : null,
        runId: work.runId,
        evaluatedThrough:
          work.runId && (runCandidateCounts.get(work.runId) ?? 0) > 0
            ? (runEndDates.get(work.runId) ?? null)
            : null,
        retryCount: work.retryCount,
        nextAttemptAt: work.nextAttemptAt,
        lastDispatchedAt: work.lastDispatchedAt,
        lastSuccessAt: work.lastSuccessAt,
        lastFailureAt: work.lastFailureAt,
        waitingSince: work.waitingSince,
        startedAt: work.jobId
          ? (snapshots.get(work.jobId)?.startedAt ?? null)
          : null,
        heartbeatAt: work.jobId
          ? (snapshots.get(work.jobId)?.heartbeatAt ?? null)
          : null,
        progress: work.jobId
          ? (snapshots.get(work.jobId)?.progress ?? null)
          : null,
        runDurationMs: this.runDurationMs(work),
        failureMessage: work.failureMessage,
        inputChanged:
          work.consumedFingerprint === null ||
          work.consumedFingerprint !== work.inputFingerprint,
        updatedAt: work.updatedAt,
      }));
    const contractStages: BacktestAutomationStage[] = stages
      .flatMap((stage) => {
        const work = worksByKey.get(stage.workKey);
        if (!work) return [];
        return [
          {
            stageKey: stage.stageKey,
            workKey: stage.workKey,
            marketId: stage.marketId,
            configId: work.identity.configId,
            configName: names.get(work.identity.configId) ?? null,
            state: stage.state,
            authorizationScope: stage.authorizationScope,
            reasonCodes: [...stage.reasonCodes],
            inputIdentityHash: stage.inputIdentityHash,
            jobId: stage.jobId,
            jobStatus: stage.jobId
              ? (snapshots.get(stage.jobId)?.status ?? null)
              : null,
            retryCount: stage.retryCount,
            nextAttemptAt: stage.nextAttemptAt,
            failureMessage: stage.failureMessage,
            lastEvaluatedAt: stage.lastEvaluatedAt,
            completedAt: stage.completedAt,
            updatedAt: stage.updatedAt,
          },
        ];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 200);
    const outstanding = works.filter(
      (work) => work.state === "QUEUED" || work.state === "RUNNING",
    );
    const waiting = works.filter(
      (work) => work.state === "WAITING" || work.state === "RETRY_SCHEDULED",
    );
    const latestSuccess = works
      .filter(
        (work) =>
          work.lastSuccessAt !== null &&
          work.runId !== null &&
          (runCandidateCounts.get(work.runId) ?? 0) > 0,
      )
      .sort(
        (a, b) => Date.parse(b.lastSuccessAt!) - Date.parse(a.lastSuccessAt!),
      )[0];
    const blockerCounts = new Map<BacktestAutomationBlockerReason, number>();
    for (const work of works)
      if (work.blockerReason)
        blockerCounts.set(
          work.blockerReason,
          (blockerCounts.get(work.blockerReason) ?? 0) + 1,
        );
    return {
      marketId,
      enabled: control.enabled,
      cadence: control.cadence,
      maxOutstanding: control.maxOutstanding,
      asOf: this.clock().toISOString(),
      nextCheckAt: control.enabled ? (options.nextCheckAt ?? null) : null,
      interventionRequired:
        works.some(
          (work) =>
            work.state === "FAILED" ||
            (work.state === "BLOCKED" &&
              work.blockerReason === "POLICY_VIOLATION"),
        ) || stages.some((stage) => stage.state === "FAILED"),
      lastCycle: cycles[0] ? this.cycleContract(cycles[0]) : null,
      works: contractWorks,
      stages: contractStages,
      outstandingWork: outstanding.length,
      oldestOutstandingAt:
        outstanding
          .map((work) => work.lastDispatchedAt ?? work.updatedAt)
          .sort()[0] ?? null,
      oldestWaitingAt:
        waiting.map((work) => work.waitingSince ?? work.updatedAt).sort()[0] ??
        null,
      lastSuccessAt: latestSuccess?.lastSuccessAt ?? null,
      lastSuccessDurationMs: latestSuccess
        ? this.runDurationMs(latestSuccess)
        : null,
      lastSuccessEvaluatedThrough: latestSuccess?.runId
        ? (runEndDates.get(latestSuccess.runId) ?? null)
        : null,
      retryScheduled: works.filter((work) => work.state === "RETRY_SCHEDULED")
        .length,
      blockerCounts: [...blockerCounts.entries()].map(([reason, count]) => ({
        reason,
        count,
      })),
      recentCycles: cycles.map((cycle) => this.cycleContract(cycle)),
    };
  }

  /** Runtime of the latest successful attempt when it is not older than the
   * latest dispatch; null while a newer attempt is pending. */
  private runDurationMs(work: BacktestAutomationWorkRecord): number | null {
    if (!work.lastSuccessAt || !work.lastDispatchedAt) return null;
    const success = Date.parse(work.lastSuccessAt);
    const dispatched = Date.parse(work.lastDispatchedAt);
    if (
      !Number.isFinite(success) ||
      !Number.isFinite(dispatched) ||
      success < dispatched
    )
      return null;
    return success - dispatched;
  }

  /** Worker startup sync for the persisted control state. */
  async configureMarket(control: {
    marketId: MarketId;
    enabled: boolean;
    cadence: "DAILY_POST_SESSION";
    maxOutstanding: number;
  }): Promise<void> {
    await this.options.store.upsertControl({
      ...control,
      updatedAt: this.clock().toISOString(),
    });
  }

  private async controlFor(
    marketId: MarketId,
  ): Promise<BacktestAutomationControlRecord> {
    const stored = await this.options.store.getControl(marketId);
    return (
      stored ?? {
        marketId,
        enabled: false,
        cadence: "DAILY_POST_SESSION",
        maxOutstanding: 2,
        updatedAt: this.clock().toISOString(),
      }
    );
  }

  private async reconcileMarket(
    marketId: MarketId,
    now: Date,
  ): Promise<{
    succeeded: number;
    failed: number;
    retried: number;
    changes: string[];
  }> {
    const works = await this.options.store.listWork(marketId);
    const snapshots = await this.options.store.jobSnapshots(
      works.flatMap((work) => (work.jobId ? [work.jobId] : [])),
    );
    const result = {
      succeeded: 0,
      failed: 0,
      retried: 0,
      changes: [] as string[],
    };
    for (const work of works) {
      if (!work.jobId) continue;
      const snapshot = snapshots.get(work.jobId);
      if (!snapshot) continue;
      const applied = this.reconcileWork(work, snapshot, now);
      if (!applied) continue;
      await this.options.store.saveWork(applied);
      if (applied.state === "SUCCEEDED") {
        result.succeeded += 1;
        result.changes.push(
          `${applied.identity.configVersion}: replay completed`,
        );
      } else if (applied.state === "FAILED") {
        result.failed += 1;
        result.changes.push(
          `${applied.identity.configVersion}: failed (${applied.failureMessage ?? "unknown"})`,
        );
      } else if (applied.state === "RETRY_SCHEDULED") {
        result.retried += 1;
      }
    }
    return result;
  }

  /** Maps one durable job snapshot onto the work registry. Returns a new record
   * only when durable state actually changed. */
  private reconcileWork(
    work: BacktestAutomationWorkRecord,
    snapshot: BacktestAutomationJobSnapshot,
    now: Date,
  ): BacktestAutomationWorkRecord | null {
    if (work.state !== "QUEUED" && work.state !== "RUNNING") return null;
    if (snapshot.status === "QUEUED" || snapshot.status === "RUNNING") {
      const next = snapshot.status === "RUNNING" ? "RUNNING" : "QUEUED";
      return work.state === next
        ? null
        : { ...work, state: next, updatedAt: now.toISOString() };
    }
    if (snapshot.status === "CANCELLING") return null;
    if (snapshot.status === "SUCCEEDED") {
      return {
        ...work,
        state: "SUCCEEDED",
        consumedFingerprint:
          work.dispatchedFingerprint ?? work.inputFingerprint,
        runId: snapshot.resultRefId,
        blockerReason: null,
        failureMessage: null,
        nextAttemptAt: null,
        waitingSince: null,
        lastSuccessAt: snapshot.completedAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
    }
    if (snapshot.status === "CANCELLED") {
      return {
        ...work,
        state: "CANCELLED",
        blockerReason: null,
        failureMessage: "Cancelled by request",
        nextAttemptAt: null,
        waitingSince: null,
        updatedAt: now.toISOString(),
      };
    }
    // FAILED or INTERRUPTED: bounded work-level backoff after the durable job
    // exhausted its own attempts.
    const retryable =
      snapshot.status === "INTERRUPTED" ||
      (snapshot.errorCategory !== null &&
        RETRYABLE_JOB_CATEGORIES.has(snapshot.errorCategory));
    const message = snapshot.error ?? "Backtest job failed";
    if (retryable && work.retryCount < this.retry.maxRetries) {
      const backoff = Math.min(
        this.retry.baseBackoffMs * 2 ** work.retryCount,
        this.retry.maxBackoffMs,
      );
      return {
        ...work,
        state: "RETRY_SCHEDULED",
        retryCount: work.retryCount + 1,
        blockerReason: null,
        failureMessage: message,
        nextAttemptAt: new Date(now.getTime() + backoff).toISOString(),
        waitingSince: work.waitingSince ?? now.toISOString(),
        lastFailureAt: snapshot.completedAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
    }
    return {
      ...work,
      state: "FAILED",
      blockerReason: null,
      failureMessage: message,
      nextAttemptAt: null,
      waitingSince: null,
      lastFailureAt: snapshot.completedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  /** A2: evaluate the injected stage catalog for completed baselines. Stage
   * outcomes are recorded on their own durable rows and never mutate the parent
   * work item, so a child failure cannot rewrite or fail the baseline. Dispatch
   * stays gated on the caller's authorization context. */
  private async evaluateStages(
    marketId: MarketId,
    now: Date,
    options: { allowDispatch: boolean },
  ): Promise<string[]> {
    const definitions = this.options.stageDefinitions ?? [];
    if (!definitions.length) return [];
    const works = (await this.options.store.listWork(marketId)).filter(
      (work) => work.state === "SUCCEEDED",
    );
    if (!works.length) return [];
    const changes: string[] = [];
    for (const work of works) {
      const label = work.identity.configVersion;
      for (const definition of definitions) {
        let record = await this.options.store.getStage(
          definition.key,
          work.workKey,
        );
        if (
          record?.state === "COMPLETED" ||
          record?.state === "SKIPPED" ||
          record?.state === "FAILED"
        )
          continue;
        if (
          record?.jobId &&
          (record.state === "QUEUED" || record.state === "RUNNING")
        ) {
          const snapshot = (
            await this.options.store.jobSnapshots([record.jobId])
          ).get(record.jobId);
          if (snapshot) {
            const reconciled = this.reconcileStage(record, snapshot, now);
            if (reconciled) {
              record = reconciled;
              await this.options.store.saveStage(record);
            }
          }
          if (
            record &&
            (record.state === "QUEUED" || record.state === "RUNNING")
          )
            continue;
          if (
            record?.state === "COMPLETED" ||
            record?.state === "SKIPPED" ||
            record?.state === "FAILED"
          )
            continue;
        }
        if (
          record?.state === "RETRY_SCHEDULED" &&
          record.nextAttemptAt !== null &&
          Date.parse(record.nextAttemptAt) > now.getTime()
        )
          continue;

        let decision: BacktestAutomationStageDecision | undefined;
        let failure: string | null = null;
        try {
          decision = await definition.evaluate({ work, now });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        const previousState = record?.state;
        if (!decision) {
          const retryCount = record?.retryCount ?? 0;
          const state: BacktestAutomationStageState =
            retryCount < this.retry.maxRetries ? "RETRY_SCHEDULED" : "FAILED";
          const backoff = Math.min(
            this.retry.baseBackoffMs * 2 ** retryCount,
            this.retry.maxBackoffMs,
          );
          record = {
            stageKey: definition.key,
            workKey: work.workKey,
            marketId,
            state,
            authorizationScope: definition.authorizationScope,
            inputIdentityHash: record?.inputIdentityHash ?? null,
            reasonCodes: ["STAGE_EVALUATION_FAILED"],
            jobId: null,
            retryCount:
              state === "RETRY_SCHEDULED" ? retryCount + 1 : retryCount,
            nextAttemptAt:
              state === "RETRY_SCHEDULED"
                ? new Date(now.getTime() + backoff).toISOString()
                : null,
            failureMessage: failure,
            lastEvaluatedAt: now.toISOString(),
            completedAt: null,
            updatedAt: now.toISOString(),
          };
          await this.options.store.saveStage(record);
          if (state === "FAILED")
            changes.push(
              `${label} ${definition.key}: failed (${failure ?? "unknown"})`,
            );
          continue;
        }
        if (decision.kind === "DISPATCH") {
          if (!options.allowDispatch) {
            record = {
              stageKey: definition.key,
              workKey: work.workKey,
              marketId,
              state: "NOT_ELIGIBLE",
              authorizationScope: definition.authorizationScope,
              inputIdentityHash: decision.inputIdentityHash,
              reasonCodes: ["SCHEDULED_AUTOMATION_DISABLED"],
              jobId: null,
              retryCount: 0,
              nextAttemptAt: null,
              failureMessage: null,
              lastEvaluatedAt: now.toISOString(),
              completedAt: null,
              updatedAt: now.toISOString(),
            };
            await this.options.store.saveStage(record);
            continue;
          }
          const job = await this.options.jobs.createJob(
            decision.jobType,
            decision.payload,
            decision.idempotencyKey,
            RESEARCH_JOB_PRIORITY.SCHEDULED,
          );
          record = {
            stageKey: definition.key,
            workKey: work.workKey,
            marketId,
            state: "QUEUED",
            authorizationScope: definition.authorizationScope,
            inputIdentityHash: decision.inputIdentityHash,
            reasonCodes: [...decision.reasonCodes],
            jobId: job.id,
            retryCount: record?.retryCount ?? 0,
            nextAttemptAt: null,
            failureMessage: null,
            lastEvaluatedAt: now.toISOString(),
            completedAt: null,
            updatedAt: now.toISOString(),
          };
          await this.options.store.saveStage(record);
          changes.push(`${label} ${definition.key}: dispatched`);
          continue;
        }
        const state: BacktestAutomationStageState =
          decision.kind === "COMPLETED" ? "COMPLETED" : decision.kind;
        record = {
          stageKey: definition.key,
          workKey: work.workKey,
          marketId,
          state,
          authorizationScope: definition.authorizationScope,
          inputIdentityHash: decision.inputIdentityHash,
          reasonCodes: [...decision.reasonCodes],
          jobId: null,
          retryCount: 0,
          nextAttemptAt: null,
          failureMessage: null,
          lastEvaluatedAt: now.toISOString(),
          completedAt: state === "COMPLETED" ? now.toISOString() : null,
          updatedAt: now.toISOString(),
        };
        await this.options.store.saveStage(record);
        if (
          previousState !== state &&
          (state === "COMPLETED" || state === "SKIPPED")
        )
          changes.push(`${label} ${definition.key}: ${state.toLowerCase()}`);
      }
    }
    return changes;
  }

  private reconcileStage(
    record: BacktestAutomationStageRecord,
    snapshot: BacktestAutomationJobSnapshot,
    now: Date,
  ): BacktestAutomationStageRecord | null {
    if (record.state !== "QUEUED" && record.state !== "RUNNING") return null;
    if (snapshot.status === "QUEUED" || snapshot.status === "RUNNING") {
      const next = snapshot.status;
      return record.state === next
        ? null
        : { ...record, state: next, updatedAt: now.toISOString() };
    }
    if (snapshot.status === "CANCELLING") return null;
    if (snapshot.status === "SUCCEEDED")
      return {
        ...record,
        state: "COMPLETED",
        completedAt: snapshot.completedAt ?? now.toISOString(),
        failureMessage: null,
        nextAttemptAt: null,
        updatedAt: now.toISOString(),
      };
    if (snapshot.status === "CANCELLED")
      return {
        ...record,
        state: "SKIPPED",
        reasonCodes: ["CANCELLED_BY_REQUEST"],
        failureMessage: null,
        nextAttemptAt: null,
        updatedAt: now.toISOString(),
      };
    const retryable =
      snapshot.status === "INTERRUPTED" ||
      (snapshot.errorCategory !== null &&
        RETRYABLE_JOB_CATEGORIES.has(snapshot.errorCategory));
    const message = snapshot.error ?? "Stage job failed";
    if (retryable && record.retryCount < this.retry.maxRetries) {
      const backoff = Math.min(
        this.retry.baseBackoffMs * 2 ** record.retryCount,
        this.retry.maxBackoffMs,
      );
      return {
        ...record,
        state: "RETRY_SCHEDULED",
        retryCount: record.retryCount + 1,
        failureMessage: message,
        nextAttemptAt: new Date(now.getTime() + backoff).toISOString(),
        updatedAt: now.toISOString(),
      };
    }
    return {
      ...record,
      state: "FAILED",
      failureMessage: message,
      nextAttemptAt: null,
      updatedAt: now.toISOString(),
    };
  }

  private async evaluateProfile(
    profile: ScannerProfile,
    origin: BacktestAutomationTriggerOrigin,
    options: BacktestAutomationEvaluationOptions,
  ): Promise<BacktestAutomationEvaluation> {
    if (profile.analysisKind !== "SETUP")
      return { kind: "SKIPPED", reason: "NOT_A_SETUP_PROFILE" };
    const now = this.clock();
    const identity = BacktestAutomationService.workIdentityFor(profile);
    const workKey = BacktestAutomationService.workKeyFor(identity);
    const availability =
      await this.options.inputs.getCapturedHistoryAvailability(
        profile.marketId,
      );
    const emptyHistory =
      !availability.replay.earliestDate || !availability.replay.latestDate;
    const qualification = emptyHistory
      ? null
      : profileQualificationInput(profile, availability);
    const candidatePlan =
      qualification && !qualification.violation
        ? await this.options.inputs.resolveReplayCandidatePlan(
            qualification.input,
          )
        : null;
    // Membership identity participates in freshness: resolving missing evidence
    // changes the fingerprint and reopens blocked or completed work, while
    // repeated unresolved membership stays on one stable fingerprint.
    const fingerprint = await this.options.inputs.captureInputFingerprint(
      profile.marketId,
      now,
      candidatePlan?.digest,
    );
    const existing = await this.options.store.getWork(workKey);
    let work: BacktestAutomationWorkRecord =
      existing ??
      this.blankWork(profile, identity, workKey, fingerprint, origin, now);

    // Reconcile this item's own job before deciding it is in flight.
    if (work.jobId && (work.state === "QUEUED" || work.state === "RUNNING")) {
      const snapshot = (
        await this.options.store.jobSnapshots([work.jobId])
      ).get(work.jobId);
      if (snapshot) {
        const reconciled = this.reconcileWork(work, snapshot, now);
        if (reconciled) {
          work = reconciled;
          await this.options.store.saveWork(work);
        }
      }
    }

    const inFlight = work.state === "QUEUED" || work.state === "RUNNING";
    if (inFlight) {
      // Coalesce: keep the one durable job, record the newer trigger and
      // fingerprint so a changed input reopens work after completion.
      const coalesced: BacktestAutomationWorkRecord = {
        ...work,
        triggerOrigin: origin,
        inputFingerprint: fingerprint,
        updatedAt: now.toISOString(),
      };
      await this.options.store.saveWork(coalesced);
      return { kind: "COALESCED", workKey, jobId: work.jobId };
    }

    const fingerprintChanged = work.inputFingerprint !== fingerprint;
    const retryPending =
      work.state === "RETRY_SCHEDULED" &&
      work.nextAttemptAt !== null &&
      Date.parse(work.nextAttemptAt) > now.getTime();
    const consumedMismatch = work.consumedFingerprint !== fingerprint;
    const due =
      !retryPending &&
      (options.force === true ||
        origin === "EXPLICIT_EXPERIMENT" ||
        (work.state === "RETRY_SCHEDULED" && work.nextAttemptAt !== null) ||
        (work.state === "BLOCKED" && fingerprintChanged) ||
        (work.state === "FAILED" && fingerprintChanged) ||
        (work.state === "CANCELLED" && fingerprintChanged) ||
        ((work.state === "SUCCEEDED" || work.state === "WAITING") &&
          consumedMismatch));
    if (!due) {
      if (work.state === "BLOCKED" && work.blockerReason)
        return { kind: "BLOCKED", workKey, reason: work.blockerReason };
      if (work.state === "RETRY_SCHEDULED")
        return {
          kind: "RETRY_SCHEDULED",
          workKey,
          nextAttemptAt: work.nextAttemptAt,
        };
      if (work.state === "WAITING" && work.blockerReason)
        return { kind: "WAITING", workKey, reason: work.blockerReason };
      return { kind: "UNCHANGED", workKey };
    }

    // Attempt identity includes the retry counter so a bounded retry after a
    // terminal job failure is a distinct durable job, while duplicate triggers
    // for the same evaluation still converge on one idempotency key. Explicit
    // refresh attempts get a fresh identity; a caller-supplied experiment id is
    // itself the attempt identity and stays idempotent.
    const explicitAttemptId =
      options.experimentAttemptId ??
      (options.force === true ? randomUUID() : null);
    const attemptKey = contentHash({
      workKey,
      fingerprint,
      retryCount: work.retryCount,
      explicitAttemptId,
    });
    if (
      attemptKey === work.attemptKey &&
      (work.state === "SUCCEEDED" ||
        work.state === "FAILED" ||
        work.state === "CANCELLED")
    )
      return { kind: "UNCHANGED", workKey };
    const updatedBase: BacktestAutomationWorkRecord = {
      ...work,
      inputFingerprint: fingerprint,
      attemptKey,
      triggerOrigin: origin,
      updatedAt: now.toISOString(),
    };
    if (emptyHistory) {
      const blocked: BacktestAutomationWorkRecord = {
        ...updatedBase,
        state: "BLOCKED",
        blockerReason: "NO_CAPTURED_HISTORY",
        nextAttemptAt: null,
        waitingSince: null,
        failureMessage: null,
      };
      await this.options.store.saveWork(blocked);
      return { kind: "BLOCKED", workKey, reason: "NO_CAPTURED_HISTORY" };
    }

    const { violation } = qualification!;
    if (violation) {
      const reason: BacktestAutomationBlockerReason =
        violation.code === "HISTORY_UNAVAILABLE"
          ? "HISTORY_RANGE_UNAVAILABLE"
          : "POLICY_VIOLATION";
      const blocked: BacktestAutomationWorkRecord = {
        ...updatedBase,
        state: "BLOCKED",
        blockerReason: reason,
        nextAttemptAt: null,
        waitingSince: null,
        failureMessage: violation.message,
      };
      await this.options.store.saveWork(blocked);
      return { kind: "BLOCKED", workKey, reason };
    }

    // An empty candidate selection means the intended strategy evaluation never
    // happened; a replay would consume scanner work and produce a result that
    // must not count as a baseline. Stay in one stable waiting state until
    // membership evidence or captured history changes.
    if (replayCandidateCount(candidatePlan!) === 0) {
      const waiting: BacktestAutomationWorkRecord = {
        ...updatedBase,
        state: "WAITING",
        blockerReason: "NO_REPLAY_CANDIDATES",
        nextAttemptAt: null,
        waitingSince:
          work.state === "WAITING" || work.state === "RETRY_SCHEDULED"
            ? (work.waitingSince ?? now.toISOString())
            : now.toISOString(),
        failureMessage:
          candidatePlan!.warnings.join(" ").slice(0, 1_000) ||
          "The requested range resolves no candidate-bearing session.",
      };
      await this.options.store.saveWork(waiting);
      return { kind: "WAITING", workKey, reason: "NO_REPLAY_CANDIDATES" };
    }

    const control = await this.controlFor(profile.marketId);
    const live = await this.options.store.countLiveWork(profile.marketId);
    if (live >= control.maxOutstanding) {
      const waiting: BacktestAutomationWorkRecord = {
        ...updatedBase,
        state: "WAITING",
        blockerReason: "CAPACITY_LIMIT",
        nextAttemptAt: null,
        waitingSince:
          work.state === "WAITING" || work.state === "RETRY_SCHEDULED"
            ? (work.waitingSince ?? now.toISOString())
            : now.toISOString(),
      };
      await this.options.store.saveWork(waiting);
      return { kind: "WAITING", workKey, reason: "CAPACITY_LIMIT" };
    }

    const job = await this.options.jobs.createJob(
      "BACKTEST",
      qualification!.input,
      `backtest-automation:${attemptKey}`,
      origin === "SCHEDULED_CATCH_UP"
        ? RESEARCH_JOB_PRIORITY.SCHEDULED
        : RESEARCH_JOB_PRIORITY.REQUESTED,
    );
    // A new attempt invalidates derived stage rows: they must describe the next
    // completed baseline, not the previous run.
    await this.options.store.clearStages(workKey);
    const dispatched: BacktestAutomationWorkRecord = {
      ...updatedBase,
      state: "QUEUED",
      jobId: job.id,
      dispatchedFingerprint: fingerprint,
      blockerReason: null,
      failureMessage: null,
      nextAttemptAt: null,
      waitingSince: null,
      lastDispatchedAt: now.toISOString(),
    };
    await this.options.store.saveWork(dispatched);
    return { kind: "DISPATCHED", workKey, jobId: job.id, attemptKey };
  }

  private blankWork(
    profile: ScannerProfile,
    identity: BacktestAutomationWorkIdentity,
    workKey: string,
    fingerprint: string,
    origin: BacktestAutomationTriggerOrigin,
    now: Date,
  ): BacktestAutomationWorkRecord {
    return {
      workKey,
      marketId: profile.marketId,
      identity,
      state: "WAITING",
      triggerOrigin: origin,
      attemptKey: contentHash({
        workKey,
        fingerprint,
        retryCount: 0,
        explicitAttemptId: null,
      }),
      inputFingerprint: fingerprint,
      dispatchedFingerprint: null,
      consumedFingerprint: null,
      blockerReason: null,
      jobId: null,
      runId: null,
      retryCount: 0,
      nextAttemptAt: null,
      failureMessage: null,
      lastDispatchedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      waitingSince: null,
      updatedAt: now.toISOString(),
    };
  }

  private cycleContract(
    record: BacktestAutomationCycleRecord,
  ): BacktestAutomationCycle {
    return {
      cycleId: record.cycleId,
      marketId: record.marketId,
      triggerOrigin: record.triggerOrigin,
      outcome: record.outcome,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      evaluated: record.evaluated,
      dispatched: record.dispatched,
      coalesced: record.coalesced,
      blocked: record.blocked,
      retried: record.retried,
      succeeded: record.succeeded,
      failed: record.failed,
      changes: [...record.changes],
    };
  }
}
