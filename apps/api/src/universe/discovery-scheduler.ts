import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  discoveryPolicyForMarket,
  discoveryPerformanceSchema,
  discoveryReasonSchema,
  discoveryStatusSchema,
  type DiscoveryEvaluationInput,
  type DiscoveryEvaluationResult,
  type DiscoveryReason,
  type DiscoveryRun,
  type DiscoveryPerformance,
  type DiscoveryPerformancePhases,
  type DiscoveryRequestUsage,
  type DiscoveryStatus,
  type MarketId,
} from "@tsx-scanner/contracts";
import type {
  CatalogClient,
  CatalogMember,
  CatalogSnapshotStore,
} from "./eodhd-catalog.js";
import type {
  DiscoveryScheduledRunRecovery,
  PostgresDiscoveryEvidenceStore,
} from "./discovery-evidence-repository.js";
import type {
  DiscoveryControlStore,
  DiscoveryLease,
} from "./discovery-control-repository.js";
import type { FastFunnelAccelerator } from "./fast-funnel-accelerator.js";
import type { TradingViewShadowComparator } from "./tradingview-shadow-comparator.js";
import {
  DiscoveryAttemptDiagnosticsCollector,
  type DiscoveryAttemptDiagnosticsDraft,
} from "./discovery-attempt-diagnostics.js";

export interface DiscoveryInputContext {
  /** Opaque observation context only; never part of a run/evidence identity. */
  attemptId?: string;
  diagnostics?: DiscoveryAttemptDiagnosticsCollector;
  marketId: MarketId;
  tradingDate: string;
  evaluationAt: string;
  completedBarEnd: string;
  /** False while inputs are being collected; true only for a frozen run boundary. */
  evaluationAtFrozen?: boolean;
  /** The fixed run-wide input collection deadline and cancellation signal. */
  deadlineAt?: Date;
  signal?: AbortSignal;
}

export interface DiscoveryInputPreparation {
  input: DiscoveryEvaluationInput | null;
  reasons: DiscoveryReason[];
  symbolId: number | null;
}

export interface DiscoveryInputSource {
  build(
    member: CatalogMember,
    context: DiscoveryInputContext,
  ): Promise<DiscoveryInputPreparation>;
}

export interface DiscoveryEvaluationEngine {
  evaluateDiscovery(
    input: DiscoveryEvaluationInput,
  ): Promise<DiscoveryEvaluationResult>;
}

export interface DiscoverySchedulerLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export interface DiscoveryBrokerMetrics {
  readonly requestCounts: {
    readonly queued: number;
    readonly active: number;
    readonly remainingHour?: number | null;
    readonly remainingDiscoveryHour?: number | null;
    readonly discoveryCompleted?: number;
    readonly discoveryFailed?: number;
    readonly discoveryCancelled?: number;
    readonly discoveryExpired?: number;
  };
}

export interface DiscoverySchedulerOptions {
  marketId: MarketId;
  catalogClient: CatalogClient | null;
  catalogStore: CatalogSnapshotStore;
  controlStore: DiscoveryControlStore;
  evidenceStore: PostgresDiscoveryEvidenceStore;
  inputSource: DiscoveryInputSource;
  engine: DiscoveryEvaluationEngine;
  session: {
    getSnapshot(): {
      marketStatus: string;
      startTime: Date;
      endTime: Date;
    };
  };
  brokerMetrics?: DiscoveryBrokerMetrics;
  clock?: () => Date;
  ownerToken?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  workerConcurrency?: number;
  /** Runtime commissioning gate. WP5 ships the path but production remains OFF/SHADOW. */
  intakeEnabled?: boolean;
  logger?: DiscoverySchedulerLogger;
  fastFunnelAccelerator?: FastFunnelAccelerator;
  shadowComparator?: TradingViewShadowComparator;
}

const FIVE_MINUTES_MS = 5 * 60_000;
const PUBLICATION_DELAY_MS = 15_000;
const CATALOG_FRESH_MAX_AGE_MS = 24 * 60 * 60_000;
const CATALOG_LAST_GOOD_MAX_AGE_MS = 96 * 60 * 60_000;
const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_WORKERS = 4;

function memberKey(member: CatalogMember): string {
  return `${member.raw.Exchange}\u0000${member.providerCode}`;
}

function evaluatedKey(value: {
  providerExchange: string;
  providerCode: string;
}): string {
  return `${value.providerExchange}\u0000${value.providerCode}`;
}

function rebindInputEvaluationAt(
  input: DiscoveryEvaluationInput,
  evaluationAt: string,
): DiscoveryEvaluationInput {
  return { ...input, evaluationAt };
}

const SILENT_LOGGER: DiscoverySchedulerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function dateInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function currentTradingDate(marketId: MarketId, startTime: Date): string {
  return dateInTimezone(
    startTime,
    marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
  );
}

