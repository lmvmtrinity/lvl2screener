import type {
  BacktestQuoteExclusion,
  BacktestQuoteExclusionCode,
} from "@tsx-scanner/contracts";
import type { QuoteFact } from "../paper-bot/types.js";

/**
 * Deterministic replay quote admission. The live scanner rejects a session
 * outright when a single quote fails validation, which aborted whole replays
 * on captured opening quotes with `day_open = 0`. Replay instead excludes the
 * invalid quote facts and reports exactly what was removed.
 *
 * The same predicate must gate feature generation (the scanner payload) and
 * execution (the accumulator). A quote that is excluded never reaches either.
 * Each excluded quote carries exactly one reason code (first match below), so
 * reason counts sum to the excluded total.
 */
export interface ReplayQuoteLike extends QuoteFact {
  readonly instrumentId: string;
  readonly last?: number;
  readonly dayOpen?: number;
  readonly spread?: number;
}

export interface ReplayQuoteAdmission<T extends ReplayQuoteLike> {
  readonly admitted: readonly T[];
  readonly excludedQuotes: number;
  readonly reasons: readonly BacktestQuoteExclusion[];
  readonly excludedByInstrument: ReadonlyMap<string, number>;
}

export function classifyReplayQuoteExclusion(
  quote: ReplayQuoteLike,
): BacktestQuoteExclusionCode | null {
  const values = [
    quote.bid,
    quote.ask,
    quote.bidSize,
    quote.askSize,
    quote.spread,
    quote.last,
    quote.dayOpen,
  ];
  if (values.some((value) => value !== undefined && !Number.isFinite(value)))
    return "NON_FINITE_VALUE";
  if (!(quote.bid > 0)) return "INVALID_BID";
  if (quote.ask < quote.bid) return "CROSSED_BOOK";
  if (quote.last !== undefined && !(quote.last > 0)) return "INVALID_LAST";
  if (quote.dayOpen !== undefined && !(quote.dayOpen > 0))
    return "INVALID_DAY_OPEN";
  if (!(quote.bidSize >= 0) || !(quote.askSize >= 0)) return "INVALID_SIZE";
  if (quote.spread !== undefined && !(quote.spread >= 0))
    return "INVALID_SPREAD";
  return null;
}

export function admitReplayQuotes<T extends ReplayQuoteLike>(
  quotes: readonly T[],
): ReplayQuoteAdmission<T> {
  const admitted: T[] = [];
  const reasonCounts = new Map<BacktestQuoteExclusionCode, number>();
  const excludedByInstrument = new Map<string, number>();
  for (const quote of quotes) {
    const reason = classifyReplayQuoteExclusion(quote);
    if (reason === null) {
      admitted.push(quote);
      continue;
    }
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    excludedByInstrument.set(
      quote.instrumentId,
      (excludedByInstrument.get(quote.instrumentId) ?? 0) + 1,
    );
  }
  return {
    admitted,
    excludedQuotes: quotes.length - admitted.length,
    reasons: [...reasonCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
    excludedByInstrument,
  };
}

export function mergeQuoteExclusionReasons(
  target: Map<BacktestQuoteExclusionCode, number>,
  reasons: readonly BacktestQuoteExclusion[],
): void {
  for (const reason of reasons)
    target.set(reason.code, (target.get(reason.code) ?? 0) + reason.count);
}

export function mergeInstrumentExclusions(
  target: Map<string, number>,
  additions: ReadonlyMap<string, number>,
): void {
  for (const [instrumentId, count] of additions)
    target.set(instrumentId, (target.get(instrumentId) ?? 0) + count);
}

export function sortedQuoteExclusionReasons(
  counts: ReadonlyMap<BacktestQuoteExclusionCode, number>,
): BacktestQuoteExclusion[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

export function quoteExclusionWarning(
  excludedQuotes: number,
  reasons: readonly BacktestQuoteExclusion[],
): string {
  const detail = reasons
    .map((reason) => `${reason.code} ${reason.count}`)
    .join(", ");
  return `${excludedQuotes} captured quote(s) were excluded from replay (${detail}); coverage and diagnostics reflect admitted quotes only.`;
}

/**
 * Returns a session whose quotes are admitted for dispatch to the scanner.
 * The original session remains the identity used for coverage hashing and for
 * accumulator accounting: never hash the admitted payload as the frozen input.
 */
export function admitReplaySession<
  T extends { quotes?: readonly ReplayQuoteLike[] },
>(session: T): T {
  const quotes = session.quotes;
  if (!quotes?.length) return session;
  const { admitted } = admitReplayQuotes(quotes);
  if (admitted.length === quotes.length) return session;
  return { ...session, quotes: admitted };
}
