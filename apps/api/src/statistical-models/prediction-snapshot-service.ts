import {
  featureSnapshotSchema,
  type StatisticalPredictionInput,
} from "@tsx-scanner/contracts";
import type { PaperSignalObservation } from "../paper-bot/paper-bot-repository.js";
import type { StatisticalModelEngine } from "./statistical-model-service.js";
import type { StatisticalModelStore } from "./statistical-model-repository.js";
import type { PredictionSnapshotStore } from "./prediction-snapshot-repository.js";

/** Best-effort observer: it has no return path into paper execution. */
export class StatisticalPredictionSnapshotService {
  constructor(
    private readonly models: StatisticalModelStore,
    private readonly engine: StatisticalModelEngine,
    private readonly snapshots: PredictionSnapshotStore,
  ) {}

  async record(observation: PaperSignalObservation): Promise<void> {
    const features = featureSnapshotSchema.safeParse(
      observation.featureSnapshot,
    );
    if (!features.success) return;
    for (const model of await this.models.listActive()) {
      if (
        model.marketId !== observation.marketId ||
        model.strategy !== observation.strategyKey ||
        !model.artifact
      )
        continue;
      const input: StatisticalPredictionInput = {
        marketId: observation.marketId,
        instrumentId: observation.instrumentId,
        symbol: observation.symbol,
        timestamp: observation.signalTimestamp,
        profileId: observation.profileId,
        profileName: observation.profileName,
        strategy: observation.strategyKey,
        deterministicScore: observation.score,
        atrPct: features.data.atrPct,
        rvolAtTime: features.data.rvolAtTime,
      };
      const batch = await this.engine.predictStatistical({
        artifact: model.artifact,
        inputs: [input],
      });
      const prediction = batch.predictions[0];
      if (!prediction) continue;
      await this.snapshots.insert({
        observationId: observation.id,
        modelId: model.id,
        modelVersion: model.modelVersion,
        strategy: model.strategy,
        input,
        prediction,
      });
    }
  }
}
