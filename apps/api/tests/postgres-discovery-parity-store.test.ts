import { describe, expect, it, vi } from "vitest";
import {
  PostgresDiscoveryParityStore,
  InMemoryDiscoveryParityStore,
} from "../src/universe/postgres-discovery-parity-store.js";
import type { DiscoveryParityAudit } from "@tsx-scanner/contracts";

function sampleAudit(
  id = "11111111-1111-4111-8111-111111111111",
): DiscoveryParityAudit {
  return {
    id,
    marketId: "CA_TSX",
    tradingDate: "2026-11-03",
    runId: "22222222-2222-4222-8222-222222222222",
    auditedAt: "2026-11-03T14:40:00.000Z",
    tradingViewCount: 2,
    questradePassCount: 1,
    overlapCount: 1,
    overlapRatio: 0.5,
    overlapSymbols: ["SHOP"],
    missedMovers: [
      {
        symbol: "BMO",
        exchange: "TSX",
        tradingViewMetrics: {
          price: 120,
          changeFromOpenPct: 1.2,
          relativeVolume: 1.8,
          averageVolume90d: 900000,
          marketCap: 90000000000,
        },
        questradeState: "FAIL",
        questradeReasons: ["ATR_THRESHOLD"],
        discrepancyCategory: "FORMULA_DIFFERENCE",
      },
    ],
    questradeOnly: [],
    metricDifferences: [
      {
        symbol: "SHOP",
        field: "price",
        questradeValue: 105,
        tradingViewValue: 104.8,
        difference: 0.2,
        pctDifference: 0.19,
      },
    ],
    discrepancySummary: {
      FORMULA_DIFFERENCE: 1,
      FORMING_VS_COMPLETED_BAR: 0,
      VOLUME_COVERAGE: 0,
      TIMESTAMP_LAG: 0,
      CORPORATE_ACTION: 0,
      CLASSIFICATION_MISMATCH: 0,
      THRESHOLD_BOUNDARY: 0,
      OTHER: 0,
    },
  };
}

describe("PostgresDiscoveryParityStore", () => {
  it("saves audit with JSON serialization of complex fields", async () => {
    const audit = sampleAudit();
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PostgresDiscoveryParityStore({ query } as any);

    await store.save(audit);

    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO discovery_parity_audit");
    const [retentionSql] = query.mock.calls[1] as unknown as [
      string,
      unknown[],
    ];
    expect(retentionSql).toContain("DELETE FROM discovery_parity_audit");
    expect(params[0]).toBe(audit.id);
    expect(params[1]).toBe("CA_TSX");
    expect(params[2]).toBe("2026-11-03");
    expect(params[3]).toBe(audit.runId);
    expect(params[9]).toBe(JSON.stringify(["SHOP"]));
    expect(params[10]).toBe(JSON.stringify(audit.missedMovers));
    expect(params[12]).toBe(JSON.stringify(audit.metricDifferences));
  });

  it("loads latest audit and properly parses stringified and Date fields", async () => {
    const audit = sampleAudit();
    const mockRow = {
      id: audit.id,
      marketId: audit.marketId,
      tradingDate: audit.tradingDate,
      runId: audit.runId,
      auditedAt: new Date(audit.auditedAt),
      tradingViewCount: audit.tradingViewCount,
      questradePassCount: audit.questradePassCount,
      overlapCount: audit.overlapCount,
      overlapRatio: audit.overlapRatio,
      overlapSymbols: JSON.stringify(audit.overlapSymbols),
      missedMovers: JSON.stringify(audit.missedMovers),
      questradeOnly: JSON.stringify(audit.questradeOnly),
      metricDifferences: JSON.stringify(audit.metricDifferences),
      discrepancySummary: JSON.stringify(audit.discrepancySummary),
    };

    const query = vi.fn(async () => ({ rows: [mockRow] }));
    const store = new PostgresDiscoveryParityStore({ query } as any);

    const loaded = await store.loadLatest("CA_TSX");
    expect(loaded).toEqual(audit);
  });

  it("returns null when loadLatest finds no records", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PostgresDiscoveryParityStore({ query } as any);

    const loaded = await store.loadLatest("CA_TSX");
    expect(loaded).toBeNull();
  });

  it("lists audits respecting limit", async () => {
    const audit = sampleAudit();
    const mockRow = {
      id: audit.id,
      marketId: audit.marketId,
      tradingDate: audit.tradingDate,
      runId: audit.runId,
      auditedAt: audit.auditedAt,
      tradingViewCount: audit.tradingViewCount,
      questradePassCount: audit.questradePassCount,
      overlapCount: audit.overlapCount,
      overlapRatio: audit.overlapRatio,
      overlapSymbols: audit.overlapSymbols,
      missedMovers: audit.missedMovers,
      questradeOnly: audit.questradeOnly,
      metricDifferences: audit.metricDifferences,
      discrepancySummary: audit.discrepancySummary,
    };

    const query = vi.fn(async () => ({ rows: [mockRow] }));
    const store = new PostgresDiscoveryParityStore({ query } as any);

    const list = await store.listAudits("CA_TSX", 10);
    expect(list).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.any(String), ["CA_TSX", 10]);
  });

  it("retrieves audit by id or returns null", async () => {
    const audit = sampleAudit();
    const query = vi.fn(async (sql: string, params: any[]) => {
      if (params[0] === audit.id) {
        return {
          rows: [
            {
              id: audit.id,
              marketId: audit.marketId,
              tradingDate: audit.tradingDate,
              runId: audit.runId,
              auditedAt: audit.auditedAt,
              tradingViewCount: audit.tradingViewCount,
              questradePassCount: audit.questradePassCount,
              overlapCount: audit.overlapCount,
              overlapRatio: audit.overlapRatio,
              overlapSymbols: audit.overlapSymbols,
              missedMovers: audit.missedMovers,
              questradeOnly: audit.questradeOnly,
              metricDifferences: audit.metricDifferences,
              discrepancySummary: audit.discrepancySummary,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const store = new PostgresDiscoveryParityStore({ query } as any);

    const found = await store.getAudit(audit.id);
    expect(found?.id).toBe(audit.id);

    const missing = await store.getAudit(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(missing).toBeNull();
  });
});

describe("InMemoryDiscoveryParityStore", () => {
  it("saves, retrieves latest, lists, and gets audit by id", async () => {
    const store = new InMemoryDiscoveryParityStore();
    const audit1 = sampleAudit("11111111-1111-4111-8111-111111111111");
    audit1.auditedAt = "2026-11-03T14:40:00.000Z";
    const audit2 = sampleAudit("22222222-2222-4222-8222-222222222222");
    audit2.auditedAt = "2026-11-03T14:45:00.000Z";

    await store.save(audit1);
    await store.save(audit2);

    const latest = await store.loadLatest("CA_TSX");
    expect(latest?.id).toBe(audit2.id);

    const list = await store.listAudits("CA_TSX", 1);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(audit2.id);

    const got = await store.getAudit(audit1.id);
    expect(got?.id).toBe(audit1.id);

    const missing = await store.getAudit(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(missing).toBeNull();
  });
});
