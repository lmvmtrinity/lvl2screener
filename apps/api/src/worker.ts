import { ResearchDatasetLineageReconciler } from "./statistical-models/research-dataset-lineage-reconciler.js";
import { ChallengerCoverageAutomation } from "./statistical-models/challenger-coverage-automation.js";
import { ResearchLineageService } from "./backtests/research-lineage-service.js";
import { createResearchRuntimeIdentityProvider } from "./backtests/research-runtime-identity.js";
import { createStudyAdmission } from "./backtests/study-admission.js";
import { PostgresPaperExecutionStore } from "./paper-bot/paper-execution-repository.js";
import {
  nextEasternBoundary,
  nextLearningCheck,
} from "./statistical-models/daily-learning-schedule.js";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  createCalibrationSchema,
  createRankingResearchSchema,
  createStatisticalModelSchema,
} from "@tsx-scanner/contracts";
import { loadConfig } from "./config.js";
import { migrate } from "./database/migrate.js";
import { PostgresBacktestStore } from "./backtests/backtest-repository.js";
import { BacktestAutomationService } from "./backtests/backtest-automation.js";
import { PostgresBacktestAutomationStore } from "./backtests/backtest-automation-repository.js";
import { standardBacktestAutomationStages } from "./backtests/backtest-automation-stages.js";
import { fundedReplayStage } from "./backtests/funded-replay-stage.js";
import { FundedHistoricalAutomationService } from "./paper-bot/funded-historical-automation.js";
import { runFundedHistoricalRange } from "./paper-bot/funded-historical-runner.js";
import { FundedComparisonRepository } from "./paper-bot/funded-comparison-repository.js";
import {
  FundedComparisonService,
  PostgresFundedComparisonEvidenceSource,
  createFundedComparisonReplayEvidenceSource,
} from "./paper-bot/funded-comparison-service.js";
import { runFundedPairedComparison } from "./paper-bot/funded-paired-runner.js";
import { FundedHistoricalReplayJobHandler } from "./worker/handlers/funded-historical-replay-job-handler.js";
import { FundedComparisonJobHandler } from "./worker/handlers/funded-comparison-job-handler.js";
import { PostgresCalibrationStore } from "./calibration/calibration-repository.js";
import { CalibrationService } from "./calibration/calibration-service.js";
import { PostgresRankingResearchStore } from "./ranking-research/ranking-research-repository.js";
import { RankingResearchService } from "./ranking-research/ranking-research-service.js";
import { PostgresStatisticalModelStore } from "./statistical-models/statistical-model-repository.js";
import { StatisticalModelService } from "./statistical-models/statistical-model-service.js";
import { PostgresPaperEvidenceTrainingStore } from "./statistical-models/paper-evidence-training-repository.js";
import { PostgresDatasetPreparationStore } from "./statistical-models/dataset-preparation-repository.js";
import { PaperEvidenceTrainingService } from "./statistical-models/paper-evidence-training-service.js";
import { PaperEvidenceTrainingScheduler } from "./statistical-models/paper-evidence-training-scheduler.js";
import { PostgresFundedExecutionTrainingStore } from "./statistical-models/funded-execution-training-repository.js";
import { FundedExecutionTrainingService } from "./statistical-models/funded-execution-training-service.js";
import { FundedExecutionTrainingScheduler } from "./statistical-models/funded-execution-training-scheduler.js";
import { fundedExecutionTrainingJobSchema } from "./statistical-models/funded-execution-training-service.js";
import { PostgresLearningAutomationStore } from "./statistical-models/learning-automation-repository.js";
import { PostgresProfileStore } from "./profiles/profile-repository.js";
import { ScannerFeatureClient } from "./market-data/scanner-client.js";
import { ResearchJobRepository } from "./research-jobs/research-job-repository.js";
import { BacktestJobHandler } from "./worker/handlers/backtest-job-handler.js";
import { SynchronousJobHandler } from "./worker/handlers/synchronous-job-handler.js";
import { CoverageVerificationJobHandler } from "./worker/handlers/coverage-verification-job-handler.js";
import { StrategyStudyJobHandler } from "./worker/handlers/strategy-study-job-handler.js";
import { SignalModelResearchJobHandler } from "./worker/handlers/signal-model-research-job-handler.js";
import { PostgresSignalModelResearchControlStore } from "./backtests/signal-model-research-control.js";
import { ExecutionDiagnosticsJobHandler } from "./worker/handlers/execution-diagnostics-job-handler.js";
import { ResearchCoverageService } from "./backtests/research-coverage-service.js";
import { PostgresCoverageRequestRepository } from "./backtests/coverage-request-repository.js";
import { PostgresResearchCoverageSource } from "./backtests/research-coverage-source.js";
import { PostgresResearchEvidenceStore } from "./backtests/research-evidence-repository.js";
import { PostgresStudyAuthorizationRepository } from "./backtests/study-authorization-repository.js";
import { PostgresChallengerAttemptStore } from "./statistical-models/challenger-attempt-repository.js";
import {
  ChallengerObservationWorker,
  ScannerChallengerObservationEngine,
} from "./statistical-models/challenger-observation-worker.js";
import { PostgresFundedShadowStore } from "./statistical-models/funded-shadow-repository.js";
import { FundedShadowObserver } from "./statistical-models/funded-shadow-observer.js";
import { FundedShadowObservationWorker } from "./statistical-models/funded-shadow-worker.js";
import {
  FundedExecutionPredictionService,
  PostgresFundedExecutionPredictionStore,
} from "./statistical-models/funded-execution-prediction.js";
import { StudyDispatchService } from "./backtests/study-dispatch-service.js";
import { EvidenceAutomationService } from "./statistical-models/evidence-automation-service.js";
import { PostgresEvidenceAutomationRepository } from "./statistical-models/evidence-automation-repository.js";
import { PostgresEvidenceAutomationReadRepository } from "./statistical-models/evidence-automation-read-repository.js";
import { ExecutionDiagnosticAutomation } from "./paper-bot/execution-diagnostic-automation.js";
import { FundedReportingService } from "./paper-bot/funded-reporting-service.js";
import {
  ResearchWorker,
  type ResearchWorkerLogger,
} from "./worker/research-worker.js";
import { BackgroundWorkTracker } from "./worker/background-work.js";
import { IdleBackoffGate } from "./worker/idle-backoff-gate.js";
import { regularSessionOpen } from "./worker/market-session-pause.js";
import { drainBacktestCompletionMarkets } from "./worker/backtest-completion-drain.js";

