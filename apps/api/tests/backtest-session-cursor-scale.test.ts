import { describe, expect, it } from "vitest";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";

/** W8 acceptance fixture: a 30-session / 150-symbol synthetic backtest must be processable without
 * loading the whole run's history into memory at once. This is a structural test, not a live-DB
 * timing test (the plan explicitly warns against fragile fine-grained timing assertions on shared
 * CI): it proves boundedness by construction -- each simulated Postgres round trip only ever
 * returns one Toronto session's worth of rows (150 symbols x a small, fixed quote count), never
 * the whole run's -- and backs that with a generous, headroom-heavy wall-clock budget and a
 * process memory-growth ceiling as a coarse secondary signal.
 */
const SESSION_COUNT = 30;
const SYMBOL_COUNT = 150;
const QUOTES_PER_SYMBOL_PER_SESSION = 10;
const MAX_ROWS_PER_QUERY_CALL =
  SYMBOL_COUNT * QUOTES_PER_SYMBOL_PER_SESSION * 2; // generous headroom

function syntheticInstrumentIds(): string[] {
  return Array.from(
    { length: SYMBOL_COUNT },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
}

// 30 consecutive calendar days from 2026-06-01.
function sessionDates(): string[] {
  const dates: string[] = [];
  const start = new Date("2026-06-01T00:00:00Z");
  for (let index = 0; index < SESSION_COUNT; index++) {
    const day = new Date(start.getTime() + index * 86_400_000);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

function syntheticReplayInput(instrumentIds: string[]) {
  return {
    version: "replay-input-v1" as const,
    marketId: "CA_TSX" as const,
    resolvedAt: "2026-08-25T00:00:00.000Z",
    inputHash: "0".repeat(64),
    requestedSymbols: instrumentIds.map((_, index) => `SYM${index}.TO`),
    candidateInstruments: instrumentIds.map((instrumentId, index) => ({
      instrumentId,
      symbol: `SYM${index}.TO`,
      sector: "Materials",
    })),
    benchmarks: [],
    universeRefreshRunId: null,
    capturedHistoryAvailability: {
      source: "CAPTURED_QUOTES" as const,
      observedAt: "2026-08-25T00:00:00.000Z",
      tables: {
        quoteSnapshot: {
          earliest: "2026-06-01T13:30:00.000Z",
          latest: "2026-06-30T20:00:00.000Z",
        },
        candle: { earliest: null, latest: null },
      },
      replay: { earliestDate: "2026-06-01", latestDate: "2026-06-30" },
    },
    warnings: [],
    candidateProvenance: "CURRENT_ACTIVE_UNIVERSE" as const,
    sessions: [],
  };
}

function quoteRow(instrumentId: string, date: string, index: number) {
  return {
    instrument_id: instrumentId,
    symbol: "",
    session_date: date,
    timestamp: new Date(
      `${date}T13:${String(30 + index).padStart(2, "0")}:00.000Z`,
    ),
    bid: "10",
    ask: "10.01",
    bid_size: "1000",
    ask_size: "1000",
    spread_absolute: "0.01",
    last: "10",
    day_open: "10",
    day_high: "10",
    day_low: "10",
    day_volume: "1000",
    is_delayed: false,
    is_halted: false,
    delay_seconds: null,
  };
}

describe("W8 acceptance: 30-session / 150-symbol synthetic backtest stays session-bounded", () => {
  it("never asks Postgres for more than one session's rows per round trip, and finishes within a generous budget", async () => {
    const instrumentIds = syntheticInstrumentIds();
    const dates = sessionDates();
    const replayInput = syntheticReplayInput(instrumentIds);
    let maxRowsReturned = 0;
    let queryCount = 0;

    const pool = {
      query: async (query: string, params: unknown[]) => {
        queryCount++;
        if (query.includes("DISTINCT")) {
          const rows = dates.map((session_date) => ({ session_date }));
          maxRowsReturned = Math.max(maxRowsReturned, rows.length);
          return { rows };
        }
        if (query.includes("FROM quote_snapshot")) {
          const date = params[1] as string;
          const rows = instrumentIds.flatMap((instrumentId) =>
            Array.from({ length: QUOTES_PER_SYMBOL_PER_SESSION }, (_, index) =>
              quoteRow(instrumentId, date, index),
            ),
          );
          maxRowsReturned = Math.max(maxRowsReturned, rows.length);
          return { rows };
        }
        if (query.includes("FROM candle")) return { rows: [] };
        throw new Error(`Unexpected query: ${query}`);
      },
    };
    const store = new PostgresBacktestStore(pool as never);
    const policy = {
      timezone: "America/Toronto" as const,
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:45", end: "12:00" },
      entries: {
        preferredStart: "10:00",
        preferredEnd: "11:30",
        hardEnd: "12:00",
      },
    };

    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();

    const sessionDatesFound = await store.loadReplaySessionDates(
      {
        marketId: "CA_TSX",
        startDate: dates[0]!,
        endDate: dates.at(-1)!,
      } as never,
      replayInput,
    );
    expect(sessionDatesFound).toHaveLength(SESSION_COUNT);

    let sessionsProcessed = 0;
    for (const date of sessionDatesFound) {
      const session = (await store.loadReplaySession(
        replayInput,
        policy,
        date,
      )) as {
        quotes: unknown[];
      };
      expect(session.quotes).toHaveLength(
        SYMBOL_COUNT * QUOTES_PER_SYMBOL_PER_SESSION,
      );
      sessionsProcessed++;
      // The defining W8 property: this loop holds at most one session's data live at a time --
      // nothing here accumulates across iterations the way the old bulk loadReplayData query did.
    }

    const elapsedMs = performance.now() - startedAt;
    const heapGrowthMb =
      (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

    expect(sessionsProcessed).toBe(SESSION_COUNT);
    // 1 dates query + 2 (quotes, candles) per session -- never one query covering the whole range.
    expect(queryCount).toBe(1 + SESSION_COUNT * 2);
    expect(maxRowsReturned).toBeLessThanOrEqual(MAX_ROWS_PER_QUERY_CALL);
    // Generous headroom budgets, not fine-grained timing: this is an in-process synthetic fixture
    // with no real I/O, so it should be fast, but the assertion only guards against a gross
    // regression (e.g. accidentally buffering all 30 sessions before processing any).
    expect(elapsedMs).toBeLessThan(5_000);
    expect(heapGrowthMb).toBeLessThan(256);
  });
});
