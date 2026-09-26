import { expect, it, vi } from "vitest";
import type {
  BacktestRun,
  BacktestTrade,
  StatisticalPredictionInput,
} from "@tsx-scanner/contracts";
import {
  SignalModelCandidateService,
  signalModelTestMembershipHash,
  type FinalTestClaimVerifier,
  type SignalModelOpportunity,
  type SignalModelCandidateInput,
} from "../src/backtests/signal-model-candidate.js";
import type { StatisticalModelEngine } from "../src/statistical-models/statistical-model-service.js";
import { buildCapturedResearchProspectiveScope } from "../src/backtests/signal-model-candidate-handoff.js";

it("requires one retained, explicit signal semantics version for prospective scope", () => {
  const scope = {
    marketId: "CA_TSX" as const,
    strategy: "ORB_RETEST" as const,
    strategyVersion: "strategy-v1",
    profileId: "00000000-0000-4000-8000-000000000001",
    configVersion: "config-v1",
    executionModelVersion: "paper-execution-v7",
    executionAssumptionsHash: "a".repeat(64),
  };
  expect(
    buildCapturedResearchProspectiveScope({
      ...scope,
      signalSemanticsVersions: ["setup-semantics-v2", "setup-semantics-v2"],
    }),
  ).toMatchObject({
    marketId: "CA_TSX",
    currency: "CAD",
    signalSemanticsVersion: "setup-semantics-v2",
    replayScope: "FORWARD_LIVE",
  });
  expect(() =>
    buildCapturedResearchProspectiveScope({
      ...scope,
      signalSemanticsVersions: [null, "setup-semantics-v2"],
    }),
  ).toThrow("SIGNAL_MODEL_CANDIDATE_SEMANTICS_UNPROVEN");
  expect(() =>
    buildCapturedResearchProspectiveScope({
      ...scope,
      signalSemanticsVersions: ["setup-semantics-v2", "setup-semantics-v1"],
    }),
  ).toThrow("SIGNAL_MODEL_CANDIDATE_SEMANTICS_MISMATCH");
});

const runId = "10000000-0000-4000-8000-000000000001";
const marketId = "CA_TSX" as const;
const sessions = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];

function trade(id: string, date: string, pnl: number): BacktestTrade {
  return {
    id,
    runId,
    instrumentId: "20000000-0000-4000-8000-000000000001",
    symbol: id.startsWith("A") ? "AAA" : "BBB",
    strategy: "ORB_RETEST",
    strategyVersion: "v1",
    configVersion: "c1",
    signalTimestamp: `${date}T10:00:00.000Z`,
    score: pnl > 0 ? 80 : 50,
    entryTime: `${date}T10:01:00.000Z`,
    entryPrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    exitTime: `${date}T10:30:00.000Z`,
    exitPrice: pnl > 0 ? 11 : 9,
    shares: 10,
    exitReason: pnl > 0 ? "TARGET" : "STOP",
    grossPnl: pnl + 1,
    netPnl: pnl,
    rMultiple: pnl / 10,
    holdMinutes: 29,
    reasonCodes: [],
    sector: null,
    atrPct: 1,
    rvolAtTime: 1,
    contextScore: 50,
    contexts: [],
  } as BacktestTrade;
}

function opportunity(
  id: string,
  stage: "TRAIN" | "VALIDATION" | "TEST",
  date: string,
  pnl: number,
): SignalModelOpportunity {
  const value = trade(id, date, pnl);
  return {
    opportunityId: id,
    stage,
    sessionDate: date,
    symbol: value.symbol,
    baselineSelected: true,
    evidenceSource: { sourceRunId: runId, evidenceId: `evidence-${id}` },
    predictionInput: {
      marketId,
      instrumentId: value.instrumentId,
      symbol: value.symbol,
      timestamp: value.signalTimestamp,
      profileId: "30000000-0000-4000-8000-000000000001",
      profileName: "fixture",
      strategy: value.strategy,
      deterministicScore: value.score,
      atrPct: value.atrPct,
      rvolAtTime: value.rvolAtTime,
    },
    outcome: { status: "CLOSED", trade: value },
  };
}

