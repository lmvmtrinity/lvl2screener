import { describe, expect, it } from "vitest";
import {
  evaluateCandleBars,
  evaluateCandleEntry,
  resolveCandleSessionClose,
} from "../src/paper-bot/candle-execution.js";
import type {
  AssumptionsSnapshot,
  CandleFact,
  CandleOpenPosition,
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

const candle = (overrides: Partial<CandleFact> = {}): CandleFact => ({
  start: "2026-08-25T14:01:00.000Z",
  end: "2026-08-25T14:02:00.000Z",
  open: 10,
  high: 10.1,
  low: 9.9,
  close: 10.05,
  ...overrides,
});

describe("evaluateCandleEntry", () => {
  it("opens a synthetic position from the entry reference plus slippage, no quote required", () => {
    const result = evaluateCandleEntry(signal, assumptions);
    expect(result).toMatchObject({
      status: "OPEN",
      entryTime: "2026-08-25T14:00:00.000Z",
      stop: 9.5,
      target: 11,
      shares: 99,
      initialRisk: 50.49,
      syntheticEntryPrice: 10.01,
    });
  });

  it("records NO_FILL with no market snapshot when a required level is absent", () => {
    const result = evaluateCandleEntry(
      { ...signal, targetReference: null },
      assumptions,
    );
    expect(result).toEqual({
      status: "NO_FILL",
      noFillReason: "MISSING_REFERENCE",
      entryMarketSnapshot: null,
    });
  });
});

const position: CandleOpenPosition = {
  entryPrice: 10.01,
  entryTime: "2026-08-25T14:00:00.000Z",
  stop: 9.5,
  target: 11,
  shares: 100,
  initialRisk: 50,
};

describe("evaluateCandleBars", () => {
  it("fills the target at the exact target price with no exit slippage", () => {
    const result = evaluateCandleBars(
      position,
      [candle({ high: 11.2 })],
      assumptions,
    );
    expect(result).toEqual({
      triggered: true,
      exitReason: "TARGET",
      exitTime: "2026-08-25T14:02:00.000Z",
      financials: { exitPrice: 11, grossPnl: 99, netPnl: 98, rMultiple: 1.96 },
    });
  });

  it("fills the stop with exit slippage applied", () => {
    const result = evaluateCandleBars(
      position,
      [candle({ low: 9.4 })],
      assumptions,
    );
    expect(result).toEqual({
      triggered: true,
      exitReason: "STOP",
      exitTime: "2026-08-25T14:02:00.000Z",
      financials: {
        exitPrice: 9.4905,
        grossPnl: -51.95,
        netPnl: -52.95,
        rMultiple: -1.059,
      },
    });
  });

  it("fills an adverse gap-through stop at the opening price minus slippage rather than the stop", () => {
    const result = evaluateCandleBars(
      position,
      [candle({ open: 8.0, high: 8.5, low: 7.5, close: 8.0 })],
      assumptions,
    );
    expect(result).toEqual({
      triggered: true,
      exitReason: "STOP",
      exitTime: "2026-08-25T14:02:00.000Z",
      financials: {
        exitPrice: 7.992,
        grossPnl: -201.8,
        netPnl: -202.8,
        rMultiple: -4.056,
      },
    });
  });

  it("fills an exact-stop open at the stop price with slippage applied", () => {
    const result = evaluateCandleBars(
      position,
      [candle({ open: 9.5, high: 9.6, low: 9.3, close: 9.4 })],
      assumptions,
    );
    expect(result).toEqual({
      triggered: true,
      exitReason: "STOP",
      exitTime: "2026-08-25T14:02:00.000Z",
      financials: {
        exitPrice: 9.4905,
        grossPnl: -51.95,
        netPnl: -52.95,
        rMultiple: -1.059,
      },
    });
  });

  it("resolves a same-bar stop/target collision to STOP", () => {
    const result = evaluateCandleBars(
      position,
      [candle({ low: 9.4, high: 11.2 })],
      assumptions,
    );
    expect(result.triggered).toBe(true);
    if (result.triggered) expect(result.exitReason).toBe("STOP");
  });

  it("does not trigger when price stays between stop and target", () => {
    const result = evaluateCandleBars(position, [candle()], assumptions);
    expect(result).toEqual({ triggered: false });
  });

  it("triggers on the first candle in sequence that crosses a level", () => {
    const result = evaluateCandleBars(
      position,
      [
        candle(),
        candle({
          start: "2026-08-25T14:02:00.000Z",
          end: "2026-08-25T14:03:00.000Z",
          high: 11.5,
        }),
      ],
      assumptions,
    );
    expect(result.triggered).toBe(true);
    if (result.triggered)
      expect(result.exitTime).toBe("2026-08-25T14:03:00.000Z");
  });
});

describe("resolveCandleSessionClose", () => {
  it("remains CLOSE_PENDING when the noon candle has not been ingested yet", () => {
    expect(resolveCandleSessionClose(position, null, assumptions)).toEqual({
      status: "CLOSE_PENDING",
    });
  });

  it("closes at the completed noon candle's close price with exit slippage applied", () => {
    const noonCandle = candle({
      start: "2026-08-25T16:00:00.000Z",
      end: "2026-08-25T16:01:00.000Z",
      close: 10.2,
    });
    const result = resolveCandleSessionClose(position, noonCandle, assumptions);
    expect(result.status).toBe("CLOSED");
    expect(result.exit).toEqual({
      triggered: true,
      exitReason: "SESSION_CLOSE",
      exitTime: "2026-08-25T16:01:00.000Z",
      financials: {
        exitPrice: 10.1898,
        grossPnl: 17.98,
        netPnl: 16.98,
        rMultiple: 0.3396,
      },
    });
  });
});
