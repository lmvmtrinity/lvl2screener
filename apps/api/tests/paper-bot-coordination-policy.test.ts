import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canLeadPosition,
  coordinateCandidates,
  isStalledBreakout,
  maximumHoldingMinutesFor,
  strategyFamily,
  COORDINATION_POLICY_VERSION,
  type ContextSnapshot,
  type CoordinationCandidate,
} from "../src/paper-bot/coordination-policy.js";

const decisionAt = "2026-09-01T14:00:00.000Z";

function candidate(
  overrides: Partial<CoordinationCandidate> = {},
): CoordinationCandidate {
  return {
    observationId: "observation-orb",
    strategyKey: "ORB_RETEST",
    strategyVersion: "v1",
    score: 80,
    entryPrice: 10,
    stopPrice: 9.5,
    targetPrice: 11,
    economicallyViable: true,
    estimatedInitialRisk: 50,
    ...overrides,
  };
}

const noExposure = {
  hasOpenSymbolPosition: false,
  lastStopAt: null,
  openPositionCount: 0,
  totalOpenRisk: 0,
  dailyRealizedLoss: 0,
  consecutiveStops: 0,
};
const policy = {
  cooldownMinutesAfterStop: 15,
  maxOpenPositions: 3,
  maxTotalOpenRisk: 1_000,
  maxDailyLoss: 1_000,
  maxConsecutiveStops: 3,
};

const freshContext: ContextSnapshot[] = [
  {
    signalKey: "MARKET_RELATIVE_STRENGTH",
    status: "STRONG",
    score: 80,
    timestamp: "2026-09-01T13:59:00.000Z",
  },
  {
    signalKey: "SECTOR_RELATIVE_STRENGTH",
    status: "NEUTRAL",
    score: 55,
    timestamp: "2026-09-01T13:59:00.000Z",
  },
];
const contextPolicy = {
  ...policy,
  requireFreshContext: true,
  contextMaxAgeSeconds: 300,
  vetoOnWeakContext: true,
};

