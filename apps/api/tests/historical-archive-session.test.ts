import { describe, expect, it } from "vitest";
import {
  archiveCandles,
  synthesizeArchiveQuotes,
  type ArchiveBar,
  type ArchiveSessionWindow,
} from "../src/historical-archive/archive-session.js";

// 2026-09-16 is an EDT session: 09:30 local = 13:30 UTC.
const window: ArchiveSessionWindow = {
  date: "2026-09-16",
  dayStart: new Date("2026-09-16T04:00:00Z"),
  open: new Date("2026-09-16T13:30:00Z"),
  close: new Date("2026-09-16T20:00:00Z"),
};
const id = "00000000-0000-4000-8000-000000000001";

function minute(
  start: string,
  open: number,
  close: number,
  volume: number,
): ArchiveBar {
  const startTime = new Date(start);
  return {
    instrumentId: id,
    timeframe: "OneMinute",
    startTime,
    endTime: new Date(startTime.getTime() + 60_000),
    open,
    high: Math.round((Math.max(open, close) + 0.1) * 100) / 100,
    low: Math.round((Math.min(open, close) - 0.1) * 100) / 100,
    close,
    volume,
  };
}

const bars = [
  minute("2026-09-16T13:28:00Z", 9.9, 10, 100.4),
  minute("2026-09-16T13:30:00Z", 10, 10.2, 1000.6),
  minute("2026-09-16T13:31:00Z", 10.2, 10.1, 500),
  minute("2026-09-16T13:32:00Z", 10.1, 10.4, 700),
];

function sample(at: string) {
  return {
    instrumentId: id,
    sampledAt: new Date(at),
    bid: 10,
    ask: 10.02,
    bidSize: 300,
    askSize: 200,
  };
}

describe("archive quote synthesis", () => {
  it("uses only bars that ended at or before each sample", () => {
    const quotes = synthesizeArchiveQuotes(window, bars, [
      sample("2026-09-16T13:30:00Z"),
      sample("2026-09-16T13:31:00Z"),
      sample("2026-09-16T13:32:00Z"),
    ]);
    // The 13:30 sample is at the open, before any regular-session bar closed.
    expect(quotes.map((quote) => quote.timestamp.toISOString())).toEqual([
      "2026-09-16T13:31:00.000Z",
      "2026-09-16T13:32:00.000Z",
    ]);
    const [first, second] = quotes;
    expect(first).toMatchObject({
      last: "10.2",
      day_open: "10",
      day_volume: "1101",
      spread_absolute: "0.02",
    });
    // The 13:32 bar ends at 13:33 and must not leak into the 13:32 quote.
    expect(second).toMatchObject({
      last: "10.1",
      day_volume: "1601",
      day_high: "10.3",
      day_low: "9.9",
    });
  });

  it("skips instruments without minute bars", () => {
    expect(
      synthesizeArchiveQuotes(window, [], [sample("2026-09-16T13:40:00Z")]),
    ).toEqual([]);
  });
});

describe("archive candles", () => {
  it("aggregates rounded minute volume into five-minute bars for the session date", () => {
    const candles = archiveCandles(window, bars, () => "2026-09-16");
    const five = candles.filter((row) => row.timeframe === "FiveMinutes");
    expect(
      five.map((row) => [
        row.start_time.toISOString(),
        row.open,
        row.close,
        row.volume,
      ]),
    ).toEqual([
      ["2026-09-16T13:25:00.000Z", "9.9", "10", "100"],
      ["2026-09-16T13:30:00.000Z", "10", "10.4", "2201"],
    ]);
    expect(candles.filter((row) => row.timeframe === "OneMinute")).toHaveLength(
      4,
    );
  });
});
