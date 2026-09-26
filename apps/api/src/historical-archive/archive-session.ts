import type { CandleRow, QuoteRow } from "../backtests/backtest-repository.js";

/**
 * Archive replay synthesis (ADR-019). Converts imported provider history into
 * the same quote/candle rows the captured replay path hands to
 * `buildSessionPayload`, so the production feature engine, state machines and
 * execution accumulator run unchanged.
 *
 * One synthetic quote is emitted per retained bid/ask sample at a minute
 * boundary T. It only uses facts known at T: the bid/ask sampled at T and the
 * minute bars that ended at or before T. Quotes start once the first
 * regular-session bar has closed, because `dayOpen` is otherwise unknown.
 */

export interface ArchiveBar {
  instrumentId: string;
  timeframe: "OneMinute" | "OneDay";
  startTime: Date;
  endTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ArchiveQuoteSample {
  instrumentId: string;
  sampledAt: Date;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
}

export interface ArchiveSessionWindow {
  date: string;
  /** Regular-session open and close, including early closes. */
  open: Date;
  close: Date;
  /** Start of the market-local calendar day (extended-hours volume counts from here). */
  dayStart: Date;
}

const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * Provider minute volume can be fractional (fractional-share prints). Candle
 * and quote volume are integers, so each bar is rounded once, here, and every
 * aggregate is built from the rounded values.
 */
export function archiveVolume(value: number): number {
  return Math.max(0, Math.round(value));
}

export function synthesizeArchiveQuotes(
  window: ArchiveSessionWindow,
  bars: readonly ArchiveBar[],
  samples: readonly ArchiveQuoteSample[],
): QuoteRow[] {
  const minuteBars = new Map<string, ArchiveBar[]>();
  for (const bar of bars) {
    if (bar.timeframe !== "OneMinute") continue;
    if (bar.startTime < window.dayStart || bar.endTime > window.close) continue;
    const list = minuteBars.get(bar.instrumentId) ?? [];
    list.push(bar);
    minuteBars.set(bar.instrumentId, list);
  }
  for (const list of minuteBars.values())
    list.sort(
      (left, right) => left.endTime.getTime() - right.endTime.getTime(),
    );

  const ordered = [...samples]
    .filter(
      (sample) =>
        sample.sampledAt > window.open && sample.sampledAt <= window.close,
    )
    .sort(
      (left, right) =>
        left.sampledAt.getTime() - right.sampledAt.getTime() ||
        compare(left.instrumentId, right.instrumentId),
    );

  const rows: QuoteRow[] = [];
  for (const sample of ordered) {
    const list = minuteBars.get(sample.instrumentId);
    if (!list) continue;
    let last: ArchiveBar | undefined;
    let dayOpen: number | undefined;
    let dayHigh = -Infinity;
    let dayLow = Infinity;
    let volume = 0;
    for (const bar of list) {
      if (bar.endTime > sample.sampledAt) break;
      last = bar;
      volume += archiveVolume(bar.volume);
      if (bar.startTime >= window.open) {
        dayOpen ??= bar.open;
        dayHigh = Math.max(dayHigh, bar.high);
        dayLow = Math.min(dayLow, bar.low);
      }
    }
    if (!last || dayOpen === undefined) continue;
    rows.push({
      instrument_id: sample.instrumentId,
      symbol: "",
      session_date: window.date,
      timestamp: sample.sampledAt,
      bid: String(sample.bid),
      ask: String(sample.ask),
      bid_size: String(sample.bidSize),
      ask_size: String(sample.askSize),
      spread_absolute: String(roundPrice(sample.ask - sample.bid)),
      last: String(last.close),
      day_open: String(dayOpen),
      day_high: String(dayHigh),
      day_low: String(dayLow),
      day_volume: String(volume),
      is_delayed: false,
      is_halted: false,
      delay_seconds: null,
    });
  }
  return rows;
}

/**
 * Candle rows for one session: archived one-minute and daily bars as stored,
 * plus five-minute bars aggregated from the minute bars of the session date.
 * A five-minute bucket is emitted only when all its minutes would have ended
 * by the bucket end, which always holds for completed history.
 */
export function archiveCandles(
  window: ArchiveSessionWindow,
  bars: readonly ArchiveBar[],
  localDate: (value: Date) => string,
): CandleRow[] {
  const rows: CandleRow[] = [];
  const buckets = new Map<string, ArchiveBar[]>();
  // Market-local dates only change on hour boundaries; memoizing by UTC hour
  // avoids formatting a date for every one of tens of thousands of bars.
  const dates = new Map<number, string>();
  const dateFor = (value: Date) => {
    const hour = Math.floor(value.getTime() / 3_600_000);
    let date = dates.get(hour);
    if (date === undefined) {
      date = localDate(value);
      dates.set(hour, date);
    }
    return date;
  };
  for (const bar of bars) {
    rows.push(candleRow(bar, bar.timeframe, dateFor(bar.startTime)));
    if (
      bar.timeframe !== "OneMinute" ||
      bar.startTime < window.dayStart ||
      bar.endTime > window.close
    )
      continue;
    const bucketStart =
      Math.floor(bar.startTime.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const key = `${bar.instrumentId}|${bucketStart}`;
    const list = buckets.get(key) ?? [];
    list.push(bar);
    buckets.set(key, list);
  }
  for (const [key, list] of buckets) {
    const [instrumentId, start] = key.split("|");
    list.sort(
      (left, right) => left.startTime.getTime() - right.startTime.getTime(),
    );
    const startTime = new Date(Number(start));
    const aggregate: ArchiveBar = {
      instrumentId: instrumentId!,
      timeframe: "OneMinute",
      startTime,
      endTime: new Date(startTime.getTime() + FIVE_MINUTES_MS),
      open: list[0]!.open,
      high: Math.max(...list.map((bar) => bar.high)),
      low: Math.min(...list.map((bar) => bar.low)),
      close: list.at(-1)!.close,
      volume: list.reduce((sum, bar) => sum + archiveVolume(bar.volume), 0),
    };
    rows.push(candleRow(aggregate, "FiveMinutes", window.date));
  }
  return rows.sort(
    (left, right) =>
      left.end_time.getTime() - right.end_time.getTime() ||
      compare(left.instrument_id, right.instrument_id) ||
      compare(left.timeframe, right.timeframe),
  );
}

function candleRow(
  bar: ArchiveBar,
  timeframe: CandleRow["timeframe"],
  localDate: string,
): CandleRow {
  return {
    instrument_id: bar.instrumentId,
    symbol: "",
    local_date: localDate,
    timeframe,
    start_time: bar.startTime,
    end_time: bar.endTime,
    open: String(bar.open),
    high: String(bar.high),
    low: String(bar.low),
    close: String(bar.close),
    volume: String(archiveVolume(bar.volume)),
    is_complete: true,
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roundPrice(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
