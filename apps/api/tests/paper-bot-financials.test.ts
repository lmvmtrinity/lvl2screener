import { describe, expect, it } from "vitest";
import {
  applyEntrySlippage,
  applyExitSlippage,
  computeClosingFinancials,
  roundMoney,
  roundPrice,
  roundR,
} from "../src/paper-bot/financials.js";

describe("paper-bot financials", () => {
  it("rounds prices to 6 decimals, money to 4, R to 6", () => {
    expect(roundPrice(1.0000005)).toBe(1.000001);
    expect(roundMoney(1.00005)).toBe(1.0001);
    expect(roundR(0.1234565)).toBe(0.123457);
  });

  it("applies entry slippage as a markup on the ask", () => {
    expect(applyEntrySlippage(10, 10)).toBe(10.01);
  });

  it("applies exit slippage as a markdown on the bid", () => {
    expect(applyExitSlippage(10, 10)).toBe(9.99);
  });

  it("subtracts the round-trip fee exactly once from gross P&L", () => {
    const result = computeClosingFinancials(10, 10.75, 100, 50, 1);
    expect(result).toEqual({
      exitPrice: 10.75,
      grossPnl: 75,
      netPnl: 74,
      rMultiple: 1.48,
    });
  });

  it("computes a negative R-multiple for a loss", () => {
    const result = computeClosingFinancials(10, 9.5, 100, 50, 1);
    expect(result.netPnl).toBe(-51);
    expect(result.rMultiple).toBe(-1.02);
  });
});
