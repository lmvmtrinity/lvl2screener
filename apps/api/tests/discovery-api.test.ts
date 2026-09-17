import { describe, expect, it, vi } from "vitest";
import type { DiscoveryApi } from "../src/api-types.js";
import type {
  DiscoveryModeState,
  DiscoveryRun,
  DiscoveryStatus,
} from "@tsx-scanner/contracts";
import {
  discoveryPolicyForMarket,
  discoveryAttemptDiagnosticsSchema,
  discoveryStatusSchema,
} from "@tsx-scanner/contracts";
import { DiscoveryAttemptDiagnosticsCollector } from "../src/universe/discovery-attempt-diagnostics.js";
import { DiscoveryScheduler } from "../src/universe/discovery-scheduler.js";
import { buildApp } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

function statusService() {
  const probe = { check: async () => ({ status: "ok" as const }) };
  return new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
}

const run: DiscoveryRun = {
  id: "00000000-0000-4000-8000-000000000001",
  marketId: "CA_TSX",
  tradingDate: "2026-09-08",
  policyVersion: "ca-discovery-v1",
  mode: "SHADOW",
  evaluationAt: "2026-09-08T14:00:00.000Z",
  completedBarEnd: "2026-09-08T13:55:00.000Z",
  catalogDigest: "a".repeat(64),
  status: "COMPLETED",
  coverage: { total: 0, pass: 0, fail: 0, unevaluable: 0, deferred: 0 },
  startedAt: "2026-09-08T14:00:00.000Z",
  completedAt: "2026-09-08T14:00:01.000Z",
  failure: null,
};

const mode: DiscoveryModeState = {
  marketId: "CA_TSX",
  mode: "SHADOW",
  revision: 1,
  updatedAt: "2026-09-08T13:00:00.000Z",
  actor: "test",
  reason: "test",
};

function discoveryService(): DiscoveryApi {
  const discoveryStatus = {
    marketId: "CA_TSX",
    mode: "SHADOW",
    revision: 1,
    modeUpdatedAt: mode.updatedAt,
    modeActor: mode.actor,
    scheduler: "IDLE",
    policy: discoveryPolicyForMarket("CA_TSX"),
    catalog: {
      status: "FRESH",
      source: "EODHD",
      tradingDate: "2026-09-08",
      fetchedAt: "2026-09-08T13:59:00.000Z",
      ageMs: 60_000,
      rowCount: 0,
      admittedCount: 0,
      failure: null,
    },
    lastRun: run,
    nextEvaluationAt: null,
    activeRunId: null,
    queueDepth: 0,
    oldestQueueAgeMs: 0,
    lastError: null,
    budget: {
      remainingHour: null,
      remainingDiscoveryHour: null,
      queued: 0,
      active: 0,
    },
  } as DiscoveryStatus;

  return {
    status: vi.fn(async () => discoveryStatus),
    listRuns: vi.fn(async () => [run]),
    listEvaluations: vi.fn(async () => []),
    preview: vi.fn(async () => run),
    changeMode: vi.fn(async () => mode),
    changeExclusion: vi.fn(async () => undefined),
    parityStatus: vi.fn(async () => ({
      marketId: "CA_TSX" as const,
      latestAudit: null,
      auditCount: 10,
      averageOverlapRatio: 0.855,
      lastAuditedAt: "2026-09-08T14:00:00.000Z",
    })),
    listParityAudits: vi.fn(async () => []),
    compareParity: vi.fn(async () => ({
      id: "20000000-0000-4000-8000-000000000001",
      marketId: "CA_TSX" as const,
      tradingDate: "2026-09-08",
      runId: run.id,
      auditedAt: "2026-09-08T14:00:00.000Z",
      tradingViewCount: 2,
      questradePassCount: 2,
      overlapCount: 2,
      overlapRatio: 1,
      overlapSymbols: ["SHOP", "ENB"],
      missedMovers: [],
      questradeOnly: [],
      metricDifferences: [],
      discrepancySummary: {
        FORMULA_DIFFERENCE: 0,
        FORMING_VS_COMPLETED_BAR: 0,
        VOLUME_COVERAGE: 0,
        TIMESTAMP_LAG: 0,
        CORPORATE_ACTION: 0,
        CLASSIFICATION_MISMATCH: 0,
        THRESHOLD_BOUNDARY: 0,
        OTHER: 0,
      },
    })),
    fastFunnelStatus: vi.fn(async () => ({
      marketId: "CA_TSX" as const,
      enabled: true,
      lastAcceleratedAt: "2026-09-08T14:00:00.000Z",
      topMoversCount: 15,
      topMoverSymbols: ["SHOP", "ENB"],
      acceleratedCandidatesCount: 15,
      acceleratedEvaluatedCount: 42,
      acceleratedPassedCount: 5,
    })),
  };
}

