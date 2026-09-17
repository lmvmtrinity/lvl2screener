import { describe, expect, it } from "vitest";
import {
  buildFundedCohortComponents,
  buildFundedDecisionDraft,
  type FundedDecisionInputs,
} from "../src/paper-bot/funded-decision-evidence.js";
import {
  decisionContentDigest,
  fundedCohortDigest,
} from "../src/paper-bot/funded-evidence-digest.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import type { PaperSignalObservation } from "../src/paper-bot/paper-bot-repository.js";
import type {
  AssumptionsSnapshot,
  QuoteFact,
  SignalFact,
  SizingContext,
} from "../src/paper-bot/types.js";

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 0,
  costs: {
    entryCommission: 0,
    exitCommission: 0,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency: "CAD",
    brokerPricingVersion: "paper-cost-policy-2026-09-04",
  },
  riskBudget: 250,
  maxNotional: 1_500,
  economics: {
    minNetRewardRisk: 1,
    minStopFrictionMultiple: 2,
    minTargetFrictionMultiple: 3,
    maxSpreadPct: 0.5,
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
};

const observation = {
  id: "00000000-0000-4000-8000-000000000001",
  sourceEventId: "00000000-0000-4000-8000-000000000002",
  sourceSignalId: null,
  setupInstanceId: null,
  instrumentId: "00000000-0000-4000-8000-000000000003",
  symbol: "TEST.TO",
  profileId: "00000000-0000-4000-8000-000000000004",
  profileName: "test",
  profileConfigId: "00000000-0000-4000-8000-000000000005",
  configVersion: "v1",
  profileParameters: {},
  strategyKey: "ORB_STANDARD",
  strategyVersion: "2026-09-01",
  signalTimestamp: "2026-09-15T14:28:00.000Z",
  score: 82,
  entryReference: 10.02,
  stopReference: 9.8,
  targetReference: 10.6,
  atr14: 0.22,
  featureSnapshot: {},
  reasonCodes: ["BREAKOUT"],
  sourceEventPayload: {},
  eligibilityStatus: "ELIGIBLE",
  eligibilityReason: null,
  marketId: "CA_TSX",
  createdAt: "2026-09-15T14:28:01.000Z",
  fundedContexts: [
    {
      signalKey: "MARKET_RELATIVE_STRENGTH",
      status: "STRONG",
      timestamp: "2026-09-15T14:28:00.000Z",
    },
  ],
} as unknown as PaperSignalObservation;

const signal: SignalFact = {
  entryReference: 10.02,
  stopReference: 9.8,
  targetReference: 10.6,
  atr14: 0.22,
  signalTimestamp: "2026-09-15T14:28:00.000Z",
};

const quote: QuoteFact = {
  timestamp: "2026-09-15T14:29:59.000Z",
  bid: 10.01,
  ask: 10.03,
  bidSize: 500,
  askSize: 400,
  sizeUnit: "SHARES",
  sizeMultiplier: 1,
  dataStatus: "REALTIME",
  actionable: true,
};

const sizingContext: SizingContext = {
  displayedSize: 400,
  maxDisplayedSizeParticipation: 0.25,
  maxSymbolNotional: 3_000,
  maxSectorNotional: 5_000,
  maxPortfolioRisk: 150,
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
  strategyKey: "ORB_STANDARD",
  maximumHoldingMinutes: 45,
  stalledBreakoutMinutes: 15,
  stalledBreakoutMinProgressR: 0.25,
};

