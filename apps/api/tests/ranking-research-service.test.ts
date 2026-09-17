import {
  createRankingResearchSchema,
  type BacktestRun,
  type BacktestTrade,
} from "@tsx-scanner/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateRankingResearch,
  RankingResearchService,
} from "../src/ranking-research/ranking-research-service.js";

const runId = "10000000-0000-4000-8000-000000000106";
const strategies = ["ORB_RETEST", "VWAP_HOLD"] as const;

function trade(
  day: number,
  strategy: (typeof strategies)[number],
  kind: "GOOD" | "BAD",
  withContext = true,
): BacktestTrade {
  const timestamp = `2026-08-${String(day).padStart(2, "0")}T14:00:00.000Z`;
  const good = kind === "GOOD";
  const suffix = `${String(day).padStart(2, "0")}${strategy === "ORB_RETEST" ? "1" : "2"}${good ? "1" : "0"}00000000`;
  return {
    id: `30000000-0000-4000-8000-${suffix}`,
    runId,
    instrumentId: "20000000-0000-4000-8000-000000000001",
    symbol: `${strategy}-${kind}`,
    strategy,
    strategyVersion: "1.0.0",
    configVersion: "test",
    signalTimestamp: timestamp,
    score: good ? 89 : 90,
    entryTime: timestamp,
    entryPrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    exitTime: timestamp,
    exitPrice: good ? 12 : 9,
    shares: 100,
    exitReason: good ? "TARGET" : "STOP",
    grossPnl: good ? 200 : -100,
    netPnl: good ? 200 : -100,
    rMultiple: good ? 1 : -1,
    holdMinutes: 5,
    reasonCodes: ["ABOVE_VWAP"],
    sector: "TEST",
    atrPct: 2.5,
    rvolAtTime: 2,
    contextScore: good ? 100 : 0,
    contexts: withContext
      ? [
          {
            status: "STRONG",
            contextScore: good ? 100 : 0,
            contextScoreComponents: [
              {
                key: "SESSION_RELATIVE_STRENGTH",
                horizon: "SESSION_FROM_OPEN",
                candidateValue: null,
                benchmarkValue: null,
                observedDifference: null,
                score: good ? 100 : 0,
                available: true,
                missingDataFlags: [],
              },
            ],
          },
        ]
      : [],
  } as unknown as BacktestTrade;
}

function backtest(withContext = true): BacktestRun {
  const trades = [1, 2, 3, 4, 5, 6].flatMap((day) =>
    strategies.flatMap((strategy) => [
      trade(day, strategy, "BAD", withContext),
      trade(day, strategy, "GOOD", withContext),
    ]),
  );
  return {
    id: runId,
    marketId: "CA_TSX",
    status: "COMPLETED",
    trades,
  } as unknown as BacktestRun;
}

describe("Phase 6 ranking research", () => {
  it("uses a chronological holdout and reports every activation gate", () => {
    const input = createRankingResearchSchema.parse({
      name: "Context holdout",
      backtestRunId: runId,
      formulaVersions: ["ranking-bounded-context-research-v1"],
      trainPct: 50,
      topPerSession: 2,
      minimumSamplesPerSlice: 1,
      slippageStressBps: 0,
      feeStressPerTrade: 0,
    });
    const output = evaluateRankingResearch(backtest(), input);
    const result = output.results[0]!;
    expect(output.splitAt).toBe("2026-08-04T14:00:00.000Z");
    expect(result.holdout.baseline.averageR).toBe(-1);
    expect(result.holdout.candidate.averageR).toBe(1);
    expect(result.gate).toMatchObject({
      adequateSamples: true,
      contextEvidenceAvailable: true,
      expectancyStableOrImproved: true,
      falseBreakoutStableOrReduced: true,
      drawdownAcceptable: true,
      strategyGeneralizes: true,
      sensitivityStable: true,
      costsAcceptable: true,
      eligibleForActivation: true,
    });
    expect(result.correlatedInputFlags).toContain(
      "SESSION_AND_ROLLING_RETURN_CORRELATION_REQUIRES_REVIEW",
    );
  });

  it("keeps legacy trades neutral and rejects activation without captured context", () => {
    const input = createRankingResearchSchema.parse({
      name: "Legacy",
      backtestRunId: runId,
      formulaVersions: ["ranking-bounded-context-research-v1"],
      trainPct: 50,
      topPerSession: 2,
      minimumSamplesPerSlice: 1,
      slippageStressBps: 0,
      feeStressPerTrade: 0,
    });
    const output = evaluateRankingResearch(backtest(false), input);
    expect(output.warnings).toContain(
      "Some source trades predate captured context evidence and remain neutral.",
    );
    expect(output.results[0]!.gate.contextEvidenceAvailable).toBe(false);
    expect(output.results[0]!.gate.eligibleForActivation).toBe(false);
  });

  it("requires explicit weights for every setup in interaction research", () => {
    const input = createRankingResearchSchema.parse({
      name: "Interactions",
      backtestRunId: runId,
      formulaVersions: ["ranking-setup-interaction-research-v1"],
      strategyWeights: { ORB_RETEST: 0.1 },
      trainPct: 50,
      topPerSession: 2,
      minimumSamplesPerSlice: 1,
      slippageStressBps: 0,
      feeStressPerTrade: 0,
    });
    const result = evaluateRankingResearch(backtest(), input).results[0]!;
    expect(result.gate.strategyGeneralizes).toBe(false);
    expect(result.gate.eligibleForActivation).toBe(false);
  });

  it("refuses research sourced from retired execution evidence", async () => {
    const input = createRankingResearchSchema.parse({
      name: "Legacy source",
      backtestRunId: runId,
      formulaVersions: ["ranking-bounded-context-research-v1"],
    });
    const service = new RankingResearchService({} as never, {
      get: async () => ({
        ...backtest(),
        executionModelVersion: "legacy-python-v1",
      }),
    });
    await expect(service.create(input)).rejects.toMatchObject({
      code: "BACKTEST_EXECUTION_MODEL",
    });
  });
});
