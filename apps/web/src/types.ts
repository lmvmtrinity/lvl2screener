import {
  type ContextStatus,
  type DataReadiness,
  type SetupStrategyName,
  type StrategyEvaluation,
  type StrategyState,
} from "@tsx-scanner/contracts";

/**
 * The paper-bot half of the market-status snapshot
 * (private development record, "Failure visibility"). Every field is
 * nullable because the processor may not have run a cycle yet.
 */
export type PaperBotStatus = {
  runId: string | null;
  sessionDate: string | null;
  scheduledCloseAt: string | null;
  executionModelVersion: string | null;
  openExecutions: number | null;
  closePendingExecutions: number | null;
  closedExecutions: number | null;
  noFillExecutions: number | null;
  rejectedEconomicsExecutions?: number | null;
  reconciliationBacklog: number | null;
  unreconcilableEvents: number;
  overdueRuns: number;
  unresolvedCoordinatedPositions?: number;
  completedRunsWithUnresolvedCoordinatedPositions?: number;
  oldestUnresolvedCoordinatedAgeMs?: number | null;
  unknownQuoteSizeUnits?: number;
  abandonedExecutions: number | null;
  lastTransitionAt: string | null;
  lastProcessingDurationMs: number | null;
  lastError: string | null;
  lastSuccessfulProcessingAt?: string | null;
  fundedProcessing?: boolean;
  fundedLastSuccessfulProcessingAt?: string | null;
  /** Account-wide funded state across runs, not just the current run. */
  funded?: {
    pendingFacts?: number;
    oldestPendingFactAgeMs?: number | null;
    closePendingOrders?: number;
    oldestClosePendingAgeMs?: number | null;
    riskVetoesTotal?: number;
    coverageGapsTotal?: number;
    recoveryFailuresTotal?: number;
    lastCycleLatencyMs?: number | null;
  };
};

export type MarketStatus = {
  state?: string;
  dataStatus?: string;
  lastQuoteAt?: string;
  lastCandleAt?: string;
  lastError?: string | null;
  instrumentCount?: number;
  featureSnapshotCount?: number;
  contextEvaluationCount?: number;
  benchmarkCount?: number;
  benchmarkWarnings?: string[];
  // Per-cycle telemetry: present on REST snapshots, deliberately stripped from
  // WebSocket broadcast frames (ws-frame.ts) to keep change detection useful.
  lastCycleDurationMs?: number;
  lastEngineDurationMs?: number;
  lastFeatureDurationMs?: number;
  lastEvaluationDurationMs?: number;
  lastEvaluationAgeMs?: number;
  session?: { marketStatus?: string; phase?: string };
  paperBot?: PaperBotStatus;
};

export type NotificationPreference =
  "enabled" | "disabled" | "blocked" | "unsupported";

export type BoardFilters = {
  state: "ALL" | StrategyState;
  setup: "ALL" | SetupStrategyName;
  sector: string;
  context: "ALL" | ContextStatus;
  readiness: "ALL" | DataReadiness;
  maximumSpread: string;
};

export type BoardRow = {
  symbol: string;
  setup: StrategyEvaluation | null;
  contextScore: number;
  contextStatus: ContextStatus;
  otherActiveSetups: number;
  sector: string | null;
  readiness: DataReadiness;
  status: string;
  reason: string;
  latestAt: string | null;
};
