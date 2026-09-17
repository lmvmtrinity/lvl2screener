import { expect, it } from "vitest";
import type {
  ChallengerAttempt,
  StatisticalModelArtifact,
  StatisticalPrediction,
} from "@tsx-scanner/contracts";
import {
  ChallengerObservationWorker,
  type ChallengerPendingWorkStore,
} from "../src/statistical-models/challenger-observation-worker.js";
import type { ChallengerObservationEngine } from "../src/statistical-models/challenger-observer.js";

const artifact: StatisticalModelArtifact = {
  artifactVersion: "1.0.0",
  modelType: "LOGISTIC_SETUP_QUALITY",
  featureNames: ["score", "atrPct", "rvolAtTime", "scoreAtrInteraction"],
  intercept: 0,
  coefficients: [0, 0, 0, 0],
  means: [0, 0, 0, 0],
  scales: [1, 1, 1, 1],
  medians: [0, 0, 0, 0],
  atrMedian: 1,
  rvolMedian: 1,
};

const attempt: ChallengerAttempt = {
  experimentId: "10000000-0000-4000-8000-000000000001",
  observationId: "10000000-0000-4000-8000-000000000002",
  modelVersion: "model-v1",
  inputHash: "a".repeat(64),
  observedAt: "2026-09-10T14:00:00.000Z",
  recordedAt: "2026-09-10T14:00:00.001Z",
  deadlineAt: "2026-09-10T14:00:05.000Z",
};

const input = {
  marketId: "CA_TSX" as const,
  instrumentId: "10000000-0000-4000-8000-000000000003",
  symbol: "BTO.TO",
  timestamp: attempt.observedAt,
  profileId: "10000000-0000-4000-8000-000000000004",
  profileName: "Worker test",
  strategy: "VWAP_RECLAIM" as const,
  deterministicScore: 80,
  atrPct: 2,
  rvolAtTime: 2,
  profileConfigId: "10000000-0000-4000-8000-000000000005",
};

const prediction: StatisticalPrediction = {
  marketId: "CA_TSX",
  instrumentId: input.instrumentId,
  symbol: input.symbol,
  timestamp: input.timestamp,
  profileId: input.profileId,
  profileName: input.profileName,
  strategy: input.strategy,
  deterministicScore: input.deterministicScore,
  setupProbability: 0.6,
  falseBreakoutProbability: 0.2,
  rankingScore: 80,
  regime: { atr: "HIGH", rvol: "HIGH", combined: "HIGH_HIGH" },
  contributions: {},
  warnings: [],
};

it("does not run two observer loops concurrently for one market", async () => {
  let releasePrediction!: (value: StatisticalPrediction) => void;
  const predictionPromise = new Promise<StatisticalPrediction>((resolve) => {
    releasePrediction = resolve;
  });
  let listed = false;
  const store: ChallengerPendingWorkStore = {
    listPendingWork: async () => {
      if (listed) return [];
      listed = true;
      return [{ attempt, input, artifact, marketId: "CA_TSX" }];
    },
    capture: async () => "INSERTED",
    finish: async () => undefined,
    expire: async () => 0,
  };
  const engine: ChallengerObservationEngine = {
    predict: async () => predictionPromise,
  };
  const worker = new ChallengerObservationWorker(
    store,
    engine,
    () => new Date("2026-09-10T14:00:01.000Z"),
  );

  const first = worker.runOnce("CA_TSX");
  await Promise.resolve();
  await expect(worker.runOnce("CA_TSX")).resolves.toEqual({
    processed: 0,
    expired: 0,
  });
  releasePrediction(prediction);
  await expect(first).resolves.toEqual({ processed: 1, expired: 0 });
});
