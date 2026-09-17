import { z } from "zod";
import { marketIdSchema } from "./markets.js";

export const paperBotRunSourceSchema = z.enum(["LIVE", "BACKTEST"]);
export type PaperBotRunSource = z.infer<typeof paperBotRunSourceSchema>;
export const paperBotRunStatusSchema = z.enum([
  "RUNNING",
  "CLOSE_PENDING",
  "COMPLETED",
  "FAILED",
]);
export const paperExecutionModelSchema = z.enum(["QUOTE", "CANDLE"]);
export type PaperExecutionModel = z.infer<typeof paperExecutionModelSchema>;
export const paperExecutionStatusSchema = z.enum([
  "PENDING",
  "OPEN",
  "CLOSE_PENDING",
  "CLOSED",
  "NO_FILL",
  /** The market was executable; the modeled trade could not pay for itself. */
  "REJECTED_ECONOMICS",
]);
export const paperNoFillReasonSchema = z.enum([
  "HALTED",
  "DELAYED",
  "STALE",
  "MISSING_QUOTE",
  "MISSING_REFERENCE",
  "UNKNOWN_QUOTE_SIZE",
  "SHARES_BELOW_ONE",
  "EXECUTABLE_PRICE_OUTSIDE_LEVELS",
  /**
   * Retained only to read rows written before the economics gate existed; new
   * rejections are persisted as REJECTED_ECONOMICS with an economics reason.
   */
  "NET_TARGET_NON_POSITIVE",
]);
export const paperEconomicsReasonSchema = z.enum([
  "NET_TARGET_NON_POSITIVE",
  "SPREAD_COST_TOO_HIGH",
  "STOP_DISTANCE_TOO_SMALL",
  "TARGET_DISTANCE_TOO_SMALL",
  "NET_REWARD_RISK_TOO_LOW",
]);
export type PaperEconomicsReason = z.infer<typeof paperEconomicsReasonSchema>;
export const paperExitReasonSchema = z.enum([
  "TARGET",
  "STOP",
  "TIME_STOP",
  "SESSION_CLOSE",
  "SESSION_CLOSE_DELAYED",
]);
export const paperEligibilityStatusSchema = z.enum([
  "ELIGIBLE",
  "BELOW_SCORE_CUTOFF",
]);

const jsonObject = z.record(z.string(), z.unknown());

export const paperBotRunSchema = z.object({
  id: z.string().uuid(),
  source: paperBotRunSourceSchema,
  sessionDate: z.string().date(),
  sessionTimezone: z.string(),
  scheduledCloseAt: z.string().datetime(),
  status: paperBotRunStatusSchema,
  executionModelVersion: z.string(),
  assumptions: jsonObject,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
  failureReason: z.string().nullable(),
});
export type PaperBotRun = z.infer<typeof paperBotRunSchema>;
export const paperBotRunListSchema = z.object({
  runs: z.array(paperBotRunSchema),
});

export const paperBotActivityEventSchema = z.enum([
  "RUN_STARTED",
  "RUN_COMPLETED",
  "RUN_CLOSE_PENDING",
  "RUN_FAILED",
  "SIGNAL_ELIGIBLE",
  "SIGNAL_BELOW_CUTOFF",
  "EXECUTION_PENDING",
  "EXECUTION_OPENED",
  "EXECUTION_CLOSED",
  "EXECUTION_NO_FILL",
  "EXECUTION_CLOSE_PENDING",
  "EXECUTION_ABANDONED",
  "EXECUTION_REJECTED_ECONOMICS",
]);
export const paperBotActivitySeveritySchema = z.enum([
  "INFO",
  "SUCCESS",
  "WARNING",
  "ERROR",
]);
export const paperBotActivitySchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  eventType: paperBotActivityEventSchema,
  severity: paperBotActivitySeveritySchema,
  symbol: z.string().nullable(),
  strategyKey: z.string().nullable(),
  model: paperExecutionModelSchema.nullable(),
  message: z.string().min(1),
  details: jsonObject,
});
export type PaperBotActivity = z.infer<typeof paperBotActivitySchema>;
export const paperBotActivityListSchema = z.object({
  activities: z.array(paperBotActivitySchema),
});

