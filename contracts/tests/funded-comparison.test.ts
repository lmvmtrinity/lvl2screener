import { describe, expect, it } from "vitest";
import {
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  FUNDED_COMPARISON_INPUT_CHUNK_LIMIT,
  FUNDED_COMPARISON_MARK_AGE_MS,
  FUNDED_COMPARISON_MINIMUM_SESSIONS,
  FUNDED_COMPARISON_OPPORTUNITY_ELIGIBILITY_VERSION,
  FUNDED_COMPARISON_SPEC_VERSION,
  FUNDED_COMPARISON_VALUATION_POLICY_VERSION,
  fundedComparisonAvailabilityReceiptSchema,
  fundedComparisonFailureReasonSchema,
  fundedComparisonFailureReceiptSchema,
  fundedComparisonInputChunkSchema,
  fundedComparisonJobPayloadSchema,
  fundedComparisonPolicyEvaluationSchema,
  fundedComparisonReplayConfigurationSchema,
  fundedComparisonResultSchema,
  fundedComparisonRunBindingKey,
  fundedComparisonRunBindingSchema,
  fundedComparisonSessionMembershipSchema,
  fundedComparisonSessionMetricSchema,
  fundedComparisonSharedInputSchema,
  fundedComparisonSourceOpportunitySchema,
  fundedComparisonSpecificationSchema,
  inputItemOrderKey,
  isResumableComparisonFailure,
  toSessionPairVector,
  type FundedComparisonInputChunk,
  type FundedComparisonResult,
} from "../src/domains/funded-comparison.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

const at = (hour: number, minute = 0) =>
  `2026-09-15T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:00.000Z`;

function sessionMembership(overrides: Record<string, unknown> = {}) {
  return {
    orderedSessionDates: ["2026-09-14", "2026-09-15"],
    sessionMembershipDigest: digestA,
    ...overrides,
  };
}

function opportunityMembership(overrides: Record<string, unknown> = {}) {
  return {
    orderedOpportunityIds: ["source-1", "source-2"],
    opportunityMembershipDigest: digestB,
    opportunityCount: 2,
    eligibilityVersion: FUNDED_COMPARISON_OPPORTUNITY_ELIGIBILITY_VERSION,
    ...overrides,
  };
}

function sharedInput(overrides: Record<string, unknown> = {}) {
  return {
    orderedSessions: [
      {
        sessionDate: "2026-09-14",
        itemCount: 3,
        chunkCount: 1,
        sessionInputDigest: digestA,
      },
      {
        sessionDate: "2026-09-15",
        itemCount: 3,
        chunkCount: 1,
        sessionInputDigest: digestB,
      },
    ],
    sharedInputDigest: digestC,
    ...overrides,
  };
}

function replayConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    request: {
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
      parameters: { scoreCutoff: 70 },
    },
    requestDigest: digestA,
    profiles: [
      {
        strategyKey: "ORB_RETEST",
        profileId: "profile-1",
        profileName: "Opening range",
        profileConfigId: "profile-config-1",
        configVersion: "config-1",
      },
    ],
    profilesDigest: digestB,
    ...overrides,
  };
}

