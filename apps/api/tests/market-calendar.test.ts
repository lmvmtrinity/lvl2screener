import { describe, expect, it } from "vitest";
import { discoveryCalendarSessionSchema } from "@tsx-scanner/contracts";
import {
  calendarProvenanceFor,
  getRecentRegularSessions,
  getTsxEarlyCloses,
  getTsxHolidays,
  getUsEarlyCloses,
  getUsHolidays,
  isMarketTradingDay,
} from "../src/universe/market-calendar.js";
import { publishedCalendarYear } from "../src/universe/published-calendars.js";

function localTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

describe("market-calendar", () => {
  it("computes US holidays correctly for 2025 and 2026", () => {
    const h2025 = getUsHolidays(2025);
    expect(h2025.has("2025-01-01")).toBe(true); // New Year
    expect(h2025.has("2025-01-20")).toBe(true); // MLK (3rd Mon)
    expect(h2025.has("2025-02-17")).toBe(true); // Presidents (3rd Mon)
    expect(h2025.has("2025-04-18")).toBe(true); // Good Friday
    expect(h2025.has("2025-05-26")).toBe(true); // Memorial (last Mon)
    expect(h2025.has("2025-06-19")).toBe(true); // Juneteenth
    expect(h2025.has("2025-07-04")).toBe(true); // Independence
    expect(h2025.has("2025-09-01")).toBe(true); // Labor (1st Mon)
    expect(h2025.has("2025-11-27")).toBe(true); // Thanksgiving (4th Thu)
    expect(h2025.has("2025-12-25")).toBe(true); // Christmas

    const h2026 = getUsHolidays(2026);
    expect(h2026.has("2026-04-03")).toBe(true); // Good Friday in 2026
    expect(h2026.has("2026-07-03")).toBe(true); // July 4 observed on Friday July 3
  });

  it("computes TSX holidays correctly for 2025 and 2026", () => {
    const h2025 = getTsxHolidays(2025);
    expect(h2025.has("2025-01-01")).toBe(true); // New Year
    expect(h2025.has("2025-02-17")).toBe(true); // Family Day (3rd Mon)
    expect(h2025.has("2025-04-18")).toBe(true); // Good Friday
    expect(h2025.has("2025-05-19")).toBe(true); // Victoria Day
    expect(h2025.has("2025-07-01")).toBe(true); // Canada Day
    expect(h2025.has("2025-08-04")).toBe(true); // Civic Holiday (1st Mon)
    expect(h2025.has("2025-09-01")).toBe(true); // Labour Day (1st Mon)
    expect(h2025.has("2025-10-13")).toBe(true); // Thanksgiving (2nd Mon)
    expect(h2025.has("2025-12-25")).toBe(true); // Christmas
    expect(h2025.has("2025-12-26")).toBe(true); // Boxing Day
  });

  it("excludes weekends from trading days", () => {
    expect(isMarketTradingDay("2026-09-12", "CA_TSX")).toBe(false); // Saturday
    expect(isMarketTradingDay("2026-09-13", "CA_TSX")).toBe(false); // Sunday
    expect(isMarketTradingDay("2026-09-11", "CA_TSX")).toBe(true); // Friday
  });

  it("generates recent regular sessions matching contract schemas and monotonic ordering", () => {
    const sessions = getRecentRegularSessions("CA_TSX", "2026-09-10", 110);
    expect(sessions.length).toBe(110);

    // Verify each session satisfies Zod contract schema
    for (const session of sessions) {
      expect(discoveryCalendarSessionSchema.parse(session)).toEqual(session);
      expect(Date.parse(session.open)).toBeLessThan(Date.parse(session.close));
    }

    // Verify chronological ordering
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1]!.tradingDate < sessions[i]!.tradingDate).toBe(
        true,
      );
      expect(
        Date.parse(sessions[i - 1]!.close) < Date.parse(sessions[i]!.open),
      ).toBe(true);
    }

    // Verify last session is on or before asOfDate
    expect(sessions.at(-1)?.tradingDate).toBe("2026-09-10");
  });

  it("generates US regular sessions correctly", () => {
    const sessions = getRecentRegularSessions("US_EQUITIES", "2026-09-10", 110);
    expect(sessions.length).toBe(110);
    expect(sessions.at(-1)?.tradingDate).toBe("2026-09-10");
    for (const session of sessions) {
      expect(discoveryCalendarSessionSchema.parse(session)).toEqual(session);
    }
  });

  it("observes weekend New Year holidays across the year boundary", () => {
    // TSX observes Saturday January 1 on the following Monday, not on the
    // preceding Friday (December 31, 2021 was a trading day).
    expect(getTsxHolidays(2022).has("2022-01-03")).toBe(true);
    expect(getTsxHolidays(2021).has("2021-12-31")).toBe(false);
    expect(isMarketTradingDay("2022-01-03", "CA_TSX")).toBe(false);
    expect(isMarketTradingDay("2021-12-31", "CA_TSX")).toBe(true);

    // US markets observe Saturday January 1 on the preceding Friday, which
    // belongs to the prior calendar year.
    expect(getUsHolidays(2028).has("2027-12-31")).toBe(true);
    expect(isMarketTradingDay("2021-12-31", "US_EQUITIES")).toBe(false);
    expect(isMarketTradingDay("2027-12-31", "US_EQUITIES")).toBe(false);
  });

  it("applies published early closes to generated sessions", () => {
    const usSessions = getRecentRegularSessions(
      "US_EQUITIES",
      "2026-12-31",
      400,
    );
    for (const date of ["2025-07-03", "2026-11-27", "2026-12-24"]) {
      const session = usSessions.find((s) => s.tradingDate === date);
      expect(session, `missing US session ${date}`).toBeDefined();
      expect(localTime(session!.open, "America/New_York")).toBe("09:30");
      expect(localTime(session!.close, "America/New_York")).toBe("13:00");
    }

    const tsxSessions = getRecentRegularSessions("CA_TSX", "2026-12-31", 400);
    const christmasEve = tsxSessions.find(
      (s) => s.tradingDate === "2025-12-24",
    );
    expect(christmasEve).toBeDefined();
    expect(localTime(christmasEve!.close, "America/Toronto")).toBe("13:00");
    const newYearsEve = tsxSessions.find((s) => s.tradingDate === "2025-12-31");
    expect(newYearsEve).toBeDefined();
    expect(localTime(newYearsEve!.close, "America/Toronto")).toBe("16:00");
  });

  it("distinguishes observed July 4 closures from July 3 early closes", () => {
    expect(isMarketTradingDay("2026-07-03", "US_EQUITIES")).toBe(false);
    expect(isMarketTradingDay("2025-07-03", "US_EQUITIES")).toBe(true);
  });

  it("matches the retained published schedules to the rule computation", () => {
    for (const marketId of ["CA_TSX", "US_EQUITIES"] as const) {
      for (const year of [2025, 2026]) {
        const published = publishedCalendarYear(marketId, year);
        expect(published).not.toBeNull();
        expect(new Set(published!.holidays)).toEqual(
          marketId === "CA_TSX" ? getTsxHolidays(year) : getUsHolidays(year),
        );
        expect(new Set(published!.earlyCloses)).toEqual(
          marketId === "CA_TSX"
            ? getTsxEarlyCloses(year)
            : getUsEarlyCloses(year),
        );
      }
    }
    // NYSE 2027 is published even though the TSX 2027 schedule is not yet.
    expect(
      new Set(publishedCalendarYear("US_EQUITIES", 2027)!.holidays),
    ).toEqual(getUsHolidays(2027));
    expect(
      new Set(publishedCalendarYear("US_EQUITIES", 2027)!.earlyCloses),
    ).toEqual(getUsEarlyCloses(2027));
  });

  it("verifies published coverage and fails closed outside it", () => {
    const ca = getRecentRegularSessions("CA_TSX", "2026-09-10", 110);
    const caProvenance = calendarProvenanceFor(
      "CA_TSX",
      ca.map((session) => session.tradingDate),
    );
    expect(caProvenance).toMatchObject({
      verified: true,
      source: "TMX_PUBLISHED_CALENDAR",
    });
    expect(caProvenance.revision).toMatch(/^exchange-published-[a-f0-9]{16}$/);

    const us = getRecentRegularSessions("US_EQUITIES", "2027-06-15", 110);
    expect(
      calendarProvenanceFor(
        "US_EQUITIES",
        us.map((session) => session.tradingDate),
      ).verified,
    ).toBe(true);

    const uncovered = getRecentRegularSessions("CA_TSX", "2024-09-10", 110);
    expect(
      calendarProvenanceFor(
        "CA_TSX",
        uncovered.map((session) => session.tradingDate),
      ),
    ).toEqual({
      verified: false,
      revision: "market-calendar-v1",
      source: "computed-session-rules-v1",
    });
  });
});
