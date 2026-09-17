import { performance } from "node:perf_hooks";
import {
  discoveryReasonSchema,
  type DiscoveryReason,
  type MarketId,
} from "@tsx-scanner/contracts";
import type {
  QuestradeRequestObservation,
  QuestradeRequestObserver,
} from "../questrade/request-observation.js";

const STAGES = [
  "INPUT_COLLECTION",
  "MAPPING",
  "ENRICHMENT",
  "DAILY_HISTORY",
  "SLOT_HISTORY",
  "EVALUATION",
  "EVIDENCE",
] as const;
export type DiscoveryDiagnosticStage = (typeof STAGES)[number];
const OPERATIONS = [
  "MAPPING",
  "FUNDAMENTALS",
  "QUOTE",
  "DAILY_HISTORY",
  "SLOT_HISTORY",
] as const;
export interface DiscoveryAttemptIdentity {
  attemptId: string;
  attemptKind: "FRESH" | "RECOVERY";
  marketId: MarketId;
  startedAt: Date;
  collectionDeadlineAt: Date;
}

function stageCounters() {
  return {
    wallMs: 0,
    cumulativeMs: 0,
    calls: 0,
    batches: {
      count: 0,
      minSize: null as number | null,
      maxSize: null as number | null,
      members: 0,
      uniqueSymbols: 0,
    },
    cache: { hit: 0, partialHit: 0, miss: 0 },
    loadedBars: 0,
  };
}
function requestCounters() {
  return {
    queued: 0,
    dispatched: 0,
    settled: 0,
    http401Retries: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    queueFull: 0,
    requestedItems: 0,
    queueWaitMs: 0,
    executionMs: 0,
  };
}
function nonnegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Aggregate-only, attempt-local observations. No request payload or member identity is retained. */
export class DiscoveryAttemptDiagnosticsCollector implements QuestradeRequestObserver {
  private readonly identity: Omit<
    DiscoveryAttemptIdentity,
    "startedAt" | "collectionDeadlineAt"
  > & { startedAt: string; collectionDeadlineAt: string };
  private readonly started: number;
  private ended: number | undefined;
  private readonly stages = Object.fromEntries(
    STAGES.map((stage) => [stage, stageCounters()]),
  ) as Record<DiscoveryDiagnosticStage, ReturnType<typeof stageCounters>>;
  private readonly active = Object.fromEntries(
    STAGES.map((stage) => [stage, { count: 0, started: 0, startSum: 0 }]),
  ) as Record<
    DiscoveryDiagnosticStage,
    { count: number; started: number; startSum: number }
  >;
  private readonly requests = Object.fromEntries(
    OPERATIONS.map((operation) => [operation, requestCounters()]),
  ) as Record<(typeof OPERATIONS)[number], ReturnType<typeof requestCounters>>;
  // Availability/freshness of the final assembled quote, not the cause of a
  // member's result. Early rejections without an assembled input count missing.
  private readonly quoteAgeBuckets = {
    missing: 0,
    future: 0,
    fresh: 0,
    stale: 0,
  };
  private readonly reasonCounts: Partial<Record<DiscoveryReason, number>> = {};

  constructor(
    identity: DiscoveryAttemptIdentity,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    this.identity = {
      attemptId: identity.attemptId,
      attemptKind: identity.attemptKind,
      marketId: identity.marketId,
      startedAt: identity.startedAt.toISOString(),
      collectionDeadlineAt: identity.collectionDeadlineAt.toISOString(),
    };
    this.started = monotonicNow();
  }

  startStage(stage: DiscoveryDiagnosticStage): () => void {
    if (this.ended !== undefined) return () => {};
    const started = this.monotonicNow();
    const active = this.active[stage];
    if (active.count++ === 0) active.started = started;
    active.startSum += started;
    this.stages[stage].calls++;
    let stopped = false;
    return () => {
      if (stopped || this.ended !== undefined) return;
      stopped = true;
      const end = this.monotonicNow();
      this.stages[stage].cumulativeMs += nonnegative(end - started);
      active.startSum -= started;
      if (--active.count === 0)
        this.stages[stage].wallMs += nonnegative(end - active.started);
    };
  }

  markRecovery(): void {
    if (this.ended === undefined) this.identity.attemptKind = "RECOVERY";
  }

  async measure<T>(
    stage: DiscoveryDiagnosticStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    const stop = this.startStage(stage);
    try {
      return await operation();
    } finally {
      stop();
    }
  }

