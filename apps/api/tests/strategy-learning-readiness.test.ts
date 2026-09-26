import { describe, expect, it } from "vitest";
import {
  assessStrategyLearningReadiness,
  type StrategyLearningEvidenceRecord,
  type StrategyLearningScope,
} from "../src/backtests/strategy-learning-readiness.js";

const scope: StrategyLearningScope = {
  marketId: "CA_TSX",
  strategyKey: "ORB_RETEST",
  profileConfigId: "00000000-0000-4000-8000-000000000001",
  strategyVersion: "v3",
  configVersion: "cfg-1",
  executionModelVersion: "execution-v2",
  executionAssumptions: { feePerTrade: 1 },
};

function evidence(
  overrides: Partial<StrategyLearningEvidenceRecord> = {},
): StrategyLearningEvidenceRecord {
  return {
    scope,
    setupInstanceId: "setup-1",
    sessionDate: "2026-09-01",
    signalHour: 10,
    atrPct: 1.2,
    rvolAtTime: 2.1,
    coverageVerified: true,
    lineageVerified: true,
    candidateCount: 1,
    qualification: "EVIDENCE_QUALIFIED",
    closedOutcome: {
      netPnl: 40,
      rMultiple: 1,
      exitReason: "TARGET",
      exitTime: "2026-09-01T14:30:00.000Z",
      entryPrice: 100,
      exitPrice: 104,
    },
    ...overrides,
  };
}

describe("strategy learning readiness", () => {
  it("counts a repeated replay of one setup as one closed outcome", () => {
    const result = assessStrategyLearningReadiness(
      scope,
      [evidence(), evidence()],
      {
        targetDistinctTrades: 30,
        recentSessions: 10,
      },
    );

    expect(result.distinctClosedTrades).toBe(1);
    expect(result.usableModelRows).toBe(1);
    expect(result.state).toBe("WAITING_FOR_EVIDENCE");
    expect(result.collectionEstimate).toMatchObject({
      state: "AVAILABLE_RANGE",
      observedRateMin: 1,
      observedRateMax: 1,
      observedSessions: 1,
    });
  });

  it("aggregates qualification across compatible replays without duplicating the outcome", () => {
    const result = assessStrategyLearningReadiness(
      scope,
      [
        evidence({ qualification: "EXPLORATORY" }),
        evidence({ qualification: "EVIDENCE_QUALIFIED" }),
      ],
      { targetDistinctTrades: 30, recentSessions: 10 },
    );

    expect(result.distinctClosedTrades).toBe(1);
    expect(result.qualificationCounts).toEqual({
      EVIDENCE_QUALIFIED: 1,
      EXPLORATORY: 0,
    });
    expect(result.blockers).not.toContain(
      "CONFLICTING_DUPLICATE_OUTCOME_IDENTITY",
    );
  });

  it("does not combine a different profile or unverified lineage", () => {
    const result = assessStrategyLearningReadiness(
      scope,
      [
        evidence({ scope: { ...scope, profileConfigId: "other-profile" } }),
        evidence({ setupInstanceId: "setup-2", lineageVerified: false }),
      ],
      {
        targetDistinctTrades: 30,
        recentSessions: 10,
      },
    );

    expect(result.distinctClosedTrades).toBe(0);
    expect(result.exclusions.INCOMPATIBLE_SCOPE).toBe(1);
    expect(result.blockers).toContain("UNVERIFIED_LINEAGE");
    expect(result.collectionEstimate).toEqual({
      state: "UNAVAILABLE",
      reason: "NO_VERIFIED_SESSIONS",
      observedRateMin: null,
      observedRateMax: null,
      observedSessions: 0,
    });
  });

  it("does not credit a zero-candidate replay as a verified session", () => {
    const result = assessStrategyLearningReadiness(
      scope,
      [evidence({ candidateCount: 0, setupInstanceId: null })],
      {
        targetDistinctTrades: 30,
        recentSessions: 10,
      },
    );

    expect(result.state).toBe("WAITING_FOR_EVIDENCE");
    expect(result.verifiedSessions).toBe(0);
    expect(result.exclusions.NO_REPLAY_CANDIDATES).toBe(1);
    expect(result.blockers).toEqual([]);
  });

  it("includes exploratory outcomes while keeping their qualification separate", () => {
    const result = assessStrategyLearningReadiness(
      scope,
      [evidence({ qualification: "EXPLORATORY" })],
      {
        targetDistinctTrades: 30,
        recentSessions: 10,
      },
    );

    expect(result.distinctClosedTrades).toBe(1);
    expect(
      (result as { qualificationCounts?: Record<string, number> })
        .qualificationCounts,
    ).toEqual({
      EVIDENCE_QUALIFIED: 0,
      EXPLORATORY: 1,
    });
  });

  it("reports thirty exploratory outcomes as a met raw sample threshold, not ready for review", () => {
    const result = assessStrategyLearningReadiness(
      scope,
      Array.from({ length: 30 }, (_, index) =>
        evidence({
          setupInstanceId: `exploratory-${index}`,
          qualification: "EXPLORATORY",
        }),
      ),
      {
        targetDistinctTrades: 30,
        recentSessions: 10,
      },
    );

    expect(result.state).toBe("SAMPLE_THRESHOLD_MET");
    expect(result.distinctClosedTrades).toBe(30);
    expect(result.shortfall).toBe(0);
    expect(result.qualificationCounts).toEqual({
      EVIDENCE_QUALIFIED: 0,
      EXPLORATORY: 30,
    });
  });

  it("fails closed when the same setup identity has conflicting outcome data", () => {
    const result = assessStrategyLearningReadiness(
      scope,
      [
        evidence(),
        evidence({
          closedOutcome: {
            netPnl: -20,
            rMultiple: -0.5,
            exitReason: "STOP",
            exitTime: "2026-09-01T14:31:00.000Z",
            entryPrice: 100,
            exitPrice: 98,
          },
        }),
      ],
      {
        targetDistinctTrades: 30,
        recentSessions: 10,
      },
    );

    expect(result.distinctClosedTrades).toBe(0);
    expect(result.blockers).toContain("CONFLICTING_DUPLICATE_OUTCOME_IDENTITY");
    expect(result.exclusions.CONFLICTING_DUPLICATE_OUTCOME_IDENTITY).toBe(1);
  });
  it("uses deduplicated outcomes per verified session and counts an empty session as zero", () => {
    const result = assessStrategyLearningReadiness(
      scope,
      [
        evidence({ sessionDate: "2026-09-01" }),
        evidence({ sessionDate: "2026-09-01" }),
        evidence({
          setupInstanceId: null,
          sessionDate: "2026-09-02",
          closedOutcome: null,
        }),
      ],
      { targetDistinctTrades: 30, recentSessions: 10 },
    );

    expect(result.distinctClosedTrades).toBe(1);
    expect(result.verifiedSessions).toBe(2);
    expect(result.collectionEstimate).toMatchObject({
      state: "UNAVAILABLE",
      reason: "ZERO_OUTCOME_SESSION",
      observedRateMin: 0,
      observedRateMax: 1,
      observedSessions: 2,
    });
  });
});
