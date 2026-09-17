import { describe, expect, it } from "vitest";
import type { FundedComparisonInputItem } from "@tsx-scanner/contracts";
import {
  buildUnionValuationGrid,
  reconstructComparisonValuation,
} from "../src/paper-bot/funded-comparison-valuation.js";
import {
  createFundedLedger,
  type LedgerEvent,
} from "../src/paper-bot/funded-ledger.js";

const sessionDate = "2026-09-15";
const open = `${sessionDate}T13:30:00.000Z`;
const entryAt = `${sessionDate}T14:30:00.000Z`;
const quoteAt = `${sessionDate}T14:31:00.000Z`;
const close = `${sessionDate}T20:00:00.000Z`;

function sharedItem(
  kind: "CLOCK" | "SIGNAL" | "QUOTE" | "CANCEL",
  at: string,
): FundedComparisonInputItem {
  if (kind === "CLOCK")
    return {
      kind: "SESSION_BOUNDARY",
      sessionDate,
      sessionStartAt: at,
      scheduledCloseAt: close,
      sessionTimezone: "America/Toronto",
    };
  if (kind === "SIGNAL")
    return {
      kind: "OPPORTUNITY",
      sourceOpportunityId: "source-1",
      sessionDate,
      sourceOrdinal: 1,
      sourceEventId: "event-1",
      setupInstanceId: "setup-1",
      instrumentId: "instrument-1",
      symbol: "SYM",
      profileConfigId: "profile-config-1",
      strategyKey: "ORB_RETEST",
      strategyVersion: "2026-09-01",
      score: 70,
      eligibilityStatus: "ELIGIBLE",
      eligibilityReason: null,
      signalTimestamp: at,
      signalSemanticsVersion: "signal-v1",
      observationFeatureVersion: "features-v1",
      entryReference: 10,
      stopReference: 9,
      targetReference: 12,
      atr14: 1,
      reasonCodes: [],
      sourceEventPayload: {},
      featureSnapshot: null,
      contexts: [],
    };
  if (kind === "QUOTE")
    return {
      kind: "QUOTE",
      instrumentId: "instrument-1",
      timestamp: at,
      bid: 10,
      ask: 10.02,
      bidSize: 500,
      askSize: 500,
      sizeUnit: "SHARES",
      sizeMultiplier: 1,
      dataStatus: "REALTIME",
      actionable: true,
      source: "QUESTRADE",
    };
  return {
    kind: "INVALIDATION",
    eventId: "invalidation-1",
    sourceOpportunityId: "source-1",
    at,
  };
}

const markOpen: LedgerEvent = {
  id: "mark-open",
  at: open,
  currency: "CAD",
  type: "MARK",
  instrumentId: "instrument-1",
  bid: 10,
};
const reserve: LedgerEvent = {
  id: "reserve",
  at: entryAt,
  currency: "CAD",
  type: "RESERVE",
  orderId: "order-1",
  debit: 1_001,
  risk: 101,
};
const buy: LedgerEvent = {
  id: "buy",
  at: entryAt,
  currency: "CAD",
  type: "BUY",
  orderId: "order-1",
  positionId: "position-1",
  instrumentId: "instrument-1",
  shares: 100,
  price: 10,
  fee: 1,
  stop: 9,
};
const markDown: LedgerEvent = {
  id: "mark-down",
  at: quoteAt,
  currency: "CAD",
  type: "MARK",
  instrumentId: "instrument-1",
  bid: 8,
};

function side(events: readonly LedgerEvent[]) {
  return {
    initialState: createFundedLedger("CAD", 25_000, sessionDate, open, 2_500),
    effects: events.map((event, index) => ({
      at: event.at,
      sequence: index + 1,
      event,
    })),
  };
}

