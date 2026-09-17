/** W9: the service-facing interfaces `buildApp` and the split route modules under `routes/`
 * depend on. Extracted from app.ts so route modules can import these types without importing
 * app.ts itself (which would create a cycle, since app.ts registers the route modules). */
import type {
  ActiveStatisticalPredictions,
  AlertPolicy,
  BacktestAutomationCycle,
  BacktestAutomationStatus,
  BacktestComparison,
  BacktestRun,
  CalibrationRun,
  CapturedHistoryAvailability,
  CreateBacktest,
  CreateCalibration,
  CreateRankingResearch,
  CreateScannerProfile,
  CreateStatisticalModel,
  DiscoveryEvidence,
  DiscoveryModeState,
  DiscoveryParityAudit,
  DiscoveryParityStatus,
  DiscoveryRun,
  DiscoveryStatus,
  FastFunnelStatus,
  FundedHistoricalReplay,
  FundedHistoricalReplayList,
  FundedLiveAccountResponse,
  PaperBotActivity,
  PaperBotRun,
  PaperCohortAggregate,
  PaperCommissionSensitivity,
  PaperCoordinationDecision,
  PaperCoordinationSummary,
  LearningAutomationRun,
  LearningDashboardOverview,
  MarketId,
  PaperCohortCurvePoint,
  PaperEvidenceComparison,
  PaperEvidenceFilters,
  PaperExecution,
  PaperEvidenceCohort,
  PaperJournalProjection,
  PaperModelForwardMonitoring,
  PaperModelDivergence,
  PaperPerformanceCurve,
  PaperPerformanceGranularity,
  PaperProfileQualification,
  PaperSignalObservation,
  PaperTradeJournal,
  ProfileComparison,
  ComparisonCohortSelection,
  ResearchCoverageReport,
  CoverageRequestRecord,
  CreateCoverageRequest,
  ResearchEvidenceBinding,
  ResearchOwner,
  EvidenceAutomationStage,
  ProfileConfigHistory,
  RankingResearchRun,
  ResearchJob,
  ResearchJobType,
  FrozenStudyPlan,
  StudyAuthorizationRecord,
  StudyExecutionAuthorization,
  ScannerProfile,
  StatisticalModel,
  StatisticalPredictionBatch,
  StrategyDefinition,
  StrategyEvaluation,
  UniverseAutomation,
  CandidateIntakeStatus,
  UniverseRefreshRun,
  UpdateCandidateIntake,
  UpdateScannerProfile,
  ChallengerExperiment,
  ChallengerObservationReport,
  RegisterChallenger,
  ExperimentAction,
  ExecutionDiagnosticResponse,
  CreateFundedHistoricalAutomationPolicy,
  FundedHistoricalAutomationPolicy,
  RevokeFundedHistoricalAutomationPolicy,
} from "@tsx-scanner/contracts";
import type { FastifyServerOptions } from "fastify";
import type { FoundationStatusService } from "./foundation/status-service.js";
import type { OperationalStatusInput } from "./foundation/operational-status.js";
import type { ObservabilitySnapshot } from "./observability/metrics.js";
import type { PersistenceMetricsSnapshot } from "./observability/persistence-metrics.js";
import type { RetentionService } from "./observability/retention-repository.js";
import type { ResearchManifestRecord } from "./backtests/research-evidence-repository.js";
import type { StrategyStudyRecord } from "./backtests/strategy-study-repository.js";
import type { ExecutionDiagnosticsRequest } from "./paper-bot/execution-diagnostics-repository.js";

export interface MarketDataApi {
  getSnapshot(): unknown;
  getInstruments(): unknown[];
  getFeatureSnapshots(): unknown[];
  getFeatureSnapshot(symbol: string): unknown;
  getObservability?(): Omit<
    ObservabilitySnapshot,
    | "broker"
    | "websocket"
    | "operationalReady"
    | "actionable"
    | "reasonCodeCount"
    | "universeConfigured"
    | "universeResolved"
    | "universeEvaluated"
    | "persistence"
    | "retention"
  >;
  getOperationalStatusInput?(): Omit<
    OperationalStatusInput,
    "databaseReady" | "scannerReady" | "marketDataMode"
  >;
  getCandidates?(): unknown[];
  getCandidate?(symbol: string): unknown[];
  getContexts?(symbol?: string): unknown[];
  getSignals?(): unknown[];
  getAlerts?(): unknown[];
  getAlertPolicy?(): AlertPolicy;
  updateAlertPolicy?(policy: AlertPolicy): Promise<AlertPolicy>;
  getCandles?(symbol: string): Array<{
    start: Date;
    end: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isComplete: boolean;
  }>;
  getUniverseAutomation?(): UniverseAutomation | undefined;
  getUniverseCandidateStatuses?(): Promise<CandidateIntakeStatus[]>;
  listUniverseRuns?(limit?: number): Promise<UniverseRefreshRun[]>;
  refreshUniverse?(): Promise<unknown[]>;
  replaceUniverseSymbols?(symbols: string[]): Promise<unknown[]>;
  updateUniverseCandidates?(input: UpdateCandidateIntake): Promise<{
    instruments: unknown[];
    pasteReport: unknown;
    refreshError?: string;
  }>;
}

