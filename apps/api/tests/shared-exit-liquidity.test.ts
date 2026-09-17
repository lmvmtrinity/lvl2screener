import { describe, expect, it } from "vitest";
import { allocateExitLiquidity } from "../src/paper-bot/shared-exit-liquidity.js";
import {
  applyEntryOrderQuote,
  submitEntryOrder,
} from "../src/paper-bot/pending-order.js";
import type { AssumptionsSnapshot, QuoteFact } from "../src/paper-bot/types.js";

const at = "2026-09-04T14:00:00Z";
const assumptions: AssumptionsSnapshot = {
  positionSize: 600,
  slippageBps: 0,
  feePerTrade: 0,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
};
const quote: QuoteFact = {
  timestamp: at,
  bid: 9.99,
  ask: 10,
  bidSize: 100,
  askSize: 100,
  actionable: true,
  dataStatus: "REALTIME",
};
const opened = (orderId: string) =>
  applyEntryOrderQuote(
    submitEntryOrder({
      orderId,
      assumptions,
      submittedAt: at,
      expiresAt: "2026-09-04T14:01:00Z",
      signal: {
        entryReference: 10,
        stopReference: 9,
        targetReference: 12,
        atr14: 1,
        signalTimestamp: at,
      },
    }),
    quote,
  );

describe("shared bid-side exits", () => {
  it("keeps a holding-time exit armed when no displayed size is available", () => {
    const order = { ...opened("timed"), context: { maximumHoldingMinutes: 1 } };
    const pending = allocateExitLiquidity(
      [order],
      { ...quote, timestamp: "2026-09-04T14:01:00Z", bidSize: 0 },
      1,
      0,
    );
    expect(pending.orders[0]?.execution).toMatchObject({
      status: "OPEN",
      position: { pendingExitReason: "TIME_STOP" },
    });
    const next = allocateExitLiquidity(
      pending.orders,
      { ...quote, timestamp: "2026-09-04T14:01:01Z", bid: 12, ask: 12.01 },
      1,
      0,
    );
    expect(next.orders[0]?.execution).toMatchObject({
      status: "CLOSED",
      position: { exitFills: [{ exitReason: "TIME_STOP" }] },
    });
  });

  it("applies stalled-breakout exits only to breakout strategies", () => {
    const fact = { ...quote, timestamp: "2026-09-04T14:01:00Z" };
    const context = {
      stalledBreakoutMinutes: 1,
      stalledBreakoutMinProgressR: 0.25,
    };
    const breakout = allocateExitLiquidity(
      [
        {
          ...opened("breakout"),
          context: { ...context, strategyKey: "ORB_RETEST" },
        },
      ],
      fact,
      1,
      0,
    );
    expect(breakout.orders[0]?.execution?.status).toBe("CLOSED");
    const reclaim = allocateExitLiquidity(
      [
        {
          ...opened("reclaim"),
          context: { ...context, strategyKey: "VWAP_RECLAIM" },
        },
      ],
      fact,
      1,
      0,
    );
    expect(reclaim.orders[0]?.execution?.status).toBe("OPEN");
  });
  it("allocates deterministic partial exits without reusing displayed size", () => {
    const fact = {
      ...quote,
      timestamp: "2026-09-04T14:00:01Z",
      bid: 12,
      ask: 12.01,
    };
    const result = allocateExitLiquidity(
      [opened("b"), opened("a")],
      fact,
      1,
      0,
    );
    expect(result.consumedShares).toBe(100);
    expect(result.orders[0]?.execution?.status).toBe("OPEN");
    expect(result.orders[1]?.execution?.status).toBe("CLOSED");
    const retry = allocateExitLiquidity(
      JSON.parse(JSON.stringify(result.orders)),
      fact,
      1,
      0,
    );
    expect(retry.consumedShares).toBe(0);
  });
  it("retains close-pending quantities until later capacity becomes available", () => {
    const boundary = "2026-09-04T21:00:00Z";
    const pending = allocateExitLiquidity(
      [opened("a")],
      { ...quote, timestamp: boundary, bidSize: 0 },
      1,
      0,
      boundary,
    );
    expect(pending.orders[0]?.execution?.status).toBe("CLOSE_PENDING");
    const closed = allocateExitLiquidity(
      pending.orders,
      { ...quote, timestamp: "2026-09-04T21:00:01Z" },
      1,
      0,
      boundary,
    );
    expect(closed.consumedShares).toBe(60);
    expect(closed.orders[0]?.execution?.status).toBe("CLOSED");
  });
});
