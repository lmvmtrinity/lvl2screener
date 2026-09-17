import { describe, expect, it } from "vitest";
import {
  applyCandleFacts,
  applyQuoteFact,
  createCandleExecution,
  createQuoteExecution,
  requestCandleSessionClose,
  requestQuoteSessionClose,
} from "../src/paper-bot/execution-core.js";
import type {
  AssumptionsSnapshot,
  CandleFact,
  QuoteFact,
  SignalFact,
} from "../src/paper-bot/types.js";

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 10,
  feePerTrade: 1,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 2,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
};

const signal: SignalFact = {
  entryReference: 10,
  stopReference: 9.5,
  targetReference: 11,
  atr14: 0.25,
  signalTimestamp: "2026-08-25T14:00:00.000Z",
};

const quote = (overrides: Partial<QuoteFact> = {}): QuoteFact => ({
  timestamp: "2026-08-25T14:00:00.000Z",
  bid: 9.99,
  ask: Math.max(10, (overrides.bid ?? 9.99) + 0.01),
  bidSize: 500,
  askSize: 500,
  dataStatus: "REALTIME",
  actionable: true,
  ...overrides,
});

const candle = (overrides: Partial<CandleFact> = {}): CandleFact => ({
  start: "2026-08-25T14:01:00.000Z",
  end: "2026-08-25T14:02:00.000Z",
  open: 10,
  high: 10.1,
  low: 9.9,
  close: 10.05,
  ...overrides,
});

describe("quote execution core idempotency", () => {
  it("opens once from the decision-time quote, carrying the entry snapshot forward", () => {
    const state = createQuoteExecution(signal, quote(), assumptions);
    expect(state.status).toBe("OPEN");
    if (state.status === "OPEN") {
      expect(state.entryMarketSnapshot.dataStatus).toBe("REALTIME");
      expect(state.entrySizeCoverage).toBeGreaterThan(0);
    }
  });

  it("ignores a quote at or before the last processed fact", () => {
    const opened = createQuoteExecution(signal, quote(), assumptions);
    const result = applyQuoteFact(
      opened,
      quote({ timestamp: "2026-08-25T14:00:00.000Z", bid: 9.4 }),
      assumptions,
    );
    expect(result.transitioned).toBe(false);
    expect(result.state).toEqual(opened);
  });

  it("triggers exactly once when the same triggering quote is replayed", () => {
    const opened = createQuoteExecution(signal, quote(), assumptions);
    const triggering = quote({
      timestamp: "2026-08-25T14:30:00.000Z",
      bid: 9.4,
    });
    const first = applyQuoteFact(opened, triggering, assumptions);
    expect(first.transitioned).toBe(true);
    expect(first.state.status).toBe("CLOSED");

    const replayed = applyQuoteFact(first.state, triggering, assumptions);
    expect(replayed.transitioned).toBe(false);
    expect(replayed.state).toEqual(first.state);
  });

  it("does not reopen a CLOSED execution when later facts arrive", () => {
    const opened = createQuoteExecution(signal, quote(), assumptions);
    const closed = applyQuoteFact(
      opened,
      quote({ timestamp: "2026-08-25T14:30:00.000Z", bid: 9.4 }),
      assumptions,
    ).state;
    const later = applyQuoteFact(
      closed,
      quote({ timestamp: "2026-08-25T15:00:00.000Z", bid: 12 }),
      assumptions,
    );
    expect(later).toEqual({ state: closed, transitioned: false });
  });

  it("advances the watermark without transitioning when price stays inside levels", () => {
    const opened = createQuoteExecution(signal, quote(), assumptions);
    const result = applyQuoteFact(
      opened,
      quote({ timestamp: "2026-08-25T14:15:00.000Z", bid: 10.2 }),
      assumptions,
    );
    expect(result.transitioned).toBe(false);
    expect(result.state.status).toBe("OPEN");
    if (result.state.status === "OPEN") {
      expect(result.state.lastFactTimestamp).toBe("2026-08-25T14:15:00.000Z");
    }
  });

  it("moves OPEN to CLOSE_PENDING once and then no-ops on repeated requests", () => {
    const opened = createQuoteExecution(signal, quote(), assumptions);
    const noon = "2026-08-25T16:00:00.000Z";
    const pending = requestQuoteSessionClose(
      opened,
      noon,
      quote({ timestamp: noon, dataStatus: "HALTED" }),
      assumptions,
    );
    expect(pending.transitioned).toBe(true);
    expect(pending.state.status).toBe("CLOSE_PENDING");

    const repeated = requestQuoteSessionClose(
      pending.state,
      noon,
      quote({ timestamp: noon, dataStatus: "HALTED" }),
      assumptions,
    );
    expect(repeated.transitioned).toBe(false);
    expect(repeated.state).toEqual(pending.state);
  });

  it("resolves CLOSE_PENDING to CLOSED on the first later actionable quote", () => {
    const opened = createQuoteExecution(signal, quote(), assumptions);
    const noon = "2026-08-25T16:00:00.000Z";
    const pending = requestQuoteSessionClose(
      opened,
      noon,
      quote({ timestamp: noon, dataStatus: "HALTED" }),
      assumptions,
    ).state;
    const resolved = requestQuoteSessionClose(
      pending,
      noon,
      quote({ timestamp: "2026-08-25T16:05:00.000Z", bid: 10.2 }),
      assumptions,
    );
    expect(resolved.transitioned).toBe(true);
    expect(resolved.state.status).toBe("CLOSED");
    if (resolved.state.status === "CLOSED") {
      expect(resolved.state.exit.exitReason).toBe("SESSION_CLOSE_DELAYED");
    }
  });
});

