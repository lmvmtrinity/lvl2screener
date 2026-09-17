import { describe, expect, it } from "vitest";
import {
  estimateConditionalPayoffs,
  ModelInformedPredictionResolver,
} from "../src/paper-bot/candidate-prediction-resolver.js";
import type { PaperSignalObservation } from "../src/paper-bot/paper-bot-repository.js";
import type { StatisticalModelStore } from "../src/statistical-models/statistical-model-repository.js";
import type { StatisticalModelEngine } from "../src/statistical-models/statistical-model-service.js";
import type { PaperEvidenceTrainingStore } from "../src/statistical-models/paper-evidence-training-repository.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../src/backtests/execution-provenance.js";

describe("estimateConditionalPayoffs", () => {
  it("returns null when no prior rows exist", () => {
    expect(estimateConditionalPayoffs([], [])).toBeNull();
  });

  it("calculates shrunk expected wins and losses correctly", () => {
    const rows = [
      { rMultiple: 2.0 },
      { rMultiple: 1.0 },
      { rMultiple: -1.0 },
      { rMultiple: -1.0 },
    ];
    const payoffs = estimateConditionalPayoffs(rows, rows);
    expect(payoffs).not.toBeNull();
    expect(payoffs?.sampleCount).toBe(4);
    expect(payoffs?.winExpectedR).toBeGreaterThan(0);
    expect(payoffs?.lossExpectedR).toBeLessThan(0);
  });
});

