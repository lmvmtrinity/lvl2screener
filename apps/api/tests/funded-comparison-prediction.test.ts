import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createBacktestSchema,
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION,
  fundedDecisionTimeInputSchema,
  fundedExecutionInferenceOutputSchema,
  fundedExecutionModelArtifactSchema,
  type FundedComparisonSpecification,
} from "@tsx-scanner/contracts";
import {
  loadFundedComparisonTrainingLineage,
  predictFundedComparisonBatch,
  type FundedComparisonChallengerRecord,
} from "../src/paper-bot/funded-comparison-prediction.js";
import type { FundedDecisionRow } from "../src/paper-bot/funded-decision-evidence-repository.js";
import {
  buildFundedDecisionDraft,
  fundedAccountStateEvidence,
} from "../src/paper-bot/funded-decision-evidence.js";
import { createFundedLedger } from "../src/paper-bot/funded-ledger.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import {
  fundedExecutionArtifactDigest,
  fundedExecutionTrainingPartitionDigest,
} from "../src/statistical-models/funded-execution-digest.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";

const fixtureUrl = new URL(
  "../../../services/scanner/tests/fixtures/funded_execution_result.json",
  import.meta.url,
);

const artifact = fundedExecutionModelArtifactSchema.parse(
  JSON.parse((await readFile(fixtureUrl, "utf8")) as string).artifact,
);
const artifactDigest = fundedExecutionArtifactDigest(artifact);

const assumptions = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 1,
  costs: {
    entryCommission: 1,
    exitCommission: 1,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency: "CAD",
    brokerPricingVersion: "cost-policy-v1",
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  riskBudget: 250,
  maxNotional: 1_500,
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
} as const;

function decisionContent(observationId: string, at: string) {
  const ledger = createFundedLedger("CAD", 25_000, "2026-09-15", at, 2_500);
  return fundedDecisionTimeInputSchema.parse(
    buildFundedDecisionDraft({
      observation: {
        id: observationId,
        strategyKey: "ORB_RETEST",
        strategyVersion: "2026-09-01",
        score: 70,
        reasonCodes: ["BREAKOUT"],
        fundedContexts: [
          {
            signalKey: "MARKET_RELATIVE_STRENGTH",
            status: "STRONG",
            timestamp: at,
          },
        ],
      },
      order: {
        signal: {
          entryReference: 10,
          stopReference: 9,
          targetReference: 12,
          atr14: 1,
          signalTimestamp: at,
        },
        assumptions,
        submittedAt: at,
      },
      requestedCapital: { maximumDebit: 1_000, maximumRisk: 250 },
      quote: {
        timestamp: at,
        bid: 10,
        ask: 10.02,
        bidSize: 500,
        askSize: 500,
        sizeUnit: "SHARES",
        sizeMultiplier: 1,
        dataStatus: "REALTIME",
        actionable: true,
      },
      context: {
        marketId: "CA_TSX",
        accountId: "account-1",
        runId: "champion-run-1",
        sourceKind: "HISTORICAL_REPLAY",
        fundedPolicyVersion: "funded-cash-v1",
        executionModelVersion: "execution-v1",
        featureVersion: "features-v1",
        runtimeVersion: "runtime-v1",
        costPolicyVersion: "cost-policy-v1",
        participationVersion: "participation-v1",
        policy: fundedPolicy(1, 0),
        accountState: fundedAccountStateEvidence(ledger, at, {
          cooldownActive: false,
          consecutiveStops: 0,
        }),
        model: null,
      },
      action: "SUBMIT",
      policyReason: null,
    }),
  );
}

function decisionRow(observationId: string, at: string): FundedDecisionRow {
  const content = decisionContent(observationId, at);
  return {
    run_id: "champion-run-1",
    observation_id: observationId,
    sequence: 1,
    market_id: "CA_TSX",
    currency: "CAD",
    account_id: "account-1",
    funded_policy_version: "funded-cash-v1",
    execution_model_version: "execution-v1",
    feature_version: "features-v1",
    evidence_schema_version: FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION,
    action: "SUBMIT",
    source_kind: "HISTORICAL_REPLAY",
    content_digest: "a".repeat(64),
    cohort_digest: "b".repeat(64),
    decision_content: content,
    captured_at: at,
  } as unknown as FundedDecisionRow;
}

