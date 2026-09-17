import { createResearchRuntimeIdentityProvider } from "./backtests/research-runtime-identity.js";
import { ResearchLineageService } from "./backtests/research-lineage-service.js";
import { createStudyAdmission } from "./backtests/study-admission.js";
import { fundedPolicy } from "./paper-bot/funded-policy.js";
import { Pool } from "pg";
import { PostgresBacktestStore } from "./backtests/backtest-repository.js";
import { BacktestAutomationService } from "./backtests/backtest-automation.js";
import { PostgresBacktestAutomationStore } from "./backtests/backtest-automation-repository.js";
import { FundedHistoricalAutomationService } from "./paper-bot/funded-historical-automation.js";
import { AutomaticProfileBacktestScheduler } from "./backtests/profile-backtest-scheduler.js";
import { BacktestService } from "./backtests/backtest-service.js";
import { buildApp } from "./app.js";
import { PostgresAlertStore } from "./alerts/alert-repository.js";
import { loadConfig } from "./config.js";
import { migrate } from "./database/migrate.js";
import { reconcileOrphanedResearch } from "./database/reconcile-orphaned-research.js";
import { DatabaseProbe, ScannerProbe } from "./foundation/probes.js";
import { FoundationStatusService } from "./foundation/status-service.js";
import { loggerOptions } from "./logging.js";
import { PersistenceMetrics } from "./observability/persistence-metrics.js";
import { PostgresRetentionService } from "./observability/retention-repository.js";
import { QuestradeCandleService } from "./market-data/candle-service.js";
import { EncryptedPostgresRefreshTokenStore } from "./market-data/postgres-token-store.js";
import { PostgresFeatureSnapshotStore } from "./market-data/feature-repository.js";
import { QuestradeQuoteService } from "./market-data/quote-service.js";
import { PostgresMarketDataRepository } from "./market-data/repository.js";
import { PostgresStrategySignalStore } from "./market-data/strategy-repository.js";
import { PostgresRankingResearchStore } from "./ranking-research/ranking-research-repository.js";
import { RankingResearchService } from "./ranking-research/ranking-research-service.js";
import { PostgresStatisticalModelStore } from "./statistical-models/statistical-model-repository.js";
import { StatisticalModelService } from "./statistical-models/statistical-model-service.js";
import { PostgresPaperEvidenceTrainingStore } from "./statistical-models/paper-evidence-training-repository.js";
import { PaperEvidenceTrainingService } from "./statistical-models/paper-evidence-training-service.js";
import { PostgresPredictionSnapshotStore } from "./statistical-models/prediction-snapshot-repository.js";
import { StatisticalPredictionSnapshotService } from "./statistical-models/prediction-snapshot-service.js";
import { PostgresLearningAutomationStore } from "./statistical-models/learning-automation-repository.js";
import { LearningDashboardService } from "./statistical-models/learning-dashboard-service.js";
import { EvidenceAutomationService } from "./statistical-models/evidence-automation-service.js";
import { PostgresEvidenceAutomationRepository } from "./statistical-models/evidence-automation-repository.js";
import { PostgresEvidenceAutomationReadRepository } from "./statistical-models/evidence-automation-read-repository.js";
import { PostgresResearchEvidenceStore } from "./backtests/research-evidence-repository.js";
import { PostgresCoverageRequestRepository } from "./backtests/coverage-request-repository.js";
import { CoverageRequestService } from "./backtests/coverage-request-service.js";
import { PostgresStrategyStudyStore } from "./backtests/strategy-study-repository.js";
import { PostgresStudyAuthorizationRepository } from "./backtests/study-authorization-repository.js";
import { StrategyStudyApiService } from "./backtests/strategy-study-api-service.js";
import { PostgresCalibrationStore } from "./calibration/calibration-repository.js";
import { CalibrationService } from "./calibration/calibration-service.js";
import { PostgresPaperEvidenceStore } from "./paper-bot/paper-reporting-repository.js";
import { PaperReportingService } from "./paper-bot/paper-reporting-service.js";
import { FundedReportingService } from "./paper-bot/funded-reporting-service.js";
import { FundedHistoricalReadService } from "./paper-bot/funded-historical-read-service.js";
import { PostgresPaperBotStore } from "./paper-bot/paper-bot-repository.js";
import { PostgresChallengerExperimentStore } from "./statistical-models/challenger-experiment-repository.js";
import {
  PostgresChallengerExperimentApiService,
  PostgresChallengerReportingService,
} from "./statistical-models/challenger-reporting-service.js";
import { ChallengerExperimentService } from "./statistical-models/challenger-experiment-service.js";
import { PostgresPaperExecutionStore } from "./paper-bot/paper-execution-repository.js";
import { PostgresPaperCoordinationStore } from "./paper-bot/paper-coordination-repository.js";
import { ModelInformedPredictionResolver } from "./paper-bot/candidate-prediction-resolver.js";
import { costPolicyForMarket } from "./paper-bot/cost-policy.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "./backtests/execution-provenance.js";
import { PostgresProfileStore } from "./profiles/profile-repository.js";
import { ProfileService } from "./profiles/profile-service.js";
import { ResearchJobRepository } from "./research-jobs/research-job-repository.js";
import { ScannerFeatureClient } from "./market-data/scanner-client.js";
import { QuestradeDataService } from "./market-data/service.js";
import { ConfiguredBenchmarkService } from "./market-data/benchmark-service.js";
import { MarketSessionManager } from "./market-data/session-manager.js";
import { MarketRuntimeCoordinator } from "./market-data/runtime-coordinator.js";
import {
  AutomatedUniverseService,
  ConfiguredUsUniverseProvider,
  ConfiguredTsxUniverseProvider,
  DEFAULT_US_UNIVERSE_POLICY,
  MockUsUniverseProvider,
  MockTsxUniverseProvider,
} from "./universe/universe-service.js";
import { PostgresUniverseStore } from "./universe/universe-repository.js";
import { EodhdCatalogClient } from "./universe/eodhd-catalog.js";
import { MassiveCatalogClient } from "./universe/massive-catalog.js";
import {
  PostgresCatalogSnapshotStore,
  PostgresDiscoveryMappingStore,
} from "./universe/postgres-discovery-provider-store.js";
import { DiscoverySymbolMapper } from "./universe/discovery-mapping.js";
import { PostgresDiscoveryEvidenceStore } from "./universe/discovery-evidence-repository.js";
import { DiscoveryEvidenceCompactor } from "./universe/discovery-evidence-compactor.js";
import { PostgresDiscoveryControlStore } from "./universe/discovery-control-repository.js";
import {
  DiscoveryIntakeWorker,
  PostgresDiscoveryIntakeRepository,
} from "./universe/discovery-intake-repository.js";
import { DiscoveryScheduler } from "./universe/discovery-scheduler.js";
import { DiscoveryService } from "./universe/discovery-service.js";
import { TradingViewScannerClient } from "./universe/tradingview-scanner-client.js";
import { PostgresDiscoveryParityStore } from "./universe/postgres-discovery-parity-store.js";
import { TradingViewShadowComparator } from "./universe/tradingview-shadow-comparator.js";
import { FastFunnelAccelerator } from "./universe/fast-funnel-accelerator.js";
import { QuestradeDiscoveryInputSource } from "./universe/questrade-discovery-input-source.js";
import { QuestradeAdapter } from "./questrade/adapter.js";
import { MockQuestradeTransport } from "./questrade/mock-transport.js";
import { LiveQuestradeTransport } from "./questrade/live-transport.js";
import { QuestradeRateLimiter } from "./questrade/rate-limiter.js";
import { PostgresRequestBudget } from "./questrade/postgres-request-budget.js";
import {
  mockDevelopmentKey,
  parseMasterKey,
} from "./questrade/token-crypto.js";
import {
  QuestradeReauthorizationRequiredError,
  QuestradeTokenManager,
} from "./questrade/token-manager.js";
import type { QuestradeTransport, TokenTransport } from "./questrade/types.js";

