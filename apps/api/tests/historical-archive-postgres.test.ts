import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { PostgresHistoricalArchiveStore } from "../src/historical-archive/archive-repository.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const url = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
describe.skipIf(!url)("historical archive on isolated PostgreSQL", () => {
  let pool: Pool;
  let instrumentId: string;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
    const symbol = `ARCH_${randomUUID().slice(0, 8)}`;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO instrument(questrade_symbol_id,symbol,description,exchange,currency,security_type,
         is_quotable,is_tradable,market_id)
       VALUES($1,$2,'archive test','NASDAQ','USD','Stock',true,true,'US_EQUITIES') RETURNING id`,
      [2_200_000_000 + Math.floor(Math.random() * 10_000_000), symbol],
    );
    instrumentId = inserted.rows[0]!.id;
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
  });

  const manifest = (schemaName: "aggs-1m" | "cbbo-1m") => ({
    provider:
      schemaName === "cbbo-1m" ? ("DATABENTO" as const) : ("MASSIVE" as const),
    dataset: schemaName === "cbbo-1m" ? "XNAS.BASIC" : "stocks",
    schemaName,
    instrumentId,
    providerSymbol: "ARCH",
    rangeStart: "2099-04-02",
    rangeEnd: "2099-04-02",
    requestParams: {},
    responseSha256: "a".repeat(64),
    responseBytes: 10,
    costUsd: null,
    retrievedAt: new Date("2099-04-03T00:00:00Z"),
  });
  const bar = (close: number) => ({
    timeframe: "OneMinute" as const,
    startTime: new Date("2099-04-02T13:30:00Z"),
    endTime: new Date("2099-04-02T13:31:00Z"),
    open: 10,
    high: 11,
    low: 9,
    close,
    volume: 100.5,
    vwap: null,
    tradeCount: null,
  });

  it("never overwrites a stored bar and counts differing reimports", async () => {
    const store = new PostgresHistoricalArchiveStore(pool);
    const first = await store.recordBars(manifest("aggs-1m"), [bar(10)]);
    expect(first).toMatchObject({
      recordCount: 1,
      insertedCount: 1,
      conflictingCount: 0,
    });
    const same = await store.recordBars(manifest("aggs-1m"), [bar(10)]);
    expect(same).toMatchObject({ insertedCount: 0, conflictingCount: 0 });
    const changed = await store.recordBars(manifest("aggs-1m"), [bar(10.5)]);
    expect(changed).toMatchObject({ insertedCount: 0, conflictingCount: 1 });
    const stored = await pool.query<{ close: string; import_id: string }>(
      "SELECT close::text, import_id FROM historical_bar WHERE instrument_id=$1",
      [instrumentId],
    );
    expect(stored.rows).toEqual([{ close: "10", import_id: first.importId }]);
    const imports = await pool.query(
      "SELECT inserted_count, conflicting_count FROM historical_archive_import WHERE instrument_id=$1 ORDER BY created_at",
      [instrumentId],
    );
    expect(imports.rows).toEqual([
      { inserted_count: 1, conflicting_count: 0 },
      { inserted_count: 0, conflicting_count: 0 },
      { inserted_count: 0, conflicting_count: 1 },
    ]);
  });

  it("reports only dates with both quotes and minute bars", async () => {
    const store = new PostgresHistoricalArchiveStore(pool);
    await store.recordQuotes(manifest("cbbo-1m"), [
      {
        sampledAt: new Date("2099-04-02T13:31:00Z"),
        bid: 10,
        ask: 10.01,
        bidSize: 100,
        askSize: 200,
      },
      {
        sampledAt: new Date("2099-04-03T13:31:00Z"),
        bid: 10,
        ask: 10.01,
        bidSize: 100,
        askSize: 200,
      },
    ]);
    expect(
      await store.sessionDates(
        [instrumentId],
        "2099-04-01",
        "2099-04-05",
        "America/New_York",
      ),
    ).toEqual(["2099-04-02"]);
    const session = await store.loadSession(
      [instrumentId],
      "2099-04-02",
      "America/New_York",
    );
    expect(session.bars).toHaveLength(1);
    expect(session.samples).toEqual([
      expect.objectContaining({
        bid: 10,
        ask: 10.01,
        bidSize: 100,
        askSize: 200,
      }),
    ]);
  });
});
