import type { FastifyInstance } from "fastify";
import {
  renderPrometheusMetrics,
  type ObservabilitySnapshot,
} from "../observability/metrics.js";
import { API_VERSION } from "../version.js";
import {
  createSnapshotBroadcaster,
  selectBroadcastAlerts,
} from "../market-data/ws-frame.js";
import type { BuildAppOptions } from "../api-types.js";
import type { DiscoveryStatus, MarketId } from "@tsx-scanner/contracts";
import { computeOperationalStatus } from "../foundation/operational-status.js";

/** Health, readiness, /api/system/status, /metrics, and the /ws snapshot broadcaster. These
 * endpoints don't belong to a single business vertical, so they stay grouped as "system" rather
 * than being forced into one of the domain route modules. */
export function registerSystemRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
  clock: () => Date,
): void {
  let connectedClients = 0;
  let broadcastsTotal = 0;
  let framesSuppressedTotal = 0;
  let lastBroadcastLatencyMs: number | null = null;

  app.get("/ws", { websocket: true }, (socket, request) => {
    const requestedMarket =
      new URL(request.url, "http://localhost").searchParams.get("marketId") ??
      "CA_TSX";
    const marketId =
      requestedMarket === "US_EQUITIES" ? "US_EQUITIES" : "CA_TSX";
    const marketService =
      options.marketDataServices?.[marketId] ??
      (marketId === "CA_TSX" ? options.marketDataService : undefined);
    connectedClients += 1;
    // One broadcaster per connection: a fresh connection (initial load or a
    // reconnect after a drop) always starts with no prior frame to compare
    // against, so its first `sendSnapshot()` call below is never suppressed —
    // the client always gets a full snapshot on connect/reconnect rather than
    // inheriting suppression or sequence state from a previous socket.
    const broadcaster = createSnapshotBroadcaster();
    const sendSnapshot = () => {
      if (socket.readyState !== 1) return;
      const started = performance.now();
      const result = broadcaster.next({
        type: "snapshot",
        timestamp: clock().toISOString(),
        market: marketService?.getSnapshot(),
        universe: marketService?.getUniverseAutomation?.(),
        candidates: marketService?.getCandidates?.() ?? [],
        contexts: marketService?.getContexts?.() ?? [],
        alerts: selectBroadcastAlerts(marketService?.getAlerts?.() ?? []),
      });
      if (result.suppressed) {
        framesSuppressedTotal += 1;
        return;
      }
      socket.send(result.json!);
      broadcastsTotal += 1;
      lastBroadcastLatencyMs =
        Math.round((performance.now() - started) * 100) / 100;
    };
    sendSnapshot();
    const timer = setInterval(sendSnapshot, 2_000);
    socket.on("close", () => {
      clearInterval(timer);
      connectedClients = Math.max(0, connectedClients - 1);
    });
  });

  app.get<{ Querystring: { marketId?: string } }>(
    "/metrics",
    async (request, reply) => {
      const requestedMarket = request.query.marketId;
      let marketId: MarketId | undefined;
      if (requestedMarket !== undefined) {
        if (requestedMarket !== "CA_TSX" && requestedMarket !== "US_EQUITIES")
          return reply.code(400).send({
            error: "marketId must be CA_TSX or US_EQUITIES",
          });
        marketId = requestedMarket;
      }
      const marketService = marketId
        ? (options.marketDataServices?.[marketId] ??
          (marketId === "CA_TSX" ? options.marketDataService : undefined))
        : options.marketDataService;
      if (marketId !== undefined && !marketService)
        return reply.code(404).send({
          error: `Market service is not configured: ${marketId}`,
        });
      const discoveryMarketId = marketId ?? "CA_TSX";
      const discoveryService =
        options.discoveryServices?.[discoveryMarketId] ??
        (discoveryMarketId === "CA_TSX" ? options.discoveryService : undefined);
      let discovery: DiscoveryStatus | null = null;
      if (discoveryService) {
        try {
          discovery = await discoveryService.status(discoveryMarketId);
        } catch {
          // Discovery telemetry must not make the shared monitoring endpoint
          // fail when its optional persistence dependency is unavailable.
          discovery = null;
        }
      }
      const observability = marketService?.getObservability?.();
      const marketSnapshot = marketService?.getSnapshot?.() as
        | {
            paperBot?: {
              unresolvedCoordinatedPositions: number;
              completedRunsWithUnresolvedCoordinatedPositions: number;
              oldestUnresolvedCoordinatedAgeMs: number | null;
              unknownQuoteSizeUnits: number;
              overdueRuns: number;
              lastSuccessfulProcessingAt?: string | null;
              fundedLastSuccessfulProcessingAt?: string | null;
              funded?: {
                closePendingOrders: number;
                oldestClosePendingAgeMs: number | null;
                riskVetoesTotal: number;
                coverageGapsTotal: number;
                recoveryFailuresTotal: number;
                lastCycleLatencyMs: number | null;
                pendingFacts?: number;
                oldestPendingFactAgeMs?: number | null;
                factsArrivedPerMinute?: number | null;
                factsDrainedPerMinute?: number | null;
                arrivalMinusDrainPerMinute?: number | null;
                reconstructionDurationMs?: number | null;
                reconstructionDurationMaxMs?: number | null;
                reconstructionReplayedEvents?: number | null;
                reconstructionPages?: number | null;
                reconstructionCheckpointAgeMs?: number | null;
                reconstructionLastObservedTimestampSeconds?: number | null;
                reconstructionCountTotal?: number;
                reconstructionFullReplaysTotal?: number;
                reconstructionBudgetFailuresTotal?: number;
              };
            };
            benchmarkReadiness?: {
              market: { status: string };
              sectors: Array<{ status: string }>;
            };
          }
        | undefined;
      const paperBot = marketSnapshot?.paperBot;
      const readiness = marketSnapshot?.benchmarkReadiness;
      const status = await options.statusService.getStatus();
      const automationStarted = performance.now();
      let backtestAutomation: ObservabilitySnapshot["backtestAutomation"] =
        null;
      if (options.backtestAutomationService) {
        try {
          const automationStatus =
            await options.backtestAutomationService.status(
              marketId ?? "CA_TSX",
            );
          const nowMs = Date.now();
          const last = automationStatus.lastCycle;
          backtestAutomation = {
            enabled: automationStatus.enabled,
            outstandingWork: automationStatus.outstandingWork,
            oldestOutstandingAgeMs: automationStatus.oldestOutstandingAt
              ? Math.max(
                  0,
                  nowMs - Date.parse(automationStatus.oldestOutstandingAt),
                )
              : null,
            oldestWaitingAgeMs: automationStatus.oldestWaitingAt
              ? Math.max(
                  0,
                  nowMs - Date.parse(automationStatus.oldestWaitingAt),
                )
              : null,
            failedWork: automationStatus.works.filter(
              (work) => work.state === "FAILED",
            ).length,
            retryScheduled: automationStatus.retryScheduled,
            stageFailed: automationStatus.stages.filter(
              (stage) => stage.state === "FAILED",
            ).length,
            lastCycleAgeMs: last?.finishedAt
              ? Math.max(0, nowMs - Date.parse(last.finishedAt))
              : null,
            lastCycleDurationMs: last?.finishedAt
              ? Date.parse(last.finishedAt) - Date.parse(last.startedAt)
              : null,
            lastCycleDispatched: last?.dispatched ?? 0,
            lastResultAgeMs: automationStatus.lastSuccessAt
              ? Math.max(0, nowMs - Date.parse(automationStatus.lastSuccessAt))
              : null,
            lastResultDurationMs: automationStatus.lastSuccessDurationMs,
            statusLatencyMs:
              Math.round((performance.now() - automationStarted) * 100) / 100,
          };
        } catch {
          // Automation telemetry must never make the shared monitoring endpoint
          // fail when its optional persistence dependency is unavailable.
          backtestAutomation = null;
        }
      }
      const marketOperational =
        marketId === undefined || !marketService?.getOperationalStatusInput
          ? status.operational
          : computeOperationalStatus({
              databaseReady: status.checks.database.status === "ok",
              scannerReady: status.checks.scanner.status === "ok",
              marketDataMode: status.mode,
              ...marketService.getOperationalStatusInput(),
            });
      const snapshot: ObservabilitySnapshot = {
        state: observability?.state ?? "UNKNOWN",
        auth: observability?.auth ?? "UNKNOWN",
        dataStatus: observability?.dataStatus ?? "UNKNOWN",
        instrumentCount: observability?.instrumentCount ?? 0,
        quoteAgeMs: observability?.quoteAgeMs ?? null,
        candleAgeMs: observability?.candleAgeMs ?? null,
        benchmarkAgeMs: observability?.benchmarkAgeMs ?? null,
        evaluationAgeMs: observability?.evaluationAgeMs ?? null,
        cycleLatencyMs: observability?.cycleLatencyMs ?? null,
        activeMonitoringCycleP95Ms:
          observability?.activeMonitoringCycleP95Ms ?? null,
        activeMonitoringCycleSampleCount:
          observability?.activeMonitoringCycleSampleCount ?? 0,
        engineLatencyMs: observability?.engineLatencyMs ?? null,
        featureLatencyMs: observability?.featureLatencyMs ?? null,
        evaluationLatencyMs: observability?.evaluationLatencyMs ?? null,
        missingBarsCount: observability?.missingBarsCount ?? 0,
        readySymbols: observability?.readySymbols ?? 0,
        warmingSymbols: observability?.warmingSymbols ?? 0,
        unavailableSymbols: observability?.unavailableSymbols ?? 0,
        alertsDeliveredTotal: observability?.alertsDeliveredTotal ?? 0,
        evaluationsWrittenTotal: observability?.evaluationsWrittenTotal ?? 0,
        // Sourced from the same shared contract as /api/system/status so the two surfaces — and
        // any alerting rule built on this endpoint — never disagree about actionability.
        operationalReady: marketOperational.operationalReady,
        actionable: marketOperational.actionable,
        reasonCodeCount: marketOperational.reasonCodes.length,
        universeConfigured: marketOperational.universe.configured,
        universeResolved: marketOperational.universe.resolved,
        universeEvaluated: marketOperational.universe.evaluated,
        discovery,
        requiredContextUnavailable:
          (readiness?.market && readiness.market.status !== "READY" ? 1 : 0) +
          (readiness?.sectors.filter((item) => item.status !== "READY")
            .length ?? 0),
        paperBot: paperBot
          ? {
              unresolvedCoordinatedPositions:
                paperBot.unresolvedCoordinatedPositions,
              completedRunsWithUnresolvedCoordinatedPositions:
                paperBot.completedRunsWithUnresolvedCoordinatedPositions,
              oldestUnresolvedCoordinatedAgeMs:
                paperBot.oldestUnresolvedCoordinatedAgeMs,
              unknownQuoteSizeUnits: paperBot.unknownQuoteSizeUnits,
              overdueRuns: paperBot.overdueRuns,
              lastSuccessfulProcessingAt: paperBot.lastSuccessfulProcessingAt,
              fundedLastSuccessfulProcessingAt:
                paperBot.fundedLastSuccessfulProcessingAt,
              ...(paperBot.funded ? { funded: paperBot.funded } : {}),
            }
          : null,
        broker: options.brokerMetrics?.requestCounts ?? null,
        websocket: {
          connectedClients,
          lastBroadcastLatencyMs,
          broadcastsTotal,
          framesSuppressedTotal,
        },
        persistence: options.persistenceMetrics?.snapshot() ?? null,
        retention: (await options.retentionService?.getLatestRun()) ?? null,
        backtestAutomation,
      };
      return reply
        .header("content-type", "text/plain; version=0.0.4")
        .send(renderPrometheusMetrics(snapshot, { marketId }));
    },
  );

  app.get("/health/live", async () => ({
    service: "api" as const,
    status: "ok" as const,
    version: API_VERSION,
    timestamp: clock().toISOString(),
  }));

  app.get("/health/ready", async (_request, reply) => {
    const status = await options.statusService.getStatus();
    return reply.code(status.status === "ok" ? 200 : 503).send(status);
  });

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/system/status",
    async (request, reply) => {
      const status = await options.statusService.getStatus();
      const requestedMarket = request.query.marketId;
      if (requestedMarket === undefined) return status;
      if (requestedMarket !== "CA_TSX" && requestedMarket !== "US_EQUITIES")
        return reply.code(400).send({
          error: "marketId must be CA_TSX or US_EQUITIES",
        });
      const marketService =
        options.marketDataServices?.[requestedMarket] ??
        (requestedMarket === "CA_TSX" ? options.marketDataService : undefined);
      if (!marketService?.getOperationalStatusInput)
        return reply.code(409).send({
          error: `${requestedMarket} is not active in this runtime`,
          marketId: requestedMarket,
        });
      // Same computation as /metrics: the status service's own operational
      // block is bound to the default (Canadian) runtime, so a market-scoped
      // read must be recomputed from that market's inputs rather than reusing
      // the CA session, universe, gating and freshness by accident.
      const operational = computeOperationalStatus({
        databaseReady: status.checks.database.status === "ok",
        scannerReady: status.checks.scanner.status === "ok",
        marketDataMode: status.mode,
        ...marketService.getOperationalStatusInput(),
      });
      return { ...status, operational };
    },
  );

  // W2: retention is shipped operator-opt-in, not auto-scheduled (see the "opt-in scheduling"
  // note in database/init/028-retention-correction.sql) -- these two endpoints are how an
  // operator triggers and observes a run without a database console. GET reflects the same
  // data exposed under /metrics as scanner_retention_* gauges.
  app.get("/api/system/retention", async (_request, reply) => {
    if (!options.retentionService)
      return reply
        .code(501)
        .send({ error: "Retention service not configured." });
    return options.retentionService.getLatestRun();
  });

  app.post("/api/system/retention/run", async (_request, reply) => {
    if (!options.retentionService)
      return reply
        .code(501)
        .send({ error: "Retention service not configured." });
    const run = await options.retentionService.runNow();
    return reply.code(run.status === "FAILED" ? 207 : 200).send(run);
  });
}
