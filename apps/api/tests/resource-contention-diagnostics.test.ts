import { describe, expect, it } from "vitest";
import { explainResourceContention } from "../src/paper-bot/resource-contention-diagnostics.js";
import {
  allocation,
  diagnosticEvidence,
  diagnosticFill,
  diagnosticQuote,
} from "./execution-diagnostics-fixtures.js";

describe("resource contention diagnostics", () => {
  it("explains canonical rank without changing allocation", () => {
    const quote = diagnosticQuote("q1", "2099-04-01T14:30:00.000Z");
    const evidence = diagnosticEvidence(
      [quote],
      [
        { ...diagnosticFill("e1", quote, 60), orderId: "a" },
        { ...diagnosticFill("e2", quote, 40), orderId: "b" },
      ],
      [allocation("b", "q1"), allocation("a", "q1")],
    );
    const rows = explainResourceContention(evidence).rows;
    expect(
      rows.map((row) => [
        row.orderId,
        row.canonicalRank,
        row.filledShares,
        row.remainingBudgetBeforeOrder,
      ]),
    ).toEqual([
      ["a", 1, 60, 100],
      ["b", 2, 40, 40],
    ]);
    expect(rows[1]!.reason).toBe("CAPACITY_BOUND_CONFIRMED");

    const unknown = {
      ...evidence,
      quotes: [{ ...quote, participation: null }],
    };
    expect(explainResourceContention(unknown).rows[1]).toMatchObject({
      initialBudgetShares: null,
      remainingBudgetBeforeOrder: null,
      reason: "PARTIAL_FILL",
      unavailable: ["MISSING_HISTORICAL_BUDGET"],
    });
  });

  it("preserves recorded vetoes and SELL ownership quantities", () => {
    const quote = diagnosticQuote("q1", "2099-04-01T14:30:00.000Z");
    const evidence = diagnosticEvidence(
      [quote],
      [
        { ...diagnosticFill("e1", quote, 20, "BID"), orderId: "sell-a" },
        { ...diagnosticFill("e2", quote, 20, "BID"), orderId: "sell-b" },
      ],
      [
        {
          ...allocation("sell-a", "q1"),
          side: "BID",
          requestedShares: 20,
          beforeShares: 60,
          afterShares: 40,
        },
        {
          ...allocation("sell-b", "q1"),
          side: "BID",
          requestedShares: 20,
          beforeShares: 40,
          afterShares: 20,
          explicitReason: "INSUFFICIENT_CASH",
        },
      ],
    );
    const rows = explainResourceContention(evidence).rows;
    expect(rows[0]).toMatchObject({
      remainingOwnedShares: 40,
      reason: "FILLED",
    });
    expect(rows[1]).toMatchObject({
      remainingOwnedShares: 20,
      reason: "RECORDED_REASON",
      recordedReason: "INSUFFICIENT_CASH",
    });
  });

  it("keeps rank and budget unknown for incomplete candidate sets", () => {
    const quote = diagnosticQuote("q1", "2099-04-01T14:30:00.000Z");
    const result = explainResourceContention(
      diagnosticEvidence(
        [quote],
        [{ ...diagnosticFill("e1", quote, 10), orderId: "a" }],
        [{ ...allocation("a", "q1"), completeness: "PARTIAL" }],
      ),
    );
    expect(result.rows[0]).toMatchObject({
      canonicalRank: null,
      remainingBudgetBeforeOrder: null,
      reason: "PARTIAL_FILL",
      unavailable: ["MISSING_ALLOCATION_INPUTS"],
    });
  });

  it("attributes fills to the exact retained quote identity", () => {
    const q1 = diagnosticQuote("q1", "2099-04-01T14:30:01.000Z");
    const q2 = diagnosticQuote("q2", "2099-04-01T14:30:02.000Z");
    const report = explainResourceContention(
      diagnosticEvidence(
        [q1, q2],
        [
          { ...diagnosticFill("e1", q1, 20, "BID"), orderId: "same-order" },
          { ...diagnosticFill("e2", q2, 30, "BID"), orderId: "same-order" },
        ],
        [
          { ...allocation("same-order", "q1"), side: "BID" },
          { ...allocation("same-order", "q2"), side: "BID" },
        ],
      ),
    );
    expect(report.rows.map((row) => row.filledShares)).toEqual([20, 30]);
  });
});
