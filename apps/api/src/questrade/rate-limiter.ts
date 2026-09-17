import {
  BROKER_BUDGET,
  MemoryRequestBudget,
  type BudgetDecision,
  type QuestradeRequestBudget,
} from "./request-budget.js";
import type {
  QuestradeRequestObservation,
  QuestradeScheduledRequestObservation,
} from "./request-observation.js";

export type QuestradeRequestPriority = "P0" | "P1" | "P2" | "P3" | "P4";
export interface RequestOptions {
  discovery?: boolean;
  signal?: AbortSignal;
  expiresAt?: Date;
  observation?: QuestradeScheduledRequestObservation;
}
interface QueuedRequest {
  priority: QuestradeRequestPriority;
  sequence: number;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  discovery: boolean;
  enqueuedAt: number;
  expiresAt: number;
  availableAt: number;
  observation?: QuestradeScheduledRequestObservation;
  dispatchedAt?: number;
  removeAbort?: () => void;
}
export interface RateLimitObservation {
  remaining: number;
  resetAt: Date;
}
export interface QuestradeRequestScheduler {
  schedule<T>(
    priority: QuestradeRequestPriority,
    operation: () => Promise<T>,
    options?: RequestOptions,
  ): Promise<T>;
}
export class QuestradeQueueError extends Error {
  constructor(readonly code: "QUEUE_FULL" | "CANCELLED" | "EXPIRED") {
    super(`Questrade request ${code}`);
    this.name = "QuestradeQueueError";
  }
}

/** Single local queue, durable broker-wide grants; auth P0 uses its separate category. */
export class QuestradeRateLimiter implements QuestradeRequestScheduler {
  private readonly queue: QueuedRequest[] = [];
  private readonly budget: QuestradeRequestBudget;
  private active = 0;
  private sequence = 0;
  private blockedUntilMs = 0;
  private wakeTimer: NodeJS.Timeout | undefined;
  private draining = false;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private expired = 0;
  private discoveryCompleted = 0;
  private discoveryFailed = 0;
  private discoveryCancelled = 0;
  private discoveryExpired = 0;
  private throttled = 0;
  private latestBudget: BudgetDecision | null = null;

  constructor(
    private readonly maxConcurrent = 2,
    private readonly reserveRequests = 2,
    private readonly clock: () => Date = () => new Date(),
    budget?: QuestradeRequestBudget,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
      throw new Error("maxConcurrent must be a positive integer");
    this.budget = budget ?? new MemoryRequestBudget(clock);
  }

