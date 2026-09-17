import { describe, expect, it, vi } from "vitest";
import { fundedHistoricalReplaySchema } from "@tsx-scanner/contracts";
import { planFundedHistoricalRange } from "../src/paper-bot/funded-historical-range-plan.js";
import {
  FundedHistoricalReadService,
  projectFundedHistoricalReplay,
  type FundedHistoricalReport,
} from "../src/paper-bot/funded-historical-read-service.js";

const runA = "10000000-0000-4000-8000-0000000000a1";
const account = "10000000-0000-4000-8000-0000000000a2";
const orderId = "10000000-0000-4000-8000-0000000000a3";
const instrumentId = "10000000-0000-4000-8000-0000000000a4";

function fundedReport(
  runId: string,
  sessionDate = "2026-09-08",
): FundedHistoricalReport {
  return {
    projection: "FUNDED_CASH_SIMULATION",
    qualifiedForCapitalAllocation: false,
    qualificationReason:
      "Out-of-sample and walk-forward qualification is not established by execution reporting",
    runId,
    accountId: account,
    asOf: `${sessionDate}T20:00:00.000Z`,
    temporalScope: "RUN_END",
    accountSession: sessionDate,
    ordersScope: "RUN",
    cohort: {
      marketId: "CA_TSX",
      currency: "CAD",
      executionModelVersion: "paper-execution-v7",
      ledgerVersion: "funded-ledger-v1",
      source: "BACKTEST",
      sessionDate,
      assumptions: {},
      fundedPolicy: null,
    },
    runStatus: "COMPLETED",
    summary: {
      cash: 10_000,
      equity: 9_996.5,
      marketValue: 0,
      buyingPower: 10_000,
      reservedCash: 0,
      reservedRisk: 0,
      openRisk: 0,
      unrealizedPnl: 0,
      realizedPnl: -3.46,
      dailyPnl: -3.46,
      remainingDailyRisk: 196.54,
      staleMarks: false,
      entriesAllowed: true,
    },
    positions: {},
    reservations: {},
    orders: [
      {
        orderId,
        instrumentId,
        status: "FILLED",
        reason: null,
        signal: {},
        assumptions: {},
        submittedAt: `${sessionDate}T14:00:00.000Z`,
        releaseAt: `${sessionDate}T14:00:00.000Z`,
        expiresAt: `${sessionDate}T20:00:00.000Z`,
        lastQuoteAt: `${sessionDate}T14:45:00.000Z`,
        execution: {
          status: "CLOSED",
          position: { shares: 25, entryPrice: 71.25 },
          exit: {
            exitReason: "TIME_STOP",
            financials: { netPnl: -3.46, rMultiple: -0.18 },
          },
        },
      },
      {
        orderId: "10000000-0000-4000-8000-0000000000a5",
        instrumentId: "10000000-0000-4000-8000-0000000000a6",
        status: "REJECTED",
        reason: "REJECTED_ECONOMICS",
        signal: {},
        assumptions: {},
        submittedAt: `${sessionDate}T14:10:00.000Z`,
        releaseAt: `${sessionDate}T14:10:00.000Z`,
        expiresAt: `${sessionDate}T20:00:00.000Z`,
        lastQuoteAt: `${sessionDate}T14:11:00.000Z`,
        execution: { status: "REJECTED_ECONOMICS" },
      },
    ],
    warnings: ["SIMULATED_LIQUIDITY_NOT_GUARANTEED"],
  } as unknown as FundedHistoricalReport;
}

describe("funded historical range planning", () => {
  it("sorts sessions and rejects invalid bounded ranges", () => {
    expect(planFundedHistoricalRange(["2026-09-09", "2026-09-08"])).toEqual([
      "2026-09-08",
      "2026-09-09",
    ]);
    expect(() => planFundedHistoricalRange([])).toThrow(/no captured sessions/);
    expect(() =>
      planFundedHistoricalRange(["2026-09-08", "2026-09-08"]),
    ).toThrow(/duplicate/);
    expect(() => planFundedHistoricalRange(["2026-9-8"])).toThrow(/Invalid/);
    expect(() =>
      planFundedHistoricalRange(["2026-09-08", "2026-09-09", "2026-09-10"], 2),
    ).toThrow(/exceeds 2/);
  });
});

