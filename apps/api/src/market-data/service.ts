import { normalizedQuoteSize } from "../paper-bot/normalized-quote-size.js";
import {
  DEFAULT_ALERT_POLICY,
  type AlertPolicy,
  type BenchmarkReadiness,
  type CandidatePasteItem,
  type CandidatePasteReport,
  type CandidateIntakeStatus,
  type ContextEvaluation,
  type DependencyStatus,
  type FeatureSnapshot,
  type ScannerAlert,
  type StrategyEvaluation,
  type StrategyStateEvent,
  type UniverseAutomation,
  type UpdateCandidateIntake,
} from "@tsx-scanner/contracts";
import type { OperationalStatusInput } from "../foundation/operational-status.js";
import type { Pool } from "pg";
import { createAlerts } from "../alerts/alert-service.js";
import type { AlertStore } from "../alerts/alert-repository.js";
import type {
  Candle,
  MarketDataAdapter,
  MarketDataStatus,
  Quote,
} from "../questrade/types.js";
import { QuestradeAuthenticationError } from "../questrade/token-manager.js";
import { QuestradeCandleService } from "./candle-service.js";
import { QuestradeQuoteService } from "./quote-service.js";
import type { PersistedInstrument } from "./repository.js";
import type { FeatureSnapshotStore } from "./feature-repository.js";
import type { FeatureEngineSink, WarmupReadiness } from "./scanner-client.js";
import type { StrategySignalStore } from "./strategy-repository.js";
import {
  MarketSessionManager,
  type MarketSessionSnapshot,
} from "./session-manager.js";
import type { UniverseManager } from "../universe/universe-service.js";
import type {
  BenchmarkManager,
  BenchmarkSnapshot,
} from "./benchmark-service.js";
import { AsyncMutex } from "./cycle-mutex.js";
import {
  ScannerRecoveryGuard,
  ScannerRecoveryPausedError,
} from "./scanner-recovery.js";
import { AlertBuffer } from "./alert-buffer.js";
import { projectCandidateCoverage } from "./coverage-projection.js";
import { projectObservability } from "./observability-projection.js";
import { LatencyWindow } from "../observability/latency-window.js";
import {
  PaperBotLiveProcessor,
  type PaperBotLiveProcessorDeps,
  type PaperPredictionSnapshotWriter,
  type ProfileLookup,
} from "../paper-bot/paper-bot-live-processor.js";
import type {
  PaperBotStore,
  UnfinishedLiveRun,
} from "../paper-bot/paper-bot-repository.js";
import type {
  PaperExecutionStore,
  PaperRunHealth,
} from "../paper-bot/paper-execution-repository.js";
import type {
  CoordinationPortfolioHealth,
  PaperCoordinationStore,
} from "../paper-bot/paper-coordination-repository.js";
import type { CoordinationPolicy } from "../paper-bot/coordination-policy.js";
import type {
  AssumptionsSnapshot,
  CandleFact,
  QuoteFact,
} from "../paper-bot/types.js";
import { zonedSessionBoundary } from "../paper-bot/session-time.js";
import {
  FundedLiveAdapter,
  type FundedInvalidation,
  type FundedOperationalSnapshot,
} from "../paper-bot/funded-live-adapter.js";
import type { FundedPolicy } from "../paper-bot/funded-policy.js";

export type MarketDataServiceState =
  | "STARTING"
  | "ACTIVE"
  | "MARKET_CLOSED"
  | "DATA_DELAYED"
  | "DEGRADED"
  | "AUTH_REQUIRED"
  | "STOPPED";

/** Consecutive authentication failures before the service stops reporting plain `DEGRADED` and
 *  transitions to the paused `AUTH_REQUIRED` state. `index.ts` already retries `initialize()` with
 *  exponential backoff; this only changes what the service *reports* while that backoff runs. */
const AUTH_FAILURE_PAUSE_THRESHOLD = 2;

/** How often the closed-market cycle re-checks for unfinished paper runs. */
const CLOSED_MARKET_PAPER_SWEEP_MS = 60_000;

/**
 * How many later sessions a still-unresolved session close may wait through.
 * 1 means "its own session and the next one". Past that the execution is
 * abandoned rather than closed against a quote from an unrelated session --
 * such a price says nothing about the session the signal belongs to.
 */
const MAX_CLOSE_HORIZON_SESSIONS = 1;

export interface MarketDataServiceSnapshot {
  state: MarketDataServiceState;
  auth: "CONNECTED" | "AUTH_REQUIRED";
  dataStatus: MarketDataStatus | "UNKNOWN";
  session?: MarketSessionSnapshot;
  instrumentCount: number;
  featureSnapshotCount: number;
  contextEvaluationCount: number;
  benchmarkCount: number;
  benchmarkReadiness?: BenchmarkReadiness;
  benchmarkWarnings: string[];
  lastCycleDurationMs?: number;
  lastEngineDurationMs?: number;
  lastFeatureDurationMs?: number;
  lastEvaluationDurationMs?: number;
  lastEvaluationAgeMs?: number;
  lastQuoteAt?: string;
  lastCandleAt?: string;
  lastError?: string;
  paperBot?: PaperBotSnapshot;
}

/**
 * The paper-bot signals private development record ("Failure
 * visibility") requires before commissioning: without them a process can
 * report healthy while its paper lifecycle has silently stopped.
 */
export interface PaperBotSnapshot {
  runId: string | null;
  sessionDate: string | null;
  scheduledCloseAt: string | null;
  executionModelVersion: string | null;
  openExecutions: number | null;
  closePendingExecutions: number | null;
  closedExecutions: number | null;
  noFillExecutions: number | null;
  /** Executable markets declined by the economics gate, not data failures. */
  rejectedEconomicsExecutions: number | null;
  /** READY events found without complete paper evidence on the last cycle. */
  reconciliationBacklog: number | null;
  /**
   * Of that backlog, how many could not be repaired at all. A non-zero value
   * that never falls is a permanently stuck row, not a transient one.
   */
  unreconcilableEvents: number;
  /** Runs past their noon boundary still awaiting closure, excluding today's. */
  overdueRuns: number;
  unresolvedCoordinatedPositions: number;
  completedRunsWithUnresolvedCoordinatedPositions: number;
  oldestUnresolvedCoordinatedAgeMs: number | null;
  unknownQuoteSizeUnits: number;
  /**
   * Executions that will never resolve: CLOSE_PENDING past the close horizon.
   * Reported as unresolved, never counted as closed trades.
   */
  abandonedExecutions: number | null;
  lastTransitionAt: string | null;
  lastProcessingDurationMs: number | null;
  lastError: string | null;
  lastSuccessfulProcessingAt?: string | null;
  fundedProcessing?: boolean;
  fundedLastSuccessfulProcessingAt?: string | null;
  funded?: FundedOperationalSnapshot;
}

export interface FundedPaperBotConfig {
  readonly pool: Pool;
  readonly accountId: string;
  readonly currency: "CAD" | "USD";
  readonly initialCash: number;
  readonly dailyLossLimit: number;
  readonly policy?: FundedPolicy;
}

export interface MarketDataLogger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

const SILENT_LOGGER: MarketDataLogger = {
  info: () => undefined,
  error: () => undefined,
};
// Bounds strategy_state_event's in-memory timeline so a full session (or a
// soak run) does not grow this array without limit; the durable history
// still lives in Postgres via strategy-repository.ts.
const MAX_RETAINED_STATE_EVENTS = 2_000;

export class QuestradeDataService {
  private instruments: PersistedInstrument[] = [];
  private state: MarketDataServiceState = "STARTING";
  private auth: MarketDataServiceSnapshot["auth"] = "AUTH_REQUIRED";
  private dataStatus: MarketDataServiceSnapshot["dataStatus"] = "UNKNOWN";
  private lastQuoteAt?: string;
  private lastCandleAt?: string;
  private lastError?: string;
  private lastOneMinuteBucket?: number;
  private lastFiveMinuteBucket?: number;
  private lastMarketRefreshBucket?: number;
  private lastCloseCollectionAt?: number;
  private lastCollectedSessionClose?: number;
  private engineSessionStart?: number;
  private timer?: NodeJS.Timeout;
  private readonly cycleMutex = new AsyncMutex();
  private featureEngine?: FeatureEngineSink;
  private featureStore?: FeatureSnapshotStore;
  private strategyStore?: StrategySignalStore;
  private alertStore?: AlertStore;
  private featureEngineReady = false;
  private readonly scannerRecovery = new ScannerRecoveryGuard();
  private universeRefreshPending = false;
  private readonly latestFeatures = new Map<string, FeatureSnapshot>();
  private readonly latestStrategies = new Map<string, StrategyEvaluation>();
  private readonly latestContexts = new Map<string, ContextEvaluation>();
  private readonly stateEvents: StrategyStateEvent[] = [];
  private alertBuffer = new AlertBuffer();
  private alertPolicy: AlertPolicy = { ...DEFAULT_ALERT_POLICY };
  private readonly fiveMinuteCandles = new Map<number, Map<string, Candle>>();
  private benchmarkSnapshot: BenchmarkSnapshot = {
    references: [],
    instruments: [],
    warnings: [],
  };
  private benchmarkReadiness?: BenchmarkReadiness;
  private lastCycleDurationMs?: number;
  private readonly activeMonitoringCycleLatencies = new LatencyWindow();
  private lastEngineDurationMs?: number;
  private lastFeatureDurationMs?: number;
  private lastEvaluationDurationMs?: number;
  private lastEvaluationAt?: number;
  private consecutiveAuthFailures = 0;
  /** Counts persisted `strategy_evaluation` writes, not merely cycles run — this is the metric
   *  W1's `score_version` regression should have made impossible to miss: a scanner that reports
   *  all-green health while this stays 0 is silently not writing anything. */
  private evaluationsWrittenTotal = 0;
  private paperBotStore?: PaperBotStore;
  private paperBotExecutionStore?: PaperExecutionStore;
  private paperBotProfiles?: ProfileLookup;
  private paperBotAssumptions?: AssumptionsSnapshot;
  private paperBotExecutionModelVersion?: string;
  private paperPredictionSnapshots?: PaperPredictionSnapshotWriter;
  private paperCoordinationStore?: PaperCoordinationStore;
  private paperCoordinationPolicy?: CoordinationPolicy;
  private paperCoordinationSizing?: PaperBotLiveProcessorDeps["coordinationSizing"];
  private paperCandidatePredictionResolver?: PaperBotLiveProcessorDeps["candidatePredictionResolver"];
  private paperBotProcessor?: PaperBotLiveProcessor;
  private paperFundedConfig?: FundedPaperBotConfig;
  private paperFundedAdapter?: FundedLiveAdapter;
  private paperFundedBound = false;
  /** Funded runs from an earlier session that still need later-session quotes. */
  private readonly paperFundedRecoveryAdapters = new Map<
    string,
    FundedLiveAdapter
  >();
  private paperFundedOperational?: FundedOperationalSnapshot;
  private paperFundedWork?: Promise<void>;
  /** A full quote/observation cycle arrived while bounded backlog catch-up was
   *  running. Pause catch-up so the next durable market cycle gets priority. */
  private paperFundedCyclePending = false;
  private paperFundedLastError?: string;
  private paperLastSuccessAt?: string;
  private fundedLastSuccessAt?: string;
  private paperBotSessionDate?: string;
  private paperBotScheduledCloseAt?: string;
  private paperBotRunId?: string;
  private paperBotLastSweepAt = 0;
  private paperBotOverdueRunCount = 0;
  private paperBotReconciliationBacklog?: number;
  private paperBotUnreconcilableCount = 0;
  private paperBotAbandonedThisSweep = 0;
  private paperBotHealth?: PaperRunHealth;
  private paperCoordinationHealth?: CoordinationPortfolioHealth;
  private paperBotProcessingMs?: number;
  private paperBotLastError?: string;

