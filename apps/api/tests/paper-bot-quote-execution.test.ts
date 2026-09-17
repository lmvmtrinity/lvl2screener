import { normalizedQuoteSize } from "../src/paper-bot/normalized-quote-size.js";
import { describe, expect, it } from "vitest";
import {
  classifyQuoteAvailability,
  evaluateQuoteEntry,
  evaluateQuoteExit,
  resolveSessionClose,
} from "../src/paper-bot/quote-execution.js";
import type {
  AssumptionsSnapshot,
  OpenPosition,
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

const actionableQuote = (overrides: Partial<QuoteFact> = {}): QuoteFact => ({
  timestamp: "2026-08-25T14:00:00.000Z",
  bid: 9.99,
  ask: Math.max(10, (overrides.bid ?? 9.99) + 0.01),
  bidSize: 500,
  askSize: 500,
  dataStatus: "REALTIME",
  actionable: true,
  ...overrides,
});

describe("classifyQuoteAvailability", () => {
  it("returns MISSING_QUOTE for a null quote", () => {
    expect(classifyQuoteAvailability(null, signal.signalTimestamp, 30)).toBe(
      "MISSING_QUOTE",
    );
  });

  it("fails closed when displayed-size semantics are not confirmed shares", () => {
    expect(
      classifyQuoteAvailability(
        { ...actionableQuote(), sizeUnit: "BOARD_LOTS" },
        signal.signalTimestamp,
        30,
      ),
    ).toBe("UNKNOWN_QUOTE_SIZE");
  });

  it("returns HALTED for a halted quote", () => {
    expect(
      classifyQuoteAvailability(
        actionableQuote({ dataStatus: "HALTED" }),
        signal.signalTimestamp,
        30,
      ),
    ).toBe("HALTED");
  });

  it("returns DELAYED for a non-actionable or delayed quote", () => {
    expect(
      classifyQuoteAvailability(
        actionableQuote({ dataStatus: "DELAYED" }),
        signal.signalTimestamp,
        30,
      ),
    ).toBe("DELAYED");
    expect(
      classifyQuoteAvailability(
        actionableQuote({ actionable: false }),
        signal.signalTimestamp,
        30,
      ),
    ).toBe("DELAYED");
  });

  it("returns STALE when the quote is older than the max age", () => {
    expect(
      classifyQuoteAvailability(
        actionableQuote({ timestamp: "2026-08-25T13:59:00.000Z" }),
        signal.signalTimestamp,
        30,
      ),
    ).toBe("STALE");
  });

  it("returns null for an actionable, fresh quote", () => {
    expect(
      classifyQuoteAvailability(actionableQuote(), signal.signalTimestamp, 30),
    ).toBeNull();
  });
});

describe("evaluateQuoteEntry", () => {
  it("opens a position from the decision-time ask, with entry slippage applied", () => {
    const result = evaluateQuoteEntry(signal, actionableQuote(), assumptions);
    expect(result).toMatchObject({
      status: "OPEN",
      entryTime: "2026-08-25T14:00:00.000Z",
      stop: 9.5,
      target: 11,
      shares: 99,
      initialRisk: 50.49,
      executableEntryPrice: 10.01,
      entrySizeCoverage: 500 / 99,
      entryMarketSnapshot: {
        bid: 9.99,
        ask: 10,
        bidSize: 500,
        askSize: 500,
        spread: 10 - 9.99,
        quoteTimestamp: "2026-08-25T14:00:00.000Z",
        dataStatus: "REALTIME",
        stalenessSeconds: 0,
      },
    });
  });

  it("records NO_FILL with HALTED when the decision-time quote is halted", () => {
    const result = evaluateQuoteEntry(
      signal,
      actionableQuote({ dataStatus: "HALTED" }),
      assumptions,
    );
    expect(result.status).toBe("NO_FILL");
    expect((result as { noFillReason: string }).noFillReason).toBe("HALTED");
  });

  it("records NO_FILL with MISSING_QUOTE when there is no decision-time quote", () => {
    const result = evaluateQuoteEntry(signal, null, assumptions);
    expect(result).toEqual({
      status: "NO_FILL",
      noFillReason: "MISSING_QUOTE",
      entryMarketSnapshot: null,
    });
  });

  it("records NO_FILL with MISSING_REFERENCE when a required level is absent", () => {
    const result = evaluateQuoteEntry(
      { ...signal, stopReference: null },
      actionableQuote(),
      assumptions,
    );
    expect((result as { noFillReason: string }).noFillReason).toBe(
      "MISSING_REFERENCE",
    );
  });

  it("records NO_FILL with SHARES_BELOW_ONE when position size is too small", () => {
    const result = evaluateQuoteEntry(signal, actionableQuote(), {
      ...assumptions,
      positionSize: 5,
    });
    expect((result as { noFillReason: string }).noFillReason).toBe(
      "SHARES_BELOW_ONE",
    );
  });
});

const openPosition: OpenPosition = {
  entryPrice: 10.01,
  entryTime: "2026-08-25T14:00:00.000Z",
  stop: 9.5,
  target: 11,
  shares: 100,
  initialRisk: 50,
};

describe("evaluateQuoteExit", () => {
  it("uses normalized provider shares for a capacity-limited stop without multiplying twice", () => {
    const quote = actionableQuote({
      bid: 9,
      bidSize: 50,
      ...normalizedQuoteSize("BOARD_LOTS", 100),
    });
    const result = evaluateQuoteExit(
      { ...openPosition, executionMode: "CAPACITY_CONSTRAINED" },
      quote,
      assumptions,
    );
    expect(result).toMatchObject({
      triggered: true,
      exitReason: "STOP",
      filledShares: 50,
      unfilledShares: 50,
    });
  });

  it.each([
    ["UNKNOWN", 100],
    ["BOARD_LOTS", null],
    ["BOARD_LOTS", 0],
    ["SHARES", 100],
  ])("rejects unverified normalized metadata %s/%s", (unit, multiplier) => {
    const quote = actionableQuote({
      bid: 9,
      ...normalizedQuoteSize(unit as string, multiplier),
    });
    expect(evaluateQuoteExit(openPosition, quote, assumptions)).toEqual({
      triggered: false,
    });
  });
  it.each(["HALTED", "DELAYED"] as const)(
    "does not trigger an exit from a %s book",
    (dataStatus) => {
      // The bid is deep below the stop, so only the actionability gate can
      // keep this from closing. A halted or delayed print is not a price the
      // simulator may transact against.
      const result = evaluateQuoteExit(
        openPosition,
        actionableQuote({
          timestamp: "2026-08-25T14:30:00.000Z",
          bid: 1,
          dataStatus,
          actionable: false,
        }),
        assumptions,
      );
      expect(result).toEqual({ triggered: false });
    },
  );

  it("does not trigger an exit from a non-actionable REALTIME book", () => {
    const result = evaluateQuoteExit(
      openPosition,
      actionableQuote({
        timestamp: "2026-08-25T14:30:00.000Z",
        bid: 1,
        actionable: false,
      }),
      assumptions,
    );
    expect(result).toEqual({ triggered: false });
  });

  it("fills the target conservatively with no additional slippage", () => {
    const result = evaluateQuoteExit(
      openPosition,
      actionableQuote({ timestamp: "2026-08-25T14:30:00.000Z", bid: 11.05 }),
      assumptions,
    );
    expect(result).toEqual({
      filledShares: 100,
      unfilledShares: 0,
      triggered: true,
      exitReason: "TARGET",
      exitTime: "2026-08-25T14:30:00.000Z",
      exitSizeCoverage: 5,
      exitMarketSnapshot: expect.objectContaining({ bid: 11.05 }),
      financials: {
        exitPrice: 11,
        grossPnl: 99,
        netPnl: 98,
        rMultiple: 1.96,
      },
      sessionCloseDelayMs: null,
    });
  });

  it("fills the stop with exit slippage applied", () => {
    const result = evaluateQuoteExit(
      openPosition,
      actionableQuote({ timestamp: "2026-08-25T14:30:00.000Z", bid: 9.4 }),
      assumptions,
    );
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.exitReason).toBe("STOP");
      expect(result.financials.exitPrice).toBe(9.3906);
    }
  });

  it("does not trigger while price remains between stop and target", () => {
    const result = evaluateQuoteExit(
      openPosition,
      actionableQuote({ timestamp: "2026-08-25T14:30:00.000Z", bid: 10.2 }),
      assumptions,
    );
    expect(result).toEqual({ triggered: false });
  });
});

