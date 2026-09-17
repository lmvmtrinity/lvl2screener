import { describe, expect, it } from "vitest";
import {
  FUNDED_EXECUTION_FEATURE_NAMES,
  FUNDED_EXECUTION_FEATURE_VERSION,
  FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
  FUNDED_EXECUTION_MODEL_TYPE,
  FUNDED_EXECUTION_OUTPUT_NAMES,
  FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
  FUNDED_EXECUTION_DATASET_POLICY_VERSION,
  FUNDED_EXECUTION_PREDICTION_VERSION,
  fundedExecutionChallengerSchema,
  fundedExecutionDatasetManifestSchema,
  fundedExecutionDatasetMemberSchema,
  fundedExecutionFeatureVectorSchema,
  fundedExecutionInferenceInputSchema,
  fundedExecutionInferenceOutputSchema,
  fundedExecutionLabelsSchema,
  fundedExecutionModelArtifactSchema,
  fundedExecutionPredictionRecordSchema,
  fundedExecutionRowIdentitySchema,
  fundedExecutionTrainingRequestSchema,
  type FundedExecutionFeatureVector,
  type FundedExecutionModelArtifact,
} from "../src/domains/funded-execution-training.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

const features: FundedExecutionFeatureVector = Object.fromEntries(
  FUNDED_EXECUTION_FEATURE_NAMES.map((name) => [name, 1]),
) as FundedExecutionFeatureVector;

function identity(overrides: Record<string, unknown> = {}) {
  return {
    marketId: "CA_TSX",
    currency: "CAD",
    accountId: "account-1",
    runId: "run-1",
    observationId: "observation-1",
    decisionSequence: 1,
    decisionContentDigest: digestA,
    cohortDigest: digestB,
    evidenceSchemaVersion: 2,
    outcomeSequences: [2],
    outcomeSourceDigests: [digestA],
    ...overrides,
  };
}

function labels(overrides: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    fillProbability: 1,
    fillFraction: 0.5,
    slippagePerShare: 0.02,
    totalExecutionCost: 1.5,
    labelAvailableAt: "2026-09-16T15:00:00.000Z",
    economicOutcomeAt: "2026-09-16T14:35:00.000Z",
    terminalityProof: null,
    terminalOutcomeStatus: "FILLED",
    terminalOutcomeSequence: 2,
    terminalOutcomeSourceDigest: digestA,
    fillLabelAvailable: true,
    costLabelAvailable: true,
    ...overrides,
  };
  return {
    ...value,
    knowledge: overrides.knowledge ?? {
      provenance: "DATABASE_CAPTURE",
      runId: null,
      sequence: null,
      at: value.labelAvailableAt,
    },
  };
}

function member(overrides: Record<string, unknown> = {}) {
  return {
    ordinal: 0,
    marketId: "CA_TSX",
    currency: "CAD",
    identity: identity(),
    instrumentId: null,
    decisionAt: "2026-09-15T14:30:00.000Z",
    sessionDate: "2026-09-15",
    partition: "TRAIN",
    features,
    labels: labels(),
    sourceKind: "LIVE_PAPER",
    labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
    featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
    rowDigest: digestA,
    ...overrides,
  };
}

