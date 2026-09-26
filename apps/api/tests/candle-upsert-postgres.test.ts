import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const url = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
describe.skipIf(!url)("candle no-op upsert on isolated PostgreSQL", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
  });

  it("preserves the tuple on an identical retry and updates a corrected bar", async () => {
    const repository = new PostgresMarketDataRepository(pool);
    const symbolId = 2_100_000_000 + Math.floor(Math.random() * 10_000_000);
    const [instrument] = await repository.upsertInstruments(
      [
        {
          symbolId,
          symbol: `CANDLE_${randomUUID().slice(0, 8)}.TO`,
          description: "candle retry regression",
          securityType: "Stock",
          exchange: "TSX",
          currency: "CAD",
          isQuotable: true,
          isTradable: true,
        },
      ],
      "CA_TSX",
    );
    const candle = {
      symbolId,
      interval: "OneMinute" as const,
      start: new Date("2099-04-02T14:00:00Z"),
      end: new Date("2099-04-02T14:01:00Z"),
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 100,
      source: "QUESTRADE" as const,
      isComplete: true,
    };
    const read = () =>
      pool.query<{ revision: string; close: string }>(
        "SELECT xmin::text AS revision, close::text AS close FROM candle WHERE instrument_id=$1 AND timeframe='OneMinute' AND start_time=$2",
        [instrument!.id, candle.start],
      );
    await repository.saveCandles([candle]);
    const first = (await read()).rows[0]!;
    await repository.saveCandles([candle]);
    expect((await read()).rows[0]).toEqual(first);
    await repository.saveCandles([{ ...candle, close: 12 }]);
    const changed = (await read()).rows[0]!;
    expect(changed.close).toBe("12");
    expect(changed.revision).not.toBe(first.revision);
  });
});