  recordBatch(
    stage: DiscoveryDiagnosticStage,
    batch: { members: number; uniqueSymbols: number },
  ): void {
    if (this.ended !== undefined) return;
    const counter = this.stages[stage].batches;
    const members = nonnegative(batch.members);
    counter.count++;
    counter.minSize = Math.min(counter.minSize ?? members, members);
    counter.maxSize = Math.max(counter.maxSize ?? members, members);
    counter.members += members;
    counter.uniqueSymbols += nonnegative(batch.uniqueSymbols);
  }

  recordCache(
    stage: DiscoveryDiagnosticStage,
    outcome: "HIT" | "PARTIAL_HIT" | "MISS",
  ): void {
    if (this.ended !== undefined) return;
    this.stages[stage].cache[
      outcome === "HIT"
        ? "hit"
        : outcome === "PARTIAL_HIT"
          ? "partialHit"
          : "miss"
    ]++;
  }

  recordLoadedBars(stage: DiscoveryDiagnosticStage, count: number): void {
    if (this.ended === undefined)
      this.stages[stage].loadedBars += nonnegative(count);
  }

  recordQuoteAge(
    observedAt: string | null,
    evaluationAt: string,
    priceAt?: string | null,
  ): void {
    if (this.ended !== undefined) return;
    const age =
      observedAt === null
        ? NaN
        : Date.parse(evaluationAt) - Date.parse(observedAt);
    const priceAge =
      priceAt === undefined
        ? age
        : priceAt === null
          ? NaN
          : Date.parse(evaluationAt) - Date.parse(priceAt);
    const futurePrice =
      priceAt != null &&
      (priceAge < 0 || Date.parse(priceAt) > Date.parse(observedAt!));
    this.quoteAgeBuckets[
      !Number.isFinite(age)
        ? "missing"
        : age < 0 || futurePrice
          ? "future"
          : age <= 30_000 && Number.isFinite(priceAge) && priceAge <= 30_000
            ? "fresh"
            : "stale"
    ]++;
  }

  recordReasons(reasons: readonly DiscoveryReason[]): void {
    if (this.ended !== undefined) return;
    for (const reason of new Set(reasons))
      if (discoveryReasonSchema.safeParse(reason).success)
        this.reasonCounts[reason] = (this.reasonCounts[reason] ?? 0) + 1;
  }

  observe(event: QuestradeRequestObservation): void {
    if (
      this.ended !== undefined ||
      event.attemptId !== this.identity.attemptId ||
      !OPERATIONS.includes(event.operation)
    )
      return;
    const counter = this.requests[event.operation];
    switch (event.phase) {
      case "QUEUED":
        counter.queued++;
        break;
      case "DISPATCHED":
        counter.dispatched++;
        break;
      case "HTTP_401_RETRY":
        counter.http401Retries++;
        break;
      case "SETTLED":
        counter.settled++;
        // Item and duration totals cover settled requests only. Queued and
        // dispatched counters separately expose work still open at termination.
        counter.requestedItems += nonnegative(event.requestedItems);
        counter.queueWaitMs += nonnegative(event.queueWaitMs);
        counter.executionMs += nonnegative(event.executionMs);
        switch (event.outcome) {
          case "COMPLETED":
            counter.completed++;
            break;
          case "FAILED":
            counter.failed++;
            break;
          case "CANCELLED":
            counter.cancelled++;
            break;
          case "EXPIRED":
            counter.expired++;
            break;
          case "QUEUE_FULL":
            counter.queueFull++;
            break;
        }
    }
  }

  snapshot() {
    const now = this.ended ?? this.monotonicNow();
    const stages = structuredClone(this.stages);
    for (const stage of STAGES)
      if (this.active[stage].count > 0) {
        stages[stage].wallMs += nonnegative(now - this.active[stage].started);
        stages[stage].cumulativeMs += nonnegative(
          now * this.active[stage].count - this.active[stage].startSum,
        );
      }
    return {
      ...this.identity,
      wallMs: nonnegative(now - this.started),
      stages,
      requests: structuredClone(this.requests),
      quoteAgeBuckets: { ...this.quoteAgeBuckets },
      reasonCounts: { ...this.reasonCounts },
    };
  }

  finish() {
    this.ended ??= this.monotonicNow();
    return this.snapshot();
  }
}

export type DiscoveryAttemptDiagnosticsDraft = ReturnType<
  DiscoveryAttemptDiagnosticsCollector["snapshot"]
>;
