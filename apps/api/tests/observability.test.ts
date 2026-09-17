import { describe, expect, it } from "vitest";
import { discoveryPolicyForMarket } from "@tsx-scanner/contracts";
import {
  renderPrometheusMetrics,
  type ObservabilitySnapshot,
} from "../src/observability/metrics.js";

const baseSnapshot: ObservabilitySnapshot = {
  state: "ACTIVE",
  auth: "CONNECTED",
  dataStatus: "REALTIME",
  instrumentCount: 3,
  quoteAgeMs: 1200,
  candleAgeMs: 4000,
  benchmarkAgeMs: 8000,
  evaluationAgeMs: 500,
  cycleLatencyMs: 42.5,
  engineLatencyMs: 30,
  featureLatencyMs: 10,
  evaluationLatencyMs: 15,
  missingBarsCount: 2,
  readySymbols: 1,
  warmingSymbols: 2,
  unavailableSymbols: 0,
  alertsDeliveredTotal: 5,
  evaluationsWrittenTotal: 12,
  operationalReady: true,
  actionable: true,
  reasonCodeCount: 0,
  universeConfigured: 3,
  universeResolved: 3,
  universeEvaluated: 3,
  requiredContextUnavailable: 0,
  paperBot: {
    unresolvedCoordinatedPositions: 1,
    completedRunsWithUnresolvedCoordinatedPositions: 0,
    oldestUnresolvedCoordinatedAgeMs: 3_600_000,
    unknownQuoteSizeUnits: 0,
    overdueRuns: 1,
    funded: {
      closePendingOrders: 2,
      oldestClosePendingAgeMs: 900_000,
      riskVetoesTotal: 3,
      coverageGapsTotal: 4,
      recoveryFailuresTotal: 5,
      lastCycleLatencyMs: 18,
      pendingFacts: 120,
      oldestPendingFactAgeMs: 45_000,
      factsArrivedPerMinute: 650.4,
      factsDrainedPerMinute: 220.2,
      arrivalMinusDrainPerMinute: 430.2,
      reconstructionDurationMs: 812.5,
      reconstructionDurationMaxMs: 900,
      reconstructionReplayedEvents: 42,
      reconstructionPages: 1,
      reconstructionCheckpointAgeMs: 660_000,
      reconstructionLastObservedTimestampSeconds: 4_092_681_600,
      reconstructionCountTotal: 7,
      reconstructionFullReplaysTotal: 1,
      reconstructionBudgetFailuresTotal: 0,
    },
  },
  broker: { completed: 100, failed: 1, queued: 0, active: 1 },
  websocket: {
    connectedClients: 2,
    lastBroadcastLatencyMs: 3,
    broadcastsTotal: 40,
    framesSuppressedTotal: 7,
  },
  persistence: {
    quote_snapshot: {
      rowsWrittenTotal: 200,
      conflictsTotal: 5,
      writesTotal: 3,
      lastLatencyMs: 12.5,
      p95LatencyMs: 18,
    },
  },
  retention: null,
};

