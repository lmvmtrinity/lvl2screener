import { describe, expect, it } from "vitest";
import {
  FundedComparisonReadService,
  type FundedComparisonReadRepository,
  type FundedComparisonReadSpecification,
} from "../src/paper-bot/funded-comparison-read-service.js";
import {
  fundedComparisonResultSchema,
  type FundedComparisonAvailabilityReceipt,
  type FundedComparisonBaselineIdentity,
  type FundedComparisonResult,
} from "@tsx-scanner/contracts";

const digest = (letter: string) => letter.repeat(64);
const baseline: FundedComparisonBaselineIdentity = {
  backtestRunId: "11111111-1111-4111-8111-111111111111",
  configVersion: "config-v1",
  strategyKeys: ["ORB_RETEST"],
  startDate: "2026-08-01",
  endDate: "2026-08-02",
  executionModelVersion: "execution-v1",
  replayInputDigest: digest("1"),
  baselineResultDigest: digest("2"),
  completedAt: "2026-08-03T20:00:00.000Z",
};

function specificationFor(
  marketId: "CA_TSX" | "US_EQUITIES",
  comparisonSpecDigest: string,
  orderedSessionDates = ["2026-08-01", "2026-08-02"],
): FundedComparisonReadSpecification {
  return {
    marketId,
    currency: marketId === "CA_TSX" ? "CAD" : "USD",
    comparisonSpecDigest,
    baseline,
    sessionMembership: { orderedSessionDates },
    evidenceCutoffAt: "2026-09-01T19:00:00.000Z",
    specificationFrozenAt: "2026-09-01T20:00:00.000Z",
  };
}

function resultFor(
  sessionDates: readonly string[] = ["2026-08-01", "2026-08-02"],
  comparisonSpecDigest = digest("d"),
  resultDigest = digest("e"),
): FundedComparisonResult {
  const sideMetrics = (netReturn: number) => ({
    return: {
      totalNetReturn: netReturn * sessionDates.length,
      returnPctOfInitialCash: netReturn / 10_000,
      sessions: sessionDates.map((sessionDate) => ({ sessionDate, netReturn })),
    },
    drawdown: { maxDrawdown: 1, maxDrawdownPctOfInitialCash: 0.0001 },
    dailyLoss: { limitHits: 0, mostNegativeDailyPnl: 0, sessionsBlocked: 0 },
    risk: { maxOpenRisk: 0, maxGrossNotional: 0, maxOpenPositions: 0 },
    activity: {
      turnover: 0,
      requested: 0,
      partialFills: 0,
      fullFills: 0,
      zeroFills: 0,
    },
    execution: {
      fillFraction: 0,
      averageSlippagePerShare: 0,
      totalModeledCosts: 0,
    },
    veto: { classification: "AVAILABLE" as const, counts: [] },
    declines: [],
    opportunityCost: {
      declinedOrVetoedCount: 0,
      forgoneRequestedNotional: 0,
      forgoneRequestedRisk: 0,
      requestedCapitalAvailableCount: 0,
      requestedCapitalUnavailableCount: 0,
      realizedValue: null,
      provableCount: 0,
      unprovableCount: 0,
    },
    stability: {
      sessionCount: sessionDates.length,
      zeroTradeSessions: sessionDates.length,
      longestReturnSignRun: 0,
    },
    integrity: {
      unresolvedExposure: 0,
      fallbackDecisionCount: 0,
      predictionAvailableCount: 0,
      predictionRequiredCount: 0,
      findings: [],
    },
  });

  return fundedComparisonResultSchema.parse({
    resultVersion: "funded-comparison-result-v1",
    comparisonSpecDigest,
    marketId: "CA_TSX",
    currency: "CAD",
    sessionCount: sessionDates.length,
    historicalVolumeStatus: "INSUFFICIENT_SESSIONS",
    pairedSessions: sessionDates.map((sessionDate) => ({
      sessionDate,
      baselineNetReturn: 10,
      challengerNetReturn: 10,
      baselineMaxDrawdown: 1,
      challengerMaxDrawdown: 1,
      valuation: "UNION_GRID_MTM" as const,
      coverage: "VERIFIED" as const,
    })),
    champion: sideMetrics(10),
    challenger: sideMetrics(10),
    deltas: {
      totalNetReturn: 0,
      returnPctOfInitialCash: 0,
      maxDrawdown: 0,
      maxDrawdownPctOfInitialCash: 0,
      limitHits: 0,
      mostNegativeDailyPnl: 0,
      sessionsBlocked: 0,
      maxOpenRisk: 0,
      maxGrossNotional: 0,
      maxOpenPositions: 0,
      turnover: 0,
      requested: 0,
      partialFills: 0,
      fullFills: 0,
      zeroFills: 0,
      fillFraction: 0,
      averageSlippagePerShare: 0,
      totalModeledCosts: 0,
      vetoCount: 0,
      declineCount: 0,
      declinedOrVetoedCount: 0,
      forgoneRequestedNotional: 0,
      forgoneRequestedRisk: 0,
      zeroTradeSessions: 0,
      longestReturnSignRun: 0,
      sessionCount: 0,
      challengerOutperformedSessions: 0,
      unavailable: [],
    },
    challengerOutperformedSessions: { count: 0, proportion: 0 },
    championEvaluationDigest: digest("1"),
    challengerEvaluationDigest: digest("2"),
    championMetricsDigest: digest("3"),
    challengerMetricsDigest: digest("4"),
    resultDigest,
  });
}

