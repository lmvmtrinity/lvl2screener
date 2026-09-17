import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { FundedReportingService } from "../src/paper-bot/funded-reporting-service.js";
import {
  fundedAccountSummary,
  type FundedLedger,
} from "../src/paper-bot/funded-ledger.js";

const ACCOUNT = "10000000-0000-4000-8000-000000000901";

function ledger(
  cash: number,
  session: string,
  at: string,
  overrides: Partial<FundedLedger> = {},
): FundedLedger {
  return {
    version: "funded-ledger-v1",
    currency: "CAD",
    cash,
    session,
    openingEquity: cash,
    dailyLossLimit: 500,
    realizedPnl: 0,
    positions: {},
    reservations: {},
    events: [],
    lastEventAt: at,
    ...overrides,
  };
}

function snapshot(
  sessionDate: string,
  boundaryAt: string,
  boundaryCash: number,
  orders: unknown[] = [],
) {
  return {
    currency: "CAD",
    sessionDate,
    boundaryAt,
    boundaryState: ledger(boundaryCash, sessionDate, boundaryAt),
    initialState: ledger(10_000, "2026-09-08", "2026-09-08T13:30:00.000Z"),
    orders,
  };
}

function order(executionStatus: "CLOSED" | "OPEN" | null) {
  return {
    instrumentId: "AAPL",
    state: {
      orderId: `order-${executionStatus ?? "NONE"}`,
      status: executionStatus === "CLOSED" ? "FILLED" : "PENDING",
      execution:
        executionStatus === null
          ? null
          : { status: executionStatus, exit: { financials: { netPnl: 10 } } },
    },
  };
}

function poolWith(responses: Array<{ rows: unknown[] }>): Pool {
  let index = 0;
  return {
    query: async () => responses[index++] ?? { rows: [] },
  } as unknown as Pool;
}

describe("funded account performance curve", () => {
  it("reports an explicit not-configured empty curve instead of guessing an account", async () => {
    const service = new FundedReportingService({} as unknown as Pool);
    const curve = await service.performanceCurve(
      "CA_TSX",
      { startDate: "2026-09-01", endDate: "2026-09-05" },
      "LIVE",
    );
    expect(curve).toMatchObject({
      account: "FUNDED",
      marketId: "CA_TSX",
      currency: "CAD",
      granularity: "DAY",
      points: [],
      warnings: ["FUNDED_ACCOUNT_NOT_CONFIGURED"],
    });
  });

  it("bases each point on the immutable run-end snapshot equity", async () => {
    const service = new FundedReportingService(
      poolWith([
        {
          rows: [
            snapshot("2026-09-09", "2026-09-09T20:00:00.000Z", 10_050, [
              order("CLOSED"),
              order("OPEN"),
            ]),
            snapshot("2026-09-10", "2026-09-10T20:00:00.000Z", 10_020, [
              order("CLOSED"),
              order("CLOSED"),
              order(null),
            ]),
          ],
        },
      ]),
      () => new Date("2026-09-11T00:00:00.000Z"),
      { CA_TSX: ACCOUNT },
    );
    const curve = await service.performanceCurve(
      "CA_TSX",
      { startDate: "2026-09-09", endDate: "2026-09-10" },
      "LIVE",
    );
    expect(curve).toMatchObject({
      account: "FUNDED",
      currency: "CAD",
      granularity: "DAY",
      warnings: [],
    });
    // Equity since inception: +50 then +20. The realized amount in the
    // boundary ledger alone is not used, because marks are not in it.
    expect(curve.points).toEqual([
      {
        sessionDate: "2026-09-09",
        closedAt: "2026-09-09T20:00:00.000Z",
        netPnl: 50,
        cumulativeNetPnl: 50,
        trades: 1,
      },
      {
        sessionDate: "2026-09-10",
        closedAt: "2026-09-10T20:00:00.000Z",
        netPnl: -30,
        cumulativeNetPnl: 20,
        trades: 2,
      },
    ]);
    // A sanity check on the fixture itself: the summary really is equity.
    expect(
      fundedAccountSummary(
        snapshot("2026-09-10", "2026-09-10T20:00:00.000Z", 10_020)
          .boundaryState,
        "2026-09-10T20:00:00.000Z",
        30_000,
      ).equity,
    ).toBe(10_020);
  });

  it("rebases the range to the last boundary before it", async () => {
    const service = new FundedReportingService(
      poolWith([
        {
          rows: [
            snapshot("2026-09-09", "2026-09-09T20:00:00.000Z", 10_050),
            snapshot("2026-09-10", "2026-09-10T20:00:00.000Z", 10_020),
          ],
        },
      ]),
      () => new Date("2026-09-11T00:00:00.000Z"),
      { CA_TSX: ACCOUNT },
    );
    const curve = await service.performanceCurve(
      "CA_TSX",
      { startDate: "2026-09-10", endDate: "2026-09-10" },
      "LIVE",
    );
    expect(curve.points).toEqual([
      {
        sessionDate: "2026-09-10",
        closedAt: "2026-09-10T20:00:00.000Z",
        netPnl: -30,
        cumulativeNetPnl: -30,
        trades: 0,
      },
    ]);
  });

  it("discloses completed runs whose run-end boundary was never captured", async () => {
    const service = new FundedReportingService(
      poolWith([
        { rows: [snapshot("2026-09-09", "2026-09-09T20:00:00.000Z", 10_050)] },
        { rows: [{ missing: "2" }] },
      ]),
      () => new Date("2026-09-11T00:00:00.000Z"),
      { CA_TSX: ACCOUNT },
    );
    const curve = await service.performanceCurve(
      "CA_TSX",
      { startDate: "2026-09-09", endDate: "2026-09-10" },
      "LIVE",
    );
    expect(curve.warnings).toEqual(["FUNDED_RUN_BOUNDARY_UNAVAILABLE"]);
  });
});
