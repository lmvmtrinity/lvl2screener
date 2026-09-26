import { expect, it } from "vitest";
import type { BacktestTrade } from "@tsx-scanner/contracts";
import { evaluateMatchedStrategyEconomics } from "../src/backtests/strategy-learning-evaluation.js";
import type {
  MatchedStrategyEvaluationInput,
  MatchedStrategyOpportunity,
} from "../src/backtests/strategy-learning-evaluation.js";

const sessions = ["2026-09-01", "2026-09-02"];

function closedTrade(
  id: string,
  sessionDate: string,
  netPnl: number,
): BacktestTrade {
  return {
    id,
    runId: "10000000-0000-4000-8000-000000000001",
    instrumentId: "20000000-0000-4000-8000-000000000001",
    symbol: id.startsWith("A") ? "AAA" : "BBB",
    strategy: "ORB_RETEST",
    strategyVersion: "v1",
    configVersion: "c1",
    signalTimestamp: `${sessionDate}T10:00:00.000Z`,
    score: 80,
    entryTime: `${sessionDate}T10:01:00.000Z`,
    entryPrice: 10,
    stopPrice: 9,
    targetPrice: 12,
    exitTime: `${sessionDate}T10:30:00.000Z`,
    exitPrice: netPnl > 0 ? 11 : 9,
    shares: 10,
    exitReason: netPnl > 0 ? "TARGET" : "STOP",
    grossPnl: netPnl + 1,
    netPnl,
    rMultiple: netPnl / 10,
    holdMinutes: 29,
    reasonCodes: [],
    sector: null,
    atrPct: 1.2,
    rvolAtTime: 1.1,
    contextScore: 50,
    contexts: [],
  } as BacktestTrade;
}

function opportunity(
  id: string,
  sessionDate: string,
  baselineSelected: boolean,
  candidateSelected: boolean,
  netPnl: number,
): MatchedStrategyOpportunity {
  return {
    opportunityId: id,
    sessionDate,
    symbol: id.startsWith("A") ? "AAA" : "BBB",
    regime: "ATR_LOW/RVOL_LOW",
    baselineSelected,
    candidateSelected,
    outcome: { status: "CLOSED", trade: closedTrade(id, sessionDate, netPnl) },
  };
}

function tradeOf(row: MatchedStrategyOpportunity): BacktestTrade {
  if (row.outcome.status !== "CLOSED") throw new Error("Fixture has no trade");
  return row.outcome.trade;
}

function input(
  opportunities: MatchedStrategyOpportunity[],
  expectedSessions = sessions,
): MatchedStrategyEvaluationInput {
  return {
    marketId: "CA_TSX",
    unit: "CAD",
    sourceRunId: "10000000-0000-4000-8000-000000000001",
    coverageStatus: "VERIFIED",
    lineageStatus: "VERIFIED",
    expectedSessions,
    expectedOpportunityIds: opportunities.map((row) => row.opportunityId),
    minimumSessions: 2,
    bootstrapSamples: 1_000,
    blockLength: 1,
    seed: 17,
    extraCostScenarios: [{ extraSlippageBps: 5, extraFeePerTrade: 0.25 }],
    opportunities,
  };
}

it("compares the same opportunity universe and counts a filtered winner without calling it zero", () => {
  const result = evaluateMatchedStrategyEconomics(
    input([
      opportunity("A1", sessions[0]!, true, true, 5),
      opportunity("B1", sessions[0]!, true, false, 4),
      opportunity("A2", sessions[1]!, true, true, -2),
    ]),
  );

  expect(result.status).toBe("AVAILABLE");
  expect(result.denominators).toMatchObject({
    matchedOpportunities: 3,
    closedOutcomes: 3,
    rejectedByCandidate: 1,
    rejectedWinners: 1,
    missedWinnerDenominator: 2,
  });
  expect(result.baseline.netPnl).toBe(7);
  expect(result.candidate.netPnl).toBe(3);
  expect(result.candidate.missedWinnerRate).toBe(0.5);
  expect(result.economicBasis).toBe("INDEPENDENT_SELECTED_OPPORTUNITIES");
});

it("reports no-fill and invalid denominators without assigning invalid outcomes zero", () => {
  const rows: MatchedStrategyOpportunity[] = [
    opportunity("A1", sessions[0]!, true, true, 2),
    {
      opportunityId: "B1",
      sessionDate: sessions[0]!,
      symbol: "BBB",
      regime: "ATR_LOW/RVOL_LOW",
      baselineSelected: true,
      candidateSelected: true,
      outcome: { status: "NO_FILL", reason: "NO_EXECUTABLE_QUOTE" },
    },
    {
      opportunityId: "A2",
      sessionDate: sessions[1]!,
      symbol: "AAA",
      regime: "ATR_LOW/RVOL_LOW",
      baselineSelected: true,
      candidateSelected: true,
      outcome: { status: "INVALID", reason: "MISSING_EXIT_EVIDENCE" },
    },
  ];
  const result = evaluateMatchedStrategyEconomics(input(rows));

  expect(result.status).toBe("UNVERIFIED");
  expect(result.denominators).toMatchObject({
    matchedOpportunities: 3,
    noFillOutcomes: 1,
    invalidOutcomes: 1,
  });
  expect(result.baseline.netPnl).toBeNull();
  expect(result.uncertainty.status).toBe("UNAVAILABLE");
  expect(result.reasonCodes).toContain("INVALID_SELECTED_OUTCOME");
});

