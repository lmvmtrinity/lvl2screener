import { describe, expect, it, vi } from "vitest";
import type { UniverseAutomation } from "@tsx-scanner/contracts";
import { buildApp } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

const automation: UniverseAutomation = {
  provider: "TEST",
  policy: {
    version: "v1",
    marketId: "CA_TSX",
    exchange: "TSX",
    currency: "CAD",
    allowedExchanges: ["TSX"],
    allowedCurrencies: ["CAD"],
    securityTypes: ["Stock"],
    minimumPrice: 5,
    maximumPrice: 150,
    minimumMarketCap: 500_000_000,
    minimumAverageVolume90d: 500_000,
    minimumDollarVolume: 20_000_000,
    minimumAtrPct: 1.5,
    minimumHistoryDays: 20,
  },
  latestRun: null,
  members: [],
};

function status() {
  const probe = { check: async () => ({ status: "ok" as const }) };
  return new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
}

describe("Phase 10 universe API", () => {
  it("exposes automation status/history and supports a manual refresh trigger", async () => {
    const refreshUniverse = vi.fn(async () => []);
    const marketDataService = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => automation,
      getUniverseCandidateStatuses: async () => [
        {
          symbol: "SHOP.TO",
          status: "READY" as const,
          source: "MANUAL" as const,
          discoveredAt: null,
          intakeAt: null,
          strategyReadyAt: null,
          reason: null,
          attemptCount: 0,
        },
      ],
      listUniverseRuns: async () => [],
      refreshUniverse,
    };
    const app = await buildApp({ statusService: status(), marketDataService });

    expect(
      (await app.inject({ method: "GET", url: "/api/universe" })).json(),
    ).toMatchObject({
      automation: {
        provider: "TEST",
        candidateStatuses: [{ symbol: "SHOP.TO", status: "READY" }],
      },
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/universe/runs" })).json(),
    ).toEqual({ runs: [] });
    expect(
      (await app.inject({ method: "POST", url: "/api/universe/refresh" }))
        .statusCode,
    ).toBe(201);
    expect(refreshUniverse).toHaveBeenCalledOnce();
    await app.close();
  });

  it("validates history limits", async () => {
    const marketDataService = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => automation,
      listUniverseRuns: async () => [],
      refreshUniverse: async () => [],
    };
    const app = await buildApp({ statusService: status(), marketDataService });
    expect(
      (await app.inject({ method: "GET", url: "/api/universe/runs?limit=0" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/universe/runs?limit=101" }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });

  it("accepts an explicit CA_TSX filter and fails closed for inactive US data", async () => {
    const marketDataService = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => automation,
      listUniverseRuns: async () => [],
    };
    const app = await buildApp({ statusService: status(), marketDataService });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/universe?marketId=CA_TSX",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/universe?marketId=US_EQUITIES",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/universe?marketId=INVALID",
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("selects active US data without mixing it into the TSX response", async () => {
    const usAutomation: UniverseAutomation = {
      ...automation,
      provider: "MOCK_US_CATALOG",
      policy: {
        ...automation.policy,
        marketId: "US_EQUITIES",
        exchange: undefined,
        currency: undefined,
        allowedExchanges: ["NASDAQ", "NYSE", "NYSE_ARCA"],
        allowedCurrencies: ["USD"],
      },
    };
    const ca = {
      getSnapshot: () => ({}),
      getInstruments: () => [{ marketId: "CA_TSX", symbol: "SHOP.TO" }],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => automation,
      listUniverseRuns: async () => [],
    };
    const us = {
      getSnapshot: () => ({}),
      getInstruments: () => [{ marketId: "US_EQUITIES", symbol: "AAPL" }],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => usAutomation,
      listUniverseRuns: async () => [],
    };
    const app = await buildApp({
      statusService: status(),
      marketDataService: ca,
      marketDataServices: { CA_TSX: ca, US_EQUITIES: us },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/universe?marketId=US_EQUITIES",
        })
      ).json(),
    ).toMatchObject({
      instruments: [{ marketId: "US_EQUITIES", symbol: "AAPL" }],
      automation: { provider: "MOCK_US_CATALOG" },
    });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/universe?marketId=ALL" })
      ).json(),
    ).toMatchObject({
      automations: [{ provider: "TEST" }, { provider: "MOCK_US_CATALOG" }],
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/market/status?marketId=ALL",
        })
      ).json(),
    ).toMatchObject({
      markets: [{ marketId: "CA_TSX" }, { marketId: "US_EQUITIES" }],
    });
    await app.close();
  });

  it("validates and replaces the editable watchlist", async () => {
    const replaceUniverseSymbols = vi.fn(async () => []);
    const marketDataService = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => ({
        ...automation,
        editable: true,
        configuredSymbols: ["BTO.TO"],
      }),
      replaceUniverseSymbols,
    };
    const app = await buildApp({ statusService: status(), marketDataService });

    const updated = await app.inject({
      method: "PUT",
      url: "/api/universe/watchlist",
      payload: { symbols: [" TSX:shop ", "BTO", "SHOP.TO"] },
    });
    expect(updated.statusCode).toBe(200);
    expect(replaceUniverseSymbols).toHaveBeenCalledWith(["SHOP.TO", "BTO.TO"]);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/universe/watchlist",
          payload: { symbols: [] },
        })
      ).statusCode,
    ).toBe(200);
    expect(replaceUniverseSymbols).toHaveBeenLastCalledWith([]);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/universe/watchlist",
          payload: { symbols: ["not a symbol"] },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("returns the structured Phase 7 candidate paste report", async () => {
    const pasteReport = {
      accepted: [],
      normalized: [
        {
          originalInput: "TSX:SHOP",
          normalizedSymbol: "SHOP.TO",
          reason: null,
        },
      ],
      duplicate: [
        {
          originalInput: "SHOP",
          normalizedSymbol: "SHOP.TO",
          reason: "Already present",
        },
      ],
      unsupported: [],
      failed: [],
    };
    const updateUniverseCandidates = vi.fn(async () => ({
      instruments: [],
      pasteReport,
      refreshError: "quote unavailable",
    }));
    const marketDataService = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => ({
        ...automation,
        editable: true,
        configuredSymbols: ["SHOP.TO"],
      }),
      updateUniverseCandidates,
    };
    const app = await buildApp({ statusService: status(), marketDataService });

    const response = await app.inject({
      method: "POST",
      url: "/api/universe/candidates",
      payload: {
        operation: "ADD",
        source: "TRADINGVIEW",
        inputs: ["TSX:SHOP", "SHOP"],
        note: "Morning scan",
        tags: ["gap-up"],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      automation: { configuredSymbols: ["SHOP.TO"] },
      pasteReport,
      refreshError: "quote unavailable",
    });
    expect(updateUniverseCandidates).toHaveBeenCalledWith({
      operation: "ADD",
      source: "TRADINGVIEW",
      inputs: ["TSX:SHOP", "SHOP"],
      note: "Morning scan",
      tags: ["gap-up"],
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/universe/candidates",
          payload: { operation: "APPEND", inputs: [] },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("routes candidate intake to US_EQUITIES when requested and isolates it from CA_TSX", async () => {
    const updateCaCandidates = vi.fn(async () => ({
      instruments: [],
      pasteReport: {
        accepted: [],
        normalized: [],
        duplicate: [],
        unsupported: [],
        failed: [],
      },
    }));
    const updateUsCandidates = vi.fn(async () => ({
      instruments: [{ marketId: "US_EQUITIES", symbol: "AAPL" }],
      pasteReport: {
        accepted: [
          { originalInput: "AAPL", normalizedSymbol: "AAPL", reason: null },
        ],
        normalized: [],
        duplicate: [],
        unsupported: [],
        failed: [],
      },
    }));
    const ca = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => automation,
      listUniverseRuns: async () => [],
      updateUniverseCandidates: updateCaCandidates,
    };
    const us = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getUniverseAutomation: () => ({
        ...automation,
        policy: { ...automation.policy, marketId: "US_EQUITIES" as const },
      }),
      listUniverseRuns: async () => [],
      updateUniverseCandidates: updateUsCandidates,
    };
    const app = await buildApp({
      statusService: status(),
      marketDataService: ca,
      marketDataServices: { CA_TSX: ca, US_EQUITIES: us },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/universe/candidates?marketId=US_EQUITIES",
      payload: {
        operation: "ADD",
        source: "TRADINGVIEW",
        inputs: ["AAPL"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateUsCandidates).toHaveBeenCalledOnce();
    expect(updateCaCandidates).not.toHaveBeenCalled();

    const rejectAll = await app.inject({
      method: "POST",
      url: "/api/universe/candidates?marketId=ALL",
      payload: {
        operation: "ADD",
        source: "TRADINGVIEW",
        inputs: ["AAPL"],
      },
    });
    expect(rejectAll.statusCode).toBe(400);

    await app.close();
  });
});