/** W8 worker process entrypoint. Runs independently of the API HTTP process (its own container in
 * docker-compose) so an API restart never interrupts a research job that is mid-lease here, and a
 * worker crash never takes the API down -- the two only share the Postgres pool and the scanner
 * service. Start with `node dist/worker.js`. */
function jsonLogger(level: string): ResearchWorkerLogger {
  const write = (severity: "info" | "error", fields: Record<string, unknown>) =>
    console[severity](
      JSON.stringify({
        service: "research-worker",
        level: severity,
        time: new Date().toISOString(),
        ...fields,
      }),
    );
  return {
    info: (fields) => {
      if (level !== "error" && level !== "silent") write("info", fields);
    },
    error: (fields) => write("error", fields),
  };
}

const config = loadConfig();
const logger = jsonLogger(config.LOG_LEVEL);
// Background passes started by the timers below are tracked so shutdown can
// stop accepting work and drain them before the pool closes. Without this,
// an in-flight pass queries the pool after `pool.end()` and logs
// "Cannot use a pool after calling end on the pool".
const backgroundWork = new BackgroundWorkTracker(logger);
let shuttingDown = false;
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
await migrate(pool);

const backtestStore = new PostgresBacktestStore(pool);
const scannerClient = new ScannerFeatureClient(
  new URL(config.SCANNER_URL),
  10_000,
  config.SCANNER_SERVICE_TOKEN,
  new URL(config.RESEARCH_SCANNER_URL ?? config.SCANNER_URL),
);
const researchRuntimeIdentityProvider =
  createResearchRuntimeIdentityProvider(scannerClient);
