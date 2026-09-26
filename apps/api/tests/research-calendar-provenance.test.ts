import { describe, expect, it } from "vitest";
import {
  calendarPolicyHashFor,
  calendarProvenanceForAt,
  calendarSessionBoundaryFor,
  legacyCalendarPolicyHash,
} from "../src/universe/market-calendar.js";
import {
  publishedCalendarRetrievedAtFor,
  publishedCalendarSource,
  publishedCalendarSourceHashFor,
  type PublishedCalendarSource,
} from "../src/universe/published-calendars.js";
import { buildSessionPayload } from "../src/backtests/backtest-repository.js";

const regularPolicy = {
  marketId: "US_EQUITIES" as const,
  timezone: "America/New_York" as const,
  openingRange: { start: "09:30", end: "09:45" },
  scanning: { start: "09:30", end: "16:00" },
  entries: {
    preferredStart: "09:45",
    preferredEnd: "11:30",
    hardEnd: "15:30",
  },
};

describe("research calendar provenance", () => {
  it("canonicalizes the full published source independently of object key order", () => {
    const source = publishedCalendarSource("CA_TSX");
    const reordered = {
      years: source.years,
      sources: source.sources,
      name: source.name,
      marketId: source.marketId,
    } as PublishedCalendarSource;
    expect(publishedCalendarSourceHashFor(source)).toMatch(/^[a-f0-9]{64}$/);
    expect(publishedCalendarSourceHashFor(reordered)).toBe(
      publishedCalendarSourceHashFor(source),
    );
    expect(
      publishedCalendarSourceHashFor({
        ...source,
        sources: source.sources.map((value) => ({
          ...value,
          retrievedAt: "2026-09-12",
        })),
      }),
    ).not.toBe(publishedCalendarSourceHashFor(source));
  });

  it("fails closed when any retained source retrieval date is missing or invalid", () => {
    const source = publishedCalendarSource("CA_TSX");
    expect(
      publishedCalendarRetrievedAtFor({
        ...source,
        sources: [{ ...source.sources[0]!, retrievedAt: "" }],
      }),
    ).toBeNull();
    expect(
      publishedCalendarRetrievedAtFor({
        ...source,
        sources: [
          { ...source.sources[0]!, retrievedAt: "2026-09-11T12:00:00Z" },
        ],
      }),
    ).toBeNull();
  });

  it("returns a full authoritative hash and exact regular session boundary", () => {
    const evidence = calendarProvenanceForAt(
      "CA_TSX",
      ["2026-09-09"],
      "2026-09-12T00:00:00.000Z",
    );
    expect(evidence.verified).toBe(true);
    expect(evidence.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.sessions).toEqual([
      {
        tradingDate: "2026-09-09",
        open: "2026-09-09T13:30:00.000Z",
        close: "2026-09-09T20:00:00.000Z",
      },
    ]);
  });

  it("uses the published early close without changing the replay policy", () => {
    const boundary = calendarSessionBoundaryFor("US_EQUITIES", "2026-11-27");
    expect(boundary).toEqual({
      tradingDate: "2026-11-27",
      open: "2026-11-27T14:30:00.000Z",
      close: "2026-11-27T18:00:00.000Z",
    });
    const payload = buildSessionPayload(
      "2026-11-27",
      [],
      [],
      [],
      regularPolicy,
      boundary,
    );
    expect((payload.session as { endTime: string }).endTime).toBe(
      "2026-11-27T18:00:00.000Z",
    );
    expect((payload.session as { scanning: unknown }).scanning).toEqual(
      regularPolicy.scanning,
    );
  });

  it("fails closed before or on the retained calendar retrieval date", () => {
    for (const cutoff of [
      "2026-09-10T23:59:59.999Z",
      "2026-09-11T23:59:59.999Z",
    ]) {
      const evidence = calendarProvenanceForAt(
        "CA_TSX",
        ["2026-09-09"],
        cutoff,
      );
      expect(evidence.verified).toBe(false);
      expect(evidence.sourceHash).toBeNull();
    }
  });

  it("fails closed for an uncovered year and a holiday", () => {
    const uncovered = calendarProvenanceForAt(
      "CA_TSX",
      ["2024-09-09"],
      "2026-09-12T00:00:00.000Z",
    );
    expect(uncovered.verified).toBe(false);
    expect(uncovered.sourceHash).toBeNull();
    expect(calendarSessionBoundaryFor("CA_TSX", "2026-09-07")).toBeNull();
  });

  it("binds market, source, sessions and cutoff into a deterministic new policy hash", () => {
    const input = {
      marketId: "US_EQUITIES" as const,
      timezone: "America/New_York" as const,
      sessionDates: ["2026-11-27"],
      inputCutoff: "2026-09-12T00:00:00.000Z",
    };
    const hash = calendarPolicyHashFor(input);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(calendarPolicyHashFor(input)).toBe(hash);
    expect(
      calendarPolicyHashFor({
        ...input,
        marketId: "CA_TSX",
        timezone: "America/Toronto",
      }),
    ).not.toBe(hash);
    expect(
      calendarPolicyHashFor({
        ...input,
        inputCutoff: "2026-09-13T00:00:00.000Z",
      }),
    ).not.toBe(hash);
    expect(legacyCalendarPolicyHash("America/New_York")).not.toBe(hash);
    expect(legacyCalendarPolicyHash("America/New_York")).toBe(
      // This is the exact identity used by pre-calendar-bound recipes.
      "2696958c42e2cfdf00dcdb050c1e6d90afcfe27943353ca85a48d122da65be73",
    );
  });
});
