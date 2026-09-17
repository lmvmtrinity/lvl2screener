import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import {
  FoundationStatusService,
  type OperationalStatusSource,
} from "../src/foundation/status-service.js";
import type { OperationalStatusInput } from "../src/foundation/operational-status.js";
import { API_VERSION } from "../src/version.js";

const NOW = new Date("2026-08-24T14:00:00.000Z");

function probe(status: "ok" | "error", detail: string): DependencyProbe {
  return { check: async () => ({ status, detail }) };
}

function service(database: "ok" | "error" = "ok") {
  return new FoundationStatusService(
    {
      database: probe(database, "database"),
      scanner: probe("ok", "scanner 0.1.0"),
      marketData: probe("ok", "mock initialized"),
    },
    () => NOW,
  );
}

describe("foundation API", () => {
  it("reports process liveness without checking dependencies", async () => {
    const app = await buildApp({ statusService: service(), clock: () => NOW });
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "api",
      status: "ok",
      version: API_VERSION,
      timestamp: NOW.toISOString(),
    });
    await app.close();
  });

  it("reports ready when all service boundaries are healthy", async () => {
    const app = await buildApp({ statusService: service() });
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      mode: "mock",
      checks: {
        database: { status: "ok" },
        scanner: { status: "ok" },
        marketData: { status: "ok" },
      },
    });
    await app.close();
  });

  it("fails readiness but keeps the status endpoint available when a dependency is down", async () => {
    const app = await buildApp({ statusService: service("error") });
    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    const status = await app.inject({
      method: "GET",
      url: "/api/system/status",
    });

    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: "degraded",
      checks: { database: { status: "error" } },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: "degraded" });
    await app.close();
  });

  it("exposes market status, enriched universe, and Phase 3 features", async () => {
    const marketDataService = {
      getSnapshot: () => ({
        state: "ACTIVE",
        dataStatus: "REALTIME",
        instrumentCount: 1,
      }),
      getInstruments: () => [
        { id: "instrument-1", symbol: "BTO.TO", symbolId: 1001 },
      ],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: (symbol: string) =>
        symbol === "BTO.TO"
          ? { symbol, computedAt: NOW.toISOString() }
          : undefined,
      getAlerts: () => [{ alertId: "alert-1", type: "READY" }],
      getSignals: () => [{ symbol: "BTO.TO", type: "READY" }],
    };
    const app = await buildApp({ statusService: service(), marketDataService });

    const market = await app.inject({
      method: "GET",
      url: "/api/market/status",
    });
    const universe = await app.inject({ method: "GET", url: "/api/universe" });
    const features = await app.inject({ method: "GET", url: "/api/features" });
    const featureDetail = await app.inject({
      method: "GET",
      url: "/api/features/BTO.TO",
    });
    const missingFeatureDetail = await app.inject({
      method: "GET",
      url: "/api/features/NOPE.TO",
    });
    const signals = await app.inject({ method: "GET", url: "/api/signals" });
    const alerts = await app.inject({
      method: "GET",
      url: "/api/alerts?limit=1",
    });

    expect(market.json()).toMatchObject({
      state: "ACTIVE",
      dataStatus: "REALTIME",
    });
    expect(universe.json()).toEqual({
      instruments: [{ id: "instrument-1", symbol: "BTO.TO", symbolId: 1001 }],
    });
    expect(features.json()).toEqual({ snapshots: [] });
    expect(featureDetail.json()).toEqual({
      symbol: "BTO.TO",
      computedAt: NOW.toISOString(),
    });
    expect(missingFeatureDetail.statusCode).toBe(404);
    expect(signals.json()).toEqual({
      signals: [{ symbol: "BTO.TO", type: "READY" }],
    });
    expect(alerts.json()).toEqual({
      alerts: [{ alertId: "alert-1", type: "READY" }],
    });
    await app.close();
  });

  it("serves explicitly selected market metrics with a market label", async () => {
    const marketService = (instrumentCount: number) => ({
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getObservability: () => ({
        state: "ACTIVE",
        auth: "CONNECTED",
        dataStatus: "REALTIME",
        instrumentCount,
        quoteAgeMs: 100,
        candleAgeMs: 200,
        benchmarkAgeMs: 300,
        evaluationAgeMs: 400,
        cycleLatencyMs: 5,
        engineLatencyMs: 4,
        featureLatencyMs: 3,
        evaluationLatencyMs: 2,
        missingBarsCount: 0,
        readySymbols: instrumentCount,
        warmingSymbols: 0,
        unavailableSymbols: 0,
        alertsDeliveredTotal: 0,
        evaluationsWrittenTotal: instrumentCount,
      }),
    });
    const ca = marketService(3);
    const us = marketService(7);
    const app = await buildApp({
      statusService: service(),
      marketDataService: ca,
      marketDataServices: { CA_TSX: ca, US_EQUITIES: us },
    });

    const defaultMetrics = await app.inject({ method: "GET", url: "/metrics" });
    const caMetrics = await app.inject({
      method: "GET",
      url: "/metrics?marketId=CA_TSX",
    });
    const usMetrics = await app.inject({
      method: "GET",
      url: "/metrics?marketId=US_EQUITIES",
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/metrics?marketId=GB_LSE",
    });

    expect(defaultMetrics.statusCode).toBe(200);
    expect(defaultMetrics.body).toContain("scanner_instrument_count 3");
    expect(caMetrics.body).toContain(
      'scanner_instrument_count{market_id="CA_TSX"} 3',
    );
    expect(usMetrics.body).toContain(
      'scanner_instrument_count{market_id="US_EQUITIES"} 7',
    );
    expect(usMetrics.body).not.toContain("scanner_instrument_count 3");
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("keeps /health/ready scoped to service readiness: an AUTH_REQUIRED market-data probe does not turn it into a 503", async () => {
    const app = await buildApp({
      statusService: new FoundationStatusService(
        {
          database: probe("ok", "database"),
          scanner: probe("ok", "scanner 0.1.0"),
          // marketData being unhealthy (e.g. Questrade auth required) is business actionability,
          // not "can this service serve the operator UI" — /health/ready must not gate on it.
          marketData: probe("error", "AUTH_REQUIRED"),
        },
        () => NOW,
      ),
    });
    const readiness = await app.inject({ method: "GET", url: "/health/ready" });

    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      status: "ok",
      checks: { marketData: { status: "error" } },
    });
    await app.close();
  });

  it("surfaces the shared operational-status contract on /api/system/status, non-actionable with AUTH_REQUIRED, even while the service itself is ready", async () => {
    const operationalSource: OperationalStatusSource = {
      getOperationalStatusInput: () =>
        ({
          auth: "AUTH_REQUIRED",
          marketStatus: "OPEN",
          phase: "PREFERRED_ENTRIES",
          quoteAgeMs: null,
          candleAgeMs: null,
          benchmarkAgeMs: null,
          evaluationAgeMs: null,
          universeConfigured: 150,
          universeResolved: 150,
          universeEvaluated: 42,
          benchmarkReady: true,
          scannerSynchronized: true,
        }) satisfies Omit<
          OperationalStatusInput,
          "databaseReady" | "scannerReady" | "marketDataMode"
        >,
    };
    const app = await buildApp({
      statusService: new FoundationStatusService(
        {
          database: probe("ok", "database"),
          scanner: probe("ok", "scanner 0.1.0"),
          marketData: probe("error", "AUTH_REQUIRED"),
        },
        () => NOW,
        "live",
        operationalSource,
      ),
    });
    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    const status = await app.inject({
      method: "GET",
      url: "/api/system/status",
    });

    expect(readiness.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      mode: "live",
      operational: {
        actionable: false,
        auth: "AUTH_REQUIRED",
      },
    });
    expect(status.json().operational.reasonCodes).toContain("AUTH_REQUIRED");
    await app.close();
  });

  it("reports WAITING_FOR_CANDIDATES (not ACTIVE) for an empty open-session universe without blocking readiness", async () => {
    const operationalSource: OperationalStatusSource = {
      getOperationalStatusInput: () => ({
        auth: "CONNECTED",
        marketStatus: "OPEN",
        phase: "PREFERRED_ENTRIES",
        quoteAgeMs: 500,
        candleAgeMs: 500,
        benchmarkAgeMs: 500,
        evaluationAgeMs: null,
        universeConfigured: 150,
        universeResolved: 150,
        universeEvaluated: 0,
        benchmarkReady: true,
        scannerSynchronized: true,
      }),
    };
    const app = await buildApp({
      statusService: new FoundationStatusService(
        {
          database: probe("ok", "database"),
          scanner: probe("ok", "scanner 0.1.0"),
          marketData: probe("ok", "connected"),
        },
        () => NOW,
        "live",
        operationalSource,
      ),
    });
    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    const status = await app.inject({
      method: "GET",
      url: "/api/system/status",
    });

    expect(readiness.statusCode).toBe(200);
    const operational = status.json().operational;
    expect(operational.actionable).toBe(false);
    expect(operational.reasonCodes).toContain("WAITING_FOR_CANDIDATES");
    await app.close();
  });

  it("scopes /api/system/status operational fields to the requested market", async () => {
    type MarketInput = Omit<
      OperationalStatusInput,
      "databaseReady" | "scannerReady" | "marketDataMode"
    >;
    const caInput: MarketInput = {
      auth: "CONNECTED",
      marketStatus: "OPEN",
      phase: "PREFERRED_ENTRIES",
      quoteAgeMs: 100,
      candleAgeMs: 100,
      benchmarkAgeMs: 100,
      evaluationAgeMs: 100,
      universeConfigured: 3,
      universeResolved: 3,
      universeEvaluated: 3,
      benchmarkReady: true,
      scannerSynchronized: true,
    };
    const usInput: MarketInput = {
      auth: "AUTH_REQUIRED",
      marketStatus: "CLOSED",
      phase: null,
      quoteAgeMs: null,
      candleAgeMs: null,
      benchmarkAgeMs: null,
      evaluationAgeMs: null,
      universeConfigured: 7,
      universeResolved: 0,
      universeEvaluated: 0,
      benchmarkReady: false,
      scannerSynchronized: false,
    };
    const make = (input: MarketInput) => ({
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getOperationalStatusInput: () => input,
    });
    const ca = make(caInput);
    const us = make(usInput);
    const app = await buildApp({
      statusService: service(),
      marketDataService: ca,
      marketDataServices: { CA_TSX: ca, US_EQUITIES: us },
    });

    const caStatus = await app.inject({
      method: "GET",
      url: "/api/system/status?marketId=CA_TSX",
    });
    const usStatus = await app.inject({
      method: "GET",
      url: "/api/system/status?marketId=US_EQUITIES",
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/system/status?marketId=GB_LSE",
    });

    expect(caStatus.json().operational).toMatchObject({
      actionable: true,
      auth: "CONNECTED",
    });
    expect(usStatus.json().operational.auth).toBe("AUTH_REQUIRED");
    expect(usStatus.json().operational.reasonCodes).toEqual(
      expect.arrayContaining([
        "AUTH_REQUIRED",
        "MARKET_CLOSED",
        "BENCHMARKS_UNRESOLVED",
        "SCANNER_OUT_OF_SYNC",
        "WAITING_FOR_CANDIDATES",
      ]),
    );
    expect(usStatus.json().operational.universe).toEqual({
      configured: 7,
      resolved: 0,
      evaluated: 0,
    });
    // The CA runtime's actionable result must not leak into the US response.
    expect(usStatus.json().operational.actionable).toBe(false);
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("returns 409 for a market that is not active in this runtime", async () => {
    const ca = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getOperationalStatusInput: () => ({
        auth: "CONNECTED" as const,
        marketStatus: "OPEN",
        phase: "PREFERRED_ENTRIES",
        quoteAgeMs: 100,
        candleAgeMs: 100,
        benchmarkAgeMs: 100,
        evaluationAgeMs: 100,
        universeConfigured: 3,
        universeResolved: 3,
        universeEvaluated: 3,
        benchmarkReady: true,
        scannerSynchronized: true,
      }),
    };
    const app = await buildApp({
      statusService: service(),
      marketDataService: ca,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/system/status?marketId=US_EQUITIES",
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("validates the alert-history limit", async () => {
    const marketDataService = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getAlerts: () => [],
    };
    const app = await buildApp({ statusService: service(), marketDataService });
    expect(
      (await app.inject({ method: "GET", url: "/api/alerts?limit=0" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/alerts?limit=201" }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });
});