function completedBarEnd(
  startTime: Date,
  now: Date,
  requested?: string,
): Date | null {
  if (requested) {
    const value = new Date(requested);
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const elapsed = now.getTime() - startTime.getTime() - PUBLICATION_DELAY_MS;
  const bars = Math.floor(elapsed / FIVE_MINUTES_MS);
  return bars < 1
    ? null
    : new Date(startTime.getTime() + bars * FIVE_MINUTES_MS);
}

function reasonForCatalogMember(member: CatalogMember): DiscoveryReason[] {
  const reasons = member.reasons.map((reason) =>
    reason === "CLASSIFICATION_REVIEW_REQUIRED"
      ? "CLASSIFICATION_REVIEW_REQUIRED"
      : reason,
  );
  return reasons.filter(
    (reason) => discoveryReasonSchema.safeParse(reason).success,
  );
}

function emptyMetrics(): DiscoveryEvaluationResult["metrics"] {
  return {
    price: { value: null, asOf: null },
    marketCap: { value: null, asOf: null },
    averageVolume90d: { value: null, asOf: null },
    averageVolume30d: { value: null, asOf: null },
    atr14: { value: null, asOf: null },
    atrPct: { value: null, asOf: null },
    relativeVolume: { value: null, asOf: null },
    changeFromOpenPct: { value: null, asOf: null },
    dollarVolume30d: { value: null, asOf: null },
  };
}

function failedResult(
  context: DiscoveryInputContext,
  member: CatalogMember,
  symbolId: number | null,
  state: "UNEVALUABLE" | "DEFERRED",
  reasons: DiscoveryReason[],
  now: Date,
): DiscoveryEvaluationResult {
  return {
    marketId: context.marketId,
    policyVersion: discoveryPolicyForMarket(context.marketId).version,
    providerCode: member.providerCode,
    providerExchange: member.raw.Exchange,
    symbolId,
    tradingDate: context.tradingDate,
    evaluationAt: context.evaluationAt,
    computedAt: now.toISOString(),
    completedBarEnd: context.completedBarEnd,
    state,
    reasons: [...new Set(reasons)],
    metrics: emptyMetrics(),
  };
}

function failureForError(
  error: unknown,
  cancelled: boolean,
): { state: "UNEVALUABLE" | "DEFERRED"; reason: DiscoveryReason } {
  if (cancelled) return { state: "DEFERRED", reason: "DISCOVERY_CANCELLED" };
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "EXPIRED")
    return { state: "DEFERRED", reason: "EVALUATION_EXPIRED" };
  if (code === "QUEUE_FULL" || code === "BUDGET_DEFERRED")
    return { state: "DEFERRED", reason: "BUDGET_DEFERRED" };
  return { state: "UNEVALUABLE", reason: "PROVIDER_FAILURE" };
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      await action(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
}

/**
 * WP4 shadow scheduler. It owns no strategy or daily-list state: its only
 * durable effects are discovery inputs/results and run lifecycle rows.
 */
export class DiscoveryScheduler {
  private readonly clock: () => Date;
  private readonly ownerToken: string;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly workerConcurrency: number;
  private readonly logger: DiscoverySchedulerLogger;
  private timer: NodeJS.Timeout | undefined;
  private activeRun?: Promise<DiscoveryRun | null>;
  private abortController?: AbortController;
  private currentLease?: DiscoveryLease;
  private lastError: string | null = null;
  private activeRunId: string | null = null;
  private nextEvaluation: Date | null = null;
  private queued = 0;
  private queueStartedAt: number | null = null;
  private active = 0;
  private scheduler: DiscoveryStatus["scheduler"] = "IDLE";
  private readonly cycleDurationsMs: number[] = [];
  private readonly queueLatenciesMs: number[] = [];
  private readonly currentAcceleratedCodes = new Set<string>();
  private lastAttemptDiagnostics: DiscoveryAttemptDiagnosticsDraft | null =
    null;

  getLastAttemptDiagnostics(): DiscoveryAttemptDiagnosticsDraft | null {
    return structuredClone(this.lastAttemptDiagnostics);
  }

  private async collectInputBeforeDeadline(
    member: CatalogMember,
    context: DiscoveryInputContext,
    deadline: number,
  ): Promise<DiscoveryInputPreparation> {
    const expired = () =>
      Object.assign(new Error("Discovery collection deadline expired"), {
        code: "EXPIRED",
      });
    const remaining = deadline - this.clock().getTime();
    if (remaining <= 0) throw expired();
    const controller = new AbortController();
    const parentSignal = this.abortController?.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopTiming = context.diagnostics?.startStage("INPUT_COLLECTION");
    try {
      const result = await Promise.race([
        this.options.inputSource.build(member, {
          ...context,
          deadlineAt: new Date(deadline),
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = expired();
            controller.abort(error);
            reject(error);
          }, remaining);
          timer.unref?.();
        }),
      ]);
      if (this.clock().getTime() >= deadline) {
        const error = expired();
        controller.abort(error);
        throw error;
      }
      return result;
    } catch (error) {
      // A rejected build may have sibling provider requests still queued. Abort
      // their shared per-member signal so they cannot dispatch after failure.
      if (!controller.signal.aborted) controller.abort(error);
      throw error;
    } finally {
      stopTiming?.();
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  private async prioritizeMembers(
    members: readonly CatalogMember[],
  ): Promise<CatalogMember[]> {
    this.currentAcceleratedCodes.clear();
    if (!this.options.fastFunnelAccelerator?.isEnabled()) {
      return [...members];
    }
    try {
      const topMovers = await this.options.fastFunnelAccelerator.getTopMovers();
      if (topMovers.length > 0) {
        const prioritized =
          this.options.fastFunnelAccelerator.prioritizeCatalogMembers(
            members,
            topMovers,
          );
        const topMoverSet = new Set(topMovers.map((s) => s.toUpperCase()));
        for (const member of members) {
          if (topMoverSet.has(member.providerCode.toUpperCase())) {
            this.currentAcceleratedCodes.add(member.providerCode.toUpperCase());
          }
        }
        this.logger.info({
          event: "FAST_FUNNEL_PRIORITIZED",
          marketId: this.options.marketId,
          topMoverCount: topMovers.length,
          acceleratedCount: this.currentAcceleratedCodes.size,
          catalogSize: members.length,
        });
        return prioritized;
      }
    } catch (error) {
      this.logger.warn({
        event: "FAST_FUNNEL_PRIORITIZATION_FAILED",
        marketId: this.options.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [...members];
  }
  private lastPerformance: DiscoveryPerformance = {
    sampleCount: 0,
    lastCycleDurationMs: null,
    lastQueueLatencyMs: null,
    cycleP95Ms: null,
    queueP95Ms: null,
    requestUsage: {
      completed: 0,
      failed: 0,
      cancelled: 0,
      expired: 0,
    },
    phases: {
      inputCollectionElapsedMs: null,
      evaluationWorkMs: null,
      serializationWorkMs: null,
      persistenceWorkMs: null,
    },
  };

  constructor(private readonly options: DiscoverySchedulerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.ownerToken = options.ownerToken ?? randomUUID();
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.workerConcurrency = options.workerConcurrency ?? DEFAULT_WORKERS;
    this.logger = options.logger ?? SILENT_LOGGER;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 120_000)
      throw new Error("Discovery lease must be at least 120 seconds");
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 250)
      throw new Error("Discovery poll interval must be at least 250ms");
    if (!Number.isInteger(this.workerConcurrency) || this.workerConcurrency < 1)
      throw new Error("Discovery worker concurrency must be positive");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.runScheduled(),
      this.pollIntervalMs,
    );
    this.timer.unref?.();
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abortController?.abort();
    if (this.activeRun) await this.activeRun;
    this.scheduler = "OFF";
  }

  async preview(completedBarEnd?: string): Promise<DiscoveryRun | null> {
    return this.runOnce({ preview: true, completedBarEnd });
  }

  async runOnce(
    request: { preview?: boolean; completedBarEnd?: string } = {},
  ): Promise<DiscoveryRun | null> {
    if (this.activeRun) return this.activeRun;
    const operation = this.execute(request).finally(() => {
      this.activeRun = undefined;
      this.abortController = undefined;
      this.currentLease = undefined;
      this.activeRunId = null;
      this.active = 0;
      this.queued = 0;
      this.queueStartedAt = null;
    });
    this.activeRun = operation;
    return operation;
  }

  private async runScheduled(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error({
        event: "DISCOVERY_SCHEDULED_RUN_FAILED",
        marketId: this.options.marketId,
        error:
          error instanceof Error ? error.message : "Unknown discovery error",
      });
    }
  }

  async getStatus(): Promise<DiscoveryStatus> {
    const mode = await this.options.controlStore.getMode(this.options.marketId);
    const latest =
      (
        await this.options.evidenceStore.listRuns(this.options.marketId, {
          limit: 1,
        })
      )[0] ?? null;
    const snapshot = await this.options.catalogStore.loadLatest(
      this.options.marketId,
    );
    const now = this.clock().getTime();
    const timezone =
      this.options.marketId === "CA_TSX"
        ? "America/Toronto"
        : "America/New_York";
    const snapshotAge = snapshot
      ? Math.max(0, now - Date.parse(snapshot.fetchedAt))
      : null;
    const catalog = snapshot
      ? {
          status:
            snapshotAge !== null &&
            snapshotAge <= CATALOG_FRESH_MAX_AGE_MS &&
            snapshot.tradingDate === dateInTimezone(this.clock(), timezone)
              ? ("FRESH" as const)
              : snapshotAge !== null &&
                  snapshotAge <= CATALOG_LAST_GOOD_MAX_AGE_MS
                ? ("LAST_GOOD" as const)
                : ("UNAVAILABLE" as const),
          source: snapshot.source,
          tradingDate: snapshot.tradingDate,
          fetchedAt: snapshot.fetchedAt,
          ageMs: snapshotAge,
          rowCount: snapshot.rowCount,
          admittedCount: snapshot.admittedCount,
          failure:
            snapshotAge !== null && snapshotAge <= CATALOG_LAST_GOOD_MAX_AGE_MS
              ? null
              : ("CATALOG_UNAVAILABLE" as const),
        }
      : {
          status: this.options.catalogClient
            ? ("UNAVAILABLE" as const)
            : ("UNKNOWN" as const),
          source: null,
          tradingDate: null,
          fetchedAt: null,
          ageMs: null,
          rowCount: null,
          admittedCount: null,
          failure: this.options.catalogClient
            ? ("CATALOG_UNAVAILABLE" as const)
            : null,
        };
    const scheduler =
      mode.mode === "OFF"
        ? "OFF"
        : mode.mode === "AUTO_ADD"
          ? !this.options.intakeEnabled
            ? "DEGRADED"
            : this.options.catalogClient
              ? this.scheduler
              : "MISSING_PROVIDER"
          : this.options.catalogClient
            ? this.scheduler
            : "MISSING_PROVIDER";
    return discoveryStatusSchema.parse({
      marketId: this.options.marketId,
      mode: mode.mode,
      revision: mode.revision,
      modeUpdatedAt: mode.updatedAt,
      modeActor: mode.actor,
      scheduler,
      policy: discoveryPolicyForMarket(this.options.marketId),
      catalog,
      lastRun: latest,
      nextEvaluationAt: this.nextEvaluation?.toISOString() ?? null,
      activeRunId: this.activeRunId,
      queueDepth: this.queued,
      oldestQueueAgeMs:
        this.queued > 0 && this.queueStartedAt !== null
          ? Math.max(0, now - this.queueStartedAt)
          : 0,
      lastError: this.lastError,
      budget: {
        remainingHour:
          this.options.brokerMetrics?.requestCounts.remainingHour ?? null,
        remainingDiscoveryHour:
          this.options.brokerMetrics?.requestCounts.remainingDiscoveryHour ??
          null,
        queued: this.options.brokerMetrics?.requestCounts.queued ?? 0,
        active: this.options.brokerMetrics?.requestCounts.active ?? 0,
      },
      performance: discoveryPerformanceSchema.parse(this.lastPerformance),
      latestAttemptDiagnostics:
        (await this.options.evidenceStore.listLatestDiagnostics?.(
          this.options.marketId,
        )) ?? null,
      fastFunnel: this.options.fastFunnelAccelerator?.getStatus(),
      parity: this.options.shadowComparator
        ? await this.options.shadowComparator.getStatus()
        : undefined,
    });
  }

  private async execute(request: {
    preview?: boolean;
    completedBarEnd?: string;
    lease?: DiscoveryLease;
  }): Promise<DiscoveryRun | null> {
    const mode = await this.options.controlStore.getMode(this.options.marketId);
    if (!request.preview && mode.mode === "OFF") {
      this.scheduler = "OFF";
      return null;
    }
    if (
      !request.preview &&
      mode.mode === "AUTO_ADD" &&
      !this.options.intakeEnabled
    ) {
      this.scheduler = "DEGRADED";
      this.lastError =
        "AUTO_ADD intake is unavailable until commissioning approval";
      return null;
    }
    if (!this.options.catalogClient) {
      this.scheduler = "MISSING_PROVIDER";
      this.lastError = "Discovery catalog provider is not configured";
      return null;
    }
    let market: ReturnType<
      NonNullable<DiscoverySchedulerOptions["session"]>["getSnapshot"]
    >;
    try {
      market = this.options.session.getSnapshot();
    } catch {
      this.scheduler = "DEGRADED";
      this.lastError = "Market session is not initialized";
      return null;
    }
    if (market.marketStatus !== "OPEN") return null;
    const now = this.clock();
    const barEnd = completedBarEnd(
      market.startTime,
      now,
      request.lease?.completedBarEnd ?? request.completedBarEnd,
    );
    if (
      !barEnd ||
      barEnd <= market.startTime ||
      barEnd > market.endTime ||
      barEnd >= now ||
      (barEnd.getTime() - market.startTime.getTime()) % FIVE_MINUTES_MS !== 0
    ) {
      if (request.completedBarEnd) {
        this.scheduler = "DEGRADED";
        this.lastError = "Invalid completed discovery bar boundary";
      }
      return null;
    }
    const tradingDate = currentTradingDate(
      this.options.marketId,
      market.startTime,
    );
    const policy = discoveryPolicyForMarket(this.options.marketId);
    const runMode: "SHADOW" | "AUTO_ADD" =
      request.preview || mode.mode === "OFF" ? "SHADOW" : mode.mode;
    if (
      !request.preview &&
      !request.lease &&
      !request.completedBarEnd &&
      this.options.controlStore.reclaimExpired
    ) {
      const abandoned = await this.options.controlStore.reclaimExpired(
        this.options.marketId,
        tradingDate,
        this.ownerToken,
        this.leaseMs,
      );
      if (abandoned)
        return this.execute({
          ...request,
          completedBarEnd: abandoned.completedBarEnd,
          lease: abandoned,
        });
    }
    const idempotencyKey =
      request.lease?.idempotencyKey ??
      (request.preview
        ? `preview:${randomUUID()}`
        : `scheduled:${this.options.marketId}:${tradingDate}:${barEnd.toISOString()}`);
    const leaseKey = {
      marketId: this.options.marketId,
      tradingDate,
      policyVersion: policy.version,
      completedBarEnd: barEnd.toISOString(),
      idempotencyKey,
    } as const;
    const lease =
      request.lease ??
      (await this.options.controlStore.claim(
        leaseKey,
        this.ownerToken,
        this.leaseMs,
      ));
    if (!lease) return null;
    this.currentLease = lease;
    this.abortController = new AbortController();
    this.scheduler = "RUNNING";
    this.lastError = null;
    this.nextEvaluation = new Date(barEnd.getTime() + FIVE_MINUTES_MS);
    let renewalInFlight: Promise<void> | undefined;
    const runStartedAt = this.clock().getTime();
    // A catalog-sized queue shares one collection budget, rather than giving
    // every next symbol a new two-minute window. Preserve unfinished members
    // as DEFERRED evidence; never reduce the denominator to hide the backlog.
    const collectionDeadline =
      runStartedAt +
      discoveryPolicyForMarket(this.options.marketId).maximumEvaluationAgeMs;
    const attemptId = randomUUID();
    const diagnostics = new DiscoveryAttemptDiagnosticsCollector({
      attemptId,
      attemptKind: lease.runId ? "RECOVERY" : "FRESH",
      marketId: this.options.marketId,
      startedAt: new Date(runStartedAt),
      collectionDeadlineAt: new Date(collectionDeadline),
    });
    const renewalTimer = setInterval(
      () => {
        if (!this.currentLease || renewalInFlight) return;
        renewalInFlight = (async () => {
          if (!request.preview) {
            const currentMode = await this.options.controlStore.getMode(
              this.options.marketId,
            );
            if (currentMode.mode !== runMode) {
              this.abortController?.abort(
                "Discovery mode changed while the run was active",
              );
              this.scheduler = "DEGRADED";
              this.lastError = "Discovery mode changed while run was active";
              return;
            }
          }
          const renewed = await this.options.controlStore.renew(
            this.currentLease!,
            this.leaseMs,
          );
          if (!renewed) {
            this.abortController?.abort(
              "Discovery lease expired or was fenced",
            );
            this.scheduler = "DEGRADED";
            this.lastError = "Discovery lease expired or was fenced";
          } else this.currentLease = renewed;
        })()
          .catch((error) => {
            this.abortController?.abort();
            this.scheduler = "DEGRADED";
            this.lastError = "Discovery lease renewal failed";
            this.logger.error({
              event: "DISCOVERY_LEASE_RENEWAL_FAILED",
              marketId: this.options.marketId,
              error:
                error instanceof Error ? error.message : "Unknown lease error",
            });
          })
          .finally(() => {
            renewalInFlight = undefined;
          });
      },
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    renewalTimer.unref?.();
    let performanceRecorded = false;
    // A lease alone is not proof that the run loaded or begin() completed.
    let diagnosticRunId: string | null = null;
    let completionDiagnostic: DiscoveryAttemptDiagnosticsDraft | undefined;
    const freezeCompletionDiagnostic = () =>
      (completionDiagnostic ??= diagnostics.snapshot());
    const requestUsageAtStart = this.requestUsageSnapshot();
    const phaseTimings = {
      inputCollectionElapsedMs: null as number | null,
      evaluationWorkMs: 0,
      evidencePersistenceWorkMs: 0,
    };
    const writePerformanceAttempt =
      this.options.evidenceStore.beginWritePerformanceAttempt();
    try {
      let catalog: import("./eodhd-catalog.js").CatalogSnapshot;
      let run: DiscoveryRun;
      let recoveredEvaluations = new Set<string>();
      let context: DiscoveryInputContext;
      const collected = new Map<
        string,
        {
          input: DiscoveryEvaluationInput | null;
          reasons: DiscoveryReason[];
          symbolId: number | null;
          error?: unknown;
        }
      >();

      const recoveryStore = this.options
        .evidenceStore as PostgresDiscoveryEvidenceStore & {
        loadScheduledRun?: (
          runId: string,
          marketId: MarketId,
        ) => Promise<DiscoveryScheduledRunRecovery | null>;
        loadScheduledRunByKey?: (input: {
          marketId: MarketId;
          tradingDate: string;
          idempotencyKey: string;
        }) => Promise<DiscoveryScheduledRunRecovery | null>;
      };
      const recovery = lease.runId
        ? await recoveryStore.loadScheduledRun?.(
            lease.runId,
            this.options.marketId,
          )
        : await recoveryStore.loadScheduledRunByKey?.({
            marketId: this.options.marketId,
            tradingDate,
            idempotencyKey,
          });

      let prioritizedCatalog: CatalogMember[] = [];
      const reclaimedRunId = lease.runId;
      if (recovery || reclaimedRunId) {
        diagnostics.markRecovery();
        if (!recovery) {
          if (!reclaimedRunId)
            throw new Error("Reclaimed discovery run identity is missing");
          // A lease pointing at a missing run is expired work, not permission
          // to create a new identity under the same schedule key.
          this.activeRunId = reclaimedRunId;
          this.currentLease = lease;
          const terminated = await diagnostics.measure("EVIDENCE", () =>
            this.options.evidenceStore.completeOwned(
              reclaimedRunId,
              lease,
              "PROVIDER_FAILURE",
            ),
          );
          this.scheduler = "DEGRADED";
          this.lastError = "Reclaimed discovery run could not be loaded";
          return terminated;
        }
        run = recovery.run;
        diagnosticRunId = run.id;
        catalog = recovery.catalog;
        recoveredEvaluations = new Set(recovery.evaluated.map(evaluatedKey));
        context = {
          attemptId,
          diagnostics,
          marketId: run.marketId,
          tradingDate: run.tradingDate,
          evaluationAt: run.evaluationAt,
          completedBarEnd: run.completedBarEnd,
          evaluationAtFrozen: true,
        };
        if (run.status !== "RUNNING") {
          return run;
        }
        this.activeRunId = run.id;
        this.currentLease =
          lease.runId === run.id
            ? lease
            : await this.options.controlStore.bindRun(lease, run.id);
        if (run.mode !== runMode) {
          this.scheduler = "DEGRADED";
          this.lastError = "Reclaimed discovery run mode no longer matches";
          const terminalDiagnostic = freezeCompletionDiagnostic();
          return await diagnostics.measure("EVIDENCE", () =>
            this.options.evidenceStore.completeOwned(
              run.id,
              this.currentLease!,
              "CANCELLED",
              terminalDiagnostic,
            ),
          );
        }
      } else {
        const catalogResult = await this.options.catalogClient.refresh(
          this.options.marketId,
          tradingDate,
        );
        if (!catalogResult.snapshot) {
          this.scheduler = "DEGRADED";
          this.lastError = catalogResult.failure ?? "Catalog unavailable";
          return null;
        }
        catalog = catalogResult.snapshot;
        // Input collection deliberately precedes the frozen evaluationAt. The
        // source retains each observation's real provider/retrieval timestamp;
        // the top-level input boundary is rebound only after all collection is
        // complete, never backdated to make a later observation fit.
        const collectionContext: DiscoveryInputContext = {
          attemptId,
          diagnostics,
          marketId: this.options.marketId,
          tradingDate,
          evaluationAt: this.clock().toISOString(),
          completedBarEnd: barEnd.toISOString(),
          evaluationAtFrozen: false,
        };
        prioritizedCatalog = await this.prioritizeMembers(catalog.members);
        const membersToCollect = prioritizedCatalog;
        this.queued = membersToCollect.length;
        this.queueStartedAt = this.queued > 0 ? this.clock().getTime() : null;
        this.active = Math.min(this.workerConcurrency, this.queued);
        const collectionStartedAt = performance.now();
        await runBounded(
          membersToCollect,
          this.workerConcurrency,
          async (member) => {
            if (this.abortController?.signal.aborted)
              throw new Error("Discovery run cancelled");
            if (!request.preview) {
              const currentMode = await this.options.controlStore.getMode(
                this.options.marketId,
              );
              if (currentMode.mode !== runMode) {
                this.abortController?.abort(
                  "Discovery mode changed while the run was active",
                );
                throw new Error("Discovery mode changed while run was active");
              }
            }
            this.queued = Math.max(0, this.queued - 1);
            const catalogReasons = reasonForCatalogMember(member);
            if (catalogReasons.length > 0) {
              collected.set(memberKey(member), {
                input: null,
                reasons: catalogReasons,
                symbolId: null,
              });
              return;
            }
            try {
              const prepared = await this.collectInputBeforeDeadline(
                member,
                collectionContext,
                collectionDeadline,
              );
              collected.set(memberKey(member), {
                input: prepared.input,
                reasons: prepared.reasons,
                symbolId: prepared.symbolId,
              });
            } catch (error) {
              collected.set(memberKey(member), {
                input: null,
                reasons: [],
                symbolId: null,
                error,
              });
            }
          },
        );
        phaseTimings.inputCollectionElapsedMs = Math.round(
          performance.now() - collectionStartedAt,
        );
        if (this.abortController?.signal.aborted)
          throw new Error("Discovery run cancelled");
        context = {
          ...collectionContext,
          evaluationAt: this.clock().toISOString(),
          evaluationAtFrozen: true,
        };
        run = await diagnostics.measure("EVIDENCE", () =>
          this.options.evidenceStore.begin({
            marketId: context.marketId,
            tradingDate: context.tradingDate,
            evaluationAt: context.evaluationAt,
            completedBarEnd: context.completedBarEnd,
            mode: runMode,
            idempotencyKey,
            catalog,
          }),
        );
        this.activeRunId = run.id;
        diagnosticRunId = run.id;
        this.currentLease = await this.options.controlStore.bindRun(
          lease,
          run.id,
        );
      }
      if (run.status !== "RUNNING") return run;
      if (prioritizedCatalog.length === 0) {
        prioritizedCatalog = await this.prioritizeMembers(catalog.members);
      }
      const pendingMembers = prioritizedCatalog.filter(
        (member) => !recoveredEvaluations.has(memberKey(member)),
      );
      this.queued = pendingMembers.length;
      this.queueStartedAt =
        this.queued > 0
          ? (this.queueStartedAt ?? this.clock().getTime())
          : null;
      this.active = Math.min(this.workerConcurrency, this.queued);
      if (recovery) {
        // Reclaimed work uses the original frozen boundary. Later observations
        // remain visible as future/stale evidence; they are never backdated.
        const collectionStartedAt = performance.now();
        await runBounded(
          pendingMembers,
          this.workerConcurrency,
          async (member) => {
            if (this.abortController?.signal.aborted)
              throw new Error("Discovery run cancelled");
            this.queued = Math.max(0, this.queued - 1);
            const catalogReasons = reasonForCatalogMember(member);
            if (catalogReasons.length > 0) {
              collected.set(memberKey(member), {
                input: null,
                reasons: catalogReasons,
                symbolId: null,
              });
              return;
            }
            try {
              const prepared = await this.collectInputBeforeDeadline(
                member,
                context,
                collectionDeadline,
              );
              collected.set(memberKey(member), {
                input: prepared.input,
                reasons: prepared.reasons,
                symbolId: prepared.symbolId,
              });
            } catch (error) {
              collected.set(memberKey(member), {
                input: null,
                reasons: [],
                symbolId: null,
                error,
              });
            }
          },
        );
        phaseTimings.inputCollectionElapsedMs = Math.round(
          performance.now() - collectionStartedAt,
        );
      }
      let acceleratedEvaluatedCount = 0;
      let acceleratedPassedCount = 0;
      let providerFailureLogs = 0;
      const processMember = async (member: CatalogMember): Promise<void> => {
        this.queued = Math.max(0, this.queued - 1);
        if (this.abortController?.signal.aborted)
          throw new Error("Discovery run cancelled");
        if (!request.preview) {
          const currentMode = await this.options.controlStore.getMode(
            this.options.marketId,
          );
          if (currentMode.mode !== runMode) {
            this.abortController?.abort(
              "Discovery mode changed while the run was active",
            );
            throw new Error("Discovery mode changed while run was active");
          }
        }
        const catalogReasons = reasonForCatalogMember(member);
        const prepared = collected.get(memberKey(member));
        let input: DiscoveryEvaluationInput | null = null;
        let result: DiscoveryEvaluationResult;
        let symbolId: number | null = null;
        if (catalogReasons.length > 0) {
          result = failedResult(
            context,
            member,
            null,
            "UNEVALUABLE",
            catalogReasons,
            this.clock(),
          );
        } else {
          try {
            if (!prepared) throw new Error("Discovery input was not collected");
            if (prepared.error) throw prepared.error;
            input = prepared.input
              ? rebindInputEvaluationAt(prepared.input, context.evaluationAt)
              : null;
            symbolId = prepared.symbolId;
            if (prepared.reasons.length > 0 || !input) {
              result = failedResult(
                context,
                member,
                symbolId,
                "UNEVALUABLE",
                prepared.reasons.length > 0
                  ? prepared.reasons
                  : ["METADATA_UNAVAILABLE"],
                this.clock(),
              );
            } else {
              const evaluationStartedAt = performance.now();
              try {
                result = await diagnostics.measure("EVALUATION", () =>
                  this.options.engine.evaluateDiscovery(input!),
                );
              } finally {
                phaseTimings.evaluationWorkMs +=
                  performance.now() - evaluationStartedAt;
              }
            }
          } catch (error) {
            const failure = failureForError(
              error,
              this.abortController?.signal.aborted ?? false,
            );
            if (providerFailureLogs < 5) {
              providerFailureLogs += 1;
              this.logger.warn({
                event: "DISCOVERY_COLLECTION_FAILED",
                marketId: this.options.marketId,
                providerCode: member.providerCode,
                reason: failure.reason,
                detail:
                  error instanceof Error
                    ? error.message.slice(0, 200)
                    : String(error).slice(0, 200),
              });
            }
            result = failedResult(
              context,
              member,
              symbolId,
              failure.state,
              [failure.reason],
              this.clock(),
            );
          }
        }
        if (
          this.currentAcceleratedCodes.has(member.providerCode.toUpperCase())
        ) {
          if (result.state === "PASS" || result.state === "FAIL") {
            acceleratedEvaluatedCount++;
          }
          if (result.state === "PASS") {
            acceleratedPassedCount++;
          }
        }
        if (this.abortController?.signal.aborted)
          throw new Error("Discovery run cancelled");
        if (!request.preview) {
          const currentMode = await this.options.controlStore.getMode(
            this.options.marketId,
          );
          if (currentMode.mode !== runMode) {
            this.abortController?.abort(
              "Discovery mode changed while the run was active",
            );
            throw new Error("Discovery mode changed while run was active");
          }
        }
        const writeStartedAt = performance.now();
        const stopEvidenceTiming = diagnostics.startStage("EVIDENCE");
        try {
          if (this.currentLease && "recordOwned" in this.options.evidenceStore)
            await this.options.evidenceStore.recordOwned(
              run.id,
              this.currentLease,
              result,
              input,
              writePerformanceAttempt,
            );
          else
            await this.options.evidenceStore.record(
              run.id,
              result,
              input,
              writePerformanceAttempt,
            );
          diagnostics.recordReasons(result.reasons);
          diagnostics.recordQuoteAge(
            input?.quote?.observedAt ?? null,
            context.evaluationAt,
            input?.quote?.priceAt,
          );
        } finally {
          stopEvidenceTiming();
          phaseTimings.evidencePersistenceWorkMs +=
            performance.now() - writeStartedAt;
        }
      };
      await runBounded(pendingMembers, this.workerConcurrency, processMember);
      if (this.options.fastFunnelAccelerator?.isEnabled()) {
        this.options.fastFunnelAccelerator.recordCycleResults({
          acceleratedCount: this.currentAcceleratedCodes.size,
          evaluatedCount: acceleratedEvaluatedCount,
          passedCount: acceleratedPassedCount,
        });
      }
      // Freeze before the atomic completion write; its own latency and later
      // parity work cannot be added to the immutable child after commit.
      const terminalDiagnostic = freezeCompletionDiagnostic();
      const completed = await diagnostics.measure("EVIDENCE", () =>
        this.currentLease && "completeOwned" in this.options.evidenceStore
          ? this.options.evidenceStore.completeOwned(
              run.id,
              this.currentLease,
              null,
              terminalDiagnostic,
            )
          : this.options.evidenceStore.complete(run.id, this.options.marketId),
      );
      this.scheduler = "IDLE";
      this.recordPerformance(
        this.clock().getTime() - runStartedAt,
        this.queueStartedAt === null
          ? null
          : this.clock().getTime() - this.queueStartedAt,
        this.requestUsageDelta(requestUsageAtStart),
        this.performancePhases(phaseTimings, writePerformanceAttempt.take()),
      );
      performanceRecorded = true;
      this.logger.info({
        event: "DISCOVERY_SHADOW_RUN_COMPLETED",
        marketId: this.options.marketId,
        runId: completed.id,
        status: completed.status,
        coverage: completed.coverage,
      });
      // Previews leave no evaluations behind, so auditing one would persist a
      // zero-pass parity artifact and distort overlap reporting.
      if (!request.preview && this.options.shadowComparator) {
        try {
          await this.options.shadowComparator.auditParity(completed.id);
        } catch (comparatorError) {
          this.logger.warn({
            event: "DISCOVERY_PARITY_AUTO_AUDIT_FAILED",
            marketId: this.options.marketId,
            runId: completed.id,
            error:
              comparatorError instanceof Error
                ? comparatorError.message
                : String(comparatorError),
          });
        }
      }
      return completed;
    } catch (error) {
      this.scheduler = "DEGRADED";
      this.lastError =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Discovery run failed";
      if (this.activeRunId && this.currentLease) {
        try {
          const terminalDiagnostic =
            diagnosticRunId === this.activeRunId
              ? freezeCompletionDiagnostic()
              : undefined;
          const completed = await diagnostics.measure("EVIDENCE", () =>
            this.options.evidenceStore.completeOwned(
              this.activeRunId!,
              this.currentLease!,
              this.abortController?.signal.aborted
                ? "CANCELLED"
                : "PROVIDER_FAILURE",
              terminalDiagnostic,
            ),
          );
          if (!performanceRecorded) {
            this.recordPerformance(
              this.clock().getTime() - runStartedAt,
              this.queueStartedAt === null
                ? null
                : this.clock().getTime() - this.queueStartedAt,
              this.requestUsageDelta(requestUsageAtStart),
              this.performancePhases(
                phaseTimings,
                writePerformanceAttempt.take(),
              ),
            );
            performanceRecorded = true;
          }
          return completed;
        } catch (completionError) {
          writePerformanceAttempt.take();
          this.logger.error({
            event: "DISCOVERY_RUN_FINALIZATION_FAILED",
            marketId: this.options.marketId,
            runId: this.activeRunId,
            error:
              completionError instanceof Error
                ? completionError.message
                : "Unknown finalization error",
          });
        }
      }
      return null;
    } finally {
      this.lastAttemptDiagnostics = diagnostics.finish();
      writePerformanceAttempt.take();
      clearInterval(renewalTimer);
      if (this.currentLease)
        await this.options.controlStore.release(this.currentLease);
    }
  }

  private recordPerformance(
    cycleDurationMs: number,
    queueLatencyMs: number | null,
    requestUsage: DiscoveryRequestUsage,
    phases: DiscoveryPerformancePhases,
  ): void {
    appendSample(this.cycleDurationsMs, cycleDurationMs);
    if (queueLatencyMs !== null)
      appendSample(this.queueLatenciesMs, queueLatencyMs);
    this.lastPerformance = {
      sampleCount: this.cycleDurationsMs.length,
      lastCycleDurationMs: cycleDurationMs,
      lastQueueLatencyMs: queueLatencyMs,
      cycleP95Ms: percentile95(this.cycleDurationsMs),
      queueP95Ms: percentile95(this.queueLatenciesMs),
      requestUsage,
      phases,
    };
  }

  private performancePhases(
    timing: {
      inputCollectionElapsedMs: number | null;
      evaluationWorkMs: number;
      evidencePersistenceWorkMs: number;
    },
    persistence: { serializationMs: number; persistenceMs: number } | null,
  ): DiscoveryPerformancePhases {
    return {
      inputCollectionElapsedMs: timing.inputCollectionElapsedMs,
      evaluationWorkMs: Math.round(timing.evaluationWorkMs),
      serializationWorkMs:
        persistence === null ? null : Math.round(persistence.serializationMs),
      persistenceWorkMs:
        persistence === null
          ? Math.round(timing.evidencePersistenceWorkMs)
          : Math.round(persistence.persistenceMs),
    };
  }

  private requestUsageSnapshot(): DiscoveryRequestUsage {
    const counts = this.options.brokerMetrics?.requestCounts;
    return {
      completed: counts?.discoveryCompleted ?? 0,
      failed: counts?.discoveryFailed ?? 0,
      cancelled: counts?.discoveryCancelled ?? 0,
      expired: counts?.discoveryExpired ?? 0,
    };
  }

  private requestUsageDelta(
    start: DiscoveryRequestUsage,
  ): DiscoveryRequestUsage {
    const end = this.requestUsageSnapshot();
    return {
      completed: Math.max(0, end.completed - start.completed),
      failed: Math.max(0, end.failed - start.failed),
      cancelled: Math.max(0, end.cancelled - start.cancelled),
      expired: Math.max(0, end.expired - start.expired),
    };
  }
}

function appendSample(samples: number[], value: number): void {
  samples.push(Math.max(0, Math.round(value)));
  if (samples.length > 100) samples.shift();
}

function percentile95(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const values = [...samples].sort((left, right) => left - right);
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null;
}
