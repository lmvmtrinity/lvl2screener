import { describe, expect, it } from "vitest";
import { createStatisticalModelSchema } from "../src/domains/statistical-models.js";
import {
  signalModelResearchAuthorizationRequestSchema,
  signalModelResearchPlanSchema,
} from "../src/domains/signal-model-research.js";

const hash = "a".repeat(64);
it("accepts captured-backtest research models only with their authorization identity", () => {
  const candidate = {
    name: "Signal research candidate ORB_RETEST",
    sourceKind: "CAPTURED_BACKTEST_RESEARCH",
    backtestRunId: "10000000-0000-4000-8000-000000000002",
    authorizationId: "10000000-0000-4000-8000-000000000004",
    planHash: hash,
    strategy: "ORB_RETEST",
    minimumSamples: 20,
  };
  expect(createStatisticalModelSchema.safeParse(candidate).success).toBe(true);
  expect(
    createStatisticalModelSchema.safeParse({
      ...candidate,
      authorizationId: undefined,
    }).success,
  ).toBe(false);
});
const plan = {
  version: "signal-model-experiment-v1",
  experimentId: "10000000-0000-4000-8000-000000000001",
  source: {
    runId: "10000000-0000-4000-8000-000000000002",
    marketId: "CA_TSX",
    strategy: "ORB_RETEST",
    strategyVersion: "v1",
    configVersion: "cfg1",
    profileId: "10000000-0000-4000-8000-000000000003",
    profileName: "research-profile",
    executionModelVersion: "paper-execution-v7",
    executionAssumptionsHash: hash,
    sourceDigest: hash,
    sourceBindingHash: hash,
    orderedMembershipHash: hash,
    orderedMembershipCount: 3,
  },
  sessions: {
    TRAIN: ["2026-01-05", "2026-01-06"],
    VALIDATION: ["2026-01-09", "2026-01-12"],
    TEST: ["2026-01-15", "2026-01-16"],
  },
  membership: {
    TRAIN: {
      opportunityIds: ["20000000-0000-4000-8000-000000000001"],
      membershipHash: hash,
    },
    VALIDATION: {
      opportunityIds: ["20000000-0000-4000-8000-000000000002"],
      membershipHash: hash,
    },
    TEST: {
      opportunityIds: ["20000000-0000-4000-8000-000000000003"],
      membershipHash: hash,
    },
  },
  overlapPurge: {
    labelHorizonSessions: 1,
    trainValidationPurgeSessions: ["2026-01-07"],
    validationTestPurgeSessions: ["2026-01-13"],
  },
  model: {
    minimumTrainingSamples: 20,
    thresholdCandidates: [0, 50, 90],
    l2Penalty: 0.1,
  },
  comparison: {
    minimumUsefulNetPnlPerSelectedOpportunity: 0.25,
    unit: "CAD",
    alpha: 0.05,
    targetPower: 0.8,
    minimumIndependentSessions: 6,
    minimumValidationSessions: 2,
    minimumClosedOutcomes: 20,
    maximumMissedWinnerRate: 0.25,
    maximumDrawdownIncrease: 100,
    maximumTurnoverIncrease: 0.1,
    maximumLargestSymbolShare: 0.5,
    maximumLargestSessionShare: 0.5,
    bootstrapSamples: 1000,
    blockLength: 2,
    seed: 17,
    extraCostScenarios: [{ extraSlippageBps: 5, extraFeePerTrade: 0.02 }],
  },
  trialBudget: 10,
};

describe("inactive signal-model research contracts", () => {
  it("accepts a frozen market/source plan with purged chronological windows", () => {
    expect(signalModelResearchPlanSchema.parse(plan)).toEqual(plan);
  });

  it("rejects stage overlap and a claimed execute mode without exact plan/source scope", () => {
    expect(() =>
      signalModelResearchPlanSchema.parse({
        ...plan,
        sessions: { ...plan.sessions, VALIDATION: ["2026-01-06"] },
      }),
    ).toThrow();
    expect(() =>
      signalModelResearchAuthorizationRequestSchema.parse({
        authorization: {
          id: "10000000-0000-4000-8000-000000000004",
          marketId: "CA_TSX",
          frozenPlanHash: hash,
          sourceDigest: hash,
          sourceBindingHash: hash,
          expiresAt: "2027-01-01T00:00:00Z",
          trialBudget: 10,
          mode: "EXECUTE_WHEN_READY",
        },
        plan,
      }),
    ).not.toThrow();
    expect(() =>
      signalModelResearchAuthorizationRequestSchema.parse({
        authorization: {
          id: "10000000-0000-4000-8000-000000000004",
          marketId: "US_EQUITIES",
          frozenPlanHash: hash,
          sourceDigest: hash,
          sourceBindingHash: hash,
          expiresAt: "2027-01-01T00:00:00Z",
          trialBudget: 10,
          mode: "EXECUTE_WHEN_READY",
        },
        plan,
      }),
    ).toThrow();
  });
});
