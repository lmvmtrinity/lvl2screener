import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocateEntryLiquidity,
  openEntryLiquidity,
} from "../src/paper-bot/shared-entry-liquidity.js";
import { allocateExitLiquidity } from "../src/paper-bot/shared-exit-liquidity.js";
import {
  applyEntryOrderQuote,
  submitEntryOrder,
} from "../src/paper-bot/pending-order.js";
import type { AssumptionsSnapshot, QuoteFact } from "../src/paper-bot/types.js";

const at = "2026-09-10T14:00:00.000Z";
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
const quote = (overrides: Partial<QuoteFact> = {}): QuoteFact => ({
  timestamp: at,
  bid: 9.99,
  ask: 10,
  bidSize: 100,
  askSize: 100,
  actionable: true,
  dataStatus: "REALTIME",
  ...overrides,
});
const entry = (orderId: string, latencyMs = 0) =>
  submitEntryOrder({
    orderId,
    assumptions: { ...assumptions, latencyMs },
    submittedAt: at,
    expiresAt: "2026-09-10T14:01:00.000Z",
    signal: {
      entryReference: 10,
      stopReference: 9,
      targetReference: 12,
      atr14: 1,
      signalTimestamp: at,
    },
  });
const opened = (orderId: string) =>
  applyEntryOrderQuote(entry(orderId), quote());

describe("shared liquidity invariants", () => {
  it("preserves entry capacity and makes replay/retry idempotent", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 3 }),
        (displayed, participationPct, orderCount) => {
          const participation = participationPct / 100;
          const orders = Array.from({ length: orderCount }, (_, index) =>
            entry(`entry-${index}`),
          );
          const initial = openEntryLiquidity(
            "instrument",
            quote({ askSize: displayed }),
            participation,
            0,
          );
          const result = allocateEntryLiquidity(initial, "instrument", orders);
          const capacity = Math.floor(displayed * participation);
          expect(result.liquidity.consumedShares).toBeLessThanOrEqual(capacity);
          const retried = allocateEntryLiquidity(
            JSON.parse(JSON.stringify(result.liquidity)),
            "instrument",
            JSON.parse(JSON.stringify(result.orders)),
          );
          expect(retried.liquidity.consumedShares).toBe(
            result.liquidity.consumedShares,
          );
          expect(retried.orders).toEqual(result.orders);
        },
      ),
      { numRuns: 500, seed: 20260909 },
    );
  });

  it("preserves exit capacity across partial fills and retries", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 100 }),
        (displayed, participationPct) => {
          const participation = participationPct / 100;
          const result = allocateExitLiquidity(
            [opened("exit-a"), opened("exit-b")],
            quote({
              timestamp: "2026-09-10T14:00:01.000Z",
              bid: 12,
              ask: 12.01,
              bidSize: displayed,
            }),
            participation,
            0,
          );
          expect(result.consumedShares).toBeLessThanOrEqual(
            Math.floor(displayed * participation),
          );
          const retried = allocateExitLiquidity(
            JSON.parse(JSON.stringify(result.orders)),
            quote({
              timestamp: "2026-09-10T14:00:01.000Z",
              bid: 12,
              ask: 12.01,
              bidSize: displayed,
            }),
            participation,
            0,
          );
          expect(retried.consumedShares).toBe(0);
          expect(retried.orders).toEqual(result.orders);
        },
      ),
      { numRuns: 500, seed: 20260910 },
    );
  });

  it("does not consume capacity before release or after the original expiry", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (latencyMs) => {
        const delayed = entry("delayed", latencyMs);
        const initial = openEntryLiquidity("instrument", quote(), 1, 0);
        const beforeRelease = allocateEntryLiquidity(initial, "instrument", [
          delayed,
        ]);
        if (latencyMs > 0) {
          expect(beforeRelease.liquidity.consumedShares).toBe(0);
          expect(beforeRelease.orders[0]?.status).toBe("PENDING");
        }
        const expired = entry("expired");
        const result = allocateEntryLiquidity(
          openEntryLiquidity(
            "instrument",
            quote({ timestamp: "2026-09-10T14:02:00.000Z" }),
            1,
            0,
          ),
          "instrument",
          [expired],
        );
        expect(result.liquidity.consumedShares).toBe(0);
        expect(result.orders[0]?.reason).toBe("EXPIRED");
      }),
      { numRuns: 500, seed: 20260911 },
    );
  });

  it("has a visible impact boundary and a mutation witness", () => {
    expect(() =>
      openEntryLiquidity("instrument", quote(), 1, 10_001),
    ).toThrow();
    const low = allocateEntryLiquidity(
      openEntryLiquidity("instrument", quote({ askSize: 100 }), 0.5, 0),
      "instrument",
      [entry("a"), entry("b")],
    );
    const high = allocateEntryLiquidity(
      openEntryLiquidity("instrument", quote({ askSize: 100 }), 1, 0),
      "instrument",
      [entry("a"), entry("b")],
    );
    expect(high.liquidity.consumedShares).toBeGreaterThan(
      low.liquidity.consumedShares,
    );
  });
});