const inputs = (
  overrides: Partial<FundedDecisionInputs> = {},
): FundedDecisionInputs => {
  const base: FundedDecisionInputs = {
    observation,
    order: {
      signal,
      assumptions,
      context: sizingContext,
      submittedAt: "2026-09-15T14:30:00.000Z",
    },
    requestedCapital: { maximumDebit: 1_500, maximumRisk: 250 },
    quote,
    context: {
      marketId: "CA_TSX",
      accountId: "00000000-0000-4000-8000-000000000006",
      runId: "00000000-0000-4000-8000-000000000007",
      sourceKind: "LIVE_PAPER",
      fundedPolicyVersion: "funded-policy-v1",
      executionModelVersion: "paper-execution-v3",
      featureVersion: "features-v1",
      runtimeVersion: "runtime-v1",
      costPolicyVersion: "paper-cost-policy-2026-09-04",
      participationVersion: "participation-v1",
      policy: fundedPolicy(0.25, 0, {
        maxOpenPositions: 3,
        maxTotalOpenRisk: 150,
        maxSymbolNotional: 3_000,
        maxSectorNotional: 5_000,
        requireFreshContext: true,
        contextRequirement: "MARKET_AND_SECTOR_REQUIRED",
        vetoOnWeakContext: true,
        maximumHoldingMinutes: 45,
        stalledBreakoutMinutes: 15,
        stalledBreakoutMinProgressR: 0.25,
      }),
      accountState: {
        cash: 10_000,
        reservedCash: 0,
        openRisk: 0,
        reservedRisk: 0,
        positionCount: 0,
        sectorExposure: {},
        dailyPnl: 0,
        entriesAllowed: true,
        cooldownActive: false,
        consecutiveStops: 0,
      },
    },
  };
  return {
    ...base,
    ...overrides,
    requestedCapital:
      "requestedCapital" in overrides
        ? overrides.requestedCapital!
        : base.requestedCapital,
  };
};