describe("resolveSessionClose", () => {
  const noon = "2026-08-25T16:00:00.000Z";

  it("closes immediately with SESSION_CLOSE when the boundary quote is actionable", () => {
    const result = resolveSessionClose(
      openPosition,
      actionableQuote({ timestamp: noon, bid: 10.2 }),
      noon,
      assumptions,
    );
    expect(result.status).toBe("CLOSED");
    expect(result.exit?.exitReason).toBe("SESSION_CLOSE");
    expect(result.exit?.sessionCloseDelayMs).toBeNull();
  });

  it("remains CLOSE_PENDING when no actionable quote is available at the boundary", () => {
    const result = resolveSessionClose(
      openPosition,
      actionableQuote({ timestamp: noon, dataStatus: "HALTED" }),
      noon,
      assumptions,
    );
    expect(result).toEqual({ status: "CLOSE_PENDING" });
  });

  it("resolves a later actionable quote as SESSION_CLOSE_DELAYED with the elapsed duration", () => {
    const laterTimestamp = "2026-08-25T16:05:00.000Z";
    const result = resolveSessionClose(
      openPosition,
      actionableQuote({ timestamp: laterTimestamp, bid: 10.2 }),
      noon,
      assumptions,
    );
    expect(result.status).toBe("CLOSED");
    expect(result.exit?.exitReason).toBe("SESSION_CLOSE_DELAYED");
    expect(result.exit?.sessionCloseDelayMs).toBe(5 * 60 * 1000);
  });
});

