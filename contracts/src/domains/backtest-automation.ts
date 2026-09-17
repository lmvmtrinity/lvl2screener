import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import { researchJobStatusSchema } from "./events-jobs.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sessionDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Why an automation cycle or work item was triggered. The trigger origin is
 * recorded next to the work identity, never folded into it: profile saves,
 * scheduled catch-up, explicit refreshes and explicit experiment reruns all
 * converge on the same computation when their inputs match.
 */
export const backtestAutomationTriggerOriginSchema = z.enum([
  "PROFILE_SAVE",
  "SCHEDULED_CATCH_UP",
  "REFRESH_NOW",
  "EXPLICIT_EXPERIMENT",
  /** A settled durable job re-triggers reconciliation and capacity drain so
   * waiting work does not idle until the next scheduled cycle. */
  "JOB_COMPLETION",
]);
export type BacktestAutomationTriggerOrigin = z.infer<
  typeof backtestAutomationTriggerOriginSchema
>;

/**
 * How much of the configured captured range a routine replay covers. Full range
 * is the v1 policy so results stay comparable; an incremental mode would be a
 * new versioned value and must not silently change evaluation semantics.
 */
export const backtestAutomationRangePolicySchema = z.enum([
  "FULL_CAPTURED_RANGE",
]);
export type BacktestAutomationRangePolicy = z.infer<
  typeof backtestAutomationRangePolicySchema
>;

export const backtestAutomationWorkStateSchema = z.enum([
  "WAITING",
  "BLOCKED",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "RETRY_SCHEDULED",
  "FAILED",
  "CANCELLED",
]);
export type BacktestAutomationWorkState = z.infer<
  typeof backtestAutomationWorkStateSchema
>;

/**
 * Why routine work cannot currently be dispatched. Permanent blockers reopen
 * only when the input fingerprint changes; capacity is transient and reopens on
 * the next cycle. `NO_REPLAY_CANDIDATES` means the captured range resolves no
 * candidate-bearing session, so a replay would evaluate nothing; it stays
 * waiting until membership or captured history changes.
 */
export const backtestAutomationBlockerReasonSchema = z.enum([
  "NO_CAPTURED_HISTORY",
  "HISTORY_RANGE_UNAVAILABLE",
  "POLICY_VIOLATION",
  "CAPACITY_LIMIT",
  "NO_REPLAY_CANDIDATES",
]);
export type BacktestAutomationBlockerReason = z.infer<
  typeof backtestAutomationBlockerReasonSchema
>;

/**
 * Computation identity for one routine replay. It is stable across duplicate
 * triggers and independent of the trigger origin; the input fingerprint is
 * tracked separately so newly completed sessions and late-arriving data reopen
 * the same work item instead of creating a new one.
 */
export const backtestAutomationWorkIdentitySchema = z
  .object({
    kind: z.literal("PROFILE_QUALIFICATION"),
    marketId: marketIdSchema,
    configId: z.string().uuid(),
    configVersion: z.string().trim().min(1).max(120),
    strategyKey: z.string().trim().min(1).max(60),
    executionModelVersion: z.string().trim().min(1).max(120),
    rangePolicy: backtestAutomationRangePolicySchema,
  })
  .strict();
export type BacktestAutomationWorkIdentity = z.infer<
  typeof backtestAutomationWorkIdentitySchema
>;

/**
 * Live session progress reported by the running durable job's heartbeat. Counts
 * are null when the job has not reported measurable sessions yet; the status
 * surface must not invent a completion percentage without them, but may still
 * show the current stage message.
 */
export const backtestAutomationJobProgressSchema = z
  .object({
    totalSessions: z.number().int().positive().nullable(),
    completedSessions: z.number().int().nonnegative().nullable(),
    message: z.string().nullable(),
  })
  .strict();
export type BacktestAutomationJobProgress = z.infer<
  typeof backtestAutomationJobProgressSchema
>;