it("refuses unmatched identities, unexpected sessions, and unverified evidence", () => {
  const rows = [opportunity("A1", sessions[0]!, true, true, 2)];
  expect(() =>
    evaluateMatchedStrategyEconomics({
      ...input([...rows, { ...rows[0]!, opportunityId: "A1" }]),
      expectedOpportunityIds: ["A1"],
    }),
  ).toThrow("DUPLICATE_OPPORTUNITY");
  expect(() =>
    evaluateMatchedStrategyEconomics(
      input([opportunity("A2", "2026-09-03", true, true, 2)]),
    ),
  ).toThrow("UNEXPECTED_SESSION");
  expect(() =>
    evaluateMatchedStrategyEconomics({
      ...input(rows),
      expectedOpportunityIds: ["A1", "MISSING"],
    }),
  ).toThrow("MISSING_MATCHED_OPPORTUNITY");
  expect(
    evaluateMatchedStrategyEconomics({
      ...input(rows),
      coverageStatus: "MISSING",
    }).status,
  ).toBe("UNVERIFIED");
  expect(() =>
    evaluateMatchedStrategyEconomics({
      ...input(rows),
      marketId: "US_EQUITIES",
      unit: "CAD",
    }),
  ).toThrow("UNIT_SCOPE_MISMATCH");
});

it("rejects candidate-only selections outside the deterministic baseline universe", () => {
  expect(() =>
    evaluateMatchedStrategyEconomics(
      input([opportunity("A1", sessions[0]!, false, true, 5)]),
    ),
  ).toThrow("CANDIDATE_NOT_BASELINE_SELECTED");
});

it("rejects closed outcomes whose symbol or market-local session does not match", () => {
  const row = opportunity("A1", sessions[0]!, true, true, 5);
  expect(() =>
    evaluateMatchedStrategyEconomics(input([{ ...row, symbol: "WRONG" }])),
  ).toThrow("OUTCOME_SYMBOL_MISMATCH");
  expect(() =>
    evaluateMatchedStrategyEconomics(
      input([
        {
          ...row,
          outcome: {
            status: "CLOSED",
            trade: {
              ...tradeOf(row),
              entryTime: "2026-09-02T14:01:00.000Z",
            },
          },
        },
      ]),
    ),
  ).toThrow("OUTCOME_SESSION_MISMATCH");
});

it("rejects the same closed trade identity counted for two opportunities", () => {
  const first = opportunity("A1", sessions[0]!, true, true, 5);
  const second = opportunity("A2", sessions[0]!, true, true, 3);
  expect(() =>
    evaluateMatchedStrategyEconomics(
      input([
        first,
        {
          ...second,
          outcome: { status: "CLOSED", trade: tradeOf(first) },
        },
      ]),
    ),
  ).toThrow("DUPLICATE_TRADE");
});

it("counts only actually observed outcome sessions when coverage is unverified", () => {
  const result = evaluateMatchedStrategyEconomics({
    ...input([opportunity("A1", sessions[0]!, true, true, 5)]),
    coverageStatus: "MISSING",
  });
  expect(result.uncertainty.status).toBe("UNAVAILABLE");
  expect(result.uncertainty.independentSessions).toBe(1);
});

it("does not produce positive qualification or uncertainty from a one-session sample", () => {
  const result = evaluateMatchedStrategyEconomics(
    input([opportunity("A1", "2026-09-01", true, true, 100)], ["2026-09-01"]),
  );
  expect(result.status).toBe("INSUFFICIENT");
  expect(result.uncertainty.status).toBe("INSUFFICIENT");
  expect(result.uncertainty.interval).toBeNull();
  expect(result.qualification).toBe("NOT_ASSESSED");
});

it("includes verified zero-opportunity sessions as paired zero-difference sessions", () => {
  const expectedSessions = Array.from(
    { length: 20 },
    (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`,
  );
  const result = evaluateMatchedStrategyEconomics(
    input(
      [opportunity("A1", expectedSessions[0]!, true, false, 1)],
      expectedSessions,
    ),
  );
  expect(result.status).toBe("AVAILABLE");
  expect(result.uncertainty.independentSessions).toBe(20);
  expect(result.uncertainty.estimate).toBe(-0.05);
  expect(result.uncertainty.interval).toMatchObject({
    lower: -0.15,
    upper: 0,
  });
});

it("counts all verified expected sessions when no opportunities occurred", () => {
  const expectedSessions = Array.from(
    { length: 20 },
    (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`,
  );
  const result = evaluateMatchedStrategyEconomics({
    ...input([], expectedSessions),
    expectedOpportunityIds: [],
  });
  expect(result.denominators.matchedOpportunities).toBe(0);
  expect(result.uncertainty.status).toBe("AVAILABLE");
  expect(result.uncertainty.independentSessions).toBe(20);
  expect(result.uncertainty.estimate).toBe(0);
  expect(result.uncertainty.interval).toEqual({ lower: 0, upper: 0 });
});

it("applies caller-declared cost stress and reports concentration without pooling selections", () => {
  const result = evaluateMatchedStrategyEconomics(
    input([
      opportunity("A1", sessions[0]!, true, true, 5),
      opportunity("A2", sessions[1]!, true, true, 3),
    ]),
  );
  expect(result.candidate.netPnl).toBe(8);
  expect(result.candidate.costSensitivity[0]).toMatchObject({
    extraSlippageBps: 5,
    extraFeePerTrade: 0.25,
    netPnl: 7.29,
  });
  expect(result.candidate.concentration).toMatchObject({
    largestSymbolShare: 1,
    largestSessionShare: 0.5,
    largestRegimeShare: 1,
  });
});