function input(): SignalModelCandidateInput {
  const testOpportunities = [
    opportunity("test-a", "TEST", sessions[2]!, 5),
    opportunity("test-b", "TEST", sessions[3]!, -5),
  ];
  const opportunities = [
    ...Array.from({ length: 20 }, (_, index) =>
      opportunity(
        `train-${index}`,
        "TRAIN",
        sessions[0]!,
        index % 2 === 0 ? 1 : -1,
      ),
    ),
    opportunity("validation-a", "VALIDATION", sessions[1]!, 10),
    opportunity("validation-b", "VALIDATION", sessions[1]!, -10),
  ];
  return {
    source: {
      id: runId,
      status: "COMPLETED",
      marketId,
      dataSource: "CAPTURED_QUOTES",
      executionModelVersion: "paper-execution-v7",
      strategies: ["ORB_RETEST"],
      dataQuality: { spread: "CAPTURED" },
      trades: opportunities.flatMap((row) =>
        row.outcome.status === "CLOSED" ? [row.outcome.trade] : [],
      ),
    } as unknown as BacktestRun,
    strategy: "ORB_RETEST",
    coverageStatus: "VERIFIED",
    lineageStatus: "VERIFIED",
    expectedSessions: {
      TRAIN: [sessions[0]!],
      VALIDATION: [sessions[1]!],
      TEST: [sessions[2]!, sessions[3]!],
    },
    expectedOpportunityIds: {
      TRAIN: Array.from({ length: 20 }, (_, index) => `train-${index}`),
      VALIDATION: ["validation-a", "validation-b"],
      TEST: ["test-a", "test-b"],
    },
    opportunities,
    loadTestOpportunities: vi.fn(async () => ({
      opportunities: testOpportunities,
      persistedTrades: testOpportunities.flatMap((row) =>
        row.outcome.status === "CLOSED" ? [row.outcome.trade] : [],
      ),
    })),
    minimumTrainingSamples: 20,
    thresholdCandidates: [0, 50, 90],
    expectedTestMembershipHash: signalModelTestMembershipHash({
      sourceRunId: runId,
      marketId,
      sessionDates: [sessions[2]!, sessions[3]!],
      opportunityIds: ["test-a", "test-b"],
    }),
    finalTestClaimId: "claim-1",
  };
}

function engine(): StatisticalModelEngine {
  return {
    trainStatistical: vi.fn(async () => ({
      status: "COMPLETED",
      artifact: {
        artifactVersion: "1.0.0",
        modelType: "LOGISTIC_SETUP_QUALITY",
        featureNames: [
          "deterministicScore",
          "atrPct",
          "logRvolAtTime",
          "minutesFromOpen",
        ],
        intercept: 0,
        coefficients: [0, 0, 0, 0],
        means: [0, 0, 0, 0],
        scales: [1, 1, 1, 1],
        medians: [0, 0, 0, 0],
        atrMedian: 0,
        rvolMedian: 0,
      },
      eligibleForActivation: true,
      train: null,
      test: null,
      calibration: [],
      warnings: [],
      trainingStart: null,
      trainingEnd: null,
      testStart: null,
      testEnd: null,
    })),
    predictStatistical: vi.fn(
      async ({ inputs }: { inputs: StatisticalPredictionInput[] }) => ({
        predictions: inputs.map((value) => ({
          ...value,
          setupProbability: value.deterministicScore === 80 ? 0.9 : 0.1,
          falseBreakoutProbability: value.deterministicScore === 80 ? 0.1 : 0.9,
          rankingScore: value.deterministicScore === 80 ? 90 : 10,
          regime: { atr: "LOW", rvol: "LOW", combined: "ATR_LOW__RVOL_LOW" },
          contributions: {},
          warnings: [],
        })),
      }),
    ),
  } as unknown as StatisticalModelEngine;
}

function gate(
  overrides: Partial<FinalTestClaimVerifier> = {},
): FinalTestClaimVerifier {
  return {
    consumeFinalTestClaim: vi.fn(async (request) => ({
      claimId: request.claimId,
      sourceRunId: request.sourceRunId,
      marketId: request.marketId,
      membershipHash: request.membershipHash,
    })),
    ...overrides,
  };
}