describe("funded historical read projection", () => {
  it("projects account results separately from signal outcomes", () => {
    const projected = projectFundedHistoricalReplay(fundedReport(runA));
    expect(projected).toMatchObject({
      projection: "FUNDED_PORTFOLIO_REPLAY",
      runId: runA,
      qualifiedForCapitalAllocation: false,
      temporalScope: "RUN_END",
      isCurrentAccount: false,
      orderCounts: { pending: 0, filled: 1, cancelled: 0, rejected: 1 },
    });
    expect(projected.orders[0]).toMatchObject({
      orderId,
      status: "FILLED",
      executionStatus: "CLOSED",
      shares: 25,
      entryPrice: 71.25,
      exitReason: "TIME_STOP",
      netPnl: -3.46,
      rMultiple: -0.18,
    });
    expect(projected.orders[1]).toMatchObject({
      status: "REJECTED",
      executionStatus: "REJECTED_ECONOMICS",
      reason: "REJECTED_ECONOMICS",
    });
    expect(fundedHistoricalReplaySchema.parse(projected).runId).toBe(runA);
  });

  it("lists market-scoped funded replays through the reporting service", async () => {
    const reporting = {
      report: vi.fn(async (runId: string) => fundedReport(runId)),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [{ runId: runA }] })),
    };
    const service = new FundedHistoricalReadService(
      pool as never,
      reporting as never,
    );
    const list = await service.list("CA_TSX", 25);
    expect(list.marketId).toBe("CA_TSX");
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]!.projection).toBe("FUNDED_PORTFOLIO_REPLAY");
    expect(reporting.report).toHaveBeenCalledWith(runA);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("r.source='BACKTEST'"),
      ["CA_TSX", 25],
    );
  });
});

describe("funded live account read", () => {
  const binding = {
    runId: runA,
    accountId: account,
    currency: "CAD" as const,
    status: "COMPLETED" as const,
    sessionDate: "2026-09-15",
    unknownPolicy: false,
  };
  const ledger = {
    version: "funded-ledger-v1" as const,
    currency: "CAD" as const,
    cash: 10_024.5,
    session: "2026-09-15",
    openingEquity: 10_000,
    dailyLossLimit: 200,
    realizedPnl: 24.5,
    positions: {},
    reservations: {},
    events: [],
    lastEventAt: "2026-09-15T13:30:00.000Z",
  };
  const closedOrder = {
    status: "FILLED",
    execution: {
      status: "CLOSED",
      exit: { financials: { netPnl: 24.5, rMultiple: 0.5 } },
    },
  };
  const rejectedOrder = {
    status: "REJECTED",
    execution: { status: "REJECTED_ECONOMICS" },
  };

  function livePool() {
    return {
      query: vi.fn(async (sql: string): Promise<{ rows: unknown[] }> => {
        if (sql.includes("r.source='LIVE'")) return { rows: [binding] };
        if (sql.includes("FROM paper_funded_account"))
          return { rows: [{ state: ledger }] };
        if (sql.includes("FROM paper_entry_order"))
          return { rows: [{ state: closedOrder }, { state: rejectedOrder }] };
        return { rows: [] };
      }),
    };
  }

  it("reads the bound market account and counts only that run's orders", async () => {
    const pool = livePool();
    const service = new FundedHistoricalReadService(
      pool as never,
      {} as never,
      () => new Date("2026-09-15T20:05:00.000Z"),
    );
    const result = await service.liveAccount("CA_TSX");
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("expected READY");
    expect(result.account).toMatchObject({
      projection: "FUNDED_PAPER_ACCOUNT",
      marketId: "CA_TSX",
      currency: "CAD",
      accountId: account,
      runId: runA,
      runStatus: "COMPLETED",
      sessionDate: "2026-09-15",
      temporalScope: "CURRENT_ACCOUNT",
      qualifiedForCapitalAllocation: false,
      activity: {
        decisions: 2,
        closed: 1,
        open: 0,
        pending: 0,
        rejected: 1,
        cancelled: 0,
        wins: 1,
        cumulativeR: 0.5,
      },
    });
    expect(result.account.summary.realizedPnl).toBe(24.5);
    expect(result.account.warnings).toContain(
      "SIMULATED_LIQUIDITY_NOT_GUARANTEED",
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("r.source='LIVE'"),
      ["CA_TSX"],
    );
  });

  it("reports an explicit unavailable state when no live run is bound", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    const service = new FundedHistoricalReadService(pool as never, {} as never);
    await expect(service.liveAccount("US_EQUITIES")).resolves.toEqual({
      status: "UNAVAILABLE",
      marketId: "US_EQUITIES",
      currency: "USD",
      reason: "NO_LIVE_FUNDED_RUN",
    });
  });

  it("refuses a currency mismatch between binding and ledger", async () => {
    const pool = livePool();
    pool.query.mockImplementationOnce(async () => ({
      rows: [{ ...binding, currency: "USD" as const }],
    }));
    const service = new FundedHistoricalReadService(
      pool as never,
      {} as never,
      () => new Date("2026-09-15T20:05:00.000Z"),
    );
    await expect(service.liveAccount("CA_TSX")).rejects.toThrow(
      /currency mismatch/,
    );
  });
});
