import { describe, expect, it } from "vitest";
import {
  toSessionPairVector,
  type FundedComparisonPolicyEvaluation,
} from "@tsx-scanner/contracts";
import {
  assembleComparisonResult,
  assembleSideMetrics,
  type FundedComparisonSideMetricInput,
  type FundedComparisonSideMetricSession,
} from "../src/paper-bot/funded-comparison-metrics.js";
import type { FundedComparisonSideValuation } from "../src/paper-bot/funded-comparison-valuation.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";
import { fundedComparisonEvaluationMembershipDigest } from "../src/paper-bot/funded-comparison-digest.js";

function valuation(
  equity: number,
  overrides: Partial<FundedComparisonSideValuation> = {},
): FundedComparisonSideValuation {
  return {
    equityPoints: [
      { at: "2026-09-15T13:30:00.000Z", equity: 25_000 },
      { at: "2026-09-15T20:00:00.000Z", equity },
    ],
    maxDrawdown: 25_000 - equity > 0 ? 25_000 - equity : 0,
    maxDrawdownPctOfInitialCash:
      (25_000 - equity > 0 ? 25_000 - equity : 0) / 25_000,
    staleMarkPoints: 0,
    integrityFindings: [],
    status: "PROVEN",
    reason: null,
    ...overrides,
  };
}

function session(
  sessionDate: string,
  equity: number,
  overrides: Partial<FundedComparisonSideMetricSession> = {},
): FundedComparisonSideMetricSession {
  return {
    sessionDate,
    valuation: valuation(equity),
    carryInEquity: 25_000,
    dailyLossLimit: 2_500,
    dailyPnl: equity - 25_000,
    entriesAllowed: true,
    openRisk: 0,
    grossNotional: 0,
    openPositions: 0,
    zeroTradeSessions: false,
    ...overrides,
  };
}

function sideInput(
  overrides: Partial<FundedComparisonSideMetricInput> = {},
): FundedComparisonSideMetricInput {
  return {
    side: "CHAMPION",
    specification: {
      marketId: "CA_TSX",
      currency: "CAD",
      capital: {
        initialCash: 25_000,
        dailyLossLimit: 2_500,
        riskConfigurationDigest: "a".repeat(64),
      },
    },
    sessions: [session("2026-09-14", 25_100), session("2026-09-15", 24_950)],
    decisions: [
      {
        sourceOpportunityId: "source-1",
        action: "SUBMIT",
        policyReason: null,
        vetoCode: null,
        requestedNotional: 1_000,
        requestedRisk: 250,
        realizedValue: 50,
        realizable: true,
      },
      {
        sourceOpportunityId: "source-2",
        action: "DECLINE",
        policyReason: "SCORE_BELOW_CUTOFF",
        vetoCode: null,
        requestedNotional: 500,
        requestedRisk: 125,
        realizedValue: null,
        realizable: false,
      },
      {
        sourceOpportunityId: "source-3",
        action: "DECLINE",
        policyReason: null,
        vetoCode: "MAX_OPEN_POSITIONS",
        requestedNotional: 800,
        requestedRisk: 200,
        realizedValue: null,
        realizable: false,
      },
    ],
    orders: [
      {
        requestedShares: 100,
        filledShares: 100,
        entryPriceMicros: 10_000_000,
        exitPriceMicros: 10_500_000,
        netPnlMicros: 50_000_000,
        slippageMicrosPerShare: 10_000,
        costsMicros: 2_000_000,
      },
      {
        requestedShares: 100,
        filledShares: 40,
        entryPriceMicros: 10_000_000,
        exitPriceMicros: null,
        netPnlMicros: null,
        slippageMicrosPerShare: 20_000,
        costsMicros: 1_000_000,
      },
    ],
    evaluations: [],
    ...overrides,
  };
}

function evaluation(
  side: "CHAMPION" | "CHALLENGER",
  disposition: FundedComparisonPolicyEvaluation["disposition"],
): FundedComparisonPolicyEvaluation {
  const withoutDigest = {
    specId: "spec-1",
    side,
    sessionDate: "2026-09-14",
    sourceOpportunityId: `source-${disposition}`,
    sourceOrdinal: 1,
    signalTimestamp: "2026-09-14T14:30:00.000Z",
    batchKey: "2026-09-14T14:30:00.000Z",
    championRank: 1,
    appliedRank: 1,
    destinationRunId: "run-1",
    destinationObservationId: "observation-1",
    disposition,
    fallbackReason:
      disposition === "FALLBACK_CHAMPION_ORDER"
        ? "PREDICTION_UNAVAILABLE"
        : null,
    prediction: null,
  };
  return { ...withoutDigest, evaluationDigest: contentHash(withoutDigest) };
}

