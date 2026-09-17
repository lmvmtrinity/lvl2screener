import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { PostgresRequestBudget } from "../src/questrade/postgres-request-budget.js";
import {
  PostgresCatalogSnapshotStore,
  PostgresDiscoveryMappingStore,
} from "../src/universe/postgres-discovery-provider-store.js";
import {
  EodhdCatalogClient,
  parseEodhdCatalog,
} from "../src/universe/eodhd-catalog.js";
import { DiscoverySymbolMapper } from "../src/universe/discovery-mapping.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!databaseUrl)("discovery provider durable acceptance", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    await migrate(pool);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
  });
  async function knownNamespace() {
    const namespace = `discovery-test-${randomUUID()}`;
    await pool.query(
      "INSERT INTO questrade_request_budget(namespace,blocked_until) VALUES($1,clock_timestamp() - interval '1 hour')",
      [namespace],
    );
    return namespace;
  }
  it("fails closed for unknown pre-restart usage", async () => {
    const budget = new PostgresRequestBudget(pool, `cold-${randomUUID()}`);
    const result = await budget.acquire(false);
    expect(result.granted).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(3_590_000);
  });
  it("shares persisted grants across instances and charges aborted dispatch", async () => {
    const namespace = await knownNamespace();
    const first = new PostgresRequestBudget(pool, namespace);
    expect((await first.acquire(true)).granted).toBe(true);
    // Simulate process death before any HTTP dispatch: construct a fresh instance.
    const restarted = new PostgresRequestBudget(pool, namespace);
    expect((await restarted.acquire(true)).granted).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM questrade_request_grant WHERE namespace=$1",
          [namespace],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("serializes concurrent processes and preserves pacing", async () => {
    const namespace = await knownNamespace();
    const workers = [
      new PostgresRequestBudget(pool, namespace),
      new PostgresRequestBudget(pool, namespace),
    ];
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => workers[i % 2]!.acquire(false)),
    );
    const grants = (
      await pool.query<{ started_at: Date }>(
        "SELECT started_at FROM questrade_request_grant WHERE namespace=$1 ORDER BY started_at",
        [namespace],
      )
    ).rows;
    expect(grants.length).toBeGreaterThan(0);
    for (let i = 1; i < grants.length; i++)
      expect(
        grants[i]!.started_at.getTime() - grants[i - 1]!.started_at.getTime(),
      ).toBeGreaterThanOrEqual(50);
  });
  it("enforces hourly exhaustion even with no recent second-window traffic", async () => {
    const namespace = await knownNamespace();
    await pool.query(
      `INSERT INTO questrade_request_grant(namespace,started_at,discovery)
      SELECT $1,clock_timestamp()-interval '1 minute',false FROM generate_series(1,15000)`,
      [namespace],
    );
    const result = await new PostgresRequestBudget(pool, namespace).acquire(
      false,
    );
    expect(result).toMatchObject({ granted: false, remainingHour: 0 });
    expect(result.retryAfterMs).toBeGreaterThan(3_500_000);
  });
  it("reserves monitoring headroom and shares 429 blocks across restarts", async () => {
    const namespace = await knownNamespace();
    await pool.query(
      `INSERT INTO questrade_request_grant(namespace,started_at,discovery)
      SELECT $1,clock_timestamp()-interval '1 minute',false FROM generate_series(1,9000)`,
      [namespace],
    );
    const budget = new PostgresRequestBudget(pool, namespace);
    expect((await budget.acquire(true)).granted).toBe(false);
    expect((await budget.acquire(false)).granted).toBe(true);
    await budget.block(new Date(Date.now() + 60_000));
    expect(
      (await new PostgresRequestBudget(pool, namespace).acquire(false)).granted,
    ).toBe(false);
  });
  it("rolls expired grants out of durable accounting", async () => {
    const namespace = await knownNamespace();
    await pool.query(
      `INSERT INTO questrade_request_grant(namespace,started_at,discovery)
      SELECT $1,clock_timestamp()-interval '2 hours',true FROM generate_series(1,1800)`,
      [namespace],
    );
    expect(
      (await new PostgresRequestBudget(pool, namespace).acquire(true)).granted,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM questrade_request_grant WHERE namespace=$1",
          [namespace],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("leases catalog fetches across clients and retains failure evidence", async () => {
    // This table belongs only to the verified disposable database; the test owns both markets.
    await pool.query("DELETE FROM discovery_catalog_cache");
    const payload = [
      {
        Code: "QBR.B",
        Name: "Synthetic",
        Exchange: "TSX",
        Currency: "CAD",
        Type: "Common Stock",
      },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(payload));
    let now = new Date("2026-09-08T12:00:00Z");
    const one = new EodhdCatalogClient(
      "synthetic",
      new PostgresCatalogSnapshotStore(pool),
      fetcher,
      () => now,
    );
    const two = new EodhdCatalogClient(
      "synthetic",
      new PostgresCatalogSnapshotStore(pool),
      fetcher,
      () => now,
    );
    const results = await Promise.all([
      one.refresh("CA_TSX", "2026-09-08"),
      two.refresh("CA_TSX", "2026-09-08"),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = new Date("2026-09-09T12:00:00Z");
    fetcher.mockResolvedValueOnce(Response.json([]));
    expect(await two.refresh("CA_TSX", "2026-09-09")).toMatchObject({
      status: "LAST_GOOD",
      failure: "EMPTY_CATALOG",
    });
    const evidence = await pool.query(
      "SELECT failure_code, retained_digest FROM discovery_catalog_attempt WHERE market_id='CA_TSX' ORDER BY id DESC LIMIT 1",
    );
    expect(evidence.rows[0]).toMatchObject({
      failure_code: "EMPTY_CATALOG",
      retained_digest: results[0]!.snapshot!.digest,
    });
    expect(
      (await new PostgresCatalogSnapshotStore(pool).loadLatest("CA_TSX"))
        ?.tradingDate,
    ).toBe("2026-09-08");
    expect(
      await new PostgresCatalogSnapshotStore(pool).loadLatest("US_EQUITIES"),
    ).toBeNull();
  });
  it("persists mapping identity and invalidates catalog revisions after restart", async () => {
    const raw = {
      Code: `T${randomUUID().slice(0, 6)}`,
      Name: "Synthetic",
      Exchange: "TSX",
      Currency: "CAD",
      Type: "Common Stock",
    };
    const member = parseEodhdCatalog([raw], "CA_TSX")[0]!;
    const broker = {
      searchSymbols: vi.fn(async () => [
        {
          symbol: `${raw.Code}.TO`,
          symbolId: 123,
          description: "Synthetic",
          securityType: "Common Stock",
          exchange: "TSX",
          currency: "CAD",
          isQuotable: true,
          isTradable: true,
        },
      ]),
    };
    const store = new PostgresDiscoveryMappingStore(pool);
    const first = await new DiscoverySymbolMapper(broker, store).resolve(
      "CA_TSX",
      member,
    );
    expect(
      await new DiscoverySymbolMapper(broker, store).resolve("CA_TSX", member),
    ).toEqual(first);
    expect(broker.searchSymbols).toHaveBeenCalledTimes(1);
    member.raw.Isin = "new-revision";
    await new DiscoverySymbolMapper(broker, store).resolve("CA_TSX", member);
    expect(broker.searchSymbols).toHaveBeenCalledTimes(2);
    expect(await store.load("US_EQUITIES", "TSX", raw.Code)).toBeNull();
  });
});
