import type {
  MarketId,
  StatisticalPrediction,
  StatisticalModelArtifact,
  StatisticalPredictionInput,
} from "@tsx-scanner/contracts";
import type {
  ChallengerAttemptStore,
  ChallengerPendingWork,
  PostgresChallengerAttemptStore,
} from "./challenger-attempt-repository.js";
import {
  observeBeforeDeadline,
  type ChallengerObservationEngine,
} from "./challenger-observer.js";
import type { StatisticalModelEngine } from "./statistical-model-service.js";

export class ScannerChallengerObservationEngine implements ChallengerObservationEngine {
  constructor(private readonly engine: StatisticalModelEngine) {}

  async predict(
    artifact: StatisticalModelArtifact,
    input: StatisticalPredictionInput,
    signal: AbortSignal,
  ): Promise<StatisticalPrediction> {
    const batch = await this.engine.predictStatistical(
      { artifact, inputs: [input] },
      signal,
    );
    const prediction = batch.predictions[0];
    if (!prediction) throw new Error("PREDICTION_EMPTY");
    return prediction;
  }
}

export interface ChallengerPendingWorkStore extends ChallengerAttemptStore {
  withMarketLease?<T>(
    marketId: MarketId,
    operation: () => Promise<T>,
  ): Promise<T | null>;
  reconcileMissingAttempts?(
    marketId: MarketId,
    limit: number,
  ): Promise<{ terminalized: number; unknown: number }>;
  listPendingWork(
    marketId: MarketId,
    limit?: number,
  ): Promise<ChallengerPendingWork[]>;
}

export class ChallengerObservationWorker {
  private readonly activeMarkets = new Set<MarketId>();

  constructor(
    private readonly attempts: ChallengerPendingWorkStore,
    private readonly engine: ChallengerObservationEngine,
    private readonly now: () => Date = () => new Date(),
    private readonly labels?: {
      reconcileLabelEvidence(limit: number): Promise<number>;
    },
  ) {}

  async runOnce(
    marketId: MarketId,
    limit = 100,
  ): Promise<{
    processed: number;
    expired: number;
  }> {
    if (this.activeMarkets.has(marketId)) return { processed: 0, expired: 0 };
    this.activeMarkets.add(marketId);
    try {
      const process = async () => {
        await this.labels?.reconcileLabelEvidence(limit);
        await this.attempts.reconcileMissingAttempts?.(marketId, limit);
        const work = await this.attempts.listPendingWork(marketId, limit);
        for (const item of work) await this.process(item);
        const expired = await this.attempts.expire(this.now(), limit);
        return { processed: work.length, expired };
      };
      return this.attempts.withMarketLease
        ? ((await this.attempts.withMarketLease(marketId, process)) ?? {
            processed: 0,
            expired: 0,
          })
        : await process();
    } finally {
      this.activeMarkets.delete(marketId);
    }
  }

  private process(item: ChallengerPendingWork): Promise<void> {
    return observeBeforeDeadline(item, this.engine, this.attempts, this.now);
  }
}

export function asChallengerWorkerStore(
  store: PostgresChallengerAttemptStore,
): ChallengerPendingWorkStore {
  return store;
}