describe("Phase C: timing provenance and execution realism (F-05)", () => {
  it("ensures simulated fill time and entryTime never precede signal timestamp", () => {
    const priorQuote = actionableQuote({
      timestamp: "2026-08-25T13:59:58.000Z",
    });
    const laterSignal: SignalFact = {
      ...signal,
      signalTimestamp: "2026-08-25T14:00:01.000Z",
    };

    const result = evaluateQuoteEntry(laterSignal, priorQuote, assumptions);
    expect(result.status).toBe("OPEN");
    if (result.status === "OPEN") {
      expect(result.quoteTime).toBe("2026-08-25T13:59:58.000Z");
      expect(result.signalTime).toBe("2026-08-25T14:00:01.000Z");
      expect(result.entryTime).toBe("2026-08-25T14:00:01.000Z");
      expect(result.fillTime).toBe("2026-08-25T14:00:01.000Z");
      expect(result.entryMarketSnapshot.fillTimestamp).toBe(
        "2026-08-25T14:00:01.000Z",
      );
    }
  });

  it("refuses timestamp-only latency without an executable future quote", () => {
    expect(() =>
      evaluateQuoteEntry(signal, actionableQuote(), {
        ...assumptions,
        latencyMs: 200,
      }),
    ).toThrow("Non-zero latency is unsupported");
  });

  it("enforces capacity constraints: caps position size to displayed liquidity and tracks unfilled shares", () => {
    const shallowQuote = actionableQuote({ askSize: 40 });
    // In UNCONSTRAINED mode (research projection), requested shares (99) fill fully with low coverage
    const unconstrainedResult = evaluateQuoteEntry(
      signal,
      shallowQuote,
      assumptions,
      { executionMode: "UNCONSTRAINED" },
    );
    expect(unconstrainedResult.status).toBe("OPEN");
    if (unconstrainedResult.status === "OPEN") {
      expect(unconstrainedResult.shares).toBe(99);
      expect(unconstrainedResult.entrySizeCoverage).toBeCloseTo(40 / 99, 4);
      expect(unconstrainedResult.sizing.unfilledShares).toBe(0);
    }

    // In CAPACITY_CONSTRAINED mode (portfolio simulation), position cannot exceed displayed liquidity
    const constrainedResult = evaluateQuoteEntry(
      signal,
      shallowQuote,
      assumptions,
      { executionMode: "CAPACITY_CONSTRAINED" },
    );
    expect(constrainedResult.status).toBe("OPEN");
    if (constrainedResult.status === "OPEN") {
      expect(constrainedResult.shares).toBe(40);
      expect(constrainedResult.sizing.unfilledShares).toBe(59);
      expect(constrainedResult.sizing.appliedCaps).toContain(
        "DISPLAYED_SIZE_PARTICIPATION",
      );
      expect(constrainedResult.entrySizeCoverage).toBe(1);
    }
  });

  it("rejects entry with SHARES_BELOW_ONE in capacity-constrained mode when displayed size is zero", () => {
    const zeroLiquidityQuote = actionableQuote({ askSize: 0 });
    const result = evaluateQuoteEntry(signal, zeroLiquidityQuote, assumptions, {
      executionMode: "CAPACITY_CONSTRAINED",
    });
    expect(result.status).toBe("NO_FILL");
    if (result.status === "NO_FILL") {
      expect(result.noFillReason).toBe("SHARES_BELOW_ONE");
    }
  });

  it("records unfilledShares upon exit when bid size is smaller than position shares", () => {
    const openPos: OpenPosition = {
      entryPrice: 10,
      entryTime: "2026-08-25T14:00:00.000Z",
      stop: 9.5,
      target: 11,
      shares: 100,
      initialRisk: 50,
      executionMode: "CAPACITY_CONSTRAINED",
    };
    const thinExitQuote = actionableQuote({
      timestamp: "2026-08-25T14:15:00.000Z",
      bid: 11.05,
      bidSize: 45,
    });
    const result = evaluateQuoteExit(openPos, thinExitQuote, assumptions);
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.exitReason).toBe("TARGET");
      expect(result.exitSizeCoverage).toBe(45 / 100);
      expect(result.unfilledShares).toBe(55);
    }
  });
});
