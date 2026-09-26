import type { PaperJournalEntry } from "@tsx-scanner/contracts";
import { describe, expect, it } from "vitest";
import {
  addDays,
  byDay,
  byStrategy,
  cumulative,
  latestSession,
  marketDate,
  monthRange,
  shiftMonth,
  summarize,
  tradePct,
} from "./journal-stats.js";

function entry(
  sessionDate: string,
  netPnl: number | null,
  overrides: Partial<PaperJournalEntry> = {},
): PaperJournalEntry {
  return {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    sessionDate,
    symbol: "ABC",
    strategyKey: "VWAP_HOLD",
    profileName: "VWAP Hold",
    configVersion: "profile-v1",
    status: netPnl === null ? "OPEN" : "CLOSED",
    entryPrice: 10,
    entryTime: `${sessionDate}T14:00:00.000Z`,
    stopPrice: 9.5,
    targetPrice: 11,
    shares: 100,
    initialRisk: 50,
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    grossPnl: netPnl,
    costs: 0,
    netPnl,
    rMultiple: null,
    runningNetPnl: null,
    ...overrides,
  } as PaperJournalEntry;
}

describe("journal stats", () => {
  it("expresses a trade as a percentage of its entry value", () => {
    expect(tradePct(entry("2026-09-17", 27.5))).toBeCloseTo(2.75);
    expect(tradePct(entry("2026-09-17", 5, { shares: null }))).toBeNull();
  });

  it("sums closed trades by day and ignores open positions", () => {
    const days = byDay([
      entry("2026-09-17", 20),
      entry("2026-09-17", -5),
      entry("2026-09-17", 0),
      entry("2026-09-18", -10),
      entry("2026-09-18", null),
    ]);
    expect(days.get("2026-09-17")).toMatchObject({
      trades: 3,
      wins: 1,
      losses: 1,
      netPnl: 15,
    });
    expect(days.get("2026-09-17")!.pct).toBeCloseTo(1.5);
    expect(days.get("2026-09-18")).toMatchObject({ trades: 1, losses: 1 });
    expect(summarize([entry("2026-09-18", null)]).trades).toBe(0);
  });

  it("accumulates sessions in date order and finds the latest one", () => {
    const days = byDay([
      entry("2026-09-18", -10),
      entry("2026-09-09", 4),
      entry("2026-09-17", 20),
    ]);
    expect(cumulative(days).map((point) => [point.date, point.netPnl])).toEqual(
      [
        ["2026-09-09", 4],
        ["2026-09-17", 24],
        ["2026-09-18", 14],
      ],
    );
    expect(latestSession(days)).toBe("2026-09-18");
    expect(latestSession(new Map())).toBeNull();
  });

  it("ranks strategies by net result", () => {
    const strategies = byStrategy([
      entry("2026-09-17", -30, { profileName: "Breakout" }),
      entry("2026-09-17", 12, { profileName: "VWAP Hold" }),
      entry("2026-09-18", -3, { profileName: "Breakout" }),
    ]);
    expect(
      strategies.map((value) => [value.name, value.bucket.netPnl]),
    ).toEqual([
      ["VWAP Hold", 12],
      ["Breakout", -33],
    ]);
  });

  it("uses the market's own calendar date and month boundaries", () => {
    // 01:30 UTC on Sep 24 is still Sep 23 in New York and Toronto.
    const late = new Date("2026-09-24T01:30:00.000Z");
    expect(marketDate("US_EQUITIES", late)).toBe("2026-09-23");
    expect(marketDate("CA_TSX", late)).toBe("2026-09-23");
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
    expect(monthRange("2026-02")).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});
