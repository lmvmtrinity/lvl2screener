import type {
  ExpectedInputCell,
  RetainedInputReceipt,
} from "../src/backtests/research-coverage.js";

export function coverageFixture(): {
  cell: ExpectedInputCell;
  receipt: RetainedInputReceipt;
} {
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
  return {
    cell,
    receipt: {
      cellId: cell.cellId,
      inputHash: "c".repeat(64),
      provenance: "VERIFIED",
      provenanceReasons: [],
      invalidQuoteCount: 0,
      warmupTimeframe: "OneMinute",
      quoteTimes: [
        cell.windowStart,
        "2026-09-09T13:30:30.000Z",
        cell.windowEnd,
      ],
      warmupBarTimes: ["2026-09-09T13:28:00.000Z", "2026-09-09T13:29:00.000Z"],
      invalidWarmupBarCount: 0,
    },
  };
}