export const paperSignalObservationSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  sourceEventId: z.string().uuid(),
  sourceSignalId: z.string().uuid().nullable(),
  setupInstanceId: z.string().uuid().nullable(),
  instrumentId: z.string().uuid(),
  symbol: z.string(),
  profileId: z.string().uuid(),
  profileName: z.string(),
  profileConfigId: z.string().uuid(),
  configVersion: z.string(),
  profileParameters: jsonObject,
  strategyKey: z.string(),
  strategyVersion: z.string(),
  signalTimestamp: z.string().datetime(),
  score: z.number().int().min(0).max(100),
  eligibilityStatus: paperEligibilityStatusSchema,
  eligibilityReason: z.string().nullable(),
  reasonCodes: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type PaperSignalObservation = z.infer<
  typeof paperSignalObservationSchema
>;
export const paperSignalObservationListSchema = z.object({
  observations: z.array(paperSignalObservationSchema),
});

export const paperExecutionSchema = z.object({
  executionState: jsonObject.nullable().optional(),
  id: z.string().uuid(),
  observationId: z.string().uuid(),
  runId: z.string().uuid(),
  model: paperExecutionModelSchema,
  status: paperExecutionStatusSchema,
  entryPrice: z.number().nullable(),
  entryTime: z.string().datetime().nullable(),
  stopPrice: z.number().nullable(),
  targetPrice: z.number().nullable(),
  shares: z.number().int().positive().nullable(),
  exitPrice: z.number().nullable(),
  exitTime: z.string().datetime().nullable(),
  exitReason: paperExitReasonSchema.nullable(),
  fee: z.number().nullable(),
  grossPnl: z.number().nullable(),
  netPnl: z.number().nullable(),
  rMultiple: z.number().nullable(),
  noFillReason: paperNoFillReasonSchema.nullable(),
  economicsReason: paperEconomicsReasonSchema.nullable().default(null),
  /** Full gate inputs and thresholds for an auditable rejection or fill. */
  economics: jsonObject.nullable().default(null),
  /** Requested/estimated risk and every cap that reduced the share count. */
  sizing: jsonObject.nullable().default(null),
  entrySizeCoverage: z.number().nullable(),
  exitSizeCoverage: z.number().nullable(),
  sessionCloseDelayMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PaperExecution = z.infer<typeof paperExecutionSchema>;
export const paperExecutionListSchema = z.object({
  executions: z.array(paperExecutionSchema),
});

export const paperEvidenceFiltersSchema = z
  .object({
    /** Evidence and monetary totals are always native to one market. */
    marketId: marketIdSchema.optional(),
    profileId: z.string().uuid().optional(),
    profileConfigId: z.string().uuid().optional(),
    executionModelVersion: z.string().min(1).optional(),
    source: paperBotRunSourceSchema.optional(),
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
    model: paperExecutionModelSchema.optional(),
    status: paperExecutionStatusSchema.optional(),
    noFillReason: paperNoFillReasonSchema.optional(),
    economicsReason: paperEconomicsReasonSchema.optional(),
    exitReason: paperExitReasonSchema.optional(),
  })
  .refine(
    (value) =>
      !value.startDate || !value.endDate || value.startDate <= value.endDate,
    "endDate must be on or after startDate",
  );
export type PaperEvidenceFilters = z.infer<typeof paperEvidenceFiltersSchema>;

export const paperRateSchema = z.object({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  value: z.number().nullable(),
});
export const paperDelayedCloseSchema = z.object({
  count: z.number().int().nonnegative(),
  totalDurationMs: z.number().int().nonnegative(),
  averageDurationMs: z.number().nullable(),
});
export const paperSizeCoverageBucketSchema = z.object({
  bucket: z.enum(["UNKNOWN", "BELOW_ONE", "ONE_TO_TWO", "TWO_OR_MORE"]),
  count: z.number().int().nonnegative(),
});
export const paperSpreadSummarySchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  minimum: z.number().nullable(),
  maximum: z.number().nullable(),
  average: z.number().nullable(),
});
export type PaperSpreadSummary = z.infer<typeof paperSpreadSummarySchema>;
export const paperEvidenceCohortSchema = z.object({
  marketId: z.string().optional(),
  currency: z.string().optional(),
  signalSemanticsVersion: z.string().optional(),
  replayScope: z.string().optional(),
  profileId: z.string().uuid(),
  profileName: z.string(),
  profileConfigId: z.string().uuid(),
  configVersion: z.string(),
  strategyKey: z.string(),
  strategyVersion: z.string(),
  source: paperBotRunSourceSchema,
  executionModelVersion: z.string(),
  assumptions: jsonObject,
});
export const paperCohortAggregateSchema = z.object({
  cohort: paperEvidenceCohortSchema,
  model: paperExecutionModelSchema,
  signalCount: z.number().int().nonnegative(),
  eligibleSignalCount: z.number().int().nonnegative(),
  fills: z.number().int().nonnegative(),
  noFills: z.number().int().nonnegative(),
  /** Economically declined candidates, kept out of the no-fill funnel stage. */
  rejectedEconomics: z.number().int().nonnegative().default(0),
  closedTrades: z.number().int().nonnegative(),
  openExecutions: z.number().int().nonnegative(),
  closePendingExecutions: z.number().int().nonnegative(),
  unresolvedExecutions: z.number().int().nonnegative(),
  fillRate: paperRateSchema,
  winRate: paperRateSchema,
  averageR: z.number().nullable(),
  expectancyR: z.number().nullable(),
  cumulativeR: z.number(),
  exitReasons: z.record(z.string(), z.number().int().nonnegative()),
  noFillReasons: z.record(z.string(), z.number().int().nonnegative()),
  economicsReasons: z
    .record(z.string(), z.number().int().nonnegative())
    .default({}),
  sizeCoverage: z.array(paperSizeCoverageBucketSchema),
  exitSizeCoverage: z.array(paperSizeCoverageBucketSchema),
  entrySpread: paperSpreadSummarySchema,
  delayedClose: paperDelayedCloseSchema,
});
export type PaperCohortAggregate = z.infer<typeof paperCohortAggregateSchema>;
export const paperCohortAggregateListSchema = z.object({
  aggregates: z.array(paperCohortAggregateSchema),
});

