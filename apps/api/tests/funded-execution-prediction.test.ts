import { describe, expect, it } from "vitest";
import type { FundedExecutionPredictionRecord } from "@tsx-scanner/contracts";
import {
  FundedExecutionPredictionService,
  type FundedExecutionPredictionInput,
  type FundedExecutionPredictionStore,
} from "../src/statistical-models/funded-execution-prediction.js";
import { contentHash } from "../src/statistical-models/funded-execution-digest.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function output(overrides: Record<string, number> = {}) {
  return {
    fillProbability: {
      value: overrides.fill ?? 0.8,
      unit: "PROBABILITY" as const,
      lowerBound: 0,
      upperBound: 1,
    },
    expectedFillFraction: {
      value: 0.7,
      unit: "FRACTION" as const,
      lowerBound: 0,
      upperBound: 1,
    },
    expectedSlippagePerShare: {
      value: 0.01,
      unit: "CURRENCY_PER_SHARE" as const,
      lowerBound: 0,
      upperBound: null,
    },
    expectedTotalExecutionCost: {
      value: 1.2,
      unit: "CURRENCY" as const,
      lowerBound: 0,
      upperBound: null,
    },
  };
}

function input(
  overrides: Partial<FundedExecutionPredictionInput> = {},
): FundedExecutionPredictionInput {
  return {
    challengerId: "00000000-0000-4000-8000-000000000010",
    marketId: "CA_TSX",
    currency: "CAD",
    sourceKind: "LIVE_PAPER",
    runId: "00000000-0000-4000-8000-0000000000aa",
    observationId: "00000000-0000-4000-8000-0000000000bb",
    expectedDecisionSequence: 1,
    expectedDecisionInputDigest: digestA,
    deadlineAt: "2026-09-16T14:31:00.000Z",
    output: output(),
    warnings: [],
    ...overrides,
  };
}

class FakePredictionStore implements FundedExecutionPredictionStore {
  records = new Map<string, FundedExecutionPredictionRecord>();
  calls: FundedExecutionPredictionInput[] = [];
  clock = "2026-09-16T14:30:01.000Z";

  async recordPrediction(
    prediction: FundedExecutionPredictionInput,
  ): Promise<FundedExecutionPredictionRecord> {
    this.calls.push(prediction);
    const model = {
      modelId: prediction.challengerId,
      modelVersion: "funded-execution-v1",
      modelType: "FUNDED_EXECUTION_QUALITY" as const,
      artifactDigest: digestA,
      cohortDigest: digestB,
      featureVersion: "funded-execution-features-v1" as const,
    };
    const digest = contentHash({
      model,
      marketId: prediction.marketId,
      currency: prediction.currency,
      sourceKind: prediction.sourceKind,
      runId: prediction.runId,
      observationId: prediction.observationId,
      decisionSequence: prediction.expectedDecisionSequence,
      decisionInputDigest: prediction.expectedDecisionInputDigest,
      deadlineAt: prediction.deadlineAt,
      output: prediction.output,
      warnings: prediction.warnings,
    });
    const record: FundedExecutionPredictionRecord = {
      predictionVersion: "funded-execution-prediction-v1",
      marketId: prediction.marketId,
      currency: prediction.currency,
      model,
      runId: prediction.runId,
      observationId: prediction.observationId,
      decisionSequence: prediction.expectedDecisionSequence,
      decisionInputDigest: prediction.expectedDecisionInputDigest,
      sourceKind: prediction.sourceKind,
      predictionAt: this.clock,
      deadlineAt: prediction.deadlineAt,
      output: prediction.output,
      warnings: [...prediction.warnings],
      digest,
    };
    if (Date.parse(this.clock) > Date.parse(prediction.deadlineAt))
      throw new Error("FUNDED_EXECUTION_PREDICTION_AFTER_DEADLINE");
    const key = `${prediction.challengerId}:${prediction.runId}:${prediction.observationId}:${prediction.expectedDecisionSequence}`;
    const existing = this.records.get(key);
    if (existing) {
      if (existing.digest !== digest)
        throw new Error("CONFLICTING_FUNDED_EXECUTION_PREDICTION");
      return existing;
    }
    this.records.set(key, record);
    return record;
  }
}

describe("funded execution forward prediction boundary", () => {
  it("records a database-timed diagnostic prediction without caller-supplied time", async () => {
    const store = new FakePredictionStore();
    const service = new FundedExecutionPredictionService(store);
    const request = input();
    expect("predictionAt" in request).toBe(false);
    const record = await service.record(request);
    expect(record.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(record.predictionAt).toBe(store.clock);
    expect(record.output.fillProbability.unit).toBe("PROBABILITY");
    expect(record.model.artifactDigest).toBe(digestA);
    expect(record.decisionInputDigest).toBe(digestA);
    const keys = Object.keys(record);
    expect(keys).not.toContain("action");
    expect(keys).not.toContain("authority");
    expect(keys).not.toContain("positionSize");
    expect(Object.keys(record.output)).toEqual([
      "fillProbability",
      "expectedFillFraction",
      "expectedSlippagePerShare",
      "expectedTotalExecutionCost",
    ]);
  });

  it("is idempotent on exact retry and fails a conflicting retry", async () => {
    const store = new FakePredictionStore();
    const service = new FundedExecutionPredictionService(store);
    const record = await service.record(input());
    await expect(service.record(input())).resolves.toEqual(record);
    expect(store.calls).toHaveLength(2);
    await expect(
      service.record(input({ output: output({ fill: 0.1 }) })),
    ).rejects.toThrow("CONFLICTING_FUNDED_EXECUTION_PREDICTION");
  });

  it("rejects a prediction whose database time is after its deadline", async () => {
    const store = new FakePredictionStore();
    const service = new FundedExecutionPredictionService(store);
    await expect(
      service.record(input({ deadlineAt: "2026-09-16T14:00:00.000Z" })),
    ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_AFTER_DEADLINE");
  });

  it("rejects invalid ownership, sequence, deadline and output", async () => {
    const service = new FundedExecutionPredictionService(
      new FakePredictionStore(),
    );
    await expect(
      service.record(input({ marketId: "US_EQUITIES", currency: "USD" })),
    ).resolves.toBeDefined();
    await expect(
      service.record(input({ marketId: "CA_TSX", currency: "USD" })),
    ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_CURRENCY_MISMATCH");
    await expect(
      service.record(input({ expectedDecisionSequence: 0 })),
    ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_INVALID_SEQUENCE");
    await expect(
      service.record(input({ deadlineAt: "not-a-time" })),
    ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_INVALID_DEADLINE");
    await expect(
      service.record(
        input({
          output: {
            ...output(),
            fillProbability: {
              value: 1.5,
              unit: "PROBABILITY",
              lowerBound: 0,
              upperBound: 1,
            },
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      service.record(
        input({
          output: {
            ...output(),
            expectedSlippagePerShare: {
              value: 0.01,
              unit: "CURRENCY" as never,
              lowerBound: 0,
              upperBound: null,
            },
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
