import { describe, expect, it, vi } from "vitest";
import type { AlertPolicy, UniverseAutomation } from "@tsx-scanner/contracts";
import { buildApp } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
import { DEFAULT_UNIVERSE_POLICY } from "../src/universe/universe-service.js";

function status() {
  const probe = { check: async () => ({ status: "ok" as const }) };
  return new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
}

describe("Phase 7 operator API", () => {
  it("reads and updates the durable alert cooldown and re-arm policy", async () => {
    let policy: AlertPolicy = {
      cooldownMinutes: 5,
      rearmRule: "NEW_SETUP_INSTANCE",
      contextNotificationsEnabled: false,
    };
    const updateAlertPolicy = vi.fn(
      async (next: AlertPolicy) => (policy = next),
    );
    const marketDataService = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getAlertPolicy: () => policy,
      updateAlertPolicy,
    };
    const app = await buildApp({ statusService: status(), marketDataService });

    expect(
      (await app.inject({ method: "GET", url: "/api/alerts/policy" })).json(),
    ).toEqual(policy);
    const updated = await app.inject({
      method: "PUT",
      url: "/api/alerts/policy",
      payload: {
        cooldownMinutes: 15,
        rearmRule: "AFTER_INVALIDATION",
        contextNotificationsEnabled: false,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      cooldownMinutes: 15,
      rearmRule: "AFTER_INVALIDATION",
    });
    expect(updateAlertPolicy).toHaveBeenCalledOnce();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/alerts/policy",
          payload: {
            cooldownMinutes: 121,
            rearmRule: "NEW_SETUP_INSTANCE",
            contextNotificationsEnabled: false,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/alerts/policy",
          payload: {
            cooldownMinutes: 5,
            rearmRule: "NEW_SETUP_INSTANCE",
            contextNotificationsEnabled: true,
          },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("returns detail diagnostics for an unavailable symbol with no feature or setup", async () => {
    const automation: UniverseAutomation = {
      provider: "TEST",
      policy: DEFAULT_UNIVERSE_POLICY,
      latestRun: null,
      members: [
        {
          instrumentId: null,
          marketId: "CA_TSX",
          symbol: "BAD.TO",
          description: "",
          exchange: "",
          normalizedExchange: "UNKNOWN",
          rawExchange: null,
          currency: "CAD",
          sector: null,
          eligible: false,
          reasons: ["METADATA_UNAVAILABLE"],
          price: null,
          marketCap: null,
          averageVolume20d: null,
          averageVolume90d: null,
          dollarVolume: null,
          atr14: null,
          atrPct: null,
          metricsAsOf: "2026-08-28T14:00:00.000Z",
        },
      ],
      coverage: [
        {
          symbol: "BAD.TO",
          status: "UNAVAILABLE",
          dataReadiness: "UNAVAILABLE",
          warmupPending: [],
          setupCount: 0,
          contextCount: 0,
          latestAnalysisAt: null,
          reasons: ["Symbol could not be resolved"],
        },
      ],
    };
    const marketDataService = {
      getSnapshot: () => ({}),
      getInstruments: () => [],
      getFeatureSnapshots: () => [],
      getFeatureSnapshot: () => undefined,
      getCandidate: () => [],
      getContexts: () => [],
      getSignals: () => [],
      getCandles: () => [],
      getUniverseAutomation: () => automation,
    };
    const app = await buildApp({ statusService: status(), marketDataService });
    const response = await app.inject({
      method: "GET",
      url: "/api/candidates/BAD.TO",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      symbol: "BAD.TO",
      strategies: [],
      feature: null,
      member: { eligible: false },
      coverage: { status: "UNAVAILABLE" },
    });
    await app.close();
  });
});
