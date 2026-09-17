import { describe, expect, it } from "vitest";
import type {
  PaperCohortAggregate,
  PaperEvidenceFilters,
  PaperJournalProjection,
  PaperPerformanceCurve,
  PaperTradeJournal,
} from "@tsx-scanner/contracts";
import { PaperReportingService } from "../src/paper-bot/paper-reporting-service.js";

const aggregate: PaperCohortAggregate = {
  cohort: {
    profileId: "10000000-0000-4000-8000-000000000301",
    profileName: "ORB",
    profileConfigId: "10000000-0000-4000-8000-000000000302",
    configVersion: "profile-v1",
    strategyKey: "ORB_RETEST",
    strategyVersion: "1.0.0",
    source: "LIVE",
    executionModelVersion: "paper-execution-v1",
    assumptions: { positionSize: 1000 },
  },
  model: "QUOTE",
  signalCount: 4,
  eligibleSignalCount: 3,
  fills: 2,
  noFills: 1,
  rejectedEconomics: 1,
  closedTrades: 2,
  openExecutions: 0,
  closePendingExecutions: 0,
  unresolvedExecutions: 0,
  fillRate: { numerator: 2, denominator: 3, value: 2 / 3 },
  winRate: { numerator: 1, denominator: 2, value: 0.5 },
  averageR: 0.25,
  expectancyR: 0.25,
  cumulativeR: 0.5,
  exitReasons: { TARGET: 1, STOP: 1 },
  noFillReasons: { STALE: 1 },
  economicsReasons: { NET_REWARD_RISK_TOO_LOW: 1 },
  sizeCoverage: [],
  exitSizeCoverage: [],
  entrySpread: { sampleCount: 0, minimum: null, maximum: null, average: null },
  delayedClose: { count: 0, totalDurationMs: 0, averageDurationMs: null },
};

const emptyJournal = (
  projection: PaperJournalProjection,
): PaperTradeJournal => ({
  projection,
  entries: [],
  totals: {
    closedTrades: 0,
    openPositions: 0,
    wins: 0,
    losses: 0,
    scratches: 0,
    winRate: { numerator: 0, denominator: 0, value: null },
    grossPnl: 0,
    costs: 0,
    netPnl: 0,
    profitFactor: null,
    cumulativeR: 0,
    averageR: null,
    largestWin: null,
    largestLoss: null,
  },
});

const emptyCurve = (): PaperPerformanceCurve => ({
  account: "COORDINATED",
  marketId: "CA_TSX",
  currency: "CAD",
  granularity: "DAY",
  startDate: "2026-09-01",
  endDate: "2026-09-05",
  points: [],
  warnings: [],
});

