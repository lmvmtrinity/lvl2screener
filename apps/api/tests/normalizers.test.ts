import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeQuote } from "../src/questrade/normalizers.js";
import type { RawQuote } from "../src/questrade/types.js";

function quote(overrides: Partial<RawQuote> = {}): RawQuote {
  return {
    symbol: "TEST.TO",
    symbolId: 42,
    bidPrice: 10,
    bidSize: 100,
    askPrice: 10.02,
    askSize: 200,
    lastTradePrice: 10.01,
    lastTradeSize: 10,
    volume: 25_000,
    openPrice: 9.9,
    highPrice: 10.1,
    lowPrice: 9.8,
    delay: false,
    isHalted: false,
    ...overrides,
  };
}

describe("normalizeQuote", () => {
  it("keeps provider trade time distinct from receipt time and missing time unknown", () => {
    const receipt = new Date("2026-09-09T14:00:00Z");
    const value = normalizeQuote(
      quote({ lastTradeTime: "2026-09-09T09:59:00-04:00" }),
      receipt,
    );
    expect(value.lastTradeAt?.toISOString()).toBe("2026-09-09T13:59:00.000Z");
    expect(value.receivedAt).toEqual(receipt);
    expect(normalizeQuote(quote(), receipt).lastTradeAt).toBeNull();
    expect(
      normalizeQuote(quote({ lastTradeTime: "invalid" }), receipt).lastTradeAt,
    ).toBeNull();
  });
  it("derives spread and permits a real-time, active quote", () => {
    const normalized = normalizeQuote(
      quote(),
      new Date("2026-08-24T14:00:00Z"),
    );

    expect(normalized.mid).toBeCloseTo(10.01);
    expect(normalized.spreadAbsolute).toBeCloseTo(0.02);
    expect(normalized.spreadPct).toBeCloseTo(0.1998, 4);
    expect(normalized.dataStatus).toBe("REALTIME");
    expect(normalized.actionable).toBe(true);
  });

  it.each([true, 15])("recognizes delayed data represented as %s", (delay) => {
    const normalized = normalizeQuote(quote({ delay }), new Date());

    expect(normalized.dataStatus).toBe("DELAYED");
    expect(normalized.actionable).toBe(false);
  });

  it("gives a halt precedence over delayed status", () => {
    const normalized = normalizeQuote(
      quote({ delay: 15, isHalted: true }),
      new Date(),
    );

    expect(normalized.dataStatus).toBe("HALTED");
    expect(normalized.actionable).toBe(false);
  });

  it("rejects crossed quotes", () => {
    expect(() =>
      normalizeQuote(quote({ bidPrice: 10.03 }), new Date()),
    ).toThrow("Invalid bid/ask");
  });

  it("normalizes Canadian board lots to displayed shares while retaining raw values", () => {
    const normalized = normalizeQuote(
      quote({ bidSize: 4, askSize: 5 }),
      new Date("2026-09-02T14:40:00Z"),
      "QUESTRADE",
      "BOARD_LOTS",
      100,
    );

    expect(normalized).toMatchObject({
      bidSize: 400,
      askSize: 500,
      bidSizeRaw: 4,
      askSizeRaw: 5,
      sizeUnit: "BOARD_LOTS",
      sizeMultiplier: 100,
    });
  });

  it("fails closed when the provider size unit is unknown", () => {
    expect(() =>
      normalizeQuote(
        quote({ bidSize: 4, askSize: 5 }),
        new Date(),
        "QUESTRADE",
        "UNKNOWN",
        1,
      ),
    ).toThrow("Quote-size unit is unknown");
  });

  it("reproduces the dated credential-free TSX size fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/questrade-tsx-quote-size-2026-09-02.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      multiplier: number;
      quote: { bidSize: number; askSize: number };
      expectedDisplayedShares: { bid: number; ask: number };
    };
    const normalized = normalizeQuote(
      quote(fixture.quote),
      new Date("2026-09-02T14:40:00Z"),
      "QUESTRADE",
      "BOARD_LOTS",
      fixture.multiplier,
    );
    expect([normalized.bidSize, normalized.askSize]).toEqual([
      fixture.expectedDisplayedShares.bid,
      fixture.expectedDisplayedShares.ask,
    ]);
  });
});
