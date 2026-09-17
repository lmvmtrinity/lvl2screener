import { describe, expect, it, vi } from "vitest";
import { FastFunnelAccelerator } from "../src/universe/fast-funnel-accelerator.js";
import { TradingViewScannerClient } from "../src/universe/tradingview-scanner-client.js";
import type { CatalogMember } from "../src/universe/eodhd-catalog.js";

function makeMember(code: string, exchange = "TSX"): CatalogMember {
  return {
    providerCode: code,
    raw: {
      Code: code,
      Name: `${code} Inc`,
      Exchange: exchange,
      Currency: "CAD",
      Type: "Common Stock",
      Isin: "CA1234567890",
    },
    reasons: [],
    resolutionStatus: "PENDING",
  };
}

describe("FastFunnelAccelerator", () => {
  it("prioritizes active movers to the front of catalog queue while preserving remaining members", async () => {
    const catalog: CatalogMember[] = [
      makeMember("RY"),
      makeMember("TD"),
      makeMember("SHOP"),
      makeMember("CVE"),
      makeMember("ENB"),
    ];

    const mockTvClient = {
      fetchTopMovers: vi.fn(async () => [
        {
          symbol: "CVE",
          exchange: "TSX",
          fullSymbol: "TSX:CVE",
          price: 24.5,
          changeFromOpenPct: 2.1,
          relativeVolume: 3.2,
          averageVolume90d: 5000000,
          marketCap: 45000000000,
          observedAt: new Date().toISOString(),
        },
        {
          symbol: "SHOP",
          exchange: "TSX",
          fullSymbol: "TSX:SHOP",
          price: 105.0,
          changeFromOpenPct: 1.8,
          relativeVolume: 2.5,
          averageVolume90d: 1200000,
          marketCap: 135000000000,
          observedAt: new Date().toISOString(),
        },
      ]),
    } as unknown as TradingViewScannerClient;

    const accelerator = new FastFunnelAccelerator({
      marketId: "CA_TSX",
      tvClient: mockTvClient,
      enabled: true,
    });

    const topMovers = await accelerator.getTopMovers();
    expect(topMovers).toEqual(["CVE", "SHOP"]);

    const prioritized = accelerator.prioritizeCatalogMembers(
      catalog,
      topMovers,
    );

    // Accelerated members are at the front in order of top movers
    expect(prioritized.map((m) => m.providerCode)).toEqual([
      "CVE",
      "SHOP",
      "RY",
      "TD",
      "ENB",
    ]);
  });

  it("caches top movers within TTL and avoids duplicate provider calls", async () => {
    let now = 1000;
    const mockTvClient = {
      fetchTopMovers: vi.fn(async () => [
        {
          symbol: "BMO",
          exchange: "TSX",
          fullSymbol: "TSX:BMO",
          price: 120.0,
          changeFromOpenPct: 1.2,
          relativeVolume: 1.9,
          averageVolume90d: 1000000,
          marketCap: 90000000000,
          observedAt: new Date().toISOString(),
        },
      ]),
    } as unknown as TradingViewScannerClient;

    const accelerator = new FastFunnelAccelerator({
      marketId: "CA_TSX",
      tvClient: mockTvClient,
      enabled: true,
      cacheTtlMs: 5000,
      clock: () => new Date(now),
    });

    const movers1 = await accelerator.getTopMovers();
    expect(movers1).toEqual(["BMO"]);
    expect(mockTvClient.fetchTopMovers).toHaveBeenCalledTimes(1);

    // Call again 2 seconds later (within TTL)
    now += 2000;
    const movers2 = await accelerator.getTopMovers();
    expect(movers2).toEqual(["BMO"]);
    expect(mockTvClient.fetchTopMovers).toHaveBeenCalledTimes(1);

    // Call again 6 seconds later (TTL expired)
    now += 6000;
    const movers3 = await accelerator.getTopMovers();
    expect(movers3).toEqual(["BMO"]);
    expect(mockTvClient.fetchTopMovers).toHaveBeenCalledTimes(2);
  });

  it("gracefully falls back to standard catalog ordering if TV query fails", async () => {
    const catalog: CatalogMember[] = [makeMember("A"), makeMember("B")];
    const mockTvClient = {
      fetchTopMovers: vi.fn(async () => {
        throw new Error("Network timeout");
      }),
    } as unknown as TradingViewScannerClient;

    const accelerator = new FastFunnelAccelerator({
      marketId: "CA_TSX",
      tvClient: mockTvClient,
      enabled: true,
    });

    const topMovers = await accelerator.getTopMovers();
    expect(topMovers).toEqual([]);

    const prioritized = accelerator.prioritizeCatalogMembers(
      catalog,
      topMovers,
    );
    expect(prioritized.map((m) => m.providerCode)).toEqual(["A", "B"]);
  });

  it("ignores top movers that are not present in the validated catalog", async () => {
    const catalog: CatalogMember[] = [makeMember("RY"), makeMember("TD")];
    const accelerator = new FastFunnelAccelerator({
      marketId: "CA_TSX",
      tvClient: {} as TradingViewScannerClient,
    });

    // UNKNOWN is not in catalog
    const prioritized = accelerator.prioritizeCatalogMembers(catalog, [
      "UNKNOWN",
      "TD",
    ]);
    expect(prioritized.map((m) => m.providerCode)).toEqual(["TD", "RY"]);
  });

  it("records per-cycle results and reports status correctly", () => {
    const accelerator = new FastFunnelAccelerator({
      marketId: "CA_TSX",
      tvClient: {} as TradingViewScannerClient,
      enabled: true,
    });

    accelerator.recordCycleResults({
      acceleratedCount: 15,
      evaluatedCount: 12,
      passedCount: 3,
    });
    // A later cycle replaces the previous counters, never accumulating them.
    accelerator.recordCycleResults({
      acceleratedCount: 4,
      evaluatedCount: 2,
      passedCount: 1,
    });

    const status = accelerator.getStatus();
    expect(status.marketId).toBe("CA_TSX");
    expect(status.enabled).toBe(true);
    expect(status.acceleratedCandidatesCount).toBe(4);
    expect(status.acceleratedEvaluatedCount).toBe(2);
    expect(status.acceleratedPassedCount).toBe(1);
  });

  it("stays disabled and performs no provider call by default", async () => {
    const fetchTopMovers = vi.fn(async () => []);
    const accelerator = new FastFunnelAccelerator({
      marketId: "CA_TSX",
      tvClient: { fetchTopMovers } as unknown as TradingViewScannerClient,
    });

    expect(accelerator.isEnabled()).toBe(false);
    expect(accelerator.getStatus().enabled).toBe(false);
    expect(await accelerator.getTopMovers()).toEqual([]);
    expect(fetchTopMovers).not.toHaveBeenCalled();
  });

  it("caches empty top movers list within TTL without re-querying", async () => {
    let callCount = 0;
    const mockTvClient = {
      fetchTopMovers: vi.fn(async () => {
        callCount++;
        return [];
      }),
    } as unknown as TradingViewScannerClient;

    let currentTime = 100000;
    const accelerator = new FastFunnelAccelerator({
      marketId: "CA_TSX",
      tvClient: mockTvClient,
      enabled: true,
      cacheTtlMs: 60_000,
      clock: () => new Date(currentTime),
    });

    const res1 = await accelerator.getTopMovers();
    expect(res1).toEqual([]);
    expect(callCount).toBe(1);

    // Within TTL (30s later)
    currentTime += 30_000;
    const res2 = await accelerator.getTopMovers();
    expect(res2).toEqual([]);
    expect(callCount).toBe(1); // not called again

    // Beyond TTL (61s later)
    currentTime += 31_000;
    const res3 = await accelerator.getTopMovers();
    expect(res3).toEqual([]);
    expect(callCount).toBe(2); // called again after TTL expiry
  });
});
