import { describe, expect, it } from "vitest";
import {
  applyLedgerEvent,
  createFundedLedger,
  fundedAccountSummary,
  FundedRiskVeto,
  type LedgerEvent,
} from "../src/paper-bot/funded-ledger.js";

const at = "2026-09-04T14:00:00Z";
const initial = () => createFundedLedger("CAD", 2000, "2026-09-04", at, 200);
const reserve: LedgerEvent = {
  id: "reserve",
  at,
  currency: "CAD",
  type: "RESERVE",
  orderId: "order",
  debit: 1001,
  risk: 101,
};
const buy: LedgerEvent = {
  id: "buy",
  at,
  currency: "CAD",
  type: "BUY",
  orderId: "order",
  positionId: "position",
  instrumentId: "instrument",
  shares: 100,
  price: 10,
  fee: 1,
  stop: 9,
};
const opened = () =>
  applyLedgerEvent(applyLedgerEvent(initial(), reserve), buy);

describe("funded cash account ledger", () => {
  it("reserves cash and risk before filling and deduplicates recovered fills", () => {
    const reserved = applyLedgerEvent(initial(), reserve);
    expect(fundedAccountSummary(reserved, at, 30000).buyingPower).toBe(999);
    const filled = applyLedgerEvent(reserved, buy);
    expect(filled.cash).toBe(999);
    expect(applyLedgerEvent(JSON.parse(JSON.stringify(filled)), buy)).toEqual(
      filled,
    );
    expect(() => applyLedgerEvent(filled, { ...buy, price: 11 })).toThrow(
      "Conflicting",
    );
    let fillVeto: unknown;
    try {
      applyLedgerEvent(reserved, { ...buy, id: "buy-2", price: 11 });
    } catch (error) {
      fillVeto = error;
    }
    expect(fillVeto).toBeInstanceOf(FundedRiskVeto);
    expect((fillVeto as FundedRiskVeto).code).toBe("FILL_EXCEEDS_RESERVATION");
  });
  it("realizes each partial sale and reconciles equity and fees", () => {
    const partial = applyLedgerEvent(opened(), {
      id: "sell-1",
      at,
      currency: "CAD",
      type: "SELL",
      positionId: "position",
      shares: 40,
      price: 11,
      fee: 0.4,
    });
    expect(partial.realizedPnl).toBe(39.2);
    expect(partial.positions.position?.shares).toBe(60);
    const closed = applyLedgerEvent(partial, {
      id: "sell-2",
      at,
      currency: "CAD",
      type: "SELL",
      positionId: "position",
      shares: 60,
      price: 11,
      fee: 0.6,
    });
    expect(closed.cash).toBe(2098);
    expect(closed.realizedPnl).toBe(98);
    expect(fundedAccountSummary(closed, at, 30000).dailyPnl).toBe(98);
  });
  it("includes unrealized losses and blocks stale or unfunded entries", () => {
    const marked = applyLedgerEvent(opened(), {
      id: "mark",
      at,
      currency: "CAD",
      type: "MARK",
      instrumentId: "instrument",
      bid: 8,
    });
    const summary = fundedAccountSummary(marked, at, 30000);
    expect(summary.dailyPnl).toBe(-201);
    expect(summary.entriesAllowed).toBe(false);
    let reserveVeto: unknown;
    try {
      applyLedgerEvent(marked, {
        ...reserve,
        id: "another",
        orderId: "another",
      });
    } catch (error) {
      reserveVeto = error;
    }
    expect(reserveVeto).toBeInstanceOf(FundedRiskVeto);
    expect((reserveVeto as FundedRiskVeto).code).toBe(
      "DAILY_LOSS_OR_BUYING_POWER",
    );
    expect(
      fundedAccountSummary(opened(), "2026-09-04T14:01:00Z", 30000).staleMarks,
    ).toBe(true);
    let buyingPowerVeto: unknown;
    try {
      applyLedgerEvent(initial(), { ...reserve, debit: 3000 });
    } catch (error) {
      buyingPowerVeto = error;
    }
    expect((buyingPowerVeto as FundedRiskVeto).code).toBe(
      "DAILY_LOSS_OR_BUYING_POWER",
    );
  });
  it("rejects oversells, currency mixing and backward events", () => {
    expect(() =>
      applyLedgerEvent(opened(), {
        id: "sell",
        at,
        currency: "CAD",
        type: "SELL",
        positionId: "position",
        shares: 101,
        price: 10,
        fee: 0,
      }),
    ).toThrow("quantity");
    expect(() =>
      applyLedgerEvent(initial(), { ...reserve, currency: "USD" }),
    ).toThrow("currency");
    expect(() =>
      applyLedgerEvent(initial(), { ...reserve, at: "2026-09-04T13:59:00Z" }),
    ).toThrow("Out-of-order");
  });
  it("requires fresh marks before a new daily equity baseline", () => {
    expect(() =>
      applyLedgerEvent(opened(), {
        id: "session",
        at: "2026-09-05T14:00:00Z",
        currency: "CAD",
        type: "SESSION",
        session: "2026-09-05",
      }),
    ).toThrow("fresh marks");
  });
});
