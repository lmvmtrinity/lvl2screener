import { describe, expect, it } from "vitest";
import {
  allocateEntryLiquidity,
  openEntryLiquidity,
} from "../src/paper-bot/shared-entry-liquidity.js";
import { submitEntryOrder } from "../src/paper-bot/pending-order.js";
import type { AssumptionsSnapshot, QuoteFact } from "../src/paper-bot/types.js";

const timestamp = "2026-09-04T14:00:00Z";
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
  timestamp,
  bid: 9.99,
  ask: 10,
  bidSize: 100,
  askSize: 100,
  actionable: true,
  dataStatus: "REALTIME",
};
const order = (orderId: string) =>
  submitEntryOrder({
    orderId,
    assumptions,
    submittedAt: timestamp,
    expiresAt: "2026-09-04T14:01:00Z",
    signal: {
      entryReference: 10,
      stopReference: 9,
      targetReference: 12,
      atr14: 1,
      signalTimestamp: timestamp,
    },
  });

describe("shared entry quote capacity", () => {
  it("allocates once in deterministic order regardless of input order", () => {
    const initial = openEntryLiquidity("instrument", quote, 1, 0);
    const result = allocateEntryLiquidity(initial, "instrument", [
      order("b"),
      order("a"),
    ]);
    expect(result.liquidity.consumedShares).toBe(100);
    const quantities = result.orders.map((entry) =>
      entry.execution?.status === "OPEN" ? entry.execution.position.shares : 0,
    );
    expect(quantities).toEqual([40, 60]);
    const retried = allocateEntryLiquidity(
      JSON.parse(JSON.stringify(result.liquidity)),
      "instrument",
      result.orders,
    );
    expect(retried.liquidity.consumedShares).toBe(100);
  });
  it("shares participation limits across all orders", () => {
    const result = allocateEntryLiquidity(
      openEntryLiquidity("instrument", quote, 0.5, 0),
      "instrument",
      [order("a"), order("b")],
    );
    expect(result.liquidity.consumedShares).toBe(50);
    expect(result.orders[1]?.status).toBe("PENDING");
  });
  it("uses the new spread and explicit adverse impact, retaining the submission", () => {
    const original = order("a");
    const result = allocateEntryLiquidity(
      openEntryLiquidity("instrument", { ...quote, ask: 10.1 }, 1, 10),
      "instrument",
      [original],
    );
    const execution = result.orders[0]?.execution;
    expect(execution?.status).toBe("OPEN");
    if (execution?.status !== "OPEN") throw new Error("Expected fill");
    expect(execution.position.entryPrice).toBe(10.1101);
    expect(result.orders[0]?.assumptions).toEqual(original.assumptions);
    expect(execution.economics?.costs.slippageBps).toBe(10);
  });
  it("rejects cross-instrument use and invalid capacity assumptions", () => {
    expect(() =>
      allocateEntryLiquidity(openEntryLiquidity("one", quote, 1, 0), "two", []),
    ).toThrow("instrument mismatch");
    expect(() => openEntryLiquidity("one", quote, 2, 0)).toThrow();
    expect(() => openEntryLiquidity("one", quote, 1, -1)).toThrow();
  });
});