describe("comparison union-grid valuation", () => {
  it("orders same-time shared items by the frozen causal precedence", () => {
    const grid = buildUnionValuationGrid({
      sharedInputs: [
        sharedItem("QUOTE", entryAt),
        sharedItem("SIGNAL", entryAt),
        sharedItem("CLOCK", entryAt),
        sharedItem("CANCEL", entryAt),
      ],
      championEffects: [],
      challengerEffects: [],
    });
    expect(
      grid.points
        .filter((point) => point.at === entryAt)
        .map((point) => point.causalKey.split("|")[1]),
    ).toEqual(["0", "1", "2", "3"]);
  });

  it("includes both sides' endogenous effect times and orders them by sequence", () => {
    const grid = buildUnionValuationGrid({
      sharedInputs: [sharedItem("CLOCK", open)],
      championEffects: [
        { at: entryAt, sequence: 2, event: reserve },
        { at: entryAt, sequence: 3, event: buy },
      ],
      challengerEffects: [{ at: quoteAt, sequence: 1, event: markDown }],
    });
    expect(grid.points.map((point) => `${point.owner}@${point.at}`)).toEqual([
      `SHARED@${open}`,
      `CHAMPION@${entryAt}`,
      `CHAMPION@${entryAt}`,
      `CHALLENGER@${quoteAt}`,
    ]);
    const championKeys = grid.points
      .filter((point) => point.owner === "CHAMPION")
      .map((point) => point.causalKey);
    expect(championKeys[0]! < championKeys[1]!).toBe(true);
  });

  it("reconstructs mark-to-market equity and union-grid drawdown", () => {
    const valuation = reconstructComparisonValuation({
      sharedInputs: [
        sharedItem("CLOCK", open),
        sharedItem("SIGNAL", entryAt),
        sharedItem("QUOTE", quoteAt),
      ],
      champion: side([markOpen, reserve, buy, markDown]),
      challenger: side([markOpen, reserve, buy, markDown]),
      initialCash: 25_000,
    });
    expect(valuation.champion.status).toBe("PROVEN");
    const equityAtEntry = valuation.champion.equityPoints.find(
      (point) => point.at === entryAt,
    );
    expect(equityAtEntry?.equity).toBe(24_999);
    const equityAfterMark = valuation.champion.equityPoints.find(
      (point) => point.at === quoteAt,
    );
    expect(equityAfterMark?.equity).toBe(24_799);
    // Peak 25,000 at the session boundary, then trough 24,799 after the mark:
    // the grid spans the union of shared and endogenous times.
    expect(valuation.champion.maxDrawdown).toBe(201);
    expect(valuation.champion.maxDrawdownPctOfInitialCash).toBeCloseTo(
      201 / 25_000,
      8,
    );
  });

  it("fails STALE_MARK when an open position has no fresh mark", () => {
    const valuation = reconstructComparisonValuation({
      sharedInputs: [
        sharedItem("CLOCK", open),
        sharedItem("SIGNAL", entryAt),
        sharedItem("QUOTE", `${sessionDate}T14:31:31.000Z`),
      ],
      champion: side([markOpen, reserve, buy]),
      challenger: side([markOpen, reserve, buy]),
      initialCash: 25_000,
    });
    expect(valuation.champion.status).toBe("UNAVAILABLE");
    expect(valuation.champion.reason).toBe("STALE_MARK");
    expect(valuation.champion.equityPoints).toEqual([]);
    expect(valuation.champion.maxDrawdown).toBeNull();
  });

  it("fails UNPROVABLE_CAUSAL_ORDER for an unsequenced effect", () => {
    const valuation = reconstructComparisonValuation({
      sharedInputs: [sharedItem("CLOCK", open)],
      champion: {
        initialState: createFundedLedger(
          "CAD",
          25_000,
          sessionDate,
          open,
          2_500,
        ),
        effects: [{ at: entryAt, sequence: 0, event: reserve }],
      },
      challenger: side([]),
      initialCash: 25_000,
    });
    expect(valuation.champion.reason).toBe("UNPROVABLE_CAUSAL_ORDER");
    expect(valuation.challenger.reason).toBe("UNPROVABLE_CAUSAL_ORDER");
  });

  it("is deterministic for identical inputs", () => {
    const build = () =>
      reconstructComparisonValuation({
        sharedInputs: [
          sharedItem("CLOCK", open),
          sharedItem("SIGNAL", entryAt),
        ],
        champion: side([markOpen, reserve, buy]),
        challenger: side([markOpen, reserve, buy]),
        initialCash: 25_000,
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
