import { describe, expect, it } from "vitest";
import {
  admitReplayQuotes,
  admitReplaySession,
  classifyReplayQuoteExclusion,
  type ReplayQuoteLike,
} from "../src/backtests/replay-quote-admission.js";

const instrumentId = "10000000-0000-4000-8000-000000000081";
const otherInstrumentId = "10000000-0000-4000-8000-000000000082";

function quote(overrides: Partial<ReplayQuoteLike> = {}): ReplayQuoteLike {
  return {
    instrumentId,
    timestamp: "2026-09-08T13:30:00.000Z",
    bid: 10,
    ask: 10.01,
    bidSize: 100,
    askSize: 100,
    spread: 0.01,
    last: 10,
    dayOpen: 10,
    dataStatus: "REALTIME",
    actionable: true,
    ...overrides,
  };
}

describe("replay quote admission", () => {
  it("admits a fully valid quote", () => {
    expect(classifyReplayQuoteExclusion(quote())).toBeNull();
  });

  it("rejects the captured opening quote with a zero day open", () => {
    expect(
      classifyReplayQuoteExclusion(quote({ bid: 7.71, ask: 7.71, dayOpen: 0 })),
    ).toBe("INVALID_DAY_OPEN");
  });

  it("classifies every admitted validation rule in first-match order", () => {
    expect(classifyReplayQuoteExclusion(quote({ bid: 0 }))).toBe("INVALID_BID");
    expect(classifyReplayQuoteExclusion(quote({ bid: 10, ask: 9.99 }))).toBe(
      "CROSSED_BOOK",
    );
    expect(classifyReplayQuoteExclusion(quote({ last: 0 }))).toBe(
      "INVALID_LAST",
    );
    expect(classifyReplayQuoteExclusion(quote({ bidSize: -1 }))).toBe(
      "INVALID_SIZE",
    );
    expect(classifyReplayQuoteExclusion(quote({ spread: -0.01 }))).toBe(
      "INVALID_SPREAD",
    );
    expect(classifyReplayQuoteExclusion(quote({ bid: Number.NaN }))).toBe(
      "NON_FINITE_VALUE",
    );
    expect(
      classifyReplayQuoteExclusion(
        quote({ bid: Number.NaN, dayOpen: 0, bidSize: -1 }),
      ),
    ).toBe("NON_FINITE_VALUE");
  });

  it("excludes individual facts and keeps valid quotes from the same instrument", () => {
    const valid = quote({ timestamp: "2026-09-08T13:31:00.000Z" });
    const admission = admitReplayQuotes([
      quote({ instrumentId, dayOpen: 0 }),
      valid,
      quote({ instrumentId: otherInstrumentId, last: 0 }),
    ]);
    expect(admission.admitted).toEqual([valid]);
    expect(admission.excludedQuotes).toBe(2);
    expect(admission.reasons).toEqual([
      { code: "INVALID_DAY_OPEN", count: 1 },
      { code: "INVALID_LAST", count: 1 },
    ]);
    expect([...admission.excludedByInstrument]).toEqual([
      [instrumentId, 1],
      [otherInstrumentId, 1],
    ]);
    expect(
      admission.reasons.reduce((sum, reason) => sum + reason.count, 0),
    ).toBe(admission.excludedQuotes);
  });

  it("does not rewrite a clean session and preserves order when filtering", () => {
    const first = quote({ timestamp: "2026-09-08T13:30:00.000Z" });
    const second = quote({ timestamp: "2026-09-08T13:31:00.000Z" });
    const session = { quotes: [first, second], candles: [] };
    expect(admitReplaySession(session)).toBe(session);

    const dirty = { quotes: [first, quote({ dayOpen: 0 }), second] };
    const admitted = admitReplaySession(dirty);
    expect(admitted.quotes).toEqual([first, second]);
    expect(dirty.quotes).toHaveLength(3);
  });
});