const config = loadConfig();
// W7: max=5 matches the acceptance budget for a bounded pool queue at this workload (a single
// scan cycle now issues a small, fixed number of bulk statements per entity per cycle instead of
// one connection-holding round trip per row, so this pool never needs to be wide to keep up).
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
await migrate(pool);
const persistenceMetrics = new PersistenceMetrics();

const clock = () => new Date();
const tradingDateForSession = (session: MarketSessionManager): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone:
      session.getSnapshot().marketId === "CA_TSX"
        ? "America/Toronto"
        : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(session.getMarket().startTime);
const isLive = config.MARKET_DATA_MODE === "live";
const masterKey = isLive
  ? parseMasterKey(config.APP_MASTER_KEY!)
  : mockDevelopmentKey();
const tokenStore = new EncryptedPostgresRefreshTokenStore(
  pool,
  masterKey,
  isLive ? "questrade_live" : "questrade_mock",
);
await tokenStore.initialize(
  isLive ? config.QUESTRADE_REFRESH_TOKEN! : "mock-refresh-token-0",
);
const rateLimiter = new QuestradeRateLimiter(
  2,
  2,
  clock,
  isLive ? new PostgresRequestBudget(pool, "questrade_live") : undefined,
);
const transport: QuestradeTransport & TokenTransport = isLive
  ? new LiveQuestradeTransport(fetch, (headers, status) =>
      rateLimiter.observeHeaders(headers, status),
    )
  : new MockQuestradeTransport();
const tokenManager = new QuestradeTokenManager(
  transport,
  tokenStore,
  clock,
  30_000,
  rateLimiter,
);
const adapter = new QuestradeAdapter(
  tokenManager,
  transport,
  clock,
  isLive ? "QUESTRADE" : "QUESTRADE_MOCK",
  rateLimiter,
);
const repository = new PostgresMarketDataRepository(pool, persistenceMetrics);
const benchmarkService = new ConfiguredBenchmarkService(
  adapter,
  repository,
  config.MARKET_BENCHMARK_SYMBOL,
  config.SECTOR_BENCHMARK_SYMBOLS,
);
const discoveryIntakeRepository = new PostgresDiscoveryIntakeRepository(
  pool,
  clock,
);
const universeStore = new PostgresUniverseStore(
  pool,
  discoveryIntakeRepository,
);
const tsxSession = new MarketSessionManager(adapter, clock, "TSX", {
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
});
const metadata = new AutomatedUniverseService(
  isLive
    ? new ConfiguredTsxUniverseProvider(
        config.TSX_UNIVERSE_SYMBOLS,
        universeStore,
      )
    : new MockTsxUniverseProvider(),
  adapter,
  universeStore,
  {
    version: "tsx-liquid-momentum-v1",
    marketId: "CA_TSX",
    exchange: "TSX",
    currency: "CAD",
    allowedExchanges: ["TSX"],
    allowedCurrencies: ["CAD"],
    securityTypes: ["Stock", "Common Stock"],
    minimumPrice: config.UNIVERSE_MIN_PRICE,
    maximumPrice: config.UNIVERSE_MAX_PRICE,
    minimumMarketCap: config.UNIVERSE_MIN_MARKET_CAP,
    minimumAverageVolume90d: config.UNIVERSE_MIN_AVERAGE_VOLUME,
    minimumDollarVolume: config.UNIVERSE_MIN_DOLLAR_VOLUME,
    minimumAtrPct: config.UNIVERSE_MIN_ATR_PCT,
    minimumHistoryDays: 20,
  },
  config.UNIVERSE_MINIMUM_SIZE,
  clock,
);
const marketData = new QuestradeDataService(
  adapter,
  metadata,
  new QuestradeQuoteService(adapter, repository, config.QUOTE_BATCH_SIZE),
  new QuestradeCandleService(adapter, repository),
  tsxSession,
  clock,
  config.MARKET_DATA_POLL_MS,
  undefined,
  benchmarkService,
  config.BENCHMARK_MAX_STALENESS_SECONDS,
);
const usEnabled =
  config.ENABLED_MARKETS.includes("US_EQUITIES") &&
  config.US_MARKET_DATA_ENABLED;