export const paperHistoricalComparisonSchema = z.object({
  backtestRunId: z.string().uuid(),
  closedTrades: z.number().int().nonnegative(),
  winRate: paperRateSchema,
  averageR: z.number().nullable(),
  expectancyR: z.number().nullable(),
  cumulativeR: z.number(),
  exitReasons: z.record(z.string(), z.number().int().nonnegative()),
});
export const paperEvidenceComparisonSchema = z.object({
  forward: paperCohortAggregateSchema,
  comparable: z.boolean(),
  reason: z.string().nullable(),
  historical: paperHistoricalComparisonSchema.nullable(),
});
export type PaperEvidenceComparison = z.infer<
  typeof paperEvidenceComparisonSchema
>;
export const paperEvidenceComparisonListSchema = z.object({
  comparisons: z.array(paperEvidenceComparisonSchema),
});

/**
 * What a closed cohort's net result would have been under an alternative
 * fixed round-trip commission. Historical conclusions must disclose their
 * cost dependence rather than silently inherit one broker schedule.
 */
export const paperCommissionScenarioSchema = z.object({
  roundTripCommission: z.number().nonnegative(),
  closedTrades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRate: paperRateSchema,
  netPnl: z.number(),
  averageR: z.number().nullable(),
  expectancyR: z.number().nullable(),
  cumulativeR: z.number(),
  profitFactor: z.number().nullable(),
});
export type PaperCommissionScenario = z.infer<
  typeof paperCommissionScenarioSchema
>;
export const paperCommissionSensitivitySchema = z.object({
  cohort: paperEvidenceCohortSchema,
  model: paperExecutionModelSchema,
  scenarios: z.array(paperCommissionScenarioSchema),
});
export type PaperCommissionSensitivity = z.infer<
  typeof paperCommissionSensitivitySchema
>;
export const paperCommissionSensitivityListSchema = z.object({
  sensitivities: z.array(paperCommissionSensitivitySchema),
});

/**
 * The coordinated shadow portfolio (docs/paper-bot-performance-improvement-plan.md,
 * Phase 4). These totals describe one cooperating portfolio and must never be
 * added to, or compared against, the independent per-strategy evidence above:
 * the two projections answer different questions from the same observations.
 */
export const paperCoordinationOutcomeSchema = z.enum([
  "APPROVED",
  "REJECTED",
  "DEFERRED",
]);

export const candidatePredictionSchema = z.object({
  modelId: z.string().uuid().optional(),
  modelVersion: z.string().optional(),
  predictionTimestamp: z.string().datetime().optional(),
  predictedProbability: z.number().min(0).max(1).optional(),
  payloadDigest: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  fallbackReason: z.string().nullable().optional(),
  expectedR: z.number().nullable().optional(),
  payoffDistribution: z
    .object({
      winExpectedR: z.number(),
      lossExpectedR: z.number(),
      sampleCount: z.number().int().nonnegative(),
      priorSampleCount: z.number().int().nonnegative(),
    })
    .optional(),
});
export type CandidatePrediction = z.infer<typeof candidatePredictionSchema>;

