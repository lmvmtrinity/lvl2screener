import {
  backtestTradeSchema,
  createRankingResearchSchema,
  rankingResearchFormulaResultSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Phase 6 ranking research contracts", () => {
  it("defaults legacy backtest trades to neutral context", () => {
    const trade = backtestTradeSchema.parse({
      id: "10000000-0000-4000-8000-000000000001",
      runId: "10000000-0000-4000-8000-000000000002",
      instrumentId: "10000000-0000-4000-8000-000000000003",
      symbol: "TEST.TO",
      strategy: "ORB_RETEST",
      strategyVersion: "1.0.0",
      configVersion: "v1",
      signalTimestamp: "2026-08-28T14:00:00.000Z",
      score: 80,
      entryTime: "2026-08-28T14:00:00.000Z",
      entryPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      exitTime: "2026-08-28T14:05:00.000Z",
      exitPrice: 12,
      shares: 100,
      exitReason: "TARGET",
      grossPnl: 200,
      netPnl: 190,
      rMultiple: 1.9,
      holdMinutes: 5,
      reasonCodes: [],
    });
    expect(trade.contextScore).toBe(50);
    expect(trade.contexts).toEqual([]);
  });
  it("bounds experimental inputs and requires versioned formulas", () => {
    const value = createRankingResearchSchema.parse({
      name: "Study",
      backtestRunId: "10000000-0000-4000-8000-000000000002",
    });
    expect(value.formulaVersions).toHaveLength(2);
    expect(value.sensitivityMultipliers).toEqual([0.75, 1, 1.25]);
    expect(
      createRankingResearchSchema.safeParse({
        ...value,
        formulaVersions: ["ranking-tiebreak-v1"],
      }).success,
    ).toBe(false);
    expect(
      createRankingResearchSchema.safeParse({
        ...value,
        sensitivityMultipliers: [1, 1, 1],
      }).success,
    ).toBe(false);
  });
  it("requires a complete activation-gate audit", () => {
    const metrics = {
      samples: 1,
      averageR: 1,
      expectancyR: 1,
      falseBreakoutRate: 0,
      maximumDrawdownR: 0,
      netR: 1,
      contextEvidenceSamples: 1,
    };
    const segment = {
      start: null,
      end: null,
      baseline: metrics,
      candidate: metrics,
      baselineSlices: [],
      candidateSlices: [],
    };
    expect(
      rankingResearchFormulaResultSchema.safeParse({
        formulaVersion: "ranking-bounded-context-research-v1",
        mode: "BOUNDED_CONTEXT",
        train: segment,
        holdout: segment,
        sensitivity: [],
        costStressedCandidate: metrics,
        costStressedBaseline: metrics,
        correlatedInputFlags: [],
        gate: { eligibleForActivation: true, reasons: [] },
      }).success,
    ).toBe(false);
  });
});
