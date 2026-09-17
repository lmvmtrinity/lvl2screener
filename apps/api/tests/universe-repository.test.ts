import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresUniverseStore } from "../src/universe/universe-repository.js";

describe("PostgresUniverseStore market isolation", () => {
  it("refuses to activate a member belonging to another market", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT market_id FROM universe_refresh_run")) {
          return { rows: [{ market_id: "US_EQUITIES" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new PostgresUniverseStore({
      connect: async () => client,
    } as unknown as Pool);

    await expect(
      store.complete(
        "11111111-1111-4111-8111-111111111111",
        [
          {
            instrument: {
              symbol: "SHOP.TO",
              symbolId: 1,
              description: "Shopify",
              securityType: "Stock",
              exchange: "TSX",
              currency: "CAD",
              isQuotable: true,
              isTradable: true,
            },
            member: {
              instrumentId: null,
              marketId: "CA_TSX",
              symbol: "SHOP.TO",
              description: "Shopify",
              exchange: "TSX",
              normalizedExchange: "TSX",
              rawExchange: "TSX",
              currency: "CAD",
              sector: null,
              eligible: true,
              reasons: [],
              price: 100,
              marketCap: null,
              averageVolume20d: null,
              averageVolume90d: null,
              dollarVolume: null,
              atr14: null,
              atrPct: null,
              metricsAsOf: "2026-09-03T13:30:00.000Z",
            },
          },
        ],
        [],
        new Date("2026-09-03T13:31:00.000Z"),
        1,
      ),
    ).rejects.toThrow("another market");
    expect(queries.some((sql) => sql.includes("INSERT INTO instrument"))).toBe(
      false,
    );
    expect(queries).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