export const shadowCoordinationDecisionSchema = z.object({
  policyVersion: z.literal("paper-coordination-v4-shadow"),
  outcome: paperCoordinationOutcomeSchema,
  reason: z.string(),
  selectedObservationId: z.string().uuid().nullable(),
  selectedStrategyKey: z.string().nullable(),
  differsFromPrimary: z.boolean(),
  differenceReason: z.string().nullable(),
  sizing: z
    .object({
      baseRisk: z.number().nullable(),
      baseShares: z.number().int().positive().nullable(),
      multiplier: z.number().min(0.5).max(1),
      finalRisk: z.number().nullable(),
      finalShares: z.number().int().nonnegative().nullable(),
      reason: z.string(),
    })
    .nullable()
    .optional(),
});
export type ShadowCoordinationDecision = z.infer<
  typeof shadowCoordinationDecisionSchema
>;

export const paperCoordinationDecisionSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  symbol: z.string(),
  decisionTimestamp: z.string().datetime(),
  outcome: paperCoordinationOutcomeSchema,
  reason: z.string(),
  policyVersion: z.string(),
  selectedObservationId: z.string().uuid().nullable(),
  selectedStrategyKey: z.string().nullable(),
  confirmationObservationIds: z.array(z.string()),
  candidateCount: z.number().int().nonnegative(),
  candidates: z.array(jsonObject).optional(),
  candidateOutcomes: z
    .record(
      z.string(),
      z.object({
        status: z.string(),
        netPnl: z.number().nullable(),
        rMultiple: z.number().nullable(),
      }),
    )
    .optional(),
  contexts: z.array(jsonObject),
  state: jsonObject,
  positionStatus: paperExecutionStatusSchema.nullable(),
  exitReason: paperExitReasonSchema.nullable(),
  exitTime: z.string().datetime().nullable(),
  netPnl: z.number().nullable(),
  rMultiple: z.number().nullable(),
  shadowDecision: jsonObject.nullable().optional(),
  createdAt: z.string().datetime(),
});
export type PaperCoordinationDecision = z.infer<
  typeof paperCoordinationDecisionSchema
>;
export const paperCoordinationDecisionListSchema = z.object({
  decisions: z.array(paperCoordinationDecisionSchema),
});

export const paperCoordinationSummarySchema = z.object({
  policyVersions: z.array(z.string()),
  decisions: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  reasons: z.record(z.string(), z.number().int().nonnegative()),
  openPositions: z.number().int().nonnegative(),
  closedTrades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRate: paperRateSchema,
  netPnl: z.number(),
  cumulativeR: z.number(),
  averageR: z.number().nullable(),
  exitReasons: z.record(z.string(), z.number().int().nonnegative()),
  /** Distinct symbols and sectors the portfolio was exposed to. */
  symbolsTraded: z.number().int().nonnegative(),
  repeatedSymbolEntries: z.number().int().nonnegative(),
});
export type PaperCoordinationSummary = z.infer<
  typeof paperCoordinationSummarySchema
>;

export const paperCohortCurvePointSchema = z.object({
  cohort: paperEvidenceCohortSchema,
  model: paperExecutionModelSchema,
  sessionDate: z.string().date(),
  closedTrades: z.number().int().nonnegative(),
  dailyR: z.number(),
  cumulativeR: z.number(),
});
export type PaperCohortCurvePoint = z.infer<typeof paperCohortCurvePointSchema>;
export const paperCohortCurveListSchema = z.object({
  points: z.array(paperCohortCurvePointSchema),
});

export const paperProfileQualificationSchema = z.object({
  profileId: z.string().uuid(),
  profileName: z.string(),
  profileConfigId: z.string().uuid(),
  strategyKey: z.string(),
  strategyVersion: z.string(),
  executionModelVersion: z.string(),
  assumptions: jsonObject,
  policyVersion: z.string(),
  asOfRunId: z.string().uuid(),
  closedTrades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  netPnl: z.number(),
  cumulativeR: z.number(),
  averageR: z.number(),
  qualification: z.enum(["EXPLORATORY", "PAPER_QUALIFIED"]),
  computedAt: z.string().datetime(),
});
export type PaperProfileQualification = z.infer<
  typeof paperProfileQualificationSchema
