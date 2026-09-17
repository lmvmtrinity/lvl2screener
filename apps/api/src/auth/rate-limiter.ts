/** W5: minimal in-memory fixed-window rate limiter for the remote-access profile. No new
 * dependency is pulled in for this -- a single-process, single-operator deployment doesn't need a
 * distributed limiter, just something that keeps a stray script or a leaked session from hammering
 * the API from the open internet. */
export class FixedWindowRateLimiter {
  private readonly hits = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Returns true when `key` is still within its limit for the current window (and records the
   * hit); false once the limit has been exceeded. */
  consume(key: string): boolean {
    const now = this.clock();
    const existing = this.hits.get(key);
    if (!existing || now - existing.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (existing.count >= this.limit) return false;
    existing.count += 1;
    return true;
  }

  /** Bounds memory on a long-running process: drop windows that have already expired. */
  sweep(): void {
    const now = this.clock();
    for (const [key, value] of this.hits) {
      if (now - value.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }

  get trackedKeys(): number {
    return this.hits.size;
  }
}
