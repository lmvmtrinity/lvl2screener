import type { MarketId } from "@tsx-scanner/contracts";
import { zonedSessionBoundary } from "../paper-bot/session-time.js";
import {
  publishedCalendarCovers,
  publishedCalendarRevision,
  publishedCalendarSource,
  publishedCalendarYear,
} from "./published-calendars.js";

export interface CalendarSession {
  tradingDate: string;
  open: string;
  close: string;
}

export interface CalendarProvenance {
  verified: boolean;
  revision: string;
  source: string;
}

const COMPUTED_CALENDAR: CalendarProvenance = {
  verified: false,
  revision: "market-calendar-v1",
  source: "computed-session-rules-v1",
};

/** Compute Easter Sunday for a given Gregorian year (Meeus/Jones/Butcher algorithm). */
function getEasterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Compute Good Friday date YYYY-MM-DD for a given year. */
function getGoodFriday(year: number): string {
  const easter = getEasterSunday(year);
  const easterDate = new Date(Date.UTC(year, easter.month - 1, easter.day));
  const goodFridayDate = new Date(easterDate.getTime() - 2 * 86_400_000);
  const m = String(goodFridayDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(goodFridayDate.getUTCDate()).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/** Finds the Nth occurrence of a weekday in a given month (1-indexed month, 0 = Sun, 1 = Mon, etc.). */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): string {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1) break;
    if (date.getUTCDay() === weekday) {
      count++;
      if (count === n) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }
  throw new Error(`Unable to find ${n}th weekday ${weekday} in month ${month}`);
}