>;
export const paperProfileQualificationListSchema = z.object({
  qualifications: z.array(paperProfileQualificationSchema),
});

const paperDifferenceSummarySchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  average: z.number().nullable(),
});
export const paperModelDivergenceSchema = z.object({
  cohort: paperEvidenceCohortSchema,
  pairedExecutions: z.number().int().nonnegative(),
  pairedClosedExecutions: z.number().int().nonnegative(),
  entryPriceDifference: paperDifferenceSummarySchema,
  exitPriceDifference: paperDifferenceSummarySchema,
  netPnlDifference: paperDifferenceSummarySchema,
  rMultipleDifference: paperDifferenceSummarySchema,
  exitReasonMismatch: paperRateSchema,
});
export type PaperModelDivergence = z.infer<typeof paperModelDivergenceSchema>;
export const paperModelDivergenceListSchema = z.object({
  divergences: z.array(paperModelDivergenceSchema),
});

/**
 * A trade-by-trade profit-and-loss ledger for the bot, one projection at a
 * time. ADR-010 forbids summing the projections, so the journal never mixes
 * them in one response: it names the projection it was built from and carries
 * totals computed only within it.
 *
 * `COORDINATED` reads as the capacity-constrained shadow account's ledger and
 * `FUNDED` reads the separately bound funded paper account's filled orders;
 * both carry a running realized balance. `INDEPENDENT` rows are unbiased
 * per-strategy evidence — one execution per observed lifecycle, overlapping
 * freely — so their totals are a sum over positions no single account could
 * have held simultaneously, and a running balance across them would describe
 * nothing real.
 */
export const paperJournalProjectionSchema = z.enum([
  "FUNDED",
  "COORDINATED",
  "INDEPENDENT",
]);
export type PaperJournalProjection = z.infer<
  typeof paperJournalProjectionSchema
>;

/** A filled position: the journal reports trades, not declined candidates. */
export const paperJournalStatusSchema = z.enum([
  "OPEN",
  "CLOSE_PENDING",
  "CLOSED",
]);

export const paperJournalEntrySchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  sessionDate: z.string().date(),
  symbol: z.string(),
  strategyKey: z.string(),
  profileName: z.string(),
  configVersion: z.string(),
  status: paperJournalStatusSchema,
  entryPrice: z.number().nullable(),
  entryTime: z.string().datetime().nullable(),
  stopPrice: z.number().nullable(),
  targetPrice: z.number().nullable(),
  shares: z.number().int().positive().nullable(),
  initialRisk: z.number().nullable(),
  requestedRisk: z.number().nullable().optional(),
  riskDeploymentRatio: z.number().nullable().optional(),
  bindingCaps: z.array(z.string()).optional(),
  exitPrice: z.number().nullable(),
  exitTime: z.string().datetime().nullable(),
  exitReason: paperExitReasonSchema.nullable(),
  grossPnl: z.number().nullable(),
  /**
   * Round-trip commissions and regulatory fees taken out of gross to reach
   * net. Slippage is not here: it is already inside the fill prices.
   */
  costs: z.number().nullable(),
  netPnl: z.number().nullable(),
  rMultiple: z.number().nullable(),
  /**
   * Net P&L through this trade, accumulated over every closed trade the
   * filters match rather than only the returned page, so truncating the list
   * cannot shift a balance. Null while a position is open, and null for the
   * whole `INDEPENDENT` projection, where no such balance exists.
   */
  runningNetPnl: z.number().nullable(),
  lastFactTimestamp: z.string().datetime().nullable().optional(),
  recoverySource: z.string().nullable().optional(),
  recoveryBoundary: z.string().datetime().nullable().optional(),
  recoveryFactTimestamp: z.string().datetime().nullable().optional(),
  recoveryDelayMs: z.number().int().nonnegative().nullable().optional(),
});
export type PaperJournalEntry = z.infer<typeof paperJournalEntrySchema>;

export const paperJournalTotalsSchema = z.object({
  closedTrades: z.number().int().nonnegative(),
  openPositions: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  /** Closed at exactly zero net; neither a win nor a loss. */
  scratches: z.number().int().nonnegative(),
  winRate: paperRateSchema,
  grossPnl: z.number(),
  costs: z.number(),
  netPnl: z.number(),
  /** Won net over lost net. Null until there is at least one losing trade. */
  profitFactor: z.number().nullable(),
  cumulativeR: z.number(),
  averageR: z.number().nullable(),
  largestWin: z.number().nullable(),
  largestLoss: z.number().nullable(),
});
export type PaperJournalTotals = z.infer<typeof paperJournalTotalsSchema>;