function specification(overrides: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    specVersion: FUNDED_COMPARISON_SPEC_VERSION,
    marketId: "CA_TSX",
    currency: "CAD",
    baseline: {
      backtestRunId: "baseline-1",
      configVersion: "config-1",
      strategyKeys: ["OPENING_RANGE_BREAKOUT"],
      startDate: "2026-09-01",
      endDate: "2026-09-15",
      executionModelVersion: "execution-v1",
      replayInputDigest: digestA,
      baselineResultDigest: digestB,
      completedAt: at(20),
    },
    sessionMembership: sessionMembership(),
    sharedInput: sharedInput(),
    replay: replayConfiguration(),
    opportunityMembership: opportunityMembership(),
    champion: {
      kind: "DETERMINISTIC_FUNDED_POLICY",
      fundedPolicyVersion: "funded-cash-v1",
      portfolioPolicyVersion: "funded-portfolio-v2",
      policyDigest: digestA,
      sourceLiveRunId: "live-run-1",
      sourceAccountId: "live-account-1",
      executionModelVersion: "execution-v1",
      costPolicyVersion: "cost-v1",
      participationVersion: "participation-v1",
      runtimeVersion: "runtime-v1",
      accountAssumptionDigest: digestB,
      assumptionsDigest: digestC,
    },
    challenger: {
      kind: "FUNDED_EXECUTION_POLICY_V1",
      policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
      policyDigest: digestB,
      model: {
        modelId: "challenger-1",
        modelVersion: "funded-execution-v1",
        artifactDigest: digestA,
        datasetDigest: digestB,
        cohortDigest: digestC,
        featureVersion: "funded-execution-features-v1",
        predictionPolicyVersion: "funded-execution-prediction-v1",
        trainingPartitionDigest: digestA,
        trainingEvidenceCutoffAt: at(12),
        trainingSessionDigest: digestB,
      },
    },
    capital: {
      initialCash: 25_000,
      dailyLossLimit: 2_500,
      riskConfigurationDigest: digestA,
    },
    valuationPolicyVersion: FUNDED_COMPARISON_VALUATION_POLICY_VERSION,
    metricsPolicyVersion: "funded-comparison-metrics-v1",
    evidenceCutoffAt: at(20),
    specificationFrozenAt: at(21),
    comparisonSpecDigest: digestC,
    ...overrides,
  };
  return value;
}

function sideMetrics(overrides: Record<string, unknown> = {}) {
  return {
    return: {
      totalNetReturn: 120,
      returnPctOfInitialCash: 0.48,
      sessions: [
        { sessionDate: "2026-09-14", netReturn: 40 },
        { sessionDate: "2026-09-15", netReturn: 80 },
      ],
    },
    drawdown: { maxDrawdown: 60, maxDrawdownPctOfInitialCash: 0.24 },
    dailyLoss: { limitHits: 0, mostNegativeDailyPnl: -30, sessionsBlocked: 0 },
    risk: { maxOpenRisk: 900, maxGrossNotional: 12_000, maxOpenPositions: 3 },
    activity: {
      turnover: 12_000,
      requested: 4,
      partialFills: 1,
      fullFills: 2,
      zeroFills: 1,
    },
    execution: {
      fillFraction: 0.75,
      averageSlippagePerShare: 0.01,
      totalModeledCosts: 12,
    },
    veto: {
      classification: "AVAILABLE",
      counts: [{ reason: "MAX_OPEN_POSITIONS", count: 1 }],
    },
    declines: [{ reason: "SCORE_BELOW_CUTOFF", count: 0 }],
    opportunityCost: {
      declinedOrVetoedCount: 1,
      forgoneRequestedNotional: 1_000,
      forgoneRequestedRisk: 250,
      requestedCapitalAvailableCount: 1,
      requestedCapitalUnavailableCount: 0,
      realizedValue: null,
      provableCount: 0,
      unprovableCount: 1,
    },
    stability: {
      sessionCount: 2,
      zeroTradeSessions: 0,
      longestReturnSignRun: 2,
    },
    integrity: {
      unresolvedExposure: 0,
      fallbackDecisionCount: 0,
      predictionAvailableCount: 2,
      predictionRequiredCount: 2,
      findings: [],
    },
    ...overrides,
  };
}

function pairedSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionDate: "2026-09-14",
    baselineNetReturn: 40,
    challengerNetReturn: 55,
    baselineMaxDrawdown: 20,
    challengerMaxDrawdown: 18,
    valuation: "UNION_GRID_MTM",
    coverage: "VERIFIED",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    resultVersion: "funded-comparison-result-v1",
    comparisonSpecDigest: digestC,
    marketId: "CA_TSX",
    currency: "CAD",
    sessionCount: 2,
    historicalVolumeStatus: "INSUFFICIENT_SESSIONS",
    pairedSessions: [
      pairedSession(),
      pairedSession({ sessionDate: "2026-09-15" }),
    ],
    champion: sideMetrics(),
    challenger: sideMetrics(),
    deltas: {
      totalNetReturn: 15,
      returnPctOfInitialCash: 0.06,
      maxDrawdown: -2,
      maxDrawdownPctOfInitialCash: -0.008,
      limitHits: 0,
      mostNegativeDailyPnl: 0,
      sessionsBlocked: 0,
      maxOpenRisk: 0,
      maxGrossNotional: 0,
      maxOpenPositions: 0,
      turnover: 0,
      requested: 0,
      partialFills: 0,
      fullFills: 0,
      zeroFills: 0,
      fillFraction: 0,
      averageSlippagePerShare: 0,
      totalModeledCosts: 0,
      vetoCount: 0,
      declineCount: 0,
      declinedOrVetoedCount: 0,
      forgoneRequestedNotional: 0,
      forgoneRequestedRisk: 0,
      zeroTradeSessions: 0,
      longestReturnSignRun: 0,
      sessionCount: 0,
      challengerOutperformedSessions: 2,
      unavailable: [],
    },
    challengerOutperformedSessions: { count: 2, proportion: 1 },
    championEvaluationDigest: digestA,
    challengerEvaluationDigest: digestB,
    championMetricsDigest: digestC,
    challengerMetricsDigest: digestA,
    resultDigest: digestB,
    ...overrides,
  };
  return value;
}

function inputItem(
  kind: string,
  at: string,
  extra: Record<string, unknown> = {},
) {
  if (kind === "OPPORTUNITY")
    return {
      kind,
      sourceOpportunityId: `source-${at}`,
      sessionDate: "2026-09-14",
      sourceOrdinal: 1,
      sourceEventId: "event-1",
      setupInstanceId: "setup-1",
      instrumentId: "instrument-1",
      profileConfigId: "profile-config-1",
      strategyKey: "ORB_RETEST",
      strategyVersion: "v1",
      score: 75,
      eligibilityStatus: "ELIGIBLE",
      eligibilityReason: null,
      signalTimestamp: at,
      signalSemanticsVersion: "signal-semantics-v1",
      observationFeatureVersion: "features-v1",
      symbol: "SYM",
      entryReference: 10,
      stopReference: 9,
      targetReference: 12,
      atr14: 1,
      reasonCodes: ["BREAKOUT"],
      sourceEventPayload: { state: "READY" },
      featureSnapshot: null,
      contexts: [],
      ...extra,
    };
  if (kind === "QUOTE")
    return {
      kind,
      instrumentId: "instrument-1",
      timestamp: at,
      bid: 10,
      ask: 10.02,
      bidSize: 100,
      askSize: 200,
      sizeUnit: "SHARES",
      sizeMultiplier: 1,
      dataStatus: "REALTIME",
      actionable: true,
      source: "QUESTRADE",
      ...extra,
    };
  if (kind === "INVALIDATION")
    return {
      kind,
      eventId: "invalidation-1",
      sourceOpportunityId: "source-1",
      at,
      ...extra,
    };
  return {
    kind: "SESSION_BOUNDARY",
    sessionDate: "2026-09-14",
    sessionStartAt: at,
    scheduledCloseAt: "2026-09-14T20:00:00.000Z",
    sessionTimezone: "America/Toronto",
    ...extra,
  };
}

function chunk(overrides: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    sessionDate: "2026-09-14",
    chunkOrdinal: 1,
    itemCount: 1,
    firstEffectiveAt: at(13, 30),
    lastEffectiveAt: at(13, 30),
    chunkDigest: digestA,
    items: [
      { itemDigest: digestA, item: inputItem("OPPORTUNITY", at(13, 30)) },
    ],
    ...overrides,
  };
  return value;
}

function policyEvaluation(overrides: Record<string, unknown> = {}) {
  return {
    specId: "spec-1",
    side: "CHALLENGER",
    sessionDate: "2026-09-14",
    sourceOpportunityId: "source-1",
    sourceOrdinal: 1,
    signalTimestamp: at(13, 30),
    batchKey: at(13, 30),
    championRank: 1,
    appliedRank: 1,
    destinationRunId: "run-1",
    destinationObservationId: "observation-1",
    disposition: "CHAMPION_ORDER",
    fallbackReason: null,
    prediction: null,
    evaluationDigest: digestA,
    ...overrides,
  };
}