describe("paper-bot coordination policy", () => {
  it("classifies closely related strategies into one family", () => {
    expect(strategyFamily("ORB_RETEST")).toBe("OPENING_RANGE");
    expect(strategyFamily("VWAP_RECLAIM")).toBe("VWAP");
    expect(strategyFamily("RSI_VWAP_RECLAIM")).toBe("VWAP");
    expect(strategyFamily("HIGH_OF_DAY_BREAKOUT")).toBe("BREAKOUT");
  });

  it("selects best feasible reward/risk before raw score and records independent-family confirmation", () => {
    const decision = coordinateCandidates(
      [
        candidate({
          observationId: "vwap",
          strategyKey: "VWAP_HOLD",
          score: 98,
          targetPrice: 10.5,
        }),
        candidate({ observationId: "orb", score: 80, targetPrice: 10.75 }),
        candidate({
          observationId: "hod",
          strategyKey: "HIGH_OF_DAY_BREAKOUT",
          score: 70,
          targetPrice: 11,
        }),
      ],
      noExposure,
      policy,
      decisionAt,
    );

    expect(decision).toMatchObject({
      outcome: "APPROVED",
      reason: "SELECTED_PRIMARY",
      selectedObservationId: "hod",
    });
    expect(decision.confirmationObservationIds).toEqual(["orb", "vwap"]);
  });

  it("does not permit another symbol position even when an alternative scores better", () => {
    const decision = coordinateCandidates(
      [candidate()],
      { ...noExposure, hasOpenSymbolPosition: true },
      policy,
      decisionAt,
    );
    expect(decision.reason).toBe("SYMBOL_POSITION_OPEN");
  });

  it("blocks a new coordinated position at either portfolio limit", () => {
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, openPositionCount: 3 },
        policy,
        decisionAt,
      ).reason,
    ).toBe("MAX_CONCURRENT_POSITIONS");
    expect(
      coordinateCandidates(
        [candidate({ estimatedInitialRisk: 75 })],
        { ...noExposure, totalOpenRisk: 950 },
        policy,
        decisionAt,
      ).reason,
    ).toBe("PORTFOLIO_RISK_LIMIT");
  });

  it("defers every new approval while an earlier run has unresolved portfolio state", () => {
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, portfolioReconciliationRequired: true },
        policy,
        decisionAt,
      ),
    ).toMatchObject({
      outcome: "DEFERRED",
      reason: "PORTFOLIO_RECONCILIATION_REQUIRED",
    });
  });

  it("opens the daily-loss and consecutive-stop circuit breakers before a new entry", () => {
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, dailyRealizedLoss: 1_000 },
        policy,
        decisionAt,
      ).reason,
    ).toBe("DAILY_LOSS_LIMIT");
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, consecutiveStops: 3 },
        policy,
        decisionAt,
      ).reason,
    ).toBe("CONSECUTIVE_STOP_LIMIT");
  });

  it("blocks re-entry before the post-stop cooldown expires and permits it at expiry", () => {
    const blocked = coordinateCandidates(
      [candidate()],
      { ...noExposure, lastStopAt: "2026-09-01T13:50:00.000Z" },
      policy,
      decisionAt,
    );
    expect(blocked.reason).toBe("POST_STOP_COOLDOWN");

    const allowed = coordinateCandidates(
      [candidate()],
      { ...noExposure, lastStopAt: "2026-09-01T13:45:00.000Z" },
      policy,
      decisionAt,
    );
    expect(allowed.reason).toBe("SELECTED_PRIMARY");
  });

  it("rejects invalid or economically impossible candidates without selecting one", () => {
    const decision = coordinateCandidates(
      [
        candidate({ economicallyViable: false }),
        candidate({ observationId: "bad-levels", stopPrice: 10 }),
      ],
      noExposure,
      policy,
      decisionAt,
    );
    expect(decision).toMatchObject({
      outcome: "REJECTED",
      reason: "NO_FEASIBLE_CANDIDATE",
      selectedObservationId: null,
    });
  });
});