const usSession = usEnabled
  ? new MarketSessionManager(
      adapter,
      clock,
      "US",
      {
        timezone: config.US_SESSION_TIMEZONE,
        openingRange: {
          start: config.OPENING_RANGE_START,
          end: config.OPENING_RANGE_END,
        },
        scanning: {
          start: config.SCANNING_START,
          end: config.SCANNING_END,
        },
        entries: {
          preferredStart: config.ENTRY_PREFERRED_START,
          preferredEnd: config.ENTRY_PREFERRED_END,
          hardEnd: config.ENTRY_HARD_END,
        },
      },
      "US_EQUITIES",
    )
  : undefined;
const usMarketData = usEnabled
  ? new QuestradeDataService(
      adapter,
      new AutomatedUniverseService(
        isLive
          ? new ConfiguredUsUniverseProvider(
              config.US_UNIVERSE_SYMBOLS,
              universeStore,
            )
          : new MockUsUniverseProvider(),
        adapter,
        universeStore,
        DEFAULT_US_UNIVERSE_POLICY,
        config.UNIVERSE_MINIMUM_SIZE,
        clock,
      ),
      new QuestradeQuoteService(adapter, repository, config.QUOTE_BATCH_SIZE),
      new QuestradeCandleService(adapter, repository),
      usSession!,
      clock,
      config.MARKET_DATA_POLL_MS,
      undefined,
      new ConfiguredBenchmarkService(
        adapter,
        repository,
        config.US_MARKET_BENCHMARK_SYMBOL,
        config.US_SECTOR_BENCHMARK_SYMBOLS,
        "US_EQUITIES",
      ),
      config.BENCHMARK_MAX_STALENESS_SECONDS,
    )
  : undefined;
const scannerClient = new ScannerFeatureClient(
  new URL(config.SCANNER_URL),
  10_000,
  config.SCANNER_SERVICE_TOKEN,
);

// WP4 discovery is API-owned and shares the live adapter's durable broker
// budget. Absence of the optional catalog credentials leaves the scheduler
// inspectable but unable to start provider work; OFF remains the database default.
// Provider selection is a composition decision: MASSIVE_API_KEY selects Massive
// for the US catalog, while CA_TSX keeps EODHD. A selected provider's request
// failures stay visible; there is no per-request fallback between providers.
const discoveryCatalogStore = new PostgresCatalogSnapshotStore(pool);
const discoveryControlStore = new PostgresDiscoveryControlStore(pool);
const discoveryEvidenceStore = new PostgresDiscoveryEvidenceStore(
  pool,
  clock,
  discoveryIntakeRepository,
);
const discoveryEodhdCatalogClient = config.EODHD_API_TOKEN
  ? new EodhdCatalogClient(
      config.EODHD_API_TOKEN,
      discoveryCatalogStore,
      fetch,
      clock,
    )
  : null;
const discoveryMassiveCatalogClient = config.MASSIVE_API_KEY
  ? new MassiveCatalogClient(
      config.MASSIVE_API_KEY,
      discoveryCatalogStore,
      fetch,
      clock,
    )
  : null;
const discoveryAdapter = adapter.forDiscovery();
const discoveryMappingStore = new PostgresDiscoveryMappingStore(pool);
const discoveryServices: Partial<
  Record<"CA_TSX" | "US_EQUITIES", DiscoveryService>
> = {};
const discoverySchedulers: DiscoveryScheduler[] = [];
const discoveryIntakeWorkers: DiscoveryIntakeWorker[] = [];
let discoveryStarted = false;
const discoveryLogger = {
  info: (fields: Record<string, unknown>) =>
    console.info(JSON.stringify(fields)),
  warn: (fields: Record<string, unknown>) =>
    console.warn(JSON.stringify(fields)),
  error: (fields: Record<string, unknown>) =>
    console.error(JSON.stringify(fields)),
};
const discoveryCompactor = new DiscoveryEvidenceCompactor(
  discoveryEvidenceStore,
  {
    enabled: config.DISCOVERY_COMPACTION_ENABLED,
    intervalMs: config.DISCOVERY_COMPACTION_INTERVAL_MS,
    inputDays: config.DISCOVERY_INPUT_RETENTION_DAYS,
    summaryDays: config.DISCOVERY_SUMMARY_RETENTION_DAYS,
    logger: discoveryLogger,
  },
);
const tvScannerClient = new TradingViewScannerClient({
  fetchFn: fetch,
  logger: discoveryLogger,
});
const discoveryParityStore = new PostgresDiscoveryParityStore(pool);