describe("funded decision builder", () => {
  it("is deterministic for the same decision-time inputs", () => {
    expect(buildFundedDecisionDraft(inputs())).toEqual(
      buildFundedDecisionDraft(inputs()),
    );
  });

  it("retains a decision record when the quote is unavailable", () => {
    const decision = buildFundedDecisionDraft(
      inputs({
        quote: null,
        context: {
          ...inputs().context,
          model: null,
        },
      }),
    );
    expect(decision.quote).toEqual({
      status: "UNAVAILABLE",
      reason: "No funded quote was retained at decision time",
    });
    expect(decision.model.status).toBe("UNAVAILABLE");
    expect(decisionContentDigest(decision)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves the exact execution inputs and policy thresholds", () => {
    const decision = buildFundedDecisionDraft(inputs());
    expect(decision.execution).toEqual({
      positionSize: 1_000,
      slippageBps: 2,
      feePerTrade: 0,
      costs: {
        entryCommission: 0,
        exitCommission: 0,
        estimatedRegulatoryFees: 0,
        slippageBps: 2,
        currency: "CAD",
        brokerPricingVersion: "paper-cost-policy-2026-09-04",
      },
      riskBudget: 250,
      maxNotional: 1_500,
      economics: {
        minNetRewardRisk: 1,
        minStopFrictionMultiple: 2,
        minTargetFrictionMultiple: 3,
        maxSpreadPct: 0.5,
      },
      stopMethod: "STRUCTURAL",
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
      executionMode: "CAPACITY_CONSTRAINED",
      latencyMs: 0,
      evidenceScope: null,
    });
    expect(decision.policy.portfolio).toMatchObject({
      maxOpenPositions: 3,
      maxTotalOpenRisk: 150,
      contextRequirement: "MARKET_AND_SECTOR_REQUIRED",
    });
    expect(decision.sizingContext).toMatchObject({
      displayedSize: 400,
      maxPortfolioRisk: 150,
      strategyKey: "ORB_STANDARD",
    });
    expect(decision.quote).toMatchObject({
      status: "AVAILABLE",
      snapshot: {
        dataStatus: "REALTIME",
        actionable: true,
        sizeUnit: "SHARES",
      },
    });
  });

  it("retains the exact requested capital constraints supplied with the signal", () => {
    const first = buildFundedDecisionDraft(inputs());
    expect(first.requestedCapital).toEqual({
      status: "AVAILABLE",
      maximumDebit: 1_500,
      maximumRisk: 250,
    });
    const second = buildFundedDecisionDraft(
      inputs({ requestedCapital: { maximumDebit: 1_500, maximumRisk: 500 } }),
    );
    expect(second.requestedCapital).toEqual({
      status: "AVAILABLE",
      maximumDebit: 1_500,
      maximumRisk: 500,
    });
    // Two otherwise identical facts with different capital constraints are not
    // economically identical; the content digest must separate them.
    expect(decisionContentDigest(first)).not.toBe(
      decisionContentDigest(second),
    );
    const declined = buildFundedDecisionDraft(
      inputs({
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        requestedCapital: null,
      }),
    );
    expect(declined.requestedCapital).toEqual({
      status: "UNAVAILABLE",
      reason: "No funded signal submission was retained for this decision",
    });
    expect(declined.evidenceSchemaVersion).toBe(2);
  });

  it("records absent legacy execution fields as null, not defaults", () => {
    const decision = buildFundedDecisionDraft(
      inputs({
        order: {
          signal,
          assumptions: {
            positionSize: 1_000,
            slippageBps: 0,
            feePerTrade: 0,
            stopMethod: "ATR",
            atrStopMultiple: 2,
            rewardRiskRatio: 2,
            maxQuoteAgeSeconds: 30,
            sessionTimezone: "America/Toronto",
            noonCloseTime: "16:00",
          },
          submittedAt: "2026-09-15T14:30:00.000Z",
        },
      }),
    );
    expect(decision.execution.costs).toBeNull();
    expect(decision.execution.riskBudget).toBeNull();
    expect(decision.execution.maxNotional).toBeNull();
    expect(decision.execution.economics).toBeNull();
    expect(decision.execution.executionMode).toBeNull();
    expect(decision.execution.latencyMs).toBeNull();
    expect(decision.sizingContext).toBeNull();
  });

  it("retains the model provenance when a prediction existed", () => {
    const decision = buildFundedDecisionDraft(
      inputs({
        context: {
          ...inputs().context,
          model: {
            modelId: "model-1",
            modelVersion: "v3",
            strategyName: "ORB_STANDARD",
            prediction: 0.62,
            inputDigest: "a".repeat(64),
            predictionAt: "2026-09-15T14:29:00.000Z",
          },
        },
      }),
    );
    expect(decision.model).toEqual({
      status: "AVAILABLE",
      modelId: "model-1",
      modelVersion: "v3",
      strategyName: "ORB_STANDARD",
      prediction: 0.62,
      inputDigest: "a".repeat(64),
      predictionAt: "2026-09-15T14:29:00.000Z",
    });
  });

  it("does not fabricate quote, context or digest values", () => {
    const decision = buildFundedDecisionDraft(
      inputs({
        observation: { ...observation, fundedContexts: [] },
      }),
    );
    expect(decision.context).toEqual({
      status: "UNAVAILABLE",
      reason: "No funded context was retained at decision time",
    });
    expect(decision.quote).toMatchObject({ status: "AVAILABLE" });
    expect(decision).not.toHaveProperty("contentDigest");
    expect(decision).not.toHaveProperty("capturedAt");
    expect(decision).not.toHaveProperty("decisionSequence");
  });

  it("carries cohort components without an embedded digest", () => {
    const components = (overrides: Record<string, unknown> = {}) =>
      buildFundedCohortComponents({
        marketId: "CA_TSX",
        sourceKind: "LIVE_PAPER",
        fundedPolicyVersion: "funded-policy-v1",
        portfolioPolicyVersion: "funded-portfolio-v2",
        executionModelVersion: "paper-execution-v3",
        costPolicyVersion: "paper-cost-policy-2026-09-04",
        participationVersion: "participation-v1",
        featureVersion: "features-v1",
        runtimeVersion: "runtime-v1",
        assumptions,
        signalModelId: null,
        signalModelVersion: null,
        ...overrides,
      });
    const base = components();
    expect(base).not.toHaveProperty("cohortDigest");
    const variants = [
      components({ marketId: "US_EQUITIES" }),
      components({ sourceKind: "HISTORICAL_REPLAY" }),
      components({ fundedPolicyVersion: "funded-policy-v2" }),
      components({ runtimeVersion: "runtime-v2" }),
      components({ signalModelId: "model-1", signalModelVersion: "v1" }),
      components({
        assumptions: { ...assumptions, riskBudget: 500 },
      }),
    ];
    const digests = variants.map((variant) => fundedCohortDigest(variant));
    expect(new Set(digests).size).toBe(variants.length);
    expect(digests).not.toContain(fundedCohortDigest(base));
    expect(fundedCohortDigest(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});