const challengerObservationWorker = new ChallengerObservationWorker(
  new PostgresChallengerAttemptStore(pool),
  new ScannerChallengerObservationEngine(scannerClient),
  undefined,
  new PostgresPaperExecutionStore(pool),
);
// FP04: authority-disabled prospective funded champion/challenger observation.
// The observer runs only behind the explicit default-false process gate, and
// even then no work occurs without a valid, non-revoked, market-scoped
// enrollment. It writes no order, reservation, ledger, policy or authority row.
const fundedShadowStore = new PostgresFundedShadowStore(pool);
const fundedShadowWorker = config.FUNDED_SHADOW_OBSERVATION_ENABLED
  ? new FundedShadowObservationWorker(
      pool,
      fundedShadowStore,
      new FundedShadowObserver({
        store: fundedShadowStore,
        pool,
        engine: scannerClient,
        predictions: new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        ),
      }),
    )
  : null;
const profileStore = new PostgresProfileStore(pool);
const replayPolicy = {
  marketId: "CA_TSX" as const,
  timezone: config.SESSION_TIMEZONE,
  openingRange: {
    start: config.OPENING_RANGE_START,
    end: config.OPENING_RANGE_END,
  },
  scanning: { start: config.SCANNING_START, end: config.SCANNING_END },
  entries: {
    preferredStart: config.ENTRY_PREFERRED_START,
    preferredEnd: config.ENTRY_PREFERRED_END,
    hardEnd: config.ENTRY_HARD_END,
  },
  benchmarkMaxStalenessSeconds: config.BENCHMARK_MAX_STALENESS_SECONDS,
} as const;
const replayPolicies = {
  CA_TSX: replayPolicy,
  US_EQUITIES: {
    ...replayPolicy,
    marketId: "US_EQUITIES" as const,
    timezone: config.US_SESSION_TIMEZONE,
  },
} as const;

const researchLineageService = new ResearchLineageService(
  pool,
  researchRuntimeIdentityProvider,
  replayPolicies,
);
const calibrationService = new CalibrationService(
  new PostgresCalibrationStore(pool),
  backtestStore,
  scannerClient,
  replayPolicies,
  researchLineageService,
);
const rankingResearchService = new RankingResearchService(
  new PostgresRankingResearchStore(pool),
  backtestStore,
);
const statisticalModelService = new StatisticalModelService(
  new PostgresStatisticalModelStore(pool),
  backtestStore,
  scannerClient,
  new PaperEvidenceTrainingService(
    new PostgresPaperEvidenceTrainingStore(pool),
    researchLineageService,
  ),
);
// FP02: funded-execution learning runs through its own store, service and
// scheduler. It shares only the scanner client and the durable research-job
// queue; training completion never changes a profile or funded policy.
const fundedExecutionTrainingService = new FundedExecutionTrainingService(
  new PostgresFundedExecutionTrainingStore(pool),
  scannerClient,
  researchRuntimeIdentityProvider,
);

const repository = new ResearchJobRepository(pool);
const fundedReportingService = new FundedReportingService(pool);
const fundedPolicyService = new FundedHistoricalAutomationService(pool);
const fundedComparisonRepository = new FundedComparisonRepository(pool);
const fundedComparisonService = new FundedComparisonService({
  pool,
  repository: fundedComparisonRepository,
  pairedRunner: (input, betweenSessions) =>
    runFundedPairedComparison(input, {
      pool,
      repository: fundedComparisonRepository,
      predictionEngine: scannerClient,
      reporting: fundedReportingService,
      evidenceSourceFor: (shared) =>
        createFundedComparisonReplayEvidenceSource(shared),
      betweenSessions,
    }),
  evidenceSource: new PostgresFundedComparisonEvidenceSource(
    pool,
    fundedComparisonRepository,
  ),
});
const backtestAutomationService = new BacktestAutomationService({
  store: new PostgresBacktestAutomationStore(pool),
  inputs: backtestStore,
  profiles: profileStore,
  jobs: repository,
  clock: () => new Date(),
  logger,
  economics: {
    minNetRewardRisk: config.PAPER_BOT_MIN_NET_REWARD_RISK,
    minStopFrictionMultiple: config.PAPER_BOT_MIN_STOP_FRICTION_MULTIPLE,
    minTargetFrictionMultiple: config.PAPER_BOT_MIN_TARGET_FRICTION_MULTIPLE,
    maxSpreadPct: config.PAPER_BOT_MAX_SPREAD_PCT,
  },
  stageDefinitions: standardBacktestAutomationStages({
    backtests: backtestStore,
    profiles: profileStore,
    fundedReplay: fundedReplayStage({
      policies: fundedPolicyService,
      runs: backtestStore,
    }),
  }),
});
for (const marketId of config.ENABLED_MARKETS)
  await backtestAutomationService.configureMarket({
    marketId,
    enabled: config.BACKTEST_AUTOMATION_ENABLED,
    cadence: "DAILY_POST_SESSION",
    maxOutstanding: config.BACKTEST_AUTOMATION_MAX_OUTSTANDING,
  });