it("fits only TRAIN, selects threshold on VALIDATION, then consumes TEST claim once and stays inactive", async () => {
  const trainer = engine();
  const value = input();
  const testWinner = (await value.loadTestOpportunities()).opportunities.find(
    (row) => row.opportunityId === "test-a",
  )!;
  if (testWinner.outcome.status !== "CLOSED") throw new Error("bad fixture");
  testWinner.outcome.trade.netPnl = -5;
  testWinner.outcome.trade.grossPnl = -4;
  testWinner.outcome.trade.rMultiple = -0.5;
  testWinner.outcome.trade.exitReason = "STOP";
  testWinner.outcome.trade.exitPrice = 9;
  const finalTestGate = gate();
  const result = await new SignalModelCandidateService(
    trainer,
    finalTestGate,
  ).evaluate(value);
  const fitPayload = vi.mocked(trainer.trainStatistical).mock.calls[0]![0] as {
    trades: BacktestTrade[];
  };

  expect(fitPayload.trades.map((value) => value.id)).toEqual(
    Array.from({ length: 20 }, (_, index) => `train-${index}`),
  );
  expect(result.threshold).toBe(90);
  expect(result.status).toBe("TESTED_INACTIVE");
  expect(result.active).toBe(false);
  expect(result.eligibleForActivation).toBe(false);
  expect(result.evaluation.denominators.matchedOpportunities).toBe(2);
  expect(result.evaluation.candidate.netPnl).toBe(-5);
  expect(finalTestGate.consumeFinalTestClaim).toHaveBeenCalledTimes(1);
  expect(value.loadTestOpportunities).toHaveBeenCalledTimes(2);
  expect(finalTestGate.consumeFinalTestClaim).toHaveBeenCalledWith({
    claimId: "claim-1",
    sourceRunId: runId,
    marketId,
    membershipHash: value.expectedTestMembershipHash,
  });
});

it("loads TEST membership only after the durable claim is consumed", async () => {
  const value = input();
  const preparedTest = await value.loadTestOpportunities();
  const order: string[] = [];
  value.loadTestOpportunities = vi.fn(async () => {
    order.push("load-test");
    return preparedTest;
  });
  const verifier = gate({
    consumeFinalTestClaim: vi.fn(async (request) => {
      order.push("consume-claim");
      return request;
    }),
  });
  await new SignalModelCandidateService(engine(), verifier).evaluate(value);
  expect(order).toEqual(["consume-claim", "load-test"]);
});

it("rejects cross-market opportunities before fitting", async () => {
  const trainer = engine();
  const value = input();
  value.opportunities[0]!.predictionInput.marketId = "US_EQUITIES";
  await expect(
    new SignalModelCandidateService(trainer, gate()).evaluate(value),
  ).rejects.toThrow("MARKET_MISMATCH");
  expect(trainer.trainStatistical).not.toHaveBeenCalled();
});

it("fails closed when an outcome source identity is absent", async () => {
  const trainer = engine();
  const value = input();
  value.opportunities[0]!.evidenceSource = {
    sourceRunId: runId,
    evidenceId: "",
  };
  await expect(
    new SignalModelCandidateService(trainer, gate()).evaluate(value),
  ).rejects.toThrow("OUTCOME_SOURCE_IDENTITY_REQUIRED");
  expect(trainer.trainStatistical).not.toHaveBeenCalled();
});

it("does not call the evaluator when final-test claim is missing", async () => {
  const trainer = engine();
  const value = input();
  value.finalTestClaimId = null;
  const finalTestGate = gate();
  await expect(
    new SignalModelCandidateService(trainer, finalTestGate).evaluate(value),
  ).rejects.toThrow("FINAL_TEST_CLAIM_REQUIRED");
  expect(trainer.predictStatistical).toHaveBeenCalledTimes(1);
  expect(finalTestGate.consumeFinalTestClaim).not.toHaveBeenCalled();
});

it("rejects a final-test claim for different frozen membership before reading TEST", async () => {
  const trainer = engine();
  const value = input();
  const finalTestGate = gate({
    consumeFinalTestClaim: vi.fn(async (request) => ({
      ...request,
      membershipHash: "different-test-membership",
    })),
  });
  await expect(
    new SignalModelCandidateService(trainer, finalTestGate).evaluate(value),
  ).rejects.toThrow("FINAL_TEST_CLAIM_INVALID");
  expect(trainer.predictStatistical).toHaveBeenCalledTimes(1);
  expect(value.loadTestOpportunities).not.toHaveBeenCalled();
});