export interface DiscoveryApi {
  status(marketId: MarketId): Promise<DiscoveryStatus>;
  listRuns(
    marketId: MarketId,
    options?: { limit?: number; before?: string },
  ): Promise<DiscoveryRun[]>;
  listEvaluations(
    marketId: MarketId,
    runId: string,
    options?: {
      limit?: number;
      after?: { exchange: string; code: string };
      includeInput?: boolean;
    },
  ): Promise<DiscoveryEvidence[]>;
  preview(
    marketId: MarketId,
    completedBarEnd?: string,
  ): Promise<DiscoveryRun | null>;
  changeMode(input: {
    marketId: MarketId;
    mode: "OFF" | "SHADOW" | "AUTO_ADD";
    expectedRevision: number;
    reason: string;
    actor: string;
  }): Promise<DiscoveryModeState>;
  changeExclusion?(input: {
    marketId: MarketId;
    tradingDate: string;
    instrumentId: string;
    excluded: boolean;
    reason: string;
    actor: string;
  }): Promise<void>;
  parityStatus?(marketId: MarketId): Promise<DiscoveryParityStatus>;
  listParityAudits?(
    marketId: MarketId,
    limit?: number,
  ): Promise<DiscoveryParityAudit[]>;
  compareParity?(
    marketId: MarketId,
    runId?: string,
  ): Promise<DiscoveryParityAudit>;
  fastFunnelStatus?(marketId: MarketId): Promise<FastFunnelStatus>;
}

export interface BuildAppOptions {
  statusService: FoundationStatusService;
  logger?: FastifyServerOptions["logger"];
  webOrigin?: string;
  clock?: () => Date;
  marketDataService?: MarketDataApi;
  /** Runtime services indexed by their explicit market identity.  The legacy
   * `marketDataService` remains the CA_TSX compatibility default. */
  marketDataServices?: Partial<Record<MarketId, MarketDataApi>>;
  discoveryService?: DiscoveryApi;
  discoveryServices?: Partial<Record<MarketId, DiscoveryApi>>;
  backtestService?: BacktestApi;
  backtestAutomationService?: BacktestAutomationApi;
  fundedHistoricalPolicyService?: FundedHistoricalPolicyApi;
  fundedHistoricalService?: FundedHistoricalReplayApi;
  profileService?: ProfileApi;
  calibrationService?: CalibrationApi;
  statisticalModelService?: StatisticalModelApi;
  paperEvidenceTrainingService?: PaperEvidenceTrainingApi;
  predictionMonitoringService?: PredictionMonitoringApi;
  rankingResearchService?: RankingResearchApi;
  researchJobService?: ResearchJobApi;
  researchEvidenceService?: ResearchEvidenceApi;
  coverageRequestService?: CoverageRequestApi;
  strategyStudyService?: StrategyStudyApi;
  challengerExperimentService?: ChallengerExperimentApi;
  learningDashboardService?: LearningDashboardApi;
  brokerMetrics?: {
    readonly requestCounts: {
      completed: number;
      failed: number;
      queued: number;
      active: number;
      discoveryCompleted?: number;
      discoveryFailed?: number;
      discoveryCancelled?: number;
      discoveryExpired?: number;
    };
  };
  persistenceMetrics?: {
    snapshot(): PersistenceMetricsSnapshot;
  };
  retentionService?: RetentionService;
  paperReportingService?: PaperReportingApi;
  fundedReportingService?: FundedReportingApi;
  /** W5: set only by the remote-access Compose profile (config.REMOTE_ACCESS_ENABLED). See
   * ./auth/remote-auth-plugin.ts for what this turns on. */
  remoteAccess?: {
    enabled: boolean;
    passwordHash: string;
  };
}

export type { RetentionRunSummary } from "./observability/retention-repository.js";