describe("paper-bot coordination policy v3", () => {
  it("defers a suppression that can clear and rejects a judgment that cannot", () => {
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, hasOpenSymbolPosition: true },
        policy,
        decisionAt,
      ).outcome,
    ).toBe("DEFERRED");
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, lastStopAt: "2026-09-01T13:50:00.000Z" },
        policy,
        decisionAt,
      ).outcome,
    ).toBe("DEFERRED");
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, dailyRealizedLoss: 1_000 },
        policy,
        decisionAt,
      ).outcome,
    ).toBe("REJECTED");
  });

  it("blocks a new position at the symbol and sector exposure caps", () => {
    const limited = {
      ...policy,
      maxSymbolNotional: 10_000,
      maxSectorNotional: 20_000,
    };
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, openSymbolNotional: 10_000 },
        limited,
        decisionAt,
      ),
    ).toMatchObject({ outcome: "DEFERRED", reason: "SYMBOL_EXPOSURE_LIMIT" });
    expect(
      coordinateCandidates(
        [candidate()],
        {
          ...noExposure,
          sector: "Financial Services",
          openSectorNotional: 20_000,
        },
        limited,
        decisionAt,
      ),
    ).toMatchObject({ outcome: "DEFERRED", reason: "SECTOR_EXPOSURE_LIMIT" });
  });

  it("requires fresh context, and records the readings it decided against", () => {
    const approved = coordinateCandidates(
      [candidate()],
      { ...noExposure, contexts: freshContext },
      contextPolicy,
      decisionAt,
    );
    expect(approved.outcome).toBe("APPROVED");
    expect(approved.contexts).toEqual(freshContext);
    expect(approved.contextAlignment).toBeCloseTo(1.5, 6);

    expect(
      coordinateCandidates(
        [candidate()],
        noExposure,
        contextPolicy,
        decisionAt,
      ),
    ).toMatchObject({
      outcome: "DEFERRED",
      reason: "CONTEXT_UNAVAILABLE",
    });

    const stale = freshContext.map((context) => ({
      ...context,
      timestamp: "2026-09-01T13:40:00.000Z",
    }));
    expect(
      coordinateCandidates(
        [candidate()],
        { ...noExposure, contexts: stale },
        contextPolicy,
        decisionAt,
      ),
    ).toMatchObject({ outcome: "DEFERRED", reason: "CONTEXT_STALE" });

    expect(
      coordinateCandidates(
        [candidate()],
        {
          ...noExposure,
          contexts: [{ ...freshContext[0]!, status: "WEAK" as const }],
        },
        contextPolicy,
        decisionAt,
      ),
    ).toMatchObject({ outcome: "REJECTED", reason: "CONTEXT_VETO" });
  });

  it("does not let market freshness substitute for required sector context", () => {
    const required = {
      ...contextPolicy,
      contextRequirement: "MARKET_AND_SECTOR_REQUIRED" as const,
    };
    expect(
      coordinateCandidates(
        [candidate()],
        {
          ...noExposure,
          contexts: [
            freshContext[0]!,
            { ...freshContext[1]!, status: "UNAVAILABLE" as const },
          ],
        },
        required,
        decisionAt,
      ),
    ).toMatchObject({
      outcome: "DEFERRED",
      reason: "SECTOR_CONTEXT_UNAVAILABLE",
    });
  });

  it("treats an inapplicable context reading as neutral, never as bearish", () => {
    const decision = coordinateCandidates(
      [candidate()],
      {
        ...noExposure,
        contexts: [
          freshContext[0]!,
          {
            signalKey: "SECTOR_RELATIVE_STRENGTH",
            status: "UNAVAILABLE",
            score: 0,
            timestamp: "2026-09-01T13:59:00.000Z",
          },
        ],
      },
      contextPolicy,
      decisionAt,
    );
    expect(decision.outcome).toBe("APPROVED");
    expect(decision.contextAlignment).toBe(2);
  });

  it("ranks on cost-inclusive reward/risk, not on the raw geometric ratio", () => {
    const decision = coordinateCandidates(
      [
        candidate({
          observationId: "wide-geometry",
          strategyKey: "VWAP_HOLD",
          targetPrice: 11,
          netRewardRisk: 0.4,
        }),
        candidate({
          observationId: "cost-aware",
          targetPrice: 10.6,
          netRewardRisk: 1.8,
        }),
      ],
      noExposure,
      policy,
      decisionAt,
    );
    expect(decision.selectedObservationId).toBe("cost-aware");
  });

  it("never lets a context-only strategy lead a position", () => {
    expect(canLeadPosition("MARKET_RELATIVE_STRENGTH")).toBe(false);
    expect(canLeadPosition("ORB_RETEST")).toBe(true);
    const decision = coordinateCandidates(
      [
        candidate({
          observationId: "context",
          strategyKey: "MARKET_RELATIVE_STRENGTH",
          score: 99,
          targetPrice: 12,
        }),
        candidate({ observationId: "orb", score: 51, targetPrice: 10.4 }),
      ],
      noExposure,
      policy,
      decisionAt,
    );
    expect(decision.selectedObservationId).toBe("orb");
    expect(decision.confirmationObservationIds).toEqual(["context"]);
  });

  it("cannot select a primary from context evidence alone", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            strategyKey: fc.constantFrom(
              "MARKET_RELATIVE_STRENGTH",
              "SECTOR_RELATIVE_STRENGTH",
            ),
            score: fc.integer({ min: 0, max: 100 }),
            targetPrice: fc.integer({ min: 1_001, max: 2_000 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (rows) => {
          const decision = coordinateCandidates(
            rows.map((row, index) =>
              candidate({
                observationId: `context-${index}`,
                strategyKey: row.strategyKey,
                score: row.score,
                targetPrice: row.targetPrice / 100,
              }),
            ),
            noExposure,
            policy,
            decisionAt,
          );
          return (
            decision.outcome === "REJECTED" &&
            decision.reason === "NO_FEASIBLE_CANDIDATE" &&
            decision.selectedObservationId === null
          );
        },
      ),
    );
  });

  it("selects the same primary regardless of candidate ordering", () => {
    const candidates = [
      candidate({ observationId: "a", targetPrice: 10.6, score: 60 }),
      candidate({
        observationId: "b",
        strategyKey: "VWAP_HOLD",
        targetPrice: 10.6,
        score: 60,
      }),
      candidate({
        observationId: "c",
        strategyKey: "BULL_FLAG",
        targetPrice: 10.9,
        score: 10,
      }),
    ];
    fc.assert(
      fc.property(
        fc.shuffledSubarray(candidates, { minLength: 3 }),
        (order) => {
          const decision = coordinateCandidates(
            order,
            noExposure,
            policy,
            decisionAt,
          );
          return decision.selectedObservationId === "c";
        },
      ),
    );
  });

  it("refuses a policy with a non-positive exposure or context limit", () => {
    expect(() =>
      coordinateCandidates(
        [candidate()],
        noExposure,
        { ...policy, maxSectorNotional: 0 },
        decisionAt,
      ),
    ).toThrow(/exposure and context limits/);
  });
});

