import { describe, expect, it } from "vitest";
import type {
  FundedHistoricalReplay,
  FundedHistoricalReplayList,
  FundedLiveAccountResponse,
} from "@tsx-scanner/contracts";
import { buildApp, type FundedHistoricalReplayApi } from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

const runId = "10000000-0000-4000-8000-0000000000b1";

const replay: FundedHistoricalReplay = {
  projection: "FUNDED_PORTFOLIO_REPLAY",
  runId,
  accountId: "10000000-0000-4000-8000-0000000000b2",
  marketId: "US_EQUITIES",
  currency: "USD",
  sessionDate: "2026-09-08",
  runStatus: "COMPLETED",
  executionModelVersion: "paper-execution-v7",
  temporalScope: "RUN_END",
  asOf: "2026-09-08T20:00:00.000Z",
  qualifiedForCapitalAllocation: false,
  qualificationReason:
    "Out-of-sample and walk-forward qualification is not established by execution reporting",
  isCurrentAccount: false,
  summary: {
    cash: 10_000,
    equity: 9_996.5,
    realizedPnl: -3.46,
    dailyPnl: -3.46,
    reservedCash: 0,
    openRisk: 0,
    remainingDailyRisk: 96.54,
    staleMarks: false,
    entriesAllowed: true,
  },
  orderCounts: { pending: 0, filled: 1, cancelled: 0, rejected: 0 },
  orders: [],
  warnings: ["SIMULATED_LIQUIDITY_NOT_GUARANTEED"],
};

class FakeFundedReplays implements FundedHistoricalReplayApi {
  lastMarket?: string;
  lastLimit?: number;
  lastLiveMarket?: string;
  async list(
    marketId: "CA_TSX" | "US_EQUITIES",
    limit?: number,
  ): Promise<FundedHistoricalReplayList> {
    this.lastMarket = marketId;
    this.lastLimit = limit;
    return { marketId, runs: [{ ...replay, marketId }] };
  }
  async get(id: string): Promise<FundedHistoricalReplay> {
    return { ...replay, runId: id };
  }
  async liveAccount(
    marketId: "CA_TSX" | "US_EQUITIES",
  ): Promise<FundedLiveAccountResponse> {
    this.lastLiveMarket = marketId;
    const account = {
      projection: "FUNDED_PAPER_ACCOUNT" as const,
      marketId,
      currency:
        marketId === "US_EQUITIES" ? ("USD" as const) : ("CAD" as const),
      accountId: replay.accountId,
      runId,
      runStatus: "COMPLETED" as const,
      sessionDate: "2026-09-15",
      asOf: "2026-09-15T20:05:00.000Z",
      temporalScope: "CURRENT_ACCOUNT" as const,
      qualifiedForCapitalAllocation: false as const,
      qualificationReason:
        "Out-of-sample and walk-forward qualification is not established by execution reporting",
      summary: replay.summary,
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
      warnings: ["SIMULATED_LIQUIDITY_NOT_GUARANTEED"],
    };
    return { status: "READY", account };
  }
}

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });

describe("funded historical replay API", () => {
  it("serves market-scoped funded replay projections", async () => {
    const service = new FakeFundedReplays();
    const app = await buildApp({
      statusService: status(),
      fundedHistoricalService: service,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/funded-replays?marketId=US_EQUITIES&limit=25",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      marketId: "US_EQUITIES",
      runs: [
        {
          projection: "FUNDED_PORTFOLIO_REPLAY",
          qualifiedForCapitalAllocation: false,
          runStatus: "COMPLETED",
        },
      ],
    });
    expect(service.lastMarket).toBe("US_EQUITIES");
    expect(service.lastLimit).toBe(25);
    await app.close();
  });

  it("rejects invalid markets and identifiers", async () => {
    const app = await buildApp({
      statusService: status(),
      fundedHistoricalService: new FakeFundedReplays(),
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/funded-replays?marketId=ALL",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/funded-replays/not-a-uuid",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/api/funded-replays/${runId}` }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });

  it("serves the live funded account for the selected market", async () => {
    const service = new FakeFundedReplays();
    const app = await buildApp({
      statusService: status(),
      fundedHistoricalService: service,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/paper-bot/funded-account?marketId=US_EQUITIES",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "READY",
      account: {
        projection: "FUNDED_PAPER_ACCOUNT",
        marketId: "US_EQUITIES",
        currency: "USD",
        runStatus: "COMPLETED",
        temporalScope: "CURRENT_ACCOUNT",
        qualifiedForCapitalAllocation: false,
        activity: { decisions: 2, closed: 1, rejected: 1 },
      },
    });
    expect(service.lastLiveMarket).toBe("US_EQUITIES");
    await app.close();
  });

  it("rejects an invalid funded account market", async () => {
    const app = await buildApp({
      statusService: status(),
      fundedHistoricalService: new FakeFundedReplays(),
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/paper-bot/funded-account?marketId=ALL",
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
});
