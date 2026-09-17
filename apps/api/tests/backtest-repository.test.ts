import { describe, expect, it } from "vitest";
import {
  PostgresBacktestStore,
  buildSessionPayload,
} from "../src/backtests/backtest-repository.js";

const historicalId = "10000000-0000-4000-8000-000000000081";
const benchmarkId = "10000000-0000-4000-8000-000000000082";
const availability = {
  source: "CAPTURED_QUOTES" as const,
  observedAt: "2026-08-25T00:00:00.000Z",
  tables: {
    quoteSnapshot: {
      earliest: "2026-08-01T13:30:00.000Z",
      latest: "2026-08-25T20:00:00.000Z",
    },
    candle: { earliest: null, latest: null },
  },
  replay: { earliestDate: "2026-08-01", latestDate: "2026-08-25" },
};

describe("PostgresBacktestStore replay input snapshots", () => {
  it("keeps backtest_run INSERT bindings aligned with its target columns", async () => {
    let statement = "";
    let parameters: unknown[] = [];
    const store = new PostgresBacktestStore({
      query: async (query: string, values: unknown[]) => {
        statement = query;
        parameters = values;
        throw new Error("capture insert");
      },
    } as never);
    await expect(
      store.create(
        {
          name: "US smoke",
          marketId: "US_EQUITIES",
          startDate: "2026-09-04",
          endDate: "2026-09-04",
          strategies: ["ORB_RETEST"],
          symbols: ["EFX"],
          dataSource: "CAPTURED_QUOTES",
          startingCapital: 100_000,
          positionSize: 10_000,
          slippageBps: 2,
          feePerTrade: 0,
          parameters: {},
        } as never,
        "config-v1",
        availability as never,
        { marketId: "US_EQUITIES" } as never,
      ),
    ).rejects.toThrow("capture insert");
    expect(parameters).toHaveLength(19);
    expect(statement).toContain("$19::jsonb");
  });

  it("rejects replay input that belongs to another market before querying history", async () => {
    const store = new PostgresBacktestStore({
      query: async () => ({ rows: [] }),
    } as never);
    await expect(
      store.loadReplaySessionDates(
        {
          marketId: "US_EQUITIES",
          startDate: "2026-08-25",
          endDate: "2026-08-25",
        } as never,
        { marketId: "CA_TSX" } as never,
      ),
    ).rejects.toThrow("belongs to another market");
  });

  it("keeps an inactive requested candidate and benchmark context out of live active-list lookups", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (query: string) => {
        queries.push(query);
        if (query.includes("FROM instrument")) {
          const candidate = {
            id: historicalId,
            symbol: "HIST.TO",
            industry_sector: "Materials",
            benchmark_kind: null,
            benchmark_sector: null,
          };
          const benchmark = {
            id: benchmarkId,
            symbol: "XIU.TO",
            industry_sector: null,
            benchmark_kind: "MARKET",
            benchmark_sector: null,
          };
          return {
            rows: query.includes("benchmark_kind IS NOT NULL")
              ? [benchmark]
              : [candidate],
          };
        }
        if (query.includes("FROM universe_refresh_run")) return { rows: [] };
        if (query.includes("FROM quote_snapshot"))
          return {
            rows: [historicalQuote(historicalId), historicalQuote(benchmarkId)],
          };
        if (query.includes("FROM candle")) return { rows: [] };
        throw new Error(`Unexpected query: ${query}`);
      },
    };
    const store = new PostgresBacktestStore(pool as never);
    const input = {
      name: "historical",
      startDate: "2026-08-25",
      endDate: "2026-08-25",
      strategies: ["ORB_RETEST"] as const,
      symbols: ["HIST.TO"],
      dataSource: "CAPTURED_QUOTES" as const,
      startingCapital: 100_000,
      positionSize: 10_000,
      slippageBps: 2,
      feePerTrade: 9.95,
      parameters: {},
    };
    const snapshot = await store.resolveReplayInput(
      input as never,
      availability,
    );
    expect(snapshot.candidateInstruments).toEqual([
      { instrumentId: historicalId, symbol: "HIST.TO", sector: "Materials" },
    ]);
    expect(snapshot.benchmarks).toMatchObject([
      { instrumentId: benchmarkId, kind: "MARKET", symbol: "XIU.TO" },
    ]);
    expect(
      queries.find((query) => query.includes("FROM instrument")),
    ).not.toContain("WHERE active=TRUE");

    const replay = (await store.loadReplayData(input as never, snapshot, {
      timezone: "America/Toronto",
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:45", end: "12:00" },
      entries: {
        preferredStart: "10:00",
        preferredEnd: "11:30",
        hardEnd: "12:00",
      },
    })) as {
      sessions: Array<{
        session: { instruments: Array<{ symbol: string; role: string }> };
      }>;
    };
    expect(replay.sessions[0]?.session.instruments).toEqual(
      expect.arrayContaining([
        {
          instrumentId: historicalId,
          symbol: "HIST.TO",
          sector: "Materials",
          role: "CANDIDATE",
          benchmarkKind: null,
          benchmarkSector: null,
        },
        {
          instrumentId: benchmarkId,
          symbol: "XIU.TO",
          sector: null,
          role: "BENCHMARK",
          benchmarkKind: "MARKET",
          benchmarkSector: null,
        },
      ]),
    );
    expect(queries.slice(2).join("\n")).not.toContain("JOIN instrument");
  });

  it("loads replay history one Toronto session at a time (W8 session-cursor path)", async () => {
    const replayInput = {
      version: "replay-input-v1" as const,
      marketId: "CA_TSX" as const,
      resolvedAt: "2026-08-25T00:00:00.000Z",
      inputHash: "hash",
      requestedSymbols: ["HIST.TO"],
      candidateInstruments: [
        { instrumentId: historicalId, symbol: "HIST.TO", sector: "Materials" },
      ],
      benchmarks: [],
      universeRefreshRunId: null,
      capturedHistoryAvailability: availability,
      warnings: [],
      candidateProvenance: "CURRENT_ACTIVE_UNIVERSE" as const,
      sessions: [],
    };
    const dates = ["2026-08-24", "2026-08-25"];
    const calls: string[] = [];
    const pool = {
      query: async (query: string, params: unknown[]) => {
        calls.push(query);
        if (query.includes("DISTINCT")) {
          return { rows: dates.map((session_date) => ({ session_date })) };
        }
        if (query.includes("FROM quote_snapshot")) {
          const date = params[1] as string;
          return {
            rows: [{ ...historicalQuote(historicalId), session_date: date }],
          };
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

    const foundDates = await store.loadReplaySessionDates(
      {
        marketId: "CA_TSX",
        startDate: "2026-08-24",
        endDate: "2026-08-25",
      } as never,
      replayInput,
    );
    expect(foundDates).toEqual(dates);
    expect(calls).toHaveLength(1); // the dates query never touches quote/candle rows

    calls.length = 0;
    const oneSession = (await store.loadReplaySession(
      replayInput,
      policy,
      "2026-08-24",
    )) as {
      session: { startTime: string; marketId: string };
      quotes: Array<{ bidSize: number; askSize: number; spread: number }>;
    };
    // Exactly two round trips (quotes, candles) for one session -- never the whole range at once.
    expect(calls).toHaveLength(2);
    expect(oneSession.session.marketId).toBe("CA_TSX");
    expect(oneSession.quotes).toHaveLength(1);
    expect(oneSession.quotes[0]).toMatchObject({
      bidSize: 1200,
      askSize: 800,
      spread: 0.01,
    });

    calls.length = 0;
    const bulk = (await store.loadReplayData(
      {
        marketId: "CA_TSX",
        startDate: "2026-08-24",
        endDate: "2026-08-25",
      } as never,
      replayInput,
      policy,
    )) as { sessions: unknown[] };
    // 1 dates query + 2 queries per session, built on the very same per-session method above.
    expect(calls).toHaveLength(1 + dates.length * 2);
    expect(bulk.sessions).toHaveLength(2);
  });

  it("reports a bounded interior no-quote gap with its evaluated window", async () => {
    const gapCalls: Array<{ market: string; sessionCount: number }> = [];
    const pool = {
      query: async (query: string, params: unknown[]) => {
        if (query.includes("session_quotes")) {
          const sessions = JSON.parse(String(params[3])) as unknown[];
          gapCalls.push({
            market: String(params[0]),
            sessionCount: sessions.length,
          });
          return params[0] === "CA_TSX"
            ? {
                rows: [
                  {
                    previous_at: new Date("2026-09-14T13:39:05.524Z"),
                    timestamp: new Date("2026-09-14T15:25:29.153Z"),
                    session_date: "2026-09-14",
                  },
                ],
              }
            : { rows: [] };
        }
        return {
          rows: [
            {
              source: "quoteSnapshot",
              earliest: new Date("2026-08-01T13:30:00.000Z"),
              latest: new Date("2026-09-14T15:25:29.153Z"),
            },
            {
              source: "candle",
              earliest: new Date("2026-06-15T13:30:00.000Z"),
              latest: new Date("2026-09-14T20:00:00.000Z"),
            },
          ],
        };
      },
    };
    const store = new PostgresBacktestStore(pool as never);

    const ca = await store.getCapturedHistoryAvailability("CA_TSX");
    expect(ca.limitations).toEqual([
      expect.objectContaining({
        marketId: "CA_TSX",
        kind: "INTERIOR_NO_QUOTE",
        basis: "QUOTE_GAP_WITH_BACKFILLED_CANDLES",
        startAt: "2026-09-14T13:39:05.524Z",
        endAt: "2026-09-14T15:25:29.153Z",
        sessionDates: ["2026-09-14"],
      }),
    ]);
    expect(ca.limitations?.[0]?.evaluatedFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ca.limitations?.[0]?.evaluatedThrough).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );

    // The bounded assessment is reused briefly; a repeat call does not rescan.
    const caAgain = await store.getCapturedHistoryAvailability("CA_TSX");
    expect(caAgain.limitations).toEqual(ca.limitations);

    // A market switch evaluates separately and never borrows the other market's gap.
    const us = await store.getCapturedHistoryAvailability("US_EQUITIES");
    expect(us.limitations).toEqual([]);
    expect(gapCalls.map((call) => call.market)).toEqual([
      "CA_TSX",
      "US_EQUITIES",
    ]);
    expect(gapCalls.every((call) => call.sessionCount > 0)).toBe(true);
  });

  it("skips the interior assessment when no quotes are retained", async () => {
    let gapQueries = 0;
    const pool = {
      query: async (query: string) => {
        if (query.includes("session_quotes")) {
          gapQueries += 1;
          return { rows: [] };
        }
        return {
          rows: [
            { source: "quoteSnapshot", earliest: null, latest: null },
            { source: "candle", earliest: null, latest: null },
          ],
        };
      },
    };
    const store = new PostgresBacktestStore(pool as never);
    const availability = await store.getCapturedHistoryAvailability("CA_TSX");
    expect(availability.replay).toEqual({
      earliestDate: null,
      latestDate: null,
    });
    expect(availability.limitations).toEqual([]);
    expect(gapQueries).toBe(0);
  });

  it("uses the published session calendar for holidays and early closes", async () => {
    let gapSql = "";
    let sessionsParam: unknown;
    const pool = {
      query: async (query: string, params: unknown[]) => {
        if (query.includes("session_quotes")) {
          gapSql = query;
          sessionsParam = params[3];
          return { rows: [] };
        }
        return {
          rows: [
            {
              source: "quoteSnapshot",
              earliest: new Date("2025-10-01T13:30:00.000Z"),
              latest: new Date("2025-11-28T19:00:00.000Z"),
            },
            {
              source: "candle",
              earliest: new Date("2025-10-01T13:30:00.000Z"),
              latest: new Date("2025-11-28T19:00:00.000Z"),
            },
          ],
        };
      },
    };
    const store = new PostgresBacktestStore(pool as never);
    const availability = await store.getCapturedHistoryAvailability(
      "US_EQUITIES",
      { now: new Date("2025-11-29T12:00:00.000Z") },
    );
    expect(availability.limitations).toEqual([]);
    expect(gapSql).toContain("session_windows");
    const sessions = JSON.parse(String(sessionsParam)) as Array<{
      sessionDate: string;
      openAt: string;
      closeAt: string;
    }>;
    // Thanksgiving 2025-11-27 is a holiday; 2025-11-28 is a 13:00 ET early close.
    expect(sessions.some((value) => value.sessionDate === "2025-11-27")).toBe(
      false,
    );
    expect(
      sessions.find((value) => value.sessionDate === "2025-11-28"),
    ).toEqual({
      sessionDate: "2025-11-28",
      openAt: "2025-11-28T14:30:00.000Z",
      closeAt: "2025-11-28T18:00:00.000Z",
    });
  });

  it("carries the market identity into the session payload Python validates", () => {
    const payload = buildSessionPayload(
      "2026-09-04",
      [
        {
          instrumentId: historicalId,
          symbol: "EFX",
          sector: null,
          benchmarkKind: null,
          benchmarkSector: null,
        },
      ],
      [{ ...historicalQuote(historicalId), session_date: "2026-09-04" }],
      [],
      {
        marketId: "US_EQUITIES",
        timezone: "America/New_York",
        openingRange: { start: "09:30", end: "09:45" },
        scanning: { start: "09:45", end: "16:00" },
        entries: {
          preferredStart: "10:00",
          preferredEnd: "11:30",
          hardEnd: "16:00",
        },
      },
    ) as {
      session: { marketId: string; market: string; timezone: string };
    };
    expect(payload.session).toMatchObject({
      marketId: "US_EQUITIES",
      market: "US_EQUITIES",
      timezone: "America/New_York",
    });
  });
});

function historicalQuote(instrumentId: string) {
  return {
    instrument_id: instrumentId,
    symbol: "",
    session_date: "2026-08-25",
    timestamp: new Date("2026-08-25T13:30:00.000Z"),
    bid: "10",
    ask: "10.01",
    bid_size: "1200",
    ask_size: "800",
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