describe("coordinated time and stall controls", () => {
  const position = {
    entryPrice: 10,
    stop: 9.5,
    entryTime: "2026-09-01T14:00:00.000Z",
  };
  const stallPolicy = {
    ...policy,
    maximumHoldingMinutes: 45,
    maximumHoldingMinutesByStrategy: { ORB_RETEST: 20 },
    stalledBreakoutMinutes: 15,
    stalledBreakoutMinProgressR: 0.25,
  };

  it("prefers a strategy's own holding horizon over the portfolio default", () => {
    expect(maximumHoldingMinutesFor(stallPolicy, "ORB_RETEST")).toBe(20);
    expect(maximumHoldingMinutesFor(stallPolicy, "BULL_FLAG")).toBe(45);
    expect(maximumHoldingMinutesFor(policy, "BULL_FLAG", 30)).toBe(30);
  });

  it("exits a breakout that has not progressed toward its target", () => {
    // Held 16 minutes at +0.05, i.e. 0.1R of the 0.50 per-share risk.
    expect(
      isStalledBreakout(
        stallPolicy,
        "HIGH_OF_DAY_BREAKOUT",
        position,
        10.05,
        "2026-09-01T14:16:00.000Z",
      ),
    ).toBe(true);
  });

  it("leaves a progressing, a young, or a non-breakout position alone", () => {
    expect(
      isStalledBreakout(
        stallPolicy,
        "HIGH_OF_DAY_BREAKOUT",
        position,
        10.2,
        "2026-09-01T14:16:00.000Z",
      ),
    ).toBe(false);
    expect(
      isStalledBreakout(
        stallPolicy,
        "HIGH_OF_DAY_BREAKOUT",
        position,
        10.05,
        "2026-09-01T14:10:00.000Z",
      ),
    ).toBe(false);
    expect(
      isStalledBreakout(
        stallPolicy,
        "VWAP_HOLD",
        position,
        10.05,
        "2026-09-01T14:16:00.000Z",
      ),
    ).toBe(false);
  });

  it("is inert until both stall thresholds are configured", () => {
    expect(
      isStalledBreakout(
        policy,
        "HIGH_OF_DAY_BREAKOUT",
        position,
        10.05,
        "2026-09-01T15:00:00.000Z",
      ),
    ).toBe(false);
  });
});

