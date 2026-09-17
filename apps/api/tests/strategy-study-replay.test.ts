import { expect, it } from "vitest";
import type { BacktestReplayResult } from "@tsx-scanner/contracts";
import {
  deriveStudySessionPairs,
  assertFrozenSessionPayload,
} from "../src/backtests/strategy-study-replay.js";
import { contentHash } from "../src/backtests/research-coverage.js";

const output = {
  metrics: {} as BacktestReplayResult["metrics"],
  analyses: [],
  trades: [
    {
      id: "10000000-0000-4000-8000-000000000201",
      runId: "10000000-0000-4000-8000-000000000202",
      instrumentId: "10000000-0000-4000-8000-000000000203",
      symbol: "ABC.TO",
      strategy: "ORB_RETEST",
      strategyVersion: "1.0.0",
      configVersion: "config",
      signalTimestamp: "2026-09-01T14:00:00.000Z",
      score: 80,
      entryTime: "2026-09-01T14:00:00.000Z",
      entryPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      exitTime: "2026-09-01T14:30:00.000Z",
      exitPrice: 11,
      shares: 10,
      exitReason: "TARGET",
      grossPnl: 10,
      netPnl: 9,
      rMultiple: 0.5,
      holdMinutes: 30,
      reasonCodes: [],
      sector: null,
      atrPct: null,
      rvolAtTime: null,
      contextScore: 50,
      contexts: [],
    },
  ],
  timeline: [],
  dataQuality: {
    quoteSnapshots: 1,
    candles: 1,
    sessions: 2,
    spread: "CAPTURED" as const,
    warnings: [],
  },
} as BacktestReplayResult;

it("keeps zero-outcome sessions in the paired result", () => {
  const pairs = deriveStudySessionPairs(output, output, "CA_TSX", [
    "2026-09-01",
    "2026-09-02",
  ]);
  expect(pairs).toEqual([
    {
      sessionDate: "2026-09-01",
      baseline: 0.5,
      challenger: 0.5,
      coverage: "VERIFIED",
    },
    {
      sessionDate: "2026-09-02",
      baseline: 0,
      challenger: 0,
      coverage: "VERIFIED",
    },
  ]);
});

it("refuses a changed retained session before engine access", () => {
  const payload = { quotes: [] };
  expect(() =>
    assertFrozenSessionPayload(
      payload,
      {
        "2026-09-01": contentHash({
          date: "2026-09-01",
          payload: { quotes: ["changed"] },
        }),
      },
      "2026-09-01",
    ),
  ).toThrow("STUDY_INPUT_CHANGED");
});

it("keeps native currency values separate from R multiples", () => {
  expect(
    deriveStudySessionPairs(output, output, "CA_TSX", ["2026-09-01"], "R")[0]
      ?.challenger,
  ).toBe(0.5);
  expect(
    deriveStudySessionPairs(output, output, "CA_TSX", ["2026-09-01"], "CAD")[0]
      ?.challenger,
  ).toBe(9);
  expect(() =>
    deriveStudySessionPairs(output, output, "CA_TSX", ["2026-09-01"], "USD"),
  ).toThrow("STUDY_UNIT_MARKET_MISMATCH");
});
