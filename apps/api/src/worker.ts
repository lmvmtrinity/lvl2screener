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
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
await migrate(pool);

const backtestStore = new PostgresBacktestStore(pool);
const scannerClient = new ScannerFeatureClient(
  new URL(config.SCANNER_URL),
  10_000,
  config.SCANNER_SERVICE_TOKEN,
);
const researchRuntimeIdentityProvider =
  createResearchRuntimeIdentityProvider(scannerClient);
const challengerObservationWorker = new ChallengerObservationWorker(
  new PostgresChallengerAttemptStore(pool),
  new ScannerChallengerObservationEngine(scannerClient),
  undefined,
  new PostgresPaperExecutionStore(pool),
);
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
    // Completion-triggered drain: a settled job re-evaluates the market so
    // waiting capacity work starts immediately and completed parents
    // materialize their follow-on stages without waiting for the daily cycle.
    onJobSettled: async (job) => {
      for (const marketId of config.ENABLED_MARKETS) {
        try {
          await backtestAutomationService.runCycle(marketId, "JOB_COMPLETION");
        } catch (error) {
          logger.error({
            event: "BACKTEST_AUTOMATION_COMPLETION_DRAIN_FAILED",
            marketId,
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  },
);

worker.start();
logger.info({ event: "RESEARCH_WORKER_STARTED" });

const challengerObservationTimer = setInterval(() => {
  for (const marketId of config.ENABLED_MARKETS) {
    void challengerObservationWorker.runOnce(marketId).catch((error) =>
      logger.error({
        event: "CHALLENGER_OBSERVATION_WORKER_FAILED",
        marketId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}, config.RESEARCH_JOB_POLL_MS);
for (const marketId of config.ENABLED_MARKETS)
  void challengerObservationWorker.runOnce(marketId).catch((error) =>
    logger.error({
      event: "CHALLENGER_OBSERVATION_STARTUP_FAILED",
      marketId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

const datasetLineageReconciler = new ResearchDatasetLineageReconciler(pool);
const challengerCoverageAutomation = new ChallengerCoverageAutomation(
  pool,
  researchRuntimeIdentityProvider,
  replayPolicies,
);
let evidenceCatchUpRunning = false;
const evidenceCatchUp = async () => {
  if (evidenceCatchUpRunning) return;
  evidenceCatchUpRunning = true;
  try {
    for (const marketId of config.ENABLED_MARKETS) {
      try {
        const processed = await evidenceAutomationService.catchUp(marketId);
        if (processed > 0)
          logger.info({
            event: "EVIDENCE_AUTOMATION_CATCH_UP",
            marketId,
            processed,
          });
        try {
          const diagnostics =
            await executionDiagnosticAutomation.catchUp(marketId);
          if (diagnostics > 0)
            logger.info({
              event: "EXECUTION_DIAGNOSTICS_AUTOMATION_DISPATCHED",
              marketId,
              dispatched: diagnostics,
            });
        } catch (error) {
          logger.error({
            event: "EXECUTION_DIAGNOSTICS_AUTOMATION_FAILED",
            marketId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await datasetLineageReconciler.catchUp(marketId);
        } catch (error) {
          logger.error({
            event: "DATASET_LINEAGE_RECONCILIATION_FAILED",
            marketId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await challengerCoverageAutomation.runOnce(marketId);
        } catch (error) {
          logger.error({
            event: "CHALLENGER_COVERAGE_PREPARATION_FAILED",
            marketId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const dispatched = await studyDispatchService.dispatchReady(marketId);
        if (dispatched > 0)
          logger.info({
            event: "STRATEGY_STUDY_AUTOMATION_DISPATCHED",
            marketId,
            dispatched,
          });
      } catch (error) {
        logger.error({
          event: "EVIDENCE_AUTOMATION_CATCH_UP_FAILED",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    evidenceCatchUpRunning = false;
  }
};
void evidenceCatchUp();
const evidenceCatchUpTimer = setInterval(
  () => void evidenceCatchUp(),
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
const scheduleBacktestAutomation = () => {
  if (backtestAutomationStopped || !config.BACKTEST_AUTOMATION_ENABLED) return;
  const now = new Date();
  const next = nextEasternBoundary(now, "17:00");
  backtestAutomationTimer = setTimeout(() => {
    void backtestAutomationCatchUp().finally(scheduleBacktestAutomation);
  }, next.getTime() - now.getTime());
};
if (config.BACKTEST_AUTOMATION_ENABLED) {
  void backtestAutomationCatchUp().finally(scheduleBacktestAutomation);
}

const paperEvidenceScheduler = new PaperEvidenceTrainingScheduler(
  new PaperEvidenceTrainingService(
    new PostgresPaperEvidenceTrainingStore(pool),
    researchLineageService,
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
  void check().finally(scheduleNext);
}

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "RESEARCH_WORKER_SHUTDOWN_STARTED", signal });
  await worker.stop();
  clearInterval(challengerObservationTimer);
  clearInterval(evidenceCatchUpTimer);
  backtestAutomationStopped = true;
  if (backtestAutomationTimer) clearTimeout(backtestAutomationTimer);
  learningStopped = true;
  if (paperEvidenceTimer) clearTimeout(paperEvidenceTimer);
  await pool.end();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
