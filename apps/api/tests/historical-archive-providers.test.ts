import { describe, expect, it } from "vitest";
import {
  inRegularHours,
  localMidnight,
  monthChunks,
  nextLocalMidnight,
} from "../src/historical-archive/archive-importer.js";
import {
  discloseArchiveEvidence,
  discloseArchiveResult,
} from "../src/historical-archive/archive-disclosure.js";
import {
  MassiveHistoryClient,
  parseDatabentoCbbo,
} from "../src/historical-archive/provider-clients.js";
import type {
  BacktestEvidenceReport,
  BacktestReplayResult,
} from "@tsx-scanner/contracts";

describe("archive date helpers", () => {
  it("splits inclusive ranges at month boundaries", () => {
    expect(monthChunks("2026-07-31", "2026-09-18")).toEqual([
      ["2026-07-31", "2026-07-31"],
      ["2026-08-01", "2026-08-31"],
      ["2026-09-01", "2026-09-18"],
    ]);
  });

  it("resolves New York midnight across daylight-saving changes", () => {
    expect(localMidnight("2026-03-08").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(localMidnight("2026-03-09").toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
    expect(
      nextLocalMidnight(new Date("2026-11-01T04:00:00Z")).toISOString(),
    ).toBe("2026-11-02T05:00:00.000Z");
  });

  it("keeps samples after the open through the close", () => {
    expect(inRegularHours(new Date("2026-09-16T13:30:00Z"))).toBe(false);
    expect(inRegularHours(new Date("2026-09-16T13:31:00Z"))).toBe(true);
    expect(inRegularHours(new Date("2026-09-16T20:00:00Z"))).toBe(true);
    expect(inRegularHours(new Date("2026-09-16T20:01:00Z"))).toBe(false);
  });
});

describe("Databento cbbo parsing", () => {
  const header =
    "ts_recv,ts_event,rtype,publisher_id,instrument_id,side,price,size,flags,bid_px_00,ask_px_00,bid_sz_00,ask_sz_00,bid_pb_00,ask_pb_00,symbol";
  it("accepts minute samples and rejects invalid books individually", () => {
    const body = [
      header,
      "2026-09-16T13:31:00.000000000Z,2026-09-16T13:30:58.5Z,193,93,1,N,172.73,1,128,172.71,172.86,1,2300,81,81,COIN",
      "2026-09-16T13:32:00.000000000Z,x,193,93,1,N,1,1,128,172.9,172.8,1,1,81,81,COIN",
      "2026-09-16T13:33:00.000000000Z,x,193,93,1,N,1,1,128,,,0,0,81,81,COIN",
      "2026-09-16T13:34:00.500000000Z,x,193,93,1,N,1,1,128,172.7,172.8,1,1,81,81,COIN",
      "2026-09-16T13:35:00.000000000Z,x,193,93,1,N,1,1,128,172.7,172.8,1,1,81,81,OKTA",
    ].join("\n");
    const { records, rejected } = parseDatabentoCbbo(body, "COIN");
    expect(records).toEqual([
      {
        sampledAt: new Date("2026-09-16T13:31:00Z"),
        bid: 172.71,
        ask: 172.86,
        bidSize: 1,
        askSize: 2300,
      },
    ]);
    // Crossed, empty, off-minute and foreign-symbol rows.
    expect(rejected).toBe(4);
  });
});

describe("Massive aggregates client", () => {
  it("follows pagination, digests every page and drops invalid bars", async () => {
    const pages = [
      {
        status: "OK",
        results: [
          {
            t: Date.parse("2026-09-16T13:30:00Z"),
            o: 10,
            h: 10.5,
            l: 9.9,
            c: 10.2,
            v: 100.4,
            vw: 10.1,
            n: 3,
          },
          {
            t: Date.parse("2026-09-16T13:31:00Z"),
            o: 10,
            h: 9,
            l: 9.5,
            c: 10,
            v: 1,
          },
        ],
        next_url: "https://api.polygon.io/next-page",
      },
      {
        status: "OK",
        results: [
          {
            t: Date.parse("2026-09-16T13:32:00Z"),
            o: 10.2,
            h: 10.3,
            l: 10.1,
            c: 10.3,
            v: 50,
          },
        ],
      },
    ];
    const urls: string[] = [];
    const client = new MassiveHistoryClient({
      apiKey: "test",
      requestDelayMs: 0,
      sleep: async () => undefined,
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(pages[urls.length - 1]), {
          status: 200,
        });
      }) as typeof fetch,
    });
    const result = await client.aggregates(
      "COIN",
      "OneMinute",
      "2026-09-16",
      "2026-09-16",
      () => new Date(0),
    );
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(
      "/v2/aggs/ticker/COIN/range/1/minute/2026-09-16/2026-09-16?adjusted=false",
    );
    expect(result.requests).toBe(2);
    expect(result.rejected).toBe(1);
    expect(
      result.records.map((record) => record.startTime.toISOString()),
    ).toEqual(["2026-09-16T13:30:00.000Z", "2026-09-16T13:32:00.000Z"]);
    expect(result.records[0]).toMatchObject({
      volume: 100.4,
      vwap: 10.1,
      tradeCount: 3,
    });
    expect(result.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails on a non-OK provider status", async () => {
    const client = new MassiveHistoryClient({
      apiKey: "test",
      requestDelayMs: 0,
      fetch: (async () =>
        new Response(JSON.stringify({ status: "NOT_AUTHORIZED" }), {
          status: 403,
        })) as unknown as typeof fetch,
    });
    await expect(
      client.aggregates(
        "COIN",
        "OneMinute",
        "2020-06-01",
        "2020-06-01",
        () => new Date(0),
      ),
    ).rejects.toThrow("HTTP 403");
  });
});

