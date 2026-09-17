import type {
  ResearchJobErrorCategory,
  ResearchJobProgress,
  ResearchJobType,
} from "@tsx-scanner/contracts";
import {
  LeaseLostError,
  type ClaimedResearchJob,
  type ResearchJobRepository,
} from "../research-jobs/research-job-repository.js";

export type { ClaimedResearchJob };

/** Thrown by a handler to signal it stopped because cancellation was requested (observed via
 * {@link JobContext.heartbeat}). Any other thrown error is treated as a failure. */
export class CancelledError extends Error {
  constructor(message = "Cancelled by request") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Coarse, storable classification of why a job failed. Handlers can throw an error carrying an
 * explicit `category` (see {@link CategorizedError}); anything else falls back to UNKNOWN. */
export class CategorizedError extends Error {
  constructor(
    readonly category: ResearchJobErrorCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CategorizedError";
  }
}

export interface JobContext {
  readonly jobId: string;
  /** The claimed lease duration, when supplied by the production worker. */
  readonly leaseMs?: number;
  /** Extends the lease, persists progress, and returns whether cancellation has been requested.
   * Handlers must call this between units of work (e.g. once per Toronto session) and throw
   * {@link CancelledError} when `cancellationRequested` is true -- that is the only place it is
   * safe to stop, since the caller is mid-write nowhere else. */
  heartbeat(progress?: ResearchJobProgress): Promise<{
    cancellationRequested: boolean;
  }>;
}

export interface ResearchJobHandler {
  /** Executes one claimed job and returns the id of the persisted, immutable result row (e.g. the
   * backtest_run/calibration_run/... id) that GET /api/backtests/:id (etc.) already serves. */
  execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }>;
}

export interface ResearchWorkerLogger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export interface ResearchWorkerOptions {
  ownerId: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  reapIntervalMs?: number;
  logger?: ResearchWorkerLogger;
  /** Called after a claimed job reaches a terminal outcome so follow-on work can
   * reconcile immediately (for example, completion-triggered automation drains).
   * Errors are logged and never fail the settled job. */
  onJobSettled?: (job: ClaimedResearchJob) => void | Promise<void>;
}

const noopLogger: ResearchWorkerLogger = { info: () => {}, error: () => {} };

/** Polls research_job for claimable work and dispatches to the handler registered for the job's
 * type. One instance is a "worker process": apps/api/src/worker.ts constructs one against the same
 * Postgres pool the API uses and runs it in a loop; nothing here depends on being in the API
 * process, so it can (and, in docker-compose, does) run as a separate container/process -- an API
 * restart never interrupts a job that is mid-lease with a different worker process. */
export class ResearchWorker {
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly reapIntervalMs: number;
  private readonly logger: ResearchWorkerLogger;
  private readonly onJobSettled:
    ((job: ClaimedResearchJob) => void | Promise<void>) | undefined;
  private stopped = false;
  private loopPromise: Promise<void> | undefined;
  private reapTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly repository: ResearchJobRepository,
    private readonly handlers: Partial<
      Record<ResearchJobType, ResearchJobHandler>
    >,
    options: ResearchWorkerOptions,
  ) {
    this.ownerId = options.ownerId;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.reapIntervalMs = options.reapIntervalMs ?? 30_000;
    this.logger = options.logger ?? noopLogger;
    this.onJobSettled = options.onJobSettled;
  }

  /** Claims and runs at most one job. Returns true if a job was claimed (regardless of outcome),
   * so callers/tests can drive the loop deterministically instead of racing a timer. */
  async runOnce(): Promise<boolean> {
    const jobTypes = Object.keys(this.handlers) as ResearchJobType[];
    if (jobTypes.length === 0) return false;
    const job = await this.repository.claimNext(
      jobTypes,
      this.ownerId,
      this.leaseMs,
    );
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  private async execute(job: ClaimedResearchJob): Promise<void> {
    const handler = this.handlers[job.jobType];
    if (!handler) {
      // Should not happen: claimNext only claims types this worker registered a handler for.
      await this.repository
        .fail(
          job.id,
          job.leaseOwner,
          `No handler registered for ${job.jobType}`,
          "UNKNOWN",
        )
        .catch(() => {});
      await this.settle(job);
      return;
    }
    const context: JobContext = {
      jobId: job.id,
      leaseMs: this.leaseMs,
      heartbeat: (progress) =>
        this.repository.heartbeat(
          job.id,
          job.leaseOwner,
          this.leaseMs,
          progress,
        ),
    };
    this.logger.info({
      event: "RESEARCH_JOB_STARTED",
      jobId: job.id,
      jobType: job.jobType,
    });
    try {
      if (job.cancellationRequested) throw new CancelledError();
      const { resultRefId } = await handler.execute(job, context);
      await this.repository.complete(job.id, job.leaseOwner, resultRefId);
      this.logger.info({
        event: "RESEARCH_JOB_SUCCEEDED",
        jobId: job.id,
        jobType: job.jobType,
      });
      await this.settle(job);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.logger.error({ event: "RESEARCH_JOB_LEASE_LOST", jobId: job.id });
        return;
      }
      if (error instanceof CancelledError) {
        await this.repository
          .markCancelled(job.id, job.leaseOwner)
          .catch(() => {});
        this.logger.info({
          event: "RESEARCH_JOB_CANCELLED",
          jobId: job.id,
          jobType: job.jobType,
        });
        await this.settle(job);
        return;
      }
      const category =
        error instanceof CategorizedError ? error.category : "UNKNOWN";
      const message = error instanceof Error ? error.message : String(error);
      await this.repository
        .fail(job.id, job.leaseOwner, message, category)
        .catch(() => {});
      this.logger.error({
        event: "RESEARCH_JOB_FAILED",
        jobId: job.id,
        jobType: job.jobType,
        category,
        error: message,
      });
      await this.settle(job);
    }
  }

  /** Runs the optional settle hook without letting it fail the settled job. */
  private async settle(job: ClaimedResearchJob): Promise<void> {
    if (!this.onJobSettled) return;
    try {
      await this.onJobSettled(job);
    } catch (error) {
      this.logger.error({
        event: "RESEARCH_JOB_SETTLE_HOOK_FAILED",
        jobId: job.id,
        jobType: job.jobType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Starts the poll loop and the periodic expired-lease sweep. Resolves once {@link stop} lets
   * the current iteration finish. */
  start(): void {
    if (this.loopPromise !== undefined) return;
    this.stopped = false;
    this.reapTimer = setInterval(() => {
      void this.repository.reapExpiredLeases().then((result) => {
        if (result.requeued || result.interrupted)
          this.logger.info({ event: "RESEARCH_JOB_LEASES_REAPED", ...result });
      });
    }, this.reapIntervalMs);
    this.reapTimer.unref?.();
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let claimed = false;
      try {
        claimed = await this.runOnce();
      } catch (error) {
        this.logger.error({
          event: "RESEARCH_WORKER_POLL_FAILED",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!claimed && !this.stopped) await sleep(this.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reapTimer) clearInterval(this.reapTimer);
    await this.loopPromise;
    this.loopPromise = undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
