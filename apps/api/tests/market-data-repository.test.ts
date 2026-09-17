import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";

describe("PostgresMarketDataRepository instrument reconciliation", () => {
  it("uses a market-scoped symbol conflict to replace a stale provider id", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO instrument"))
          return {
            rows: [
              {
                id: "instrument-1",
                questrade_symbol_id: "987654",
                symbol: "XIU.TO",
                description: "ISHARES S&P/TSX 60 INDEX ETF",
                security_type: "ETF",
                exchange: "TSX",
                currency: "CAD",
                is_quotable: true,
                is_tradable: true,
                active: false,
                benchmark_kind: "MARKET",
                benchmark_sector: null,
                market_id: "CA_TSX",
                inserted: false,
              },
            ],
          };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const repository = new PostgresMarketDataRepository(pool);

    const result = await repository.upsertInstruments([
      {
        symbol: "XIU.TO",
        symbolId: 987654,
        description: "ISHARES S&P/TSX 60 INDEX ETF",
        securityType: "ETF",
        exchange: "TSX",
        currency: "CAD",
        isQuotable: true,
        isTradable: true,
      },
    ]);

    const upsert = queries.find((sql) =>
      sql.includes("INSERT INTO instrument"),
    );
    expect(upsert).toContain("ON CONFLICT (market_id, symbol) DO UPDATE SET");
    expect(upsert).toContain(
      "questrade_symbol_id = EXCLUDED.questrade_symbol_id",
    );
    expect(result[0]).toMatchObject({
      id: "instrument-1",
      symbol: "XIU.TO",
      symbolId: 987654,
      marketId: "CA_TSX",
    });
  });

  it("clears and assigns benchmark roles only inside the selected market", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new PostgresMarketDataRepository({
      connect: async () => client,
    } as unknown as Pool);

    await repository.markBenchmarks(
      [{ symbolId: 7, kind: "MARKET", sector: null }],
      "US_EQUITIES",
    );

    const clear = queries.find(({ sql }) =>
      sql.includes("SET benchmark_kind = NULL"),
    );
    const assign = queries.find(({ sql }) =>
      sql.includes("SET benchmark_kind = u.kind"),
    );
    expect(clear?.sql).toContain("WHERE market_id=$1");
    expect(clear?.values).toEqual(["US_EQUITIES", [7]]);
    expect(assign?.sql).toContain("i.market_id=$2");
    expect(assign?.values?.[1]).toBe("US_EQUITIES");
  });
});