describe("discovery API", () => {
  function diagnostic() {
    const {
      wallMs,
      stages: { EVIDENCE, ...stages },
      ...draft
    } = new DiscoveryAttemptDiagnosticsCollector(
      {
        attemptId: "10000000-0000-4000-8000-000000000003",
        attemptKind: "FRESH",
        marketId: "US_EQUITIES",
        startedAt: new Date(run.startedAt),
        collectionDeadlineAt: new Date("2026-09-08T14:02:00.000Z"),
      },
      () => 0,
    ).finish();
    return {
      ...draft,
      preCompletionWallMs: wallMs,
      timingBoundary: "BEFORE_COMPLETION_TRANSACTION",
      stages: { ...stages, PRE_COMPLETION_PERSISTENCE: EVIDENCE },
      schemaVersion: "discovery-attempt-diagnostics-v1",
      runId: run.id,
      capturedAt: run.completedAt,
      frozenEvaluationAt: run.evaluationAt,
      finalRunCoverage: {
        total: 5,
        pass: 0,
        fail: 0,
        unevaluable: 1,
        deferred: 4,
      },
    };
  }

  it("validates bounded completed diagnostics and rejects member or raw fields at every level", () => {
    const summary = diagnostic();
    expect(discoveryAttemptDiagnosticsSchema.safeParse(summary).success).toBe(
      true,
    );
    for (const invalid of [
      { ...summary, symbol: "SECRET" },
      { ...summary, wallMs: 1 },
      { ...summary, timingBoundary: "AFTER_COMMIT" },
      {
        ...summary,
        stages: {
          ...summary.stages,
          INPUT_COLLECTION: {
            ...summary.stages.INPUT_COLLECTION,
            symbols: ["SECRET"],
          },
        },
      },
      {
        ...summary,
        requests: {
          ...summary.requests,
          QUOTE: { ...summary.requests.QUOTE, url: "https://secret.invalid" },
        },
      },
      { ...summary, reasonCounts: { SECRET: 1 } },
      { ...summary, finalRunCoverage: null },
      { ...summary, schemaVersion: "unknown" },
    ])
      expect(discoveryAttemptDiagnosticsSchema.safeParse(invalid).success).toBe(
        false,
      );
  });

  it("exposes only the requested market's latest persisted diagnostic through scheduler status", async () => {
    const summary = diagnostic();
    const lookup = vi.fn(async (marketId: string) =>
      marketId === "US_EQUITIES" ? summary : null,
    );
    const services = Object.fromEntries(
      (["CA_TSX", "US_EQUITIES"] as const).map((marketId) => {
        const scheduler = new DiscoveryScheduler({
          marketId,
          controlStore: { getMode: async () => ({ ...mode, marketId }) },
          evidenceStore: {
            listRuns: async () => [],
            listLatestDiagnostics: lookup,
          },
          catalogStore: { loadLatest: async () => null },
        } as never);
        return [
          marketId,
          { ...discoveryService(), status: () => scheduler.getStatus() },
        ];
      }),
    );
    const app = await buildApp({
      statusService: statusService(),
      discoveryServices: services,
    });
    try {
      const us = await app.inject({
        method: "GET",
        url: "/api/discovery/status?marketId=US_EQUITIES",
      });
      const ca = await app.inject({
        method: "GET",
        url: "/api/discovery/status?marketId=CA_TSX",
      });
      expect(us.statusCode).toBe(200);
      expect(discoveryStatusSchema.parse(us.json())).toMatchObject({
        marketId: "US_EQUITIES",
        latestAttemptDiagnostics: {
          marketId: "US_EQUITIES",
          runId: run.id,
          attemptId: "10000000-0000-4000-8000-000000000003",
          timingBoundary: "BEFORE_COMPLETION_TRANSACTION",
          preCompletionWallMs: 0,
          stages: {
            PRE_COMPLETION_PERSISTENCE: { wallMs: 0, cumulativeMs: 0 },
          },
        },
      });
      expect(ca.json()).toMatchObject({
        marketId: "CA_TSX",
        latestAttemptDiagnostics: null,
      });
      expect(lookup.mock.calls).toEqual([["US_EQUITIES"], ["CA_TSX"]]);
    } finally {
      await app.close();
    }
  });

  it("requires an explicit market and preserves market-scoped service selection", async () => {
    const service = discoveryService();
    const app = await buildApp({
      statusService: statusService(),
      discoveryServices: { CA_TSX: service },
    });

    expect(
      (await app.inject({ method: "GET", url: "/api/discovery/status" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/discovery/status?marketId=US_EQUITIES",
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/discovery/status?marketId=CA_TSX",
        })
      ).json(),
    ).toMatchObject({ marketId: "CA_TSX", mode: "SHADOW" });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/discovery/runs?marketId=CA_TSX&limit=1",
        })
      ).json(),
    ).toMatchObject({ runs: [run] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/discovery/evaluations?marketId=CA_TSX&runId=${run.id}`,
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("keeps preview available while refusing AUTO_ADD and exposing exclusions", async () => {
    const service = discoveryService();
    const app = await buildApp({
      statusService: statusService(),
      discoveryService: service,
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/discovery/preview",
          payload: { marketId: "CA_TSX" },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/discovery/mode",
          payload: {
            marketId: "CA_TSX",
            mode: "AUTO_ADD",
            expectedRevision: 1,
            reason: "test",
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(service.changeMode).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/discovery/exclusion",
          payload: {
            marketId: "CA_TSX",
            tradingDate: "2026-09-08",
            instrumentId: run.id,
            excluded: true,
            reason: "test",
          },
        })
      ).statusCode,
    ).toBe(204);
    await app.close();
  });

  it("exposes parity status and audit history", async () => {
    const service = discoveryService();
    const app = await buildApp({
      statusService: statusService(),
      discoveryService: service,
    });

    expect(
      (await app.inject({ method: "GET", url: "/api/discovery/parity" }))
        .statusCode,
    ).toBe(400);

    const response = await app.inject({
      method: "GET",
      url: "/api/discovery/parity?marketId=CA_TSX&limit=10",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: {
        marketId: "CA_TSX",
        auditCount: 10,
        averageOverlapRatio: 0.855,
      },
      audits: [],
    });
    await app.close();
  });

  it("triggers parity comparison via POST /api/discovery/parity/compare", async () => {
    const service = discoveryService();
    const app = await buildApp({
      statusService: statusService(),
      discoveryService: service,
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/discovery/parity/compare",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);

    const response = await app.inject({
      method: "POST",
      url: "/api/discovery/parity/compare",
      payload: { marketId: "CA_TSX", runId: run.id },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      marketId: "CA_TSX",
      runId: run.id,
      overlapCount: 2,
    });
    await app.close();
  });

  it("exposes fast-funnel accelerator status via GET /api/discovery/fast-funnel", async () => {
    const service = discoveryService();
    const app = await buildApp({
      statusService: statusService(),
      discoveryService: service,
    });

    expect(
      (await app.inject({ method: "GET", url: "/api/discovery/fast-funnel" }))
        .statusCode,
    ).toBe(400);

    const response = await app.inject({
      method: "GET",
      url: "/api/discovery/fast-funnel?marketId=CA_TSX",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      marketId: "CA_TSX",
      enabled: true,
      topMoversCount: 15,
      acceleratedCandidatesCount: 15,
      acceleratedEvaluatedCount: 42,
      acceleratedPassedCount: 5,
    });
    await app.close();
  });
});