  constructor(
    private readonly adapter: MarketDataAdapter,
    private readonly metadata: UniverseManager,
    private readonly quotes: QuestradeQuoteService,
    private readonly candles: QuestradeCandleService,
    private readonly sessions: MarketSessionManager,
    private readonly clock: () => Date = () => new Date(),
    private readonly pollIntervalMs = 2_000,
    private logger: MarketDataLogger = SILENT_LOGGER,
    private readonly benchmarks?: BenchmarkManager,
    private readonly benchmarkMaxStalenessSeconds = 30,
  ) {}

  setLogger(logger: MarketDataLogger): void {
    this.logger = logger;
  }

  setFeatureEngine(
    engine: FeatureEngineSink,
    store: FeatureSnapshotStore,
    strategyStore?: StrategySignalStore,
    alertStore?: AlertStore,
  ): void {
    this.featureEngine = engine;
    this.featureStore = store;
    this.strategyStore = strategyStore;
    this.alertStore = alertStore;
  }

  /**
   * Wires the paper-trading-bot live processor (private development record,
   * Phase 3). Once wired, a RUNNING/CLOSE_PENDING live run for the current session date and
   * `executionModelVersion` is started or resumed the next time
   * `initialize()` runs or a new session is detected.
   */
  setPaperBot(
    store: PaperBotStore,
    executionStore: PaperExecutionStore,
    profiles: ProfileLookup,
    assumptions: AssumptionsSnapshot,
    executionModelVersion: string,
    predictionSnapshots?: PaperPredictionSnapshotWriter,
    coordinationStore?: PaperCoordinationStore,
    coordinationPolicy?: CoordinationPolicy,
    coordinationSizing?: PaperBotLiveProcessorDeps["coordinationSizing"],
    candidatePredictionResolver?: PaperBotLiveProcessorDeps["candidatePredictionResolver"],
    funded?: FundedPaperBotConfig,
  ): void {
    this.paperBotStore = store;
    this.paperBotExecutionStore = executionStore;
    this.paperBotProfiles = profiles;
    this.paperBotAssumptions = assumptions;
    this.paperBotExecutionModelVersion = executionModelVersion;
    this.paperPredictionSnapshots = predictionSnapshots;
    this.paperCoordinationStore = coordinationStore;
    this.paperCoordinationPolicy = coordinationPolicy;
    this.paperCoordinationSizing = coordinationSizing;
    this.paperCandidatePredictionResolver = candidatePredictionResolver;
    this.paperFundedConfig = funded;
    this.paperFundedOperational = undefined;
    this.paperFundedBound = false;
    this.paperFundedCyclePending = false;
    this.paperFundedRecoveryAdapters.clear();
  }

  /**
   * Starts or resumes today's live paper-bot run and (re)builds the
   * processor bound to it. Called once from `initialize()` and again
   * whenever `refreshMarketIfDue()` detects a new trading session, mirroring
   * how the feature engine itself is re-warmed on a session rollover.
   */
  private async startOrResumePaperBotRun(): Promise<void> {
    if (
      !this.paperBotStore ||
      !this.paperBotExecutionStore ||
      !this.paperBotProfiles ||
      !this.paperBotAssumptions ||
      !this.paperBotExecutionModelVersion
    )
      return;
    const market = this.sessions.getMarket();
    const sessionDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.paperBotAssumptions.sessionTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(market.startTime);
    if (sessionDate === this.paperBotSessionDate) return;
    // Never swap a run/account adapter underneath an in-flight funded batch.
    await this.paperFundedWork;
    const scheduledCloseAt = zonedSessionBoundary(
      sessionDate,
      this.paperBotAssumptions.noonCloseTime,
      this.paperBotAssumptions.sessionTimezone,
    );
    const run = await this.paperBotStore.startOrResumeLiveRun({
      source: "LIVE",
      sessionDate,
      sessionTimezone: this.paperBotAssumptions.sessionTimezone,
      scheduledCloseAt,
      executionModelVersion: this.paperBotExecutionModelVersion,
      assumptions: this.paperBotAssumptions,
      marketId: this.sessions.getMarketId(),
    });
    this.paperBotSessionDate = sessionDate;
    this.paperBotScheduledCloseAt = run.scheduledCloseAt;
    this.paperBotRunId = run.id;
    this.paperBotProcessor = new PaperBotLiveProcessor(
      {
        paperBotStore: this.paperBotStore,
        paperExecutionStore: this.paperBotExecutionStore,
        profiles: this.paperBotProfiles,
        assumptions: this.paperBotAssumptions,
        predictionSnapshots: this.paperPredictionSnapshots,
        coordinationStore: this.paperCoordinationStore,
        coordinationPolicy: this.paperCoordinationPolicy,
        coordinationSizing: this.paperCoordinationSizing,
        candidatePredictionResolver: this.paperCandidatePredictionResolver,
      },
      run.id,
    );
    const fundedConfig = this.paperFundedConfig;
    const fundedAdapter = fundedConfig
      ? new FundedLiveAdapter({
          pool: fundedConfig.pool,
          runId: run.id,
          accountId: fundedConfig.accountId,
          currency: fundedConfig.currency,
          marketId: run.marketId,
          assumptions: run.assumptions,
          policy: fundedConfig.policy,
        })
      : undefined;
    this.paperFundedAdapter = fundedAdapter;
    this.paperFundedBound = false;
    this.paperFundedOperational = undefined;
    if (fundedAdapter && fundedConfig) {
      try {
        await fundedAdapter.bind(
          run.sessionDate,
          market.startTime.toISOString(),
          fundedConfig.initialCash,
          fundedConfig.dailyLossLimit,
        );
        this.paperFundedBound = true;
      } catch (error) {
        // An earlier funded session may still have close-pending orders. Keep
        // the live processor available and retry binding after each later
        // quote batch; abandoning the whole market-data initialization here
        // would prevent those quotes from ever reaching the prior run.
        if (
          !(error instanceof Error) ||
          !error.message.includes("Funded account has")
        )
          throw error;
        this.logger.error({
          event: "FUNDED_PAPER_BIND_DEFERRED",
          runId: run.id,
          error: error.message,
        });
      }
    }
    try {
      const reconciliation =
        await this.paperBotProcessor.reconcileReadyEvents();
      this.paperBotReconciliationBacklog = reconciliation.candidates;
      this.paperBotUnreconcilableCount = reconciliation.skipped.length;
      if (reconciliation.candidates > 0 || reconciliation.processed > 0) {
        this.logger.info({
          event: "PAPER_BOT_READY_EVENTS_RECONCILED",
          runId: run.id,
          count: reconciliation.processed,
          backlog: reconciliation.candidates,
          skipped: reconciliation.skipped.length,
        });
      }
    } catch (error) {
      // Paper evidence is repairable by the next periodic reconciliation and
      // must not prevent the scanner from starting.
      this.logger.error({
        event: "PAPER_BOT_RECONCILIATION_FAILED",
        runId: run.id,
        error:
          error instanceof Error ? error.message : "Unknown paper-bot error",
      });
    }
    this.logger.info({
      event: "PAPER_BOT_RUN_STARTED",
      runId: run.id,
      sessionDate,
      status: run.status,
    });
    // A process that starts after noon -- or after days of downtime -- must
    // immediately request closure for every unfinished earlier run rather
    // than leaving it RUNNING forever (Phase 3 durability requirements).
    await this.settleOverduePaperBotRuns(new Map(), false);
  }

  async initialize(): Promise<void> {
    // Settling an overdue paper run reads and writes only the database, so it
    // must not sit behind Questrade authentication. A stranded refresh token
    // is exactly the situation that produces overdue runs, and `initialize()`
    // throws below when auth fails -- leaving every unfinished run stranded
    // for the whole outage if this ran any later. index.ts retries
    // initialize() with backoff, so this re-runs until it succeeds.
    await this.settleOverduePaperBotRuns(new Map(), false);
    try {
      await this.adapter.initialize();
      this.auth = "CONNECTED";
      this.consecutiveAuthFailures = 0;
    } catch (error) {
      this.auth = "AUTH_REQUIRED";
      this.consecutiveAuthFailures += 1;
      this.fail(
        error,
        "MARKET_DATA_AUTH_FAILED",
        this.consecutiveAuthFailures >= AUTH_FAILURE_PAUSE_THRESHOLD
          ? "AUTH_REQUIRED"
          : "DEGRADED",
      );
      throw error;
    }

    try {
      this.scannerRecovery.assertAvailable(this.clock().getTime());
      this.instruments = await this.metadata.enrich(true);
      this.benchmarkSnapshot = await this.resolveBenchmarks();
      const session = await this.sessions.initialize();
      if (this.alertStore) {
        const [alerts, policy] = await Promise.all([
          this.alertStore.listRecent(),
          this.alertStore.loadPolicy(),
        ]);
        // A retried initialize() (e.g. after a 429 during warm-up) re-lists the same durable
        // alerts; rebuild the in-memory buffer from the durable snapshot instead of appending,
        // so a retry cannot duplicate alerts that were already loaded. AlertBuffer's constructor
        // already dedupes by alertId.
        this.alertBuffer = new AlertBuffer(alerts);
        this.alertPolicy = policy;
      }
      await this.startOrResumePaperBotRun();
      this.lastMarketRefreshBucket = Math.floor(
        this.clock().getTime() / 3_600_000,
      );
      await this.synchronizeFeatureEngine();
      if (
        session.marketStatus === "OPEN" ||
        session.marketStatus === "AFTER_HOURS"
      ) {
        this.markCandleBuckets(this.clock());
      }
      this.state = session.marketStatus === "OPEN" ? "ACTIVE" : "MARKET_CLOSED";
      this.lastError = undefined;
      this.logger.info({
        event: "MARKET_DATA_INITIALIZED",
        instruments: this.instruments.length,
        phase: session.phase,
      });
    } catch (error) {
      this.recordScannerRecoveryFailure(error);
      this.fail(error, "MARKET_DATA_INITIALIZATION_FAILED");
      throw error;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runCycle(), this.pollIntervalMs);
    this.timer.unref?.();
    void this.runCycle();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.cycleMutex.waitForIdle();
    await this.paperFundedWork;
    this.state = "STOPPED";
  }