function repository(
  overrides: Partial<FundedComparisonReadRepository> = {},
): FundedComparisonReadRepository {
  return {
    listSpecifications: async () => [],
    loadAvailability: async () => undefined,
    loadSpecification: async () => undefined,
    loadResult: async () => undefined,
    ...overrides,
  };
}

describe("funded comparison read service", () => {
  it("keeps list market-scoped and rejects the ALL aggregation", async () => {
    const calls: string[] = [];
    const read = new FundedComparisonReadService(
      repository({
        listSpecifications: async (marketId, limit) => {
          calls.push(`${marketId}:${limit}`);
          return [
            {
              specificationId: "ca-spec",
              marketId,
              currency: "CAD",
              comparisonSpecDigest: digest("a"),
              status: "PENDING",
              sessionCount: 2,
              historicalVolumeStatus: null,
              resultDigest: null,
              resultAvailable: false,
              failures: [],
              createdAt: "2026-09-01T20:00:00.000Z",
            },
          ];
        },
        loadSpecification: async () => ({
          specification: specificationFor("CA_TSX", digest("a")),
        }),
      }),
    );

    await expect(read.list("ALL", 10)).rejects.toThrow("ALL");
    await expect(read.list("CA_TSX", 10)).resolves.toMatchObject([
      expect.objectContaining({
        baseline,
        evidenceCutoffAt: "2026-09-01T19:00:00.000Z",
        specificationFrozenAt: "2026-09-01T20:00:00.000Z",
      }),
    ]);
    expect(calls).toEqual(["CA_TSX:10"]);
  });

  it("loads separate CA and US specifications without mixing their projections", async () => {
    const requested: string[] = [];
    const read = new FundedComparisonReadService(
      repository({
        listSpecifications: async (marketId) => {
          requested.push(marketId);
          return [
            {
              specificationId: `${marketId}-spec`,
              marketId,
              currency: marketId === "CA_TSX" ? "CAD" : "USD",
              comparisonSpecDigest: digest(marketId === "CA_TSX" ? "a" : "b"),
              status: "PENDING",
              sessionCount: 2,
              historicalVolumeStatus: null,
              resultDigest: null,
              resultAvailable: false,
              failures: [],
              createdAt: "2026-09-01T20:00:00.000Z",
            },
          ];
        },
        loadSpecification: async (specId) => ({
          specification: specificationFor(
            specId.startsWith("CA_") ? "CA_TSX" : "US_EQUITIES",
            digest(specId.startsWith("CA_") ? "a" : "b"),
          ),
        }),
      }),
    );

    const ca = await read.list("CA_TSX", 10);
    const us = await read.list("US_EQUITIES", 10);

    expect(ca[0]?.marketId).toBe("CA_TSX");
    expect(ca[0]?.currency).toBe("CAD");
    expect(us[0]?.marketId).toBe("US_EQUITIES");
    expect(us[0]?.currency).toBe("USD");
    expect(requested).toEqual(["CA_TSX", "US_EQUITIES"]);
  });

  it("fails visibly when a listed specification is missing or has mismatched ownership", async () => {
    const receipt: FundedComparisonAvailabilityReceipt = {
      specificationId: "ca-spec",
      marketId: "CA_TSX",
      currency: "CAD",
      comparisonSpecDigest: digest("a"),
      status: "PENDING",
      sessionCount: 2,
      historicalVolumeStatus: null,
      resultDigest: null,
      resultAvailable: false,
      failures: [],
      createdAt: "2026-09-01T20:00:00.000Z",
    };
    const missing = new FundedComparisonReadService(
      repository({ listSpecifications: async () => [receipt] }),
    );
    await expect(missing.list("CA_TSX", 10)).rejects.toThrow(
      "RETAINED_INPUT_MISSING",
    );

    const mismatched = new FundedComparisonReadService(
      repository({
        listSpecifications: async () => [receipt],
        loadSpecification: async () => ({
          specification: specificationFor("US_EQUITIES", digest("a")),
        }),
      }),
    );
    await expect(mismatched.list("CA_TSX", 10)).rejects.toThrow(
      "MARKET_CURRENCY_MISMATCH",
    );
  });

  it("returns unavailable with exact failure reasons and no partial metrics", async () => {
    const availability: FundedComparisonAvailabilityReceipt = {
      specificationId: "spec-1",
      marketId: "US_EQUITIES",
      currency: "USD",
      comparisonSpecDigest: digest("a"),
      status: "UNAVAILABLE",
      sessionCount: 3,
      historicalVolumeStatus: null,
      resultDigest: null,
      resultAvailable: false,
      failures: [
        {
          reason: "QUOTE_COVERAGE_MISSING",
          classification: "TERMINAL",
          side: "CHAMPION",
          sessionDate: "2026-08-01",
          detail: "No retained quotes",
          recordedAt: "2026-09-01T20:00:00.000Z",
        },
      ],
      createdAt: "2026-09-01T20:00:00.000Z",
    };
    const read = new FundedComparisonReadService(
      repository({ loadAvailability: async () => availability }),
    );

    const output = await read.get("spec-1");

    expect(output).toEqual({
      ...availability,
      result: null,
    });
    expect(output?.failures[0]?.reason).toBe("QUOTE_COVERAGE_MISSING");
  });

  it("reports a missing paired session as INCOMPLETE_SESSION and withholds metrics", async () => {
    const availability: FundedComparisonAvailabilityReceipt = {
      specificationId: "spec-2",
      marketId: "CA_TSX",
      currency: "CAD",
      comparisonSpecDigest: digest("b"),
      status: "READY",
      sessionCount: 2,
      historicalVolumeStatus: "INSUFFICIENT_SESSIONS",
      resultDigest: digest("c"),
      resultAvailable: true,
      failures: [],
      createdAt: "2026-09-01T20:00:00.000Z",
    };
    const read = new FundedComparisonReadService(
      repository({
        loadAvailability: async () => availability,
        loadSpecification: async () => ({
          specification: specificationFor("CA_TSX", digest("b")),
        }),
        loadResult: async () =>
          resultFor(["2026-08-01"], digest("b"), digest("c")),
      }),
    );

    const output = await read.get("spec-2");

    expect(output?.status).toBe("UNAVAILABLE");
    expect(output?.result).toBeNull();
    expect(output?.failures).toEqual([
      expect.objectContaining({
        reason: "INCOMPLETE_SESSION",
        classification: "TERMINAL",
        sessionDate: null,
      }),
    ]);
  });

  it("keeps a fully proven sub-20 result visible as insufficient", async () => {
    const availability: FundedComparisonAvailabilityReceipt = {
      specificationId: "spec-3",
      marketId: "CA_TSX",
      currency: "CAD",
      comparisonSpecDigest: digest("d"),
      status: "READY",
      sessionCount: 2,
      historicalVolumeStatus: "INSUFFICIENT_SESSIONS",
      resultDigest: digest("e"),
      resultAvailable: true,
      failures: [],
      createdAt: "2026-09-01T20:00:00.000Z",
    };
    const result = resultFor(undefined, digest("d"), digest("e"));
    const read = new FundedComparisonReadService(
      repository({
        loadAvailability: async () => availability,
        loadSpecification: async () => ({
          specification: specificationFor("CA_TSX", digest("d")),
        }),
        loadResult: async () => result,
      }),
    );

    const output = await read.get("spec-3");

    expect(output?.status).toBe("READY");
    expect(output?.historicalVolumeStatus).toBe("INSUFFICIENT_SESSIONS");
    expect(output?.result).toBe(result);
  });

  it.each([
    ["one-session result", ["2026-08-01"]],
    ["three-session result", ["2026-08-01", "2026-08-02", "2026-08-03"]],
    ["different ordered dates", ["2026-08-03", "2026-08-04"]],
  ])(
    "rejects %s when valid result membership differs from the specification",
    async (_label, resultSessionDates) => {
      const availability: FundedComparisonAvailabilityReceipt = {
        specificationId: "spec-vector",
        marketId: "CA_TSX",
        currency: "CAD",
        comparisonSpecDigest: digest("a"),
        status: "READY",
        sessionCount: 2,
        historicalVolumeStatus: "INSUFFICIENT_SESSIONS",
        resultDigest: digest("b"),
        resultAvailable: true,
        failures: [],
        createdAt: "2026-09-01T20:00:00.000Z",
      };
      const result = resultFor(resultSessionDates, digest("a"), digest("b"));
      const read = new FundedComparisonReadService(
        repository({
          loadAvailability: async () => availability,
          loadSpecification: async () => ({
            specification: specificationFor("CA_TSX", digest("a")),
          }),
          loadResult: async () => result,
        }),
      );

      const output = await read.get("spec-vector");

      expect(output?.status).toBe("UNAVAILABLE");
      expect(output?.result).toBeNull();
      expect(output?.failures.at(-1)?.reason).toBe("INCOMPLETE_SESSION");
    },
  );
});