describe("archive disclosure", () => {
  it("relabels captured spreads and never qualifies evidence", () => {
    const result = {
      dataQuality: {
        quoteSnapshots: 1,
        candles: 1,
        sessions: 1,
        spread: "CAPTURED",
        warnings: [],
      },
    } as unknown as BacktestReplayResult;
    expect(discloseArchiveResult(result).dataQuality.spread).toBe("ARCHIVED");
    const evidence = {
      qualification: "EVIDENCE_QUALIFIED",
      warnings: [],
    } as unknown as BacktestEvidenceReport;
    expect(discloseArchiveEvidence(evidence).qualification).toBe("EXPLORATORY");
  });
});

describe("archive import planning", () => {
  it("reports unresolved Databento symbols and keeps planning the rest", async () => {
    const instruments = [
      { id: "00000000-0000-4000-8000-000000000001", symbol: "NEW" },
      { id: "00000000-0000-4000-8000-000000000002", symbol: "OLD" },
    ];
    const { ProviderError } =
      await import("../src/historical-archive/provider-clients.js");
    const { runArchiveImport } =
      await import("../src/historical-archive/archive-importer.js");
    const summary = await runArchiveImport(
      {
        pool: { query: async () => ({ rows: instruments }) } as never,
        store: { importedRanges: async () => [] } as never,
        databento: {
          cost: async (symbol: string) => {
            if (symbol === "NEW")
              throw new ProviderError(
                'Databento metadata.get_cost failed with HTTP 422: {"detail":{"case":"symbology_invalid_request"}}',
                422,
              );
            return 0.01;
          },
        } as never,
        log: () => undefined,
      },
      {
        symbols: ["NEW", "OLD"],
        startDate: "2026-09-14",
        endDate: "2026-09-18",
        includeBenchmarks: false,
        maxCostUsd: 1,
        dryRun: true,
        bars: false,
        quotes: true,
        today: "2026-09-25",
      },
    );
    expect(summary.unresolved).toEqual([
      { symbol: "NEW", from: "2026-09-14", to: "2026-09-18" },
    ]);
    expect(summary.plannedChunks).toBe(1);
    expect(summary.estimatedCostUsd).toBe(0.01);
  });
});