export const backtestAutomationWorkSchema = z
  .object({
    workKey: sha256Schema,
    marketId: marketIdSchema,
    kind: z.literal("PROFILE_QUALIFICATION"),
    configId: z.string().uuid(),
    /** Display-only label resolved at read time; null when the config is gone. */
    configName: z.string().nullable(),
    configVersion: z.string(),
    strategyKey: z.string(),
    state: backtestAutomationWorkStateSchema,
    triggerOrigin: backtestAutomationTriggerOriginSchema,
    blockerReason: backtestAutomationBlockerReasonSchema.nullable(),
    inputFingerprint: sha256Schema,
    consumedFingerprint: sha256Schema.nullable(),
    attemptKey: sha256Schema,
    jobId: z.string().uuid().nullable(),
    jobStatus: researchJobStatusSchema.nullable(),
    runId: z.string().uuid().nullable(),
    /** Market-local session through which the last successful baseline replay
     * evaluated. Result time and runtime describe computation; this describes
     * evidence coverage and may lag newly captured sessions. */
    evaluatedThrough: sessionDateSchema.nullable(),
    retryCount: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime().nullable(),
    lastDispatchedAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    lastFailureAt: z.string().datetime().nullable(),
    /** When this item entered WAITING/RETRY, preserved across re-evaluations. */
    waitingSince: z.string().datetime().nullable().default(null),
    /** Durable job start, so the surface can show real elapsed time while it runs. */
    startedAt: z.string().datetime().nullable().default(null),
    /** Last heartbeat or progress write from the durable job. Relative to
     * `asOf`, this is the "last progress received" a human can trust. */
    heartbeatAt: z.string().datetime().nullable().default(null),
    /** Measurable session progress while the job is in flight; null otherwise. */
    progress: backtestAutomationJobProgressSchema.nullable().default(null),
    /** Runtime of the latest successful attempt, when it is not older than the
     * latest dispatch. Null while a newer attempt is pending. */
    runDurationMs: z.number().int().nonnegative().nullable(),
    failureMessage: z.string().nullable(),
    /** True when the current input fingerprint differs from the consumed one. */
    inputChanged: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type BacktestAutomationWork = z.infer<
  typeof backtestAutomationWorkSchema
>;

export const backtestAutomationCycleOutcomeSchema = z.enum([
  "CHANGED",
  "NO_CHANGES",
  "BLOCKED",
  "DISABLED",
  "FAILED",
]);
export type BacktestAutomationCycleOutcome = z.infer<
  typeof backtestAutomationCycleOutcomeSchema
>;

export const backtestAutomationCycleSchema = z
  .object({
    cycleId: z.string().uuid(),
    marketId: marketIdSchema,
    triggerOrigin: backtestAutomationTriggerOriginSchema,
    outcome: backtestAutomationCycleOutcomeSchema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    evaluated: z.number().int().nonnegative(),
    dispatched: z.number().int().nonnegative(),
    coalesced: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    retried: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Human-readable cycle changes, newest evidence for the status surface. */
    changes: z.array(z.string()),
  })
  .strict();
export type BacktestAutomationCycle = z.infer<
  typeof backtestAutomationCycleSchema
>;

/**
 * Follow-on stage evaluated for a completed baseline. Stages never launch
 * training or studies: qualification-owned and authorization-required stages are
 * visible as waiting/not-eligible states, and only an approved bounded policy
 * can make a funded replay dispatchable.
 */
export const backtestAutomationStageKeySchema = z.enum([
  "COVERAGE",
  "CALIBRATION",
  "TRAINING",
  "STRATEGY_STUDY",
  "FUNDED_REPLAY",
]);
export type BacktestAutomationStageKey = z.infer<
  typeof backtestAutomationStageKeySchema
>;

export const backtestAutomationStageStateSchema = z.enum([
  "WAITING_FOR_EVIDENCE",
  "NOT_ELIGIBLE",
  "RETRY_SCHEDULED",
  "QUEUED",
  "RUNNING",
  "FAILED",
  "COMPLETED",
  "SKIPPED",
]);
export type BacktestAutomationStageState = z.infer<
  typeof backtestAutomationStageStateSchema
>;

export const backtestAutomationAuthorizationScopeSchema = z.enum([
  "AUTOMATIC",
  "QUALIFICATION_OWNED",
  "AUTHORIZATION_REQUIRED",
  "POLICY_REQUIRED",
]);
export type BacktestAutomationAuthorizationScope = z.infer<
  typeof backtestAutomationAuthorizationScopeSchema
>;

export const backtestAutomationStageSchema = z
  .object({
    stageKey: backtestAutomationStageKeySchema,
    workKey: sha256Schema,
    marketId: marketIdSchema,
    configId: z.string().uuid(),
    /** Display-only label resolved at read time; null when the config is gone. */
    configName: z.string().nullable(),
    state: backtestAutomationStageStateSchema,
    authorizationScope: backtestAutomationAuthorizationScopeSchema,
    reasonCodes: z.array(z.string().trim().min(1).max(120)),
    inputIdentityHash: sha256Schema.nullable(),
    jobId: z.string().uuid().nullable(),
    jobStatus: researchJobStatusSchema.nullable(),
    retryCount: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime().nullable(),
    failureMessage: z.string().nullable(),
    lastEvaluatedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type BacktestAutomationStage = z.infer<
  typeof backtestAutomationStageSchema
>;

export const backtestAutomationStatusSchema = z
  .object({
    marketId: marketIdSchema,
    enabled: z.boolean(),
    cadence: z.enum(["DAILY_POST_SESSION"]),
    maxOutstanding: z.number().int().nonnegative(),
    asOf: z.string().datetime(),
    nextCheckAt: z.string().datetime().nullable(),
    /** True when any work item needs a human decision or retries exhausted. */
    interventionRequired: z.boolean(),
    lastCycle: backtestAutomationCycleSchema.nullable(),
    works: z.array(backtestAutomationWorkSchema),
    stages: z.array(backtestAutomationStageSchema),
    /** A4 diagnostics: live queue pressure and recent cycle history. */
    outstandingWork: z.number().int().nonnegative(),
    oldestOutstandingAt: z.string().datetime().nullable(),
    /** Oldest work waiting on capacity or a bounded retry backoff. */
    oldestWaitingAt: z.string().datetime().nullable(),
    /** Most recent successful baseline completion and its runtime. */
    lastSuccessAt: z.string().datetime().nullable(),
    lastSuccessDurationMs: z.number().int().nonnegative().nullable(),
    /** Evidential coverage of that latest result, distinct from its run time. */
    lastSuccessEvaluatedThrough: sessionDateSchema.nullable(),
    retryScheduled: z.number().int().nonnegative(),
    blockerCounts: z.array(
      z
        .object({
          reason: backtestAutomationBlockerReasonSchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    recentCycles: z.array(backtestAutomationCycleSchema),
  })
  .strict();
export type BacktestAutomationStatus = z.infer<
  typeof backtestAutomationStatusSchema
>;

/**
 * A3: explicit, bounded approval for automatic simulated funded replay. A policy
 * names one experiment scope and freezes the account identity; without an
 * active policy the funded stage is not eligible and no account write occurs.
 */
export const fundedHistoricalAutomationScopeSchema = z
  .object({
    kind: z.literal("PROFILE_CONFIG"),
    configId: z.string().uuid(),
    configVersion: z.string().trim().min(1).max(120),
  })
  .strict();
export type FundedHistoricalAutomationScope = z.infer<
  typeof fundedHistoricalAutomationScopeSchema
>;

export const fundedHistoricalAutomationPolicySchema = z
  .object({
    policyId: z.string().uuid(),
    policyHash: sha256Schema,
    marketId: marketIdSchema,
    scope: fundedHistoricalAutomationScopeSchema,
    maxSessions: z.number().int().positive().max(60),
    approvedBy: z.string().trim().min(2).max(120),
    approvalNote: z.string().trim().min(4).max(400),
    approvedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    revokedBy: z.string().trim().min(1).max(120).nullable(),
    revokedReason: z.string().trim().min(1).max(400).nullable(),
  })
  .strict();
export type FundedHistoricalAutomationPolicy = z.infer<
  typeof fundedHistoricalAutomationPolicySchema
>;

export const createFundedHistoricalAutomationPolicySchema = z
  .object({
    marketId: marketIdSchema,
    scope: fundedHistoricalAutomationScopeSchema,
    maxSessions: z.number().int().positive().max(60),
    approvedBy: z.string().trim().min(2).max(120),
    approvalNote: z.string().trim().min(4).max(400),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type CreateFundedHistoricalAutomationPolicy = z.infer<
  typeof createFundedHistoricalAutomationPolicySchema
>;

export const revokeFundedHistoricalAutomationPolicySchema = z
  .object({
    revokedBy: z.string().trim().min(2).max(120),
    reason: z.string().trim().min(4).max(400),
  })
  .strict();
export type RevokeFundedHistoricalAutomationPolicy = z.infer<
  typeof revokeFundedHistoricalAutomationPolicySchema
>;

export const fundedHistoricalAutomationPolicyListSchema = z
  .object({ policies: z.array(fundedHistoricalAutomationPolicySchema) })
  .strict();
export type FundedHistoricalAutomationPolicyList = z.infer<
  typeof fundedHistoricalAutomationPolicyListSchema
>;

export const fundedHistoricalReplayJobPayloadSchema = z
  .object({
    version: z.literal("funded-historical-replay-v1"),
    policyId: z.string().uuid(),
    policyHash: sha256Schema,
    backtestRunId: z.string().uuid(),
  })
  .strict();
export type FundedHistoricalReplayJobPayload = z.infer<
  typeof fundedHistoricalReplayJobPayloadSchema
>;
