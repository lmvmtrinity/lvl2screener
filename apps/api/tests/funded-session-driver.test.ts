import { describe, expect, it, vi } from "vitest";
import {
  processFundedSessionFacts,
  type FundedSessionFact,
} from "../src/paper-bot/funded-session-driver.js";
import { FundedRiskVeto } from "../src/paper-bot/funded-ledger.js";
import type { FundedOrderService } from "../src/paper-bot/funded-order-service.js";

const at = "2026-09-04T14:00:00Z";
const signal: FundedSessionFact = {
  type: "SIGNAL",
  instrumentId: "instrument",
  maximumDebit: 1000,
  maximumRisk: 100,
  order: {
    orderId: "order",
    submittedAt: at,
    expiresAt: "2026-09-04T14:01:00Z",
    signal: {
      entryReference: 10,
      stopReference: 9,
      targetReference: 12,
      atr14: 1,
      signalTimestamp: at,
    },
    assumptions: {
      positionSize: 1000,
      slippageBps: 0,
      feePerTrade: 0,
      stopMethod: "STRUCTURAL",
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
    },
  },
};
const quote: FundedSessionFact = {
  type: "QUOTE",
  instrumentId: "instrument",
  participation: 1,
  impactBps: 0,
  quote: {
    timestamp: at,
    bid: 9.99,
    ask: 10,
    bidSize: 100,
    askSize: 100,
    actionable: true,
    dataStatus: "REALTIME",
  },
};
describe("funded session chronological driver", () => {
  it("submits signals before same-time quotes regardless of input order", async () => {
    const calls: string[] = [];
    const service = {
      submit: vi.fn(async () => {
        calls.push("submit");
      }),
      quote: vi.fn(async () => {
        calls.push("quote");
      }),
      cancel: vi.fn(),
    } as unknown as FundedOrderService;
    expect(
      await processFundedSessionFacts(service, [
        { fact: quote, factId: "quote-1" },
        { fact: signal, factId: "funded-signal:order" },
      ]),
    ).toEqual({
      processed: 2,
      reservationVetoes: [],
      cancellationNoOps: [],
    });
    expect(calls).toEqual(["submit", "quote"]);
    // The durable envelope identity travels with the fact so the order and
    // ledger writes can bind their exact causal fact.
    expect(vi.mocked(service.submit).mock.calls[0]?.at(-1)).toBe(
      "funded-signal:order",
    );
    expect(vi.mocked(service.quote).mock.calls[0]?.at(-1)).toBe("quote-1");
  });
  it("continues quote processing after a reservation veto, not after infrastructure failure", async () => {
    const service = {
      submit: vi
        .fn()
        .mockRejectedValue(
          new FundedRiskVeto("order", "risk", "MAX_TOTAL_OPEN_RISK"),
        ),
      quote: vi.fn(),
      cancel: vi.fn(),
    } as unknown as FundedOrderService;
    const vetoed = await processFundedSessionFacts(service, [
      { fact: signal },
      { fact: quote },
    ]);
    expect(vetoed.reservationVetoes).toHaveLength(1);
    expect(vetoed.reservationVetoes[0]).toEqual({
      orderId: "order",
      reason: "risk",
      code: "MAX_TOTAL_OPEN_RISK",
    });
    expect(service.quote).toHaveBeenCalledOnce();
    vi.mocked(service.submit).mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(
      processFundedSessionFacts(service, [{ fact: signal }, { fact: quote }]),
    ).rejects.toThrow("database unavailable");
  });

  it("acknowledges a durable cancellation no-op after a reservation veto", async () => {
    const service = {
      submit: vi.fn(),
      quote: vi.fn(),
      cancel: vi.fn(async () => ({
        status: "NO_OP" as const,
        orderId: "order",
        reason: "RESERVATION_VETO" as const,
      })),
    } as unknown as FundedOrderService;
    const cancellation: FundedSessionFact = {
      type: "CANCEL",
      orderId: "order",
      at: "2026-09-04T14:00:01Z",
      reason: "SIGNAL_INVALIDATED",
    };
    await expect(
      processFundedSessionFacts(service, [
        { fact: cancellation, factId: "funded-invalidation:event-1" },
      ]),
    ).resolves.toMatchObject({
      processed: 1,
      cancellationNoOps: [{ orderId: "order", reason: "RESERVATION_VETO" }],
    });
  });
});
