import { describe, expect, it, vi } from "vitest";
import type { FundedReportingApi, PaperReportingApi } from "../src/app.js";
import { buildApp } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import type {
  PaperBotActivity,
  PaperCohortAggregate,
  PaperJournalProjection,
  PaperTradeJournal,
} from "@tsx-scanner/contracts";

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
const aggregate: PaperCohortAggregate = {
  cohort: {
    profileId: "10000000-0000-4000-8000-000000000311",
    profileName: "ORB",
    profileConfigId: "10000000-0000-4000-8000-000000000312",
    configVersion: "profile-v1",
    strategyKey: "ORB_RETEST",
    strategyVersion: "1.0.0",
    source: "LIVE",
    executionModelVersion: "paper-execution-v1",
    assumptions: {},
  },
  model: "QUOTE",
  signalCount: 0,
  eligibleSignalCount: 0,
  fills: 0,
  noFills: 0,
  rejectedEconomics: 0,
  closedTrades: 0,
  openExecutions: 0,
  closePendingExecutions: 0,
  unresolvedExecutions: 0,
  fillRate: { numerator: 0, denominator: 0, value: null },
  winRate: { numerator: 0, denominator: 0, value: null },
  averageR: null,
  expectancyR: null,
  cumulativeR: 0,
  exitReasons: {},
  noFillReasons: {},
  economicsReasons: {},
  sizeCoverage: [],
  exitSizeCoverage: [],
  entrySpread: { sampleCount: 0, minimum: null, maximum: null, average: null },
  delayedClose: { count: 0, totalDurationMs: 0, averageDurationMs: null },
};

const fundedJournal: PaperTradeJournal = {
  projection: "FUNDED",
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
  unresolvedPositions: [],
};

class Reporting implements PaperReportingApi {
  filters?: unknown;
  async listActivities(
    filters: Parameters<PaperReportingApi["listActivities"]>[0],
  ): Promise<PaperBotActivity[]> {
    this.filters = filters;
    return [
      {
        id: "10000000-0000-4000-8000-000000000319",
        runId: "10000000-0000-4000-8000-000000000318",
        occurredAt: "2026-08-31T13:30:00.000Z",
        eventType: "RUN_STARTED",
        severity: "INFO",
        symbol: null,
        strategyKey: null,
        model: null,
        message: "Paper bot started the live run for 2026-08-31.",
        details: { source: "LIVE" },
      },
    ];
  }
  async listRuns() {
    return [];
  }
  async listObservations() {
    return [];
  }
  async listExecutions() {
    return [];
  }
  async aggregates(filters: Parameters<PaperReportingApi["aggregates"]>[0]) {
    this.filters = filters;
    return [aggregate];
  }
  commissions?: readonly number[];
  async commissionSensitivity(
    filters: Parameters<PaperReportingApi["commissionSensitivity"]>[0],
    roundTripCommissions?: readonly number[],
  ) {
    this.filters = filters;
    this.commissions = roundTripCommissions;
    return [
      {
        cohort: aggregate.cohort,
        model: "QUOTE" as const,
        scenarios: [
          {
            roundTripCommission: 0,
            closedTrades: 2,
            wins: 1,
            winRate: { numerator: 1, denominator: 2, value: 0.5 },
            netPnl: 10,
            averageR: 0.1,
            expectancyR: 0.1,
            cumulativeR: 0.2,
            profitFactor: 2,
          },
        ],
      },
    ];
  }
  async coordinationDecisions() {
    return [];
  }
  async coordinationSummary() {
    return {
      policyVersions: ["paper-coordination-v2"],
      decisions: 3,
      approved: 1,
      deferred: 1,
      rejected: 1,
      reasons: { SELECTED_PRIMARY: 1, POST_STOP_COOLDOWN: 1, CONTEXT_VETO: 1 },
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
    };
  }
  async curves() {
    return [];
  }
  performanceRange?: { startDate: string; endDate: string };
  async performanceCurve(
    _filters: Parameters<PaperReportingApi["performanceCurve"]>[0],
    range: Parameters<PaperReportingApi["performanceCurve"]>[1],
    granularity: Parameters<PaperReportingApi["performanceCurve"]>[2],
  ) {
    this.performanceRange = range;
    return {
      account: "COORDINATED" as const,
      marketId: "CA_TSX" as const,
      currency: "CAD" as const,
      granularity,
      startDate: range.startDate,
      endDate: range.endDate,
      points: [
        {
          sessionDate: "2026-09-04",
          closedAt: "2026-09-04T19:59:00.000Z",
          netPnl: 42,
          cumulativeNetPnl: 42,
          trades: 1,
        },
      ],
      warnings: [],
    };
  }
  async divergences() {
    return [];
  }
  async qualifications() {
    return [];
  }
  async comparisons() {
    return [];
  }
  projection?: PaperJournalProjection;
  limit?: number;
  async journal(
    filters: Parameters<PaperReportingApi["journal"]>[0],
    projection: PaperJournalProjection,
    limit?: number,
  ) {
    this.filters = filters;
    this.projection = projection;
    this.limit = limit;
    return {
      projection,
      entries: [
        {
          id: "10000000-0000-4000-8000-000000000320",
          runId: "10000000-0000-4000-8000-000000000318",
          sessionDate: "2026-08-31",
          symbol: "ABC",
          strategyKey: "ORB_RETEST",
          profileName: "ORB",
          configVersion: "profile-v1",
          status: "CLOSED" as const,
          entryPrice: 10,
          entryTime: "2026-08-31T14:00:00.000Z",
          stopPrice: 9.5,
          targetPrice: 11,
          shares: 100,
          initialRisk: 50,
          exitPrice: 11,
          exitTime: "2026-08-31T15:00:00.000Z",
          exitReason: "TARGET" as const,
          grossPnl: 100,
          costs: 1,
          netPnl: 99,
          rMultiple: 1.98,
          runningNetPnl: projection === "COORDINATED" ? 99 : null,
        },
      ],
      totals: {
        closedTrades: 1,
        openPositions: 0,
        wins: 1,
        losses: 0,
        scratches: 0,
        winRate: { numerator: 1, denominator: 1, value: 1 },
        grossPnl: 100,
        costs: 1,
        netPnl: 99,
        profitFactor: null,
        cumulativeR: 1.98,
        averageR: 1.98,
        largestWin: 99,
        largestLoss: null,
      },
    };
  }
}