describe("Phase 5 paper reporting service", () => {
  it("de-duplicates, sorts, and validates commission scenarios", async () => {
    const calls: unknown[] = [];
    const service = new PaperReportingService({
      listActivities: async () => [],
      listRuns: async () => [],
      listObservations: async () => [],
      listExecutions: async () => [],
      aggregates: async () => [aggregate],
      commissionSensitivity: async (filters, commissions) => {
        calls.push(commissions);
        void filters;
        return [];
      },
      coordinationDecisions: async () => [],
      coordinationSummary: async () => ({
        policyVersions: ["paper-coordination-v2"],
        decisions: 3,
        approved: 1,
        deferred: 1,
        rejected: 1,
        reasons: {
          SELECTED_PRIMARY: 1,
          POST_STOP_COOLDOWN: 1,
          CONTEXT_VETO: 1,
        },
        openPositions: 0,
        closedTrades: 1,
        wins: 1,
        winRate: { numerator: 1, denominator: 1, value: 1 },
        netPnl: 42,
        cumulativeR: 0.8,
        averageR: 0.8,
        exitReasons: { TARGET: 1 },
        symbolsTraded: 1,
        repeatedSymbolEntries: 0,
      }),
      curves: async () => [],
      divergences: async () => [],
      qualifications: async () => [],
      journal: async (_filters, projection) => emptyJournal(projection),
      performanceCurve: async () => emptyCurve(),
      historicalFor: async () => ({ reason: "No exact provenance" }),
    });
    await service.commissionSensitivity({}, [9.95, 0, 1, 0]);
    await service.commissionSensitivity({});
    expect(calls).toEqual([
      [0, 1, 9.95],
      [0, 1, 9.95],
    ]);
    await expect(service.commissionSensitivity({}, [])).rejects.toMatchObject({
      code: "INVALID_COMPARISON",
    });
    await expect(service.commissionSensitivity({}, [-1])).rejects.toMatchObject(
      { code: "INVALID_COMPARISON" },
    );
  });

  // ADR-009 makes the candle model supplementary: an unfiltered independent
  // journal must not add a symbol's quote and candle executions together.
  it("defaults the independent journal to the canonical quote model", async () => {
    const seen: Array<PaperEvidenceFilters & { projection?: string }> = [];
    const service = new PaperReportingService({
      listActivities: async () => [],
      listRuns: async () => [],
      listObservations: async () => [],
      listExecutions: async () => [],
      aggregates: async () => [aggregate],
      commissionSensitivity: async () => [],
      coordinationDecisions: async () => [],
      coordinationSummary: async () => {
        throw new Error("not used");
      },
      curves: async () => [],
      divergences: async () => [],
      qualifications: async () => [],
      journal: async (filters, projection) => {
        seen.push({ ...filters, projection });
        return emptyJournal(projection);
      },
      performanceCurve: async () => emptyCurve(),
      historicalFor: async () => ({ reason: "No exact provenance" }),
    });

    await service.journal({ source: "LIVE" }, "INDEPENDENT");
    await service.journal({ source: "LIVE", model: "CANDLE" }, "INDEPENDENT");
    // The coordinated ledger has no per-model executions to pick between, so
    // it must be passed through untouched.
    await service.journal({ source: "LIVE" }, "COORDINATED");

    expect(seen).toEqual([
      { source: "LIVE", model: "QUOTE", projection: "INDEPENDENT" },
      { source: "LIVE", model: "CANDLE", projection: "INDEPENDENT" },
      { source: "LIVE", projection: "COORDINATED" },
    ]);
  });

  it("compares LIVE quote evidence only through an exact provenance result", async () => {
    const calls: unknown[] = [];
    const service = new PaperReportingService({
      listActivities: async () => [],
      listRuns: async () => [],
      listObservations: async () => [],
      listExecutions: async () => [],
      aggregates: async (filters) => {
        calls.push(filters);
        return [aggregate];
      },
      commissionSensitivity: async () => [],
      coordinationDecisions: async () => [],
      coordinationSummary: async () => ({
        policyVersions: ["paper-coordination-v2"],
        decisions: 3,
        approved: 1,
        deferred: 1,
        rejected: 1,
        reasons: {
          SELECTED_PRIMARY: 1,
          POST_STOP_COOLDOWN: 1,
          CONTEXT_VETO: 1,
        },
        openPositions: 0,
        closedTrades: 1,
        wins: 1,
        winRate: { numerator: 1, denominator: 1, value: 1 },
        netPnl: 42,
        cumulativeR: 0.8,
        averageR: 0.8,
        exitReasons: { TARGET: 1 },
        symbolsTraded: 1,
        repeatedSymbolEntries: 0,
      }),
      curves: async () => [],
      divergences: async () => [],
      qualifications: async () => [],
      journal: async (_filters, projection) => emptyJournal(projection),
      performanceCurve: async () => emptyCurve(),
      historicalFor: async () => ({
        backtestRunId: "10000000-0000-4000-8000-000000000303",
        closedTrades: 4,
        wins: 3,
        averageR: 0.4,
        cumulativeR: 1.6,
        exitReasons: { TARGET: 3, STOP: 1 },
      }),
    });
    const result = await service.comparisons({
      profileConfigId: aggregate.cohort.profileConfigId,
    });
    expect(calls).toEqual([
      {
        profileConfigId: aggregate.cohort.profileConfigId,
        source: "LIVE",
        model: "QUOTE",
      },
    ]);
    expect(result[0]).toMatchObject({
      comparable: true,
      historical: { backtestRunId: "10000000-0000-4000-8000-000000000303" },
    });
  });

  it("refuses arbitrary historical and supplementary-model comparisons", async () => {
    const service = new PaperReportingService({
      listActivities: async () => [],
      listRuns: async () => [],
      listObservations: async () => [],
      listExecutions: async () => [],
      aggregates: async () => [aggregate],
      commissionSensitivity: async () => [],
      coordinationDecisions: async () => [],
      coordinationSummary: async () => ({
        policyVersions: ["paper-coordination-v2"],
        decisions: 3,
        approved: 1,
        deferred: 1,
        rejected: 1,
        reasons: {
          SELECTED_PRIMARY: 1,
          POST_STOP_COOLDOWN: 1,
          CONTEXT_VETO: 1,
        },
        openPositions: 0,
        closedTrades: 1,
        wins: 1,
        winRate: { numerator: 1, denominator: 1, value: 1 },
        netPnl: 42,
        cumulativeR: 0.8,
        averageR: 0.8,
        exitReasons: { TARGET: 1 },
        symbolsTraded: 1,
        repeatedSymbolEntries: 0,
      }),
      curves: async () => [],
      divergences: async () => [],
      qualifications: async () => [],
      journal: async (_filters, projection) => emptyJournal(projection),
      performanceCurve: async () => emptyCurve(),
      historicalFor: async () => ({ reason: "No exact provenance" }),
    });
    await expect(
      service.comparisons({ source: "BACKTEST" }),
    ).rejects.toMatchObject({
      code: "INVALID_COMPARISON",
    });
    await expect(
      service.comparisons({ model: "CANDLE" }),
    ).rejects.toMatchObject({
      code: "INVALID_COMPARISON",
    });
    await expect(service.comparisons({})).resolves.toMatchObject([
      { comparable: false, historical: null, reason: "No exact provenance" },
    ]);
  });
});
