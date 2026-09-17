import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ECONOMICS_POLICY_VERSION,
  evaluateEconomics,
  tickSize,
} from "../src/paper-bot/economics.js";
import { evaluateCandleEntry } from "../src/paper-bot/candle-execution.js";
import { evaluateQuoteEntry } from "../src/paper-bot/quote-execution.js";
import type {
  AssumptionsSnapshot,
  EconomicsGates,
  QuoteFact,
  SignalFact,
} from "../src/paper-bot/types.js";

const gates: EconomicsGates = {
  minNetRewardRisk: 1,
  minStopFrictionMultiple: 2,
  minTargetFrictionMultiple: 3,
  maxSpreadPct: 0.5,
};

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 10,
  feePerTrade: 0,
  costs: {
    entryCommission: 0,
    exitCommission: 0,
    estimatedRegulatoryFees: 0,
    slippageBps: 10,
    currency: "CAD",
    brokerPricingVersion: "questrade-ca-equities-2026-09-01",
  },
  riskBudget: 100,
  maxNotional: 1_000,
  economics: gates,
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
  ask: 10,
  bidSize: 500,
  askSize: 500,
  dataStatus: "REALTIME",
  actionable: true,
  ...overrides,
});

describe("tickSize", () => {
  it("uses half-cent increments below fifty cents and cents at or above", () => {
    expect(tickSize(0.49)).toBe(0.005);
    expect(tickSize(0.5)).toBe(0.01);
    expect(tickSize(42)).toBe(0.01);
  });

  it("uses the US penny policy even below fifty cents", () => {
    expect(tickSize(0.49, "US_EQUITIES")).toBe(0.01);
    expect(tickSize(42, "US_EQUITIES")).toBe(0.01);
    expect(() => tickSize(0, "US_EQUITIES")).toThrow("invalid price");
  });
});

describe("evaluateEconomics", () => {
  const base = {
    executableEntryPrice: 10,
    stop: 9.5,
    target: 11,
    shares: 100,
    spread: 0.01,
    assumptions,
  };

  it("measures distances, exits, and cost-inclusive reward/risk", () => {
    const economics = evaluateEconomics(base);
    expect(economics.policyVersion).toBe(ECONOMICS_POLICY_VERSION);
    expect(economics.expectedTargetExitValue).toBe(1_100);
    // The stop exit is charged 10bps of slippage below the trigger.
    expect(economics.conservativeStopExitPrice).toBe(9.4905);
    expect(economics.expectedTargetNetPnl).toBe(100);
    expect(economics.expectedStopNetPnl).toBe(-50.95);
    expect(economics.netRewardRisk).toBeCloseTo(1.9627, 3);
    expect(economics.stopDistance.dollars).toBe(0.5);
    expect(economics.stopDistance.ticks).toBe(50);
    expect(economics.stopDistance.percent).toBe(5);
    expect(economics.stopDistance.spreadMultiples).toBe(50);
    expect(economics.spreadPct).toBe(0.1);
    expect(economics.rejections).toEqual([]);
  });

  it("uses the selected market tick increment in its immutable measures", () => {
    const economics = evaluateEconomics({
      ...base,
      marketId: "US_EQUITIES",
      executableEntryPrice: 0.49,
      stop: 0.47,
      target: 0.51,
    });
    expect(economics.stopDistance.ticks).toBe(2);
    expect(economics.targetDistance.ticks).toBe(2);
  });

  it("reports a null spread multiple when there is no book (candle model)", () => {
    const economics = evaluateEconomics({ ...base, spread: null });
    expect(economics.spread).toBeNull();
    expect(economics.spreadPct).toBeNull();
    expect(economics.stopDistance.spreadMultiples).toBeNull();
    expect(economics.stopDistance.frictionMultiples).toBeGreaterThan(0);
  });

  it("rejects a target that cannot cover round-trip friction", () => {
    const economics = evaluateEconomics({
      ...base,
      target: 10.001,
      assumptions: {
        ...assumptions,
        feePerTrade: 5,
        costs: { ...assumptions.costs!, exitCommission: 5 },
      },
    });
    expect(economics.rejections[0]).toBe("NET_TARGET_NON_POSITIVE");
  });

  it("rejects a spread that costs more than the configured maximum", () => {
    const economics = evaluateEconomics({ ...base, spread: 0.2 });
    expect(economics.rejections).toContain("SPREAD_COST_TOO_HIGH");
  });

  it("rejects stop and target distances that sit inside modeled friction", () => {
    const economics = evaluateEconomics({
      ...base,
      stop: 9.99,
      target: 10.02,
      spread: 0.01,
    });
    expect(economics.rejections).toContain("STOP_DISTANCE_TOO_SMALL");
    expect(economics.rejections).toContain("TARGET_DISTANCE_TOO_SMALL");
  });

  it("rejects a cost-inclusive reward/risk below the configured floor", () => {
    const economics = evaluateEconomics({ ...base, target: 10.3 });
    expect(economics.netRewardRisk).toBeLessThan(1);
    expect(economics.rejections).toEqual(["NET_REWARD_RISK_TOO_LOW"]);
  });

  it("applies only the mandatory invariant when a run configured no gates", () => {
    const legacy = evaluateEconomics({
      ...base,
      target: 10.3,
      assumptions: { ...assumptions, economics: undefined },
    });
    expect(legacy.rejections).toEqual([]);
  });

  it("persists the thresholds that produced the decision", () => {
    expect(evaluateEconomics(base).gates).toEqual(gates);
  });
});