let backtestCompletionDrainTimer: NodeJS.Timeout | undefined;
const scheduleBacktestCompletionDrain = () => {
  if (shuttingDown || backtestCompletionDrainTimer) return;
  backtestCompletionDrainTimer = setTimeout(() => {
    backtestCompletionDrainTimer = undefined;
    if (shuttingDown) return;
    void backgroundWork.run(
      "BACKTEST_AUTOMATION_COMPLETION_DRAIN_FAILED",
      "ALL",
      () =>
        drainBacktestCompletionMarkets(
          config.ENABLED_MARKETS,
          (marketId) =>
            backtestAutomationService.runCycle(marketId, "JOB_COMPLETION"),
          (fields) => logger.error(fields),
        ),
    );
  }, 30_000);
};
const evidenceAutomationService = new EvidenceAutomationService(
  new PostgresEvidenceAutomationRepository(pool),
  repository,
  () => new Date(),
  new PostgresEvidenceAutomationReadRepository(pool),
);
const executionDiagnosticEvidence = new PostgresEvidenceAutomationRepository(
  pool,
);
const executionDiagnosticAutomation = new ExecutionDiagnosticAutomation(
  pool,
  executionDiagnosticEvidence,
  repository,
);
const researchEvidenceStore = new PostgresResearchEvidenceStore(pool);
const coverageRequestRepository = new PostgresCoverageRequestRepository(pool);
const studyAuthorizationStore = new PostgresStudyAuthorizationRepository(pool);
const studyDispatchService = new StudyDispatchService(
  studyAuthorizationStore,
  researchEvidenceStore,
  undefined,
  createStudyAdmission(pool, researchRuntimeIdentityProvider),
);
const coverageService = new ResearchCoverageService(
  new PostgresResearchCoverageSource(pool),
  () => new Date(),
);
const worker = new ResearchWorker(
  repository,
  {
    BACKTEST: new BacktestJobHandler(
      backtestStore,
      scannerClient,
      replayPolicies,
      profileStore,
      researchLineageService,
    ),
    CALIBRATION: new SynchronousJobHandler(
      createCalibrationSchema,
      (input, jobId, attemptCount) =>
        calibrationService.create(input, jobId, attemptCount),
    ),
    RANKING_RESEARCH: new SynchronousJobHandler(
      createRankingResearchSchema,
      (input) => rankingResearchService.create(input),
    ),
    STATISTICAL_TRAINING: new SynchronousJobHandler(
      createStatisticalModelSchema,
      (input) => statisticalModelService.create(input),
    ),
    FUNDED_EXECUTION_TRAINING: new SynchronousJobHandler(
      fundedExecutionTrainingJobSchema,
      (input) => fundedExecutionTrainingService.train(input.datasetId),
    ),
    COVERAGE_VERIFICATION: new CoverageVerificationJobHandler(
      coverageService,
      researchEvidenceStore,
      repository,
      coverageRequestRepository,
      researchRuntimeIdentityProvider,
    ),
    STRATEGY_STUDY: new StrategyStudyJobHandler(
      pool,
      backtestStore,
      scannerClient,
      replayPolicies,
      researchEvidenceStore,
      researchRuntimeIdentityProvider,
    ),
    SIGNAL_MODEL_RESEARCH: new SignalModelResearchJobHandler(
      pool,
      scannerClient,
    ),
    EXECUTION_DIAGNOSTICS: new ExecutionDiagnosticsJobHandler(
      fundedReportingService,
    ),
    FUNDED_HISTORICAL_REPLAY: new FundedHistoricalReplayJobHandler(
      fundedPolicyService,
      backtestStore,
      (input, betweenSessions) =>
        runFundedHistoricalRange(input, {
          pool,
          config,
          engine: scannerClient,
          store: backtestStore,
          reporting: fundedReportingService,
          betweenSessions,
        }),
    ),
    FUNDED_COMPARISON: new FundedComparisonJobHandler(fundedComparisonService),
  },
  {
    ownerId: `${hostname()}:${process.pid}:${randomUUID()}`,
    leaseMs: config.RESEARCH_JOB_LEASE_MS,
    pollIntervalMs: config.RESEARCH_JOB_POLL_MS,
    logger,
    ...(config.RESEARCH_PAUSE_DURING_SESSION
      ? {
          claimsPaused: () =>
            regularSessionOpen(config.ENABLED_MARKETS, new Date()),
        }
      : {}),
    // Completion-triggered drain: a settled job re-evaluates the market so
    // waiting capacity work starts immediately and completed parents
    // materialize their follow-on stages without waiting for the daily cycle.
    onJobSettled: (job) => {
      if (
        job.jobType !== "BACKTEST" &&
        job.jobType !== "COVERAGE_VERIFICATION" &&
        job.jobType !== "FUNDED_HISTORICAL_REPLAY"
      )
        return;
      scheduleBacktestCompletionDrain();
    },
  },
);

