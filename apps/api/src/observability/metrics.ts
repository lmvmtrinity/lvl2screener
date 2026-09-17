import type { PersistenceMetricsSnapshot } from "./persistence-metrics.js";
import type { RetentionRunSummary } from "./retention-repository.js";
import type { DiscoveryStatus, MarketId } from "@tsx-scanner/contracts";

/**
 * Phase 9 observability. A dependency-free Prometheus text-exposition renderer:
 * no client library, no scrape-interval assumptions, just a snapshot -> text mapping
 * so `/metrics` can be scraped by any standard collector.
 */
export interface ObservabilitySnapshot {
  state: string;
  auth: string;
  dataStatus: string;
  instrumentCount: number;
  quoteAgeMs: number | null;
  candleAgeMs: number | null;
  benchmarkAgeMs: number | null;
  evaluationAgeMs: number | null;
  cycleLatencyMs: number | null;
  activeMonitoringCycleP95Ms?: number | null;
  activeMonitoringCycleSampleCount?: number;
  engineLatencyMs: number | null;
  featureLatencyMs: number | null;
  evaluationLatencyMs: number | null;
  missingBarsCount: number;
  readySymbols: number;
  warmingSymbols: number;
  unavailableSymbols: number;
  alertsDeliveredTotal: number;
  /** Cumulative `strategy_evaluation` rows persisted since process start. Distinct from
   *  `readySymbols`/instantaneous counts: a scanner reporting all-green health with this stuck at
   *  0 is silently not writing anything, which is exactly the defect W1/W6 exist to surface. */
  evaluationsWrittenTotal: number;
  /** The shared actionability contract (see `foundation/operational-status.ts`), so this and
   *  `/api/system/status` never disagree about whether the system is actionable. */
  operationalReady: boolean;
  actionable: boolean;
  reasonCodeCount: number;
  universeConfigured: number;
  universeResolved: number;
  universeEvaluated: number;
  requiredContextUnavailable?: number;
  /** Market-scoped discovery status, when the API has the discovery service wired. */
  discovery?: DiscoveryStatus | null;
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
      /** Trailing five-minute averages over the account's durable facts. */
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
  } | null;
  broker: {
    completed: number;
    failed: number;
    queued: number;
    active: number;
    cancelled?: number;
    expired?: number;
    throttled?: number;
    discoveryQueued?: number;
    discoveryCompleted?: number;
    discoveryFailed?: number;
    discoveryCancelled?: number;
    discoveryExpired?: number;
    oldestQueueAgeMs?: number;
    remainingHour?: number | null;
    remainingDiscoveryHour?: number | null;
  } | null;
  websocket: {
    connectedClients: number;
    lastBroadcastLatencyMs: number | null;
    broadcastsTotal: number;
    /** Cycles where the outgoing frame was byte-identical to the last one sent to that
     *  client and was withheld instead of re-sent (W6b change detection). A healthy,
     *  quiet market should keep this climbing roughly in step with `broadcastsTotal`
     *  staying flat — the two together are how an operator confirms suppression is
     *  actually firing, not just deployed. */
    framesSuppressedTotal: number;
  };
  /** W7 set-based bulk-write metrics, keyed by entity (quote_snapshot, candle, feature_snapshot,
   *  strategy_signal, strategy_evaluation, strategy_state_event, context_evaluation, instrument).
   *  `null` when no persistence metrics recorder is wired (e.g. in tests). */
  persistence: PersistenceMetricsSnapshot | null;
  /** W2: the most recent `prune_retention_history()` run (see
   *  database/init/028-retention-correction.sql and observability/retention-repository.ts).
   *  `null` when no retention service is wired, or when one is wired but no run has ever
   *  happened on this database (e.g. retention scheduling has not been opted into yet). */
  retention: RetentionRunSummary | null;
  /** A4 backtest-automation gauges. Null when the API has no automation service wired
   *  or its status read is temporarily unavailable. */
  backtestAutomation?: BacktestAutomationMetrics | null;
}