describe("Phase 9 Prometheus metrics rendering", () => {
  it("exposes discovery starvation, cancellations, quota and unknown allowance distinctly", () => {
    const text = renderPrometheusMetrics({
      ...baseSnapshot,
      broker: {
        ...baseSnapshot.broker!,
        discoveryQueued: 50,
        oldestQueueAgeMs: 90_000,
        cancelled: 4,
        expired: 3,
        throttled: 2,
        discoveryCompleted: 12,
        discoveryFailed: 3,
        discoveryCancelled: 4,
        discoveryExpired: 5,
        remainingHour: 6000,
        remainingDiscoveryHour: 0,
      },
    });
    expect(text).toContain("scanner_broker_discovery_queued 50");
    expect(text).toContain("scanner_broker_oldest_queue_age_ms 90000");
    expect(text).toContain("scanner_broker_requests_cancelled_total 4");
    expect(text).toContain("scanner_broker_requests_expired_total 3");
    expect(text).toContain("scanner_broker_requests_throttled_total 2");
    expect(text).toContain(
      "scanner_broker_discovery_requests_completed_total 12",
    );
    expect(text).toContain("scanner_broker_discovery_requests_failed_total 3");
    expect(text).toContain(
      "scanner_broker_discovery_requests_cancelled_total 4",
    );
    expect(text).toContain("scanner_broker_discovery_requests_expired_total 5");
    expect(text).toContain("scanner_broker_discovery_remaining_hour 0");
    expect(renderPrometheusMetrics(baseSnapshot)).not.toMatch(
      /^scanner_broker_remaining_hour /m,
    );
  });
  it("renders market-scoped discovery state, coverage, timing, and request usage", () => {
    const text = renderPrometheusMetrics(
      {
        ...baseSnapshot,
        discovery: {
          marketId: "CA_TSX",
          mode: "SHADOW",
          revision: 3,
          modeUpdatedAt: "2026-09-09T13:00:00.000Z",
          modeActor: "test",
          scheduler: "IDLE",
          policy: discoveryPolicyForMarket("CA_TSX"),
          catalog: {
            status: "FRESH",
            source: "EODHD",
            tradingDate: "2026-09-09",
            fetchedAt: "2026-09-09T14:00:00.000Z",
            ageMs: 1_000,
            rowCount: 100,
            admittedCount: 80,
            failure: null,
          },
          lastRun: {
            id: "00000000-0000-4000-8000-000000000003",
            marketId: "CA_TSX",
            tradingDate: "2026-09-09",
            policyVersion: "ca-discovery-v1",
            mode: "SHADOW",
            evaluationAt: "2026-09-09T14:00:00.000Z",
            completedBarEnd: "2026-09-09T13:55:00.000Z",
            catalogDigest: "b".repeat(64),
            status: "PARTIAL",
            coverage: {
              total: 100,
              pass: 60,
              fail: 20,
              unevaluable: 10,
              deferred: 10,
            },
            startedAt: "2026-09-09T14:00:00.000Z",
            completedAt: "2026-09-09T14:01:00.000Z",
            failure: null,
          },
          nextEvaluationAt: null,
          activeRunId: null,
          queueDepth: 4,
          oldestQueueAgeMs: 5_000,
          lastError: null,
          budget: {
            remainingHour: 10_000,
            remainingDiscoveryHour: 1_500,
            queued: 4,
            active: 1,
          },
          performance: {
            sampleCount: 2,
            lastCycleDurationMs: 50_000,
            lastQueueLatencyMs: 20_000,
            cycleP95Ms: 55_000,
            queueP95Ms: 25_000,
            requestUsage: {
              completed: 80,
              failed: 2,
              cancelled: 1,
              expired: 3,
            },
          },
        },
      },
      { marketId: "CA_TSX" },
    );
    expect(text).toContain('scanner_discovery_mode{market_id="CA_TSX"} 1');
    expect(text).toContain(
      'scanner_discovery_catalog_rows{market_id="CA_TSX"} 100',
    );
    expect(text).toContain(
      'scanner_discovery_queue_p95_ms{market_id="CA_TSX"} 25000',
    );
    expect(text).toContain(
      'scanner_discovery_last_run_deferred_fraction{market_id="CA_TSX"} 0.1',
    );
    expect(text).toContain(
      'scanner_discovery_last_run_requests_completed{market_id="CA_TSX"} 80',
    );
  });
  it("renders the active-monitoring cycle p95 separately from discovery p95", () => {
    const text = renderPrometheusMetrics({
      ...baseSnapshot,
      activeMonitoringCycleP95Ms: 47.25,
      activeMonitoringCycleSampleCount: 12,
    });

    expect(text).toContain("scanner_active_monitoring_cycle_p95_ms 47.25");
    expect(text).toContain("scanner_active_monitoring_cycle_sample_count 12");
    expect(text).not.toContain(
      "scanner_active_monitoring_cycle_p95_ms{market_id",
    );
  });
  it("renders every gauge and counter in Prometheus text exposition format", () => {
    const text = renderPrometheusMetrics(baseSnapshot);
    expect(text).toContain("scanner_market_data_state 1");
    expect(text).toContain("scanner_quote_age_ms 1200");
    expect(text).toContain("scanner_candle_age_ms 4000");
    expect(text).toContain("scanner_benchmark_age_ms 8000");
    expect(text).toContain("scanner_cycle_latency_ms 42.5");
    expect(text).toContain("scanner_missing_bars_count 2");
    expect(text).toContain("scanner_alerts_delivered_total 5");
    expect(text).toContain("scanner_broker_requests_completed_total 100");
    expect(text).toContain("scanner_websocket_connected_clients 2");
    expect(text).toContain("scanner_websocket_frames_suppressed_total 7");
    expect(text).toContain(
      "scanner_paper_bot_unresolved_coordinated_positions 1",
    );
    expect(text).toContain("scanner_paper_bot_funded_close_pending_orders 2");
    expect(text).toContain(
      "scanner_paper_bot_funded_oldest_close_pending_age_ms 900000",
    );
    expect(text).toContain("scanner_paper_bot_funded_risk_vetoes_total 3");
    expect(text).toContain("scanner_paper_bot_funded_coverage_gaps_total 4");
    expect(text).toContain(
      "scanner_paper_bot_funded_recovery_failures_total 5",
    );
    expect(text).toContain(
      "scanner_paper_bot_funded_arrival_minus_drain_per_minute 430.2",
    );
    expect(text).toContain(
      "scanner_paper_bot_funded_facts_arrived_per_minute 650.4",
    );
    expect(text).toContain(
      "scanner_paper_bot_funded_reconstruction_duration_ms 812.5",
    );
    expect(text).toContain(
      "scanner_paper_bot_funded_reconstruction_checkpoint_age_ms 660000",
    );
    expect(text).toContain(
      "scanner_paper_bot_funded_reconstruction_last_observed_timestamp_seconds 4092681600",
    );
    expect(text).toContain(
      "scanner_paper_bot_funded_reconstruction_budget_failures_total 0",
    );
    expect(text).toMatch(
      /# TYPE scanner_paper_bot_funded_reconstruction_budget_failures_total counter/,
    );
    expect(text).toContain("scanner_required_context_unavailable 0");
    expect(text).toMatch(/# TYPE scanner_alerts_delivered_total counter/);
    expect(text).toMatch(/# TYPE scanner_quote_age_ms gauge/);
  });

  it("adds a market label for an explicitly selected market scrape", () => {
    const text = renderPrometheusMetrics(baseSnapshot, {
      marketId: "US_EQUITIES",
    });

    expect(text).toContain(
      'scanner_market_data_state{market_id="US_EQUITIES"} 1',
    );
    expect(text).toContain(
      "# HELP scanner_market_data_state Market-data service state",
    );
    expect(text).not.toContain("scanner_market_data_state 1");
    expect(text).toContain(
      'scanner_paper_bot_funded_risk_vetoes_total{market_id="US_EQUITIES"} 3',
    );
    // Persistence and broker counters are process-wide, so they are not duplicated
    // under a market label when a per-market scrape is requested.
    expect(text).toContain(
      'scanner_persistence_rows_written_total{entity="quote_snapshot"} 200',
    );
    expect(text).toContain("scanner_broker_requests_completed_total 100");
  });

  it("omits null fields instead of emitting invalid metric lines", () => {
    const text = renderPrometheusMetrics({
      ...baseSnapshot,
      benchmarkAgeMs: null,
      broker: null,
    });
    expect(text).not.toContain("scanner_benchmark_age_ms");
    expect(text).not.toContain("scanner_broker_requests");
  });

  it("maps every service state to a distinct numeric gauge value", () => {
    const states: ObservabilitySnapshot["state"][] = [
      "STARTING",
      "ACTIVE",
      "MARKET_CLOSED",
      "DATA_DELAYED",
      "DEGRADED",
      "AUTH_REQUIRED",
      "STOPPED",
    ];
    const values = states.map((state) => {
      const text = renderPrometheusMetrics({ ...baseSnapshot, state });
      return Number(text.match(/scanner_market_data_state (-?\d+)/)?.[1]);
    });
    expect(new Set(values).size).toBe(states.length);
  });

  it("renders the evaluation-write and empty-universe metrics so a green scanner writing nothing is distinguishable", () => {
    const healthyText = renderPrometheusMetrics(baseSnapshot);
    expect(healthyText).toContain("scanner_evaluations_written_total 12");
    expect(healthyText).toContain("scanner_universe_empty 0");
    expect(healthyText).toContain("scanner_actionable 1");

    const emptyUniverseText = renderPrometheusMetrics({
      ...baseSnapshot,
      evaluationsWrittenTotal: 0,
      universeResolved: 0,
      universeEvaluated: 0,
      actionable: false,
      reasonCodeCount: 1,
    });
    expect(emptyUniverseText).toContain("scanner_evaluations_written_total 0");
    expect(emptyUniverseText).toContain("scanner_universe_empty 1");
    expect(emptyUniverseText).toContain("scanner_actionable 0");
    expect(emptyUniverseText).toContain(
      "scanner_operational_reason_code_count 1",
    );
  });

  it("renders per-entity persistence metrics with an entity label", () => {
    const text = renderPrometheusMetrics(baseSnapshot);
    expect(text).toContain(
      'scanner_persistence_rows_written_total{entity="quote_snapshot"} 200',
    );
    expect(text).toContain(
      'scanner_persistence_conflicts_total{entity="quote_snapshot"} 5',
    );
    expect(text).toContain(
      'scanner_persistence_writes_total{entity="quote_snapshot"} 3',
    );
    expect(text).toContain(
      'scanner_persistence_last_latency_ms{entity="quote_snapshot"} 12.5',
    );
    expect(text).toContain(
      'scanner_persistence_p95_latency_ms{entity="quote_snapshot"} 18',
    );
  });

  it("omits persistence metrics entirely when no recorder is wired", () => {
    const text = renderPrometheusMetrics({
      ...baseSnapshot,
      persistence: null,
    });
    expect(text).not.toContain("scanner_persistence_");
  });

  it("omits retention metrics entirely when no retention run has ever happened", () => {
    const text = renderPrometheusMetrics(baseSnapshot);
    expect(text).not.toContain("scanner_retention_");
  });

  it("renders retention run status, timing, and per-table row counts", () => {
    const text = renderPrometheusMetrics({
      ...baseSnapshot,
      retention: {
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-28T04:00:00.000Z",
        finishedAt: "2026-08-28T04:00:05.000Z",
        status: "SUCCEEDED",
        tableResults: [
          { table: "quote_snapshot", rowsDeleted: 1200, error: null },
          { table: "candle", rowsDeleted: 300, error: null },
        ],
        error: null,
      },
    });
    expect(text).toContain("scanner_retention_last_run_status 1");
    expect(text).toContain("scanner_retention_last_run_failed_tables 0");
    expect(text).toContain(
      'scanner_retention_last_run_rows_deleted{table_name="quote_snapshot"} 1200',
    );
    expect(text).toContain(
      'scanner_retention_last_run_rows_deleted{table_name="candle"} 300',
    );
    expect(text).toContain(
      "scanner_retention_last_run_started_timestamp_seconds",
    );
    expect(text).toContain(
      "scanner_retention_last_run_finished_timestamp_seconds",
    );
  });

  it("reports a failed retention run distinctly from a successful one", () => {
    const text = renderPrometheusMetrics({
      ...baseSnapshot,
      retention: {
        id: "22222222-2222-4222-8222-222222222222",
        startedAt: "2026-08-28T04:00:00.000Z",
        finishedAt: "2026-08-28T04:00:05.000Z",
        status: "FAILED",
        tableResults: [
          { table: "quote_snapshot", rowsDeleted: 1200, error: null },
          { table: "candle", rowsDeleted: 0, error: "deadlock detected" },
        ],
        error: "candle: deadlock detected",
      },
    });
    expect(text).toContain("scanner_retention_last_run_status 2");
    expect(text).toContain("scanner_retention_last_run_failed_tables 1");
  });
});
