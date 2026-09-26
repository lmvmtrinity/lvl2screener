import type { MarketId } from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type {
  FundedShadowObserver,
  FundedShadowPassResult,
} from "./funded-shadow-observer.js";
import type { FundedShadowStore } from "./funded-shadow-repository.js";

/**
 * Per-market FP04 worker loop. A session advisory lease prevents two worker
 * processes from observing the same market concurrently; contention and the
 * following recovery are recorded as bounded operational evidence. Committed
 * evidence is never rolled back on lease contention or process restart.
 */

const LEASE_CONTENTION_REPORT_MS = 60_000;

export class FundedShadowObservationWorker {
  private contended = false;
  private lastContentionRecordedAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly store: FundedShadowStore,
    private readonly observer: FundedShadowObserver,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async runOnce(marketId: MarketId): Promise<FundedShadowPassResult | null> {
    const currency = marketId === "CA_TSX" ? "CAD" : "USD";
    const lockKey = `funded-shadow-observer:${marketId}`;
    const client = await this.pool.connect();
    try {
      const locked = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked`,
        [lockKey],
      );
      if (locked.rows[0]?.locked !== true) {
        this.contended = true;
        if (
          this.now() - this.lastContentionRecordedAt >
          LEASE_CONTENTION_REPORT_MS
        ) {
          this.lastContentionRecordedAt = this.now();
          await this.store.recordObserverEvent({
            marketId,
            currency,
            kind: "LEASE_CONTENDED",
            detail: "funded shadow observation lease is held by another worker",
          });
        }
        return null;
      }
      if (this.contended) {
        this.contended = false;
        await this.store.recordObserverEvent({
          marketId,
          currency,
          kind: "LEASE_ACQUIRED",
          detail: "funded shadow observation recovered after lease contention",
        });
      }
      try {
        return await this.observer.runOnce(marketId);
      } finally {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1,0))`,
          [lockKey],
        );
      }
    } finally {
      client.release();
    }
  }
}