function artifact(
  overrides: Record<string, unknown> = {},
): FundedExecutionModelArtifact {
  const head = (output: string, kind: string, unit: string) => ({
    output,
    kind,
    unit,
    lowerBound: 0,
    upperBound: unit === "PROBABILITY" || unit === "FRACTION" ? 1 : null,
    trainingSamples: 160,
    intercept: 0.1,
    coefficients: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0.01),
    means: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0),
    scales: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 1),
    medians: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0),
    trainMetrics:
      kind === "LOGISTIC"
        ? {
            kind,
            samples: 160,
            positives: 80,
            negatives: 80,
            baseRate: 0.5,
            brierScore: 0.2,
            baselineBrierScore: 0.25,
            logLoss: 0.6,
            rocAuc: 0.6,
            calibration: [],
          }
        : {
            kind,
            samples: 160,
            meanPredicted: 0.5,
            meanActual: 0.5,
            meanAbsoluteError: 0.1,
            rootMeanSquaredError: 0.2,
          },
    testMetrics:
      kind === "LOGISTIC"
        ? {
            kind,
            samples: 40,
            positives: 20,
            negatives: 20,
            baseRate: 0.5,
            brierScore: 0.2,
            baselineBrierScore: 0.25,
            logLoss: 0.6,
            rocAuc: 0.6,
            calibration: [],
          }
        : {
            kind,
            samples: 40,
            meanPredicted: 0.5,
            meanActual: 0.5,
            meanAbsoluteError: 0.1,
            rootMeanSquaredError: 0.2,
          },
  });
  return {
    artifactVersion: "funded-execution-v1",
    modelType: FUNDED_EXECUTION_MODEL_TYPE,
    featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
    featureNames: [...FUNDED_EXECUTION_FEATURE_NAMES],
    sourceDatasetDigest: digestB,
    trainingPartitionDigest: digestA,
    trainingRowCount: 200,
    trainingFillRowCount: 200,
    trainingCostRowCount: 120,
    outputs: [
      head("fillProbability", "LOGISTIC", "PROBABILITY"),
      head("expectedFillFraction", "LINEAR", "FRACTION"),
      head("expectedSlippagePerShare", "LINEAR", "CURRENCY_PER_SHARE"),
      head("expectedTotalExecutionCost", "LINEAR", "CURRENCY"),
    ],
    warnings: [],
    ...overrides,
  } as FundedExecutionModelArtifact;
}

function predictionOutput() {
  return {
    fillProbability: {
      value: 0.8,
      unit: "PROBABILITY",
      lowerBound: 0,
      upperBound: 1,
    },
    expectedFillFraction: {
      value: 0.7,
      unit: "FRACTION",
      lowerBound: 0,
      upperBound: 1,
    },
    expectedSlippagePerShare: {
      value: 0.01,
      unit: "CURRENCY_PER_SHARE",
      lowerBound: 0,
      upperBound: null,
    },
    expectedTotalExecutionCost: {
      value: 1.2,
      unit: "CURRENCY",
      lowerBound: 0,
      upperBound: null,
    },
  };
}

describe("funded execution feature contract", () => {
  it("accepts a decision-only vector with explicit nulls", () => {
    const parsed = fundedExecutionFeatureVectorSchema.parse(
      Object.fromEntries(
        FUNDED_EXECUTION_FEATURE_NAMES.map((name) => [name, null]),
      ),
    );
    expect(Object.keys(parsed)).toEqual([...FUNDED_EXECUTION_FEATURE_NAMES]);
  });

  it("rejects unknown feature fields and out-of-range context strength", () => {
    expect(
      fundedExecutionFeatureVectorSchema.safeParse({ ...features, fill: 1 })
        .success,
    ).toBe(false);
    expect(
      fundedExecutionFeatureVectorSchema.safeParse({
        ...features,
        contextStrength: 4,
      }).success,
    ).toBe(false);
  });
});