const tsxFastFunnel = new FastFunnelAccelerator({
  marketId: "CA_TSX",
  tvClient: tvScannerClient,
  enabled: config.DISCOVERY_FAST_FUNNEL_ENABLED,
  clock,
  logger: discoveryLogger,
});
const tsxShadowComparator = new TradingViewShadowComparator({
  marketId: "CA_TSX",
  tvClient: tvScannerClient,
  evidenceStore: discoveryEvidenceStore,
  parityStore: discoveryParityStore,
  clock,
  logger: discoveryLogger,
});
const tsxDiscoveryScheduler = new DiscoveryScheduler({
  marketId: "CA_TSX",
  catalogClient: discoveryEodhdCatalogClient,
  catalogStore: discoveryCatalogStore,
  controlStore: discoveryControlStore,
  evidenceStore: discoveryEvidenceStore,
  inputSource: new QuestradeDiscoveryInputSource(
    discoveryAdapter,
    new DiscoverySymbolMapper(discoveryAdapter, discoveryMappingStore, clock),
    "CA_TSX",
    tsxSession,
    clock,
  ),
  engine: scannerClient,
  session: tsxSession,
  brokerMetrics: rateLimiter,
  clock,
  leaseMs: config.DISCOVERY_LEASE_MS,
  pollIntervalMs: config.DISCOVERY_POLL_MS,
  workerConcurrency: config.DISCOVERY_WORKERS,
  logger: discoveryLogger,
  intakeEnabled: false,
  fastFunnelAccelerator: tsxFastFunnel,
  shadowComparator: tsxShadowComparator,
});
discoverySchedulers.push(tsxDiscoveryScheduler);
discoveryIntakeWorkers.push(
  new DiscoveryIntakeWorker({
    repository: discoveryIntakeRepository,
    marketId: "CA_TSX",
    enabled: false,
    tradingDate: () => tradingDateForSession(tsxSession),
    synchronize: (action) =>
      marketData.synchronizeDiscoveryCandidate(action.instrument),
    logger: discoveryLogger,
  }),
);
discoveryServices.CA_TSX = new DiscoveryService(
  tsxDiscoveryScheduler,
  discoveryControlStore,
  discoveryEvidenceStore,
  "CA_TSX",
  discoveryIntakeRepository,
  tsxShadowComparator,
  tsxFastFunnel,
  discoveryParityStore,
);
if (usSession) {
  const usFastFunnel = new FastFunnelAccelerator({
    marketId: "US_EQUITIES",
    tvClient: tvScannerClient,
    enabled: config.DISCOVERY_FAST_FUNNEL_ENABLED,
    clock,
    logger: discoveryLogger,
  });
  const usShadowComparator = new TradingViewShadowComparator({
    marketId: "US_EQUITIES",
    tvClient: tvScannerClient,
    evidenceStore: discoveryEvidenceStore,
    parityStore: discoveryParityStore,
    clock,
    logger: discoveryLogger,
  });
  const usDiscoveryScheduler = new DiscoveryScheduler({
    marketId: "US_EQUITIES",
    catalogClient: discoveryMassiveCatalogClient ?? discoveryEodhdCatalogClient,
    catalogStore: discoveryCatalogStore,
    controlStore: discoveryControlStore,
    evidenceStore: discoveryEvidenceStore,
    inputSource: new QuestradeDiscoveryInputSource(
      discoveryAdapter,
      new DiscoverySymbolMapper(discoveryAdapter, discoveryMappingStore, clock),
      "US_EQUITIES",
      usSession,
      clock,
    ),
    engine: scannerClient,
    session: usSession,
    brokerMetrics: rateLimiter,
    clock,
    leaseMs: config.DISCOVERY_LEASE_MS,
    pollIntervalMs: config.DISCOVERY_POLL_MS,
    workerConcurrency: config.DISCOVERY_WORKERS,
    logger: discoveryLogger,
    intakeEnabled: false,
    fastFunnelAccelerator: usFastFunnel,
    shadowComparator: usShadowComparator,
  });
  discoverySchedulers.push(usDiscoveryScheduler);
  discoveryIntakeWorkers.push(
    new DiscoveryIntakeWorker({
      repository: discoveryIntakeRepository,
      marketId: "US_EQUITIES",
      enabled: false,
      tradingDate: () => tradingDateForSession(usSession),
      synchronize: (action) =>
        usMarketData!.synchronizeDiscoveryCandidate(action.instrument),
      logger: discoveryLogger,
    }),
  );
  discoveryServices.US_EQUITIES = new DiscoveryService(
    usDiscoveryScheduler,
    discoveryControlStore,
    discoveryEvidenceStore,
    "US_EQUITIES",
    discoveryIntakeRepository,
    usShadowComparator,
    usFastFunnel,
    discoveryParityStore,
  );
}
const profileStore = new PostgresProfileStore(pool);
const backtestStore = new PostgresBacktestStore(pool);
const backtestAutomationStore = new PostgresBacktestAutomationStore(pool);
const backtestAutomationService = new BacktestAutomationService({
  store: backtestAutomationStore,
  inputs: backtestStore,
  profiles: profileStore,
  jobs: new ResearchJobRepository(pool),
  clock,
});
const fundedHistoricalPolicyService = new FundedHistoricalAutomationService(
  pool,
  clock,
);
for (const marketId of config.ENABLED_MARKETS)
  await backtestAutomationService.configureMarket({
    marketId,
    enabled: config.BACKTEST_AUTOMATION_ENABLED,
    cadence: "DAILY_POST_SESSION",
    maxOutstanding: config.BACKTEST_AUTOMATION_MAX_OUTSTANDING,
  });
