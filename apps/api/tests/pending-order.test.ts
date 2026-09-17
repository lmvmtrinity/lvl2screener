import { describe, expect, it } from "vitest";
import {
  applyEntryOrderQuote,
  cancelEntryOrder,
  expireEntryOrder,
  submitEntryOrder,
} from "../src/paper-bot/pending-order.js";
import type { AssumptionsSnapshot, QuoteFact } from "../src/paper-bot/types.js";

const submittedAt = "2026-09-04T14:00:00.000Z";
const assumptions: AssumptionsSnapshot = {
  positionSize: 1000,
  slippageBps: 0,
  feePerTrade: 1,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 500,
};
const input = {
  orderId: "order-1",
  assumptions,
  submittedAt,
  expiresAt: "2026-09-04T14:00:10.000Z",
  signal: {
    entryReference: 10,
    stopReference: 9,
    targetReference: 12,
    atr14: 1,
    signalTimestamp: submittedAt,
  },
};
const quote: QuoteFact = {
  timestamp: "2026-09-04T14:00:00.500Z",
  bid: 10.19,
  ask: 10.2,
  bidSize: 100,
  askSize: 100,
  actionable: true,
  dataStatus: "REALTIME",
};

describe("pending entry order lifecycle", () => {
  it("ignores pre-release prices and uses the released quote after JSON recovery", () => {
    const order = submitEntryOrder(input);
    expect(
      applyEntryOrderQuote(order, {
        ...quote,
        timestamp: submittedAt,
        ask: 10,
      }),
    ).toBe(order);
    const filled = applyEntryOrderQuote(
      JSON.parse(JSON.stringify(order)),
      quote,
    );
    expect(filled.status).toBe("FILLED");
    expect(filled.execution?.status).toBe("OPEN");
    if (filled.execution?.status !== "OPEN") throw new Error("Expected fill");
    expect(filled.execution.position.entryPrice).toBe(10.2);
    expect(filled.execution.position.fillTime).toBe(quote.timestamp);
    expect(filled.execution.position.signalTime).toBe(submittedAt);
    expect(filled.execution.position.latencyMs).toBe(500);
    expect(applyEntryOrderQuote(filled, quote)).toBe(filled);
  });
  it("cancels at expiry before a same-time fill", () => {
    const order = submitEntryOrder(input);
    expect(
      applyEntryOrderQuote(order, { ...quote, timestamp: input.expiresAt })
        .reason,
    ).toBe("EXPIRED");
    expect(expireEntryOrder(order, input.expiresAt).status).toBe("CANCELLED");
  });
  it("keeps unavailable liquidity pending without double-processing", () => {
    const order = submitEntryOrder(input);
    const waiting = applyEntryOrderQuote(order, { ...quote, askSize: 0 });
    expect(waiting.status).toBe("PENDING");
    expect(applyEntryOrderQuote(waiting, quote)).toBe(waiting);
    expect(
      applyEntryOrderQuote(waiting, {
        ...quote,
        timestamp: "2026-09-04T14:00:01Z",
      }).status,
    ).toBe("FILLED");
  });
  it("never fills cancelled or invalidated orders", () => {
    const cancelled = cancelEntryOrder(
      submitEntryOrder(input),
      submittedAt,
      "SIGNAL_INVALIDATED",
    );
    expect(applyEntryOrderQuote(cancelled, quote)).toBe(cancelled);
  });
  it("rejects invalid times and negative latency", () => {
    expect(() =>
      submitEntryOrder({
        ...input,
        assumptions: { ...assumptions, latencyMs: -1 },
      }),
    ).toThrow();
    expect(() =>
      submitEntryOrder({ ...input, expiresAt: submittedAt }),
    ).toThrow();
    expect(() =>
      submitEntryOrder({ ...input, submittedAt: "invalid" }),
    ).toThrow();
  });
});
