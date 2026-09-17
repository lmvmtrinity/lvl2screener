import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";

const url = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
const caInstrument = "f1000000-0000-4000-8000-000000000001";
const usInstrument = "f1000000-0000-4000-8000-000000000002";

async function insertInstrument(
  pool: Pool,
  id: string,
  symbol: string,
  marketId: "CA_TSX" | "US_EQUITIES",
  symbolId: number,
) {
  const ca = marketId === "CA_TSX";
  await pool.query(
    `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,security_type,is_quotable,is_tradable,market_id)
     VALUES($1,$2,$3,$4,$5,$6,'Stock',TRUE,TRUE,$7)`,
    [
      id,
      symbolId,
      symbol,
      symbol,
      ca ? "TSX" : "NASDAQ",
      ca ? "CAD" : "USD",
      marketId,
    ],
  );
}

async function insertQuote(
  pool: Pool,
  instrumentId: string,
  timestamp: string,
) {
  await pool.query(
    `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,spread_absolute,spread_pct,is_delayed,is_halted,source)
     VALUES($1,$2,10,10.01,100,100,10,100,1000,10,10.5,9.5,0.01,0.1,FALSE,FALSE,'QUESTRADE')`,
    [instrumentId, timestamp],
  );
}

async function insertCandle(
  pool: Pool,
  instrumentId: string,
  startTime: string,
  endTime: string,
) {
  await pool.query(
    `INSERT INTO candle(instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,source,is_complete)
     VALUES($1,'OneMinute',$2,$3,10,10.5,9.5,10,1000,'QUESTRADE',TRUE)`,
    [instrumentId, startTime, endTime],
  );
}

describe.skipIf(!url)("captured-history interior gap PostgreSQL", () => {
  let pool: Pool;
  let store: PostgresBacktestStore;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
    await insertInstrument(pool, caInstrument, "GAP.TO", "CA_TSX", 910001);
    await insertInstrument(pool, usInstrument, "GAP.US", "US_EQUITIES", 910002);
    // CA session (Toronto, UTC-4): quotes around a 106-minute no-quote interval
    // with complete candles backfilled inside it.
    await insertQuote(pool, caInstrument, "2026-09-14T13:30:00.000Z");
    await insertQuote(pool, caInstrument, "2026-09-14T13:39:05.524Z");
    await insertQuote(pool, caInstrument, "2026-09-14T15:25:29.153Z");
    await insertQuote(pool, caInstrument, "2026-09-14T19:59:00.000Z");
    await insertCandle(
      pool,
      caInstrument,
      "2026-09-14T14:00:00.000Z",
      "2026-09-14T14:01:00.000Z",
    );
    await insertCandle(
      pool,
      caInstrument,
      "2026-09-14T15:00:00.000Z",
      "2026-09-14T15:01:00.000Z",
    );
    // The same day outside the regular session is not assessed.
    await insertQuote(pool, caInstrument, "2026-09-14T20:30:00.000Z");
    // US market has continuous-enough quotes and no interior gap.
    await insertQuote(pool, usInstrument, "2026-09-14T13:31:00.000Z");
    await insertQuote(pool, usInstrument, "2026-09-14T13:35:00.000Z");
    await insertQuote(pool, usInstrument, "2026-09-14T13:40:00.000Z");
    await insertQuote(pool, usInstrument, "2026-09-14T13:45:00.000Z");
    await insertQuote(pool, usInstrument, "2026-09-14T13:50:00.000Z");
    await insertQuote(pool, usInstrument, "2026-09-14T13:55:00.000Z");
    await insertCandle(
      pool,
      usInstrument,
      "2026-09-14T13:45:00.000Z",
      "2026-09-14T13:46:00.000Z",
    );
    // US 2025 Thanksgiving (2025-11-27, exchange holiday) and the following
    // early close (2025-11-28 closes 13:00 ET / 18:00Z): holiday rows and
    // post-close rows must not create limitations, while a genuine pre-close
    // gap still must.
    await insertQuote(pool, usInstrument, "2025-11-27T15:00:00.000Z");
    await insertQuote(pool, usInstrument, "2025-11-27T15:30:00.000Z");
    await insertCandle(
      pool,
      usInstrument,
      "2025-11-27T15:15:00.000Z",
      "2025-11-27T15:16:00.000Z",
    );
    await insertQuote(pool, usInstrument, "2025-11-28T14:35:00.000Z");
    await insertQuote(pool, usInstrument, "2025-11-28T14:40:00.000Z");
    await insertQuote(pool, usInstrument, "2025-11-28T15:35:00.000Z");
    await insertQuote(pool, usInstrument, "2025-11-28T18:30:00.000Z");
    await insertQuote(pool, usInstrument, "2025-11-28T19:30:00.000Z");
    await insertCandle(
      pool,
      usInstrument,
      "2025-11-28T15:00:00.000Z",
      "2025-11-28T15:01:00.000Z",
    );
    await insertCandle(
      pool,
      usInstrument,
      "2025-11-28T18:15:00.000Z",
      "2025-11-28T18:16:00.000Z",
    );
    store = new PostgresBacktestStore(pool);
  }, 60000);
  afterAll(async () => pool?.end());

  it("reports the observed no-quote interval with market and time bounds", async () => {
    const availability = await store.getCapturedHistoryAvailability("CA_TSX");
    expect(availability.limitations).toEqual([
      expect.objectContaining({
        marketId: "CA_TSX",
        kind: "INTERIOR_NO_QUOTE",
        basis: "QUOTE_GAP_WITH_BACKFILLED_CANDLES",
        startAt: "2026-09-14T13:39:05.524Z",
        endAt: "2026-09-14T15:25:29.153Z",
        sessionDates: ["2026-09-14"],
      }),
    ]);
  });

  it("uses published sessions so holidays and post-close rows are not gaps", async () => {
    const us = await store.getCapturedHistoryAvailability("US_EQUITIES", {
      now: new Date("2025-11-29T12:00:00.000Z"),
    });
    expect(us.limitations).toEqual([
      expect.objectContaining({
        marketId: "US_EQUITIES",
        kind: "INTERIOR_NO_QUOTE",
        startAt: "2025-11-28T14:40:00.000Z",
        endAt: "2025-11-28T15:35:00.000Z",
        sessionDates: ["2025-11-28"],
      }),
    ]);
  });

  it("keeps market ownership in the assessment", async () => {
    const us = await store.getCapturedHistoryAvailability("US_EQUITIES");
    expect(us.limitations).toEqual([]);
    const ca = await store.getCapturedHistoryAvailability("CA_TSX");
    expect(ca.limitations).toHaveLength(1);
    expect(ca.limitations?.[0]?.marketId).toBe("CA_TSX");
  });
});
