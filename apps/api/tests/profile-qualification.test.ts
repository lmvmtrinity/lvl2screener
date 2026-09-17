import { describe, expect, it } from "vitest";
import { qualify } from "../src/profiles/profile-repository.js";

describe("Phase 8 profile qualification", () => {
  it("is EXPLORATORY with no linked evidence and no paper trades", () => {
    const result = qualify({
      evidence_qualified: false,
      paper_trades: 0,
      paper_wins: 0,
      paper_net_pnl: null,
    });
    expect(result).toEqual({
      qualification: "EXPLORATORY",
      qualificationReason:
        "No qualifying paper or holdout evidence is linked to this profile configuration.",
    });
  });

  it("stays EXPLORATORY below the minimum paper sample even with positive P&L", () => {
    const result = qualify({
      evidence_qualified: false,
      paper_trades: 120,
      paper_wins: 80,
      paper_net_pnl: 500,
    });
    expect(result.qualification).toBe("EXPLORATORY");
    expect(result.qualificationReason).toContain("120 closed paper trade");
  });

  it("is PAPER_QUALIFIED at or above the minimum sample with positive net P&L", () => {
    const result = qualify({
      evidence_qualified: false,
      paper_trades: 200,
      paper_wins: 120,
      paper_net_pnl: 1200,
    });
    expect(result.qualification).toBe("PAPER_QUALIFIED");
  });

  it("stays EXPLORATORY at the minimum sample with non-positive net P&L", () => {
    const result = qualify({
      evidence_qualified: false,
      paper_trades: 200,
      paper_wins: 80,
      paper_net_pnl: -50,
    });
    expect(result.qualification).toBe("EXPLORATORY");
  });

  it("prefers EVIDENCE_QUALIFIED over any paper sample", () => {
    const result = qualify({
      evidence_qualified: true,
      paper_trades: 0,
      paper_wins: 0,
      paper_net_pnl: null,
    });
    expect(result.qualification).toBe("EVIDENCE_QUALIFIED");
  });
});
