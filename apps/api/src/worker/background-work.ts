export interface BackgroundWorkLogger {
  error(fields: Record<string, unknown>): void;
}

/**
 * Tracks detached background passes so shutdown can stop accepting work and
 * drain in-flight passes before a shared resource (for example the Postgres
 * pool) closes. A settled pass is removed from the set; a failure is logged
 * and never rejects the promise returned by {@link run}, so callers can chain
 * timers safely.
 */
export class BackgroundWorkTracker {
  private readonly inFlight = new Set<Promise<unknown>>();
  private accepting = true;

  constructor(private readonly logger: BackgroundWorkLogger) {}

  get size(): number {
    return this.inFlight.size;
  }

  /** Stops accepting new passes. An already-running pass is unaffected. */
  close(): void {
    this.accepting = false;
  }

  /** Starts one tracked pass. The returned promise resolves once the pass
   * settles, whether it succeeded or failed. */
  run(
    event: string,
    marketId: string | undefined,
    task: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.accepting) {
      this.logger.error({
        event: `${event}_REFUSED`,
        ...(marketId ? { marketId } : {}),
        error: "background work is closed for shutdown",
      });
      return Promise.resolve();
    }
    const promise = task();
    this.inFlight.add(promise);
    const settle = () => {
      this.inFlight.delete(promise);
    };
    promise.then(settle, settle);
    return promise.then(
      () => undefined,
      (error) => {
        this.logger.error({
          event,
          ...(marketId ? { marketId } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  /** Waits until every tracked pass has settled. Safe to call repeatedly. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}
