import { describe, expect, it } from "vitest";
import {
  fundedCohortComponentsSchema,
  fundedCohortIdentitySchema,
  fundedDecisionActionSchema,
  fundedDecisionContextSchema,
  fundedDecisionEvidenceIdentitySchema,
  fundedDecisionModelSchema,
  fundedDecisionPortfolioSchema,
  fundedDecisionQuoteSchema,
  fundedDecisionTimeInputSchema,
  fundedEconomicsGatesSchema,
  fundedOutcomeDetailSchema,
  fundedOutcomeStatusSchema,
  fundedOutcomeVersionSchema,
  fundedSourceKindSchema,
} from "../src/domains/funded-learning-evidence.js";

const identity = {
  marketId: "CA_TSX",
  currency: "CAD",
  accountId: "account-1",
  runId: "run-1",
  observationId: "observation-1",
  decisionSequence: 1,
  fundedPolicyVersion: "funded-policy-v1",
  executionModelVersion: "paper-execution-v3",
  featureVersion: "features-v1",
} as const;

const decisionInput = {
  marketId: "CA_TSX",
  currency: "CAD",
  accountId: "account-1",
  runId: "run-1",
  observationId: "observation-1",
  evidenceSchemaVersion: 2,
  fundedPolicyVersion: "funded-policy-v1",
  executionModelVersion: "paper-execution-v3",
  featureVersion: "features-v1",
  sourceKind: "LIVE_PAPER",
  action: "SUBMIT",
  policyReason: null,
  decisionAt: "2026-09-15T14:30:00.000Z",
  strategyKey: "ORB_STANDARD",
  strategyVersion: "2026-09-01",
  score: 82,
  reasonCodes: ["BREAKOUT"],
  requestedCapital: {
    status: "AVAILABLE",
    maximumDebit: 1_500,
    maximumRisk: 250,
  },
  quote: {
    status: "AVAILABLE",
    snapshot: {
      timestamp: "2026-09-15T14:29:59.000Z",
      bid: 10.01,
      ask: 10.03,
      bidSize: 500,
      askSize: 400,
      sizeUnit: "SHARES",
      sizeMultiplier: 1,
      dataStatus: "REALTIME",
      actionable: true,
    },
  },
  model: { status: "UNAVAILABLE", reason: "No signal model was active" },
  portfolio: {
    status: "AVAILABLE",
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
  context: { status: "UNAVAILABLE", reason: "No context was retained" },
  execution: {
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
  },
  sizingContext: {
    displayedSize: 400,
    openSymbolNotional: null,
    openSectorNotional: null,
    openPortfolioRisk: null,
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
  },
  policy: {
    projectionVersion: "funded-cash-v1",
    participation: 0.25,
    impactBps: 0,
    latencyPolicy: "CAPTURED_PER_ORDER",
    portfolio: {
      version: "funded-portfolio-v2",
      maxOpenPositions: 3,
      maxTotalOpenRisk: 150,
      maxSymbolNotional: 3_000,
      maxSectorNotional: 5_000,
      cooldownMinutesAfterStop: 15,
      maxConsecutiveStops: 3,
      requireFreshContext: true,
      contextMaxAgeSeconds: 300,
      vetoOnWeakContext: true,
      contextRequirement: "MARKET_AND_SECTOR_REQUIRED",
      maximumHoldingMinutes: 45,
      maximumHoldingMinutesByStrategy: null,
      stalledBreakoutMinutes: 15,
      stalledBreakoutMinProgressR: 0.25,
    },
  },
  signal: {
    signalTimestamp: "2026-09-15T14:28:00.000Z",
    entryReference: 10.02,
    stopReference: 9.8,
    targetReference: 10.6,
    atr14: 0.22,
  },
} as const;

describe("funded decision evidence contracts", () => {
  it("accepts the exact identity and rejects an invalid sequence", () => {
    expect(fundedDecisionEvidenceIdentitySchema.parse(identity)).toEqual(
      identity,
    );
    expect(
      fundedDecisionEvidenceIdentitySchema.safeParse({
        ...identity,
        decisionSequence: 0,
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionEvidenceIdentitySchema.safeParse({
        ...identity,
        marketId: "CA_TSX",
        currency: "USD",
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionEvidenceIdentitySchema.safeParse({
        ...identity,
        marketId: "US_EQUITIES",
        currency: "USD",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown identity fields", () => {
    expect(
      fundedDecisionEvidenceIdentitySchema.safeParse({
        ...identity,
        outcome: "FILLED",
      }).success,
    ).toBe(false);
  });

  it("requires available timestamps at or before the decision time", () => {
    expect(fundedDecisionTimeInputSchema.parse(decisionInput)).toEqual(
      decisionInput,
    );
    expect(
      fundedDecisionTimeInputSchema.safeParse({
        ...decisionInput,
        quote: {
          status: "AVAILABLE",
          snapshot: {
            ...decisionInput.quote.snapshot,
            timestamp: "2026-09-15T14:31:00.000Z",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionTimeInputSchema.safeParse({
        ...decisionInput,
        signal: {
          ...decisionInput.signal,
          signalTimestamp: "2026-09-15T14:31:00.000Z",
        },
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionTimeInputSchema.safeParse({
        ...decisionInput,
        model: {
          status: "AVAILABLE",
          modelId: "model-1",
          modelVersion: "v1",
          strategyName: "ORB_STANDARD",
          prediction: 0.6,
          inputDigest: "a".repeat(64),
          predictionAt: "2026-09-15T14:31:00.000Z",
        },
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionTimeInputSchema.safeParse({
        ...decisionInput,
        context: {
          status: "AVAILABLE",
          contexts: [
            {
              signalKey: "MARKET_RELATIVE_STRENGTH",
              status: "STRONG",
              timestamp: "2026-09-15T14:31:00.000Z",
            },
          ],
          contextStatus: "STRONG",
          contextTimestamp: null,
        },
      }).success,
    ).toBe(false);
  });

  it("retains a decision record when the quote is unavailable", () => {
    const unavailable = {
      ...decisionInput,
      quote: {
        status: "UNAVAILABLE",
        reason: "No quote was retained at decision time",
      },
    } as const;
    expect(fundedDecisionTimeInputSchema.safeParse(unavailable).success).toBe(
      true,
    );
  });

  it("retains the exact supplied capital constraints and an explicit absence", () => {
    const parsed = fundedDecisionTimeInputSchema.parse(decisionInput);
    expect(parsed.requestedCapital).toEqual({
      status: "AVAILABLE",
      maximumDebit: 1_500,
      maximumRisk: 250,
    });
    expect(
      fundedDecisionTimeInputSchema.safeParse({
        ...decisionInput,
        requestedCapital: {
          status: "AVAILABLE",
          maximumDebit: 0,
          maximumRisk: 250,
        },
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionTimeInputSchema.safeParse({
        ...decisionInput,
        requestedCapital: {
          status: "AVAILABLE",
          maximumDebit: 1_500,
          maximumRisk: -1,
        },
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionTimeInputSchema.safeParse({
        ...decisionInput,
        requestedCapital: { status: "UNAVAILABLE" },
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionTimeInputSchema.parse({
        ...decisionInput,
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        requestedCapital: {
          status: "UNAVAILABLE",
          reason: "No funded signal submission was retained",
        },
      }).requestedCapital,
    ).toEqual({
      status: "UNAVAILABLE",
      reason: "No funded signal submission was retained",
    });
  });

  it("enforces the v2 action, reason and capital pairing", () => {
    const availableCapital = {
      status: "AVAILABLE",
      maximumDebit: 1_500,
      maximumRisk: 250,
    } as const;
    const unavailableCapital = {
      status: "UNAVAILABLE",
      reason: "No funded signal submission was retained",
    } as const;
    const invalid = [
      // SUBMIT must not carry a refusal reason or lack supplied capital.
      {
        action: "SUBMIT",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        requestedCapital: availableCapital,
      },
      {
        action: "SUBMIT",
        policyReason: null,
        requestedCapital: unavailableCapital,
      },
      // DECLINE/DEFER must carry an exact reason and must not fabricate capital.
      {
        action: "DECLINE",
        policyReason: null,
        requestedCapital: unavailableCapital,
      },
      {
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        requestedCapital: availableCapital,
      },
      {
        action: "DEFER",
        policyReason: null,
        requestedCapital: unavailableCapital,
      },
      {
        action: "DEFER",
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
        requestedCapital: availableCapital,
      },
    ];
    for (const combination of invalid)
      expect(
        fundedDecisionTimeInputSchema.safeParse({
          ...decisionInput,
          ...combination,
        }).success,
        JSON.stringify(combination),
      ).toBe(false);
    // The valid pairings still parse exactly.
    expect(
      fundedDecisionTimeInputSchema.parse({
        ...decisionInput,
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        requestedCapital: unavailableCapital,
      }),
    ).toMatchObject({ action: "DECLINE" });
    expect(
      fundedDecisionTimeInputSchema.parse({
        ...decisionInput,
        action: "DEFER",
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
        requestedCapital: unavailableCapital,
      }),
    ).toMatchObject({ action: "DEFER" });
  });

  it("requires the versioned evidence schema marker", () => {
    const { evidenceSchemaVersion: _version, ...withoutVersion } =
      decisionInput;
    expect(
      fundedDecisionTimeInputSchema.safeParse(withoutVersion).success,
    ).toBe(false);
    expect(
      fundedDecisionTimeInputSchema.safeParse({
        ...decisionInput,
        evidenceSchemaVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects outcome-like fields on the decision-time input", () => {
    for (const extra of [
      { realizedPnl: 10 },
      { filledFraction: 0.5 },
      { status: "CLOSED" },
      { decisionSequence: 1 },
      { capturedAt: "2026-09-15T14:30:01.000Z" },
      { contentDigest: "a".repeat(64) },
    ])
      expect(
        fundedDecisionTimeInputSchema.safeParse({
          ...decisionInput,
          ...extra,
        }).success,
      ).toBe(false);
  });

  it("uses the real funded quote, model, context and portfolio variants", () => {
    expect(
      fundedDecisionQuoteSchema.safeParse({
        status: "UNAVAILABLE",
        reason: "x",
      }).success,
    ).toBe(true);
    expect(
      fundedDecisionQuoteSchema.safeParse({ status: "MISSING" }).success,
    ).toBe(false);
    expect(
      fundedDecisionModelSchema.safeParse({
        status: "UNAVAILABLE",
        reason: "x",
      }).success,
    ).toBe(true);
    expect(
      fundedDecisionModelSchema.safeParse({ status: "UNAVAILABLE" }).success,
    ).toBe(false);
    expect(
      fundedDecisionContextSchema.safeParse({
        status: "AVAILABLE",
        contexts: [
          {
            signalKey: "SECTOR",
            status: "STALE",
            timestamp: "2026-09-15T14:00:00.000Z",
          },
        ],
        contextStatus: "STALE",
        contextTimestamp: "2026-09-15T14:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      fundedDecisionContextSchema.safeParse({
        status: "AVAILABLE",
        contexts: [
          {
            signalKey: "SECTOR",
            status: "SUPPORTIVE",
            timestamp: "2026-09-15T14:00:00.000Z",
          },
        ],
        contextStatus: null,
        contextTimestamp: null,
      }).success,
    ).toBe(false);
    expect(
      fundedDecisionPortfolioSchema.safeParse({ status: "UNAVAILABLE" })
        .success,
    ).toBe(false);
    expect(
      fundedDecisionPortfolioSchema.safeParse({
        status: "UNAVAILABLE",
        reason: "No snapshot",
      }).success,
    ).toBe(true);
  });

  it("covers the decision actions and outcome states", () => {
    expect(fundedDecisionActionSchema.options).toEqual([
      "SUBMIT",
      "DECLINE",
      "DEFER",
    ]);
    expect(fundedOutcomeStatusSchema.options).toEqual([
      "DECISION_ACCEPTED",
      "POLICY_DECLINED",
      "POLICY_DEFERRED",
      "RISK_VETOED",
      "EXPIRED",
      "NO_EXECUTABLE_QUOTE",
      "NO_FILL",
      "PARTIAL_FILL",
      "FILLED",
      "CLOSED",
      "UNRESOLVED",
    ]);
    expect(fundedSourceKindSchema.options).toEqual([
      "LIVE_PAPER",
      "HISTORICAL_REPLAY",
    ]);
  });

  it("requires an explicit reason and availability time for unresolved", () => {
    const unresolved = {
      identity,
      sequence: 1,
      status: "UNRESOLVED",
      availableAt: "2026-09-15T15:00:00.000Z",
      recordedAt: "2026-09-15T15:00:01.000Z",
      sourceKind: "LIVE_PAPER",
      sourceId: "funded-signal:observation-1",
      sourceDigest: "b".repeat(64),
      reason: null,
      detail: null,
      supersedesSequence: null,
    };
    expect(fundedOutcomeVersionSchema.safeParse(unresolved).success).toBe(
      false,
    );
    expect(
      fundedOutcomeVersionSchema.parse({
        ...unresolved,
        reason: "No executable quote was retained before expiry",
      }),
    ).toMatchObject({ status: "UNRESOLVED" });
    expect(
      fundedOutcomeVersionSchema.safeParse({
        ...unresolved,
        reason: "No executable quote was retained before expiry",
        availableAt: "2026-09-15T15:00:02.000Z",
        recordedAt: "2026-09-15T15:00:01.000Z",
      }).success,
    ).toBe(false);
  });

  it("tightens partial and full fill semantics", () => {
    const base = {
      identity,
      sequence: 2,
      status: "PARTIAL_FILL",
      availableAt: "2026-09-15T14:31:00.000Z",
      recordedAt: "2026-09-15T14:31:01.000Z",
      sourceKind: "LIVE_PAPER",
      sourceId: "buy:observation-1",
      sourceDigest: "c".repeat(64),
      reason: null,
      supersedesSequence: null,
    };
    const partial = {
      ...base,
      detail: {
        filledFraction: 0.5,
        filledShares: 50,
        requestedShares: 100,
        averagePrice: 10.05,
        fees: 0,
        slippage: 0.02,
      },
    };
    expect(fundedOutcomeVersionSchema.parse(partial)).toMatchObject({
      detail: { filledFraction: 0.5 },
    });
    for (const detail of [
      { ...partial.detail, filledFraction: 0 },
      { ...partial.detail, filledFraction: 1 },
      { ...partial.detail, filledShares: 0 },
      { ...partial.detail, filledShares: 100 },
    ])
      expect(
        fundedOutcomeVersionSchema.safeParse({ ...partial, detail }).success,
      ).toBe(false);
    const filled = {
      ...base,
      status: "FILLED",
      detail: {
        filledFraction: 1,
        filledShares: 100,
        requestedShares: 100,
        averagePrice: 10.05,
        fees: 0,
        slippage: 0.02,
      },
    };
    expect(fundedOutcomeVersionSchema.parse(filled)).toMatchObject({
      status: "FILLED",
    });
    for (const detail of [
      { ...filled.detail, filledFraction: 0.9 },
      { ...filled.detail, filledShares: 99 },
      { ...filled.detail, filledShares: 0, requestedShares: 0 },
    ])
      expect(
        fundedOutcomeVersionSchema.safeParse({ ...filled, detail }).success,
      ).toBe(false);
  });

  it("retains typed detail and correction provenance append-only", () => {
    const corrected = {
      identity,
      sequence: 3,
      status: "CLOSED",
      availableAt: "2026-09-15T15:00:00.000Z",
      recordedAt: "2026-09-15T15:00:01.000Z",
      sourceKind: "LIVE_PAPER",
      sourceId: "sell:observation-1",
      sourceDigest: "d".repeat(64),
      reason: "CORRECTED_EXIT",
      detail: { filledFraction: 1, realizedNetPnl: 12.5, realizedR: 0.05 },
      supersedesSequence: 2,
    };
    expect(fundedOutcomeVersionSchema.parse(corrected)).toMatchObject({
      supersedesSequence: 2,
    });
    expect(
      fundedOutcomeVersionSchema.safeParse({
        ...corrected,
        supersedesSequence: 3,
      }).success,
    ).toBe(false);
    expect(
      fundedOutcomeDetailSchema.safeParse({
        status: "CLOSED",
        detail: { vetoReason: "wrong" },
      }).success,
    ).toBe(false);
  });

  it("rejects the wrong detail shape for a status", () => {
    const base = {
      identity,
      sequence: 1,
      availableAt: "2026-09-15T15:00:00.000Z",
      recordedAt: "2026-09-15T15:00:01.000Z",
      sourceKind: "LIVE_PAPER",
      sourceId: "fact-1",
      sourceDigest: "e".repeat(64),
      reason: null,
      supersedesSequence: null,
    };
    expect(
      fundedOutcomeDetailSchema.safeParse({
        status: "RISK_VETOED",
        detail: { vetoReason: "sector exposure" },
      }).success,
    ).toBe(true);
    expect(
      fundedOutcomeDetailSchema.safeParse({
        status: "RISK_VETOED",
        detail: { filledFraction: 0.5 },
      }).success,
    ).toBe(false);
    expect(
      fundedOutcomeVersionSchema.safeParse({
        ...base,
        status: "CLOSED",
        detail: {
          filledFraction: 1,
          realizedNetPnl: 12.5,
          realizedR: 0.05,
        },
      }).success,
    ).toBe(true);
    expect(
      fundedOutcomeVersionSchema.safeParse({
        ...base,
        status: "CLOSED",
        detail: { vetoReason: "nope" },
      }).success,
    ).toBe(false);
  });

  it("isolates compatible cohorts and rejects invalid pairings", () => {
    const cohort = {
      marketId: "CA_TSX",
      currency: "CAD",
      evidenceSchemaVersion: 2,
      fundedPolicyVersion: "funded-policy-v1",
      portfolioPolicyVersion: "funded-portfolio-v2",
      executionModelVersion: "paper-execution-v3",
      costPolicyVersion: "paper-cost-policy-2026-09-04",
      participationVersion: "participation-v1",
      sourceKind: "LIVE_PAPER",
      featureVersion: "features-v1",
      runtimeVersion: "runtime-v1",
      accountAssumptionDigest: "f".repeat(64),
      signalModelId: null,
      signalModelVersion: null,
      cohortDigest: "a".repeat(64),
    } as const;
    expect(fundedCohortIdentitySchema.parse(cohort)).toEqual(cohort);
    expect(
      fundedCohortIdentitySchema.safeParse({
        ...cohort,
        marketId: "CA_TSX",
        currency: "USD",
      }).success,
    ).toBe(false);
    expect(
      fundedCohortIdentitySchema.safeParse({
        ...cohort,
        signalModelId: "model-1",
        signalModelVersion: null,
      }).success,
    ).toBe(false);
    expect(
      fundedCohortIdentitySchema.safeParse({
        ...cohort,
        cohortDigest: undefined,
      }).success,
    ).toBe(false);
  });

  it("separates cohort components from their digest", () => {
    const components = {
      marketId: "CA_TSX",
      currency: "CAD",
      evidenceSchemaVersion: 2,
      fundedPolicyVersion: "funded-policy-v1",
      portfolioPolicyVersion: "funded-portfolio-v2",
      executionModelVersion: "paper-execution-v3",
      costPolicyVersion: "paper-cost-policy-2026-09-04",
      participationVersion: "participation-v1",
      sourceKind: "LIVE_PAPER",
      featureVersion: "features-v1",
      runtimeVersion: "runtime-v1",
      accountAssumptionDigest: "f".repeat(64),
      signalModelId: null,
      signalModelVersion: null,
    } as const;
    expect(fundedCohortComponentsSchema.parse(components)).toEqual(components);
    expect(
      fundedCohortComponentsSchema.safeParse({
        ...components,
        cohortDigest: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      fundedCohortComponentsSchema.safeParse({
        ...components,
        marketId: "US_EQUITIES",
      }).success,
    ).toBe(false);
  });

  it("accepts the nonnegative funded economics gates used by legacy runs", () => {
    expect(
      fundedEconomicsGatesSchema.parse({
        minNetRewardRisk: 0,
        minStopFrictionMultiple: 0,
        minTargetFrictionMultiple: 0,
        maxSpreadPct: 0,
      }),
    ).toEqual({
      minNetRewardRisk: 0,
      minStopFrictionMultiple: 0,
      minTargetFrictionMultiple: 0,
      maxSpreadPct: 0,
    });
    expect(
      fundedEconomicsGatesSchema.safeParse({
        minNetRewardRisk: -1,
        minStopFrictionMultiple: 0,
        minTargetFrictionMultiple: 0,
        maxSpreadPct: 0,
      }).success,
    ).toBe(false);
  });
});