describe("Phase 5 paper reporting API", () => {
  it("validates filters and serves database-side aggregate envelopes", async () => {
    const reporting = new Reporting();
    const app = await buildApp({
      statusService: status(),
      paperReportingService: reporting,
    });
    const response = await app.inject({
      url: `/api/paper-bot/aggregates?profileConfigId=${aggregate.cohort.profileConfigId}&source=LIVE&model=QUOTE`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ aggregates: [aggregate] });
    expect(reporting.filters).toEqual({
      profileConfigId: aggregate.cohort.profileConfigId,
      source: "LIVE",
      model: "QUOTE",
    });
    const invalid = await app.inject({
      url: "/api/paper-bot/aggregates?source=NOPE",
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("serves commission sensitivity scenarios from an explicit list", async () => {
    const reporting = new Reporting();
    const app = await buildApp({
      statusService: status(),
      paperReportingService: reporting,
    });
    const response = await app.inject({
      url: "/api/paper-bot/commission-sensitivity?source=LIVE&commissions=0,1,9.95",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sensitivities).toHaveLength(1);
    expect(reporting.commissions).toEqual([0, 1, 9.95]);
    expect(reporting.filters).toEqual({ source: "LIVE" });

    const defaults = await app.inject({
      url: "/api/paper-bot/commission-sensitivity?source=LIVE",
    });
    expect(defaults.statusCode).toBe(200);
    expect(reporting.commissions).toBeUndefined();

    const invalid = await app.inject({
      url: "/api/paper-bot/commission-sensitivity?commissions=free",
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("keeps the coordinated shadow projection on its own endpoints", async () => {
    const app = await buildApp({
      statusService: status(),
      paperReportingService: new Reporting(),
    });
    const decisions = await app.inject({
      url: "/api/paper-bot/coordination/decisions?source=LIVE&limit=50",
    });
    const summary = await app.inject({
      url: "/api/paper-bot/coordination/summary?source=LIVE",
    });
    expect(decisions.statusCode).toBe(200);
    expect(decisions.json()).toEqual({ decisions: [] });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().summary).toMatchObject({
      approved: 1,
      deferred: 1,
      rejected: 1,
      closedTrades: 1,
    });
    await app.close();
  });

  it("serves database-side curve and model-divergence envelopes", async () => {
    const app = await buildApp({
      statusService: status(),
      paperReportingService: new Reporting(),
    });
    const curves = await app.inject({
      url: "/api/paper-bot/curves?source=LIVE",
    });
    const divergences = await app.inject({
      url: "/api/paper-bot/divergences?source=LIVE",
    });
    expect(curves.statusCode).toBe(200);
    expect(curves.json()).toEqual({ points: [] });
    expect(divergences.statusCode).toBe(200);
    expect(divergences.json()).toEqual({ divergences: [] });
    await app.close();
  });

  it("serves the coordinated performance curve over an explicit session range", async () => {
    const reporting = new Reporting();
    const app = await buildApp({
      statusService: status(),
      paperReportingService: reporting,
    });
    const response = await app.inject({
      url: "/api/paper-bot/performance?marketId=CA_TSX&source=LIVE&startDate=2026-09-01&endDate=2026-09-05&granularity=TRADE",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: "COORDINATED",
      currency: "CAD",
      granularity: "TRADE",
      points: [{ sessionDate: "2026-09-04", cumulativeNetPnl: 42 }],
    });
    expect(reporting.performanceRange).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-05",
    });

    const missing = await app.inject({
      url: "/api/paper-bot/performance?marketId=CA_TSX",
    });
    expect(missing.statusCode).toBe(400);
    const reversed = await app.inject({
      url: "/api/paper-bot/performance?startDate=2026-09-05&endDate=2026-09-01",
    });
    expect(reversed.statusCode).toBe(400);
    const badGranularity = await app.inject({
      url: "/api/paper-bot/performance?startDate=2026-09-01&endDate=2026-09-05&granularity=WEEK",
    });
    expect(badGranularity.statusCode).toBe(400);
    await app.close();
  });

  it("dispatches the funded curve to the funded reporting service without a shadow read", async () => {
    const performanceCurve = vi.fn(async () => ({
      account: "FUNDED" as const,
      marketId: "US_EQUITIES" as const,
      currency: "USD" as const,
      granularity: "DAY" as const,
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      points: [],
      warnings: [],
    }));
    const fundedReportingService: FundedReportingApi = {
      getExecutionDiagnostics: vi.fn(),
      performanceCurve,
      journal: vi.fn(),
    };
    const app = await buildApp({
      statusService: status(),
      fundedReportingService,
    });
    const response = await app.inject({
      url: "/api/paper-bot/performance?account=FUNDED&marketId=US_EQUITIES&source=LIVE&startDate=2026-09-01&endDate=2026-09-05",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: "FUNDED",
      currency: "USD",
    });
    expect(performanceCurve).toHaveBeenCalledWith(
      "US_EQUITIES",
      { startDate: "2026-09-01", endDate: "2026-09-05" },
      "LIVE",
    );
    await app.close();
  });

  it("serves one P&L journal projection at a time and defaults to the coordinated ledger", async () => {
    const reporting = new Reporting();
    const app = await buildApp({
      statusService: status(),
      paperReportingService: reporting,
    });

    const defaulted = await app.inject({
      url: "/api/paper-bot/journal?source=LIVE",
    });
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.json()).toMatchObject({
      projection: "COORDINATED",
      totals: { closedTrades: 1, netPnl: 99 },
    });
    // The projection selects a ledger; it must never leak into the filters.
    expect(reporting.filters).toEqual({ source: "LIVE" });
    expect(reporting.limit).toBe(200);

    const independent = await app.inject({
      url: "/api/paper-bot/journal?source=LIVE&projection=INDEPENDENT&limit=25",
    });
    expect(independent.statusCode).toBe(200);
    expect(independent.json().projection).toBe("INDEPENDENT");
    // No running balance exists across overlapping independent executions.
    expect(independent.json().entries[0].runningNetPnl).toBeNull();
    expect(reporting.limit).toBe(25);

    const invalid = await app.inject({
      url: "/api/paper-bot/journal?projection=BOTH",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("Invalid journal projection");
    await app.close();
  });

  it("serves the funded journal from the funded reporting service", async () => {
    const journal = vi.fn(async () => fundedJournal);
    const fundedReportingService: FundedReportingApi = {
      getExecutionDiagnostics: vi.fn(),
      performanceCurve: vi.fn(),
      journal,
    };
    const app = await buildApp({
      statusService: status(),
      fundedReportingService,
    });
    const response = await app.inject({
      url: "/api/paper-bot/journal?projection=FUNDED&marketId=CA_TSX&source=LIVE&limit=25",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projection: "FUNDED",
      entries: [],
    });
    expect(journal).toHaveBeenCalledWith(
      { marketId: "CA_TSX", source: "LIVE" },
      25,
    );
    await app.close();
  });

  it("serves the durable human-readable activity journal", async () => {
    const reporting = new Reporting();
    const app = await buildApp({
      statusService: status(),
      paperReportingService: reporting,
    });
    const response = await app.inject({
      url: "/api/paper-bot/activities?source=LIVE&limit=100",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      activities: [
        {
          eventType: "RUN_STARTED",
          severity: "INFO",
          message: "Paper bot started the live run for 2026-08-31.",
        },
      ],
    });
    expect(reporting.filters).toEqual({ source: "LIVE" });
    await app.close();
  });
});
