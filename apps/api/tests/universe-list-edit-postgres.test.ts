import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UniverseMember } from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import type { Instrument } from "../src/questrade/types.js";
import { PostgresUniverseStore } from "../src/universe/universe-repository.js";
import {
  DEFAULT_UNIVERSE_POLICY,
  type UniverseEvaluation,
} from "../src/universe/universe-service.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

function evaluation(
  symbol: string,
  symbolId: number,
  metricsAsOf: string,
): UniverseEvaluation {
  const instrument: Instrument = {
    symbolId,
    symbol,
    description: `${symbol} test`,
    securityType: "Stock",
    exchange: "TSX",
    currency: "CAD",
    isQuotable: true,
    isTradable: true,
  };
  const member: UniverseMember = {
    instrumentId: null,
    marketId: "CA_TSX",
    symbol,
    description: `${symbol} test`,
    exchange: "TSX",
    normalizedExchange: "TSX",
    rawExchange: "TSX",
    currency: "CAD",
    sector: null,
    eligible: true,
    reasons: [],
    price: 20,
    marketCap: 1_000_000_000,
    averageVolume20d: 1_000_000,
    averageVolume90d: 1_000_000,
    dollarVolume: 20_000_000,
    atr14: 0.5,
    atrPct: 2.5,
    metricsAsOf,
  };
  return { instrument, member };
}

describe.skipIf(!databaseUrl)(
  "universe list edit PostgreSQL acceptance",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 5 });
      await migrate(pool);
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
    }, 60_000);

    it("records a list edit with carried membership and deactivates removed symbols", async () => {
      const store = new PostgresUniverseStore(pool);
      const provider = `LIST_EDIT_TEST_${Date.now()}`;
      const fullAt = "2026-09-24T13:00:00.000Z";
      const kept = evaluation("LEKEEP.TO", 990_001, fullAt);
      const dropped = evaluation("LEDROP.TO", 990_002, fullAt);

      const full = await store.begin(
        provider,
        DEFAULT_UNIVERSE_POLICY,
        new Date(fullAt),
      );
      expect(full.refreshKind).toBe("FULL");
      const fullDone = await store.complete(
        full.id,
        [kept, dropped],
        [],
        new Date("2026-09-24T13:01:00.000Z"),
        0,
      );
      const carried: UniverseEvaluation = {
        instrument: kept.instrument,
        member: fullDone.members.find((value) => value.symbol === "LEKEEP.TO")!,
      };

      const edit = await store.begin(
        provider,
        DEFAULT_UNIVERSE_POLICY,
        new Date("2026-09-24T14:00:00.000Z"),
        "LIST_EDIT",
      );
      const editDone = await store.complete(
        edit.id,
        [carried],
        [],
        new Date("2026-09-24T14:00:01.000Z"),
        0,
        0,
      );

      expect(editDone.run).toMatchObject({
        refreshKind: "LIST_EDIT",
        status: "COMPLETED",
        discoveredCount: 1,
        evaluatedCount: 0,
        activatedCount: 1,
      });
      expect(editDone.members).toEqual([
        expect.objectContaining({
          symbol: "LEKEEP.TO",
          metricsAsOf: fullAt,
          instrumentId: carried.member.instrumentId,
        }),
      ]);
      const active = await pool.query<{ symbol: string; active: boolean }>(
        "SELECT symbol, active FROM instrument WHERE market_id='CA_TSX' AND symbol = ANY($1) ORDER BY symbol",
        [["LEDROP.TO", "LEKEEP.TO"]],
      );
      expect(active.rows).toEqual([
        { symbol: "LEDROP.TO", active: false },
        { symbol: "LEKEEP.TO", active: true },
      ]);
      const [latest] = await store.listRuns(1, "CA_TSX");
      expect(latest).toMatchObject({ id: edit.id, refreshKind: "LIST_EDIT" });
    });
  },
);