  async runCycle(): Promise<void> {
    // A tick that lands while the mutex is already held (by a previous cycle still running, or
    // by a universe refresh/candidate intake in progress) is skipped rather than queued — the
    // next 2s poll tick will run once the holder releases. Queuing every skipped tick behind the
    // mutex would just replay a burst of stale cycles back-to-back once the holder frees up.
    if (this.cycleMutex.isLocked) return;
    await this.cycleMutex.runExclusive(async () => {
      const cycleStarted = performance.now();
      try {
        try {
          await this.refreshMarketIfDue();
        } catch (error) {
          if (
            !(error instanceof ScannerRecoveryPausedError) ||
            this.sessions.getSnapshot().marketStatus === "OPEN"
          )
            throw error;
          // A deferred session reload must not block closing paper facts.
          this.lastError = error.message;
        }
        if (
          this.universeRefreshPending ||
          (this.featureEngine && !this.featureEngineReady)
        ) {
          const pause = this.scannerRecovery.pause(this.clock().getTime());
          // A history-reload pause must not block the existing closed-market
          // paper settlement path. Open-market scans remain out of sync.
          if (!pause) {
            if (this.universeRefreshPending)
              await this.refreshUniverseWithinCycle();
            else await this.synchronizeFeatureEngine();
          } else if (this.sessions.getSnapshot().marketStatus === "OPEN")
            throw pause;
          else this.lastError = pause.message;
        }
        const session = this.sessions.getSnapshot();
        if (session.marketStatus !== "OPEN") {
          this.state = "MARKET_CLOSED";
          const instruments = await this.quoteCollectionInstruments();
          const closeAt = session.endTime.getTime();
          const now = this.clock().getTime();
          let closeQuotes: Quote[] = [];
          // Collect the final completed bars and a post-boundary book before
          // settlement. Retry briefly for provider publication lag, and allow
          // one catch-up collection on startup after the close. Never scan or
          // admit new signals on this path.
          if (
            this.paperBotProcessor &&
            now >= closeAt &&
            (this.lastCollectedSessionClose !== closeAt ||
              (now - closeAt <= 5 * 60_000 &&
                now - (this.lastCloseCollectionAt ?? 0) >= 60_000))
          ) {
            const scannerWasReady = this.featureEngineReady;
            try {
              closeQuotes = await this.quotes.collect(
                instruments.map((instrument) => instrument.symbolId),
              );
              await this.collectCandles(
                ["OneMinute", "FiveMinutes"],
                scannerWasReady,
              );
              this.lastCollectedSessionClose = closeAt;
              this.lastCloseCollectionAt = now;
            } catch (error) {
              // A collection outage must not suppress durable recovery or the
              // funded order clock. Retry collection on the next cycle.
              if (scannerWasReady && !this.featureEngineReady) {
                this.recordScannerRecoveryFailure(error);
                this.fail(error, "PAPER_BOT_CLOSE_COLLECTION_FAILED");
              } else {
                this.logger.error({
                  event: "PAPER_BOT_CLOSE_COLLECTION_FAILED",
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
          // The regular close can coincide with the first AFTER_HOURS cycle,
          // before the periodic overdue-run sweep is due. Close the current
          // run immediately, then let the sweep reconcile older runs.
          await this.requestPaperBotSessionCloseIfDue(closeQuotes, instruments);
          const closeFacts = this.quotesByInstrumentId(
            closeQuotes,
            instruments,
          );
          this.scheduleFundedPaperBot(closeFacts, []);
          // A closed market still has to settle runs whose session close has passed:
          // one holding no unfinished execution becomes COMPLETED instead of
          // being stranded RUNNING until the next open session. Outside the
          // final collection window, recovery uses retained facts, so this
          // sweep is throttled well below the poll interval.
          if (
            this.paperBotStore &&
            this.clock().getTime() - this.paperBotLastSweepAt >=
              CLOSED_MARKET_PAPER_SWEEP_MS
          ) {
            await this.settleOverduePaperBotRuns(closeFacts, false);
          }
          return;
        }

        const allInstruments = this.allInstruments();
        const collectionInstruments = await this.quoteCollectionInstruments();
        const quotes = await this.quotes.collect(
          collectionInstruments.map((instrument) => instrument.symbolId),
        );
        this.auth = "CONNECTED";
        this.consecutiveAuthFailures = 0;
        const candidateIds = new Set(
          this.instruments.map((value) => value.symbolId),
        );
        this.updateQuoteStatus(
          quotes.filter((value) => candidateIds.has(value.symbolId)),
        );
        await this.updateFeatures(
          quotes,
          allInstruments,
          collectionInstruments,
        );
        const due = this.dueCandleIntervals(this.clock());
        if (due.length > 0) {
          await this.collectCandles(due);
          this.markCandleBuckets(this.clock(), due);
        }
        await this.requestPaperBotSessionCloseIfDue(
          quotes,
          collectionInstruments,
        );
        if (this.paperBotStore) {
          await this.settleOverduePaperBotRuns(
            this.quotesByInstrumentId(quotes, collectionInstruments),
            true,
          );
        }
        this.state =
          this.dataStatus === "DELAYED" || this.dataStatus === "HALTED"
            ? "DATA_DELAYED"
            : "ACTIVE";
        this.lastError = undefined;
        this.scannerRecovery.scanSucceeded();
      } catch (error) {
        this.recordScannerRecoveryFailure(error);
        const isAuthFailure = error instanceof QuestradeAuthenticationError;
        if (isAuthFailure) {
          this.auth = "AUTH_REQUIRED";
          this.consecutiveAuthFailures += 1;
        }
        this.fail(
          error,
          "MARKET_DATA_CYCLE_FAILED",
          isAuthFailure &&
            this.consecutiveAuthFailures >= AUTH_FAILURE_PAUSE_THRESHOLD
            ? "AUTH_REQUIRED"
            : "DEGRADED",
        );
      } finally {
        this.lastCycleDurationMs =
          Math.round((performance.now() - cycleStarted) * 100) / 100;
        this.activeMonitoringCycleLatencies.record(this.lastCycleDurationMs);
      }
    });
  }

  getSnapshot(): MarketDataServiceSnapshot {
    let session: MarketSessionSnapshot | undefined;
    try {
      session = this.sessions.getSnapshot();
    } catch {
      session = undefined;
    }
    return {
      state: this.state,
      auth: this.auth,
      dataStatus: this.dataStatus,
      session,
      instrumentCount: this.instruments.length,
      featureSnapshotCount: this.latestFeatures.size,
      contextEvaluationCount: this.latestContexts.size,
      benchmarkCount: this.benchmarkSnapshot.instruments.length,
      benchmarkReadiness: this.benchmarkReadiness,
      benchmarkWarnings: [...this.benchmarkSnapshot.warnings],
      ...(this.lastCycleDurationMs !== undefined
        ? { lastCycleDurationMs: this.lastCycleDurationMs }
        : {}),
      ...(this.lastEngineDurationMs !== undefined
        ? { lastEngineDurationMs: this.lastEngineDurationMs }
        : {}),
      ...(this.lastFeatureDurationMs !== undefined
        ? { lastFeatureDurationMs: this.lastFeatureDurationMs }
        : {}),
      ...(this.lastEvaluationDurationMs !== undefined
        ? { lastEvaluationDurationMs: this.lastEvaluationDurationMs }
        : {}),
      ...(this.lastEvaluationAt !== undefined
        ? {
            lastEvaluationAgeMs: Math.max(
              0,
              this.clock().getTime() - this.lastEvaluationAt,
            ),
          }
        : {}),
      ...(this.lastQuoteAt ? { lastQuoteAt: this.lastQuoteAt } : {}),
      ...(this.lastCandleAt ? { lastCandleAt: this.lastCandleAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.paperBotStore ? { paperBot: this.paperBotSnapshot() } : {}),
    };
  }

  private paperBotSnapshot(): PaperBotSnapshot {
    return {
      runId: this.paperBotRunId ?? null,
      sessionDate: this.paperBotSessionDate ?? null,
      scheduledCloseAt: this.paperBotScheduledCloseAt ?? null,
      executionModelVersion: this.paperBotExecutionModelVersion ?? null,
      openExecutions: this.paperBotHealth?.open ?? null,
      closePendingExecutions: this.paperBotHealth?.closePending ?? null,
      closedExecutions: this.paperBotHealth?.closed ?? null,
      noFillExecutions: this.paperBotHealth?.noFill ?? null,
      rejectedEconomicsExecutions:
        this.paperBotHealth?.rejectedEconomics ?? null,
      reconciliationBacklog: this.paperBotReconciliationBacklog ?? null,
      unreconcilableEvents: this.paperBotUnreconcilableCount,
      overdueRuns: this.paperBotOverdueRunCount,
      unresolvedCoordinatedPositions:
        this.paperCoordinationHealth?.unresolvedPositions ?? 0,
      completedRunsWithUnresolvedCoordinatedPositions:
        this.paperCoordinationHealth?.completedRunsWithUnresolvedPositions ?? 0,
      oldestUnresolvedCoordinatedAgeMs:
        this.paperCoordinationHealth?.oldestUnresolvedAgeMs ?? null,
      unknownQuoteSizeUnits:
        this.paperCoordinationHealth?.unknownQuoteSizeUnits ?? 0,
      abandonedExecutions: this.paperBotHealth?.abandoned ?? null,
      lastTransitionAt: this.paperBotHealth?.lastTransitionAt ?? null,
      lastProcessingDurationMs: this.paperBotProcessingMs ?? null,
      lastError: this.paperBotLastError ?? this.paperFundedLastError ?? null,
      lastSuccessfulProcessingAt: this.paperLastSuccessAt ?? null,
      fundedProcessing: this.paperFundedWork !== undefined,
      fundedLastSuccessfulProcessingAt: this.fundedLastSuccessAt ?? null,
      ...(this.paperFundedOperational
        ? { funded: this.paperFundedOperational }
        : {}),
    };
  }

  getObservability(): {
    state: MarketDataServiceState;
    auth: string;
    dataStatus: string;
    instrumentCount: number;
    quoteAgeMs: number | null;
    candleAgeMs: number | null;
    benchmarkAgeMs: number | null;
    evaluationAgeMs: number | null;
    cycleLatencyMs: number | null;
    activeMonitoringCycleP95Ms: number | null;
    activeMonitoringCycleSampleCount: number;
    engineLatencyMs: number | null;
    featureLatencyMs: number | null;
    evaluationLatencyMs: number | null;
    missingBarsCount: number;
    readySymbols: number;
    warmingSymbols: number;
    unavailableSymbols: number;
    alertsDeliveredTotal: number;
    evaluationsWrittenTotal: number;
  } {
    return projectObservability({
      state: this.state,
      auth: this.auth,
      dataStatus: this.dataStatus,
      instrumentCount: this.instruments.length,
      lastQuoteAt: this.lastQuoteAt,
      lastCandleAt: this.lastCandleAt,
      lastEvaluationAt: this.lastEvaluationAt,
      lastCycleDurationMs: this.lastCycleDurationMs,
      activeMonitoringCycleP95Ms: this.activeMonitoringCycleLatencies.p95(),
      activeMonitoringCycleSampleCount:
        this.activeMonitoringCycleLatencies.sampleCount,
      lastEngineDurationMs: this.lastEngineDurationMs,
      lastFeatureDurationMs: this.lastFeatureDurationMs,
      lastEvaluationDurationMs: this.lastEvaluationDurationMs,
      benchmarkReadiness: this.benchmarkReadiness,
      latestFeatures: this.latestFeatures.values(),
      alertsDeliveredTotal: this.alertBuffer.deliveredCount,
      evaluationsWrittenTotal: this.evaluationsWrittenTotal,
      now: this.clock().getTime(),
    });
  }

  /**
   * Primitives the shared operational-status contract needs, decoupled from Postgres/dependency
   * checks so {@link computeOperationalStatus} stays a pure function callers can unit test.
   */
  getOperationalStatusInput(): Omit<
    OperationalStatusInput,
    "databaseReady" | "scannerReady" | "marketDataMode"
  > {
    const observability = this.getObservability();
    let session: MarketSessionSnapshot | undefined;
    try {
      session = this.sessions.getSnapshot();
    } catch {
      session = undefined;
    }
    const automation = this.metadata.getAutomation?.();
    const universeConfigured =
      automation?.configuredSymbols?.length ?? this.instruments.length;
    const benchmarkReady =
      this.benchmarkSnapshot.warnings.length === 0 &&
      (this.benchmarkReadiness === undefined ||
        (this.benchmarkReadiness.market?.status !== "UNAVAILABLE" &&
          !this.benchmarkReadiness.sectors.some(
            (sector) => sector.status === "UNAVAILABLE",
          )));
    return {
      auth: this.auth,
      marketStatus: session?.marketStatus ?? null,
      phase: session?.phase ?? null,
      quoteAgeMs: observability.quoteAgeMs,
      candleAgeMs: observability.candleAgeMs,
      benchmarkAgeMs: observability.benchmarkAgeMs,
      evaluationAgeMs: observability.evaluationAgeMs,
      universeConfigured,
      universeResolved: this.instruments.length,
      universeEvaluated: this.latestFeatures.size,
      benchmarkReady,
      scannerSynchronized: this.featureEngineReady,
    };
  }

  getInstruments(): PersistedInstrument[] {
    return this.instruments.map((instrument) => ({ ...instrument }));
  }

  getUniverseAutomation(): UniverseAutomation | undefined {
    const automation = this.metadata.getAutomation?.();
    if (!automation) return undefined;
    const symbols =
      automation.configuredSymbols ??
      automation.members.map((value) => value.symbol);
    return {
      ...automation,
      coverage: symbols.map((symbol) => {
        const upper = symbol.toUpperCase();
        return projectCandidateCoverage(
          symbol,
          automation,
          this.latestFeatures.get(upper),
          [...this.latestStrategies.values()].filter(
            (value) => value.symbol.toUpperCase() === upper,
          ),
          [...this.latestContexts.values()].filter(
            (value) => value.symbol.toUpperCase() === upper,
          ),
        );
      }),
    };
  }

  getUniverseCandidateStatuses(): Promise<CandidateIntakeStatus[]> {
    return this.metadata.getCandidateIntakeStatuses?.() ?? Promise.resolve([]);
  }

  listUniverseRuns(limit?: number) {
    return this.metadata.listRuns?.(limit) ?? Promise.resolve([]);
  }

  async refreshUniverse(): Promise<PersistedInstrument[]> {
    // Queues behind an in-flight cycle (or another refresh) instead of polling for
    // `cycleInFlight` to clear; while this holds the mutex, `runCycle` sees `isLocked` and skips
    // its tick rather than racing this refresh over shared state (instruments, feature maps).
    return this.cycleMutex.runExclusive(async () => {
      try {
        this.universeRefreshPending = true;
        return await this.refreshUniverseWithinCycle();
      } catch (error) {
        this.recordScannerRecoveryFailure(error);
        this.fail(error, "UNIVERSE_REFRESH_FAILED");
        throw error;
      }
    });
  }

  /** Called only while the cycle mutex is held; deferred intake must reload
   * membership before the engine can scan again. */
  private async refreshUniverseWithinCycle(): Promise<PersistedInstrument[]> {
    if (this.featureEngine) {
      this.featureEngineReady = false;
      this.scannerRecovery.assertAvailable(this.clock().getTime());
    }
    const instruments = await this.metadata.enrich();
    this.instruments = instruments;
    this.benchmarkSnapshot = await this.resolveBenchmarks();
    const activeIds = new Set(instruments.map((value) => value.symbolId));
    const activeSymbols = new Set(
      instruments.map((value) => value.symbol.toUpperCase()),
    );
    for (const id of this.fiveMinuteCandles.keys())
      if (!activeIds.has(id)) this.fiveMinuteCandles.delete(id);
    for (const symbol of this.latestFeatures.keys())
      if (!activeSymbols.has(symbol.toUpperCase()))
        this.latestFeatures.delete(symbol);
    for (const [key, evaluation] of this.latestStrategies) {
      if (!activeSymbols.has(evaluation.symbol.toUpperCase()))
        this.latestStrategies.delete(key);
    }
    for (const [key, evaluation] of this.latestContexts) {
      if (!activeSymbols.has(evaluation.symbol.toUpperCase()))
        this.latestContexts.delete(key);
    }
    if (this.featureEngine) {
      await this.synchronizeFeatureEngine();
      this.markCandleBuckets(this.clock());
    }
    this.universeRefreshPending = false;
    this.logger.info({
      event: "UNIVERSE_REFRESH_COMPLETED",
      instruments: instruments.length,
    });
    return this.getInstruments();
  }

  /** Warm one durably admitted discovery candidate without replacing the scanner session. */
  async synchronizeDiscoveryCandidate(
    instrument: PersistedInstrument,
  ): Promise<void> {
    await this.cycleMutex.runExclusive(async () => {
      const marketId = this.sessions.getSnapshot().marketId;
      if ((instrument.marketId ?? "CA_TSX") !== marketId)
        throw new Error(
          "Discovery intake instrument belongs to another market",
        );
      await this.metadata.reloadConfiguredCandidates?.();
      const market = this.sessions.getMarket();
      const warmup = await this.candles.collectRange(
        [instrument],
        {
          startTime: new Date(market.startTime.getTime() - 90 * 86_400_000),
          endTime: this.clock(),
        },
        ["OneMinute", "FiveMinutes", "OneDay"],
      );
      if (!this.featureEngine)
        throw new Error("Scanner feature engine is unavailable");
      if (!this.featureEngine.warmInstrument)
        throw new Error(
          "Scanner does not support incremental instrument warm-up",
        );
      const readiness: WarmupReadiness =
        await this.featureEngine.warmInstrument(instrument, warmup, marketId);
      if (!readiness.ready)
        throw new Error(
          `Discovery candidate warm-up is not ready: ${readiness.reasons.join(",")}`,
        );
      this.rememberFeatureCandles(warmup);
      if (!this.instruments.some((value) => value.id === instrument.id))
        this.instruments = [...this.instruments, instrument].sort(
          (left, right) => left.symbol.localeCompare(right.symbol),
        );
      if (warmup.length > 0) this.lastCandleAt = this.clock().toISOString();
      this.logger.info({
        event: "DISCOVERY_INTAKE_SYNCHRONIZED",
        marketId,
        symbol: instrument.symbol,
        instrumentId: instrument.id,
        candleCount: warmup.length,
      });
    });
  }

  async replaceUniverseSymbols(
    symbols: string[],
  ): Promise<PersistedInstrument[]> {
    if (!this.metadata.replaceSymbols)
      throw new Error("This universe provider is not editable");
    await this.metadata.replaceSymbols(symbols);
    return this.refreshUniverse();
  }

  async updateUniverseCandidates(input: UpdateCandidateIntake): Promise<{
    instruments: PersistedInstrument[];
    pasteReport: CandidatePasteReport;
    refreshError?: string;
  }> {
    if (!this.metadata.updateCandidates)
      throw new Error(
        "This universe provider does not support candidate intake metadata",
      );
    const pasteReport = await this.metadata.updateCandidates(input);
    let instruments: PersistedInstrument[];
    try {
      instruments = await this.refreshUniverse();
    } catch (error) {
      const refreshError =
        error instanceof Error ? error.message : "Universe refresh failed";
      this.logger.error({
        event: "CANDIDATE_INTAKE_REFRESH_FAILED",
        candidatesSaved: true,
        error: refreshError,
      });
      return {
        instruments: this.getInstruments(),
        pasteReport,
        refreshError,
      };
    }
    const unsupported = new Set(
      (this.metadata.getAutomation?.().members ?? [])
        .filter((value) => value.reasons.includes("METADATA_UNAVAILABLE"))
        .map((value) => value.symbol),
    );
    for (const key of ["accepted", "normalized"] as const) {
      const retained: CandidatePasteItem[] = [];
      for (const item of pasteReport[key]) {
        if (item.normalizedSymbol && unsupported.has(item.normalizedSymbol)) {
          pasteReport.unsupported.push({
            ...item,
            reason: "Symbol could not be resolved by the market-data provider",
          });
        } else retained.push(item);
      }
      pasteReport[key] = retained;
    }
    return { instruments, pasteReport };
  }

  getFeatureSnapshots(): FeatureSnapshot[] {
    return [...this.latestFeatures.values()].sort((left, right) =>
      left.symbol.localeCompare(right.symbol),
    );
  }

  getFeatureSnapshot(symbol: string): FeatureSnapshot | undefined {
    return this.latestFeatures.get(symbol.toUpperCase());
  }

  getCandidates(): StrategyEvaluation[] {
    return [...this.latestStrategies.values()].sort(
      (a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol),
    );
  }

  getCandidate(symbol: string): StrategyEvaluation[] {
    const upper = symbol.toUpperCase();
    return this.getCandidates().filter(
      (value) => value.symbol.toUpperCase() === upper,
    );
  }

  getContexts(symbol?: string): ContextEvaluation[] {
    return [...this.latestContexts.values()]
      .filter(
        (value) =>
          !symbol || value.symbol.toUpperCase() === symbol.toUpperCase(),
      )
      .sort(
        (a, b) =>
          b.contextScore - a.contextScore || a.signal.localeCompare(b.signal),
      );
  }

  getSignals(): StrategyStateEvent[] {
    return [...this.stateEvents].reverse();
  }

  getAlerts(): ScannerAlert[] {
    return this.alertBuffer.list();
  }

  getAlertPolicy(): AlertPolicy {
    return { ...this.alertPolicy };
  }

  async updateAlertPolicy(policy: AlertPolicy): Promise<AlertPolicy> {
    this.alertPolicy = this.alertStore
      ? await this.alertStore.savePolicy(policy)
      : { ...policy };
    return this.getAlertPolicy();
  }

  getCandles(symbol: string): Candle[] {
    const instrument = this.instruments.find(
      (value) => value.symbol.toUpperCase() === symbol.toUpperCase(),
    );
    if (!instrument) return [];
    return [
      ...(this.fiveMinuteCandles.get(instrument.symbolId)?.values() ?? []),
    ]
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .slice(-120);
  }

  async check(): Promise<DependencyStatus> {
    const snapshot = this.getSnapshot();
    if (
      snapshot.state === "DEGRADED" ||
      snapshot.state === "STARTING" ||
      snapshot.auth === "AUTH_REQUIRED"
    ) {
      return {
        status: "error",
        detail: snapshot.lastError ?? `Market data is ${snapshot.state}`,
      };
    }
    return {
      status: "ok",
      detail: `Questrade ${snapshot.auth}; ${snapshot.dataStatus}; ${snapshot.session?.phase ?? "UNKNOWN"}`,
    };
  }

  private async collectCandles(
    intervals: ("OneMinute" | "FiveMinutes")[],
    updateScanner = true,
  ): Promise<void> {
    const collected = await this.candles.collect(
      this.allInstruments(),
      this.sessions.getMarket(),
      this.clock(),
      intervals,
    );
    // Closing paper facts remain useful while scanner recovery is paused.
    // Do not turn a failed scanner upload into repeated closing broker reads.
    if (updateScanner) await this.ingestFeatureCandles(collected);
    else this.rememberFeatureCandles(collected);
    if (collected.length > 0) this.lastCandleAt = this.clock().toISOString();
    if (this.paperBotProcessor) {
      try {
        await this.processPaperBotCandles(collected);
      } catch (error) {
        this.logger.error({
          event: "PAPER_BOT_CANDLE_CYCLE_FAILED",
          error:
            error instanceof Error ? error.message : "Unknown paper-bot error",
        });
      }
    }
  }

  /**
   * Feeds newly completed one-minute candles to the candle model's exit
   * evaluation, and to the noon close for any candle execution whose noon
   * bar has now arrived. The quote-side noon close is requested separately
   * from `runCycle`, where the quote batch is available; each call only
   * carries the map for its own data source; the other model's rows simply
   * see no candidate this call, which is a harmless no-op
   * (private development record Phase 3 "detect the noon boundary").
   */
  private async processPaperBotCandles(collected: Candle[]): Promise<void> {
    if (!this.paperBotProcessor) return;
    const oneMinute = collected.filter(
      (candle) => candle.interval === "OneMinute",
    );
    if (oneMinute.length === 0) return;
    const instrumentIdBySymbolId = new Map(
      this.allInstruments().map((instrument) => [
        instrument.symbolId,
        instrument.id,
      ]),
    );
    const candlesByInstrumentId = new Map<string, CandleFact[]>();
    const noonCandlesByInstrumentId = new Map<string, CandleFact>();
    for (const candle of oneMinute) {
      const instrumentId = instrumentIdBySymbolId.get(candle.symbolId);
      if (!instrumentId) continue;
      const fact: CandleFact = {
        start: candle.start.toISOString(),
        end: candle.end.toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      };
      const list = candlesByInstrumentId.get(instrumentId) ?? [];
      list.push(fact);
      candlesByInstrumentId.set(instrumentId, list);
      if (fact.end === this.paperBotScheduledCloseAt) {
        noonCandlesByInstrumentId.set(instrumentId, fact);
      }
    }
    await this.paperBotProcessor.evaluateOpenCandleExecutions(
      candlesByInstrumentId,
      this.paperBotScheduledCloseAt ?? null,
    );
    if (
      this.paperBotScheduledCloseAt &&
      this.clock().getTime() >=
        new Date(this.paperBotScheduledCloseAt).getTime()
    ) {
      await this.paperBotProcessor.requestSessionClose(
        this.paperBotScheduledCloseAt,
        new Map(),
        noonCandlesByInstrumentId,
      );
    }
  }

  private async collectWarmup(): Promise<Candle[]> {
    const market = this.sessions.getMarket();
    const now = this.clock();
    const intraday = await this.candles.collectRange(
      this.allInstruments(),
      {
        startTime: new Date(market.startTime.getTime() - 21 * 86_400_000),
        endTime: now,
      },
      ["OneMinute", "FiveMinutes"],
    );
    const daily = await this.candles.collectRange(
      this.allInstruments(),
      {
        startTime: new Date(market.startTime.getTime() - 90 * 86_400_000),
        endTime: now,
      },
      ["OneDay"],
    );
    return [...intraday, ...daily];
  }

  /**
   * Fetches a complete warm-up before replacing the scanner session. A provider
   * failure therefore leaves the previous in-memory engine intact, marks it out
   * of sync, and arms runCycle's existing recovery path for the next attempt.
   */
  private async synchronizeFeatureEngine(): Promise<void> {
    this.scannerRecovery.beginWarmup(this.clock().getTime());
    if (!this.featureEngine) {
      const warmup = await this.collectWarmup();
      if (warmup.length > 0) this.lastCandleAt = this.clock().toISOString();
      return;
    }
    this.featureEngineReady = false;
    try {
      const warmup = await this.collectWarmup();
      await this.initializeFeatureEngine();
      await this.ingestFeatureCandles(warmup);
      this.featureEngineReady = true;
      if (warmup.length > 0) this.lastCandleAt = this.clock().toISOString();
    } catch (error) {
      this.featureEngineReady = false;
      throw error;
    }
  }

  private async initializeFeatureEngine(): Promise<void> {
    if (!this.featureEngine) return;
    try {
      await this.featureEngine.startSession(
        this.sessions.getMarket(),
        this.instruments,
        this.sessions.getPolicy(),
        this.benchmarkSnapshot,
        this.benchmarkMaxStalenessSeconds,
        this.sessions.getSnapshot().marketId,
      );
      this.engineSessionStart = this.sessions.getMarket().startTime.getTime();
    } catch (error) {
      this.featureEngineReady = false;
      throw error;
    }
  }

  private async ingestFeatureCandles(candles: Candle[]): Promise<void> {
    this.rememberFeatureCandles(candles);
    if (!this.featureEngine) return;
    try {
      await this.featureEngine.ingestCandles(
        candles,
        this.allInstruments(),
        this.sessions.getSnapshot().marketId,
      );
    } catch (error) {
      this.featureEngineReady = false;
      throw error;
    }
  }

  private rememberFeatureCandles(candles: Candle[]): void {
    for (const candle of candles) {
      if (candle.interval !== "FiveMinutes") continue;
      let values = this.fiveMinuteCandles.get(candle.symbolId);
      if (!values) {
        values = new Map();
        this.fiveMinuteCandles.set(candle.symbolId, values);
      }
      values.set(candle.start.toISOString(), candle);
      if (values.size > 160) values.delete(values.keys().next().value!);
    }
  }

  private async updateFeatures(
    quotes: Quote[],
    instruments = this.allInstruments(),
    paperInstruments = instruments,
  ): Promise<void> {
    if (!this.featureEngine || !this.featureStore) return;
    try {
      const engineStarted = performance.now();
      const scannerIds = new Set(
        instruments.map((instrument) => instrument.symbolId),
      );
      const result = await this.featureEngine.ingestQuotes(
        quotes.filter((quote) => scannerIds.has(quote.symbolId)),
        instruments,
        this.sessions.getSnapshot().marketId,
      );
      this.lastEngineDurationMs =
        Math.round((performance.now() - engineStarted) * 100) / 100;
      this.lastFeatureDurationMs = result.timings.featureMs;
      this.lastEvaluationDurationMs = result.timings.evaluationMs;
      this.lastEvaluationAt = this.clock().getTime();
      const generatedAlerts = createAlerts(
        result.events,
        this.alertBuffer.list(),
        this.alertPolicy,
      );
      await this.featureStore.saveFeatureSnapshots(result.snapshots);
      if (this.strategyStore) {
        await this.strategyStore.saveStrategyResults(
          result.evaluations,
          result.events,
          result.contexts,
        );
        this.evaluationsWrittenTotal += result.evaluations.length;
      }
      const alerts = this.alertStore
        ? await this.alertStore.saveAlerts(generatedAlerts)
        : generatedAlerts;
      for (const snapshot of result.snapshots)
        this.latestFeatures.set(snapshot.symbol, snapshot);
      for (const value of result.evaluations)
        this.latestStrategies.set(`${value.symbol}:${value.profileId}`, value);
      for (const value of result.contexts)
        this.latestContexts.set(`${value.symbol}:${value.profileId}`, value);
      this.benchmarkReadiness = result.benchmarkReadiness;
      this.stateEvents.push(...result.events);
      if (this.stateEvents.length > MAX_RETAINED_STATE_EVENTS)
        this.stateEvents.splice(
          0,
          this.stateEvents.length - MAX_RETAINED_STATE_EVENTS,
        );
      if (alerts.length > 0) {
        this.alertBuffer.record(alerts);
        for (const alert of alerts)
          this.logger.info({
            event: "SCANNER_ALERT_CREATED",
            alertType: alert.type,
            symbol: alert.symbol,
            strategy: alert.strategy,
            score: alert.score,
          });
      }
    } catch (error) {
      this.featureEngineReady = false;
      throw error;
    }
    // Isolated from the try/catch above: a paper-bot failure must be observable but must never
    // mark the feature engine unready or suppress the scanner results/alerts already persisted
    // this cycle (private development record, Phase 3 durability requirements).
    if (this.paperBotProcessor) {
      try {
        await this.processPaperBot(quotes, paperInstruments);
      } catch (error) {
        this.paperBotLastError =
          error instanceof Error ? error.message : "Unknown paper-bot error";
        this.logger.error({
          event: "PAPER_BOT_CYCLE_FAILED",
          error: this.paperBotLastError,
        });
      }
    }
  }

  private async processPaperBot(
    quotes: Quote[],
    instruments: PersistedInstrument[],
  ): Promise<void> {
    if (!this.paperBotProcessor || !this.strategyStore) return;
    const started = performance.now();
    const quotesByInstrumentId = this.quotesByInstrumentId(quotes, instruments);
    // Reconciliation reads the event and its source signal only after both are
    // durable, and joins the decision-time quote already persisted by this
    // cycle. This avoids inserting an immutable observation with missing
    // source-signal provenance.
    const reconciliation = await this.paperBotProcessor.reconcileReadyEvents();
    this.paperBotReconciliationBacklog = reconciliation.candidates;
    this.paperBotUnreconcilableCount = reconciliation.skipped.length;
    for (const skipped of reconciliation.skipped) {
      this.logger.error({
        event: "PAPER_BOT_EVENT_UNRECONCILABLE",
        sourceEventId: skipped.sourceEventId,
        reason: skipped.reason,
      });
    }
    await this.paperBotProcessor.evaluateOpenQuoteExecutions(
      quotesByInstrumentId,
      this.paperBotScheduledCloseAt ?? null,
    );
    await this.paperBotProcessor.evaluateOpenCoordinatedPositions(
      quotesByInstrumentId,
      this.paperBotScheduledCloseAt ?? null,
    );
    this.paperBotProcessingMs =
      Math.round((performance.now() - started) * 100) / 100;
    this.paperBotLastError = undefined;
    this.paperLastSuccessAt = this.clock().toISOString();
    if (this.paperBotExecutionStore && this.paperBotRunId) {
      this.paperBotHealth = await this.paperBotExecutionStore.runHealth(
        this.paperBotRunId,
      );
    }
    await this.refreshCoordinationHealth();
    this.scheduleFundedPaperBot(
      quotesByInstrumentId,
      reconciliation.eligibleObservations,
    );
  }

  private scheduleFundedPaperBot(
    quotes: ReadonlyMap<string, QuoteFact>,
    observations: readonly import("../paper-bot/paper-bot-repository.js").PaperSignalObservation[],
  ): void {
    if (!this.paperFundedAdapter) return;
    if (this.paperFundedWork) {
      this.paperFundedCyclePending = true;
      return;
    }
    this.paperFundedCyclePending = false;
    // Quotes and observations are durable before scheduling. Skipped ticks are
    // recovered from retained inputs; never queue stale in-memory cycles.
    this.paperFundedWork = this.processFundedPaperBot(quotes, observations)
      .then((succeeded) => {
        if (succeeded) {
          this.paperFundedLastError = undefined;
          this.fundedLastSuccessAt = this.clock().toISOString();
          this.scheduleFundedDrainCatchUp();
        }
      })
      .catch((error: unknown) => {
        this.paperFundedLastError =
          error instanceof Error
            ? error.message
            : "Unknown funded worker error";
        this.logger.error({
          event: "FUNDED_PAPER_BOT_CYCLE_FAILED",
          error: this.paperFundedLastError,
        });
      })
      .finally(() => {
        this.paperFundedWork = undefined;
      });
  }

  /**
   * Bounded catch-up between quote cycles: while the account has unacknowledged
   * facts, reuse the live funded batch budget (100 facts / 1,000 ms) without
   * re-running the cycle's observation/quote/projection work. Each pass is the
   * same drain with the same per-run advisory lock, oldest-first ordering,
   * effects-before-acknowledgement protocol and per-fact yielding; passes run
   * one at a time through the existing funded-work guard and only chain after
   * measurable progress, so the event loop stays responsive and nothing else
   * changes.
   */
  private scheduleFundedDrainCatchUp(): void {
    setImmediate(() => {
      if (!this.paperFundedAdapter || this.paperFundedWork) return;
      if (this.paperFundedCyclePending) return;
      if ((this.paperFundedOperational?.pendingFacts ?? 0) <= 0) return;
      this.paperFundedWork = this.drainFundedBacklog()
        .catch((error: unknown) => {
          this.paperFundedAdapter?.recordRecoveryFailure();
          this.paperFundedLastError =
            error instanceof Error
              ? error.message
              : "Unknown funded drain error";
          this.logger.error({
            event: "FUNDED_PAPER_BOT_DRAIN_FAILED",
            error: this.paperFundedLastError,
          });
        })
        .finally(() => {
          this.paperFundedWork = undefined;
        });
    });
  }

  /**
   * Live funded drain budget. The documented healthy pass is 100 facts /
   * 1,000 ms. A durable backlog extends the bounded pass by one second per
   * 1,000 unacknowledged facts, and a sustained five-minute arrival-minus-drain
   * deficit adds one further second so an account that is falling behind
   * recovers even before its queue crosses a whole second (up to ten seconds).
   * Fact ordering, per-fact transactions, the per-run advisory lock and
   * per-fact event-loop yielding are unchanged; only the bounded pass length
   * grows. The extension is derived from the last durable operational
   * snapshot, never from a caller-supplied number.
   */
  private fundedDrainBudget(): { maxFacts: number; maxDurationMs: number } {
    const pending = Math.max(0, this.paperFundedOperational?.pendingFacts ?? 0);
    const deficit =
      (this.paperFundedOperational?.arrivalMinusDrainPerMinute ?? 0) > 0
        ? 1
        : 0;
    const passes = Math.min(
      10,
      Math.max(1, Math.ceil(pending / 1_000) + deficit),
    );
    return { maxFacts: 100 * passes, maxDurationMs: 1_000 * passes };
  }

  private async drainFundedBacklog(): Promise<void> {
    if (!this.paperFundedAdapter) return;
    const cycleAt = this.clock().toISOString();
    const budget = this.fundedDrainBudget();
    let processed = 0;
    // Recovery adapters are inserted in the oldest-run order returned by
    // processFundedRecoveryRuns. Drain their already-enqueued facts first: an
    // older unresolved run can intentionally prevent the current run from
    // binding to the shared account, and must not remain cadence-bound while
    // that gate is active.
    for (const adapter of this.paperFundedRecoveryAdapters.values()) {
      processed = await adapter.drainEnqueued(budget);
      if (processed > 0) break;
    }
    if (processed === 0 && this.paperFundedBound)
      processed = await this.paperFundedAdapter.drainEnqueued(budget);
    if (processed === 0) return;
    this.paperFundedOperational =
      await this.paperFundedAdapter.operationalSnapshot(cycleAt);
    this.fundedLastSuccessAt = this.clock().toISOString();
    if (
      !this.paperFundedCyclePending &&
      (this.paperFundedOperational.pendingFacts ?? 0) > 0
    )
      this.scheduleFundedDrainCatchUp();
  }

  /**
   * Feeds the opt-in funded simulator from the same durable observations and
   * persisted quote batch as the legacy evidence processor. Failures are
   * isolated so funded recovery cannot suppress independent/shadow evidence.
   */
  private async processFundedPaperBot(
    quotesByInstrumentId: ReadonlyMap<string, QuoteFact>,
    fallbackObservations: readonly import("../paper-bot/paper-bot-repository.js").PaperSignalObservation[],
  ): Promise<boolean> {
    if (!this.paperFundedAdapter || !this.paperBotRunId || !this.paperBotStore)
      return true;
    try {
      const cycleAt = this.clock().toISOString();
      await this.processFundedRecoveryRuns(quotesByInstrumentId, cycleAt);
      if (!this.paperFundedBound && this.paperFundedConfig) {
        const market = this.sessions.getMarket();
        await this.paperFundedAdapter.bind(
          this.paperBotSessionDate ?? "",
          market.startTime.toISOString(),
          this.paperFundedConfig.initialCash,
          this.paperFundedConfig.dailyLossLimit,
        );
        this.paperFundedBound = true;
      }
      if (!this.paperFundedBound) {
        // Recovery may keep the new run unbound while an older run drains. The
        // account-wide snapshot is still publishable and must include that
        // older run before binding succeeds; it is taken here, only on the
        // path that returns without running a cycle.
        this.paperFundedOperational =
          await this.paperFundedAdapter.operationalSnapshot(cycleAt);
        return true;
      }
      const observations =
        (await this.paperBotStore.findEligibleObservationsForFunding?.(
          this.paperBotRunId,
        )) ?? fallbackObservations;
      const invalidations: FundedInvalidation[] =
        (await this.paperBotStore.findFundedInvalidations?.(
          this.paperBotRunId,
        )) ?? [];
      const retainedQuotes = await this.paperFundedAdapter.retainedQuotes(
        [
          ...new Set([
            ...this.instruments.map((instrument) => instrument.id),
            ...quotesByInstrumentId.keys(),
          ]),
        ],
        cycleAt,
      );
      const quotes = new Map<string, QuoteFact & { instrumentId: string }>();
      for (const quote of retainedQuotes)
        quotes.set(`${quote.instrumentId}|${quote.timestamp}`, quote);
      for (const [instrumentId, quote] of quotesByInstrumentId)
        quotes.set(`${instrumentId}|${quote.timestamp}`, {
          instrumentId,
          ...quote,
        });
      const result = await this.paperFundedAdapter.process(
        {
          at: cycleAt,
          sessionDate: this.paperBotSessionDate ?? "",
          scheduledCloseAt: this.paperBotScheduledCloseAt ?? "",
          expectedInstrumentIds: this.instruments.map(
            (instrument) => instrument.id,
          ),
          observations: observations.filter(
            (row) => Date.parse(row.signalTimestamp) <= Date.parse(cycleAt),
          ),
          invalidations: invalidations.filter(
            (row) => Date.parse(row.at) <= Date.parse(cycleAt),
          ),
          quotes: [...quotes.values()],
        },
        this.fundedDrainBudget(),
      );
      this.paperFundedOperational =
        await this.paperFundedAdapter.operationalSnapshot(cycleAt);
      if (result.skippedQuotes > 0) {
        this.logger.info({
          event: "FUNDED_PAPER_QUOTE_SKIPPED",
          runId: this.paperBotRunId,
          count: result.skippedQuotes,
        });
      }
      if (result.coverageGaps > 0) {
        this.logger.info({
          event: "FUNDED_PAPER_INPUT_COVERAGE_GAP",
          runId: this.paperBotRunId,
          count: result.coverageGaps,
        });
      }
      return true;
    } catch (error) {
      const recoveryFailuresTotal =
        this.paperFundedAdapter.recordRecoveryFailure();
      // Keep the failure visible even when the database query that normally
      // refreshes the funded snapshot is the operation that failed.
      let previous = this.paperFundedOperational;
      if (!previous) {
        try {
          previous = await this.paperFundedAdapter.operationalSnapshot(
            this.clock().toISOString(),
          );
        } catch {
          // Preserve the failure counter even when the database itself is
          // unavailable; a later successful cycle refreshes durable gauges.
        }
      }
      this.paperFundedOperational = {
        closePendingOrders: previous?.closePendingOrders ?? 0,
        oldestClosePendingAgeMs: previous?.oldestClosePendingAgeMs ?? null,
        riskVetoesTotal: previous?.riskVetoesTotal ?? 0,
        coverageGapsTotal: previous?.coverageGapsTotal ?? 0,
        recoveryFailuresTotal,
        lastCycleLatencyMs: previous?.lastCycleLatencyMs ?? null,
        pendingFacts: previous?.pendingFacts,
        oldestPendingFactAgeMs: previous?.oldestPendingFactAgeMs,
        evidenceCaptureFailuresTotal: previous?.evidenceCaptureFailuresTotal,
        evidenceProjectionFailuresTotal:
          previous?.evidenceProjectionFailuresTotal,
        evidenceDecisionGapsTotal: previous?.evidenceDecisionGapsTotal,
        evidenceOutcomeGapsTotal: previous?.evidenceOutcomeGapsTotal,
        factsArrivedPerMinute: previous?.factsArrivedPerMinute,
        factsDrainedPerMinute: previous?.factsDrainedPerMinute,
        arrivalMinusDrainPerMinute: previous?.arrivalMinusDrainPerMinute,
        reconstructionDurationMs: previous?.reconstructionDurationMs,
        reconstructionDurationMaxMs: previous?.reconstructionDurationMaxMs,
        reconstructionReplayedEvents: previous?.reconstructionReplayedEvents,
        reconstructionPages: previous?.reconstructionPages,
        reconstructionCheckpointAgeMs: previous?.reconstructionCheckpointAgeMs,
        reconstructionLastObservedTimestampSeconds:
          previous?.reconstructionLastObservedTimestampSeconds,
        reconstructionCountTotal: previous?.reconstructionCountTotal,
        reconstructionFullReplaysTotal:
          previous?.reconstructionFullReplaysTotal,
        reconstructionBudgetFailuresTotal:
          previous?.reconstructionBudgetFailuresTotal,
      };
      this.paperFundedLastError =
        error instanceof Error
          ? error.message
          : "Unknown funded paper-bot error";
      this.logger.error({
        event: "FUNDED_PAPER_BOT_CYCLE_FAILED",
        runId: this.paperBotRunId,
        error: this.paperFundedLastError,
      });
      return false;
    }
  }

  /**
   * Feed retained/current quotes to funded runs from earlier sessions before
   * attempting to bind the new session to the same account. Funded account
   * ownership is intentionally sequential, so this is the recovery path that
   * releases the account after a restart or a close-pending halt.
   */
  private async processFundedRecoveryRuns(
    quotesByInstrumentId: ReadonlyMap<string, QuoteFact>,
    through: string,
  ): Promise<void> {
    const config = this.paperFundedConfig;
    const paperBotStore = this.paperBotStore;
    if (!config || !this.paperBotRunId || !paperBotStore) return;
    const { rows } = await config.pool.query<{
      runId: string;
      marketId: "CA_TSX" | "US_EQUITIES";
      sessionDate: string | Date;
      scheduledCloseAt: string | Date;
      assumptions: AssumptionsSnapshot;
      policy: FundedPolicy;
      instrumentIds: string[];
    }>(
      `SELECT r.id AS "runId",r.market_id AS "marketId",r.session_date AS "sessionDate",
              r.scheduled_close_at AS "scheduledCloseAt",r.assumptions,b.policy,
              ARRAY(SELECT DISTINCT o.instrument_id FROM paper_entry_order o
                    WHERE o.run_id=r.id) AS "instrumentIds"
       FROM paper_funded_run b JOIN paper_bot_run r ON r.id=b.run_id
       WHERE b.account_id=$1 AND b.run_id<>$2
         AND (r.status IN ('RUNNING','CLOSE_PENDING') OR EXISTS (
           SELECT 1 FROM paper_entry_order o
           WHERE o.run_id=r.id AND (o.state->>'status'='PENDING'
             OR o.state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING'))
         ) OR EXISTS (SELECT 1 FROM paper_funded_fact f
           WHERE f.run_id=r.id AND f.outcome IS NULL))
       ORDER BY r.session_date,r.id`,
      [config.accountId, this.paperBotRunId],
    );
    const activeRecoveryRunIds = new Set(rows.map((row) => row.runId));
    for (const runId of this.paperFundedRecoveryAdapters.keys())
      if (!activeRecoveryRunIds.has(runId))
        this.paperFundedRecoveryAdapters.delete(runId);
    const currentQuotes = [...quotesByInstrumentId.entries()].map(
      ([instrumentId, quote]) => ({ instrumentId, ...quote }),
    );
    for (const row of rows) {
      let adapter = this.paperFundedRecoveryAdapters.get(row.runId);
      if (!adapter) {
        adapter = new FundedLiveAdapter({
          pool: config.pool,
          runId: row.runId,
          accountId: config.accountId,
          currency: config.currency,
          marketId: row.marketId,
          assumptions: row.assumptions,
          policy: row.policy,
        });
        this.paperFundedRecoveryAdapters.set(row.runId, adapter);
      }
      const retained = await adapter.retainedQuotes(
        [
          ...new Set([
            ...this.instruments.map((instrument) => instrument.id),
            ...row.instrumentIds,
          ]),
        ],
        through,
      );
      const quotes = new Map<string, QuoteFact & { instrumentId: string }>();
      for (const quote of retained)
        quotes.set(`${quote.instrumentId}|${quote.timestamp}`, quote);
      for (const quote of currentQuotes)
        quotes.set(`${quote.instrumentId}|${quote.timestamp}`, quote);
      const observations =
        (await paperBotStore.findEligibleObservationsForFunding?.(row.runId)) ??
        [];
      const invalidations: FundedInvalidation[] =
        (await paperBotStore.findFundedInvalidations?.(row.runId)) ?? [];
      await adapter.process(
        {
          at: through,
          sessionDate: new Date(row.sessionDate).toISOString().slice(0, 10),
          scheduledCloseAt: new Date(row.scheduledCloseAt).toISOString(),
          observations: observations.filter(
            (row) => Date.parse(row.signalTimestamp) <= Date.parse(through),
          ),
          invalidations: invalidations.filter(
            (row) => Date.parse(row.at) <= Date.parse(through),
          ),
          quotes: [...quotes.values()],
        },
        this.fundedDrainBudget(),
      );
      await paperBotStore.settleRunAfterCloseRequest(row.runId);
      const remaining = await config.pool.query(
        `SELECT 1
         WHERE EXISTS (
           SELECT 1 FROM paper_entry_order
           WHERE run_id=$1 AND (state->>'status'='PENDING'
             OR state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING'))
         ) OR EXISTS (
           SELECT 1 FROM paper_funded_fact
           WHERE run_id=$1 AND outcome IS NULL
         )`,
        [row.runId],
      );
      if (!remaining.rows.length)
        this.paperFundedRecoveryAdapters.delete(row.runId);
    }
  }

  private async refreshCoordinationHealth(): Promise<void> {
    if (!this.paperCoordinationStore?.portfolioHealth) return;
    this.paperCoordinationHealth =
      await this.paperCoordinationStore.portfolioHealth(
        this.sessions.getMarketId(),
      );
  }

  /**
   * Resolves live runs whose noon boundary has already passed but which are
   * still RUNNING or CLOSE_PENDING -- including runs from earlier sessions.
   *
   * The per-cycle processor is bound to the current session's run only, so
   * without this sweep two specified behaviours are lost: a run whose noon
   * passed while the process was down (or while the market was closed) would
   * stay RUNNING forever, and an execution left CLOSE_PENDING by a halt
   * would never get its "first later actionable bid", which
   * private development record requires to be honoured across restarts
   * and later sessions.
   *
   * Runs holding nothing unfinished settle to COMPLETED here. Runs still
   * holding genuinely unresolved liquidity stay CLOSE_PENDING and are
   * retried against every later quote batch. Prior-session CANDLE executions
   * are passed no live noon bar (that bar is historical and never reappears
   * in a live batch); they resolve only from the first persisted complete
   * bar at or after the boundary, and stay CLOSE_PENDING and reported as
   * unresolved when no real bar exists rather than closed at an invented
   * price.
   */
  private async settleOverduePaperBotRuns(
    quotesByInstrumentId: ReadonlyMap<string, QuoteFact>,
    skipCurrentRun: boolean,
  ): Promise<void> {
    if (
      !this.paperBotStore ||
      !this.paperBotExecutionStore ||
      !this.paperBotProfiles ||
      !this.paperBotAssumptions ||
      !this.paperBotExecutionModelVersion
    )
      return;
    this.paperBotLastSweepAt = this.clock().getTime();
    const currentMarketId = this.sessions.getMarketId();
    let runs: UnfinishedLiveRun[];
    try {
      runs = await this.paperBotStore.listUnfinishedLiveRuns(currentMarketId);
    } catch (error) {
      this.logger.error({
        event: "PAPER_BOT_UNFINISHED_RUN_SCAN_FAILED",
        error:
          error instanceof Error ? error.message : "Unknown paper-bot error",
      });
      return;
    }
    const now = this.clock().getTime();
    let overdue = 0;
    let abandoned = 0;
    for (const { run, laterSessions } of runs) {
      if (run.marketId && run.marketId !== currentMarketId) continue;
      // Skip the current run only on the open-market path, where the cycle's
      // own close stage has already handled it with this cycle's real quotes.
      // On the startup and closed-market paths nothing else will: the cycle
      // returns at `marketStatus !== "OPEN"` before reaching that stage, so
      // excluding the current run here is what would strand a run whose noon
      // passed while the market was shut.
      if (skipCurrentRun && run.id === this.paperBotRunId) continue;
      if (new Date(run.scheduledCloseAt).getTime() > now) continue;
      if (run.id !== this.paperBotRunId) overdue += 1;

      // Past the horizon independent evidence is no longer offered facts. It keeps
      // status CLOSE_PENDING, so it stays out of every closed-trade
      // statistic and is reported as unresolved.
      if (laterSessions > MAX_CLOSE_HORIZON_SESSIONS) {
        try {
          const count =
            await this.paperBotExecutionStore.abandonUnresolvedExecutions(
              run.id,
              `no actionable liquidity within ${MAX_CLOSE_HORIZON_SESSIONS} session(s) after the ${run.sessionDate} close`,
            );
          abandoned += count;
          if (count > 0) {
            this.logger.error({
              event: "PAPER_BOT_CLOSE_HORIZON_EXPIRED",
              runId: run.id,
              sessionDate: run.sessionDate,
              abandoned: count,
            });
          }
          await this.paperBotStore.settleRunAfterCloseRequest(run.id);
        } catch (error) {
          this.logger.error({
            event: "PAPER_BOT_ABANDON_FAILED",
            runId: run.id,
            error:
              error instanceof Error
                ? error.message
                : "Unknown paper-bot error",
          });
          continue;
        }
        // Independent evidence has a finite horizon; owned coordinated
        // positions must retain a recovery path and remain visibly unresolved
        // until real liquidity closes them. The query below excludes abandoned
        // independent executions.
        if (!this.paperCoordinationStore) continue;
      }

      const processor = new PaperBotLiveProcessor(
        {
          paperBotStore: this.paperBotStore,
          paperExecutionStore: this.paperBotExecutionStore,
          profiles: this.paperBotProfiles,
          // The run's own immutable snapshot, never the currently configured
          // one: an earlier cohort's slippage and fee define its economics,
          // and closing its executions under today's assumptions would mix
          // two economic semantics inside one immutable cohort.
          assumptions: run.assumptions,
          predictionSnapshots: this.paperPredictionSnapshots,
          coordinationStore: this.paperCoordinationStore,
          coordinationPolicy: this.paperCoordinationPolicy,
          coordinationSizing: this.paperCoordinationSizing,
        },
        run.id,
      );
      try {
        // A prior run that was interrupted between event persistence and
        // observation creation keeps its READY events forever unobserved once
        // its session window ages out of the current-run reconciliation. The
        // open-market cycle must not spend its budget on that repair, but the
        // startup and closed-market sweeps own it: observe the stranded events
        // first, then settle what real persisted quotes can close.
        if (!skipCurrentRun) {
          try {
            const reconciliation = await processor.reconcileReadyEvents();
            if (reconciliation.processed > 0) {
              this.logger.info({
                event: "PAPER_BOT_PRIOR_RUN_EVENTS_RECONCILED",
                runId: run.id,
                sessionDate: run.sessionDate,
                count: reconciliation.processed,
                skipped: reconciliation.skipped.length,
              });
            }
          } catch (error) {
            this.logger.error({
              event: "PAPER_BOT_PRIOR_RUN_RECONCILIATION_FAILED",
              runId: run.id,
              sessionDate: run.sessionDate,
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown paper-bot error",
            });
          }
        }
        await processor.requestSessionClose(
          run.scheduledCloseAt,
          quotesByInstrumentId,
          new Map(),
        );
      } catch (error) {
        this.logger.error({
          event: "PAPER_BOT_OVERDUE_RUN_CLOSE_FAILED",
          runId: run.id,
          sessionDate: run.sessionDate,
          error:
            error instanceof Error ? error.message : "Unknown paper-bot error",
        });
      }
    }
    this.paperBotOverdueRunCount = overdue;
    this.paperBotAbandonedThisSweep = abandoned;
    await this.refreshCoordinationHealth();

    // Only the startup and closed-market sweeps refresh the counts. The
    // open-market cycle already does it in `processPaperBot`, and without
    // this the operational snapshot would report nulls for every execution
    // count outside trading hours -- exactly when an operator is most likely
    // to be checking whether the previous session collected anything.
    if (!skipCurrentRun && this.paperBotRunId) {
      try {
        this.paperBotHealth = await this.paperBotExecutionStore.runHealth(
          this.paperBotRunId,
        );
      } catch (error) {
        this.logger.error({
          event: "PAPER_BOT_HEALTH_READ_FAILED",
          runId: this.paperBotRunId,
          error:
            error instanceof Error ? error.message : "Unknown paper-bot error",
        });
      }
    }
  }

  private async requestPaperBotSessionCloseIfDue(
    quotes: Quote[],
    instruments: PersistedInstrument[],
  ): Promise<void> {
    if (!this.paperBotProcessor || !this.paperBotScheduledCloseAt) return;
    if (
      this.clock().getTime() < new Date(this.paperBotScheduledCloseAt).getTime()
    )
      return;
    try {
      await this.paperBotProcessor.requestSessionClose(
        this.paperBotScheduledCloseAt,
        this.quotesByInstrumentId(quotes, instruments),
        new Map(),
      );
    } catch (error) {
      this.logger.error({
        event: "PAPER_BOT_SESSION_CLOSE_FAILED",
        error:
          error instanceof Error ? error.message : "Unknown paper-bot error",
      });
    }
  }

  private quotesByInstrumentId(
    quotes: Quote[],
    instruments: PersistedInstrument[],
  ): Map<string, QuoteFact> {
    const instrumentIdBySymbolId = new Map(
      instruments.map((instrument) => [instrument.symbolId, instrument.id]),
    );
    const quotesByInstrumentId = new Map<string, QuoteFact>();
    for (const quote of quotes) {
      const instrumentId = instrumentIdBySymbolId.get(quote.symbolId);
      if (!instrumentId) continue;
      quotesByInstrumentId.set(instrumentId, {
        timestamp: quote.receivedAt.toISOString(),
        bid: quote.bid,
        ask: quote.ask,
        bidSize: quote.bidSize,
        askSize: quote.askSize,
        ...normalizedQuoteSize(quote.sizeUnit, quote.sizeMultiplier),
        dataStatus: quote.dataStatus,
        actionable: quote.actionable,
      });
    }
    return quotesByInstrumentId;
  }

  private dueCandleIntervals(now: Date): ("OneMinute" | "FiveMinutes")[] {
    const oneMinuteBucket = Math.floor(now.getTime() / 60_000);
    const fiveMinuteBucket = Math.floor(now.getTime() / 300_000);
    const due: ("OneMinute" | "FiveMinutes")[] = [];
    if (this.lastOneMinuteBucket !== oneMinuteBucket) {
      due.push("OneMinute");
    }
    if (this.lastFiveMinuteBucket !== fiveMinuteBucket) {
      due.push("FiveMinutes");
    }
    return due;
  }

  private markCandleBuckets(
    now: Date,
    intervals: ("OneMinute" | "FiveMinutes")[] = ["OneMinute", "FiveMinutes"],
  ): void {
    if (intervals.includes("OneMinute"))
      this.lastOneMinuteBucket = Math.floor(now.getTime() / 60_000);
    if (intervals.includes("FiveMinutes"))
      this.lastFiveMinuteBucket = Math.floor(now.getTime() / 300_000);
  }

  private async refreshMarketIfDue(): Promise<void> {
    const bucket = Math.floor(this.clock().getTime() / 3_600_000);
    if (bucket !== this.lastMarketRefreshBucket) {
      await this.sessions.refresh();
      this.lastMarketRefreshBucket = bucket;
      await this.startOrResumePaperBotRun();
    }
    // A paused rollover remains pending even after this hour's market-hours
    // request succeeded. Retry its metadata and cache reset, not just candles.
    if (
      this.featureEngine &&
      this.engineSessionStart !== this.sessions.getMarket().startTime.getTime()
    ) {
      this.featureEngineReady = false;
      this.scannerRecovery.assertAvailable(this.clock().getTime());
      this.instruments = await this.metadata.enrich(true);
      this.benchmarkSnapshot = await this.resolveBenchmarks();
      this.fiveMinuteCandles.clear();
      this.latestFeatures.clear();
      this.latestStrategies.clear();
      this.latestContexts.clear();
      await this.synchronizeFeatureEngine();
      this.markCandleBuckets(this.clock());
      this.universeRefreshPending = false;
      this.logger.info({
        event: "MARKET_DATA_NEW_SESSION_WARMED",
        startTime: this.sessions.getMarket().startTime.toISOString(),
      });
    }
  }

  private updateQuoteStatus(quotes: Quote[]): void {
    if (quotes.length === 0) {
      this.dataStatus = "UNKNOWN";
      return;
    }
    this.lastQuoteAt = quotes.reduce(
      (latest, quote) =>
        quote.receivedAt.toISOString() > latest
          ? quote.receivedAt.toISOString()
          : latest,
      quotes[0]?.receivedAt.toISOString() ?? this.clock().toISOString(),
    );
    this.dataStatus = quotes.some((quote) => quote.isHalted)
      ? "HALTED"
      : quotes.some((quote) => quote.isDelayed)
        ? "DELAYED"
        : "REALTIME";
  }

  private fail(
    error: unknown,
    event: string,
    state: "DEGRADED" | "AUTH_REQUIRED" = "DEGRADED",
  ): void {
    const message =
      (!this.featureEngineReady &&
        this.scannerRecovery.pause(this.clock().getTime())?.message) ||
      (error instanceof Error ? error.message : "Unknown market-data error");
    if (
      error instanceof ScannerRecoveryPausedError &&
      this.state === state &&
      this.lastError === message
    )
      return;
    this.state = state;
    this.lastError = message;
    this.logger.error({ event, error: this.lastError, state });
  }

  private recordScannerRecoveryFailure(error: unknown): void {
    if (!this.featureEngineReady)
      this.scannerRecovery.failed(this.clock().getTime(), error);
  }

  private allInstruments(): PersistedInstrument[] {
    return [
      ...new Map(
        [...this.instruments, ...this.benchmarkSnapshot.instruments].map(
          (value) => [value.symbolId, value],
        ),
      ).values(),
    ];
  }

  private async quoteCollectionInstruments(): Promise<PersistedInstrument[]> {
    const recovery = this.paperBotStore
      ? await this.quotes.recoveryInstruments(this.sessions.getMarketId())
      : [];
    return [
      ...new Map(
        [...this.allInstruments(), ...recovery].map((instrument) => [
          instrument.symbolId,
          instrument,
        ]),
      ).values(),
    ];
  }

  private async resolveBenchmarks(): Promise<BenchmarkSnapshot> {
    return this.benchmarks
      ? this.benchmarks.resolve()
      : { references: [], instruments: [], warnings: [] };
  }
}