worker.start();
logger.info({ event: "RESEARCH_WORKER_STARTED" });

// Only independently persisted EXECUTE_WHEN_READY grants are considered. This
// bounded source-readiness scan never promotes PREPARE_ONLY records and creates
// no authority; dispatch revalidates the exact frozen source before queueing.
const signalModelResearchControl = new PostgresSignalModelResearchControlStore(
  pool,
);
const checkSignalModelResearchReadiness = () =>
  backgroundWork.run(
    "SIGNAL_MODEL_RESEARCH_READINESS_CHECK_FAILED",
    "ALL",
    async () => {
      const dispatched =
        await signalModelResearchControl.dispatchAuthorizedReady(2);
      if (dispatched > 0)
        logger.info({
          event: "SIGNAL_MODEL_RESEARCH_AUTHORIZED_JOBS_DISPATCHED",
          count: dispatched,
        });
    },
  );
void checkSignalModelResearchReadiness();
const signalModelReadinessTimer = setInterval(
  () => void checkSignalModelResearchReadiness(),
  5 * 60_000,
);
signalModelReadinessTimer.unref?.();

// Challenger and funded shadow attempts carry prediction deadlines, so these
// observers poll every tick; an idle backoff could turn a new attempt into
// MISSED_DEADLINE. The workers' own market guards prevent overlapping passes.
const runChallengerObservation = (marketId: "CA_TSX" | "US_EQUITIES") =>
  challengerObservationWorker.runOnce(marketId);
const challengerObservationTimer = setInterval(() => {
  for (const marketId of config.ENABLED_MARKETS)
    void backgroundWork.run(
      "CHALLENGER_OBSERVATION_WORKER_FAILED",
      marketId,
      () => runChallengerObservation(marketId),
    );
}, config.RESEARCH_JOB_POLL_MS);
for (const marketId of config.ENABLED_MARKETS)
  void backgroundWork.run(
    "CHALLENGER_OBSERVATION_STARTUP_FAILED",
    marketId,
    () => runChallengerObservation(marketId),
  );

const runFundedShadowObservation = (marketId: "CA_TSX" | "US_EQUITIES") =>
  fundedShadowWorker!.runOnce(marketId);
const fundedShadowTimer = fundedShadowWorker
  ? setInterval(() => {
      for (const marketId of config.ENABLED_MARKETS)
        void backgroundWork.run(
          "FUNDED_SHADOW_OBSERVATION_FAILED",
          marketId,
          () => runFundedShadowObservation(marketId),
        );
    }, config.RESEARCH_JOB_POLL_MS)
  : null;
if (fundedShadowWorker)
  for (const marketId of config.ENABLED_MARKETS)
    void backgroundWork.run(
      "FUNDED_SHADOW_OBSERVATION_STARTUP_FAILED",
      marketId,
      () => runFundedShadowObservation(marketId),
    );