export interface BacktestAutomationMetrics {
  enabled: boolean;
  outstandingWork: number;
  oldestOutstandingAgeMs: number | null;
  /** Age of the oldest work waiting on capacity or a bounded retry backoff. */
  oldestWaitingAgeMs: number | null;
  failedWork: number;
  retryScheduled: number;
  stageFailed: number;
  lastCycleAgeMs: number | null;
  lastCycleDurationMs: number | null;
  lastCycleDispatched: number;
  /** Time since the most recent successful baseline completion. */
  lastResultAgeMs: number | null;
  /** Runtime of that successful completion. */
  lastResultDurationMs: number | null;
  /** Wall-clock cost of the status read backing this snapshot. */
  statusLatencyMs: number;
}

const STATE_VALUE: Record<string, number> = {
  STARTING: 0,
  ACTIVE: 1,
  MARKET_CLOSED: 2,
  DATA_DELAYED: 3,
  DEGRADED: 4,
  AUTH_REQUIRED: 5,
  STOPPED: 6,
};

export function renderPrometheusMetrics(
  snapshot: ObservabilitySnapshot,
  options: { readonly marketId?: MarketId } = {},
): string {
  const lines: string[] = [];
  const marketMetric = (name: string): string =>
    options.marketId ? `${name}{market_id="${options.marketId}"}` : name;
  const metricBaseName = (name: string): string =>
    name.slice(0, name.indexOf("{") === -1 ? name.length : name.indexOf("{"));
  const gauge = (
    name: string,
    help: string,
    value: number | null | undefined,
  ): void => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    const baseName = metricBaseName(name);
    lines.push(
      `# HELP ${baseName} ${help}`,
      `# TYPE ${baseName} gauge`,
      `${name} ${value}`,
    );
  };
  const counter = (
    name: string,
    help: string,
    value: number | null | undefined,
  ): void => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    const baseName = metricBaseName(name);
    lines.push(
      `# HELP ${baseName} ${help}`,
      `# TYPE ${baseName} counter`,
      `${name} ${value}`,
    );
  };

  gauge(
    marketMetric("scanner_market_data_state"),
    "Market-data service state (0=STARTING 1=ACTIVE 2=MARKET_CLOSED 3=DATA_DELAYED 4=DEGRADED 5=AUTH_REQUIRED 6=STOPPED).",
    STATE_VALUE[snapshot.state] ?? -1,
  );
  gauge(
    marketMetric("scanner_auth_connected"),
    "1 when the broker session is authenticated, 0 when auth is required.",
    snapshot.auth === "CONNECTED" ? 1 : 0,
  );
  gauge(
    marketMetric("scanner_instrument_count"),
    "Number of instruments currently tracked.",
    snapshot.instrumentCount,
  );
  gauge(
    marketMetric("scanner_quote_age_ms"),
    "Milliseconds since the most recent quote was received.",
    snapshot.quoteAgeMs,
  );
  gauge(
    marketMetric("scanner_candle_age_ms"),
    "Milliseconds since the most recent candle was received.",
    snapshot.candleAgeMs,
  );
  gauge(
    marketMetric("scanner_benchmark_age_ms"),
    "Milliseconds since the most recent benchmark observation.",
    snapshot.benchmarkAgeMs,
  );
  gauge(
    marketMetric("scanner_evaluation_age_ms"),
    "Milliseconds since the most recent strategy evaluation.",
    snapshot.evaluationAgeMs,
  );
  gauge(
    marketMetric("scanner_cycle_latency_ms"),
    "Duration of the most recently completed scan cycle.",
    snapshot.cycleLatencyMs,
  );
  gauge(
    marketMetric("scanner_active_monitoring_cycle_p95_ms"),
    "p95 duration of recent active-monitoring scan cycles over a bounded in-process sample.",
    snapshot.activeMonitoringCycleP95Ms,
  );
  gauge(
    marketMetric("scanner_active_monitoring_cycle_sample_count"),
    "Number of active-monitoring scan cycles retained by the current process for p95 diagnostics.",
    snapshot.activeMonitoringCycleSampleCount,
  );
  gauge(
    marketMetric("scanner_engine_latency_ms"),
    "Duration of the most recent feature-engine round trip.",
    snapshot.engineLatencyMs,
  );
  gauge(
    marketMetric("scanner_feature_latency_ms"),
    "Duration of the most recent feature computation reported by the engine.",
    snapshot.featureLatencyMs,
  );
  gauge(
    marketMetric("scanner_evaluation_latency_ms"),
    "Duration of the most recent strategy evaluation reported by the engine.",
    snapshot.evaluationLatencyMs,
  );
  gauge(
    marketMetric("scanner_missing_bars_count"),
    "Number of instruments still warming up missing bar series.",
    snapshot.missingBarsCount,
  );
  gauge(
    marketMetric("scanner_ready_symbols"),
    "Number of symbols with realtime, warmed-up data.",
    snapshot.readySymbols,
  );
  gauge(
    marketMetric("scanner_warming_symbols"),
    "Number of symbols still warming up.",
    snapshot.warmingSymbols,
  );
  gauge(
    marketMetric("scanner_unavailable_symbols"),
    "Number of symbols with halted, delayed, or unknown data.",
    snapshot.unavailableSymbols,
  );
  counter(
    marketMetric("scanner_alerts_delivered_total"),
    "Total alerts delivered since process start.",
    snapshot.alertsDeliveredTotal,
  );
  counter(
    marketMetric("scanner_evaluations_written_total"),
    "Total strategy_evaluation rows persisted since process start. Green health with this stuck at 0 means nothing is actually being evaluated.",
    snapshot.evaluationsWrittenTotal,
  );
  gauge(
    marketMetric("scanner_operational_ready"),
    "1 when operational dependencies (auth, benchmarks, engine sync) are healthy, independent of market hours or actionability.",
    snapshot.operationalReady ? 1 : 0,
  );
  gauge(
    marketMetric("scanner_actionable"),
    "1 when the shared operational-status contract reports the system actionable for trading; 0 whenever any non-actionable reason code is present.",
    snapshot.actionable ? 1 : 0,
  );
  gauge(
    marketMetric("scanner_operational_reason_code_count"),
    "Number of active non-actionable reason codes reported by /api/system/status.",
    snapshot.reasonCodeCount,
  );
  gauge(
    marketMetric("scanner_universe_configured"),
    "Symbols configured for the universe (watchlist / provider config).",
    snapshot.universeConfigured,
  );
  gauge(
    marketMetric("scanner_universe_resolved"),
    "Symbols the universe provider resolved to tradeable instruments.",
    snapshot.universeResolved,
  );
  gauge(
    marketMetric("scanner_universe_evaluated"),
    "Symbols with a current feature/strategy evaluation.",
    snapshot.universeEvaluated,
  );
  gauge(
    marketMetric("scanner_universe_empty"),
    "1 when the resolved universe is empty (configured symbols failed to resolve to any instrument).",
    snapshot.universeResolved === 0 ? 1 : 0,
  );
  gauge(
    marketMetric("scanner_required_context_unavailable"),
    "Required market or sector context readings that are unavailable or stale.",
    snapshot.requiredContextUnavailable ?? 0,
  );
  if (snapshot.paperBot) {
    gauge(
      marketMetric("scanner_paper_bot_unresolved_coordinated_positions"),
      "Open or close-pending positions in the coordinated shadow portfolio.",
      snapshot.paperBot.unresolvedCoordinatedPositions,
    );
    gauge(
      marketMetric(
        "scanner_paper_bot_completed_runs_with_unresolved_positions",
      ),
      "Completed runs that still own an unresolved coordinated position; target is always zero.",
      snapshot.paperBot.completedRunsWithUnresolvedCoordinatedPositions,
    );
    gauge(
      marketMetric("scanner_paper_bot_oldest_unresolved_position_age_ms"),
      "Age in milliseconds of the oldest unresolved coordinated position.",
      snapshot.paperBot.oldestUnresolvedCoordinatedAgeMs,
    );
    gauge(
      marketMetric("scanner_paper_bot_unknown_quote_size_units"),
      "Latest instrument quotes whose displayed-size unit is unknown; target is zero.",
      snapshot.paperBot.unknownQuoteSizeUnits,
    );
    gauge(
      marketMetric("scanner_paper_bot_overdue_runs"),
      "Earlier live paper-bot runs that remain unresolved past session close.",
      snapshot.paperBot.overdueRuns,
    );
    if (snapshot.paperBot.funded) {
      gauge(
        marketMetric("scanner_paper_bot_funded_pending_facts"),
        "Unacknowledged funded facts across the account's current and recovery runs.",
        snapshot.paperBot.funded.pendingFacts ?? 0,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_oldest_pending_fact_age_ms"),
        "Age of the oldest unacknowledged funded fact.",
        snapshot.paperBot.funded.oldestPendingFactAgeMs ?? null,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_facts_arrived_per_minute"),
        "Five-minute average of durable funded facts arriving per minute.",
        snapshot.paperBot.funded.factsArrivedPerMinute ?? null,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_facts_drained_per_minute"),
        "Five-minute average of durable funded facts acknowledged per minute.",
        snapshot.paperBot.funded.factsDrainedPerMinute ?? null,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_arrival_minus_drain_per_minute"),
        "Sustained capacity deficit: arrivals per minute minus acknowledgements per minute; a positive value grows the backlog.",
        snapshot.paperBot.funded.arrivalMinusDrainPerMinute ?? null,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_close_pending_orders"),
        "Funded orders waiting for an actionable close fill across the selected account's current and recovery runs.",
        snapshot.paperBot.funded.closePendingOrders,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_oldest_close_pending_age_ms"),
        "Age in milliseconds of the oldest funded CLOSE_PENDING order across the selected account's current and recovery runs.",
        snapshot.paperBot.funded.oldestClosePendingAgeMs,
      );
      counter(
        marketMetric("scanner_paper_bot_funded_risk_vetoes_total"),
        "Funded reservation or fill risk vetoes recorded by the durable fact inbox.",
        snapshot.paperBot.funded.riskVetoesTotal,
      );
      counter(
        marketMetric("scanner_paper_bot_funded_coverage_gaps_total"),
        "Funded input coverage gaps: skipped observations/quotes and late facts.",
        snapshot.paperBot.funded.coverageGapsTotal,
      );
      counter(
        marketMetric("scanner_paper_bot_funded_recovery_failures_total"),
        "Funded live-cycle recovery failures since process start.",
        snapshot.paperBot.funded.recoveryFailuresTotal,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_last_cycle_latency_ms"),
        "Duration of the most recent successful funded live cycle.",
        snapshot.paperBot.funded.lastCycleLatencyMs,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_reconstruction_duration_ms"),
        "Wall duration of the last bounded ledger reconstruction.",
        snapshot.paperBot.funded.reconstructionDurationMs ?? null,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_reconstruction_duration_max_ms"),
        "Slowest bounded ledger reconstruction since process start.",
        snapshot.paperBot.funded.reconstructionDurationMaxMs ?? null,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_reconstruction_replayed_events"),
        "Events replayed by the last bounded ledger reconstruction.",
        snapshot.paperBot.funded.reconstructionReplayedEvents ?? null,
      );
      gauge(
        marketMetric("scanner_paper_bot_funded_reconstruction_pages"),
        "Event pages fetched by the last bounded ledger reconstruction.",
        snapshot.paperBot.funded.reconstructionPages ?? null,
      );
      gauge(
        marketMetric(
          "scanner_paper_bot_funded_reconstruction_checkpoint_age_ms",
        ),
        "Replayed window span of the last checkpointed reconstruction; omitted after a full replay.",
        snapshot.paperBot.funded.reconstructionCheckpointAgeMs ?? null,
      );
      gauge(
        marketMetric(
          "scanner_paper_bot_funded_reconstruction_last_observed_timestamp_seconds",
        ),
        "Wall-clock time of the most recent bounded ledger reconstruction.",
        snapshot.paperBot.funded.reconstructionLastObservedTimestampSeconds ??
          null,
      );
      counter(
        marketMetric("scanner_paper_bot_funded_reconstruction_count_total"),
        "Bounded ledger reconstructions since process start.",
        snapshot.paperBot.funded.reconstructionCountTotal ?? 0,
      );
      counter(
        marketMetric(
          "scanner_paper_bot_funded_reconstruction_full_replays_total",
        ),
        "Reconstructions that replayed from account creation because no usable checkpoint existed.",
        snapshot.paperBot.funded.reconstructionFullReplaysTotal ?? 0,
      );
      counter(
        marketMetric(
          "scanner_paper_bot_funded_reconstruction_budget_failures_total",
        ),
        "Reconstructions that failed closed on the event budget; target zero.",
        snapshot.paperBot.funded.reconstructionBudgetFailuresTotal ?? 0,
      );
    }
  }
  if (snapshot.paperBot) {
    gauge(
      marketMetric("scanner_paper_bot_last_success_timestamp_seconds"),
      "Wall-clock completion time of the last independent paper cycle.",
      snapshot.paperBot.lastSuccessfulProcessingAt
        ? Date.parse(snapshot.paperBot.lastSuccessfulProcessingAt) / 1000
        : null,
    );
    gauge(
      marketMetric("scanner_paper_bot_funded_last_success_timestamp_seconds"),
      "Wall-clock completion time of the last successful bounded funded batch, not proof of an empty backlog.",
      snapshot.paperBot.fundedLastSuccessfulProcessingAt
        ? Date.parse(snapshot.paperBot.fundedLastSuccessfulProcessingAt) / 1000
        : null,
    );
  }
  if (snapshot.broker) {
    counter(
      "scanner_broker_requests_cancelled_total",
      "Obsolete queued broker requests cancelled.",
      snapshot.broker.cancelled ?? 0,
    );
    counter(
      "scanner_broker_requests_expired_total",
      "Broker requests expired before dispatch.",
      snapshot.broker.expired ?? 0,
    );
    counter(
      "scanner_broker_requests_throttled_total",
      "Observed broker HTTP 429 responses.",
      snapshot.broker.throttled ?? 0,
    );
    gauge(
      "scanner_broker_discovery_queued",
      "Queued discovery broker requests.",
      snapshot.broker.discoveryQueued ?? 0,
    );
    gauge(
      "scanner_broker_oldest_queue_age_ms",
      "Age of oldest queued request; rising age indicates starvation.",
      snapshot.broker.oldestQueueAgeMs ?? 0,
    );
    gauge(
      "scanner_broker_remaining_hour",
      "Remaining shared hourly allowance at last grant check; omitted when unknown.",
      snapshot.broker.remainingHour ?? null,
    );
    gauge(
      "scanner_broker_discovery_remaining_hour",
      "Remaining discovery allowance including monitoring headroom at last grant check; omitted when unknown.",
      snapshot.broker.remainingDiscoveryHour ?? null,
    );
    counter(
      "scanner_broker_requests_completed_total",
      "Total broker requests completed since process start.",
      snapshot.broker.completed,
    );
    counter(
      "scanner_broker_requests_failed_total",
      "Total broker requests failed since process start.",
      snapshot.broker.failed,
    );
    if (snapshot.broker.discoveryCompleted !== undefined)
      counter(
        "scanner_broker_discovery_requests_completed_total",
        "Discovery broker requests completed since process start.",
        snapshot.broker.discoveryCompleted,
      );
    if (snapshot.broker.discoveryFailed !== undefined)
      counter(
        "scanner_broker_discovery_requests_failed_total",
        "Discovery broker requests failed since process start.",
        snapshot.broker.discoveryFailed,
      );
    if (snapshot.broker.discoveryCancelled !== undefined)
      counter(
        "scanner_broker_discovery_requests_cancelled_total",
        "Queued discovery broker requests cancelled before dispatch.",
        snapshot.broker.discoveryCancelled,
      );
    if (snapshot.broker.discoveryExpired !== undefined)
      counter(
        "scanner_broker_discovery_requests_expired_total",
        "Discovery broker requests expired before dispatch.",
        snapshot.broker.discoveryExpired,
      );
    gauge(
      "scanner_broker_requests_queued",
      "Broker requests currently queued.",
      snapshot.broker.queued,
    );
    gauge(
      "scanner_broker_requests_active",
      "Broker requests currently in flight.",
      snapshot.broker.active,
    );
  }
  if (snapshot.discovery) {
    const discovery = snapshot.discovery;
    const modeValue: Record<string, number> = {
      OFF: 0,
      SHADOW: 1,
      AUTO_ADD: 2,
    };
    const schedulerValue: Record<string, number> = {
      OFF: 0,
      MISSING_PROVIDER: 1,
      IDLE: 2,
      RUNNING: 3,
      DEGRADED: 4,
    };
    const catalogValue: Record<string, number> = {
      UNKNOWN: 0,
      FRESH: 1,
      LAST_GOOD: 2,
      UNAVAILABLE: 3,
    };
    const runStatusValue: Record<string, number> = {
      RUNNING: 0,
      COMPLETED: 1,
      PARTIAL: 2,
      FAILED: 3,
      CANCELLED: 4,
    };
    gauge(
      marketMetric("scanner_discovery_mode"),
      "Discovery mode (0=OFF 1=SHADOW 2=AUTO_ADD).",
      modeValue[discovery.mode] ?? -1,
    );
    gauge(
      marketMetric("scanner_discovery_scheduler_status"),
      "Discovery scheduler state (0=OFF 1=MISSING_PROVIDER 2=IDLE 3=RUNNING 4=DEGRADED).",
      schedulerValue[discovery.scheduler] ?? -1,
    );
    gauge(
      marketMetric("scanner_discovery_catalog_status"),
      "Discovery catalog state (0=UNKNOWN 1=FRESH 2=LAST_GOOD 3=UNAVAILABLE).",
      catalogValue[discovery.catalog.status] ?? -1,
    );
    gauge(
      marketMetric("scanner_discovery_catalog_rows"),
      "Rows in the most recent captured discovery catalog.",
      discovery.catalog.rowCount,
    );
    gauge(
      marketMetric("scanner_discovery_catalog_admitted_rows"),
      "Rows admitted from the most recent discovery catalog.",
      discovery.catalog.admittedCount,
    );
    gauge(
      marketMetric("scanner_discovery_catalog_age_ms"),
      "Age of the most recent discovery catalog.",
      discovery.catalog.ageMs,
    );
    gauge(
      marketMetric("scanner_discovery_queue_depth"),
      "Discovery work items currently waiting in the scheduler queue.",
      discovery.queueDepth,
    );
    gauge(
      marketMetric("scanner_discovery_oldest_queue_age_ms"),
      "Age of the oldest discovery item waiting in the scheduler queue.",
      discovery.oldestQueueAgeMs,
    );
    gauge(
      marketMetric("scanner_discovery_cycle_p95_ms"),
      "p95 discovery cycle duration over the bounded in-process sample.",
      discovery.performance?.cycleP95Ms,
    );
    gauge(
      marketMetric("scanner_discovery_queue_p95_ms"),
      "p95 discovery queue latency over the bounded in-process sample.",
      discovery.performance?.queueP95Ms,
    );
    gauge(
      marketMetric("scanner_discovery_performance_sample_count"),
      "Number of discovery performance samples retained by the current process.",
      discovery.performance?.sampleCount,
    );
    if (discovery.performance?.requestUsage) {
      gauge(
        marketMetric("scanner_discovery_last_run_requests_completed"),
        "Discovery broker requests completed during the most recent run.",
        discovery.performance.requestUsage.completed,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_requests_failed"),
        "Discovery broker requests failed during the most recent run.",
        discovery.performance.requestUsage.failed,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_requests_cancelled"),
        "Discovery broker requests cancelled during the most recent run.",
        discovery.performance.requestUsage.cancelled,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_requests_expired"),
        "Discovery broker requests expired during the most recent run.",
        discovery.performance.requestUsage.expired,
      );
    }
    if (discovery.lastRun) {
      const coverage = discovery.lastRun.coverage;
      gauge(
        marketMetric("scanner_discovery_last_run_status"),
        "Most recent discovery run state (0=RUNNING 1=COMPLETED 2=PARTIAL 3=FAILED 4=CANCELLED).",
        runStatusValue[discovery.lastRun.status] ?? -1,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_total"),
        "Catalog members in the most recent discovery run.",
        coverage.total,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_pass"),
        "PASS outcomes in the most recent discovery run.",
        coverage.pass,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_fail"),
        "FAIL outcomes in the most recent discovery run.",
        coverage.fail,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_unevaluable"),
        "UNEVALUABLE outcomes in the most recent discovery run.",
        coverage.unevaluable,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_deferred"),
        "DEFERRED outcomes in the most recent discovery run.",
        coverage.deferred,
      );
      gauge(
        marketMetric("scanner_discovery_last_run_deferred_fraction"),
        "Fraction of the most recent discovery run deferred or unfinished.",
        coverage.total > 0 ? coverage.deferred / coverage.total : null,
      );
    }
  }
  gauge(
    "scanner_websocket_connected_clients",
    "Number of connected WebSocket clients.",
    snapshot.websocket.connectedClients,
  );
  gauge(
    "scanner_websocket_last_broadcast_latency_ms",
    "Duration of the most recent WebSocket broadcast to all clients.",
    snapshot.websocket.lastBroadcastLatencyMs,
  );
  counter(
    "scanner_websocket_broadcasts_total",
    "Total WebSocket broadcasts sent since process start.",
    snapshot.websocket.broadcastsTotal,
  );
  counter(
    "scanner_websocket_frames_suppressed_total",
    "Total WebSocket frames withheld because they were unchanged since the last send.",
    snapshot.websocket.framesSuppressedTotal,
  );

  if (snapshot.persistence) {
    for (const [entity, metric] of Object.entries(snapshot.persistence)) {
      const label = `{entity="${entity}"}`;
      lines.push(
        `# HELP scanner_persistence_rows_written_total Total rows inserted or updated by set-based bulk writes, by entity.`,
        `# TYPE scanner_persistence_rows_written_total counter`,
        `scanner_persistence_rows_written_total${label} ${metric.rowsWrittenTotal}`,
        `# HELP scanner_persistence_conflicts_total Total rows that hit ON CONFLICT DO UPDATE (an existing row was overwritten), by entity.`,
        `# TYPE scanner_persistence_conflicts_total counter`,
        `scanner_persistence_conflicts_total${label} ${metric.conflictsTotal}`,
        `# HELP scanner_persistence_writes_total Total bulk-write statements executed, by entity.`,
        `# TYPE scanner_persistence_writes_total counter`,
        `scanner_persistence_writes_total${label} ${metric.writesTotal}`,
      );
      if (metric.lastLatencyMs !== null)
        lines.push(
          `# HELP scanner_persistence_last_latency_ms Duration of the most recent bulk write, by entity.`,
          `# TYPE scanner_persistence_last_latency_ms gauge`,
          `scanner_persistence_last_latency_ms${label} ${metric.lastLatencyMs}`,
        );
      if (metric.p95LatencyMs !== null)
        lines.push(
          `# HELP scanner_persistence_p95_latency_ms p95 duration of recent bulk writes over a rolling window, by entity.`,
          `# TYPE scanner_persistence_p95_latency_ms gauge`,
          `scanner_persistence_p95_latency_ms${label} ${metric.p95LatencyMs}`,
        );
    }
  }

  if (snapshot.retention) {
    const run = snapshot.retention;
    const statusValue: Record<string, number> = {
      RUNNING: 0,
      SUCCEEDED: 1,
      FAILED: 2,
      SKIPPED_CONCURRENT: 3,
    };
    gauge(
      "scanner_retention_last_run_status",
      "Status of the most recent retention run (0=RUNNING 1=SUCCEEDED 2=FAILED 3=SKIPPED_CONCURRENT).",
      statusValue[run.status] ?? -1,
    );
    gauge(
      "scanner_retention_last_run_started_timestamp_seconds",
      "Unix timestamp (seconds) of the most recent retention run's start.",
      Date.parse(run.startedAt) / 1000,
    );
    if (run.finishedAt)
      gauge(
        "scanner_retention_last_run_finished_timestamp_seconds",
        "Unix timestamp (seconds) of the most recent retention run's completion.",
        Date.parse(run.finishedAt) / 1000,
      );
    gauge(
      "scanner_retention_last_run_failed_tables",
      "Number of tables that raised an error on the most recent retention run.",
      run.tableResults.filter((result) => result.error !== null).length,
    );
    for (const result of run.tableResults) {
      const label = `{table_name="${result.table}"}`;
      lines.push(
        `# HELP scanner_retention_last_run_rows_deleted Rows deleted for this table on the most recent retention run, by table.`,
        `# TYPE scanner_retention_last_run_rows_deleted gauge`,
        `scanner_retention_last_run_rows_deleted${label} ${result.rowsDeleted}`,
      );
    }
  }

  if (snapshot.backtestAutomation) {
    const automation = snapshot.backtestAutomation;
    gauge(
      marketMetric("scanner_backtest_automation_enabled"),
      "1 when the scheduled backtest automation cycle is enabled for this market.",
      automation.enabled ? 1 : 0,
    );
    gauge(
      marketMetric("scanner_backtest_automation_outstanding"),
      "Qualification work items currently queued or running.",
      automation.outstandingWork,
    );
    gauge(
      marketMetric("scanner_backtest_automation_oldest_outstanding_age_ms"),
      "Age of the oldest outstanding qualification work item.",
      automation.oldestOutstandingAgeMs,
    );
    gauge(
      marketMetric("scanner_backtest_automation_oldest_waiting_age_ms"),
      "Age of the oldest work waiting on capacity or retry backoff.",
      automation.oldestWaitingAgeMs,
    );
    gauge(
      marketMetric("scanner_backtest_automation_last_result_age_ms"),
      "Milliseconds since the most recent successful baseline completion.",
      automation.lastResultAgeMs,
    );
    gauge(
      marketMetric("scanner_backtest_automation_last_result_duration_ms"),
      "Runtime of the most recent successful baseline completion.",
      automation.lastResultDurationMs,
    );
    gauge(
      marketMetric("scanner_backtest_automation_failed_work"),
      "Qualification work items in a terminal failed state.",
      automation.failedWork,
    );
    gauge(
      marketMetric("scanner_backtest_automation_retry_scheduled"),
      "Qualification work items waiting on a bounded retry backoff.",
      automation.retryScheduled,
    );
    gauge(
      marketMetric("scanner_backtest_automation_stage_failed"),
      "Follow-on stages in a terminal failed state.",
      automation.stageFailed,
    );
    gauge(
      marketMetric("scanner_backtest_automation_last_cycle_age_ms"),
      "Milliseconds since the last durable automation cycle finished.",
      automation.lastCycleAgeMs,
    );
    gauge(
      marketMetric("scanner_backtest_automation_last_cycle_duration_ms"),
      "Wall-clock duration of the last durable automation cycle.",
      automation.lastCycleDurationMs,
    );
    gauge(
      marketMetric("scanner_backtest_automation_last_cycle_dispatched"),
      "Baseline replays dispatched by the last durable automation cycle.",
      automation.lastCycleDispatched,
    );
    gauge(
      marketMetric("scanner_backtest_automation_status_latency_ms"),
      "Wall-clock cost of the automation status read backing this scrape.",
      automation.statusLatencyMs,
    );
  }

  return lines.join("\n") + "\n";
}
