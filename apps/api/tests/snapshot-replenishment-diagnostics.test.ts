import { describe, expect, it } from "vitest";
import { analyzeSnapshotReplenishment } from "../src/paper-bot/snapshot-replenishment-diagnostics.js";
import {
  diagnosticEvidence,
  diagnosticFill,
  diagnosticQuote,
} from "./execution-diagnostics-fixtures.js";

describe("snapshot replenishment diagnostics", () => {
  it("labels increasing identical books as unverified replenishment, not stale", () => {
    const first = diagnosticQuote("q1", "2099-04-01T14:30:00.000Z");
    const second = diagnosticQuote("q2", "2099-04-01T14:30:01.000Z");
    const result = analyzeSnapshotReplenishment(
      diagnosticEvidence(
        [second, first, first],
        [diagnosticFill("e1", first, 80), diagnosticFill("e2", second, 60)],
      ),
    );
    expect(result.stretches.find((row) => row.side === "ASK")).toMatchObject({
      snapshotCount: 2,
      totalFilledShares: 140,
      fillsAfterFirstSnapshotShares: 60,
      excessOverInitialBudgetShares: 40,
      assessment: "REPLENISHMENT_UNVERIFIED",
    });
    expect(result.excluded).toEqual([]);
    expect(result.unlinkedFillShares).toEqual({ BID: 0, ASK: 0 });
  });

  it("does not invent a budget and accounts for bid-side partial fills", () => {
    const first = {
      ...diagnosticQuote("q1", "2099-04-01T14:30:00.000Z"),
      participation: null,
    };
    const second = {
      ...diagnosticQuote("q2", "2099-04-01T14:30:01.000Z", 100, 200),
      participation: null,
    };
    const result = analyzeSnapshotReplenishment(
      diagnosticEvidence(
        [first, second],
        [
          diagnosticFill("e1", first, 30, "BID"),
          diagnosticFill("e2", second, 20, "BID"),
        ],
      ),
    );
    expect(result.stretches).toHaveLength(1);
    expect(result.stretches[0]).toMatchObject({
      side: "BID",
      totalFilledShares: 50,
      initialBudgetShares: null,
      excessOverInitialBudgetShares: null,
    });
  });

  it("excludes halted observations and does not bridge an invalid snapshot", () => {
    const first = diagnosticQuote("q1", "2099-04-01T14:30:00.000Z");
    const haltedBase = diagnosticQuote("halt", "2099-04-01T14:30:01.000Z");
    const halted = {
      ...haltedBase,
      quote: { ...haltedBase.quote, dataStatus: "HALTED" as const },
    };
    const third = diagnosticQuote("q3", "2099-04-01T14:30:02.000Z");
    const result = analyzeSnapshotReplenishment(
      diagnosticEvidence([first, halted, third], []),
    );
    expect(result.excluded).toEqual([{ evidenceId: "halt", reason: "HALTED" }]);
    expect(result.stretches).toEqual([]);
  });

  it("counts an unlinked fill as unavailable instead of allocating it", () => {
    const quote = diagnosticQuote("q1", "2099-04-01T14:30:00.000Z");
    const fill = {
      ...diagnosticFill("e1", quote, 12),
      quoteEvidenceId: null,
      linkUnknown: "AMBIGUOUS_FILL_QUOTE_LINK" as const,
    };
    const result = analyzeSnapshotReplenishment(
      diagnosticEvidence([quote], [fill]),
    );
    expect(result.unlinkedFillShares).toEqual({ BID: 0, ASK: 12 });
    expect(result.stretches).toEqual([]);
    expect(result.unavailable).toContain("AMBIGUOUS_FILL_QUOTE_LINK");
  });

  it("rejects conflicting duplicate event identities", () => {
    const first = diagnosticQuote("q1", "2099-04-01T14:30:00.000Z");
    const conflicting = diagnosticFill("e1", first, 13);
    expect(() =>
      analyzeSnapshotReplenishment(
        diagnosticEvidence(
          [first],
          [diagnosticFill("e1", first, 12), conflicting],
        ),
      ),
    ).toThrow("Conflicting diagnostic event identity");
  });
});
