import type {
  BacktestReplayResult,
  MarketId,
  SessionPair,
} from "@tsx-scanner/contracts";
import { contentHash } from "./research-coverage.js";
import { marketSessionTimezone } from "./execution-provenance.js";

export function deriveStudySessionPairs(
  baseline: BacktestReplayResult,
  challenger: BacktestReplayResult,
  marketId: MarketId,
  expectedSessions: readonly string[],
  unit: "R" | "CAD" | "USD" = "R",
): SessionPair[] {
  const expectedUnit = marketId === "CA_TSX" ? "CAD" : "USD";
  if (unit !== "R" && unit !== expectedUnit)
    throw new Error("STUDY_UNIT_MARKET_MISMATCH");
  const values = (output: BacktestReplayResult) => {
    const byDate = new Map<string, number>();
    for (const trade of output.trades) {
      const date = dateInMarket(trade.exitTime, marketId);
      byDate.set(
        date,
        (byDate.get(date) ?? 0) +
          (unit === "R" ? trade.rMultiple : trade.netPnl),
      );
    }
    return byDate;
  };
  const baselineByDate = values(baseline);
  const challengerByDate = values(challenger);
  return expectedSessions.map((sessionDate) => ({
    sessionDate,
    baseline: baselineByDate.get(sessionDate) ?? 0,
    challenger: challengerByDate.get(sessionDate) ?? 0,
    coverage: "VERIFIED",
  }));
}

export function assertFrozenSessionPayload(
  payload: unknown,
  sessionPayloadHashes: Record<string, string>,
  date?: string,
): void {
  const payloadDate =
    date ??
    (typeof payload === "object" && payload !== null
      ? (payload as { date?: unknown }).date
      : undefined);
  if (typeof payloadDate !== "string") throw new Error("STUDY_INPUT_CHANGED");
  const expected = sessionPayloadHashes[payloadDate];
  if (!expected || contentHash({ date: payloadDate, payload }) !== expected)
    throw new Error(`STUDY_INPUT_CHANGED:${payloadDate}`);
}

function dateInMarket(timestamp: string, marketId: MarketId): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketSessionTimezone(marketId),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date(timestamp))
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