/** Finds the last occurrence of a weekday in a given month. */
function lastWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
): string {
  let lastDay = 1;
  for (let day = 1; day <= 31; day++) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1) break;
    if (date.getUTCDay() === weekday) {
      lastDay = day;
    }
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** Observe weekend-adjusted holiday (Saturday -> Friday, Sunday -> Monday). */
function observedFixedHoliday(
  year: number,
  month: number,
  day: number,
): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dow = date.getUTCDay();
  let adjustedDate = date;
  if (dow === 0) {
    // Sunday -> Monday
    adjustedDate = new Date(date.getTime() + 86_400_000);
  } else if (dow === 6) {
    // Saturday -> Friday
    adjustedDate = new Date(date.getTime() - 86_400_000);
  }
  const y = adjustedDate.getUTCFullYear();
  const m = String(adjustedDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(adjustedDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Get holidays for US equities (NYSE & NASDAQ). */
export function getUsHolidays(year: number): Set<string> {
  const holidays = new Set<string>();
  // New Year's Day (observed)
  holidays.add(observedFixedHoliday(year, 1, 1));
  // Martin Luther King Jr. Day (3rd Monday in January)
  holidays.add(nthWeekdayOfMonth(year, 1, 1, 3));
  // Washington's Birthday / Presidents' Day (3rd Monday in February)
  holidays.add(nthWeekdayOfMonth(year, 2, 1, 3));
  // Good Friday
  holidays.add(getGoodFriday(year));
  // Memorial Day (last Monday in May)
  holidays.add(lastWeekdayOfMonth(year, 5, 1));
  // Juneteenth (observed)
  holidays.add(observedFixedHoliday(year, 6, 19));
  // Independence Day (observed)
  holidays.add(observedFixedHoliday(year, 7, 4));
  // Labor Day (1st Monday in September)
  holidays.add(nthWeekdayOfMonth(year, 9, 1, 1));
  // Thanksgiving Day (4th Thursday in November)
  holidays.add(nthWeekdayOfMonth(year, 11, 4, 4));
  // Christmas Day (observed)
  holidays.add(observedFixedHoliday(year, 12, 25));
  return holidays;
}

/** Get holidays for Canadian equities (TSX). */
export function getTsxHolidays(year: number): Set<string> {
  const holidays = new Set<string>();
  // New Year's Day. TSX observes a weekend New Year on the following Monday,
  // including a Saturday January 1 (e.g. Monday January 3, 2022). It does not
  // close the preceding Friday as US exchanges do.
  const ny = new Date(Date.UTC(year, 0, 1));
  if (ny.getUTCDay() === 0) {
    holidays.add(`${year}-01-02`);
  } else if (ny.getUTCDay() === 6) {
    holidays.add(`${year}-01-03`);
  } else {
    holidays.add(`${year}-01-01`);
  }
  // Family Day (3rd Monday in February)
  holidays.add(nthWeekdayOfMonth(year, 2, 1, 3));
  // Good Friday
  holidays.add(getGoodFriday(year));
  // Victoria Day (Monday preceding May 25, or on May 24 if Monday)
  for (let day = 18; day <= 24; day++) {
    const d = new Date(Date.UTC(year, 4, day));
    if (d.getUTCDay() === 1) {
      holidays.add(`${year}-05-${String(day).padStart(2, "0")}`);
      break;
    }
  }
  // Canada Day (July 1; if Sunday, observed July 2)
  const cd = new Date(Date.UTC(year, 6, 1));
  if (cd.getUTCDay() === 0) {
    holidays.add(`${year}-07-02`);
  } else if (cd.getUTCDay() === 6) {
    holidays.add(`${year}-07-03`);
  } else {
    holidays.add(`${year}-07-01`);
  }
  // Civic Holiday (1st Monday in August)
  holidays.add(nthWeekdayOfMonth(year, 8, 1, 1));
  // Labour Day (1st Monday in September)
  holidays.add(nthWeekdayOfMonth(year, 9, 1, 1));
  // Thanksgiving Day (2nd Monday in October)
  holidays.add(nthWeekdayOfMonth(year, 10, 1, 2));
  // Christmas & Boxing Day
  const xm = new Date(Date.UTC(year, 11, 25));
  if (xm.getUTCDay() === 5) {
    // Friday Christmas -> Boxing Day on following Monday
    holidays.add(`${year}-12-25`);
    holidays.add(`${year}-12-28`);
  } else if (xm.getUTCDay() === 6) {
    // Saturday Christmas -> Mon Dec 27, Tue Dec 28
    holidays.add(`${year}-12-27`);
    holidays.add(`${year}-12-28`);
  } else if (xm.getUTCDay() === 0) {
    // Sunday Christmas -> Mon Dec 26, Tue Dec 27
    holidays.add(`${year}-12-26`);
    holidays.add(`${year}-12-27`);
  } else {
    holidays.add(`${year}-12-25`);
    holidays.add(`${year}-12-26`);
  }
  return holidays;
}

const holidayCache = new Map<string, Set<string>>();

function getHolidaysForMarketYear(
  marketId: MarketId,
  year: number,
): Set<string> {
  const key = `${marketId}:${year}`;
  let cached = holidayCache.get(key);
  if (!cached) {
    const published = publishedCalendarYear(marketId, year);
    cached = published
      ? new Set(published.holidays)
      : marketId === "CA_TSX"
        ? getTsxHolidays(year)
        : getUsHolidays(year);
    holidayCache.set(key, cached);
  }
  return cached;
}

function isWeekday(date: Date): boolean {
  const dow = date.getUTCDay();
  return dow !== 0 && dow !== 6;
}

function isoDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * US early closes at 1:00 pm ET. Published NYSE/Nasdaq early-close dates are:
 * the Friday after Thanksgiving, July 3 when both July 3 and July 4 fall on a
 * weekday, and Christmas Eve when it is a weekday and not the observed holiday.
 * Ad-hoc closures (for example state funerals) are not modeled.
 */
export function getUsEarlyCloses(year: number): Set<string> {
  const earlyCloses = new Set<string>();
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
  earlyCloses.add(
    isoDate(new Date(Date.parse(`${thanksgiving}T00:00:00Z`) + 86_400_000)),
  );
  const july3 = new Date(Date.UTC(year, 6, 3));
  const july4 = new Date(Date.UTC(year, 6, 4));
  if (isWeekday(july3) && isWeekday(july4)) earlyCloses.add(`${year}-07-03`);
  const christmasEve = new Date(Date.UTC(year, 11, 24));
  if (
    isWeekday(christmasEve) &&
    !getHolidaysForMarketYear("US_EQUITIES", year).has(`${year}-12-24`)
  )
    earlyCloses.add(`${year}-12-24`);
  return earlyCloses;
}

/**
 * TSX early close at 1:00 pm ET on Christmas Eve when it is a trading day.
 * Recent TMX schedules keep New Year's Eve and the last trading day of the
 * year as full sessions, so no other recurring early close is modeled here.
 */
export function getTsxEarlyCloses(year: number): Set<string> {
  const earlyCloses = new Set<string>();
  const christmasEve = new Date(Date.UTC(year, 11, 24));
  if (
    isWeekday(christmasEve) &&
    !getHolidaysForMarketYear("CA_TSX", year).has(`${year}-12-24`)
  )
    earlyCloses.add(`${year}-12-24`);
  return earlyCloses;
}

const earlyCloseCache = new Map<string, Set<string>>();

function getEarlyClosesForMarketYear(
  marketId: MarketId,
  year: number,
): Set<string> {
  const key = `${marketId}:${year}`;
  let cached = earlyCloseCache.get(key);
  if (!cached) {
    const published = publishedCalendarYear(marketId, year);
    cached = published
      ? new Set(published.earlyCloses)
      : marketId === "CA_TSX"
        ? getTsxEarlyCloses(year)
        : getUsEarlyCloses(year);
    earlyCloseCache.set(key, cached);
  }
  return cached;
}

/**
 * Provenance for a set of session dates. Published schedules verify only the
 * years they cover; any uncovered date falls back to the unverified computed
 * rules so the evaluator stays fail-closed.
 */
export function calendarProvenanceFor(
  marketId: MarketId,
  tradingDates: readonly string[],
): CalendarProvenance {
  if (
    tradingDates.length > 0 &&
    publishedCalendarCovers(marketId, tradingDates)
  )
    return {
      verified: true,
      revision: publishedCalendarRevision(marketId),
      source: publishedCalendarSource(marketId).name,
    };
  return { ...COMPUTED_CALENDAR };
}

function isMarketEarlyClose(marketId: MarketId, dateStr: string): boolean {
  const year = Number(dateStr.slice(0, 4));
  return getEarlyClosesForMarketYear(marketId, year).has(dateStr);
}

/** Returns true if dateStr (YYYY-MM-DD) is a regular trading session (not a weekend or exchange holiday). */
export function isMarketTradingDay(
  dateStr: string,
  marketId: MarketId,
): boolean {
  const parts = dateStr.split("-");
  const year = Number(parts[0] ?? "2026");
  const month = Number(parts[1] ?? "1");
  const day = Number(parts[2] ?? "1");
  const date = new Date(Date.UTC(year, month - 1, day));
  const dow = date.getUTCDay();
  // Weekend
  if (dow === 0 || dow === 6) return false;
  // Holiday
  const holidays = getHolidaysForMarketYear(marketId, year);
  if (holidays.has(dateStr)) return false;
  // A Saturday January 1 is observed on the preceding Friday in December of
  // the prior year (US markets), which belongs to the next year's holiday set.
  const nextYearHolidays = getHolidaysForMarketYear(marketId, year + 1);
  if (nextYearHolidays.has(dateStr)) return false;
  return true;
}

/**
 * Generates an ordered list of regular trading sessions up to and including asOfDate.
 * Satisfies the requirement for at least 91 prior sessions for ATR and 10 sessions for RVOL.
 */
export function getRecentRegularSessions(
  marketId: MarketId,
  asOfDate: string,
  count = 110,
): CalendarSession[] {
  const timezone =
    marketId === "CA_TSX" ? "America/Toronto" : "America/New_York";
  const parts = asOfDate.split("-");
  const y = Number(parts[0] ?? "2026");
  const m = Number(parts[1] ?? "1");
  const d = Number(parts[2] ?? "1");
  let cursor = new Date(Date.UTC(y, m - 1, d));
  const tradingDates: string[] = [];

  // Step backward until count trading days are collected
  let iterations = 0;
  const maxIterations = count * 3;
  while (tradingDates.length < count && iterations < maxIterations) {
    iterations++;
    const curY = cursor.getUTCFullYear();
    const curM = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const curD = String(cursor.getUTCDate()).padStart(2, "0");
    const curDateStr = `${curY}-${curM}-${curD}`;
    if (isMarketTradingDay(curDateStr, marketId)) {
      tradingDates.push(curDateStr);
    }
    cursor = new Date(cursor.getTime() - 86_400_000);
  }

  // Reverse so they are in chronological ascending order
  tradingDates.reverse();

  return tradingDates.map((tradingDate) => ({
    tradingDate,
    open: zonedSessionBoundary(tradingDate, "09:30", timezone),
    close: zonedSessionBoundary(
      tradingDate,
      isMarketEarlyClose(marketId, tradingDate) ? "13:00" : "16:00",
      timezone,
    ),
  }));
}
