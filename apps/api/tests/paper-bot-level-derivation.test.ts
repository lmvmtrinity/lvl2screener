import { describe, expect, it } from "vitest";
import {
  deriveStopAndTarget,
  sizeEntry,
} from "../src/paper-bot/level-derivation.js";
import type {
  AssumptionsSnapshot,
  SignalFact,
} from "../src/paper-bot/types.js";

const baseAssumptions: AssumptionsSnapshot = {
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

const baseSignal: SignalFact = {
  entryReference: 10,
  stopReference: 9.5,
  targetReference: 11,
  atr14: 0.25,
  signalTimestamp: "2026-08-25T14:00:00.000Z",
};

describe("deriveStopAndTarget", () => {
  it("uses the structural stop and target references", () => {
    expect(deriveStopAndTarget(baseSignal, baseAssumptions)).toEqual({
      ok: true,
      stop: 9.5,
      target: 11,
    });
  });

  it("rejects MISSING_REFERENCE when entry reference is absent", () => {
    expect(
      deriveStopAndTarget(
        { ...baseSignal, entryReference: null },
        baseAssumptions,
      ),
    ).toEqual({ ok: false, noFillReason: "MISSING_REFERENCE" });
  });

  it("rejects MISSING_REFERENCE when the structural stop is absent", () => {
    expect(
      deriveStopAndTarget(
        { ...baseSignal, stopReference: null },
        baseAssumptions,
      ),
    ).toEqual({ ok: false, noFillReason: "MISSING_REFERENCE" });
  });

  it("derives an ATR stop when configured, ignoring the structural reference", () => {
    const assumptions: AssumptionsSnapshot = {
      ...baseAssumptions,
      stopMethod: "ATR",
    };
    expect(deriveStopAndTarget(baseSignal, assumptions)).toEqual({
      ok: true,
      stop: 9.5,
      target: 11,
    });
  });

  it("rejects MISSING_REFERENCE for an ATR stop when ATR is unavailable", () => {
    const assumptions: AssumptionsSnapshot = {
      ...baseAssumptions,
      stopMethod: "ATR",
    };
    expect(
      deriveStopAndTarget({ ...baseSignal, atr14: null }, assumptions),
    ).toEqual({ ok: false, noFillReason: "MISSING_REFERENCE" });
  });

  it("overrides the target with a configured reward/risk ratio", () => {
    const assumptions: AssumptionsSnapshot = {
      ...baseAssumptions,
      rewardRiskRatio: 3,
    };
    expect(deriveStopAndTarget(baseSignal, assumptions)).toEqual({
      ok: true,
      stop: 9.5,
      target: 11.5,
    });
  });

  it("rejects MISSING_REFERENCE when no target reference or ratio is available", () => {
    expect(
      deriveStopAndTarget(
        { ...baseSignal, targetReference: null },
        baseAssumptions,
      ),
    ).toEqual({ ok: false, noFillReason: "MISSING_REFERENCE" });
  });
});

describe("sizeEntry", () => {
  const base = {
    entryPrice: 10,
    stop: 9.5,
    target: 11,
    positionSize: 1_000,
    fixedCosts: 1,
  };

  it("sizes shares by floor(positionSize / entryPrice) and computes initial risk", () => {
    expect(sizeEntry(base)).toEqual({
      ok: true,
      executableEntryPrice: 10,
      shares: 100,
      initialRisk: 50,
      sizing: {
        requestedRisk: 50,
        estimatedRisk: 50,
        costInclusiveLossPerShare: 0.5,
        uncappedShares: 100,
        shares: 100,
        unfilledShares: 0,
        appliedCaps: ["POSITION_NOTIONAL"],
      },
    });
  });

  it("sizes from the dollar-risk budget and reports the cap that bound", () => {
    const result = sizeEntry({ ...base, riskBudget: 26 });
    expect(result).toMatchObject({
      ok: true,
      shares: 50,
      sizing: {
        requestedRisk: 26,
        estimatedRisk: 25,
        uncappedShares: 50,
        appliedCaps: ["RISK_BUDGET"],
      },
    });
  });

  it("charges the modeled stop exit, not the stop trigger, against the budget", () => {
    // A stop that fills 1c lower buys fewer shares for the same budget.
    expect(
      sizeEntry({ ...base, riskBudget: 26, stopExitPrice: 9.49 }),
    ).toMatchObject({ ok: true, shares: 49 });
  });

  it("applies notional, displayed-size, exposure, and portfolio-risk caps in order", () => {
    const result = sizeEntry({
      ...base,
      riskBudget: 1_000,
      maxNotional: 800,
      context: {
        displayedSize: 60,
        maxDisplayedSizeParticipation: 0.5,
        openSymbolNotional: 100,
        maxSymbolNotional: 400,
        openSectorNotional: 0,
        maxSectorNotional: 10_000,
        openPortfolioRisk: 0,
        maxPortfolioRisk: 1_000,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      shares: 30,
      sizing: {
        appliedCaps: [
          "RISK_BUDGET",
          "POSITION_NOTIONAL",
          "MAX_NOTIONAL",
          "DISPLAYED_SIZE_PARTICIPATION",
        ],
      },
    });
  });

  it("caps four normalized board lots at 100 shares under 25% participation", () => {
    expect(
      sizeEntry({
        ...base,
        positionSize: 100_000,
        riskBudget: 100_000,
        context: {
          displayedSize: 400,
          maxDisplayedSizeParticipation: 0.25,
        },
      }),
    ).toMatchObject({ ok: true, shares: 100 });
  });

  it("keeps an explicit four-share quote as four shares before participation", () => {
    expect(
      sizeEntry({
        ...base,
        positionSize: 100_000,
        riskBudget: 100_000,
        context: {
          displayedSize: 4,
          maxDisplayedSizeParticipation: 0.25,
        },
      }),
    ).toMatchObject({ ok: true, shares: 1 });
  });

  it("rejects SHARES_BELOW_ONE when an exposure cap leaves no room", () => {
    expect(
      sizeEntry({
        ...base,
        context: { openSymbolNotional: 400, maxSymbolNotional: 400 },
      }),
    ).toEqual({ ok: false, noFillReason: "SHARES_BELOW_ONE" });
  });

  it("rejects SHARES_BELOW_ONE when position size cannot buy one share", () => {
    expect(sizeEntry({ ...base, positionSize: 5 })).toEqual({
      ok: false,
      noFillReason: "SHARES_BELOW_ONE",
    });
  });

  it("rejects EXECUTABLE_PRICE_OUTSIDE_LEVELS when entry is at or below stop", () => {
    expect(sizeEntry({ ...base, entryPrice: 9 })).toEqual({
      ok: false,
      noFillReason: "EXECUTABLE_PRICE_OUTSIDE_LEVELS",
    });
  });

  it("rejects EXECUTABLE_PRICE_OUTSIDE_LEVELS when entry is at or above target", () => {
    expect(sizeEntry({ ...base, entryPrice: 11 })).toEqual({
      ok: false,
      noFillReason: "EXECUTABLE_PRICE_OUTSIDE_LEVELS",
    });
  });

  it("no longer judges economics: an unpayable target still sizes", () => {
    // Target viability is the economics gate's decision, and it must be
    // reported as REJECTED_ECONOMICS rather than hidden inside sizing.
    expect(sizeEntry({ ...base, target: 10.01, fixedCosts: 2 })).toMatchObject({
      ok: true,
      shares: 100,
    });
  });
});