describe("economics gating of entries", () => {
  it("declines a quote entry as REJECTED_ECONOMICS, never as NO_FILL", () => {
    const result = evaluateQuoteEntry(
      { ...signal, targetReference: 10.3 },
      quote(),
      assumptions,
    );
    expect(result.status).toBe("REJECTED_ECONOMICS");
    expect(result).toMatchObject({
      economicsReason: "NET_REWARD_RISK_TOO_LOW",
      entryMarketSnapshot: { bid: 9.99, ask: 10 },
    });
  });

  it("declines a candle entry with the same reason from the same facts", () => {
    const result = evaluateCandleEntry(
      { ...signal, targetReference: 10.3 },
      assumptions,
    );
    expect(result).toMatchObject({
      status: "REJECTED_ECONOMICS",
      economicsReason: "NET_REWARD_RISK_TOO_LOW",
    });
  });

  it("attaches the economics and sizing audit trail to an accepted entry", () => {
    const result = evaluateQuoteEntry(signal, quote(), assumptions);
    expect(result).toMatchObject({
      status: "OPEN",
      economics: { rejections: [] },
      sizing: { appliedCaps: ["RISK_BUDGET", "POSITION_NOTIONAL"] },
    });
  });

  it("rejects a wide spread before it can open a position", () => {
    const result = evaluateQuoteEntry(
      signal,
      quote({ bid: 9.9, ask: 10 }),
      assumptions,
    );
    expect(result).toMatchObject({
      status: "REJECTED_ECONOMICS",
      economicsReason: "SPREAD_COST_TOO_HIGH",
    });
  });
});

describe("economics properties", () => {
  const money = (min: number, max: number) =>
    fc
      .integer({ min: Math.round(min * 100), max: Math.round(max * 100) })
      .map((value) => value / 100);

  it("never accepts an entry whose modeled target loses money", () => {
    fc.assert(
      fc.property(
        money(1, 100),
        money(0.01, 5),
        money(0.01, 20),
        fc.integer({ min: 1, max: 5_000 }),
        money(0, 20),
        (entry, stopGap, targetGap, shares, commission) => {
          const economics = evaluateEconomics({
            executableEntryPrice: entry,
            stop: entry - stopGap,
            target: entry + targetGap,
            shares,
            spread: 0.01,
            assumptions: {
              ...assumptions,
              feePerTrade: commission,
              costs: { ...assumptions.costs!, exitCommission: commission },
            },
          });
          return (
            economics.rejections.length > 0 ||
            economics.expectedTargetNetPnl > 0
          );
        },
      ),
    );
  });

  it("cannot improve expected economics by raising costs", () => {
    fc.assert(
      fc.property(
        money(1, 100),
        money(0.01, 5),
        money(0.01, 20),
        fc.integer({ min: 1, max: 5_000 }),
        money(0, 10),
        money(0.01, 10),
        (entry, stopGap, targetGap, shares, commission, increase) => {
          const input = {
            executableEntryPrice: entry,
            stop: entry - stopGap,
            target: entry + targetGap,
            shares,
            spread: 0.01,
          };
          const cheap = evaluateEconomics({
            ...input,
            assumptions: {
              ...assumptions,
              feePerTrade: commission,
              costs: { ...assumptions.costs!, exitCommission: commission },
            },
          });
          const dear = evaluateEconomics({
            ...input,
            assumptions: {
              ...assumptions,
              feePerTrade: commission + increase,
              costs: {
                ...assumptions.costs!,
                exitCommission: commission + increase,
              },
            },
          });
          return (
            dear.expectedTargetNetPnl <= cheap.expectedTargetNetPnl &&
            dear.rejections.length >= cheap.rejections.length
          );
        },
      ),
    );
  });

  it("cannot increase position size by raising costs", () => {
    fc.assert(
      fc.property(
        money(1, 50),
        money(0.05, 5),
        money(0, 10),
        money(0.01, 10),
        (entry, stopGap, commission, increase) => {
          const evaluate = (fee: number) =>
            evaluateQuoteEntry(
              {
                ...signal,
                entryReference: entry,
                stopReference: entry - stopGap,
                targetReference: entry + stopGap * 4,
              },
              quote({ bid: entry - 0.01, ask: entry }),
              {
                ...assumptions,
                feePerTrade: fee,
                costs: { ...assumptions.costs!, exitCommission: fee },
              },
            );
          const cheap = evaluate(commission);
          const dear = evaluate(commission + increase);
          const shares = (result: ReturnType<typeof evaluate>) =>
            result.status === "OPEN" ? result.shares : 0;
          return shares(dear) <= shares(cheap);
        },
      ),
    );
  });
});