describe("paper-coordination-v4-shadow and model-informed ranking", () => {
  it("generates shadow decision alongside primary v3 decision", () => {
    const candidateA = candidate({
      observationId: "obs-a",
      strategyKey: "ORB_RETEST",
      entryPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11, // RR 2.0
      prediction: {
        predictedProbability: 0.65,
        expectedR: 0.35,
      },
    });

    const decision = coordinateCandidates(
      [candidateA],
      noExposure,
      policy,
      decisionAt,
    );

    expect(decision.policyVersion).toBe(COORDINATION_POLICY_VERSION);
    expect(decision.outcome).toBe("APPROVED");
    expect(decision.selectedObservationId).toBe("obs-a");
    expect(decision.shadowDecision).toBeDefined();
    expect(decision.shadowDecision?.policyVersion).toBe(
      "paper-coordination-v4-shadow",
    );
    expect(decision.shadowDecision?.outcome).toBe("APPROVED");
    expect(decision.shadowDecision?.selectedObservationId).toBe("obs-a");
    expect(decision.shadowDecision?.differsFromPrimary).toBe(false);
  });

  it("prefers higher expected R in v4 shadow ranking when primary v3 tie-breaks on score", () => {
    const candidateA = candidate({
      observationId: "obs-a",
      strategyKey: "ORB_RETEST",
      entryPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11, // RR 2.0
      score: 95, // Higher deterministic score -> v3 will prefer A
      prediction: {
        predictedProbability: 0.55,
        expectedR: 0.15,
      },
    });
    const candidateB = candidate({
      observationId: "obs-b",
      strategyKey: "VWAP_HOLD",
      entryPrice: 20,
      stopPrice: 19,
      targetPrice: 22, // RR 2.0
      score: 80, // Lower score
      prediction: {
        predictedProbability: 0.72,
        expectedR: 0.48, // Higher expected R -> v4 shadow will prefer B
      },
    });

    const decision = coordinateCandidates(
      [candidateA, candidateB],
      noExposure,
      policy,
      decisionAt,
    );

    // Primary v3 picks candidate A because of score 95 vs 80
    expect(decision.outcome).toBe("APPROVED");
    expect(decision.selectedObservationId).toBe("obs-a");

    // Shadow v4 picks candidate B because of expectedR 0.48 vs 0.15
    expect(decision.shadowDecision?.outcome).toBe("APPROVED");
    expect(decision.shadowDecision?.selectedObservationId).toBe("obs-b");
    expect(decision.shadowDecision?.differsFromPrimary).toBe(true);
    expect(decision.shadowDecision?.differenceReason).toBe(
      "V4_SHADOW_HIGHER_EXPECTED_R",
    );
  });

  it("statistically vetoes low-expectancy candidate in shadow without affecting primary v3", () => {
    const candidateA = candidate({
      observationId: "obs-low-expectancy",
      strategyKey: "ORB_RETEST",
      entryPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11,
      prediction: {
        predictedProbability: 0.35,
        expectedR: -0.2, // Negative expectancy
      },
    });

    const shadowPolicy = {
      ...policy,
      minimumExpectedR: 0.05, // Requires >= +0.05R
      minimumSetupProbability: 0.5, // Requires >= 50%
    };

    const decision = coordinateCandidates(
      [candidateA],
      noExposure,
      shadowPolicy,
      decisionAt,
    );

    // Primary v3 remains APPROVED (model-blind!)
    expect(decision.outcome).toBe("APPROVED");
    expect(decision.selectedObservationId).toBe("obs-low-expectancy");

    // Shadow v4 vetoes and REJECTS with PREDICTED_LOW_EXPECTANCY
    expect(decision.shadowDecision?.outcome).toBe("REJECTED");
    expect(decision.shadowDecision?.reason).toBe("PREDICTED_LOW_EXPECTANCY");
    expect(decision.shadowDecision?.selectedObservationId).toBeNull();
    expect(decision.shadowDecision?.differsFromPrimary).toBe(true);
    expect(decision.shadowDecision?.differenceReason).toBe(
      "V4_SHADOW_VETOED_LOW_EXPECTANCY",
    );
  });

  describe("Phase C: portfolio risk controls & loss accounting (F-10)", () => {
    it("distinguishes CUMULATIVE_LOSS from NET_REALIZED_LOSS policies", () => {
      const stateWithWinningOffset = {
        ...noExposure,
        dailyRealizedLoss: 150,
        dailyCumulativeLoss: 150,
        dailyNetRealizedPnl: 50, // +$50 net despite -$150 in gross losses
      };

      // Default CUMULATIVE_LOSS triggers limit because gross losses (150) >= maxDailyLoss (100)
      const defaultDecision = coordinateCandidates(
        [candidate()],
        stateWithWinningOffset,
        { ...policy, maxDailyLoss: 100 },
        decisionAt,
      );
      expect(defaultDecision.outcome).toBe("REJECTED");
      expect(defaultDecision.reason).toBe("DAILY_LOSS_LIMIT");

      // NET_REALIZED_LOSS allows entry because net P&L is positive (+50)
      const netDecision = coordinateCandidates(
        [candidate()],
        stateWithWinningOffset,
        {
          ...policy,
          maxDailyLoss: 100,
          dailyLossLimitType: "NET_REALIZED_LOSS",
        },
        decisionAt,
      );
      expect(netDecision.outcome).toBe("APPROVED");
      expect(netDecision.reason).toBe("SELECTED_PRIMARY");

      // NET_REALIZED_LOSS triggers limit when net loss exceeds maxDailyLoss
      const stateWithNetLoss = {
        ...noExposure,
        dailyRealizedLoss: 150,
        dailyCumulativeLoss: 150,
        dailyNetRealizedPnl: -120, // Net loss exceeds $100 limit
      };
      const netLossDecision = coordinateCandidates(
        [candidate()],
        stateWithNetLoss,
        {
          ...policy,
          maxDailyLoss: 100,
          dailyLossLimitType: "NET_REALIZED_LOSS",
        },
        decisionAt,
      );
      expect(netLossDecision.outcome).toBe("REJECTED");
      expect(netLossDecision.reason).toBe("DAILY_LOSS_LIMIT");
    });

    it("reserves remaining daily risk when reserveRemainingDailyRisk is enabled", () => {
      const state = {
        ...noExposure,
        dailyRealizedLoss: 40,
        dailyCumulativeLoss: 40,
        totalOpenRisk: 35,
      };
      const candidateSetup = candidate({ estimatedInitialRisk: 30 });

      // Without reserveRemainingDailyRisk: 40 < 100, openRisk + candidateRisk = 65 <= 1000 -> APPROVED
      const unreservedDecision = coordinateCandidates(
        [candidateSetup],
        state,
        { ...policy, maxDailyLoss: 100, reserveRemainingDailyRisk: false },
        decisionAt,
      );
      expect(unreservedDecision.outcome).toBe("APPROVED");

      // With reserveRemainingDailyRisk: 40 (current loss) + 35 (open risk) + 30 (candidate risk) = 105 > 100 -> REJECTED
      const reservedDecision = coordinateCandidates(
        [candidateSetup],
        state,
        { ...policy, maxDailyLoss: 100, reserveRemainingDailyRisk: true },
        decisionAt,
      );
      expect(reservedDecision.outcome).toBe("REJECTED");
      expect(reservedDecision.reason).toBe("DAILY_LOSS_LIMIT");

      // Smaller candidate: 40 + 35 + 20 = 95 <= 100 -> APPROVED
      const smallerCandidate = candidate({ estimatedInitialRisk: 20 });
      const smallerDecision = coordinateCandidates(
        [smallerCandidate],
        state,
        { ...policy, maxDailyLoss: 100, reserveRemainingDailyRisk: true },
        decisionAt,
      );
      expect(smallerDecision.outcome).toBe("APPROVED");
      expect(smallerDecision.reason).toBe("SELECTED_PRIMARY");
    });
  });
});