const profileService = new ProfileService(
  profileStore,
  (profiles) => scannerClient.syncProfiles(profiles),
  new AutomaticProfileBacktestScheduler(backtestAutomationService),
);
await profileService.initialize();
marketData.setFeatureEngine(
  scannerClient,
  new PostgresFeatureSnapshotStore(pool, persistenceMetrics),
  new PostgresStrategySignalStore(pool, persistenceMetrics),
  new PostgresAlertStore(pool),
);
if (usMarketData) {
  usMarketData.setFeatureEngine(
    scannerClient,
    new PostgresFeatureSnapshotStore(pool, persistenceMetrics),
    new PostgresStrategySignalStore(pool, persistenceMetrics),
    new PostgresAlertStore(pool),
  );
}
const paperRiskByMarket = {
  CA_TSX: {
    riskBudget: config.PAPER_BOT_RISK_BUDGET_CAD,
    maxSymbolNotional: config.PAPER_COORDINATION_MAX_SYMBOL_NOTIONAL_CAD,
    maxSectorNotional: config.PAPER_COORDINATION_MAX_SECTOR_NOTIONAL_CAD,
    maxTotalOpenRisk: config.PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_CAD,
    maxDailyLoss: config.PAPER_COORDINATION_MAX_DAILY_LOSS_CAD,
  },
  US_EQUITIES: {
    riskBudget: config.PAPER_BOT_RISK_BUDGET_USD,
    maxSymbolNotional: config.PAPER_COORDINATION_MAX_SYMBOL_NOTIONAL_USD,
    maxSectorNotional: config.PAPER_COORDINATION_MAX_SECTOR_NOTIONAL_USD,
    maxTotalOpenRisk: config.PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_USD,
    maxDailyLoss: config.PAPER_COORDINATION_MAX_DAILY_LOSS_USD,
  },
} as const;
const tsxPaperRisk = paperRiskByMarket.CA_TSX;
const usPaperRisk = paperRiskByMarket.US_EQUITIES;

const paperAssumptions = {
  positionSize: tsxPaperRisk.maxSymbolNotional,
  slippageBps: config.PAPER_BOT_SLIPPAGE_BPS,
  feePerTrade: config.PAPER_BOT_FEE_PER_TRADE,
  costs: {
    ...costPolicyForMarket("CA_TSX"),
    exitCommission: config.PAPER_BOT_FEE_PER_TRADE,
    slippageBps: config.PAPER_BOT_SLIPPAGE_BPS,
  },
  riskBudget: tsxPaperRisk.riskBudget,
  maxNotional: tsxPaperRisk.maxSymbolNotional,
  economics: {
    minNetRewardRisk: config.PAPER_BOT_MIN_NET_REWARD_RISK,
    minStopFrictionMultiple: config.PAPER_BOT_MIN_STOP_FRICTION_MULTIPLE,
    minTargetFrictionMultiple: config.PAPER_BOT_MIN_TARGET_FRICTION_MULTIPLE,
    maxSpreadPct: config.PAPER_BOT_MAX_SPREAD_PCT,
  },
  stopMethod: "STRUCTURAL" as const,
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: config.SESSION_TIMEZONE,
  noonCloseTime: "16:00",
  evidenceScope: "FORWARD_LIVE",
};

const candidatePredictionResolver = new ModelInformedPredictionResolver(
  new PostgresStatisticalModelStore(pool),
  scannerClient,
  new PostgresPaperEvidenceTrainingStore(pool),
  paperAssumptions,
);
const challengerExperimentStore = new PostgresChallengerExperimentStore(pool);

marketData.setPaperBot(
  new PostgresPaperBotStore(pool, challengerExperimentStore),
  new PostgresPaperExecutionStore(pool),
  profileStore,
  paperAssumptions,
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  new StatisticalPredictionSnapshotService(
    new PostgresStatisticalModelStore(pool),
    scannerClient,
    new PostgresPredictionSnapshotStore(pool),
  ),
  new PostgresPaperCoordinationStore(pool),
  {
    cooldownMinutesAfterStop:
      config.PAPER_COORDINATION_COOLDOWN_MINUTES_AFTER_STOP,
    maxOpenPositions: config.PAPER_COORDINATION_MAX_OPEN_POSITIONS,
    maxTotalOpenRisk: tsxPaperRisk.maxTotalOpenRisk,
    maxDailyLoss: tsxPaperRisk.maxDailyLoss,
    dailyLossLimitType: config.PAPER_COORDINATION_DAILY_LOSS_LIMIT_TYPE,
    reserveRemainingDailyRisk:
      config.PAPER_COORDINATION_RESERVE_REMAINING_DAILY_RISK,
    maxConsecutiveStops: config.PAPER_COORDINATION_MAX_CONSECUTIVE_STOPS,
    maximumHoldingMinutes: config.PAPER_COORDINATION_MAX_HOLDING_MINUTES,
    maximumHoldingMinutesByStrategy:
      config.PAPER_COORDINATION_MAX_HOLDING_MINUTES_BY_STRATEGY,
    stalledBreakoutMinutes: config.PAPER_COORDINATION_STALLED_BREAKOUT_MINUTES,
    stalledBreakoutMinProgressR:
      config.PAPER_COORDINATION_STALLED_BREAKOUT_MIN_PROGRESS_R,
    maxSymbolNotional: tsxPaperRisk.maxSymbolNotional,
    maxSectorNotional: tsxPaperRisk.maxSectorNotional,
    requireFreshContext: config.PAPER_COORDINATION_REQUIRE_FRESH_CONTEXT,
    contextRequirement: config.PAPER_COORDINATION_CONTEXT_REQUIREMENT,
    contextMaxAgeSeconds: config.PAPER_COORDINATION_CONTEXT_MAX_AGE_SECONDS,
    vetoOnWeakContext: config.PAPER_COORDINATION_VETO_ON_WEAK_CONTEXT,
  },
  {
    maxDisplayedSizeParticipation:
      config.PAPER_COORDINATION_MAX_DISPLAYED_SIZE_PARTICIPATION,
  },
  candidatePredictionResolver,
  config.PAPER_FUNDED_CAD_ACCOUNT_ID
    ? {
        pool,
        accountId: config.PAPER_FUNDED_CAD_ACCOUNT_ID,
        currency: "CAD",
        initialCash: config.PAPER_FUNDED_INITIAL_CASH_CAD,
        dailyLossLimit: config.PAPER_FUNDED_DAILY_LOSS_LIMIT_CAD,
        policy: fundedPolicy(
          config.PAPER_COORDINATION_MAX_DISPLAYED_SIZE_PARTICIPATION,
          0,
          {
            maxOpenPositions: config.PAPER_COORDINATION_MAX_OPEN_POSITIONS,
            maxTotalOpenRisk: tsxPaperRisk.maxTotalOpenRisk,
            maxSymbolNotional: tsxPaperRisk.maxSymbolNotional,
            maxSectorNotional: tsxPaperRisk.maxSectorNotional,
            cooldownMinutesAfterStop:
              config.PAPER_COORDINATION_COOLDOWN_MINUTES_AFTER_STOP,
            maxConsecutiveStops:
              config.PAPER_COORDINATION_MAX_CONSECUTIVE_STOPS,
            requireFreshContext:
              config.PAPER_COORDINATION_REQUIRE_FRESH_CONTEXT,
            contextRequirement: config.PAPER_COORDINATION_CONTEXT_REQUIREMENT,
            contextMaxAgeSeconds:
              config.PAPER_COORDINATION_CONTEXT_MAX_AGE_SECONDS,
            vetoOnWeakContext: config.PAPER_COORDINATION_VETO_ON_WEAK_CONTEXT,
            maximumHoldingMinutes:
              config.PAPER_COORDINATION_MAX_HOLDING_MINUTES,
            maximumHoldingMinutesByStrategy:
              config.PAPER_COORDINATION_MAX_HOLDING_MINUTES_BY_STRATEGY,
            stalledBreakoutMinutes:
              config.PAPER_COORDINATION_STALLED_BREAKOUT_MINUTES,
            stalledBreakoutMinProgressR:
              config.PAPER_COORDINATION_STALLED_BREAKOUT_MIN_PROGRESS_R,
          },
        ),
      }
    : undefined,
);

