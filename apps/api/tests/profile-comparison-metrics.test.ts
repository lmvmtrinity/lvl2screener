import { describe, expect, it } from "vitest";
import { realizedOutcomeDrawdown } from "../src/profiles/comparison-metrics.js";

describe("realized outcome drawdown", () => {
  it("ignores storage order while preserving actual realization order", () => {
    const rows = [100, -80, -80, 100].map((pnl, index) => ({
      outcomeId: `outcome-${index}`,
      realizedAt: `2026-09-01T14:0${index}:00.000Z`,
      pnl,
    }));

    expect(realizedOutcomeDrawdown(rows).amount).toBe(160);
    expect(
      realizedOutcomeDrawdown([rows[2]!, rows[0]!, rows[3]!, rows[1]!]),
    ).toEqual(realizedOutcomeDrawdown(rows));
  });

  it("nets one instant instead of inventing order inside it", () => {
    expect(
      realizedOutcomeDrawdown([
        { outcomeId: "a", realizedAt: "2026-09-01T14:00:00Z", pnl: -100 },
        {
          outcomeId: "b",
          realizedAt: "2026-09-01T10:00:00-04:00",
          pnl: 100,
        },
      ]).amount,
    ).toBe(0);
  });

  it("ignores an identical retry identity and preserves positive-only outcomes", () => {
    const outcome = {
      outcomeId: "a",
      realizedAt: "2026-09-01T14:00:00Z",
      pnl: 100,
    };
    expect(realizedOutcomeDrawdown([outcome, outcome])).toEqual(
      realizedOutcomeDrawdown([outcome]),
    );
    expect(realizedOutcomeDrawdown([outcome])).toMatchObject({
      amount: 0,
      status: "AVAILABLE",
    });
  });

  it("does not fabricate missing realization time", () => {
    expect(
      realizedOutcomeDrawdown([{ outcomeId: "a", realizedAt: null, pnl: -10 }])
        .status,
    ).toBe("UNAVAILABLE");
    expect(
      realizedOutcomeDrawdown([
        { outcomeId: "a", realizedAt: "2026-09-01T14:00:00Z", pnl: NaN },
      ]).status,
    ).toBe("UNAVAILABLE");
    expect(realizedOutcomeDrawdown([]).status).toBe("NO_CLOSED_OUTCOMES");
  });

  it("rejects contradictory duplicate identities", () => {
    expect(() =>
      realizedOutcomeDrawdown([
        { outcomeId: "a", realizedAt: "2026-09-01T14:00:00Z", pnl: 10 },
        { outcomeId: "a", realizedAt: "2026-09-01T14:01:00Z", pnl: 10 },
      ]),
    ).toThrow("Conflicting realized outcome identity");
  });
});