export const paperUnresolvedPositionSchema = z.object({
  id: z.string().uuid(),
  symbol: z.string(),
  sessionDate: z.string().date(),
  status: z.enum(["OPEN", "CLOSE_PENDING"]),
  runStatus: paperBotRunStatusSchema,
  entryTime: z.string().datetime().nullable(),
  lastFactTimestamp: z.string().datetime().nullable(),
  ageMs: z.number().int().nonnegative(),
});
export type PaperUnresolvedPosition = z.infer<
  typeof paperUnresolvedPositionSchema
>;

export const paperTradeJournalSchema = z.object({
  projection: paperJournalProjectionSchema,
  entries: z.array(paperJournalEntrySchema),
  /** Computed over every trade the filters match, not only the entries returned. */
  totals: paperJournalTotalsSchema,
  /** Portfolio-wide warnings are intentionally not restricted by journal dates. */
  unresolvedPositions: z.array(paperUnresolvedPositionSchema).optional(),
});
export type PaperTradeJournal = z.infer<typeof paperTradeJournalSchema>;

/**
 * Time buckets for the performance curve. TRADE returns one point per closed
 * position; DAY returns one point per session or completed funded-run boundary.
 */
export const paperPerformanceGranularitySchema = z.enum(["TRADE", "DAY"]);
export type PaperPerformanceGranularity = z.infer<
  typeof paperPerformanceGranularitySchema
>;

/**
 * Which account's performance is being read. COORDINATED is the capacity-
 * constrained shadow portfolio's realized P&L; FUNDED is the separately bound
 * funded paper account's mark-to-market boundary equity. ADR-010 forbids
 * adding them together, so one curve is served per request.
 */
export const paperPerformanceAccountSchema = z.enum(["COORDINATED", "FUNDED"]);
export type PaperPerformanceAccount = z.infer<
  typeof paperPerformanceAccountSchema
>;

export const paperPerformanceQuerySchema = z
  .object({
    marketId: marketIdSchema.optional(),
    source: paperBotRunSourceSchema.optional(),
    startDate: z.string().date(),
    endDate: z.string().date(),
    granularity: paperPerformanceGranularitySchema.default("DAY"),
    account: paperPerformanceAccountSchema.default("COORDINATED"),
  })
  .refine(
    (value) => value.startDate <= value.endDate,
    "endDate must be on or after startDate",
  );
export type PaperPerformanceQuery = z.infer<typeof paperPerformanceQuerySchema>;

export const paperPerformancePointSchema = z.object({
  sessionDate: z.string().date(),
  /**
   * When the point was realized: the last exit time in a coordinated bucket,
   * or the retained funded run-end boundary. Neither point is marked to a
   * later price.
   */
  closedAt: z.string().datetime(),
  netPnl: z.number(),
  cumulativeNetPnl: z.number(),
  trades: z.number().int().nonnegative(),
});
export type PaperPerformancePoint = z.infer<typeof paperPerformancePointSchema>;

/**
 * $ performance over time for one account. COORDINATED points are realized
 * net P&L bucketed by the session that exited them, never the session that
 * decided them. FUNDED points are the funded account's equity change at each
 * completed run boundary, based on the immutable run-end snapshot; runs whose
 * boundary was never captured remain unavailable instead of being marked to
 * a later price. `warnings` names evidence limitations explicitly.
 */
export const paperPerformanceCurveSchema = z.object({
  account: paperPerformanceAccountSchema,
  marketId: marketIdSchema,
  currency: z.enum(["CAD", "USD"]),
  granularity: paperPerformanceGranularitySchema,
  startDate: z.string().date(),
  endDate: z.string().date(),
  points: z.array(paperPerformancePointSchema),
  warnings: z.array(z.string()).default([]),
});
export type PaperPerformanceCurve = z.infer<typeof paperPerformanceCurveSchema>;