function specification(): FundedComparisonSpecification {
  return {
    specVersion: "funded-comparison-spec-v1",
    marketId: "CA_TSX",
    currency: "CAD",
    baseline: {
      backtestRunId: "baseline-1",
      configVersion: "config-1",
      strategyKeys: ["ORB_RETEST"],
      startDate: "2026-09-01",
      endDate: "2026-09-15",
      executionModelVersion: "execution-v1",
      replayInputDigest: "c".repeat(64),
      baselineResultDigest: "d".repeat(64),
      completedAt: "2026-09-15T20:00:00.000Z",
    },
    sessionMembership: {
      orderedSessionDates: ["2026-09-15"],
      sessionMembershipDigest: "e".repeat(64),
    },
    sharedInput: {
      orderedSessions: [
        {
          sessionDate: "2026-09-15",
          itemCount: 3,
          chunkCount: 1,
          sessionInputDigest: "e".repeat(64),
        },
      ],
      sharedInputDigest: "f".repeat(64),
    },
    replay: {
      request: createBacktestSchema.parse({
        name: "baseline",
        marketId: "CA_TSX",
        startDate: "2026-09-01",
        endDate: "2026-09-15",
        strategies: ["ORB_RETEST"],
        symbols: [],
        startingCapital: 25_000,
        positionSize: 2_500,
        slippageBps: 5,
        feePerTrade: 1,
        parameters: {
          ...createBacktestSchema.parse({
            name: "x",
            startDate: "2026-09-01",
            endDate: "2026-09-02",
          }).parameters,
          scoreCutoff: 70,
        },
      }),
      requestDigest: "a".repeat(64),
      profiles: [
        {
          strategyKey: "ORB_RETEST",
          profileId: "profile-1",
          profileName: "Opening range",
          profileConfigId: "00000000-0000-4000-8000-000000000010",
          configVersion: "config-1",
        },
      ],
      profilesDigest: "b".repeat(64),
    },
    opportunityMembership: {
      orderedOpportunityIds: ["source-1", "source-2"],
      opportunityMembershipDigest: "f".repeat(64),
      opportunityCount: 2,
      eligibilityVersion: "funded-comparison-eligible-opportunities-v1",
    },
    champion: {
      kind: "DETERMINISTIC_FUNDED_POLICY",
      fundedPolicyVersion: "funded-cash-v1",
      portfolioPolicyVersion: "funded-portfolio-v2",
      policyDigest: "a".repeat(64),
      sourceLiveRunId: "live-run-1",
      sourceAccountId: "live-account-1",
      executionModelVersion: "execution-v1",
      costPolicyVersion: "cost-policy-v1",
      participationVersion: "participation-v1",
      runtimeVersion: "runtime-v1",
      accountAssumptionDigest: "b".repeat(64),
      assumptionsDigest: "c".repeat(64),
    },
    challenger: {
      kind: "FUNDED_EXECUTION_POLICY_V1",
      policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
      policyDigest: "d".repeat(64),
      model: {
        modelId: "00000000-0000-4000-8000-000000000001",
        modelVersion: "funded-execution-v1",
        artifactDigest,
        datasetDigest: artifact.sourceDatasetDigest,
        cohortDigest: "b".repeat(64),
        featureVersion: "funded-execution-features-v1",
        predictionPolicyVersion: "funded-execution-prediction-v1",
        trainingPartitionDigest: artifact.trainingPartitionDigest,
        trainingEvidenceCutoffAt: "2026-09-11T20:00:00.000Z",
        trainingSessionDigest: "e".repeat(64),
      },
    },
    capital: {
      initialCash: 25_000,
      dailyLossLimit: 2_500,
      riskConfigurationDigest: "f".repeat(64),
    },
    valuationPolicyVersion: "funded-comparison-valuation-v1",
    metricsPolicyVersion: "funded-comparison-metrics-v1",
    evidenceCutoffAt: "2026-09-15T20:00:00.000Z",
    specificationFrozenAt: "2026-09-15T20:30:00.000Z",
    comparisonSpecDigest: "9".repeat(64),
  };
}

function challenger(): FundedComparisonChallengerRecord {
  return {
    challengerId: specification().challenger.model.modelId,
    modelVersion: "funded-execution-v1",
    artifactDigest,
    cohortDigest: "b".repeat(64),
    datasetDigest: artifact.sourceDatasetDigest,
    featureVersion: "funded-execution-features-v1",
    artifact,
    training: {
      trainingSessionDates: ["2026-09-09", "2026-09-10", "2026-09-11"],
      trainingKnowledgeCutoffAt: "2026-09-11T20:00:00.000Z",
      trainingPartitionDigest: artifact.trainingPartitionDigest,
      trainingSessionDigest: "e".repeat(64),
    },
  };
}

const at = "2026-09-15T14:30:00.000Z";

function request(decisions: Map<string, FundedDecisionRow>) {
  return {
    specification: specification(),
    challenger: challenger(),
    signalTimestamp: at,
    candidates: [
      {
        sourceOpportunityId: "source-1",
        sourceOrdinal: 1,
        signalTimestamp: at,
        deterministicScore: 70,
        decisionAt: at,
        observationId: "observation-1",
      },
      {
        sourceOpportunityId: "source-2",
        sourceOrdinal: 2,
        signalTimestamp: at,
        deterministicScore: 70,
        decisionAt: at,
        observationId: "observation-2",
      },
    ],
    championDecisions: decisions,
  };
}

