import { describe, expect, it, vi } from "vitest";
import type { StatisticalTrainingResult } from "@tsx-scanner/contracts";
import { StatisticalModelService } from "../src/statistical-models/statistical-model-service.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../src/backtests/execution-provenance.js";

const datasetId = "10000000-0000-4000-8000-000000000010";
const modelId = "10000000-0000-4000-8000-000000000011";
const dataset = {
  id: datasetId,
  sourceKind: "PAPER_EVIDENCE" as const,
  policyVersion: "paper-evidence-v1",
  cohort: {
    strategy: "ORB_RETEST" as const,
    strategyVersion: "v1",
    profileConfigId: "10000000-0000-4000-8000-000000000012",
    configVersion: "config-v1",
    executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
    assumptions: { positionSize: 100 },
    closedQuoteCount: 2,
    positives: 1,
    negatives: 1,
    firstSignalAt: "2026-08-01T14:00:00.000Z",
    lastSignalAt: "2026-08-02T14:00:00.000Z",
    missingFeatureCount: 0,
  },
  requestedCutoff: "2026-08-03T00:00:00.000Z",
  effectiveCutoff: "2026-08-02T14:00:00.000Z",
  sourceDigest: "evidence-digest",
  sourceRowCount: 2,
  excludedCounts: {},
  researchQualification: {
    policyVersion: "paper-research-qualification-v2",
    qualified: true,
    reasons: [],
    sourceRowCount: 2,
    acceptedRowCount: 2,
    distinctSessionCount: 4,
    chronologicalSplitAt: "2026-08-02T14:00:00.000Z",
    walkForwardWindows: [],
    excludedCounts: {},
    chronologicalTrainSourceKeys: [
      "paper_execution:10000000-0000-4000-8000-000000000099",
    ],
    chronologicalTestSourceKeys: [
      "paper_execution:10000000-0000-4000-8000-000000000100",
    ],
  },
  createdAt: "2026-08-03T00:00:00.000Z",
};
const incomplete: StatisticalTrainingResult = {
  status: "INSUFFICIENT_DATA",
  artifact: null,
  train: null,
  test: null,
  calibration: [],
  eligibleForActivation: false,
  warnings: ["Need more evidence"],
  trainingStart: null,
  trainingEnd: null,
  testStart: null,
  testEnd: null,
};

describe("StatisticalModelService paper evidence", () => {
  it("trains only from a frozen dataset and leaves the challenger inactive", async () => {
    const create = vi.fn(async () => ({ id: modelId }));
    const complete = vi.fn(async () => ({ id: modelId, active: false }));
    const trainStatistical = vi.fn(async () => incomplete);
    const service = new StatisticalModelService(
      { create, markTraining: vi.fn(), complete, fail: vi.fn() } as never,
      {} as never,
      { trainStatistical, predictStatistical: vi.fn() },
      {
        getDataset: async () => dataset,
        datasetRows: async () => [
          {
            sourceKey: "paper_execution:10000000-0000-4000-8000-000000000099",
            executionId: "10000000-0000-4000-8000-000000000099",
            observationId: "10000000-0000-4000-8000-000000000098",
            signalTimestamp: "2026-08-01T14:00:00.000Z",
            labelAvailableAt: "2026-08-01T14:15:00.000Z",
            deterministicScore: 80,
            atrPct: 1.2,
            rvolAtTime: 2,
            rMultiple: 1,
          },
          {
            sourceKey: "paper_execution:10000000-0000-4000-8000-000000000100",
            executionId: "10000000-0000-4000-8000-000000000100",
            observationId: "10000000-0000-4000-8000-000000000101",
            signalTimestamp: "2026-08-02T14:00:00.000Z",
            labelAvailableAt: "2026-08-02T14:15:00.000Z",
            deterministicScore: 70,
            atrPct: 1.1,
            rvolAtTime: 1.8,
            rMultiple: -1,
          },
        ],
      } as never,
    );
    await service.create({
      sourceKind: "PAPER_EVIDENCE",
      name: "Automatic challenger",
      trainingDatasetId: datasetId,
      strategy: "ORB_RETEST",
      trainPct: 80,
      minimumSamples: 200,
      l2Penalty: 0.1,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: "PAPER_EVIDENCE" }),
    );
    expect(trainStatistical).toHaveBeenCalledWith(
      expect.objectContaining({
        trades: [
          expect.objectContaining({
            entryTime: "2026-08-01T14:00:00.000Z",
            rMultiple: 1,
          }),
          expect.objectContaining({
            sourceKey: "paper_execution:10000000-0000-4000-8000-000000000100",
            entryTime: "2026-08-02T14:00:00.000Z",
          }),
        ],
        trainingSourceKeys: [
          "paper_execution:10000000-0000-4000-8000-000000000099",
        ],
        testingSourceKeys: [
          "paper_execution:10000000-0000-4000-8000-000000000100",
        ],
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      modelId,
      incomplete,
      expect.stringContaining("phase12-"),
    );
  });

  it("refuses an immutable dataset without a passing research gate", async () => {
    const create = vi.fn();
    const service = new StatisticalModelService(
      { create } as never,
      {} as never,
      {} as never,
      {
        getDataset: async () => ({
          ...dataset,
          researchQualification: {
            ...dataset.researchQualification,
            qualified: false,
            reasons: ["MISSING_LABEL_AVAILABILITY"],
          },
        }),
        datasetRows: async () => [],
      } as never,
    );

    await expect(
      service.create({
        sourceKind: "PAPER_EVIDENCE",
        name: "Unqualified challenger",
        trainingDatasetId: datasetId,
        strategy: "ORB_RETEST",
        trainPct: 80,
        minimumSamples: 200,
        l2Penalty: 0.1,
      }),
    ).rejects.toMatchObject({ code: "PAPER_DATASET_NOT_QUALIFIED" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a legacy qualified dataset without a frozen partition", async () => {
    const create = vi.fn();
    const service = new StatisticalModelService(
      { create } as never,
      {} as never,
      {} as never,
      {
        getDataset: async () => ({
          ...dataset,
          researchQualification: {
            ...dataset.researchQualification,
            policyVersion: "paper-research-qualification-v1",
            chronologicalTrainSourceKeys: undefined,
            chronologicalTestSourceKeys: undefined,
          },
        }),
        datasetRows: async () => [],
      } as never,
    );
    await expect(
      service.create({
        sourceKind: "PAPER_EVIDENCE",
        name: "Legacy challenger",
        trainingDatasetId: datasetId,
        strategy: "ORB_RETEST",
        trainPct: 80,
        minimumSamples: 200,
        l2Penalty: 0.1,
      }),
    ).rejects.toMatchObject({ code: "PAPER_DATASET_NOT_QUALIFIED" });
    expect(create).not.toHaveBeenCalled();
  });
});