describe("ModelInformedPredictionResolver", () => {
  const dummyObservation: PaperSignalObservation = {
    id: "obs-123",
    runId: "run-123",
    symbol: "SHOP.TO",
    instrumentId: "inst-123",
    strategyKey: "ORB_RETEST",
    strategyVersion: "v1",
    profileId: "prof-123",
    profileName: "Test Profile",
    configVersion: "1",
    signalTimestamp: "2026-09-01T14:00:00.000Z",
    score: 85,
    entryReference: 100,
    stopReference: 95,
    targetReference: 110,
    atr14: 2.5,
    profileConfigId: "cfg-123",
    featureSnapshot: {
      atrPct: 2.5,
      rvolAtTime: 1.8,
    },
    createdAt: "2026-09-01T14:00:00.000Z",
  } as any;

  it("returns fallback reason NO_ACTIVE_MODEL when no active model exists", async () => {
    const mockModelStore: Partial<StatisticalModelStore> = {
      listActive: async () => [],
    };
    const mockEngine: Partial<StatisticalModelEngine> = {
      predictStatistical: async () => ({ predictions: [] }),
    };

    const resolver = new ModelInformedPredictionResolver(
      mockModelStore as StatisticalModelStore,
      mockEngine as StatisticalModelEngine,
    );

    const result = await resolver.resolveCandidatePrediction(
      dummyObservation,
      null,
    );
    expect(result.fallbackReason).toBe("NO_ACTIVE_MODEL");
    expect(result.predictedProbability).toBeUndefined();
  });

  it("predicts probability and estimates expected R with active model and prior history", async () => {
    const mockModelStore: Partial<StatisticalModelStore> = {
      listActive: (async () => [
        {
          id: "mod-456",
          trainingDatasetId: "dataset-456",
          modelVersion: "v1.0.0",
          strategy: "ORB_RETEST",
          artifact: {
            strategy: "ORB_RETEST",
            intercept: 0,
            weights: {},
            featureMeans: {},
            featureStdDevs: {},
            metrics: {
              rocAuc: 0.7,
              brierScore: 0.2,
              logLoss: 0.5,
              positiveRate: 0.5,
              totalSamples: 100,
            },
          },
          active: true,
          activatedAt: "2026-09-01T00:00:00.000Z",
          deactivatedAt: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ]) as any,
    };

    const mockEngine: Partial<StatisticalModelEngine> = {
      predictStatistical: (async () => ({
        predictions: [
          {
            setupProbability: 0.65,
            warnings: [],
          },
        ],
      })) as any,
    };

    const mockEvidenceStore: Partial<PaperEvidenceTrainingStore> = {
      getDataset: (async () => ({
        id: "dataset-456",
        cohort: {
          strategy: "ORB_RETEST",
          strategyVersion: "v1",
          profileConfigId: "cfg-123",
          configVersion: "1",
          executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
          assumptions: { sessionTimezone: "America/Toronto" },
          closedQuoteCount: 0,
          positives: 0,
          negatives: 0,
          firstSignalAt: null,
          lastSignalAt: null,
          missingFeatureCount: 0,
        },
      })) as any,
      rowsFor: (async () => [
        {
          sourceKey: "key-1",
          executionId: "exec-1",
          observationId: "obs-old-1",
          signalTimestamp: "2026-08-30T14:00:00.000Z",
          deterministicScore: 80,
          atrPct: 2.0,
          rvolAtTime: 1.5,
          rMultiple: 2.0,
        },
        {
          sourceKey: "key-2",
          executionId: "exec-2",
          observationId: "obs-old-2",
          signalTimestamp: "2026-08-31T14:00:00.000Z",
          deterministicScore: 75,
          atrPct: 2.1,
          rvolAtTime: 1.4,
          rMultiple: -1.0,
        },
      ]) as any,
      compatibleBaselineRowsFor: (async () => [
        { rMultiple: 2.0 },
        { rMultiple: -1.0 },
      ]) as any,
    };

    const resolver = new ModelInformedPredictionResolver(
      mockModelStore as StatisticalModelStore,
      mockEngine as StatisticalModelEngine,
      mockEvidenceStore as PaperEvidenceTrainingStore,
      { sessionTimezone: "America/Toronto" } as any,
    );

    const result = await resolver.resolveCandidatePrediction(
      dummyObservation,
      null,
    );
    expect(result.fallbackReason).toBeNull();
    expect(result.modelId).toBe("mod-456");
    expect(result.modelVersion).toBe("v1.0.0");
    expect(result.predictedProbability).toBe(0.65);
    expect(result.payloadDigest).toBeDefined();
    expect(result.expectedR).toBeDefined();
    expect(result.payoffDistribution?.sampleCount).toBe(2);
  });

  it("returns fallback reason MODEL_COHORT_MISMATCH when model dataset was trained on legacy execution version", async () => {
    const mockModelStore: Partial<StatisticalModelStore> = {
      listActive: (async () => [
        {
          id: "mod-legacy",
          trainingDatasetId: "dataset-legacy",
          modelVersion: "v0.9.0",
          strategy: "ORB_RETEST",
          artifact: {
            strategy: "ORB_RETEST",
            intercept: 0,
            weights: {},
            featureMeans: {},
            featureStdDevs: {},
            metrics: {
              rocAuc: 0.7,
              brierScore: 0.2,
              logLoss: 0.5,
              positiveRate: 0.5,
              totalSamples: 100,
            },
          },
          active: true,
        },
      ]) as any,
    };

    const mockEvidenceStore: Partial<PaperEvidenceTrainingStore> = {
      getDataset: (async () => ({
        id: "dataset-legacy",
        cohort: {
          strategy: "ORB_RETEST",
          strategyVersion: "v1",
          profileConfigId: "cfg-123",
          configVersion: "1",
          executionModelVersion: "paper-execution-v5", // Legacy cohort!
          assumptions: { sessionTimezone: "America/Toronto" },
        },
      })) as any,
      compatibleBaselineRowsFor: (async () => []) as any,
    };

    const resolver = new ModelInformedPredictionResolver(
      mockModelStore as StatisticalModelStore,
      {} as StatisticalModelEngine,
      mockEvidenceStore as PaperEvidenceTrainingStore,
      { sessionTimezone: "America/Toronto" } as any,
    );

    const result = await resolver.resolveCandidatePrediction(
      dummyObservation,
      null,
    );
    expect(result.fallbackReason).toBe("MODEL_COHORT_MISMATCH");
    expect(result.modelId).toBe("mod-legacy");
    expect(result.predictedProbability).toBeUndefined();
  });
});