function inferenceOutput(payload: unknown) {
  const parsed = parsePayload(payload);
  return fundedExecutionInferenceOutputSchema.parse({
    requestVersion: "funded-execution-inference-v1",
    marketId: "CA_TSX",
    currency: "CAD",
    model: parsed.model,
    predictions: parsed.inputs.map((input) => ({
      runId: input.runId,
      observationId: input.observationId,
      decisionSequence: input.decisionSequence,
      decisionInputDigest: input.decisionInputDigest,
      output: {
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
          value: 2,
          unit: "CURRENCY",
          lowerBound: 0,
          upperBound: null,
        },
      },
      warnings: [],
    })),
    warnings: [],
  });
}

function parsePayload(payload: unknown) {
  return payload as {
    model: unknown;
    inputs: {
      runId: string;
      observationId: string;
      decisionSequence: number;
      decisionInputDigest: string;
    }[];
  };
}

describe("comparison-owned historical prediction", () => {
  it("computes one valid diagnostic batch from champion decisions", async () => {
    const decisions = new Map([
      ["source-1", decisionRow("observation-1", at)],
      ["source-2", decisionRow("observation-2", at)],
    ]);
    let calls = 0;
    const batch = await predictFundedComparisonBatch(request(decisions), {
      predictFundedExecution: async (payload) => {
        calls += 1;
        return inferenceOutput(payload);
      },
    });
    expect(calls).toBe(1);
    expect(batch.batchFallback).toBe(false);
    expect(batch.candidates).toHaveLength(2);
    expect(
      batch.candidates.every(
        (candidate) =>
          candidate.predictionIdentityValid &&
          candidate.prediction?.expectedFillFraction === 0.7,
      ),
    ).toBe(true);
    expect(batch.identities.get("source-1")?.outputDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(batch.identities.get("source-1")?.inputDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("falls back for the complete batch when a decision is missing", async () => {
    const decisions = new Map([["source-1", decisionRow("observation-1", at)]]);
    let calls = 0;
    const batch = await predictFundedComparisonBatch(request(decisions), {
      predictFundedExecution: async () => {
        calls += 1;
        return {};
      },
    });
    expect(calls).toBe(0);
    expect(batch.batchFallback).toBe(true);
    expect(
      batch.candidates.every((candidate) => candidate.prediction === null),
    ).toBe(true);
    expect(
      batch.candidates.every(
        (candidate) =>
          candidate.unavailableReason === "PREDICTION_DECISION_UNAVAILABLE",
      ),
    ).toBe(true);
  });

  it("falls back when inference fails or the identity does not match", async () => {
    const decisions = new Map([
      ["source-1", decisionRow("observation-1", at)],
      ["source-2", decisionRow("observation-2", at)],
    ]);
    const failed = await predictFundedComparisonBatch(request(decisions), {
      predictFundedExecution: async () => {
        throw new Error("scanner unavailable");
      },
    });
    expect(failed.batchFallback).toBe(true);
    expect(failed.candidates[0]!.unavailableReason).toBe("INFERENCE_FAILED");
    const mismatched = await predictFundedComparisonBatch(request(decisions), {
      predictFundedExecution: async (payload) => {
        const output = inferenceOutput(payload);
        return {
          ...output,
          predictions: output.predictions.map((prediction) => ({
            ...prediction,
            decisionInputDigest: "0".repeat(64),
          })),
        };
      },
    });
    expect(mismatched.batchFallback).toBe(true);
    expect(mismatched.candidates[0]!.unavailableReason).toBe(
      "INVALID_DIAGNOSTIC",
    );
  });

  it("treats a cohort mismatch as a model identity failure", async () => {
    const decisions = new Map([
      ["source-1", decisionRow("observation-1", at)],
      ["source-2", decisionRow("observation-2", at)],
    ]);
    const wrongCohort = new Map(
      [...decisions].map(([key, row]) => [
        key,
        { ...row, cohort_digest: "0".repeat(64) },
      ]),
    );
    const batch = await predictFundedComparisonBatch(request(wrongCohort), {
      predictFundedExecution: async () => {
        throw new Error("must not be called");
      },
    });
    expect(batch.batchFallback).toBe(true);
    expect(batch.candidates[0]!.unavailableReason).toBe(
      "MODEL_IDENTITY_MISMATCH",
    );
  });

  it("never writes FP04 forward predictions", async () => {
    const source = await readFile(
      new URL(
        "../src/paper-bot/funded-comparison-prediction.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toContain("funded-execution-prediction.js");
    expect(source).not.toContain("INSERT INTO funded_execution_prediction");
    expect(source).not.toContain("PostgresFundedExecutionPredictionStore");
  });

  it("derives the TRAIN chronology from the persisted FP02 member lineage", async () => {
    const rowDigests = ["1".repeat(64), "2".repeat(64)];
    const pool = {
      query: async (text: string) => {
        expect(text).toContain("funded_execution_dataset_member");
        return {
          rows: [
            {
              session_date: "2026-09-03",
              label_available_at: "2026-09-03T20:00:00.000Z",
              row_digest: rowDigests[0],
            },
            {
              session_date: "2026-09-04",
              label_available_at: "2026-09-04T20:00:00.000Z",
              row_digest: rowDigests[1],
            },
            {
              session_date: "2026-09-04",
              label_available_at: "2026-09-05T20:00:00.000Z",
              row_digest: rowDigests[1],
            },
          ],
        };
      },
    } as unknown as Pool;
    const lineage = await loadFundedComparisonTrainingLineage(
      pool,
      "00000000-0000-4000-8000-000000000400",
    );
    expect(lineage.trainingSessionDates).toEqual(["2026-09-03", "2026-09-04"]);
    expect(lineage.trainingKnowledgeCutoffAt).toBe("2026-09-05T20:00:00.000Z");
    expect(lineage.trainingPartitionDigest).toBe(
      fundedExecutionTrainingPartitionDigest([...rowDigests, rowDigests[1]!]),
    );
    expect(lineage.trainingSessionDigest).toBe(
      contentHash(["2026-09-03", "2026-09-04"]),
    );
  });

  it("fails closed when the TRAIN lineage is empty or unordered", async () => {
    const emptyPool = {
      query: async () => ({ rows: [] }),
    } as unknown as Pool;
    await expect(
      loadFundedComparisonTrainingLineage(
        emptyPool,
        "00000000-0000-4000-8000-000000000400",
      ),
    ).rejects.toThrow(/no TRAIN-partition members/i);
    const unorderedPool = {
      query: async () => ({
        rows: [
          {
            session_date: "2026-09-04",
            label_available_at: "2026-09-04T20:00:00.000Z",
            row_digest: "1".repeat(64),
          },
          {
            session_date: "2026-09-03",
            label_available_at: "2026-09-03T20:00:00.000Z",
            row_digest: "2".repeat(64),
          },
        ],
      }),
    } as unknown as Pool;
    await expect(
      loadFundedComparisonTrainingLineage(
        unorderedPool,
        "00000000-0000-4000-8000-000000000400",
      ),
    ).rejects.toThrow(/not ordered by session date/i);
  });

  it("fails the whole batch closed for out-of-range or negative diagnostics", async () => {
    const decisions = new Map([
      ["source-1", decisionRow("observation-1", at)],
      ["source-2", decisionRow("observation-2", at)],
    ]);
    for (const override of [
      { expectedFillFraction: { value: 1.5 } },
      { expectedFillFraction: { value: -0.1 } },
      { expectedTotalExecutionCost: { value: -1 } },
      { expectedSlippagePerShare: { value: -0.5 } },
    ]) {
      const batch = await predictFundedComparisonBatch(request(decisions), {
        predictFundedExecution: async (payload) => {
          const output = inferenceOutput(payload);
          return {
            ...output,
            predictions: output.predictions.map((prediction) => ({
              ...prediction,
              output: {
                ...prediction.output,
                ...(override.expectedFillFraction
                  ? {
                      expectedFillFraction: {
                        ...prediction.output.expectedFillFraction,
                        ...override.expectedFillFraction,
                      },
                    }
                  : {}),
                ...(override.expectedTotalExecutionCost
                  ? {
                      expectedTotalExecutionCost: {
                        ...prediction.output.expectedTotalExecutionCost,
                        ...override.expectedTotalExecutionCost,
                      },
                    }
                  : {}),
                ...(override.expectedSlippagePerShare
                  ? {
                      expectedSlippagePerShare: {
                        ...prediction.output.expectedSlippagePerShare,
                        ...override.expectedSlippagePerShare,
                      },
                    }
                  : {}),
              },
            })),
          };
        },
      });
      // A diagnostic outside the frozen units is never admitted: whether the
      // inference contract rejects it or the comparison range guard does, the
      // whole batch stays fallback with no usable prediction.
      expect(batch.batchFallback).toBe(true);
      expect(batch.identities.size).toBe(0);
      expect(
        batch.candidates.every(
          (candidate) =>
            candidate.prediction === null &&
            candidate.unavailableReason !== null,
        ),
      ).toBe(true);
    }
  });
});
