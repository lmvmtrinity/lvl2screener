import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrate, loadMigrations } from "../src/database/migrate.js";
import { PostgresUniverseStore } from "../src/universe/universe-repository.js";
import {
  AutomatedUniverseService,
  DEFAULT_UNIVERSE_POLICY,
  DEFAULT_US_UNIVERSE_POLICY,
  MockTsxUniverseProvider,
  MockUsUniverseProvider,
} from "../src/universe/universe-service.js";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";
import { QuestradeAdapter } from "../src/questrade/adapter.js";
import { MockQuestradeTransport } from "../src/questrade/mock-transport.js";
import {
  QuestradeTokenManager,
  InMemoryRefreshTokenStore,
} from "../src/questrade/token-manager.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!databaseUrl)("US integration PostgreSQL acceptance", () => {
  it.each(["fresh", "pre-US upgrade"])(
    "%s preserves market history, activation and benchmarks",
    async (mode) => {
      const name = `tsx_scanner_test_us_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl, max: 1 });
      const url = new URL(databaseUrl!);
      url.pathname = `/${name}`;
      const connectionString = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL", {
        ...process.env,
        AUDIT_TEST_DATABASE_URL: url.toString(),
      });
      const pool = new Pool({ connectionString, max: 2 });
      let created = false;
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
        created = true;
        if (mode === "pre-US upgrade") {
          await migrate(pool, {
            migrations: (await loadMigrations()).filter(
              (migration) => migration.filename < "056-",
            ),
          });
          await pool.query(`INSERT INTO instrument(questrade_symbol_id,symbol,description,exchange,currency,security_type,is_quotable,is_tradable,active)
          VALUES(1999999999,'LEGACY.TO','Pre-US fixture','TSX','CAD','Stock',true,true,false)`);
        }
        await migrate(pool);
        expect((await migrate(pool)).applied).toEqual([]);
        if (mode === "pre-US upgrade")
          expect(
            (
              await pool.query(
                "SELECT market_id,currency FROM instrument WHERE symbol='LEGACY.TO'",
              )
            ).rows,
          ).toEqual([{ market_id: "CA_TSX", currency: "CAD" }]);
        const clock = () => new Date("2026-08-24T14:00:00Z");
        const transport = new MockQuestradeTransport();
        const adapter = new QuestradeAdapter(
          new QuestradeTokenManager(
            transport,
            new InMemoryRefreshTokenStore("mock-refresh-token-0"),
            clock,
            0,
          ),
          transport,
          clock,
        );
        const store = new PostgresUniverseStore(pool);
        const repository = new PostgresMarketDataRepository(pool);
        const ca = new AutomatedUniverseService(
          new MockTsxUniverseProvider(),
          adapter,
          store,
          DEFAULT_UNIVERSE_POLICY,
          1,
          clock,
        );
        const us = new AutomatedUniverseService(
          new MockUsUniverseProvider(),
          adapter,
          store,
          DEFAULT_US_UNIVERSE_POLICY,
          1,
          clock,
        );
        const caInstruments = await ca.enrich();
        const usInstruments = await us.enrich();
        expect(caInstruments.length).toBeGreaterThan(0);
        expect(usInstruments.length).toBeGreaterThan(0);
        const active = (market: "CA_TSX" | "US_EQUITIES") =>
          repository.listActiveInstruments(market);
        const caBefore = await active("CA_TSX");
        const usBefore = await active("US_EQUITIES");
        expect(
          (
            await pool.query(
              "SELECT DISTINCT universe_source FROM instrument WHERE market_id='US_EQUITIES'",
            )
          ).rows,
        ).toEqual([{ universe_source: "AUTOMATED_US_UNIVERSE" }]);
        await us.enrich();
        expect(await active("CA_TSX")).toEqual(caBefore);
        await ca.enrich();
        expect(await active("US_EQUITIES")).toEqual(usBefore);
        expect(
          (await ca.listRuns()).every((run) => run.marketId === "CA_TSX"),
        ).toBe(true);
        expect(
          (await us.listRuns()).every((run) => run.marketId === "US_EQUITIES"),
        ).toBe(true);
        for (const [service, market, currency] of [
          [ca, "CA_TSX", "CAD"],
          [us, "US_EQUITIES", "USD"],
        ] as const) {
          const runs = await service.listRuns();
          expect(runs).toHaveLength(2);
          const last = await store.loadLastCompleted(
            service.getAutomation().provider,
            market,
          );
          expect(last!.instruments.length).toBeGreaterThan(0);
          expect(
            last!.instruments.every(
              (instrument) =>
                instrument.marketId === market &&
                instrument.currency === currency,
            ),
          ).toBe(true);
        }
        await repository.markBenchmarks(
          [
            {
              symbolId: caInstruments[0]!.symbolId,
              kind: "MARKET",
              sector: null,
            },
          ],
          "CA_TSX",
        );
        await repository.markBenchmarks([], "US_EQUITIES");
        expect(
          (await active("CA_TSX")).find(
            (instrument) => instrument.symbolId === caInstruments[0]!.symbolId,
          )?.benchmarkKind,
        ).toBe("MARKET");
        // A rejected peer-market activation must leave both inventories unchanged.
        const before = (
          await pool.query(
            "SELECT id,market_id,active,benchmark_kind FROM instrument ORDER BY id",
          )
        ).rows;
        const run = await store.begin(
          "bad-fixture",
          DEFAULT_US_UNIVERSE_POLICY,
          clock(),
        );
        await expect(
          store.complete(
            run.id,
            [
              {
                member: ca.getAutomation().members[0]!,
                instrument: caInstruments[0]!,
              },
            ],
            [],
            clock(),
            1,
          ),
        ).rejects.toThrow("another market");
        expect(
          (
            await pool.query(
              "SELECT id,market_id,active,benchmark_kind FROM instrument ORDER BY id",
            )
          ).rows,
        ).toEqual(before);
        await expect(
          pool.query("UPDATE instrument SET currency='CAD' WHERE id=$1", [
            usInstruments[0]!.id,
          ]),
        ).rejects.toThrow();
      } finally {
        await pool.end();
        if (created) await admin.query(`DROP DATABASE "${name}"`);
        await admin.end();
      }
    },
    60000,
  );
});
