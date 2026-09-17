import { describe, expect, it } from "vitest";
import type {
  ExpectedInputCell,
  RetainedInputReceipt,
} from "../src/backtests/research-coverage.js";
import {
  contentHash,
  evaluateCoverage,
} from "../src/backtests/research-coverage.js";
import { hashResearchSession } from "../src/backtests/research-session-input.js";

const cell: ExpectedInputCell = {
  cellId: "ca-member-session",
  marketId: "CA_TSX",
  instrumentId: "10000000-0000-4000-8000-000000000001",
  sessionDate: "2026-09-09",
  role: "CANDIDATE",
  membership: "REQUIRED",
  membershipSourceHash: "a".repeat(64),
  calendarSourceHash: "b".repeat(64),
  windowStart: "2026-09-09T13:30:00.000Z",
  windowEnd: "2026-09-09T13:31:00.000Z",
  maxQuoteGapMs: 30_000,
  warmupTimeframe: "OneMinute",
  warmupWindowStart: "2026-09-09T13:28:00.000Z",
  requiredWarmupBars: 2,
  warmupBefore: "2026-09-09T13:30:00.000Z",
};

const receipt: RetainedInputReceipt = {
  cellId: cell.cellId,
  inputHash: "c".repeat(64),
  provenance: "VERIFIED",
  provenanceReasons: [],
  invalidQuoteCount: 0,
  warmupTimeframe: "OneMinute",
  quoteTimes: [cell.windowStart, "2026-09-09T13:30:30.000Z", cell.windowEnd],
  warmupBarTimes: ["2026-09-09T13:28:00.000Z", "2026-09-09T13:29:00.000Z"],
  invalidWarmupBarCount: 0,
};

describe("research coverage evaluator", () => {
  it("does not equate no captured quotes with no trades", () => {
    expect(evaluateCoverage([cell], [])[0]?.status).toBe("INCOMPLETE");
    expect(evaluateCoverage([cell], [])[0]?.reasons).toContain("QUOTE_MISSING");
  });

  it("accepts verified inputs without requiring any opportunity or trade", () => {
    expect(evaluateCoverage([cell], [receipt])[0]?.status).toBe("VERIFIED");
    expect(evaluateCoverage([cell], [receipt])[0]?.validQuotes).toBe(3);
    expect(evaluateCoverage([cell], [receipt])[0]?.validWarmupBars).toBe(2);
  });

  it("refuses a current membership guess and future warmup", () => {
    expect(
      evaluateCoverage([{ ...cell, membership: "UNKNOWN" }], [receipt])[0]
        ?.status,
    ).toBe("UNKNOWN");
    const late = {
      ...receipt,
      warmupBarTimes: [cell.windowEnd, cell.windowEnd],
    };
    expect(evaluateCoverage([cell], [late])[0]?.reasons).toContain(
      "WARMUP_SHORTFALL",
    );
  });

  it("hashes maps canonically but retains array chronology", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
    expect(() => contentHash({ value: Number.NaN })).toThrow(
      "UNSUPPORTED_CANONICAL_VALUE",
    );
    const session = { quotes: [], candles: [{ close: 10, volume: 100 }] };
    expect(hashResearchSession("2026-09-09", session)).toBe(
      contentHash({ date: "2026-09-09", payload: session }),
    );
    expect(
      hashResearchSession("2026-09-09", {
        ...session,
        candles: [{ close: 11, volume: 100 }],
      }),
    ).not.toBe(hashResearchSession("2026-09-09", session));
    expect(
      contentHash({ capturedAt: new Date("2026-09-09T00:00:00.000Z") }),
    ).toBe(contentHash({ capturedAt: "2026-09-09T00:00:00.000Z" }));
  });

  it("keeps required benchmarks in the denominator independently of trades", () => {
    const benchmark = {
      ...cell,
      cellId: "market-benchmark",
      role: "MARKET_BENCHMARK" as const,
    };
    const result = evaluateCoverage([cell, benchmark], [receipt]);
    expect(result).toEqual([
      expect.objectContaining({ cellId: cell.cellId, status: "VERIFIED" }),
      expect.objectContaining({
        cellId: benchmark.cellId,
        status: "INCOMPLETE",
        reasons: expect.arrayContaining(["QUOTE_MISSING"]),
      }),
    ]);
  });

  it("reports missing provenance as unknown and proved nonmembership as not required", () => {
    expect(
      evaluateCoverage(
        [
          {
            ...cell,
            membership: "UNKNOWN",
            membershipSourceHash: null,
            calendarSourceHash: null,
          },
        ],
        [receipt],
      )[0],
    ).toEqual(
      expect.objectContaining({
        status: "UNKNOWN",
        reasons: expect.arrayContaining([
          "MEMBERSHIP_UNPROVEN",
          "CALENDAR_UNPROVEN",
        ]),
      }),
    );
    expect(
      evaluateCoverage([{ ...cell, membership: "NOT_REQUIRED" }], [])[0],
    ).toEqual(expect.objectContaining({ status: "NOT_REQUIRED" }));
  });

  it("treats an unproved no-trade gap as unknown but accepts a proved interval", () => {
    const gapReceipt = {
      ...receipt,
      quoteTimes: [cell.windowStart, cell.windowEnd],
    };
    expect(
      evaluateCoverage(
        [cell],
        [
          {
            ...gapReceipt,
            provenance: "UNKNOWN",
            provenanceReasons: ["AVAILABILITY_UNPROVEN"],
          },
        ],
      )[0],
    ).toEqual(
      expect.objectContaining({
        status: "UNKNOWN",
        reasons: expect.arrayContaining(["AVAILABILITY_UNPROVEN"]),
      }),
    );
    expect(
      evaluateCoverage(
        [cell],
        [{ ...gapReceipt, provenanceReasons: ["NO_TRADE_INTERVAL_PROVED"] }],
      )[0]?.status,
    ).toBe("VERIFIED");
  });

  it("rejects duplicate receipts and stream mismatches", () => {
    expect(() => evaluateCoverage([cell], [receipt, receipt])).toThrow(
      "DUPLICATE_RECEIPT",
    );
    expect(() =>
      evaluateCoverage(
        [cell],
        [{ ...receipt, warmupTimeframe: "FiveMinutes" }],
      ),
    ).toThrow("WARMUP_STREAM_MISMATCH");
  });

  it("marks endpoint gaps, invalid retained rows and duplicate warmup bars incomplete", () => {
    const result = evaluateCoverage(
      [cell],
      [
        {
          ...receipt,
          quoteTimes: ["2026-09-09T13:30:20.000Z"],
          invalidQuoteCount: 1,
          warmupBarTimes: [
            "2026-09-09T13:29:00.000Z",
            "2026-09-09T13:29:00.000Z",
          ],
          invalidWarmupBarCount: 1,
        },
      ],
    )[0]!;
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "QUOTE_GAP",
        "INVALID_RETAINED_INPUT",
        "WARMUP_SHORTFALL",
      ]),
    );
  });
});