describe("comparison metric assembler", () => {
  it("emits every metric group with explicit units", () => {
    const metrics = assembleSideMetrics(sideInput());
    expect(metrics.return.totalNetReturn).toBe(50);
    expect(metrics.return.sessions.map((row) => row.netReturn)).toEqual([
      100, -50,
    ]);
    // Cross-session drawdown: the series is 25_000 -> 25_100 -> 25_000 ->
    // 24_950, so the peak-to-trough drawdown is 150, not the largest single
    // session drawdown.
    expect(metrics.drawdown.maxDrawdown).toBe(150);
    expect(metrics.activity).toEqual({
      // Gross entry-plus-exit notional: 100*10 + 100*10.5 + 40*10 = 2_450.
      turnover: 2_450,
      requested: 2,
      partialFills: 1,
      fullFills: 1,
      zeroFills: 0,
    });
    expect(metrics.execution.fillFraction).toBeCloseTo(140 / 200, 8);
    // Share-weighted slippage: (0.01*100 + 0.02*40) / 140.
    expect(metrics.execution.averageSlippagePerShare).toBeCloseTo(1.8 / 140, 8);
    expect(metrics.execution.totalModeledCosts).toBe(3);
    expect(metrics.veto).toEqual({
      classification: "AVAILABLE",
      counts: [{ reason: "MAX_OPEN_POSITIONS", count: 1 }],
    });
    expect(metrics.declines).toEqual([
      { reason: "SCORE_BELOW_CUTOFF", count: 1 },
    ]);
    expect(metrics.opportunityCost).toEqual({
      declinedOrVetoedCount: 2,
      forgoneRequestedNotional: 1_300,
      forgoneRequestedRisk: 325,
      requestedCapitalAvailableCount: 2,
      requestedCapitalUnavailableCount: 0,
      realizedValue: null,
      provableCount: 0,
      unprovableCount: 2,
    });
    expect(metrics.stability.sessionCount).toBe(2);
  });

  it("preserves missing requested capital instead of converting it to zero", () => {
    const metrics = assembleSideMetrics(
      sideInput({
        decisions: [
          {
            sourceOpportunityId: "source-1",
            action: "DECLINE",
            policyReason: "SCORE_BELOW_CUTOFF",
            vetoCode: null,
            requestedNotional: null,
            requestedRisk: null,
            realizedValue: null,
            realizable: false,
          },
          {
            sourceOpportunityId: "source-2",
            action: "DECLINE",
            policyReason: null,
            vetoCode: "MAX_OPEN_POSITIONS",
            requestedNotional: 800,
            requestedRisk: 200,
            realizedValue: null,
            realizable: false,
          },
        ],
      }),
    );
    expect(metrics.opportunityCost.forgoneRequestedNotional).toBeNull();
    expect(metrics.opportunityCost.forgoneRequestedRisk).toBeNull();
    expect(metrics.opportunityCost.requestedCapitalAvailableCount).toBe(1);
    expect(metrics.opportunityCost.requestedCapitalUnavailableCount).toBe(1);
  });

  it("marks the veto classification unavailable for an unknown reason", () => {
    const input = sideInput({
      decisions: [
        {
          sourceOpportunityId: "source-1",
          action: "DECLINE",
          policyReason: null,
          vetoCode: "UNKNOWN_VETO_REASON",
          requestedNotional: 100,
          requestedRisk: 10,
          realizedValue: null,
          realizable: false,
        },
      ],
    });
    expect(assembleSideMetrics(input).veto.classification).toBe("UNAVAILABLE");
  });

  it("reports a provable realized counterfactual only when every covered outcome is provable", () => {
    const input = sideInput({
      decisions: [
        {
          sourceOpportunityId: "source-1",
          action: "DECLINE",
          policyReason: "POLICY",
          vetoCode: null,
          requestedNotional: 100,
          requestedRisk: 10,
          realizedValue: 12,
          realizable: true,
        },
      ],
    });
    expect(assembleSideMetrics(input).opportunityCost.realizedValue).toBe(12);
  });

  it("assembles challenger-minus-champion deltas and the paired vector", () => {
    const champion = assembleSideMetrics(sideInput());
    const challenger = assembleSideMetrics(
      sideInput({
        side: "CHALLENGER",
        sessions: [
          session("2026-09-14", 25_200),
          session("2026-09-15", 25_150),
        ],
        evaluations: [
          evaluation("CHALLENGER", "PREDICTED"),
          evaluation("CHALLENGER", "FALLBACK_CHAMPION_ORDER"),
        ],
      }),
    );
    const championEvaluationDigest = fundedComparisonEvaluationMembershipDigest(
      ["a".repeat(64)],
    );
    const challengerEvaluationDigest =
      fundedComparisonEvaluationMembershipDigest([
        evaluation("CHALLENGER", "PREDICTED").evaluationDigest,
      ]);
    const result = assembleComparisonResult({
      specification: {
        marketId: "CA_TSX",
        currency: "CAD",
        comparisonSpecDigest: "c".repeat(64),
        sessionMembership: {
          orderedSessionDates: ["2026-09-14", "2026-09-15"],
          sessionMembershipDigest: "d".repeat(64),
        },
        capital: {
          initialCash: 25_000,
          dailyLossLimit: 2_500,
          riskConfigurationDigest: "a".repeat(64),
        },
      },
      sessionPairs: [
        {
          sessionDate: "2026-09-14",
          champion: valuation(25_100),
          challenger: valuation(25_200),
        },
        {
          sessionDate: "2026-09-15",
          champion: valuation(25_050),
          challenger: valuation(25_150),
        },
      ],
      champion,
      challenger,
      championEvaluationDigest,
      challengerEvaluationDigest,
    });
    expect(result.deltas.totalNetReturn).toBe(300);
    // Champion cross-session drawdown 150, challenger 200 -> challenger minus
    // champion is +50 (a worse drawdown).
    expect(result.deltas.maxDrawdown).toBe(50);
    expect(result.deltas.vetoCount).toBe(0);
    expect(result.challengerOutperformedSessions).toEqual({
      count: 2,
      proportion: 1,
    });
    expect(result.historicalVolumeStatus).toBe("INSUFFICIENT_SESSIONS");
    expect(result.pairedSessions.map((row) => row.sessionDate)).toEqual([
      "2026-09-14",
      "2026-09-15",
    ]);
    expect(toSessionPairVector(result)).toEqual([
      {
        sessionDate: "2026-09-14",
        baseline: 100,
        challenger: 200,
        coverage: "VERIFIED",
      },
      {
        sessionDate: "2026-09-15",
        baseline: 50,
        challenger: 150,
        coverage: "VERIFIED",
      },
    ]);
    const text = JSON.stringify(result);
    for (const forbidden of [
      "gatePass",
      "passed",
      "recommendation",
      "authority",
    ])
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    expect(result.resultDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("assembles an exact quiet session after a populated session for both sides", () => {
    const quietDate = "2026-09-15";
    const championSessions = [
      session("2026-09-14", 25_100),
      session(quietDate, 25_000, { zeroTradeSessions: true }),
    ];
    const challengerSessions = [
      session("2026-09-14", 25_200),
      session(quietDate, 25_000, { zeroTradeSessions: true }),
    ];
    const champion = assembleSideMetrics(
      sideInput({ sessions: championSessions }),
    );
    const challenger = assembleSideMetrics(
      sideInput({ side: "CHALLENGER", sessions: challengerSessions }),
    );
    const result = assembleComparisonResult({
      specification: {
        marketId: "CA_TSX",
        currency: "CAD",
        comparisonSpecDigest: "c".repeat(64),
        sessionMembership: {
          orderedSessionDates: ["2026-09-14", quietDate],
          sessionMembershipDigest: "d".repeat(64),
        },
        capital: {
          initialCash: 25_000,
          dailyLossLimit: 2_500,
          riskConfigurationDigest: "a".repeat(64),
        },
      },
      sessionPairs: [
        {
          sessionDate: "2026-09-14",
          champion: championSessions[0]!.valuation,
          challenger: challengerSessions[0]!.valuation,
        },
        {
          sessionDate: quietDate,
          champion: championSessions[1]!.valuation,
          challenger: challengerSessions[1]!.valuation,
        },
      ],
      champion,
      challenger,
      championEvaluationDigest: "a".repeat(64),
      challengerEvaluationDigest: "b".repeat(64),
    });
    expect(result.pairedSessions[1]).toMatchObject({
      sessionDate: quietDate,
      baselineNetReturn: 0,
      challengerNetReturn: 0,
    });
    expect(result.champion.stability.zeroTradeSessions).toBe(1);
    expect(result.challenger.stability.zeroTradeSessions).toBe(1);
  });

  it("labels 19 sessions insufficient and 20 sufficient", () => {
    const buildResult = (count: number) => {
      const sessions = Array.from({ length: count }, (_, index) =>
        session(`2026-09-${(index + 1).toString().padStart(2, "0")}`, 25_050),
      );
      const metrics = assembleSideMetrics(sideInput({ sessions }));
      return assembleComparisonResult({
        specification: {
          marketId: "CA_TSX",
          currency: "CAD",
          comparisonSpecDigest: "c".repeat(64),
          sessionMembership: {
            orderedSessionDates: sessions.map((value) => value.sessionDate),
            sessionMembershipDigest: "d".repeat(64),
          },
          capital: {
            initialCash: 25_000,
            dailyLossLimit: 2_500,
            riskConfigurationDigest: "a".repeat(64),
          },
        },
        sessionPairs: sessions.map((value) => ({
          sessionDate: value.sessionDate,
          champion: value.valuation,
          challenger: value.valuation,
        })),
        champion: metrics,
        challenger: metrics,
        championEvaluationDigest: "a".repeat(64),
        challengerEvaluationDigest: "b".repeat(64),
      });
    };
    expect(buildResult(19).historicalVolumeStatus).toBe(
      "INSUFFICIENT_SESSIONS",
    );
    expect(buildResult(20).historicalVolumeStatus).toBe(
      "SUFFICIENT_FOR_LATER_G2",
    );
  });

  it("refuses to assemble a side metric tree from an unavailable valuation", () => {
    expect(() =>
      assembleSideMetrics(
        sideInput({
          sessions: [
            session("2026-09-14", 25_100, {
              valuation: valuation(25_100, {
                status: "UNAVAILABLE",
                reason: "STALE_MARK",
                equityPoints: [],
                maxDrawdown: null,
                maxDrawdownPctOfInitialCash: null,
              }),
            }),
          ],
        }),
      ),
    ).toThrow(/unavailable valuation/i);
  });

  it("refuses to assemble a paired result unless both sides are PROVEN", () => {
    const proven = assembleSideMetrics(sideInput());
    expect(() =>
      assembleComparisonResult({
        specification: {
          marketId: "CA_TSX",
          currency: "CAD",
          comparisonSpecDigest: "c".repeat(64),
          sessionMembership: {
            orderedSessionDates: ["2026-09-14"],
            sessionMembershipDigest: "d".repeat(64),
          },
          capital: {
            initialCash: 25_000,
            dailyLossLimit: 2_500,
            riskConfigurationDigest: "a".repeat(64),
          },
        },
        sessionPairs: [
          {
            sessionDate: "2026-09-14",
            champion: valuation(25_100),
            challenger: valuation(25_100, {
              status: "UNAVAILABLE",
              reason: "STALE_MARK",
              equityPoints: [],
              maxDrawdown: null,
              maxDrawdownPctOfInitialCash: null,
            }),
          },
        ],
        champion: proven,
        challenger: proven,
        championEvaluationDigest: "a".repeat(64),
        challengerEvaluationDigest: "b".repeat(64),
      }),
    ).toThrow(/both sides PROVEN/i);
  });

  it("refuses to assemble a proven subset of the frozen session membership", () => {
    const onlyFirstSession = assembleSideMetrics(
      sideInput({ sessions: [session("2026-09-14", 25_100)] }),
    );
    expect(() =>
      assembleComparisonResult({
        specification: {
          marketId: "CA_TSX",
          currency: "CAD",
          comparisonSpecDigest: "c".repeat(64),
          sessionMembership: {
            orderedSessionDates: ["2026-09-14", "2026-09-15"],
            sessionMembershipDigest: "d".repeat(64),
          },
          capital: {
            initialCash: 25_000,
            dailyLossLimit: 2_500,
            riskConfigurationDigest: "a".repeat(64),
          },
        },
        sessionPairs: [
          {
            sessionDate: "2026-09-14",
            champion: valuation(25_100),
            challenger: valuation(25_100),
          },
        ],
        champion: onlyFirstSession,
        challenger: onlyFirstSession,
        championEvaluationDigest: "a".repeat(64),
        challengerEvaluationDigest: "b".repeat(64),
      }),
    ).toThrow(/frozen session membership/i);
  });
});
