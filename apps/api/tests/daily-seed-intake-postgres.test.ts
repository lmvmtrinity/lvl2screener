import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { PostgresDiscoveryIntakeRepository } from "../src/universe/discovery-intake-repository.js";
import { PostgresUniverseStore } from "../src/universe/universe-repository.js";
import {
  ConfiguredTsxUniverseProvider,
  ConfiguredUsUniverseProvider,
} from "../src/universe/universe-service.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const date = "2026-09-28";
const guard = {
  phase: "RESCAN" as const,
  marketId: "CA_TSX" as const,
  tradingDate: date,
  maxAdds: 5,
};

describe.skipIf(!databaseUrl)("daily rescan durable intake", () => {
  let pool: Pool;
  let store: PostgresUniverseStore;
  const provider = (market: "CA_TSX" | "US_EQUITIES" = "CA_TSX") =>
    market === "US_EQUITIES"
      ? new ConfiguredUsUniverseProvider(
          [],
          store,
          () => new Date(`${date}T13:55:20Z`),
        )
      : new ConfiguredTsxUniverseProvider(
          [],
          store,
          () => new Date(`${date}T13:55:20Z`),
        );
  const add = (symbols: string[], tag: string) => ({
    operation: "ADD" as const,
    source: "MANUAL" as const,
    inputs: symbols,
    tags: [tag],
  });
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    store = new PostgresUniverseStore(
      pool,
      new PostgresDiscoveryIntakeRepository(pool),
    );
  }, 180_000);
  beforeEach(async () => {
    await pool.query("DELETE FROM universe_watchlist");
    await provider().updateCandidates(add(["BB.TO"], "daily-seed-v1"));
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("protects an operator replacement from a stale seeded provider", async () => {
    const stale = provider();
    await stale.listSymbols();
    await provider().replaceSymbols(["SHOP.TO"]);
    await expect(
      stale.updateCandidates(add(["AC.TO"], "daily-seed-v2"), guard),
    ).rejects.toThrow("DAILY_SEED_RESCAN_LIST_NOT_OWNED");
    expect(
      (await provider().listSymbols()).map((value) => value.symbol),
    ).toEqual(["SHOP.TO"]);
  });

  it("refuses a second batch after restart even when the receipt is absent", async () => {
    await provider().updateCandidates(add(["AC.TO"], "daily-seed-v2"), guard);
    await expect(
      provider().updateCandidates(add(["GIL.TO"], "daily-seed-v2"), guard),
    ).rejects.toThrow("DAILY_SEED_RESCAN_ALREADY_APPLIED");
    expect(
      (await provider().listSymbols()).map((value) => value.symbol),
    ).toEqual(["AC.TO", "BB.TO"]);
  });

  it("serializes concurrent rescans so only one batch commits", async () => {
    const results = await Promise.allSettled([
      provider().updateCandidates(add(["AC.TO"], "daily-seed-v2"), guard),
      provider().updateCandidates(add(["GIL.TO"], "daily-seed-v2"), guard),
    ]);
    expect(
      results.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(
      1,
    );
    expect(await provider().listSymbols()).toHaveLength(2);
  });

  it("enforces the configured addition limit at the write boundary", async () => {
    await expect(
      provider().updateCandidates(add(["AC.TO", "GIL.TO"], "daily-seed-v2"), {
        ...guard,
        maxAdds: 1,
      }),
    ).rejects.toThrow("DAILY_SEED_RESCAN_LIMIT");
    expect(await provider().listSymbols()).toHaveLength(1);
  });

  it("rejects stale dates and wrong-market guards", async () => {
    await expect(
      provider().updateCandidates(add(["AC.TO"], "daily-seed-v2"), {
        ...guard,
        tradingDate: "2026-09-25",
      }),
    ).rejects.toThrow("DAILY_SEED_RESCAN_IDENTITY");
    await expect(
      provider("US_EQUITIES").updateCandidates(
        add(["AAPL"], "daily-seed-v2"),
        guard,
      ),
    ).rejects.toThrow("DAILY_SEED_RESCAN_IDENTITY");
  });

  it("keeps independent US and CA rescan batches", async () => {
    await provider("US_EQUITIES").updateCandidates(
      add(["BB"], "daily-seed-v1"),
    );
    await provider("US_EQUITIES").updateCandidates(
      add(["AAPL"], "daily-seed-v2"),
      { ...guard, marketId: "US_EQUITIES" },
    );
    await provider().updateCandidates(add(["AC.TO"], "daily-seed-v2"), guard);
    expect(
      (await provider("US_EQUITIES").listSymbols()).map(
        (value) => value.symbol,
      ),
    ).toEqual(["AAPL", "BB"]);
    expect(
      (await provider().listSymbols()).map((value) => value.symbol),
    ).toEqual(["AC.TO", "BB.TO"]);
  });

  it("seeds an empty list once and protects a later operator replacement", async () => {
    await provider().replaceSymbols([]);
    const seedGuard = { ...guard, phase: "SEED" as const };
    await provider().updateCandidates(
      add(["BB.TO"], "daily-seed-v1"),
      seedGuard,
    );
    const stale = provider();
    await stale.listSymbols();
    await provider().replaceSymbols(["SHOP.TO"]);
    await expect(
      stale.updateCandidates(add(["AC.TO"], "daily-seed-v1"), seedGuard),
    ).rejects.toThrow("DAILY_SEED_LIST_NOT_EMPTY");
    expect(
      (await provider().listSymbols()).map((value) => value.symbol),
    ).toEqual(["SHOP.TO"]);
  });

  it("cannot overwrite a newer-date watchlist with a delayed seed", async () => {
    await pool.query(
      "UPDATE universe_watchlist SET trading_date='2026-09-29' WHERE market_id='CA_TSX'",
    );
    await expect(
      provider().updateCandidates(add(["AC.TO"], "daily-seed-v1"), {
        ...guard,
        phase: "SEED",
      }),
    ).rejects.toThrow("DAILY_SEED_RESCAN_IDENTITY");
    const persisted = await store.loadConfiguredSymbols(
      "CONFIGURED_TSX_LIVE_WATCHLIST",
      "CA_TSX",
    );
    expect(persisted?.tradingDate).toBe("2026-09-29");
    expect(persisted?.symbols).toEqual(["BB.TO"]);
  });
});