describe("funded execution labels", () => {
  it("treats unknown cost labels as null rather than zero", () => {
    const parsed = fundedExecutionLabelsSchema.parse(
      labels({
        slippagePerShare: null,
        totalExecutionCost: null,
        costLabelAvailable: false,
      }),
    );
    expect(parsed.slippagePerShare).toBeNull();
    expect(parsed.totalExecutionCost).toBeNull();
  });

  it("requires a proven terminal zero fill to carry fraction 0", () => {
    expect(
      fundedExecutionLabelsSchema.safeParse(
        labels({
          fillProbability: 0,
          fillFraction: 0,
          slippagePerShare: null,
          totalExecutionCost: null,
          costLabelAvailable: false,
        }),
      ).success,
    ).toBe(true);
    expect(
      fundedExecutionLabelsSchema.safeParse(
        labels({ fillProbability: 0, fillFraction: 0.5 }),
      ).success,
    ).toBe(false);
  });

  it("rejects cost labels without a proven fill and unknown fields", () => {
    expect(
      fundedExecutionLabelsSchema.safeParse(
        labels({ fillProbability: null, fillFraction: null }),
      ).success,
    ).toBe(false);
    expect(
      fundedExecutionLabelsSchema.safeParse({ ...labels(), zeroFill: true })
        .success,
    ).toBe(false);
  });

  it("requires the separate economic outcome timestamp", () => {
    const withoutEconomic = labels();
    delete (withoutEconomic as Record<string, unknown>).economicOutcomeAt;
    expect(fundedExecutionLabelsSchema.safeParse(withoutEconomic).success).toBe(
      false,
    );
  });

  it("requires a final partial fill to bind its immutable terminality proof", () => {
    const partial = labels({
      terminalOutcomeStatus: "PARTIAL_FILL",
      fillFraction: 0.5,
    });
    expect(fundedExecutionLabelsSchema.safeParse(partial).success).toBe(false);
    expect(
      fundedExecutionLabelsSchema.safeParse({
        ...partial,
        terminalityProof: {
          orderId: "observation-1",
          revision: 3,
          stateDigest: digestA,
          factAt: "2026-09-16T14:40:00.000Z",
          recordedAt: "2026-09-16T14:41:00.000Z",
        },
      }).success,
    ).toBe(true);
    expect(
      fundedExecutionLabelsSchema.safeParse({
        ...partial,
        terminalityProof: {
          orderId: "observation-1",
          revision: 3,
        },
      }).success,
    ).toBe(false);
  });

  it("binds replay knowledge to its run and sequence and live knowledge to none", () => {
    const replayCoordinate = (value: Record<string, unknown>) =>
      fundedExecutionLabelsSchema.safeParse(
        labels({
          knowledge: {
            provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
            at: "2026-09-16T15:00:00.000Z",
            ...value,
          },
        }),
      ).success;
    expect(replayCoordinate({ runId: null, sequence: null })).toBe(false);
    expect(replayCoordinate({ runId: "replay-run", sequence: null })).toBe(
      false,
    );
    expect(replayCoordinate({ runId: "replay-run", sequence: 3 })).toBe(true);
    expect(
      fundedExecutionLabelsSchema.safeParse(
        labels({
          knowledge: {
            provenance: "DATABASE_CAPTURE",
            runId: "replay-run",
            sequence: 3,
            at: "2026-09-16T15:00:00.000Z",
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("funded execution row identity", () => {
  it("pairs market and currency", () => {
    expect(
      fundedExecutionRowIdentitySchema.safeParse(
        identity({ marketId: "US_EQUITIES", currency: "CAD" }),
      ).success,
    ).toBe(false);
  });

  it("requires outcome sequences and digests to correspond", () => {
    expect(
      fundedExecutionRowIdentitySchema.safeParse(
        identity({ outcomeSequences: [2, 3] }),
      ).success,
    ).toBe(false);
  });

  it("rejects version-1 evidence", () => {
    expect(
      fundedExecutionRowIdentitySchema.safeParse(
        identity({ evidenceSchemaVersion: 1 }),
      ).success,
    ).toBe(false);
  });
});

describe("funded execution dataset manifests and members", () => {
  it("accepts a valid member and rejects unknown fields", () => {
    expect(fundedExecutionDatasetMemberSchema.safeParse(member()).success).toBe(
      true,
    );
    expect(
      fundedExecutionDatasetMemberSchema.safeParse({
        ...member(),
        label: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a member whose currency does not match the market", () => {
    expect(
      fundedExecutionDatasetMemberSchema.safeParse(
        member({
          marketId: "CA_TSX",
          currency: "USD",
          identity: identity({ currency: "USD" }),
        }),
      ).success,
    ).toBe(false);
  });

  it("binds member source kind to its knowledge provenance", () => {
    const replayKnowledge = {
      provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
      runId: "run-1",
      sequence: 8,
      at: "2026-09-16T15:00:00.000Z",
    };
    expect(
      fundedExecutionDatasetMemberSchema.safeParse(
        member({
          sourceKind: "HISTORICAL_REPLAY",
          labels: labels({ knowledge: replayKnowledge }),
        }),
      ).success,
    ).toBe(true);
    // Live capture cannot claim replay provenance or a replay run/sequence.
    expect(
      fundedExecutionDatasetMemberSchema.safeParse(
        member({ labels: labels({ knowledge: replayKnowledge }) }),
      ).success,
    ).toBe(false);
    expect(
      fundedExecutionDatasetMemberSchema.safeParse(
        member({
          labels: labels({
            knowledge: {
              provenance: "DATABASE_CAPTURE",
              runId: "run-1",
              sequence: 8,
              at: "2026-09-16T15:00:00.000Z",
            },
          }),
        }),
      ).success,
    ).toBe(false);
    // Live knowledge must equal the audit knowledge time.
    expect(
      fundedExecutionDatasetMemberSchema.safeParse(
        member({
          labels: labels({
            knowledge: {
              provenance: "DATABASE_CAPTURE",
              runId: null,
              sequence: null,
              at: "2026-09-16T14:59:00.000Z",
            },
          }),
        }),
      ).success,
    ).toBe(false);
    // A replay member cannot use database capture, a foreign run or no sequence.
    for (const knowledge of [
      {
        provenance: "DATABASE_CAPTURE",
        runId: null,
        sequence: null,
        at: "2026-09-16T15:00:00.000Z",
      },
      {
        provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
        runId: "other-run",
        sequence: 8,
        at: "2026-09-16T15:00:00.000Z",
      },
      {
        provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
        runId: "run-1",
        sequence: null,
        at: "2026-09-16T15:00:00.000Z",
      },
    ])
      expect(
        fundedExecutionDatasetMemberSchema.safeParse(
          member({
            sourceKind: "HISTORICAL_REPLAY",
            labels: labels({ knowledge }),
          }),
        ).success,
      ).toBe(false);
  });

  it("rejects a dataset manifest with mismatched market/currency", () => {
    const manifest = {
      id: "00000000-0000-4000-8000-000000000001",
      marketId: "CA_TSX",
      currency: "USD",
      cohort: {
        marketId: "CA_TSX",
        currency: "USD",
        evidenceSchemaVersion: 2,
        fundedPolicyVersion: "funded-policy-v1",
        portfolioPolicyVersion: "funded-portfolio-v2",
        executionModelVersion: "paper-execution-v3",
        costPolicyVersion: "paper-cost-policy-2026-09-04",
        participationVersion: "participation-v1",
        sourceKind: "LIVE_PAPER",
        featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
        runtimeVersion: "runtime-v1",
        accountAssumptionDigest: digestA,
        signalModelId: null,
        signalModelVersion: null,
        cohortDigest: digestB,
      },
      sourceKind: "LIVE_PAPER",
      requestedCutoff: "2026-09-16T20:00:00.000Z",
      effectiveCutoff: "2026-09-16T19:00:00.000Z",
      datasetPolicyVersion: FUNDED_EXECUTION_DATASET_POLICY_VERSION,
      labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
      featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      qualificationPolicyVersion: FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
      membershipDigest: digestA,
      datasetDigest: digestB,
      qualificationReceipt: {
        policyVersion: FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
        qualified: true,
        reasons: [],
        minimumRows: 200,
        minimumNewRows: 50,
        newOutcomesSincePrior: 200,
        priorDatasetId: null,
        priorDatasetRowCount: null,
        liveRunRequired: true,
        distinctSessionCount: 12,
        chronologicalSplitAt: "2026-09-15T14:30:00.000Z",
        trainFillPositives: 80,
        trainFillNegatives: 80,
        testFillPositives: 20,
        testFillNegatives: 20,
        trainCostLabelCount: 100,
        testCostLabelCount: 30,
        counts: {
          sourceRowCount: 220,
          usableRowCount: 200,
          includedRowCount: 200,
          trainRowCount: 160,
          testRowCount: 40,
          excludedCounts: {},
          unknownCounts: {},
        },
      },
      sourceWatermark: {
        latestDecisionAt: "2026-09-16T19:00:00.000Z",
        latestLabelAvailableAt: "2026-09-16T19:00:00.000Z",
        latestEconomicOutcomeAt: "2026-09-16T18:30:00.000Z",
        decisionCount: 220,
        outcomeVersionCount: 260,
      },
      activationEligible: true,
      createdAt: "2026-09-16T20:01:00.000Z",
    };
    expect(
      fundedExecutionDatasetManifestSchema.safeParse(manifest).success,
    ).toBe(false);
  });
});

describe("funded execution artifact prohibition", () => {
  it("accepts the deterministic artifact shape", () => {
    expect(
      fundedExecutionModelArtifactSchema.safeParse(artifact()).success,
    ).toBe(true);
  });

  it("rejects action, sizing, veto-bypass and authority fields", () => {
    for (const forbidden of [
      { action: "SUBMIT" },
      { authority: "ACTIVE" },
      { positionSize: 1000 },
      { vetoBypass: true },
      { recommendedAction: "BUY" },
      { ranking: [1, 2, 3] },
      { profileId: "profile-1" },
    ]) {
      expect(
        fundedExecutionModelArtifactSchema.safeParse({
          ...artifact(),
          ...forbidden,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects a reordered feature list and reordered outputs", () => {
    const reordered = [...FUNDED_EXECUTION_FEATURE_NAMES];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(
      fundedExecutionModelArtifactSchema.safeParse(
        artifact({ featureNames: reordered }),
      ).success,
    ).toBe(false);
    const outputs = artifact().outputs.map((output) => ({ ...output }));
    const first = outputs[0]!;
    outputs[0] = outputs[1]!;
    outputs[1] = first;
    expect(
      fundedExecutionModelArtifactSchema.safeParse(artifact({ outputs }))
        .success,
    ).toBe(false);
  });
});

describe("funded execution training request", () => {
  function trainingRow(partition: "TRAIN" | "TEST", observation: string) {
    return {
      marketId: "CA_TSX",
      currency: "CAD",
      runId: "run-1",
      observationId: observation,
      decisionSequence: 1,
      decisionContentDigest: digestA,
      decisionAt: "2026-09-15T14:30:00.000Z",
      sessionDate: "2026-09-15",
      partition,
      features,
      labels: labels(),
      rowDigest: digestA,
    };
  }
  function request(overrides: Record<string, unknown> = {}) {
    return {
      requestVersion: "funded-execution-training-v1",
      marketId: "CA_TSX",
      currency: "CAD",
      cohortDigest: digestB,
      datasetDigest: digestA,
      membershipDigest: digestB,
      trainingPartitionDigest: digestA,
      featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
      featureNames: [...FUNDED_EXECUTION_FEATURE_NAMES],
      sourceKind: "LIVE_PAPER",
      rows: [
        trainingRow("TRAIN", "observation-1"),
        trainingRow("TEST", "observation-2"),
      ],
      ...overrides,
    };
  }

  it("accepts a frozen train/test request", () => {
    expect(
      fundedExecutionTrainingRequestSchema.safeParse(request()).success,
    ).toBe(true);
  });

  it("rejects a reordered feature contract", () => {
    const names = [...FUNDED_EXECUTION_FEATURE_NAMES];
    [names[0], names[1]] = [names[1]!, names[0]!];
    expect(
      fundedExecutionTrainingRequestSchema.safeParse(
        request({ featureNames: names }),
      ).success,
    ).toBe(false);
  });

  it("binds request source kind to each row's knowledge provenance", () => {
    const replayRow = {
      ...trainingRow("TRAIN", "observation-1"),
      labels: labels({
        knowledge: {
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
          runId: "run-1",
          sequence: 3,
          at: "2026-09-16T15:00:00.000Z",
        },
      }),
    };
    expect(
      fundedExecutionTrainingRequestSchema.safeParse(
        request({
          sourceKind: "HISTORICAL_REPLAY",
          rows: [replayRow, trainingRow("TEST", "observation-2")],
        }),
      ).success,
    ).toBe(false);
    expect(
      fundedExecutionTrainingRequestSchema.safeParse(
        request({
          rows: [
            replayRow,
            {
              ...trainingRow("TEST", "observation-2"),
              labels: labels({
                knowledge: {
                  provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
                  runId: "other-run",
                  sequence: 3,
                  at: "2026-09-16T15:00:00.000Z",
                },
              }),
            },
          ],
        }),
      ).success,
    ).toBe(false);
    const replayLabels = labels({
      knowledge: {
        provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
        runId: "run-1",
        sequence: 3,
        at: "2026-09-16T15:00:00.000Z",
      },
    });
    expect(
      fundedExecutionTrainingRequestSchema.safeParse(
        request({
          sourceKind: "HISTORICAL_REPLAY",
          rows: [
            { ...trainingRow("TRAIN", "observation-1"), labels: replayLabels },
            { ...trainingRow("TEST", "observation-2"), labels: replayLabels },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects cross-market rows and duplicate membership", () => {
    expect(
      fundedExecutionTrainingRequestSchema.safeParse(
        request({
          rows: [
            trainingRow("TRAIN", "observation-1"),
            {
              ...trainingRow("TEST", "observation-2"),
              marketId: "US_EQUITIES",
              currency: "USD",
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      fundedExecutionTrainingRequestSchema.safeParse(
        request({
          rows: [
            trainingRow("TRAIN", "observation-1"),
            trainingRow("TRAIN", "observation-1"),
            trainingRow("TEST", "observation-2"),
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe("funded execution inference boundary", () => {
  it("validates inference input identity and feature version", () => {
    const model = {
      modelId: "model-1",
      modelVersion: "funded-execution-v1",
      modelType: FUNDED_EXECUTION_MODEL_TYPE,
      artifactDigest: digestA,
      cohortDigest: digestB,
      featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
    };
    const input = {
      requestVersion: "funded-execution-inference-v1",
      marketId: "CA_TSX",
      currency: "CAD",
      model,
      artifact: artifact(),
      inputs: [
        {
          runId: "run-1",
          observationId: "observation-1",
          decisionSequence: 1,
          decisionInputDigest: digestA,
          features,
        },
      ],
    };
    expect(fundedExecutionInferenceInputSchema.safeParse(input).success).toBe(
      true,
    );
    expect(
      fundedExecutionInferenceInputSchema.safeParse({
        ...input,
        model: { ...model, featureVersion: "features-v2" },
      }).success,
    ).toBe(false);
    expect(
      fundedExecutionInferenceInputSchema.safeParse({
        ...input,
        inferenceAction: "SUBMIT",
      }).success,
    ).toBe(false);
  });

  it("rejects an inference output that carries an action field or bad unit", () => {
    const output = {
      requestVersion: "funded-execution-inference-v1",
      marketId: "CA_TSX",
      currency: "CAD",
      model: {
        modelId: "model-1",
        modelVersion: "funded-execution-v1",
        modelType: FUNDED_EXECUTION_MODEL_TYPE,
        artifactDigest: digestA,
        cohortDigest: digestB,
        featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      },
      predictions: [
        {
          runId: "run-1",
          observationId: "observation-1",
          decisionSequence: 1,
          decisionInputDigest: digestA,
          output: predictionOutput(),
          warnings: [],
        },
      ],
      warnings: [],
    };
    expect(fundedExecutionInferenceOutputSchema.safeParse(output).success).toBe(
      true,
    );
    expect(
      fundedExecutionInferenceOutputSchema.safeParse({
        ...output,
        predictions: [
          {
            ...output.predictions[0],
            action: "SUBMIT",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      fundedExecutionInferenceOutputSchema.safeParse({
        ...output,
        predictions: [
          {
            ...output.predictions[0],
            output: {
              ...predictionOutput(),
              fillProbability: {
                value: 0.8,
                unit: "FRACTION",
                lowerBound: 0,
                upperBound: 1,
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("funded execution challenger", () => {
  const cohort = {
    marketId: "CA_TSX" as const,
    currency: "CAD" as const,
    evidenceSchemaVersion: 2 as const,
    fundedPolicyVersion: "funded-policy-v1",
    portfolioPolicyVersion: "funded-portfolio-v2",
    executionModelVersion: "paper-execution-v3",
    costPolicyVersion: "paper-cost-policy-2026-09-04",
    participationVersion: "participation-v1",
    sourceKind: "LIVE_PAPER" as const,
    featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
    runtimeVersion: "runtime-v1",
    accountAssumptionDigest: digestA,
    signalModelId: null,
    signalModelVersion: null,
    cohortDigest: digestB,
  };
  function challenger(overrides: Record<string, unknown> = {}) {
    return {
      id: "00000000-0000-4000-8000-000000000002",
      marketId: "CA_TSX",
      currency: "CAD",
      cohort,
      datasetId: "00000000-0000-4000-8000-000000000003",
      datasetDigest: digestA,
      modelVersion: "funded-execution-v1",
      modelType: FUNDED_EXECUTION_MODEL_TYPE,
      artifactDigest: digestA,
      featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
      qualificationPolicyVersion: FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
      trainingPolicyVersion: "funded-execution-training-v1",
      trainingCodeVersion: "funded-execution-trainer-v1",
      runtimeFingerprint: null,
      status: "INACTIVE",
      eligibleForActivation: false,
      active: false,
      artifact: artifact(),
      metrics: null,
      sampleCounts: { trainingRows: 200 },
      failureReceipt: null,
      createdAt: "2026-09-16T20:02:00.000Z",
      ...overrides,
    };
  }

  it("accepts an inactive challenger and rejects activation fields", () => {
    expect(
      fundedExecutionChallengerSchema.safeParse(challenger()).success,
    ).toBe(true);
    for (const forbidden of [
      { eligibleForActivation: true },
      { active: true },
      { authority: "ACTIVE" },
      { promotedAt: "2026-09-16T20:00:00.000Z" },
    ])
      expect(
        fundedExecutionChallengerSchema.safeParse({
          ...challenger(),
          ...forbidden,
        }).success,
      ).toBe(false);
  });

  it("rejects FAILED without a failure receipt and INACTIVE without artifact", () => {
    expect(
      fundedExecutionChallengerSchema.safeParse(
        challenger({ status: "FAILED" }),
      ).success,
    ).toBe(false);
    expect(
      fundedExecutionChallengerSchema.safeParse(challenger({ artifact: null }))
        .success,
    ).toBe(false);
  });
});

describe("funded execution prediction record", () => {
  function prediction(overrides: Record<string, unknown> = {}) {
    return {
      predictionVersion: FUNDED_EXECUTION_PREDICTION_VERSION,
      marketId: "CA_TSX",
      currency: "CAD",
      model: {
        modelId: "model-1",
        modelVersion: "funded-execution-v1",
        modelType: FUNDED_EXECUTION_MODEL_TYPE,
        artifactDigest: digestA,
        cohortDigest: digestB,
        featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      },
      runId: "run-1",
      observationId: "observation-1",
      decisionSequence: 1,
      decisionInputDigest: digestA,
      sourceKind: "LIVE_PAPER",
      predictionAt: "2026-09-16T14:30:00.000Z",
      deadlineAt: "2026-09-16T14:31:00.000Z",
      output: predictionOutput(),
      warnings: [],
      digest: digestA,
      ...overrides,
    };
  }

  it("accepts a prediction recorded within its deadline", () => {
    expect(
      fundedExecutionPredictionRecordSchema.safeParse(prediction()).success,
    ).toBe(true);
  });

  it("rejects a prediction recorded after its deadline", () => {
    expect(
      fundedExecutionPredictionRecordSchema.safeParse(
        prediction({
          predictionAt: "2026-09-16T14:32:00.000Z",
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects cross-market ownership and action fields", () => {
    // The record itself carries the model/cohort digest, not cohort components;
    // cross-market and cross-cohort binding is enforced by the prediction
    // service against the persisted challenger before a record can exist.
    expect(
      fundedExecutionPredictionRecordSchema.safeParse(
        prediction({ action: "SUBMIT" }),
      ).success,
    ).toBe(false);
    expect(
      fundedExecutionPredictionRecordSchema.safeParse(
        prediction({
          model: {
            modelId: "model-1",
            modelVersion: "funded-execution-v1",
            modelType: FUNDED_EXECUTION_MODEL_TYPE,
            artifactDigest: digestA,
            cohortDigest: "not-a-digest",
            featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("frozen output order", () => {
  it("exports the four execution-quality outputs in order", () => {
    expect([...FUNDED_EXECUTION_OUTPUT_NAMES]).toEqual([
      "fillProbability",
      "expectedFillFraction",
      "expectedSlippagePerShare",
      "expectedTotalExecutionCost",
    ]);
  });
});
