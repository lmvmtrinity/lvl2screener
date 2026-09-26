import type { PaperJournalEntry } from "@tsx-scanner/contracts";

export type JournalMarket = "CA_TSX" | "US_EQUITIES";

/** Summary of closed trades over a set of entries. `pct` is the sum of each
 * trade's net P&L over its entry value, matching "% of position". */
export interface JournalBucket {
  trades: number;
  wins: number;
  losses: number;
  netPnl: number;
  pct: number;
  /** Trades whose entry value is unknown are excluded from `pct`. */
  pctTrades: number;
}

export function marketTimeZone(marketId: JournalMarket): string {
  return marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto";
}

/** The market-local calendar date (YYYY-MM-DD) for an instant. */
export function marketDate(marketId: JournalMarket, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketTimeZone(marketId),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Shifts a YYYY-MM-DD calendar date by whole days. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** First and last calendar dates of a YYYY-MM month. */
export function monthRange(month: string): { start: string; end: string } {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(last).padStart(2, "0")}`,
  };
}

export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const value = new Date(Date.UTC(year, index - 1 + delta, 1));
  return value.toISOString().slice(0, 7);
}

/** Net P&L as a percentage of the position's entry value, or null when the
 * entry value is unknown. */
export function tradePct(entry: PaperJournalEntry): number | null {
  if (
    entry.netPnl === null ||
    entry.entryPrice === null ||
    entry.shares === null ||
    entry.entryPrice <= 0
  )
    return null;
  return (entry.netPnl / (entry.entryPrice * entry.shares)) * 100;
}

function emptyBucket(): JournalBucket {
  return { trades: 0, wins: 0, losses: 0, netPnl: 0, pct: 0, pctTrades: 0 };
}

function add(bucket: JournalBucket, entry: PaperJournalEntry): void {
  if (entry.status !== "CLOSED" || entry.netPnl === null) return;
  bucket.trades += 1;
  if (entry.netPnl > 0) bucket.wins += 1;
  else if (entry.netPnl < 0) bucket.losses += 1;
  bucket.netPnl += entry.netPnl;
  const pct = tradePct(entry);
  if (pct !== null) {
    bucket.pct += pct;
    bucket.pctTrades += 1;
  }
}

/** Closed trades summed into one bucket. Open positions are ignored. */
export function summarize(
  entries: readonly PaperJournalEntry[],
): JournalBucket {
  const bucket = emptyBucket();
  for (const entry of entries) add(bucket, entry);
  return bucket;
}

/** Closed trades grouped by session date. */
export function byDay(
  entries: readonly PaperJournalEntry[],
): Map<string, JournalBucket> {
  const days = new Map<string, JournalBucket>();
  for (const entry of entries) {
    if (entry.status !== "CLOSED") continue;
    const bucket = days.get(entry.sessionDate) ?? emptyBucket();
    add(bucket, entry);
    days.set(entry.sessionDate, bucket);
  }
  return days;
}

/** Closed trades grouped by profile, best net result first. */
export function byStrategy(
  entries: readonly PaperJournalEntry[],
): { name: string; bucket: JournalBucket }[] {
  const groups = new Map<string, JournalBucket>();
  for (const entry of entries) {
    if (entry.status !== "CLOSED") continue;
    const bucket = groups.get(entry.profileName) ?? emptyBucket();
    add(bucket, entry);
    groups.set(entry.profileName, bucket);
  }
  return [...groups.entries()]
    .map(([name, bucket]) => ({ name, bucket }))
    .sort((left, right) => right.bucket.netPnl - left.bucket.netPnl);
}

/** Closed trades whose session falls within [start, end]. */
export function between(
  entries: readonly PaperJournalEntry[],
  start: string,
  end: string,
): PaperJournalEntry[] {
  return entries.filter(
    (entry) => entry.sessionDate >= start && entry.sessionDate <= end,
  );
}

/** One cumulative point per session with closed trades, in session order. */
export function cumulative(
  days: ReadonlyMap<string, JournalBucket>,
): { date: string; netPnl: number; pct: number; trades: number }[] {
  let netPnl = 0;
  let pct = 0;
  return [...days.entries()]
    .filter(([, bucket]) => bucket.trades > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, bucket]) => {
      netPnl += bucket.netPnl;
      pct += bucket.pct;
      return { date, netPnl, pct, trades: bucket.trades };
    });
}

/** The latest session date with a closed trade, if any. */
export function latestSession(
  days: ReadonlyMap<string, JournalBucket>,
): string | null {
  return (
    [...days.entries()]
      .filter(([, bucket]) => bucket.trades > 0)
      .map(([date]) => date)
      .sort()
      .at(-1) ?? null
  );
}