const datasetLineageReconciler = new ResearchDatasetLineageReconciler(pool);
const challengerCoverageAutomation = new ChallengerCoverageAutomation(
  pool,
  researchRuntimeIdentityProvider,
  replayPolicies,
);
let evidenceCatchUpRunning = false;
const evidenceCatchUpGate = new IdleBackoffGate();
const evidenceCatchUp = async () => {
  if (evidenceCatchUpRunning) return;
  evidenceCatchUpRunning = true;
  try {
    for (const marketId of config.ENABLED_MARKETS) {
      await evidenceCatchUpGate
        .run(marketId, async () => {
          let worked = false;
          let failed = false;
          try {
            const processed = await evidenceAutomationService.catchUp(marketId);
            worked ||= processed > 0;
            if (processed > 0)
              logger.info({
                event: "EVIDENCE_AUTOMATION_CATCH_UP",
                marketId,
                processed,
              });
            try {
              const diagnostics =
                await executionDiagnosticAutomation.catchUp(marketId);
              worked ||= diagnostics > 0;
              if (diagnostics > 0)
                logger.info({
                  event: "EXECUTION_DIAGNOSTICS_AUTOMATION_DISPATCHED",
                  marketId,
                  dispatched: diagnostics,
                });
            } catch (error) {
              failed = true;
              logger.error({
                event: "EXECUTION_DIAGNOSTICS_AUTOMATION_FAILED",
                marketId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            try {
              const reconciled =
                await datasetLineageReconciler.catchUp(marketId);
              worked ||= reconciled > 0;
            } catch (error) {
              failed = true;
              logger.error({
                event: "DATASET_LINEAGE_RECONCILIATION_FAILED",
                marketId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            try {
              const prepared =
                await challengerCoverageAutomation.runOnce(marketId);
              worked ||= prepared > 0;
            } catch (error) {
              failed = true;
              logger.error({
                event: "CHALLENGER_COVERAGE_PREPARATION_FAILED",
                marketId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            const dispatched =
              await studyDispatchService.dispatchReady(marketId);
            worked ||= dispatched > 0;
            if (dispatched > 0)
              logger.info({
                event: "STRATEGY_STUDY_AUTOMATION_DISPATCHED",
                marketId,
                dispatched,
              });
          } catch (error) {
            failed = true;
            logger.error({
              event: "EVIDENCE_AUTOMATION_CATCH_UP_FAILED",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (failed)
            throw new Error(`Evidence catch-up failed for ${marketId}`);
          return worked;
        })
        .catch((error) => {
          logger.error({
            event: "EVIDENCE_AUTOMATION_MARKET_BACKOFF",
            marketId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  } finally {
    evidenceCatchUpRunning = false;
  }
};
void backgroundWork.run(
  "EVIDENCE_AUTOMATION_CATCH_UP_FAILED",
  undefined,
  evidenceCatchUp,
);
const evidenceCatchUpTimer = setInterval(
  () =>
    void backgroundWork.run(
      "EVIDENCE_AUTOMATION_CATCH_UP_FAILED",
      undefined,
      evidenceCatchUp,
    ),
  config.RESEARCH_JOB_POLL_MS,
);

// A1: bounded startup catch-up plus a daily post-session cycle. The per-market
// outstanding cap bounds dispatches, so catch-up is a reconciliation pass and
// never an unbounded enqueue. Disabled control state performs no work.
let backtestAutomationTimer: NodeJS.Timeout | undefined;
let backtestAutomationStopped = false;
const backtestAutomationCatchUp = async () => {
  for (const marketId of config.ENABLED_MARKETS) {
    try {
      const cycle = await backtestAutomationService.runCycle(
        marketId,
        "SCHEDULED_CATCH_UP",
      );
      if (cycle.outcome !== "NO_CHANGES")
        logger.info({
          event: "BACKTEST_AUTOMATION_CATCH_UP",
          marketId,
          outcome: cycle.outcome,
          dispatched: cycle.dispatched,
          coalesced: cycle.coalesced,
          blocked: cycle.blocked,
        });
    } catch (error) {
      logger.error({
        event: "BACKTEST_AUTOMATION_CATCH_UP_FAILED",
        marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
const runBacktestAutomationCatchUp = () =>
  backgroundWork.run(
    "BACKTEST_AUTOMATION_CATCH_UP_FAILED",
    undefined,
    backtestAutomationCatchUp,
  );
const scheduleBacktestAutomation = () => {
  if (backtestAutomationStopped || !config.BACKTEST_AUTOMATION_ENABLED) return;
  const now = new Date();
  const next = nextEasternBoundary(now, "17:00");
  backtestAutomationTimer = setTimeout(() => {
    void runBacktestAutomationCatchUp().finally(scheduleBacktestAutomation);
  }, next.getTime() - now.getTime());
};
if (config.BACKTEST_AUTOMATION_ENABLED) {
  void runBacktestAutomationCatchUp().finally(scheduleBacktestAutomation);
}

const paperEvidenceScheduler = new PaperEvidenceTrainingScheduler(
  new PaperEvidenceTrainingService(
    new PostgresPaperEvidenceTrainingStore(pool),
    researchLineageService,
    new PostgresDatasetPreparationStore(pool),
  ),
  repository,
  undefined,
  new PostgresLearningAutomationStore(pool),
);
const fundedExecutionTrainingScheduler = new FundedExecutionTrainingScheduler(
  fundedExecutionTrainingService,
  repository,
);
let paperEvidenceTimer: NodeJS.Timeout | undefined;
let learningStopped = false;
if (config.PAPER_MODEL_TRAINING_ENABLED) {
  const check = async () => {
    try {
      const queued = await paperEvidenceScheduler.run();
      logger.info({ event: "PAPER_EVIDENCE_TRAINING_CHECK", queued });
    } catch (error) {
      logger.error({
        event: "PAPER_EVIDENCE_TRAINING_CHECK_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const funded = await fundedExecutionTrainingScheduler.run();
      if (funded.queued > 0 || funded.examined.length > 0)
        logger.info({
          event: "FUNDED_EXECUTION_TRAINING_CHECK",
          queued: funded.queued,
          examined: funded.examined,
        });
    } catch (error) {
      logger.error({
        event: "FUNDED_EXECUTION_TRAINING_CHECK_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const scheduleNext = () => {
    if (learningStopped) return;
    const now = new Date();
    const next = config.PAPER_MODEL_TRAINING_CHECK_MS
      ? new Date(now.getTime() + config.PAPER_MODEL_TRAINING_CHECK_MS)
      : nextLearningCheck(now);
    logger.info({
      event: "PAPER_EVIDENCE_TRAINING_SCHEDULED",
      nextCheckAt: next.toISOString(),
    });
    paperEvidenceTimer = setTimeout(() => {
      void check().finally(scheduleNext);
    }, next.getTime() - now.getTime());
  };
  // Startup catches evidence completed while the worker was unavailable.
  // Chain checks so a slow training qualification cannot overlap another check.
  void backgroundWork
    .run("PAPER_EVIDENCE_TRAINING_CHECK_FAILED", undefined, check)
    .finally(scheduleNext);
}

const shutdown = async (signal: string) => {
  if (shuttingDown) {
    logger.info({ event: "RESEARCH_WORKER_SHUTDOWN_IGNORED", signal });
    return;
  }
  shuttingDown = true;
  logger.info({ event: "RESEARCH_WORKER_SHUTDOWN_STARTED", signal });
  // Stop every producer first so no new pass can start while the pool closes,
  // then let the current job finish, then drain in-flight background passes.
  backgroundWork.close();
  if (backtestCompletionDrainTimer) clearTimeout(backtestCompletionDrainTimer);
  clearInterval(challengerObservationTimer);
  clearInterval(signalModelReadinessTimer);
  if (fundedShadowTimer) clearInterval(fundedShadowTimer);
  clearInterval(evidenceCatchUpTimer);
  backtestAutomationStopped = true;
  if (backtestAutomationTimer) clearTimeout(backtestAutomationTimer);
  learningStopped = true;
  if (paperEvidenceTimer) clearTimeout(paperEvidenceTimer);
  await worker.stop();
  await backgroundWork.drain();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
