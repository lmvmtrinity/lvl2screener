import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  FundedComparisonChampionError,
  fundedComparisonChampionFromSource,
  portfolioPolicyVersionOf,
  resolveFundedComparisonChampion,
  riskConfigurationDigestOf,
  verifyChallengerBinding,
  verifyChampionBinding,
  type FundedComparisonChampionSource,
} from "../src/paper-bot/funded-comparison-champion.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { executionAssumptionsEvidence } from "../src/paper-bot/funded-decision-evidence.js";
import { accountAssumptionDigest } from "../src/paper-bot/funded-evidence-digest.js";

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

function source(
  overrides: Partial<FundedComparisonChampionSource> = {},
): FundedComparisonChampionSource {
  return {
    marketId: "CA_TSX",
    currency: "CAD",
    sourceRunId: "00000000-0000-4000-8000-000000000001",
    sourceAccountId: "00000000-0000-4000-8000-000000000002",
    status: "RUNNING",
    policy: fundedPolicy(1, 0),
    assumptions,
    executionModelVersion: "execution-v1",
    initialCash: 25_000,
    dailyLossLimit: 2_500,
    ...overrides,
  };
}

function fakePool(row: Record<string, unknown> | undefined): Pool {
  return {
    query: async () => ({ rows: row ? [row] : [] }),
  } as unknown as Pool;
}

describe("funded comparison champion resolution", () => {
  it("derives a stable champion identity and capital from durable rows", () => {
    const resolved = fundedComparisonChampionFromSource(source());
    expect(resolved.champion.kind).toBe("DETERMINISTIC_FUNDED_POLICY");
    expect(resolved.champion.portfolioPolicyVersion).toBe(
      "funded-portfolio-v2",
    );
    expect(resolved.champion.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.champion.accountAssumptionDigest).toBe(
      accountAssumptionDigest(executionAssumptionsEvidence(assumptions)),
    );
    expect(resolved.capital).toEqual({
      initialCash: 25_000,
      dailyLossLimit: 2_500,
      riskConfigurationDigest: riskConfigurationDigestOf(
        25_000,
        2_500,
        fundedPolicy(1, 0).portfolio,
      ),
    });
    const again = fundedComparisonChampionFromSource(source());
    expect(again.champion).toEqual(resolved.champion);
    expect(again.capital).toEqual(resolved.capital);
  });

  it("records the legacy portfolio shape without inventing v2 fields", () => {
    const legacy = fundedPolicy(1, 0);
    delete (legacy as { portfolio?: unknown }).portfolio;
    expect(portfolioPolicyVersionOf(legacy)).toBe("funded-portfolio-v1-legacy");
    const resolved = fundedComparisonChampionFromSource(
      source({ policy: legacy }),
    );
    expect(resolved.champion.portfolioPolicyVersion).toBe(
      "funded-portfolio-v1-legacy",
    );
    expect(resolved.capital.riskConfigurationDigest).toBe(
      riskConfigurationDigestOf(25_000, 2_500, undefined),
    );
  });

  it("changes the frozen digest when the persisted policy or capital changes", () => {
    const baseline = fundedComparisonChampionFromSource(source()).champion;
    const changedPolicy = fundedComparisonChampionFromSource(
      source({ policy: fundedPolicy(0.5, 0) }),
    ).champion;
    expect(changedPolicy.policyDigest).not.toBe(baseline.policyDigest);
    expect(changedPolicy.participationVersion).not.toBe(
      baseline.participationVersion,
    );
    const changedCapital = fundedComparisonChampionFromSource(
      source({ initialCash: 30_000 }),
    );
    expect(changedCapital.champion).toEqual(baseline);
    expect(changedCapital.capital.initialCash).toBe(30_000);
    expect(changedCapital.capital.riskConfigurationDigest).not.toBe(
      fundedComparisonChampionFromSource(source()).capital
        .riskConfigurationDigest,
    );
  });

  it("prefers the active LIVE run and falls back to the newest completed one", async () => {
    const resolved = await resolveFundedComparisonChampion(
      fakePool({
        run_id: "run-1",
        status: "CLOSE_PENDING",
        execution_model_version: "execution-v1",
        assumptions,
        policy: fundedPolicy(1, 0),
        account_id: source().sourceAccountId,
        currency: "CAD",
        initial_state: { cash: 25_000, dailyLossLimit: 2_500, currency: "CAD" },
      }),
      "CA_TSX",
      source().sourceAccountId,
    );
    expect(resolved.source.status).toBe("CLOSE_PENDING");
    expect(resolved.source.sourceRunId).toBe("run-1");
  });

  it("fails CHAMPION_NOT_RETAINED without a retained LIVE run", async () => {
    await expect(
      resolveFundedComparisonChampion(
        fakePool(undefined),
        "CA_TSX",
        source().sourceAccountId,
      ),
    ).rejects.toThrow(FundedComparisonChampionError);
  });

  it("rejects a market/currency mismatch", () => {
    expect(() =>
      fundedComparisonChampionFromSource(source({ currency: "USD" })),
    ).toThrow(/another market or currency/i);
  });

  it("rechecks champion and challenger bindings before side effects", () => {
    const { champion } = fundedComparisonChampionFromSource(source());
    const specification = {
      marketId: "CA_TSX" as const,
      currency: "CAD" as const,
      champion,
      challenger: {
        kind: "FUNDED_EXECUTION_POLICY_V1" as const,
        policyVersion:
          "funded-comparison-execution-quality-ordering-v1" as const,
        policyDigest: "d".repeat(64),
        model: {
          modelId: "model-1",
          modelVersion: "funded-execution-v1",
          artifactDigest: "a".repeat(64),
          datasetDigest: "b".repeat(64),
          cohortDigest: "c".repeat(64),
          featureVersion: "funded-execution-features-v1" as const,
          predictionPolicyVersion: "funded-execution-prediction-v1",
          trainingPartitionDigest: "a".repeat(64),
          trainingEvidenceCutoffAt: "2026-09-11T20:00:00.000Z",
          trainingSessionDigest: "b".repeat(64),
        },
      },
    };
    const binding = {
      specId: "spec-1",
      side: "CHAMPION" as const,
      sessionDate: "2026-09-15",
      runId: "run-1",
      accountId: "account-1",
      marketId: "CA_TSX" as const,
      currency: "CAD" as const,
      policyDigest: champion.policyDigest,
      executionModelVersion: champion.executionModelVersion,
      accountAssumptionDigest: champion.accountAssumptionDigest,
      boundAt: "2026-09-15T13:30:00.000Z",
    };
    expect(() => verifyChampionBinding(specification, binding)).not.toThrow();
    expect(() =>
      verifyChampionBinding(specification, {
        ...binding,
        policyDigest: "e".repeat(64),
      }),
    ).toThrow(/champion binding/i);
    expect(() =>
      verifyChampionBinding(specification, {
        ...binding,
        side: "CHALLENGER",
      }),
    ).toThrow(/champion binding/i);
    const challengerBinding = {
      ...binding,
      side: "CHALLENGER" as const,
      policyDigest: specification.challenger.policyDigest,
    };
    expect(() =>
      verifyChallengerBinding(specification, challengerBinding),
    ).not.toThrow();
    expect(() =>
      verifyChallengerBinding(specification, {
        ...challengerBinding,
        policyDigest: "e".repeat(64),
      }),
    ).toThrow(/challenger binding/i);
  });
});