export const fundedHistoricalOrderOutcomeSchema = z.object({
  orderId: z.string(),
  instrumentId: z.string(),
  status: z.enum(["PENDING", "FILLED", "CANCELLED", "REJECTED"]),
  executionStatus: paperExecutionStatusSchema.nullable(),
  reason: z.string().nullable(),
  shares: z.number().nullable(),
  entryPrice: z.number().nullable(),
  exitReason: paperExitReasonSchema.nullable(),
  netPnl: z.number().nullable(),
  rMultiple: z.number().nullable(),
});
export type FundedHistoricalOrderOutcome = z.infer<
  typeof fundedHistoricalOrderOutcomeSchema
>;

export const fundedHistoricalReplaySummarySchema = z.object({
  cash: z.number(),
  equity: z.number(),
  realizedPnl: z.number(),
  dailyPnl: z.number(),
  reservedCash: z.number(),
  openRisk: z.number(),
  remainingDailyRisk: z.number(),
  staleMarks: z.boolean(),
  entriesAllowed: z.boolean(),
});
export type FundedHistoricalReplaySummary = z.infer<
  typeof fundedHistoricalReplaySummarySchema
>;

/**
 * Read projection of a funded account replay. `qualifiedForCapitalAllocation`
 * is a literal false: execution reporting never establishes promotion
 * evidence, and this output is deliberately separate from independent signal
 * outcomes.
 */
export const fundedHistoricalReplaySchema = z.object({
  projection: z.literal("FUNDED_PORTFOLIO_REPLAY"),
  runId: z.string().uuid(),
  accountId: z.string().uuid(),
  marketId: marketIdSchema,
  currency: z.enum(["CAD", "USD"]),
  sessionDate: z.string().date(),
  runStatus: paperBotRunStatusSchema,
  executionModelVersion: z.string(),
  temporalScope: z.enum(["RUN_END", "AS_OF", "CURRENT_ACCOUNT"]),
  asOf: z.string().datetime(),
  qualifiedForCapitalAllocation: z.literal(false),
  qualificationReason: z.string(),
  isCurrentAccount: z.boolean(),
  summary: fundedHistoricalReplaySummarySchema,
  orderCounts: z.object({
    pending: z.number().int().nonnegative(),
    filled: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  orders: z.array(fundedHistoricalOrderOutcomeSchema),
  warnings: z.array(z.string()),
});
export type FundedHistoricalReplay = z.infer<
  typeof fundedHistoricalReplaySchema
>;

export const fundedHistoricalReplayListSchema = z.object({
  marketId: marketIdSchema,
  runs: z.array(fundedHistoricalReplaySchema),
});
export type FundedHistoricalReplayList = z.infer<
  typeof fundedHistoricalReplayListSchema
>;

/**
 * Order counts for the latest live funded run only. The account's summary is
 * current, but its activity must never borrow trades from another session.
 */
export const fundedLiveAccountActivitySchema = z.object({
  decisions: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  cumulativeR: z.number().nullable(),
});
export type FundedLiveAccountActivity = z.infer<
  typeof fundedLiveAccountActivitySchema
>;

/**
 * Live funded paper account state for one market. Unlike the funded replay
 * projection this reads the bound account's current ledger rather than a
 * completed run boundary, so it is explicitly `CURRENT_ACCOUNT` scope and
 * never presented as run-end or promotion evidence. `qualifiedForCapitalAllocation`
 * is a literal false: execution reporting never establishes that.
 */
export const fundedLiveAccountSchema = z.object({
  projection: z.literal("FUNDED_PAPER_ACCOUNT"),
  marketId: marketIdSchema,
  currency: z.enum(["CAD", "USD"]),
  accountId: z.string().uuid(),
  runId: z.string().uuid(),
  runStatus: paperBotRunStatusSchema,
  sessionDate: z.string().date(),
  asOf: z.string().datetime(),
  temporalScope: z.literal("CURRENT_ACCOUNT"),
  qualifiedForCapitalAllocation: z.literal(false),
  qualificationReason: z.string(),
  summary: fundedHistoricalReplaySummarySchema,
  activity: fundedLiveAccountActivitySchema,
  warnings: z.array(z.string()),
});
export type FundedLiveAccount = z.infer<typeof fundedLiveAccountSchema>;

export const fundedLiveAccountResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("READY"), account: fundedLiveAccountSchema }),
  z.object({
    status: z.literal("UNAVAILABLE"),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    reason: z.literal("NO_LIVE_FUNDED_RUN"),
  }),
]);
export type FundedLiveAccountResponse = z.infer<
  typeof fundedLiveAccountResponseSchema
>;