it("requires source run identity for no-fill and invalid outcomes", async () => {
  for (const status of ["NO_FILL", "INVALID"] as const) {
    const trainer = engine();
    const value = input();
    const row = (await value.loadTestOpportunities()).opportunities.find(
      (item) => item.opportunityId === "test-b",
    )!;
    row.outcome =
      status === "NO_FILL"
        ? { status, reason: "NO_EXECUTABLE_QUOTE" }
        : { status, reason: "UNPROVEN_OUTCOME" };
    row.evidenceSource.sourceRunId = "foreign-run";
    await expect(
      new SignalModelCandidateService(trainer, gate()).evaluate(value),
    ).rejects.toThrow("OUTCOME_SOURCE_IDENTITY_REQUIRED");
    expect(trainer.trainStatistical).toHaveBeenCalledTimes(1);
  }
});

it("rejects training labels unavailable when validation begins", async () => {
  const trainer = engine();
  const value = input();
  const trainingTrade = value.opportunities[0]!.outcome;
  if (trainingTrade.status !== "CLOSED") throw new Error("bad fixture");
  trainingTrade.trade.exitTime = `${sessions[1]}T10:00:00.000Z`;
  await expect(
    new SignalModelCandidateService(trainer, gate()).evaluate(value),
  ).rejects.toThrow("TRAIN_LABEL_UNAVAILABLE_BEFORE_VALIDATION");
  expect(trainer.trainStatistical).not.toHaveBeenCalled();
});

it("rejects validation labels unavailable when TEST begins", async () => {
  const trainer = engine();
  const value = input();
  const validationTrade = value.opportunities.find(
    (row) => row.stage === "VALIDATION",
  )!.outcome;
  if (validationTrade.status !== "CLOSED") throw new Error("bad fixture");
  validationTrade.trade.exitTime = `${sessions[2]}T10:00:00.000Z`;
  await expect(
    new SignalModelCandidateService(trainer, gate()).evaluate(value),
  ).rejects.toThrow("VALIDATION_LABEL_UNAVAILABLE_BEFORE_TEST");
  expect(trainer.trainStatistical).not.toHaveBeenCalled();
});

it("fails closed when a selected validation outcome is invalid", async () => {
  const trainer = engine();
  const value = input();
  const row = value.opportunities.find(
    (item) => item.opportunityId === "validation-b",
  )!;
  row.outcome = { status: "INVALID", reason: "UNPROVEN_OUTCOME" };
  const finalTestGate = gate();
  await expect(
    new SignalModelCandidateService(trainer, finalTestGate).evaluate(value),
  ).rejects.toThrow("VALIDATION_SELECTED_OUTCOME_INVALID");
  expect(trainer.predictStatistical).toHaveBeenCalledTimes(1);
  expect(finalTestGate.consumeFinalTestClaim).not.toHaveBeenCalled();
});

it("rejects swapped predictions when the same symbol has different identities", async () => {
  const trainer = engine();
  const basePredict = trainer.predictStatistical;
  const finalTestGate = gate();
  const value = input();
  const first = value.opportunities.find(
    (row) => row.opportunityId === "validation-a",
  )!;
  const second = value.opportunities.find(
    (row) => row.opportunityId === "validation-b",
  )!;
  second.symbol = first.symbol;
  second.predictionInput.symbol = first.symbol;
  second.predictionInput.instrumentId = "20000000-0000-4000-8000-000000000002";
  second.predictionInput.timestamp = `${sessions[1]}T10:02:00.000Z`;
  trainer.predictStatistical = vi.fn(async (payload) => {
    const result = await basePredict(payload);
    if (payload.inputs[0]?.symbol !== payload.inputs[1]?.symbol) return result;
    return { predictions: [...result.predictions].reverse() };
  });
  await expect(
    new SignalModelCandidateService(trainer, finalTestGate).evaluate(value),
  ).rejects.toThrow("PREDICTION_IDENTITY_MISMATCH");
  expect(finalTestGate.consumeFinalTestClaim).not.toHaveBeenCalled();
});