if (usMarketData && config.US_PAPER_TRADING_ENABLED) {
  const usPaperAssumptions = {
    positionSize: usPaperRisk.maxSymbolNotional,
    slippageBps: config.PAPER_BOT_SLIPPAGE_BPS,
    feePerTrade: config.PAPER_BOT_FEE_PER_TRADE,
    costs: {
      ...costPolicyForMarket("US_EQUITIES"),
      exitCommission: config.PAPER_BOT_FEE_PER_TRADE,
      slippageBps: config.PAPER_BOT_SLIPPAGE_BPS,
    },
    riskBudget: usPaperRisk.riskBudget,
    maxNotional: usPaperRisk.maxSymbolNotional,
    economics: {
      minNetRewardRisk: config.PAPER_BOT_MIN_NET_REWARD_RISK,
      minStopFrictionMultiple: config.PAPER_BOT_MIN_STOP_FRICTION_MULTIPLE,
      minTargetFrictionMultiple: config.PAPER_BOT_MIN_TARGET_FRICTION_MULTIPLE,
      maxSpreadPct: config.PAPER_BOT_MAX_SPREAD_PCT,
    },
    stopMethod: "STRUCTURAL" as const,
    atrStopMultiple: 1,
    rewardRiskRatio: null,
    maxQuoteAgeSeconds: 30,
    sessionTimezone: config.US_SESSION_TIMEZONE,
    noonCloseTime: "16:00",
    evidenceScope: "FORWARD_LIVE",
  };

  const usCandidatePredictionResolver = new ModelInformedPredictionResolver(
    new PostgresStatisticalModelStore(pool),
    scannerClient,
    new PostgresPaperEvidenceTrainingStore(pool),
    usPaperAssumptions,
  );

  usMarketData.setPaperBot(
    new PostgresPaperBotStore(pool, challengerExperimentStore),
    new PostgresPaperExecutionStore(pool),
    profileStore,
    usPaperAssumptions,
    AUTHORITATIVE_EXECUTION_MODEL_VERSION,
    new StatisticalPredictionSnapshotService(
      new PostgresStatisticalModelStore(pool),
      scannerClient,
      new PostgresPredictionSnapshotStore(pool),
    ),
    new PostgresPaperCoordinationStore(pool),
    {
      cooldownMinutesAfterStop:
        config.PAPER_COORDINATION_COOLDOWN_MINUTES_AFTER_STOP,
      maxOpenPositions: config.PAPER_COORDINATION_MAX_OPEN_POSITIONS,
      maxTotalOpenRisk: usPaperRisk.maxTotalOpenRisk,
      maxDailyLoss: usPaperRisk.maxDailyLoss,
      dailyLossLimitType: config.PAPER_COORDINATION_DAILY_LOSS_LIMIT_TYPE,
      reserveRemainingDailyRisk:
        config.PAPER_COORDINATION_RESERVE_REMAINING_DAILY_RISK,
      maxConsecutiveStops: config.PAPER_COORDINATION_MAX_CONSECUTIVE_STOPS,
      maximumHoldingMinutes: config.PAPER_COORDINATION_MAX_HOLDING_MINUTES,
      maximumHoldingMinutesByStrategy:
        config.PAPER_COORDINATION_MAX_HOLDING_MINUTES_BY_STRATEGY,
      stalledBreakoutMinutes:
        config.PAPER_COORDINATION_STALLED_BREAKOUT_MINUTES,
      stalledBreakoutMinProgressR:
        config.PAPER_COORDINATION_STALLED_BREAKOUT_MIN_PROGRESS_R,
      maxSymbolNotional: usPaperRisk.maxSymbolNotional,
      maxSectorNotional: usPaperRisk.maxSectorNotional,
      requireFreshContext: config.PAPER_COORDINATION_REQUIRE_FRESH_CONTEXT,
      contextRequirement: config.PAPER_COORDINATION_CONTEXT_REQUIREMENT,
      contextMaxAgeSeconds: config.PAPER_COORDINATION_CONTEXT_MAX_AGE_SECONDS,
      vetoOnWeakContext: config.PAPER_COORDINATION_VETO_ON_WEAK_CONTEXT,
    },
    {
      maxDisplayedSizeParticipation:
        config.PAPER_COORDINATION_MAX_DISPLAYED_SIZE_PARTICIPATION,
    },
    usCandidatePredictionResolver,
    config.PAPER_FUNDED_USD_ACCOUNT_ID
      ? {
          pool,
          accountId: config.PAPER_FUNDED_USD_ACCOUNT_ID,
          currency: "USD",
          initialCash: config.PAPER_FUNDED_INITIAL_CASH_USD,
          dailyLossLimit: config.PAPER_FUNDED_DAILY_LOSS_LIMIT_USD,
          policy: fundedPolicy(
            config.PAPER_COORDINATION_MAX_DISPLAYED_SIZE_PARTICIPATION,
            0,
            {
              maxOpenPositions: config.PAPER_COORDINATION_MAX_OPEN_POSITIONS,
              maxTotalOpenRisk: usPaperRisk.maxTotalOpenRisk,
              maxSymbolNotional: usPaperRisk.maxSymbolNotional,
              maxSectorNotional: usPaperRisk.maxSectorNotional,
              cooldownMinutesAfterStop:
                config.PAPER_COORDINATION_COOLDOWN_MINUTES_AFTER_STOP,
              maxConsecutiveStops:
                config.PAPER_COORDINATION_MAX_CONSECUTIVE_STOPS,
              requireFreshContext:
                config.PAPER_COORDINATION_REQUIRE_FRESH_CONTEXT,
              contextRequirement: config.PAPER_COORDINATION_CONTEXT_REQUIREMENT,
              contextMaxAgeSeconds:
                config.PAPER_COORDINATION_CONTEXT_MAX_AGE_SECONDS,
              vetoOnWeakContext: config.PAPER_COORDINATION_VETO_ON_WEAK_CONTEXT,
              maximumHoldingMinutes:
                config.PAPER_COORDINATION_MAX_HOLDING_MINUTES,
              maximumHoldingMinutesByStrategy:
                config.PAPER_COORDINATION_MAX_HOLDING_MINUTES_BY_STRATEGY,
              stalledBreakoutMinutes:
                config.PAPER_COORDINATION_STALLED_BREAKOUT_MINUTES,
              stalledBreakoutMinProgressR:
                config.PAPER_COORDINATION_STALLED_BREAKOUT_MIN_PROGRESS_R,
            },
          ),
        }
      : undefined,
  );
}