export interface ProfileApi {
  listDefinitions(): Promise<StrategyDefinition[]>;
  listProfiles(): Promise<ScannerProfile[]>;
  create(input: CreateScannerProfile): Promise<ScannerProfile>;
  update(id: string, input: UpdateScannerProfile): Promise<ScannerProfile>;
  duplicate(
    id: string,
    name?: string,
    sourceCalibrationRunId?: string,
  ): Promise<ScannerProfile>;
  configHistory(id: string): Promise<ProfileConfigHistory>;
  listEvaluations(
    profileId?: string,
    limit?: number,
  ): Promise<StrategyEvaluation[]>;
  opportunities(): Promise<StrategyEvaluation[]>;
  compare(
    ids: string[],
    source: "LIVE" | "PAPER" | "BACKTEST",
    startDate: string,
    endDate: string,
    timeStart?: string,
    timeEnd?: string,
    marketId?: MarketId,
    cohortKeys?: ComparisonCohortSelection,
  ): Promise<ProfileComparison>;
}

export interface PaperReportingApi {
  listActivities(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperBotActivity[]>;
  listRuns(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperBotRun[]>;
  listObservations(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperSignalObservation[]>;
  listExecutions(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperExecution[]>;
  aggregates(filters: PaperEvidenceFilters): Promise<PaperCohortAggregate[]>;
  commissionSensitivity(
    filters: PaperEvidenceFilters,
    roundTripCommissions?: readonly number[],
  ): Promise<PaperCommissionSensitivity[]>;
  coordinationDecisions(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperCoordinationDecision[]>;
  coordinationSummary(
    filters: PaperEvidenceFilters,
  ): Promise<PaperCoordinationSummary>;
  curves(filters: PaperEvidenceFilters): Promise<PaperCohortCurvePoint[]>;
  divergences(filters: PaperEvidenceFilters): Promise<PaperModelDivergence[]>;
  qualifications(
    filters: PaperEvidenceFilters,
  ): Promise<PaperProfileQualification[]>;
  comparisons(
    filters: PaperEvidenceFilters,
  ): Promise<PaperEvidenceComparison[]>;
  journal(
    filters: PaperEvidenceFilters,
    projection: PaperJournalProjection,
    limit?: number,
  ): Promise<PaperTradeJournal>;
  performanceCurve(
    filters: PaperEvidenceFilters,
    range: { startDate: string; endDate: string },
    granularity: PaperPerformanceGranularity,
  ): Promise<PaperPerformanceCurve>;
}

export interface FundedReportingApi {
  getExecutionDiagnostics(
    runId: string,
    request: ExecutionDiagnosticsRequest,
  ): Promise<ExecutionDiagnosticResponse>;
  performanceCurve(
    marketId: MarketId | undefined,
    range: { startDate: string; endDate: string },
    source?: string,
  ): Promise<PaperPerformanceCurve>;
  journal(
    filters: PaperEvidenceFilters,
    limit?: number,
  ): Promise<PaperTradeJournal>;
}

export interface BacktestApi {
  listRuns(limit?: number): Promise<BacktestRun[]>;
  getRun(id: string): Promise<BacktestRun>;
  getCapturedHistoryAvailability?(
    marketId?: MarketId,
  ): Promise<CapturedHistoryAvailability>;
  createRun(input: CreateBacktest): Promise<BacktestRun>;
  compare(ids: string[]): Promise<BacktestComparison>;
}
/** A1 automation read model and explicit refresh for the Backtest & Studies page. */
export interface BacktestAutomationApi {
  status(
    marketId: MarketId,
    options?: { nextCheckAt?: string | null },
  ): Promise<BacktestAutomationStatus>;
  refreshNow(marketId: MarketId): Promise<BacktestAutomationCycle>;
  /** Explicit check for newly due work; never forces an attempt. */
  checkNow(marketId: MarketId): Promise<BacktestAutomationCycle>;
}
/** A3 explicit funded replay policy approval records. */
export interface FundedHistoricalPolicyApi {
  listPolicies(marketId: MarketId): Promise<FundedHistoricalAutomationPolicy[]>;
  requestPolicy(
    input: CreateFundedHistoricalAutomationPolicy,
  ): Promise<FundedHistoricalAutomationPolicy>;
  revokePolicy(
    id: string,
    input: RevokeFundedHistoricalAutomationPolicy,
  ): Promise<FundedHistoricalAutomationPolicy | null>;
}
export interface FundedHistoricalReplayApi {
  list(marketId: MarketId, limit?: number): Promise<FundedHistoricalReplayList>;
  get(runId: string): Promise<FundedHistoricalReplay>;
  liveAccount(marketId: MarketId): Promise<FundedLiveAccountResponse>;
}
export interface CalibrationApi {
  list(limit?: number): Promise<CalibrationRun[]>;
  get(id: string): Promise<CalibrationRun>;
  create(input: CreateCalibration): Promise<CalibrationRun>;
}
export interface StatisticalModelApi {
  list(limit?: number): Promise<StatisticalModel[]>;
  get(id: string): Promise<StatisticalModel>;
  create(input: CreateStatisticalModel): Promise<StatisticalModel>;
  activate(id: string): Promise<StatisticalModel>;
  deactivate(id: string): Promise<StatisticalModel>;
  predictions(
    id: string,
    evaluations: StrategyEvaluation[],
  ): Promise<StatisticalPredictionBatch>;
  activePredictions(
    evaluations: StrategyEvaluation[],
  ): Promise<ActiveStatisticalPredictions>;
}
/** Read-only evidence readiness surface. Training is intentionally not exposed here. */
export interface PaperEvidenceTrainingApi {
  listCohorts(): Promise<PaperEvidenceCohort[]>;
}
export interface PredictionMonitoringApi {
  monitoring(): Promise<PaperModelForwardMonitoring[]>;
}
export interface RankingResearchApi {
  list(limit?: number): Promise<RankingResearchRun[]>;
  get(id: string): Promise<RankingResearchRun>;
  create(input: CreateRankingResearch): Promise<RankingResearchRun>;
}

export interface LearningDashboardApi {
  evidenceArtifact?(
    kind: string,
    id: string,
    marketId: MarketId,
  ): Promise<unknown | undefined>;
  overview(): Promise<LearningDashboardOverview>;
  automationRuns(limit?: number): Promise<LearningAutomationRun[]>;
  evidenceAutomation?(marketId: MarketId): Promise<EvidenceAutomationStage[]>;
}

export interface ResearchEvidenceApi {
  saveManifest(record: ResearchManifestRecord): Promise<string>;
  getManifest(hash: string): Promise<ResearchManifestRecord | null>;
  saveReport(report: ResearchCoverageReport): Promise<string>;
  getReport(hash: string): Promise<ResearchCoverageReport | null>;
  bind(owner: ResearchOwner, binding: ResearchEvidenceBinding): Promise<void>;
  getBinding(owner: ResearchOwner): Promise<ResearchEvidenceBinding | null>;
}

export interface CoverageRequestApi {
  create(
    input: CreateCoverageRequest,
    idempotencyKey: string,
  ): Promise<CoverageRequestRecord>;
  get(id: string, marketId: MarketId): Promise<CoverageRequestRecord | null>;
}

export interface StrategyStudyApi {
  create(plan: FrozenStudyPlan, idempotencyKey: string): Promise<ResearchJob>;
  get(id: string): Promise<StrategyStudyRecord | null>;
  list(marketId: MarketId, limit?: number): Promise<StrategyStudyRecord[]>;
  createAuthorization(
    authorization: StudyExecutionAuthorization,
    plan: FrozenStudyPlan,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord>;
  listAuthorizations(
    marketId: MarketId,
    limit?: number,
  ): Promise<StudyAuthorizationRecord[]>;
  revokeAuthorization(
    id: string,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord | null>;
}

export interface ChallengerExperimentApi {
  list(marketId: MarketId, limit?: number): Promise<ChallengerExperiment[]>;
  get(id: string): Promise<ChallengerExperiment | null>;
  report(id: string, asOf?: string): Promise<ChallengerObservationReport>;
  register(
    input: RegisterChallenger,
    idempotencyKey: string,
  ): Promise<ChallengerExperiment>;
  transition(
    id: string,
    action: ExperimentAction,
    idempotencyKey: string,
  ): Promise<ChallengerExperiment>;
}

/** W8: durable research job queue. POST handlers for backtests/calibrations/ranking-research/
 * statistical-models enqueue through this instead of running the work inline; a worker process
 * (apps/api/src/worker.ts) claims and executes queued jobs. */
export interface ResearchJobApi {
  createJob(
    jobType: ResearchJobType,
    payload: unknown,
    idempotencyKey?: string | null,
  ): Promise<ResearchJob>;
  createStrictJob?(
    jobType: ResearchJobType,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ResearchJob>;
  get(id: string): Promise<ResearchJob | undefined>;
  requestCancellation(id: string): Promise<ResearchJob | undefined>;
  list?(jobType?: ResearchJobType, limit?: number): Promise<ResearchJob[]>;
}
