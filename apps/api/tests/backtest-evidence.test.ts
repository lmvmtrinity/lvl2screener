import { describe, expect, it } from "vitest";
import type {
  BacktestReplayResult,
  BacktestTrade,
} from "@tsx-scanner/contracts";
import {
  buildBacktestEvidence,
  buildStrategyBacktestEvidence,
} from "../src/backtests/evidence-service.js";

const uuid = (value: number) =>
  `10000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

function trade(
  index: number,
  day: number,
  setupInstanceId: string | null = uuid(index + 1),
): BacktestTrade {
  const entry = `2026-08-${String(day).padStart(2, "0")}T14:${String(index % 30).padStart(2, "0")}:00.000Z`;
  const exit = new Date(Date.parse(entry) + 15 * 60_000).toISOString();
  return {
    id: uuid(index + 500),
    runId: uuid(900),
    instrumentId: uuid(index + 1_000),
    symbol: `T${index}.TO`,
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configVersion: "phase8-evidence-test",
    signalTimestamp: entry,
    score: 85,
    entryTime: entry,
    entryPrice: 10,
    stopPrice: 9.5,
    targetPrice: 11,
    exitTime: exit,
    exitPrice: 11,
    shares: 100,
    exitReason: "TARGET",
    grossPnl: 100,
    netPnl: 100,
    rMultiple: 2,
    holdMinutes: 15,
    reasonCodes: [],
    sector: "Materials",
    atrPct: 2,
    rvolAtTime: 2,
    contextScore: 50,
    contexts: [],
    setupInstanceId,
  };
}

function replay(
  trades: BacktestTrade[],
  duplicateReady = false,
): BacktestReplayResult {
  const timeline = trades.map((value) => ({
    instrumentId: value.instrumentId,
    symbol: value.symbol,
    strategy: value.strategy,
    timestamp: value.entryTime,
    previousState: "FORMING" as const,
    state: "READY" as const,
    score: value.score,
    reasonCodes: [],
    setupInstanceId: value.setupInstanceId ?? null,
  }));
  if (duplicateReady && timeline[0])
    timeline.push({
      ...timeline[0],
      timestamp: new Date(
        Date.parse(timeline[0].timestamp) + 1_000,
      ).toISOString(),
    });
  return {
    trades,
    timeline,
    analyses: [],
    metrics: {} as never,
    dataQuality: {
      quoteSnapshots: 1,
      candles: 1,
      sessions: 1,
      spread: "CAPTURED",
      warnings: [],
    },
  };
}

describe("Phase 8 evidence reporting", () => {
  it("uses setup instances, deterministic bootstrap ranges, slice gates, and walk-forward windows", () => {
    const trades = Array.from({ length: 120 }, (_, index) =>
      trade(index, 10 + Math.floor(index / 30)),
    );
    const first = buildBacktestEvidence(
      replay(trades, true),
      new Date("2026-08-28T12:00:00.000Z"),
    );
    const repeated = buildBacktestEvidence(
      replay(trades, true),
      new Date("2026-08-28T12:00:00.000Z"),
    );
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      qualification: "EVIDENCE_QUALIFIED",
      uniqueSetupInstances: 120,
      duplicateReadyEventsExcluded: 1,
      adequateSamples: true,
      positiveExpectancyRange: true,
      expectancy: { estimate: 100, lower: 100, upper: 100, samples: 120 },
    });
    expect(first.walkForward).toHaveLength(3);
    expect(first.sliceGates).toHaveLength(4);
  });

  it("keeps underpowered and legacy evidence exploratory", () => {
    const report = buildBacktestEvidence(
      replay([trade(1, 10, null)]),
      new Date("2026-08-28T12:00:00.000Z"),
    );
    expect(report.qualification).toBe("EXPLORATORY");
    expect(report.adequateSamples).toBe(false);
    expect(report.warnings.join(" ")).toContain("setup-instance identity");
  });

  it("reports simultaneous same-sector exposure", () => {
    const report = buildBacktestEvidence(replay([trade(1, 10), trade(2, 10)]));
    expect(report.portfolioRisk).toMatchObject({
      maximumConcurrentTrades: 2,
      overlappingTradePairs: 1,
      sameSectorOverlappingPairs: 1,
      sameSectorOverlapRate: 100,
    });
  });

  it("keeps mixed-strategy evidence separate for profile qualification", () => {
    const orb = Array.from({ length: 120 }, (_, index) =>
      trade(index, 10 + Math.floor(index / 30)),
    );
    const vwap = trade(300, 10);
    vwap.strategy = "VWAP_HOLD";
    const evidence = buildStrategyBacktestEvidence(
      replay([...orb, vwap]),
      new Date("2026-08-28T12:00:00.000Z"),
    );
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: "ORB_RETEST",
          evidence: expect.objectContaining({
            qualification: "EVIDENCE_QUALIFIED",
          }),
        }),
        expect.objectContaining({
          strategy: "VWAP_HOLD",
          evidence: expect.objectContaining({ qualification: "EXPLORATORY" }),
        }),
      ]),
    );
  });
});
