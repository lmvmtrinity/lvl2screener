import { afterEach, expect, it, vi } from "vitest";
import { ScannerFeatureClient } from "../src/market-data/scanner-client.js";
import type { PersistedInstrument } from "../src/market-data/repository.js";
import type { Candle } from "../src/questrade/types.js";

afterEach(() => vi.unstubAllGlobals());

const instrument = {
  id: "10000000-0000-4000-8000-000000000001",
  symbolId: 1,
  symbol: "AA",
  marketId: "US_EQUITIES",
  description: "AA",
  securityType: "Stock",
  exchange: "NYSE",
  currency: "USD",
  isQuotable: true,
  isTradable: true,
  active: true,
} satisfies PersistedInstrument;
const candles: Candle[] = Array.from({ length: 12_001 }, (_, index) => ({
  symbolId: 1,
  interval: "OneMinute",
  start: new Date(Date.UTC(2026, 8, 1) + index * 60_000),
  end: new Date(Date.UTC(2026, 8, 1) + (index + 1) * 60_000),
  open: 50,
  high: 51,
  low: 49,
  close: 50,
  volume: index,
  source: "QUESTRADE",
  isComplete: true,
}));

it("uploads large history sequentially without losing candle order or market ownership", async () => {
  const received: Array<{
    marketId: string;
    candles: Array<{ volume: number }>;
  }> = [];
  let inFlight = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      expect(inFlight).toBe(false);
      inFlight = true;
      received.push(JSON.parse(init.body));
      await Promise.resolve();
      inFlight = false;
      return new Response(null, { status: 204 });
    }),
  );
  await new ScannerFeatureClient(new URL("http://scanner:8000")).ingestCandles(
    candles,
    [instrument],
  );
  expect(received.map((batch) => batch.candles.length)).toEqual([
    5000, 5000, 2001,
  ]);
  expect(received.every((batch) => batch.marketId === "US_EQUITIES")).toBe(
    true,
  );
  expect(
    received.flatMap((batch) => batch.candles.map((candle) => candle.volume)),
  ).toEqual(candles.map((candle) => candle.volume));
});

it("stops a failed warm-up and reports the failing endpoint so recovery can retry", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    new ScannerFeatureClient(new URL("http://scanner:8000")).ingestCandles(
      candles,
      [instrument],
    ),
  ).rejects.toThrow(
    "Scanner /internal/v1/candles/batch request failed: Timed out",
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("returns scanner-verified incremental warm-up readiness", async () => {
  const readiness = {
    instrumentId: instrument.id,
    ready: false,
    dailyHistoryCount: 0,
    historicalIntradaySessionCount: 0,
    currentSessionOneMinuteCount: 0,
    openingRangeComplete: false,
    benchmarkReady: false,
    reasons: ["DAILY_HISTORY_UNAVAILABLE"],
  };
  const fetchMock = vi.fn().mockResolvedValue(Response.json(readiness));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    new ScannerFeatureClient(new URL("http://scanner:8000")).warmInstrument(
      instrument,
      candles.slice(0, 1),
    ),
  ).resolves.toEqual(readiness);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: "/internal/v1/instruments/warm" }),
    expect.objectContaining({
      body: expect.stringContaining('"marketId":"US_EQUITIES"'),
    }),
  );
});
