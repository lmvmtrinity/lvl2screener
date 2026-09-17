import { describe, expect, it } from "vitest";
import {
  contextEvaluationSchema,
  createBacktestSchema,
  engineResultBatchSchema,
  strategyEvaluationSchema,
} from "../src/index.js";

const feature = {
  instrumentId: "10000000-0000-4000-8000-000000000001",
  symbol: "BTO.TO",
  timestamp: "2026-08-27T14:00:00.000Z",
  timeframe: "OneMinute",
  featureVersion: "1.0.0",
  configVersion: "test",
  dataStatus: "REALTIME",
  actionable: true,
  price: 8,
  bid: 7.99,
  ask: 8.01,
  mid: 8,
  spreadAbsolute: 0.02,
  spreadPct: 0.25,
  changeFromOpenPct: 1,
  vwap: 7.95,
  distanceFromVwapPct: 0.63,
  closeAboveVwap: true,
  last3ClosesAboveVwap: 3,
  vwapSlopePct: 0.1,
  touchVwap: false,
  vwapReclaim: false,
  vwapRejection: false,
  atr14: 0.25,
  atrPct: 3.125,
  rvolAtTime: 2,
  currentCumulativeVolume: 100_000,
  historicalMeanCumulativeVolume: 50_000,
  openingRange: null,
  swingHighs: [],
  swingLows: [],
  nearestSupport: null,
  nearestResistance: null,
  distanceFromVwapAtr: 0.2,
  distanceFromOrhAtr: null,
  changeFromOpenAtr: 0.32,
  consecutiveGreenCandles: 2,
  recentMoveVelocityAtr: 0.1,
  warmingUp: [],
} as const;

const context = {
  kind: "CONTEXT",
  instrumentId: feature.instrumentId,
  symbol: feature.symbol,
  timestamp: feature.timestamp,
  profileId: "10000000-0000-4000-8000-000000000002",
  profileName: "Market Context",
  signal: "MARKET_RELATIVE_STRENGTH",
  signalVersion: "1.0.0",
  configVersion: "test",
  status: "STRONG",
  contextScore: 80,
  observedValue: 0.8,
  benchmarkSymbol: "XIU.TO",
  benchmarkValue: 0.2,
  benchmarkTimestamp: feature.timestamp,
  lookback: "SESSION_FROM_OPEN",
  reasonCodes: ["MARKET_OUTPERFORMANCE_STRONG"],
  featureSnapshot: feature,
} as const;

describe("setup and context contract boundary", () => {
  it("accepts context evidence but rejects setup trade fields", () => {
    expect(contextEvaluationSchema.parse(context).status).toBe("STRONG");
    expect(
      contextEvaluationSchema.safeParse({ ...context, entryReference: 8 })
        .success,
    ).toBe(false);
  });

  it("rejects context strategies in setup evaluations and trade backtests", () => {
    const setup = {
      ...context,
      kind: "SETUP",
      strategy: "MARKET_RELATIVE_STRENGTH",
      strategyVersion: "1.0.0",
      state: "READY",
      score: 80,
      setupScore: 80,
      entryReference: 8,
      stopReference: 7.8,
      targetReference: 8.4,
      estimatedRr: 2,
    };
    expect(strategyEvaluationSchema.safeParse(setup).success).toBe(false);
    expect(
      createBacktestSchema.safeParse({
        name: "invalid",
        startDate: "2026-08-01",
        endDate: "2026-08-02",
        strategies: ["MARKET_RELATIVE_STRENGTH"],
      }).success,
    ).toBe(false);
  });

  it("defaults phase 0 engine latency when the scanner omits it", () => {
    const batch = engineResultBatchSchema.parse({
      snapshots: [],
      evaluations: [],
      events: [],
      contexts: [],
      benchmarkReadiness: { market: null, sectors: [] },
    });
    expect(batch.timings).toEqual({ featureMs: 0, evaluationMs: 0 });
  });
});
