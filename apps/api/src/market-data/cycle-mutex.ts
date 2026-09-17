/** W9: real promise-based mutex, replacing the `cycleInFlight` boolean + `while (flag) await new
 * Promise(setTimeout)` polling pattern QuestradeDataService used to serialize its scan cycle
 * against universe refreshes/candidate intake and to let `stop()` wait for an in-flight cycle to
 * finish. A queued caller now resumes as soon as the mutex is released instead of re-checking a
 * flag on a fixed poll interval, so there is no polling latency and no busy-wait. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private locked = false;

  /** True while a `runExclusive` call is actively running (not merely queued behind one). Used by
   * callers that want to skip an overlapping tick rather than queue behind it — see
   * `QuestradeDataService.runCycle`, which returns immediately if a cycle or a universe refresh
   * already holds the mutex. */
  get isLocked(): boolean {
    return this.locked;
  }

  /** Runs `fn` once every previously queued holder has released the mutex, then holds it exclusively
   * for the duration of `fn`. Calls queue in the order they arrive. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      release();
    }
  }

  /** Resolves once every currently queued `runExclusive` call (including one in flight) has
   * released the mutex. Used by `stop()` to wait out an in-flight cycle without polling. */
  waitForIdle(): Promise<void> {
    return this.tail;
  }
}
