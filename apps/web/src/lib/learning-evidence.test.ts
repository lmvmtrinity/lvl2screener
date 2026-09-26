import { describe, expect, it } from "vitest";
import {
  type EvidenceReadiness,
  daysSinceSignal,
  splitEvidence,
} from "./learning-evidence.js";

function readiness(
  marketId: "CA_TSX" | "US_EQUITIES",
  strategy: string,
  executionModelVersion: string,
  closedQuoteCount: number,
  lastSignalAt: string | null = "2026-09-23T16:30:00.000Z",
): EvidenceReadiness {
  return {
    cohort: {
      marketId,
      strategy,
      profileConfigId: `${marketId}-${strategy}`,
      configVersion: `profile-${strategy.toLowerCase()}-v1`,
      executionModelVersion,
      closedQuoteCount,
      positives: 1,
      negatives: 1,
      firstSignalAt: "2026-09-08T14:00:00.000Z",
      lastSignalAt,
    },
    closedQuoteCount,
    threshold: 200,
    progressPct: Math.round((closedQuoteCount / 200) * 100),
    newOutcomesSinceLastDataset: closedQuoteCount,
    newOutcomeThreshold: 50,
    qualifies: false,
    disqualificationReason: "INSUFFICIENT_CLOSED_QUOTES",
  } as unknown as EvidenceReadiness;
}

describe("splitEvidence", () => {
  it("keeps the other market's cohorts out of the selected market", () => {
    const rows = [
      readiness(
        "US_EQUITIES",
        "PRIOR_DAY_HIGH_BREAKOUT",
        "paper-execution-v7",
        78,
      ),
      readiness("CA_TSX", "PRIOR_DAY_HIGH_BREAKOUT", "paper-execution-v7", 22),
    ];
    const split = splitEvidence(rows, "CA_TSX");
    expect(split.market.map((row) => row.cohort.marketId)).toEqual(["CA_TSX"]);
    expect(split.current[0]!.closedQuoteCount).toBe(22);
  });

  it("treats the newest execution model as current, ordering by outcomes", () => {
    const rows = [
      readiness("CA_TSX", "VWAP_HOLD", "paper-execution-v7", 3),
      readiness("CA_TSX", "ORB_RETEST", "paper-execution-v2", 3),
      readiness("CA_TSX", "HIGH_OF_DAY_BREAKOUT", "paper-execution-v10", 1),
      readiness("CA_TSX", "PRIOR_DAY_HIGH_BREAKOUT", "paper-execution-v10", 22),
    ];
    const split = splitEvidence(rows, "CA_TSX");
    expect(split.currentModel).toBe("paper-execution-v10");
    expect(split.current.map((row) => row.cohort.strategy)).toEqual([
      "PRIOR_DAY_HIGH_BREAKOUT",
      "HIGH_OF_DAY_BREAKOUT",
    ]);
    expect(split.older).toHaveLength(2);
  });

  it("reports no current model for a market without cohorts", () => {
    const split = splitEvidence([], "US_EQUITIES");
    expect(split.currentModel).toBeNull();
    expect(split.current).toEqual([]);
  });
});

describe("daysSinceSignal", () => {
  it("counts whole days and returns null without a signal", () => {
    const now = Date.parse("2026-09-23T21:00:00.000Z");
    const quiet = readiness(
      "CA_TSX",
      "VWAP_HOLD",
      "paper-execution-v7",
      3,
      "2026-09-11T15:05:00.000Z",
    );
    expect(daysSinceSignal(quiet, now)).toBe(12);
    expect(
      daysSinceSignal(
        readiness("CA_TSX", "VWAP_HOLD", "paper-execution-v7", 0, null),
        now,
      ),
    ).toBeNull();
  });
});
