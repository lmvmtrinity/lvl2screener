const HOUR_MS = 3_600_000;
const MAX_WARMUPS_PER_HOUR = 3;
const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 300_000;

export class ScannerRecoveryPausedError extends Error {
  constructor(
    readonly retryAt: Date,
    reason: string,
    lastFailure?: string,
  ) {
    super(
      `Scanner recovery paused until ${retryAt.toISOString()}: ${reason}${lastFailure ? `. Last failure: ${lastFailure}` : ""}`,
    );
    this.name = "ScannerRecoveryPausedError";
  }
}

/** Per-runtime protection for expensive full history reloads, separate from
 * the durable broker request budget. Successful uploads do not reset failures:
 * the next complete live scan must succeed first. */
export class ScannerRecoveryGuard {
  private warmups: number[] = [];
  private failures = 0;
  private retryAfter = 0;
  private lastFailure?: string;

  pause(now: number): ScannerRecoveryPausedError | undefined {
    this.warmups = this.warmups.filter((started) => started > now - HOUR_MS);
    const hourLimit =
      this.warmups.length >= MAX_WARMUPS_PER_HOUR
        ? this.warmups[0]! + HOUR_MS
        : 0;
    const retryAt = Math.max(this.retryAfter, hourLimit);
    if (retryAt <= now) return undefined;
    return new ScannerRecoveryPausedError(
      new Date(retryAt),
      hourLimit > now
        ? `${MAX_WARMUPS_PER_HOUR} full history reloads attempted in the last hour`
        : `retry backoff after ${this.failures} failed scan/recovery attempt(s)`,
      this.lastFailure,
    );
  }

  assertAvailable(now: number): void {
    const pause = this.pause(now);
    if (pause) throw pause;
  }

  beginWarmup(now: number): void {
    this.assertAvailable(now);
    // Charge before the first request, including attempts that fail partway.
    this.warmups.push(now);
  }

  failed(now: number, error: unknown): void {
    // Polling a paused runtime must not extend its deadline or spend an attempt.
    if (error instanceof ScannerRecoveryPausedError) return;
    this.failures = Math.min(this.failures + 1, 5);
    this.retryAfter =
      now +
      Math.min(
        INITIAL_RETRY_DELAY_MS * 2 ** (this.failures - 1),
        MAX_RETRY_DELAY_MS,
      );
    this.lastFailure = error instanceof Error ? error.message : String(error);
  }

  scanSucceeded(): void {
    this.failures = 0;
    this.retryAfter = 0;
    this.lastFailure = undefined;
    // A successful scan never refunds the rolling-hour warm-up allowance.
  }
}