// The CA runtime is the only enabled runtime in Phase 2. Subsequent market
// runtimes join this coordinator rather than sharing the CA session state.
const marketRuntimes = new MarketRuntimeCoordinator([
  { marketId: "CA_TSX", service: marketData },
  ...(usMarketData
    ? [{ marketId: "US_EQUITIES" as const, service: usMarketData }]
    : []),
]);

const statusService = new FoundationStatusService(
  {
    database: new DatabaseProbe(pool),
    scanner: new ScannerProbe(new URL(config.SCANNER_URL)),
    marketData,
  },
  clock,
  config.MARKET_DATA_MODE,
  marketData,
);
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
};
const replayPolicies = {
  CA_TSX: replayPolicy,
  US_EQUITIES: {
    ...replayPolicy,
    marketId: "US_EQUITIES" as const,
    timezone: config.US_SESSION_TIMEZONE,
  },
} as const;

const researchLineage = new ResearchLineageService(
  pool,
  createResearchRuntimeIdentityProvider(scannerClient),
  replayPolicies,
);
const evidenceTrainingService = new PaperEvidenceTrainingService(
  new PostgresPaperEvidenceTrainingStore(pool),
  researchLineage,
);
const researchEvidenceStore = new PostgresResearchEvidenceStore(pool);
const coverageRequestService = new CoverageRequestService(
  new PostgresCoverageRequestRepository(pool),
);
const strategyStudyStore = new PostgresStrategyStudyStore(pool);
const studyAuthorizationStore = new PostgresStudyAuthorizationRepository(pool);
const evidenceAutomationService = new EvidenceAutomationService(
  new PostgresEvidenceAutomationRepository(pool),
  new ResearchJobRepository(pool),
  clock,
  new PostgresEvidenceAutomationReadRepository(pool),
);
const paperReportingService = new PaperReportingService(
  new PostgresPaperEvidenceStore(pool),
);
const fundedReportingService = new FundedReportingService(pool, clock, {
  CA_TSX: config.PAPER_FUNDED_CAD_ACCOUNT_ID,
  US_EQUITIES: config.PAPER_FUNDED_USD_ACCOUNT_ID,
});
const predictionMonitoringService = new PostgresPredictionSnapshotStore(pool);
const statisticalModelService = new StatisticalModelService(
  new PostgresStatisticalModelStore(pool),
  backtestStore,
  scannerClient,
  evidenceTrainingService,
);
const learningDashboardService = new LearningDashboardService(
  new PostgresLearningAutomationStore(pool),
  evidenceTrainingService,
  statisticalModelService,
  predictionMonitoringService,
  paperReportingService,
  config.PAPER_MODEL_TRAINING_ENABLED,
  new ResearchJobRepository(pool),
  config.PAPER_MODEL_TRAINING_CHECK_MS
    ? `Every ${config.PAPER_MODEL_TRAINING_CHECK_MS / 3_600_000} hours, plus worker startup`
    : "Daily at 5:00 p.m. Eastern, plus worker startup",
  evidenceAutomationService,
  config.PAPER_MODEL_TRAINING_CHECK_MS ?? null,
);
const challengerApiService = new PostgresChallengerExperimentApiService(
  new ChallengerExperimentService(
    challengerExperimentStore,
    {
      activate: async () => {
        throw new Error(
          "MODEL_ACTIVATION_NOT_AUTHORIZED_BY_CHALLENGER_WORKFLOW",
        );
      },
    },
    { now: clock },
  ),
  new PostgresChallengerReportingService(
    challengerExperimentStore,
    pool,
    clock,
  ),
);