  schedule<T>(
    priority: QuestradeRequestPriority,
    operation: () => Promise<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) {
      this.observe(options.observation, "SETTLED", {
        outcome: this.signalAbortCode(options.signal),
        queueWaitMs: 0,
      });
      return Promise.reject(
        new QuestradeQueueError(this.signalAbortCode(options.signal)),
      );
    }
    if (
      options.discovery &&
      this.queue.filter((item) => item.discovery).length >=
        BROKER_BUDGET.discoveryQueue
    ) {
      this.observe(options.observation, "SETTLED", {
        outcome: "QUEUE_FULL",
        queueWaitMs: 0,
      });
      return Promise.reject(new QuestradeQueueError("QUEUE_FULL"));
    }
    const now = this.clock().getTime();
    const expiresAt = Math.min(
      options.expiresAt?.getTime() ?? Infinity,
      options.discovery ? now + BROKER_BUDGET.discoveryExpiryMs : Infinity,
    );
    if (Number.isNaN(expiresAt) || expiresAt <= now) {
      this.observe(options.observation, "SETTLED", {
        outcome: "EXPIRED",
        queueWaitMs: 0,
      });
      return Promise.reject(new QuestradeQueueError("EXPIRED"));
    }
    return new Promise<T>((resolve, reject) => {
      const request: QueuedRequest = {
        priority: options.discovery ? "P4" : priority,
        sequence: this.sequence++,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        discovery: options.discovery ?? false,
        enqueuedAt: now,
        expiresAt,
        availableAt: now,
        observation: options.observation,
      };
      if (options.signal) {
        const abort = () => {
          this.rejectQueued(request, this.signalAbortCode(options.signal));
          this.kick();
        };
        options.signal.addEventListener("abort", abort, { once: true });
        request.removeAbort = () =>
          options.signal?.removeEventListener("abort", abort);
      }
      this.queue.push(request);
      this.observe(request.observation, "QUEUED");
      this.queue.sort(
        (a, b) =>
          a.priority.localeCompare(b.priority) || a.sequence - b.sequence,
      );
      this.kick();
    });
  }

  cancelPendingDiscovery(): void {
    for (const request of [...this.queue])
      if (request.discovery) this.rejectQueued(request, "CANCELLED");
    this.kick();
  }

  async observeLimit(observation: RateLimitObservation): Promise<void> {
    if (
      !Number.isFinite(observation.remaining) ||
      !Number.isFinite(observation.resetAt.getTime())
    )
      return;
    if (observation.remaining <= this.reserveRequests) {
      this.blockedUntilMs = Math.max(
        this.blockedUntilMs,
        observation.resetAt.getTime(),
      );
      await this.budget.block(observation.resetAt);
      this.kick();
    }
  }

  async observeHeaders(headers: Headers, status = 200): Promise<void> {
    const remainingValue = headers.get("x-ratelimit-remaining");
    const resetValue = headers.get("x-ratelimit-reset");
    const now = this.clock().getTime();
    let reset = 0;
    if (resetValue) {
      const numeric = Number(resetValue);
      reset = Number.isFinite(numeric)
        ? numeric * (numeric < 10_000_000_000 ? 1000 : 1)
        : Date.parse(resetValue);
    }
    if (status === 429) {
      this.throttled++;
      const retry = headers.get("retry-after");
      const retryAt = retry
        ? Number.isFinite(Number(retry))
          ? now + Number(retry) * 1000
          : Date.parse(retry)
        : 0;
      // Unknown/malformed reset is conservatively the full hourly window.
      const until = Math.max(
        Number.isFinite(reset) ? reset : 0,
        Number.isFinite(retryAt) ? retryAt : 0,
      );
      await this.observeLimit({
        remaining: 0,
        resetAt: new Date(until > now ? until : now + 3_600_000),
      });
    } else if (
      remainingValue !== null &&
      Number.isFinite(Number(remainingValue)) &&
      Number.isFinite(reset) &&
      reset > now
    ) {
      await this.observeLimit({
        remaining: Number(remainingValue),
        resetAt: new Date(reset),
      });
    }
  }

  get queuedCount(): number {
    return this.queue.length;
  }
  get requestCounts() {
    return {
      completed: this.completed,
      failed: this.failed,
      queued: this.queue.length,
      active: this.active,
      cancelled: this.cancelled,
      expired: this.expired,
      throttled: this.throttled,
      discoveryQueued: this.queue.filter((item) => item.discovery).length,
      discoveryCompleted: this.discoveryCompleted,
      discoveryFailed: this.discoveryFailed,
      discoveryCancelled: this.discoveryCancelled,
      discoveryExpired: this.discoveryExpired,
      oldestQueueAgeMs: this.queue.length
        ? Math.max(
            ...this.queue.map(
              (item) => this.clock().getTime() - item.enqueuedAt,
            ),
          )
        : 0,
      remainingHour: this.latestBudget?.remainingHour ?? null,
      remainingDiscoveryHour: this.latestBudget?.remainingDiscoveryHour ?? null,
    };
  }

  private rejectQueued(
    request: QueuedRequest,
    code: "CANCELLED" | "EXPIRED",
  ): void {
    const index = this.queue.indexOf(request);
    if (index < 0) return; // Dispatch already started; cancellation cannot undo a broker call.
    this.queue.splice(index, 1);
    request.removeAbort?.();
    if (code === "CANCELLED") this.cancelled++;
    else this.expired++;
    if (request.discovery) {
      if (code === "CANCELLED") this.discoveryCancelled++;
      else this.discoveryExpired++;
    }
    this.observe(request.observation, "SETTLED", {
      outcome: code,
      queueWaitMs: this.elapsedSince(request.enqueuedAt),
    });
    request.reject(new QuestradeQueueError(code));
  }

  private signalAbortCode(
    signal: AbortSignal | undefined,
  ): "CANCELLED" | "EXPIRED" {
    const reason = signal?.reason;
    return typeof reason === "object" &&
      reason !== null &&
      "code" in reason &&
      reason.code === "EXPIRED"
      ? "EXPIRED"
      : "CANCELLED";
  }

  private kick(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (true) {
        const now = this.clock().getTime();
        for (const item of [...this.queue])
          if (item.expiresAt <= now) this.rejectQueued(item, "EXPIRED");
        if (this.active >= this.maxConcurrent) break;
        const request = this.queue.find(
          (item) =>
            item.availableAt <= now &&
            (item.priority === "P0" || now >= this.blockedUntilMs),
        );
        if (!request) break;
        // P0 is token redemption, outside the market-data category. Never put it
        // behind an hour-long market embargo or lose a rotated token to a metrics write.
        if (request.priority !== "P0") {
          let decision: BudgetDecision;
          try {
            decision = await this.budget.acquire(request.discovery);
          } catch {
            const index = this.queue.indexOf(request);
            if (index >= 0) {
              this.queue.splice(index, 1);
              request.removeAbort?.();
              this.failed++;
              if (request.discovery) this.discoveryFailed++;
              this.observe(request.observation, "SETTLED", {
                outcome: "FAILED",
                queueWaitMs: this.elapsedSince(request.enqueuedAt),
              });
              request.reject(new Error("Questrade request budget unavailable"));
            }
            continue;
          }
          this.latestBudget = decision;
          if (!this.queue.includes(request)) continue; // Cancelled while grant persisted: retain the charge.
          if (!decision.granted) {
            request.availableAt =
              this.clock().getTime() + Math.max(1, decision.retryAfterMs);
            continue;
          }
        }
        if (request.expiresAt <= this.clock().getTime()) {
          this.rejectQueued(request, "EXPIRED");
          continue;
        }
        const index = this.queue.indexOf(request);
        if (index < 0) continue;
        this.queue.splice(index, 1);
        request.removeAbort?.();
        this.active++;
        request.dispatchedAt = this.clock().getTime();
        this.observe(request.observation, "DISPATCHED", {
          queueWaitMs: this.elapsedSince(request.enqueuedAt),
        });
        void Promise.resolve()
          .then(request.operation)
          .then(
            (value) => {
              this.completed++;
              if (request.discovery) this.discoveryCompleted++;
              this.observe(request.observation, "SETTLED", {
                outcome: "COMPLETED",
                queueWaitMs: Math.max(
                  0,
                  request.dispatchedAt! - request.enqueuedAt,
                ),
                executionMs: this.elapsedSince(request.dispatchedAt),
              });
              request.resolve(value);
            },
            (error: unknown) => {
              this.failed++;
              if (request.discovery) this.discoveryFailed++;
              this.observe(request.observation, "SETTLED", {
                outcome: "FAILED",
                queueWaitMs: Math.max(
                  0,
                  request.dispatchedAt! - request.enqueuedAt,
                ),
                executionMs: this.elapsedSince(request.dispatchedAt),
              });
              request.reject(error);
            },
          )
          .finally(() => {
            this.active--;
            this.kick();
          });
      }
    } finally {
      this.draining = false;
      this.scheduleWake();
    }
  }

  private scheduleWake(): void {
    if (this.queue.length === 0) return;
    const now = this.clock().getTime();
    const next = Math.min(
      ...this.queue.map((item) =>
        Math.min(
          item.expiresAt,
          this.active < this.maxConcurrent
            ? Math.max(
                item.availableAt,
                item.priority === "P0" ? 0 : this.blockedUntilMs,
              )
            : Infinity,
        ),
      ),
    );
    if (!Number.isFinite(next)) return;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = undefined;
        this.kick();
      },
      Math.max(1, next - now),
    );
    this.wakeTimer.unref?.();
  }

  private observe(
    observation: QuestradeScheduledRequestObservation | undefined,
    phase: QuestradeRequestObservation["phase"],
    detail: Pick<
      QuestradeRequestObservation,
      "outcome" | "queueWaitMs" | "executionMs"
    > = {},
  ): void {
    if (!observation) return;
    try {
      const result = observation.observer.observe({
        attemptId: observation.attemptId,
        operation: observation.operation,
        requestedItems: observation.requestedItems,
        phase,
        at: this.clock(),
        ...detail,
      });
      void Promise.resolve(result as unknown).catch(() => undefined);
    } catch {
      // Diagnostics must never change broker request semantics.
    }
  }

  private elapsedSince(startedAt: number | undefined): number {
    return startedAt === undefined
      ? 0
      : Math.max(0, this.clock().getTime() - startedAt);
  }
}
