import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { FundedReportingService } from "../src/paper-bot/funded-reporting-service.js";

const ACCOUNT = "10000000-0000-4000-8000-000000000951";
const ENTRY = "10000000-0000-4000-8000-000000000952";
const RUN = "10000000-0000-4000-8000-000000000953";

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY,
    runId: RUN,
    sessionDate: "2026-09-15",
    symbol: "TD.TO",
    strategyKey: "ORB_RETEST",
    profileName: "Funded paper account",
    configVersion: "funded-policy-v1",
    status: "CLOSED",
    entryPrice: "10.00",
    entryTime: "2026-09-15T14:00:00.000Z",
    stopPrice: "9.50",
    targetPrice: "11.00",
    shares: "100",
    initialRisk: "50",
    requestedRisk: "60",
    bindingCaps: ["RISK_BUDGET"],
    exitPrice: "10.50",
    exitTime: "2026-09-15T15:00:00.000Z",
    exitReason: "TARGET",
    grossPnl: "51",
    netPnl: "50",
    rMultiple: "1",
    costs: "1",
    runningNetPnl: "50",
    lastFactTimestamp: "2026-09-15T15:00:00.000Z",
    ...overrides,
  };
}

const totalRow = {
  closed_trades: "1",
  open_positions: "0",
  wins: "1",
  losses: "0",
  scratches: "0",
  gross_pnl: "51",
  costs: "1",
  net_pnl: "50",
  won_net_pnl: "50",
  lost_net_pnl: "0",
  cumulative_r: "1",
  average_r: "1",
  largest_win: "50",
  largest_loss: null,
};

function poolWith(responses: Array<{ rows: unknown[] }>): Pool {
  let index = 0;
  return {
    query: async () => responses[index++] ?? { rows: [] },
  } as unknown as Pool;
}

describe("funded account journal", () => {
  it("returns an explicit empty funded ledger when no account is configured", async () => {
    const service = new FundedReportingService({} as unknown as Pool);
    const journal = await service.journal(
      { marketId: "CA_TSX", source: "LIVE" },
      200,
    );
    expect(journal).toMatchObject({
      projection: "FUNDED",
      entries: [],
      unresolvedPositions: [],
    });
    expect(journal.totals).toMatchObject({
      closedTrades: 0,
      netPnl: 0,
      profitFactor: null,
    });
  });

  it("maps funded order state into the shared journal contract", async () => {
    const service = new FundedReportingService(
      poolWith([
        { rows: [entryRow()] },
        { rows: [totalRow] },
        {
          rows: [
            {
              id: ENTRY,
              symbol: "TD.TO",
              sessionDate: "2026-09-15",
              status: "OPEN",
              runStatus: "RUNNING",
              entryTime: "2026-09-15T14:00:00.000Z",
              lastFactTimestamp: "2026-09-15T14:30:00.000Z",
              ageMs: "1800000",
            },
          ],
        },
      ]),
      () => new Date("2026-09-15T16:00:00.000Z"),
      { CA_TSX: ACCOUNT },
    );
    const journal = await service.journal(
      { marketId: "CA_TSX", source: "LIVE" },
      200,
    );
    expect(journal.projection).toBe("FUNDED");
    expect(journal.entries).toEqual([
      {
        id: ENTRY,
        runId: RUN,
        sessionDate: "2026-09-15",
        symbol: "TD.TO",
        strategyKey: "ORB_RETEST",
        profileName: "Funded paper account",
        configVersion: "funded-policy-v1",
        status: "CLOSED",
        entryPrice: 10,
        entryTime: "2026-09-15T14:00:00.000Z",
        stopPrice: 9.5,
        targetPrice: 11,
        shares: 100,
        initialRisk: 50,
        requestedRisk: 60,
        riskDeploymentRatio: 50 / 60,
        bindingCaps: ["RISK_BUDGET"],
        exitPrice: 10.5,
        exitTime: "2026-09-15T15:00:00.000Z",
        exitReason: "TARGET",
        grossPnl: 51,
        costs: 1,
        netPnl: 50,
        rMultiple: 1,
        runningNetPnl: 50,
        lastFactTimestamp: "2026-09-15T15:00:00.000Z",
      },
    ]);
    expect(journal.totals).toMatchObject({
      closedTrades: 1,
      openPositions: 0,
      wins: 1,
      winRate: { numerator: 1, denominator: 1, value: 1 },
      netPnl: 50,
      profitFactor: null,
      largestWin: 50,
      largestLoss: null,
    });
    expect(journal.unresolvedPositions).toEqual([
      {
        id: ENTRY,
        symbol: "TD.TO",
        sessionDate: "2026-09-15",
        status: "OPEN",
        runStatus: "RUNNING",
        entryTime: "2026-09-15T14:00:00.000Z",
        lastFactTimestamp: "2026-09-15T14:30:00.000Z",
        ageMs: 1_800_000,
      },
    ]);
  });
});