describe("funded comparison contracts", () => {
  it("exposes the frozen constants", () => {
    expect(FUNDED_COMPARISON_SPEC_VERSION).toBe("funded-comparison-spec-v1");
    expect(FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION).toBe(
      "funded-comparison-execution-quality-ordering-v1",
    );
    expect(FUNDED_COMPARISON_MARK_AGE_MS).toBe(30_000);
    expect(FUNDED_COMPARISON_INPUT_CHUNK_LIMIT).toBe(1_000);
    expect(FUNDED_COMPARISON_MINIMUM_SESSIONS).toBe(20);
  });

  it("accepts a paired market/currency specification", () => {
    expect(
      fundedComparisonSpecificationSchema.parse(specification()),
    ).toMatchObject({ marketId: "CA_TSX", currency: "CAD" });
  });

  it("rejects a market/currency mismatch", () => {
    expect(() =>
      fundedComparisonSpecificationSchema.parse(
        specification({ marketId: "US_EQUITIES" }),
      ),
    ).toThrow();
  });

  it("rejects unsorted or duplicate session membership", () => {
    expect(() =>
      fundedComparisonSessionMembershipSchema.parse(
        sessionMembership({
          orderedSessionDates: ["2026-09-15", "2026-09-14"],
        }),
      ),
    ).toThrow();
    expect(() =>
      fundedComparisonSessionMembershipSchema.parse(
        sessionMembership({
          orderedSessionDates: ["2026-09-14", "2026-09-14"],
        }),
      ),
    ).toThrow();
  });

  it("rejects duplicate source opportunity identity", () => {
    expect(() =>
      fundedComparisonSpecificationSchema.parse(
        specification({
          opportunityMembership: opportunityMembership({
            orderedOpportunityIds: ["source-1", "source-1"],
          }),
        }),
      ),
    ).toThrow();
  });

  it("rejects malformed digests and unknown fields", () => {
    expect(() =>
      fundedComparisonSpecificationSchema.parse(
        specification({ comparisonSpecDigest: "not-a-digest" }),
      ),
    ).toThrow();
    expect(() =>
      fundedComparisonSpecificationSchema.parse(
        specification({ authority: "ACTIVE" }),
      ),
    ).toThrow();
  });

  it("round-trips every failure reason with its classification", () => {
    for (const reason of fundedComparisonFailureReasonSchema.options) {
      const resumable = isResumableComparisonFailure(reason);
      expect(
        fundedComparisonFailureReceiptSchema.parse({
          specId: "spec-1",
          attemptId: "attempt-1",
          side: null,
          sessionDate: null,
          reason,
          classification: resumable ? "INTERRUPTION" : "TERMINAL",
          detail: `failed: ${reason}`,
          failureDigest: digestA,
          recordedAt: at(15),
        }).reason,
      ).toBe(reason);
    }
  });

  it("rejects a misclassified failure receipt", () => {
    expect(() =>
      fundedComparisonFailureReceiptSchema.parse({
        specId: "spec-1",
        attemptId: "attempt-1",
        side: null,
        sessionDate: null,
        reason: "CANCELLED",
        classification: "TERMINAL",
        detail: "cancelled",
        failureDigest: digestA,
        recordedAt: at(15),
      }),
    ).toThrow();
    expect(() =>
      fundedComparisonFailureReceiptSchema.parse({
        specId: "spec-1",
        attemptId: "attempt-1",
        side: null,
        sessionDate: null,
        reason: "STALE_MARK",
        classification: "INTERRUPTION",
        detail: "stale",
        failureDigest: digestA,
        recordedAt: at(15),
      }),
    ).toThrow();
  });

  it("keeps the source opportunity identity independent of destination observations", () => {
    const opportunity = fundedComparisonSourceOpportunitySchema.parse({
      sourceOpportunityId: "source-1",
      sessionDate: "2026-09-14",
      sourceOrdinal: 1,
      sourceEventId: "event-1",
      setupInstanceId: "setup-1",
      instrumentId: "instrument-1",
      profileConfigId: "profile-config-1",
      signalTimestamp: at(13, 30),
      sourceContentDigest: digestA,
    });
    const evaluation = fundedComparisonPolicyEvaluationSchema.parse(
      policyEvaluation({
        side: "CHAMPION",
        sourceOpportunityId: opportunity.sourceOpportunityId,
        destinationObservationId: "different-destination-uuid",
      }),
    );
    expect(evaluation.sourceOpportunityId).toBe("source-1");
    expect(evaluation.destinationObservationId).toBe(
      "different-destination-uuid",
    );
  });

  it("enforces the 1,000-item chunk bound and canonical order", () => {
    expect(() =>
      fundedComparisonInputChunkSchema.parse(
        chunk({ itemCount: FUNDED_COMPARISON_INPUT_CHUNK_LIMIT + 1 }),
      ),
    ).toThrow();
    expect(() =>
      fundedComparisonInputChunkSchema.parse(
        chunk({
          itemCount: 2,
          firstEffectiveAt: at(13, 30),
          lastEffectiveAt: at(13, 31),
          items: [
            { itemDigest: digestA, item: inputItem("QUOTE", at(13, 31)) },
            { itemDigest: digestB, item: inputItem("QUOTE", at(13, 30)) },
          ],
        }),
      ),
    ).toThrow();
    const valid: FundedComparisonInputChunk =
      fundedComparisonInputChunkSchema.parse(chunk());
    expect(valid.itemCount).toBe(1);
  });

  it("keys run bindings by side and session", () => {
    const binding = {
      specId: "spec-1",
      side: "CHAMPION" as const,
      sessionDate: "2026-09-14",
      runId: "run-1",
      accountId: "account-1",
      marketId: "CA_TSX" as const,
      currency: "CAD" as const,
      policyDigest: digestA,
      executionModelVersion: "execution-v1",
      accountAssumptionDigest: digestB,
      boundAt: at(13),
    };
    expect(fundedComparisonRunBindingSchema.parse(binding).side).toBe(
      "CHAMPION",
    );
    expect(
      fundedComparisonRunBindingKey({
        ...binding,
        side: "CHALLENGER",
        sessionDate: "2026-09-15",
      }),
    ).toBe("spec-1:CHALLENGER:2026-09-15");
    expect(
      fundedComparisonRunBindingKey(binding) ===
        fundedComparisonRunBindingKey({ ...binding, side: "CHALLENGER" }),
    ).toBe(false);
  });

  it("enforces batch-wide fallback dispositions", () => {
    const fallback = policyEvaluation({
      disposition: "FALLBACK_CHAMPION_ORDER",
      fallbackReason: "PREDICTION_UNAVAILABLE",
      appliedRank: 2,
      championRank: 2,
    });
    expect(
      fundedComparisonPolicyEvaluationSchema.parse(fallback).appliedRank,
    ).toBe(2);
    expect(() =>
      fundedComparisonPolicyEvaluationSchema.parse({
        ...fallback,
        appliedRank: 1,
      }),
    ).toThrow();
    expect(() =>
      fundedComparisonPolicyEvaluationSchema.parse({
        ...fallback,
        fallbackReason: null,
      }),
    ).toThrow();
    expect(() =>
      fundedComparisonPolicyEvaluationSchema.parse({
        ...policyEvaluation({
          disposition: "PREDICTED",
          appliedRank: 1,
        }),
      }),
    ).toThrow();
    const predicted = fundedComparisonPolicyEvaluationSchema.parse(
      policyEvaluation({
        disposition: "PREDICTED",
        prediction: {
          runId: "run-1",
          observationId: "observation-1",
          decisionSequence: 1,
          decisionInputDigest: digestA,
          modelId: "challenger-1",
          modelVersion: "funded-execution-v1",
          modelType: "FUNDED_EXECUTION_QUALITY",
          artifactDigest: digestA,
          cohortDigest: digestB,
          featureVersion: "funded-execution-features-v1",
          inputDigest: digestB,
          outputDigest: digestC,
        },
      }),
    );
    expect(predicted.disposition).toBe("PREDICTED");
  });

  it("validates the per-side/session metric row", () => {
    expect(
      fundedComparisonSessionMetricSchema.parse({
        specId: "spec-1",
        side: "CHAMPION",
        sessionDate: "2026-09-14",
        marketId: "CA_TSX",
        currency: "CAD",
        valuation: "UNION_GRID_MTM",
        valuationReason: null,
        netReturn: 40,
        maxDrawdown: 20,
        tradeCount: 2,
        unrealizedPositionCount: 0,
        unresolvedOrderCount: 0,
        unresolvedReservationCount: 0,
        staleMarkCount: 0,
        valuationPointCount: 42,
        metricDigest: digestA,
      }).valuation,
    ).toBe("UNION_GRID_MTM");
    expect(() =>
      fundedComparisonSessionMetricSchema.parse({
        specId: "spec-1",
        side: "CHAMPION",
        sessionDate: "2026-09-14",
        marketId: "CA_TSX",
        currency: "CAD",
        valuation: "UNAVAILABLE",
        valuationReason: null,
        netReturn: null,
        maxDrawdown: null,
        tradeCount: 0,
        unrealizedPositionCount: 0,
        unresolvedOrderCount: 0,
        unresolvedReservationCount: 0,
        staleMarkCount: 0,
        valuationPointCount: 0,
        metricDigest: digestA,
      }),
    ).toThrow();
  });

  it("validates the immutable result artifact and ordering", () => {
    expect(fundedComparisonResultSchema.parse(result()).sessionCount).toBe(2);
    expect(() =>
      fundedComparisonResultSchema.parse({
        ...result(),
        pairedSessions: [
          pairedSession({ sessionDate: "2026-09-15" }),
          pairedSession({ sessionDate: "2026-09-14" }),
        ],
      }),
    ).toThrow();
    expect(() =>
      fundedComparisonResultSchema.parse({ ...result(), gatePass: true }),
    ).toThrow();
    expect(() =>
      fundedComparisonResultSchema.parse({
        ...result(),
        historicalVolumeStatus: "SUFFICIENT_FOR_LATER_G2",
      }),
    ).toThrow();
    expect(() =>
      fundedComparisonResultSchema.parse({
        ...result(),
        pairedSessions: [
          pairedSession({ valuation: "UNAVAILABLE", coverage: "VERIFIED" }),
        ],
      }),
    ).toThrow();
  });

  it("projects the paired vector into SessionPair rows", () => {
    const rows = toSessionPairVector(
      fundedComparisonResultSchema.parse(result()) as FundedComparisonResult,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      sessionDate: "2026-09-14",
      baseline: 40,
      challenger: 55,
      coverage: "VERIFIED",
    });
    expect(rows[1]!.sessionDate).toBe("2026-09-15");
  });

  it("validates the job payload and availability receipt", () => {
    expect(
      fundedComparisonJobPayloadSchema.parse({
        specificationId: "spec-1",
        comparisonSpecDigest: digestA,
        marketId: "CA_TSX",
        currency: "CAD",
        maxSessions: 20,
      }).maxSessions,
    ).toBe(20);
    expect(
      fundedComparisonAvailabilityReceiptSchema.parse({
        specificationId: "spec-1",
        marketId: "CA_TSX",
        currency: "CAD",
        comparisonSpecDigest: digestA,
        status: "UNAVAILABLE",
        sessionCount: 2,
        historicalVolumeStatus: null,
        resultDigest: null,
        resultAvailable: false,
        failures: [
          {
            reason: "CHAMPION_NOT_RETAINED",
            classification: "TERMINAL",
            side: null,
            sessionDate: null,
            detail: "no retained live funded run",
            recordedAt: at(16),
          },
        ],
        createdAt: at(16),
      }).status,
    ).toBe("UNAVAILABLE");
  });

  it("requires the frozen shared input to cover the session membership in order", () => {
    expect(() =>
      fundedComparisonSpecificationSchema.parse(
        specification({
          sharedInput: sharedInput({
            orderedSessions: [
              {
                sessionDate: "2026-09-15",
                itemCount: 3,
                chunkCount: 1,
                sessionInputDigest: digestA,
              },
            ],
          }),
        }),
      ),
    ).toThrow();
    expect(() =>
      fundedComparisonSharedInputSchema.parse(
        sharedInput({
          orderedSessions: [
            {
              sessionDate: "2026-09-15",
              itemCount: 3,
              chunkCount: 1,
              sessionInputDigest: digestA,
            },
            {
              sessionDate: "2026-09-14",
              itemCount: 3,
              chunkCount: 1,
              sessionInputDigest: digestB,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects a frozen replay request from another market", () => {
    expect(() =>
      fundedComparisonSpecificationSchema.parse(
        specification({
          replay: replayConfiguration({
            request: {
              ...replayConfiguration().request,
              marketId: "US_EQUITIES",
            },
          }),
        }),
      ),
    ).toThrow();
    expect(
      fundedComparisonReplayConfigurationSchema.parse(replayConfiguration())
        .request.marketId,
    ).toBe("CA_TSX");
  });

  it("orders equal-time items CANCEL < CLOCK < SIGNAL < QUOTE", () => {
    const timestamp = at(13, 30);
    const cancel = inputItem("INVALIDATION", timestamp);
    const clock = inputItem("SESSION_BOUNDARY", timestamp);
    const signal = inputItem("OPPORTUNITY", timestamp);
    const quote = inputItem("QUOTE", timestamp);
    const keys = [cancel, clock, signal, quote].map((item) =>
      inputItemOrderKey(item as never),
    );
    expect(keys[0]).toBe(inputItemOrderKey(cancel as never));
    expect(keys[1]).toBe(inputItemOrderKey(clock as never));
    expect(keys[2]).toBe(inputItemOrderKey(signal as never));
    expect(keys[3]).toBe(inputItemOrderKey(quote as never));
    expect(keys[0]! < keys[1]!).toBe(true);
    expect(keys[1]! < keys[2]!).toBe(true);
    expect(keys[2]! < keys[3]!).toBe(true);
  });

  it("totally orders equal-time quotes by their retained source identity", () => {
    const timestamp = at(13, 30);
    const sourceZ = {
      ...(inputItem("QUOTE", timestamp) as Record<string, unknown>),
      source: "SOURCE_Z",
    };
    const sourceA = {
      ...(inputItem("QUOTE", timestamp) as Record<string, unknown>),
      source: "SOURCE_A",
    };
    const ordered = [sourceZ, sourceA].sort((left, right) =>
      inputItemOrderKey(left as never).localeCompare(
        inputItemOrderKey(right as never),
      ),
    );
    expect(ordered.map((item) => item.source)).toEqual([
      "SOURCE_A",
      "SOURCE_Z",
    ]);
  });

  it("reports missing requested capital as null, never zero", () => {
    const metrics = sideMetrics();
    expect(
      sideMetrics({
        opportunityCost: {
          ...(metrics.opportunityCost as Record<string, unknown>),
          forgoneRequestedNotional: null,
          forgoneRequestedRisk: null,
          requestedCapitalAvailableCount: 0,
          requestedCapitalUnavailableCount: 1,
        },
      }),
    ).toMatchObject({
      opportunityCost: { forgoneRequestedNotional: null },
    });
    expect(() =>
      fundedComparisonResultSchema.parse(
        result({
          champion: sideMetrics({
            opportunityCost: {
              declinedOrVetoedCount: 1,
              forgoneRequestedNotional: null,
              forgoneRequestedRisk: null,
              requestedCapitalAvailableCount: 1,
              requestedCapitalUnavailableCount: 0,
              realizedValue: null,
              provableCount: 0,
              unprovableCount: 1,
            },
          }),
        }),
      ),
    ).toThrow();
  });

  it("requires the paired vector to cover both sides' session returns", () => {
    expect(() =>
      fundedComparisonResultSchema.parse({
        ...result(),
        pairedSessions: [pairedSession({ sessionDate: "2026-09-15" })],
      }),
    ).toThrow();
  });

  it("carries no authority or gate field in the specification fixture", () => {
    const text = JSON.stringify(specification());
    for (const forbidden of [
      "activation",
      "authority",
      "recommendation",
      "bypass",
    ])
      expect(text.includes(forbidden)).toBe(false);
  });
});
