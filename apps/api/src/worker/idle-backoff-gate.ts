import type { MarketId } from "@tsx-scanner/contracts";

/** Bounded polling for jobs whose inputs rarely change between worker ticks. */
export class IdleBackoffGate {
  private readonly idleUntil = new Map<MarketId, number>();
  private readonly failures = new Map<MarketId, number>();
  private readonly active = new Set<MarketId>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly idleMs = 30_000,
    private readonly maxFailureMs = 5 * 60_000,
  ) {}

  async run(marketId: MarketId, action: () => Promise<boolean>): Promise<void> {
    if (
      this.active.has(marketId) ||
      this.now() < (this.idleUntil.get(marketId) ?? 0)
    )
      return;
    this.active.add(marketId);
    try {
      const worked = await action();
      this.failures.delete(marketId);
      if (worked) this.idleUntil.delete(marketId);
      else this.idleUntil.set(marketId, this.now() + this.idleMs);
    } catch (error) {
      const failures = (this.failures.get(marketId) ?? 0) + 1;
      this.failures.set(marketId, failures);
      this.idleUntil.set(
        marketId,
        this.now() +
          Math.min(this.idleMs * 2 ** (failures - 1), this.maxFailureMs),
      );
      throw error;
    } finally {
      this.active.delete(marketId);
    }
  }
}
