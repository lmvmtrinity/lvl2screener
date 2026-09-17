import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type {
  BacktestReplayResult,
  BacktestTrade,
} from "@tsx-scanner/contracts";
import { buildBacktestEvidence } from "../src/backtests/evidence-service.js";

function replayResult(trades: BacktestTrade[]): BacktestReplayResult {
  return {
    trades,
    timeline: [],
    metrics: {} as BacktestReplayResult["metrics"],
    analyses: [],
    dataQuality: {} as BacktestReplayResult["dataQuality"],
  };
}

const BASE_MS = Date.parse("2026-03-02T13:30:00.000Z");

let nextSeedIndex = 0;
const tradeArbitrary = fc
  .record({
    index: fc.integer({ min: 0, max: 400 }),
    holdMinutes: fc.integer({ min: 1, max: 240 }),
    netPnl: fc.float({
      min: Math.fround(-500),
      max: Math.fround(500),
      noNaN: true,
    }),
    exitReason: fc.constantFrom(
      "STOP" as const,
      "TARGET" as const,
      "SESSION_CLOSE" as const,
    ),
    strategy: fc.constantFrom(
      "ORB_RETEST" as const,
      "BULL_FLAG" as const,
      "PRIOR_DAY_HIGH_BREAKOUT" as const,
    ),
    atrPct: fc.option(fc.float({ min: 0, max: Math.fround(5), noNaN: true }), {
      nil: null,
    }),
    rvolAtTime: fc.option(
      fc.float({ min: 0, max: Math.fround(5), noNaN: true }),
      { nil: null },
    ),
    sector: fc.option(fc.constantFrom("ENERGY", "FINANCIALS", "TECH"), {
      nil: null,
    }),
    shares: fc.integer({ min: 1, max: 1000 }),
    entryPrice: fc.float({
      min: Math.fround(1),
      max: Math.fround(200),
      noNaN: true,
    }),
    duplicate: fc.boolean(),
  })
  .map((value): BacktestTrade => {
    const seedIndex = nextSeedIndex++;
    const entryMs = BASE_MS + value.index * 15 * 60_000;
    const exitMs = entryMs + value.holdMinutes * 60_000;
    return {
      id: `00000000-0000-4000-8000-${String(seedIndex).padStart(12, "0")}`,
      runId: "00000000-0000-4000-8000-000000000001",
      instrumentId: "00000000-0000-4000-8000-000000000002",
      symbol: "BTO.TO",
      strategy: value.strategy,
      strategyVersion: "1.0.0",
      configVersion: "phase4-default-v1",
      signalTimestamp: new Date(entryMs).toISOString(),
      score: 80,
      entryTime: new Date(entryMs).toISOString(),
      entryPrice: value.entryPrice,
      stopPrice: Math.max(0.01, value.entryPrice - 1),
      targetPrice: value.entryPrice + 1,
      exitTime: new Date(exitMs).toISOString(),
      exitPrice: value.entryPrice,
      shares: value.shares,
      exitReason: value.exitReason,
      grossPnl: value.netPnl,
      netPnl: value.netPnl,
      rMultiple: 0,
      holdMinutes: value.holdMinutes,
      reasonCodes: [],
      sector: value.sector,
      atrPct: value.atrPct,
      rvolAtTime: value.rvolAtTime,
      contextScore: 50,
      contexts: [],
      // Reusing the same instance id on ~half the generated trades models the
      // duplicate-READY replay this evidence report is required to collapse.
      setupInstanceId: value.duplicate
        ? "00000000-0000-4000-8000-00000000dupe"
        : `00000000-0000-4000-8000-${String(seedIndex + 1).padStart(12, "0")}`,
    };
  });

describe("Phase 9 property tests: backtest evidence bounds", () => {
  it("every bootstrap confidence interval keeps lower <= estimate's bound <= upper", () => {
    fc.assert(
      fc.property(
        fc.array(tradeArbitrary, { minLength: 0, maxLength: 25 }),
        (trades) => {
          const report = buildBacktestEvidence(replayResult(trades));
          for (const interval of [
            report.expectancy,
            report.winRate,
            report.falseBreakoutRate,
          ]) {
            if (interval.lower === null || interval.upper === null) continue;
            expect(interval.lower).toBeLessThanOrEqual(interval.upper);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("win rate and false-breakout rate estimates always stay within [0, 100]", () => {
    fc.assert(
      fc.property(
        fc.array(tradeArbitrary, { minLength: 1, maxLength: 25 }),
        (trades) => {
          const report = buildBacktestEvidence(replayResult(trades));
          for (const interval of [report.winRate, report.falseBreakoutRate]) {
            if (interval.estimate === null) continue;
            expect(interval.estimate).toBeGreaterThanOrEqual(0);
            expect(interval.estimate).toBeLessThanOrEqual(100);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("qualification is always one of the two Phase 8 tiers and never crashes on any generated sample", () => {
    fc.assert(
      fc.property(
        fc.array(tradeArbitrary, { minLength: 0, maxLength: 25 }),
        (trades) => {
          const report = buildBacktestEvidence(replayResult(trades));
          expect(["EXPLORATORY", "EVIDENCE_QUALIFIED"]).toContain(
            report.qualification,
          );
          expect(report.duplicateReadyEventsExcluded).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("deduplicates trades sharing a setup instance before computing portfolio overlap", () => {
    fc.assert(
      fc.property(
        fc.array(tradeArbitrary, { minLength: 0, maxLength: 25 }),
        (trades) => {
          const report = buildBacktestEvidence(replayResult(trades));
          const uniqueInstanceIds = new Set(
            trades.map((trade) => trade.setupInstanceId ?? trade.id),
          ).size;
          expect(
            report.portfolioRisk.maximumConcurrentTrades,
          ).toBeLessThanOrEqual(uniqueInstanceIds);
        },
      ),
      { numRuns: 200 },
    );
  });
});
