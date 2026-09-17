import { describe, expect, it } from "vitest";
import { FundedLiveAdapter } from "../src/paper-bot/funded-live-adapter.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 0,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
};

describe("funded live retained quote catch-up", () => {
  it.each(["SHARES", "BOARD_LOTS"])(
    "loads normalized retained %s quotes after the persisted clock",
    async (unit) => {
      const adapter = new FundedLiveAdapter({
        pool: {
          query: async () => ({
            rows: [
              {
                instrumentId: "instrument-1",
                timestamp: "2099-02-02T14:00:02.000Z",
                bid: "9.99",
                ask: "10",
                bidSize: "100",
                askSize: "100",
                sizeUnit: unit,
                sizeMultiplier: unit === "BOARD_LOTS" ? 100 : 1,
              },
            ],
          }),
        } as never,
        runId: "run-1",
        accountId: "account-1",
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions,
      });
      await expect(
        adapter.retainedQuotes(["instrument-1"], "2099-02-02T14:00:03.000Z"),
      ).resolves.toEqual([
        {
          instrumentId: "instrument-1",
          timestamp: "2099-02-02T14:00:02.000Z",
          bid: 9.99,
          ask: 10,
          bidSize: 100,
          askSize: 100,
          sizeUnit: "SHARES",
          sizeMultiplier: 1,
          dataStatus: "REALTIME",
          actionable: true,
        },
      ]);
    },
  );

  it("reports durable close-pending age and funded failure counters", async () => {
    const queries: string[] = [];
    const adapter = new FundedLiveAdapter({
      pool: {
        query: async (text: string) => {
          queries.push(text);
          return {
            rows: [
              {
                closePendingOrders: "2",
                oldestClosePendingAt: "2099-02-02T14:00:00.000Z",
                riskVetoesTotal: "3",
                lateFactsTotal: "4",
              },
            ],
          };
        },
      } as never,
      runId: "run-1",
      accountId: "account-1",
      currency: "CAD",
      marketId: "CA_TSX",
      assumptions,
    });
    expect(adapter.recordRecoveryFailure()).toBe(1);
    expect(adapter.recordRecoveryFailure()).toBe(2);
    await expect(
      adapter.operationalSnapshot("2099-02-02T14:15:00.000Z"),
    ).resolves.toEqual({
      closePendingOrders: 2,
      oldestClosePendingAgeMs: 900_000,
      riskVetoesTotal: 3,
      coverageGapsTotal: 4,
      recoveryFailuresTotal: 2,
      lastCycleLatencyMs: null,
      pendingFacts: 0,
      oldestPendingFactAgeMs: null,
      factsArrivedPerMinute: 0,
      factsDrainedPerMinute: 0,
      arrivalMinusDrainPerMinute: 0,
      evidenceCaptureFailuresTotal: 0,
      evidenceProjectionFailuresTotal: 0,
      evidenceDecisionGapsTotal: 0,
      evidenceOutcomeGapsTotal: 0,
      reconstructionDurationMs: null,
      reconstructionDurationMaxMs: 0,
      reconstructionReplayedEvents: null,
      reconstructionPages: null,
      reconstructionCheckpointAgeMs: null,
      reconstructionLastObservedTimestampSeconds: null,
      reconstructionCountTotal: 0,
      reconstructionFullReplaysTotal: 0,
      reconstructionBudgetFailuresTotal: 0,
    });
    expect(
      queries.some((text) =>
        text.includes("FROM paper_funded_fact_rate_minute f"),
      ),
    ).toBe(true);
    expect(queries.some((text) => text.includes("f.fact_at >"))).toBe(false);
  });
});
