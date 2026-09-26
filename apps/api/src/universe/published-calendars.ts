import { createHash } from "node:crypto";
import type { MarketId } from "@tsx-scanner/contracts";

export interface PublishedCalendarYear {
  /** Exchange closure dates (YYYY-MM-DD), including observed holidays. */
  readonly holidays: readonly string[];
  /** Regular sessions that close early (YYYY-MM-DD), currently 13:00 ET. */
  readonly earlyCloses: readonly string[];
}

export interface PublishedCalendarSource {
  readonly marketId: MarketId;
  readonly name: string;
  readonly sources: readonly { url: string; retrievedAt: string }[];
  readonly years: Readonly<Record<number, PublishedCalendarYear>>;
}

/**
 * Retained exchange-published schedules. This is the authoritative calendar
 * evidence for the covered years; the rule computation in `market-calendar.ts`
 * remains only as an uncovered-range fallback and for consistency tests.
 *
 * Additions or corrections must update this data (and therefore the
 * content-addressed revision) rather than mutating behavior elsewhere.
 */
const TSX_SOURCE: PublishedCalendarSource = {
  marketId: "CA_TSX",
  name: "TMX_PUBLISHED_CALENDAR",
  sources: [
    {
      url: "https://www.tsx.com/en/trading/calendars-and-trading-hours/calendar",
      retrievedAt: "2026-09-11",
    },
  ],
  years: {
    2025: {
      holidays: [
        "2025-01-01",
        "2025-02-17",
        "2025-04-18",
        "2025-05-19",
        "2025-07-01",
        "2025-08-04",
        "2025-09-01",
        "2025-10-13",
        "2025-12-25",
        "2025-12-26",
      ],
      earlyCloses: ["2025-12-24"],
    },
    2026: {
      holidays: [
        "2026-01-01",
        "2026-02-16",
        "2026-04-03",
        "2026-05-18",
        "2026-07-01",
        "2026-08-03",
        "2026-09-07",
        "2026-10-12",
        "2026-12-25",
        "2026-12-28",
      ],
      earlyCloses: ["2026-12-24"],
    },
  },
};

const NYSE_SOURCE: PublishedCalendarSource = {
  marketId: "US_EQUITIES",
  name: "NYSE_PUBLISHED_CALENDAR",
  sources: [
    {
      url: "https://www.nyse.com/markets/hours-calendars",
      retrievedAt: "2026-09-11",
    },
    {
      url: "https://www.nasdaq.com/press-release/nyse-group-announces-2025-2026-and-2027-holiday-and-early-closings-calendar-2024-11",
      retrievedAt: "2026-09-11",
    },
  ],
  years: {
    2025: {
      holidays: [
        "2025-01-01",
        "2025-01-20",
        "2025-02-17",
        "2025-04-18",
        "2025-05-26",
        "2025-06-19",
        "2025-07-04",
        "2025-09-01",
        "2025-11-27",
        "2025-12-25",
      ],
      earlyCloses: ["2025-07-03", "2025-11-28", "2025-12-24"],
    },
    2026: {
      holidays: [
        "2026-01-01",
        "2026-01-19",
        "2026-02-16",
        "2026-04-03",
        "2026-05-25",
        "2026-06-19",
        "2026-07-03",
        "2026-09-07",
        "2026-11-26",
        "2026-12-25",
      ],
      earlyCloses: ["2026-11-27", "2026-12-24"],
    },
    2027: {
      holidays: [
        "2027-01-01",
        "2027-01-18",
        "2027-02-15",
        "2027-03-26",
        "2027-05-31",
        "2027-06-18",
        "2027-07-05",
        "2027-09-06",
        "2027-11-25",
        "2027-12-24",
      ],
      earlyCloses: ["2027-11-26"],
    },
  },
};

const SOURCES: Readonly<Record<MarketId, PublishedCalendarSource>> = {
  CA_TSX: TSX_SOURCE,
  US_EQUITIES: NYSE_SOURCE,
};

export function publishedCalendarSource(
  marketId: MarketId,
): PublishedCalendarSource {
  return SOURCES[marketId];
}

export function publishedCalendarYear(
  marketId: MarketId,
  year: number,
): PublishedCalendarYear | null {
  return SOURCES[marketId].years[year] ?? null;
}

/**
 * Content-addressed revision. Any change to the retained schedule data changes
 * this value, so evidence tied to a previous revision cannot be silently reused.
 */
export function publishedCalendarRevision(marketId: MarketId): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(SOURCES[marketId]))
    .digest("hex");
  return `exchange-published-${digest.slice(0, 16)}`;
}

/** Full content identity for consumers whose contract requires a SHA-256 hash. */
export function publishedCalendarSourceHash(marketId: MarketId): string {
  return publishedCalendarSourceHashFor(SOURCES[marketId]);
}

/** Full content identity for a retained source object. Object key order is not
 * part of the evidence identity, while array order remains meaningful. */
export function publishedCalendarSourceHashFor(
  source: PublishedCalendarSource,
): string {
  return createHash("sha256")
    .update(canonicalPublishedCalendarJson(source))
    .digest("hex");
}

/** Latest retained source retrieval date. The source is date-granular, so callers
 * must treat the whole date as unavailable until the following date. */
export function publishedCalendarRetrievedAt(
  marketId: MarketId,
): string | null {
  return publishedCalendarRetrievedAtFor(SOURCES[marketId]);
}

/** Return the latest retained retrieval date only when every source entry is
 * present and valid. Partial metadata must remain unverified. */
export function publishedCalendarRetrievedAtFor(
  source: PublishedCalendarSource,
): string | null {
  if (
    source.sources.length === 0 ||
    source.sources.some((entry) => !isValidCalendarDate(entry.retrievedAt))
  )
    return null;
  return (
    source.sources
      .map((entry) => entry.retrievedAt)
      .sort()
      .at(-1) ?? null
  );
}

export function publishedCalendarCovers(
  marketId: MarketId,
  tradingDates: readonly string[],
): boolean {
  return tradingDates.every(
    (tradingDate) =>
      publishedCalendarYear(marketId, Number(tradingDate.slice(0, 4))) !== null,
  );
}

function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}

function canonicalPublishedCalendarJson(value: unknown): string {
  return JSON.stringify(canonicalPublishedCalendarValue(value));
}

function canonicalPublishedCalendarValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) return value.map(canonicalPublishedCalendarValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => {
          if (record[key] === undefined)
            throw new Error("UNSUPPORTED_CALENDAR_IDENTITY_VALUE");
          return [key, canonicalPublishedCalendarValue(record[key])];
        }),
    );
  }
  throw new Error("UNSUPPORTED_CALENDAR_IDENTITY_VALUE");
}