const app = await buildApp({
  statusService,
  logger: loggerOptions(config),
  webOrigin: config.WEB_ORIGIN,
  marketDataService: marketData,
  marketDataServices: {
    CA_TSX: marketData,
    ...(usMarketData ? { US_EQUITIES: usMarketData } : {}),
  },
  discoveryServices,
  backtestService: new BacktestService(
    backtestStore,
    scannerClient,
    replayPolicies,
    profileStore,
    researchLineage,
  ),
  backtestAutomationService,
  fundedHistoricalPolicyService,
  fundedHistoricalService: new FundedHistoricalReadService(
    pool,
    fundedReportingService,
  ),
  rankingResearchService: new RankingResearchService(
    new PostgresRankingResearchStore(pool),
    backtestStore,
  ),
  calibrationService: new CalibrationService(
    new PostgresCalibrationStore(pool),
    backtestStore,
    scannerClient,
    replayPolicies,
    researchLineage,
  ),
  paperReportingService,
  fundedReportingService,
  statisticalModelService,
  paperEvidenceTrainingService: evidenceTrainingService,
  predictionMonitoringService,
  learningDashboardService,
  profileService,
  researchJobService: new ResearchJobRepository(pool),
  researchEvidenceService: researchEvidenceStore,
  coverageRequestService,
  strategyStudyService: new StrategyStudyApiService(
    strategyStudyStore,
    studyAuthorizationStore,
    new ResearchJobRepository(pool),
    createStudyAdmission(
      pool,
      createResearchRuntimeIdentityProvider(scannerClient),
    ),
  ),
  challengerExperimentService: challengerApiService,
  brokerMetrics: rateLimiter,
  persistenceMetrics,
  retentionService: new PostgresRetentionService(pool),
  remoteAccess: config.REMOTE_ACCESS_ENABLED
    ? {
        enabled: true,
        passwordHash: config.OPERATOR_PASSWORD_HASH!,
      }
    : undefined,
});
marketData.setLogger(app.log);
usMarketData?.setLogger(app.log);
discoveryCompactor.start();

// A prior process (API or worker) may have died mid-run leaving a legacy *_run/*_model row stuck
// RUNNING/TRAINING forever; see reconcile-orphaned-research.ts for why this still runs alongside
// W8's research_job lease/heartbeat system rather than being replaced by it.
for (const reconciled of await reconcileOrphanedResearch(pool)) {
  if (reconciled.interruptedCount > 0)
    app.log.info({
      event: "RESEARCH_ORPHANED_ROWS_INTERRUPTED",
      table: reconciled.table,
      count: reconciled.interruptedCount,
    });
}

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ event: "SHUTDOWN_STARTED", signal });
  await discoveryCompactor.stop();
  await Promise.all(discoveryIntakeWorkers.map((worker) => worker.stop()));
  await Promise.all(discoverySchedulers.map((scheduler) => scheduler.stop()));
  await marketRuntimes.stop();
  // A refresh interrupted between Questrade issuing a replacement token and the store committing
  // it strands the account until someone authorizes manually, so let any rotation finish first.
  await tokenManager.settle();
  await app.close();
  await pool.end();
  process.exit(0);
};

// Registered before the first authentication attempt: an unhandled SIGTERM during startup is
// exactly what kills a rotation mid-flight.
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

const MARKET_DATA_RETRY_FLOOR_MS = 15_000;
const MARKET_DATA_RETRY_CEILING_MS = 300_000;

// Market data starting is not a precondition for serving. Failing to authenticate used to throw
// out of the module and crash-loop the container, which hides the problem and takes the whole API
// down with it; the operator surfaces already report auth as AUTH_REQUIRED.
const startMarketData = async (attempt = 0): Promise<void> => {
  if (shuttingDown) return;
  try {
    await marketRuntimes.initialize();
    // Each runtime owns its first and subsequent ticks. A slow first cycle in
    // either market must not prevent the other market's timers from starting.
    marketRuntimes.start();
    if (!discoveryStarted) {
      for (const scheduler of discoverySchedulers) scheduler.start();
      for (const worker of discoveryIntakeWorkers) worker.start();
      discoveryStarted = true;
    }
    app.log.info({ event: "MARKET_DATA_STARTED", attempt });
  } catch (error) {
    const reauthorize = error instanceof QuestradeReauthorizationRequiredError;
    const delayMs = Math.min(
      MARKET_DATA_RETRY_FLOOR_MS * 2 ** attempt,
      MARKET_DATA_RETRY_CEILING_MS,
    );
    app.log.error({
      event: reauthorize
        ? "MARKET_DATA_REAUTHORIZATION_REQUIRED"
        : "MARKET_DATA_START_FAILED",
      attempt,
      retryInMs: delayMs,
      error: error instanceof Error ? error.message : String(error),
      ...(reauthorize
        ? {
            remedy:
              "Generate a new Questrade manual authorization token, then restart the API with QUESTRADE_REFRESH_TOKEN set.",
          }
        : {}),
    });
    const timer = setTimeout(() => void startMarketData(attempt + 1), delayMs);
    timer.unref?.();
  }
};

void startMarketData();

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info({
    event: "API_READY",
    port: config.API_PORT,
    marketDataMode: config.MARKET_DATA_MODE,
  });
} catch (error) {
  app.log.error({ event: "API_START_FAILED", error });
  await pool.end();
  process.exit(1);
}
