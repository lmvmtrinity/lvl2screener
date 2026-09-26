import { describe, expect, it } from "vitest";
import { strategyLearningReadinessSchema } from "../src/domains/strategy-learning-loop.js";

describe("strategy learning readiness contract", () => {
  it("keeps BACKTEST_RUN sample shortage and lineage blockers distinct", () => {
    const parsed = strategyLearningReadinessSchema.parse({
      sourceKind: "BACKTEST_RUN",
      scope: {
        marketId: "US_EQUITIES",
        strategyKey: "ORB_RETEST",
        profileConfigId: "00000000-0000-4000-8000-000000000001",
        strategyVersion: "v3",
        configVersion: "cfg-1",
        executionModelVersion: "execution-v2",
        executionAssumptions: {},
      },
      state: "UNVERIFIED_INPUT",
      targetDistinctTrades: 30,
      verifiedSessions: 0,
      distinctClosedTrades: 0,
      usableModelRows: 0,
      qualificationCounts: { EVIDENCE_QUALIFIED: 0, EXPLORATORY: 0 },
      exclusions: { UNVERIFIED_LINEAGE: 1 },
      strata: { time: {}, atr: {}, rvol: {} },
      blockers: ["UNVERIFIED_LINEAGE"],
      shortfall: 30,
      feasibility: {
        state: "UNAVAILABLE",
        reason: "MISSING_PREDECLARED_EXPERIMENT_CRITERIA",
      },
      collectionEstimate: {
        state: "UNAVAILABLE",
        reason: "NO_VERIFIED_SESSIONS",
        observedRateMin: null,
        observedRateMax: null,
        observedSessions: 0,
      },
    });

    expect(parsed.scope.marketId).toBe("US_EQUITIES");
    expect(parsed.state).toBe("UNVERIFIED_INPUT");
    expect(parsed.collectionEstimate.state).toBe("UNAVAILABLE");
  });
});
