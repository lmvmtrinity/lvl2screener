import { describe, expect, it } from "vitest";
import { strategyParametersSchema } from "@tsx-scanner/contracts";
import {
  applyQuoteFact,
  createQuoteExecution,
  requestQuoteSessionClose,
  requestQuoteTimeStop,
} from "../src/paper-bot/execution-core.js";
import { regenerateSessionEvidence } from "../src/paper-bot/evidence-regeneration.js";
import type { PaperSignalObservation } from "../src/paper-bot/paper-bot-repository.js";
import type { AssumptionsSnapshot, QuoteFact } from "../src/paper-bot/types.js";

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
};
const signal = {
  entryReference: 10,
  stopReference: 9.5,
  targetReference: 11,
  atr14: 1,
  signalTimestamp: "2026-09-04T14:00:00.000Z",
};
const quote: QuoteFact = {
  timestamp: signal.signalTimestamp,
  bid: 9.99,
  ask: 10,
  bidSize: 100,
  askSize: 100,
  dataStatus: "REALTIME",
  actionable: true,
};

describe("audit completion invariants", () => {
  it("rejects malformed exit facts without poisoning the recovery watermark", () => {
    const initial = createQuoteExecution(signal, quote, assumptions);
    for (const invalid of [
      { ...quote, timestamp: "invalid", bid: 11, ask: 11.01 },
      { ...quote, timestamp: "2026-09-04T14:01:00Z", bid: 11, ask: 10 },
      { ...quote, timestamp: "2026-09-04T14:01:00Z", bid: -1 },
    ]) {
      expect(applyQuoteFact(initial, invalid, assumptions).state).toEqual(
        initial,
      );
      expect(requestQuoteTimeStop(initial, invalid, assumptions).state).toEqual(
        initial,
      );
    }
  });
  it("keeps zero-size exits open and settles only actual fills, with one round-trip fee", () => {
    const initial = createQuoteExecution(signal, quote, assumptions);
    const zero = applyQuoteFact(
      initial,
      {
        ...quote,
        timestamp: "2026-09-04T14:01:00Z",
        bid: 11,
        ask: 11.01,
        bidSize: 0,
      },
      assumptions,
    ).state;
    expect(zero.status).toBe("OPEN");
    const fact = {
      ...quote,
      timestamp: "2026-09-04T14:02:00Z",
      bid: 11,
      ask: 11.01,
      bidSize: 30,
    };
    const partial = applyQuoteFact(zero, fact, assumptions).state;
    expect(partial).toMatchObject({
      status: "OPEN",
      position: { shares: 100, remainingShares: 70 },
    });
    expect(applyQuoteFact(partial, fact, assumptions).transitioned).toBe(false);
    const restored = JSON.parse(JSON.stringify(partial));
    const closed = applyQuoteFact(
      restored,
      { ...fact, timestamp: "2026-09-04T14:03:00Z", bidSize: 100 },
      assumptions,
    ).state;
    expect(closed).toMatchObject({
      status: "CLOSED",
      position: { remainingShares: 0 },
      exit: { financials: { grossPnl: 100, netPnl: 99 } },
    });
  });

  it("latches an unfilled stop and exits remaining shares after a rebound", () => {
    const initial = createQuoteExecution(signal, quote, assumptions);
    const stopped = applyQuoteFact(
      initial,
      { ...quote, timestamp: "2026-09-04T14:01:00Z", bid: 9, bidSize: 0 },
      assumptions,
    ).state;
    const exit = applyQuoteFact(
      stopped,
      { ...quote, timestamp: "2026-09-04T14:02:00Z", bid: 10, ask: 10.01 },
      assumptions,
    ).state;
    expect(exit).toMatchObject({
      status: "CLOSED",
      exit: { exitReason: "STOP", financials: { netPnl: -1 } },
    });
  });

  it("retains partially closed session positions and rejects duplicate time-stop facts", () => {
    const opened = createQuoteExecution(signal, quote, assumptions);
    expect(requestQuoteTimeStop(opened, quote, assumptions).transitioned).toBe(
      false,
    );
    const boundary = "2026-09-04T20:00:00.000Z";
    const partial = requestQuoteSessionClose(
      opened,
      boundary,
      { ...quote, timestamp: boundary, bidSize: 25 },
      assumptions,
    ).state;
    expect(partial).toMatchObject({
      status: "CLOSE_PENDING",
      position: { remainingShares: 75 },
    });
    const finished = requestQuoteSessionClose(
      partial,
      boundary,
      { ...quote, timestamp: "2026-09-04T20:00:01Z" },
      assumptions,
    ).state;
    expect(finished.status).toBe("CLOSED");
  });

  it("preserves all stop policies through the shared profile contract", () => {
    for (const stopPolicy of [
      "HYBRID",
      "PATTERN_INVALIDATION",
      "NEAREST_SUPPORT",
    ]) {
      expect(strategyParametersSchema.parse({ stopPolicy }).stopPolicy).toBe(
        stopPolicy,
      );
    }
  });

  it("never executes excluded signals or certifies another symbol's history", () => {
    const observation = {
      ...signal,
      id: "excluded",
      instrumentId: "missing",
      marketId: "CA_TSX",
      eligibilityStatus: "BELOW_SCORE_CUTOFF",
    } as PaperSignalObservation;
    const input = {
      originalRunId: "old",
      sessionDate: "2026-09-04",
      marketId: "CA_TSX" as const,
      observations: [observation],
      assumptions,
      quotesByInstrument: new Map([["other", [quote]]]),
      candlesByInstrument: new Map([
        [
          "other",
          [
            {
              start: "2026-09-04T14:01:00Z",
              end: "2026-09-04T14:02:00Z",
              open: 10,
              high: 11,
              low: 10,
              close: 11,
            },
          ],
        ],
      ]),
    };
    expect(regenerateSessionEvidence(input).executions).toHaveLength(0);
    expect(
      regenerateSessionEvidence({
        ...input,
        observations: [{ ...observation, eligibilityStatus: "ELIGIBLE" }],
      }).reproducibility,
    ).not.toBe("REPRODUCIBLE");
  });
});