describe("candle execution core idempotency", () => {
  it("drops already-processed or out-of-order candles before scanning", () => {
    const opened = createCandleExecution(signal, assumptions);
    const first = applyCandleFacts(opened, [candle()], assumptions);
    expect(first.transitioned).toBe(false);
    if (first.state.status === "OPEN") {
      expect(first.state.lastFactTimestamp).toBe("2026-08-25T14:02:00.000Z");
    }

    // Re-delivering the same bar (e.g. a reconciliation replay) must not
    // re-scan it or move the watermark backwards.
    const replay = applyCandleFacts(first.state, [candle()], assumptions);
    expect(replay).toEqual({ state: first.state, transitioned: false });
  });

  it("triggers exactly once even if the batch is redelivered after closing", () => {
    const opened = createCandleExecution(signal, assumptions);
    const triggering = [candle({ low: 9.4 })];
    const closed = applyCandleFacts(opened, triggering, assumptions);
    expect(closed.transitioned).toBe(true);
    expect(closed.state.status).toBe("CLOSED");

    const replay = applyCandleFacts(closed.state, triggering, assumptions);
    expect(replay).toEqual({ state: closed.state, transitioned: false });
  });

  it("moves OPEN to CLOSE_PENDING when the noon candle is not yet ingested, then closes once it is", () => {
    const opened = createCandleExecution(signal, assumptions);
    const pending = requestCandleSessionClose(opened, null, assumptions);
    expect(pending.transitioned).toBe(true);
    expect(pending.state.status).toBe("CLOSE_PENDING");

    const repeated = requestCandleSessionClose(
      pending.state,
      null,
      assumptions,
    );
    expect(repeated.transitioned).toBe(false);

    const noonCandle = candle({
      start: "2026-08-25T16:00:00.000Z",
      end: "2026-08-25T16:01:00.000Z",
      close: 10.2,
    });
    const resolved = requestCandleSessionClose(
      pending.state,
      noonCandle,
      assumptions,
    );
    expect(resolved.transitioned).toBe(true);
    expect(resolved.state.status).toBe("CLOSED");
  });

  it("excludes a partially elapsed entry candle starting before a mid-minute entry (F-02)", () => {
    // Mid-minute signal at 14:00:30
    const midMinuteSignal: SignalFact = {
      ...signal,
      signalTimestamp: "2026-08-25T14:00:30.000Z",
    };
    const opened = createCandleExecution(midMinuteSignal, assumptions);

    // Candle 1 spans 14:00:00 - 14:01:00 (started before entry). Low touches stop (9.0 <= 9.5).
    const overlappingBar: CandleFact = {
      start: "2026-08-25T14:00:00.000Z",
      end: "2026-08-25T14:01:00.000Z",
      open: 10.0,
      high: 10.1,
      low: 9.0,
      close: 9.8,
    };

    // The overlapping bar must be excluded from evaluation
    const result1 = applyCandleFacts(opened, [overlappingBar], assumptions);
    expect(result1.transitioned).toBe(false);
    expect(result1.state.status).toBe("OPEN");

    // Candle 2 spans 14:01:00 - 14:02:00 (starts after entry). Low touches stop.
    const postEntryBar: CandleFact = {
      start: "2026-08-25T14:01:00.000Z",
      end: "2026-08-25T14:02:00.000Z",
      open: 9.8,
      high: 9.9,
      low: 9.0,
      close: 9.1,
    };
    const result2 = applyCandleFacts(
      result1.state,
      [postEntryBar],
      assumptions,
    );
    expect(result2.transitioned).toBe(true);
    expect(result2.state.status).toBe("CLOSED");
    if (result2.state.status === "CLOSED") {
      expect(result2.state.exit.exitReason).toBe("STOP");
      expect(result2.state.exit.exitTime).toBe("2026-08-25T14:02:00.000Z");
    }
  });

  it("admits a candle starting exactly at the boundary entry time (F-02)", () => {
    const boundarySignal: SignalFact = {
      ...signal,
      signalTimestamp: "2026-08-25T14:01:00.000Z",
    };
    const opened = createCandleExecution(boundarySignal, assumptions);

    // Candle spans 14:01:00 - 14:02:00 (start matches entry time exactly)
    const boundaryBar: CandleFact = {
      start: "2026-08-25T14:01:00.000Z",
      end: "2026-08-25T14:02:00.000Z",
      open: 10.0,
      high: 10.1,
      low: 9.4,
      close: 9.5,
    };
    const result = applyCandleFacts(opened, [boundaryBar], assumptions);
    expect(result.transitioned).toBe(true);
    expect(result.state.status).toBe("CLOSED");
  });

  it("sorts unsorted candle batches and deduplicates duplicate bars (F-02)", () => {
    const opened = createCandleExecution(signal, assumptions);
    const bar1: CandleFact = {
      start: "2026-08-25T14:01:00.000Z",
      end: "2026-08-25T14:02:00.000Z",
      open: 10.0,
      high: 10.5,
      low: 9.9,
      close: 10.2,
    };
    const bar2: CandleFact = {
      start: "2026-08-25T14:02:00.000Z",
      end: "2026-08-25T14:03:00.000Z",
      open: 10.2,
      high: 11.2,
      low: 10.1,
      close: 11.1,
    };
    // Pass in reverse order with duplicates: [bar2, bar1, bar2]
    const result = applyCandleFacts(opened, [bar2, bar1, bar2], assumptions);
    expect(result.transitioned).toBe(true);
    expect(result.state.status).toBe("CLOSED");
    if (result.state.status === "CLOSED") {
      expect(result.state.exit.exitReason).toBe("TARGET");
      expect(result.state.exit.exitTime).toBe("2026-08-25T14:03:00.000Z");
    }
  });
});
