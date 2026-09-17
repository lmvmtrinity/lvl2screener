import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import {
  researchEvidenceBindingSchema,
  sampledExcursionSchema,
} from "./research-evidence.js";
import {
  NEUTRAL_CONTEXT_SCORE,
  contextEvaluationSchema,
  strategyStateEventSchema,
} from "./scoring.js";
import {
  setupStrategyNameSchema,
  strategyParametersSchema,
  strategyStateSchema,
} from "./strategies.js";

export const backtestStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
]);

/**
 * Authoritative replay/paper execution model. This constant only identifies
 * whether evidence was produced by the current execution version; evidence
 * qualification and pairwise comparability remain separate assessments and
 * must not be derived from a version match.
 */
export const AUTHORITATIVE_EXECUTION_MODEL_VERSION = "paper-execution-v7";

export const createBacktestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  marketId: marketIdSchema.default("CA_TSX"),
  startDate: z.string().date(),
  endDate: z.string().date(),
  strategies: z
    .array(setupStrategyNameSchema)
    .min(1)
    .default(["ORB_RETEST", "VWAP_HOLD"]),
  symbols: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(32)
        .transform((value) => value.toUpperCase()),
    )
    .max(500)
    .default([]),
  dataSource: z.literal("CAPTURED_QUOTES").default("CAPTURED_QUOTES"),
  startingCapital: z.number().positive().max(1_000_000_000).default(100_000),
  positionSize: z.number().positive().max(100_000_000).default(10_000),
  slippageBps: z.number().nonnegative().max(1_000).default(2),
  feePerTrade: z.number().nonnegative().max(10_000).default(0),
  parameters: strategyParametersSchema.default({
    rvolAtTimeMin: 1.5,
    spreadHardMaxPct: 0.25,
    atrPctMin: 0,
    breakoutVolumeRatioMin: 1.5,
    retestTolerancePct: 0.15,
    scoreCutoff: 0,
    breakoutBufferPct: 0.05,
    relativeStrengthMinPct: 0.5,
    flagpoleMinAtr: 0.5,
    flagRetracementMaxPct: 50,
    setupTimeoutMinutes: 20,
    consolidationBarsMin: 3,
    consolidationRangeMaxPct: 0.75,
    flagDurationBarsMin: 1,
    flagDurationBarsMax: 2,
    flagpoleMinSlopeAtrPerBar: 0,
    volumeContractionMaxPct: 100,
    retestVolumeContractionEnabled: 0,
    retestHighBreakEnabled: 0,
    retestRejectionEnabled: 0,
    retestVolumeContractionMaxRatio: 0.8,
    rejectionLowerWickBodyMin: 2,
    rejectionUpperWickRangeMaxPct: 20,
    rejectionCloseLocationMinPct: 65,
    rsiPeriod: 14,
    rsiPivotLeftBars: 2,
    rsiPivotRightBars: 2,
    rsiPivotMinSpacingBars: 3,
    rsiPivotMaxSpacingBars: 12,
    rsiDivergenceMinPoints: 3,
    rsiDivergenceVolumeContractionMaxRatio: 0.8,
    rsiSetupTimeoutMinutes: 30,
    dailyEmaFilterEnabled: 0,
  }),
});
export type CreateBacktest = z.infer<typeof createBacktestSchema>;

export const backtestMetricsSchema = z.object({
  signalsGenerated: z.number().int().nonnegative(),
  readySignals: z.number().int().nonnegative(),
  tradesSimulated: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  winRate: z.number(),
  averageWin: z.number(),
  averageLoss: z.number(),
  averageR: z.number(),
  medianR: z.number(),
  profitFactor: z.number().nullable(),
  expectancy: z.number(),
  netPnl: z.number(),
  maximumDrawdown: z.number(),
  maximumDrawdownPct: z.number(),
  falseBreakoutRate: z.number(),
  signalToTradeConversion: z.number(),
  averageHoldMinutes: z.number(),
  observations: z.number().int().nonnegative().default(0),
  eligibleSignals: z.number().int().nonnegative().default(0),
  fills: z.number().int().nonnegative().default(0),
  noFills: z.number().int().nonnegative().default(0),
  closePending: z.number().int().nonnegative().default(0),
  closedTrades: z.number().int().nonnegative().default(0),
});
export type BacktestMetrics = z.infer<typeof backtestMetricsSchema>;

export const backtestSliceSchema = z.object({
  dimension: z.enum([
    "STRATEGY",
    "SCORE_BUCKET",
    "TIME_OF_DAY",
    "SECTOR",
    "ATR_REGIME",
    "RVOL_REGIME",
  ]),
  bucket: z.string(),
  trades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRate: z.number(),
  averageR: z.number(),
  expectancy: z.number(),
  netPnl: z.number(),
});
export type BacktestSlice = z.infer<typeof backtestSliceSchema>;

export const backtestTradeSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  instrumentId: z.string().uuid(),
  symbol: z.string(),
  strategy: setupStrategyNameSchema,
  strategyVersion: z.string(),
  configVersion: z.string(),
  signalTimestamp: z.string().datetime(),
  score: z.number().int().min(0).max(100),
  entryTime: z.string().datetime(),
  entryPrice: z.number().positive(),
  stopPrice: z.number().positive(),
  targetPrice: z.number().positive(),
  exitTime: z.string().datetime(),
  exitPrice: z.number().positive(),
  shares: z.number().int().positive(),
  exitReason: z.enum([
    "STOP",
    "TARGET",
    "TIME_STOP",
    "SESSION_CLOSE",
    "SESSION_CLOSE_DELAYED",
  ]),
  grossPnl: z.number(),
  netPnl: z.number(),
  rMultiple: z.number(),
  holdMinutes: z.number().nonnegative(),
  reasonCodes: z.array(z.string()),
  sector: z.string().nullable().default(null),
  atrPct: z.number().nullable().default(null),
  rvolAtTime: z.number().nullable().default(null),
  contextScore: z.number().int().min(0).max(100).default(NEUTRAL_CONTEXT_SCORE),
  contexts: z.array(contextEvaluationSchema).default([]),
  setupInstanceId: z.string().uuid().nullable().optional(),
  sampledExcursion: sampledExcursionSchema.nullable().optional(),
});
export type BacktestTrade = z.infer<typeof backtestTradeSchema>;
export const backtestTimelineEventSchema = z.object({
  instrumentId: z.string().uuid(),
  symbol: z.string(),
  strategy: setupStrategyNameSchema,
  timestamp: z.string().datetime(),
  previousState: strategyStateSchema,
  state: strategyStateSchema,
  score: z.number().int().min(0).max(100),
  reasonCodes: z.array(z.string()),
  setupInstanceId: z.string().uuid().nullable().default(null),
});
export type BacktestTimelineEvent = z.infer<typeof backtestTimelineEventSchema>;
export const backtestQuoteExclusionCodeSchema = z.enum([
  "NON_FINITE_VALUE",
  "INVALID_BID",
  "CROSSED_BOOK",
  "INVALID_LAST",
  "INVALID_DAY_OPEN",
  "INVALID_SIZE",
  "INVALID_SPREAD",
]);
export type BacktestQuoteExclusionCode = z.infer<
  typeof backtestQuoteExclusionCodeSchema
>;
export const backtestQuoteExclusionSchema = z.object({
  code: backtestQuoteExclusionCodeSchema,
  count: z.number().int().positive(),
});
export type BacktestQuoteExclusion = z.infer<
  typeof backtestQuoteExclusionSchema
>;
export const backtestDataQualitySchema = z.object({
  quoteSnapshots: z.number().int().nonnegative(),
  /** Admitted quotes available to features and execution. Optional on legacy rows. */
  admittedQuotes: z.number().int().nonnegative().optional(),
  /**
   * Unique invalid quotes excluded from replay. Each excluded quote carries
   * exactly one reason code, so `exclusionReasons` counts sum to this value.
   */
  excludedQuotes: z.number().int().nonnegative().optional(),
  exclusionReasons: z.array(backtestQuoteExclusionSchema).optional(),
  candles: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  spread: z.enum(["CAPTURED", "UNAVAILABLE"]),
  warnings: z.array(z.string()),
});
export type BacktestDataQuality = z.infer<typeof backtestDataQualitySchema>;
export const backtestSignalReplayResultSchema = z.object({
  events: z.array(strategyStateEventSchema),
  contexts: z.array(contextEvaluationSchema),
  dataQuality: backtestDataQualitySchema,
});
export type BacktestSignalReplayResult = z.infer<
  typeof backtestSignalReplayResultSchema
>;

export const capturedHistoryTableAvailabilitySchema = z.object({
  earliest: z.string().datetime().nullable(),
  latest: z.string().datetime().nullable(),
});
/**
 * A bounded interior capture limitation derived from retained quote/candle
 * evidence. It describes an observed no-quote interval; it never claims an
 * outage cause, and candle backfill does not erase the missing forward quotes.
 */
export const capturedHistoryLimitationSchema = z
  .object({
    marketId: marketIdSchema,
    kind: z.literal("INTERIOR_NO_QUOTE"),
    /** Evidence basis for the interval, not an inferred cause. */
    basis: z.literal("QUOTE_GAP_WITH_BACKFILLED_CANDLES"),
    /** Exact observed bounds: last retained quote before through first after. */
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    /** Market-local session dates the interval covers. */
    sessionDates: z.array(z.string().date()),
    /** Plain-language research-impact explanation. */
    detail: z.string().min(1),
    /** The bounded window that was actually assessed for interior gaps. */
    evaluatedFrom: z.string().datetime(),
    evaluatedThrough: z.string().datetime(),
  })
  .strict();
export type CapturedHistoryLimitation = z.infer<
  typeof capturedHistoryLimitationSchema
>;
export const capturedHistoryAvailabilitySchema = z.object({
  source: z.literal("CAPTURED_QUOTES"),
  observedAt: z.string().datetime(),
  tables: z.object({
    quoteSnapshot: capturedHistoryTableAvailabilitySchema,
    candle: capturedHistoryTableAvailabilitySchema,
  }),
  replay: z.object({
    earliestDate: z.string().date().nullable(),
    latestDate: z.string().date().nullable(),
  }),
  /**
   * Optional so snapshots persisted before this field remain readable. An
   * absent field means interior limitations were not evaluated for that
   * snapshot; it is not proof that captured history was gap-free.
   */
  limitations: z.array(capturedHistoryLimitationSchema).optional(),
});
export type CapturedHistoryAvailability = z.infer<
  typeof capturedHistoryAvailabilitySchema
>;
export const replayInputInstrumentSchema = z.object({
  instrumentId: z.string().uuid(),
  symbol: z.string(),
  sector: z.string().nullable(),
});
export type ReplayInputInstrument = z.infer<typeof replayInputInstrumentSchema>;
export const replayInputBenchmarkSchema = replayInputInstrumentSchema.extend({
  kind: z.enum(["MARKET", "SECTOR"]),
  benchmarkSector: z.string().nullable(),
});
/**
 * How a replay's candidate instruments were selected. `HISTORICAL_MEMBERSHIP`
 * resolves each session from retained universe membership that was effective
 * before that session opened; `EXPLICIT_CAPTURED_COHORT` freezes caller-selected
 * symbols for exploratory replays and does not claim point-in-time universe
 * reconstruction; `CURRENT_ACTIVE_UNIVERSE` is the legacy live-universe selection
 * retained for runs persisted before historical membership resolution.
 */
export const replayCandidateProvenanceSchema = z.enum([
  "HISTORICAL_MEMBERSHIP",
  "EXPLICIT_CAPTURED_COHORT",
  "CURRENT_ACTIVE_UNIVERSE",
]);
export type ReplayCandidateProvenance = z.infer<
  typeof replayCandidateProvenanceSchema
>;
/**
 * Per-session candidate resolution frozen into the replay input. `RESOLVED`
 * means retained membership produced candidates; `EMPTY` means membership was
 * evaluated for that session and none were eligible; `NO_EVIDENCE` means no
 * completed membership snapshot was effective before the session opened. Only
 * `RESOLVED` sessions carry candidates and are replayed.
 */
export const replaySessionCandidatesSchema = z.object({
  sessionDate: z.string().date(),
  resolution: z.enum(["RESOLVED", "EMPTY", "NO_EVIDENCE"]),
  membershipRunId: z.string().uuid().nullable(),
  effectiveAt: z.string().datetime().nullable(),
  candidates: z.array(replayInputInstrumentSchema),
  reasonCodes: z.array(z.string()),
});
export type ReplaySessionCandidates = z.infer<
  typeof replaySessionCandidatesSchema
>;
export const replayInputSnapshotSchema = z.object({
  version: z.literal("replay-input-v1"),
  marketId: marketIdSchema.default("CA_TSX"),
  resolvedAt: z.string().datetime(),
  requestedSymbols: z.array(z.string()),
  candidateInstruments: z.array(replayInputInstrumentSchema),
  benchmarks: z.array(replayInputBenchmarkSchema),
  universeRefreshRunId: z.string().uuid().nullable(),
  capturedHistoryAvailability: capturedHistoryAvailabilitySchema,
  warnings: z.array(z.string()),
  /** Defaults preserve legacy snapshots written before candidate provenance. */
  candidateProvenance: replayCandidateProvenanceSchema.default(
    "CURRENT_ACTIVE_UNIVERSE",
  ),
  /** Empty for legacy snapshots, which resolved one candidate list per run. */
  sessions: z.array(replaySessionCandidatesSchema).default([]),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ReplayInputSnapshot = z.infer<typeof replayInputSnapshotSchema>;
export const backtestReplayResultSchema = z.object({
  metrics: backtestMetricsSchema,
  analyses: z.array(backtestSliceSchema),
  trades: z.array(backtestTradeSchema),
  timeline: z.array(backtestTimelineEventSchema),
  dataQuality: backtestDataQualitySchema,
});
export type BacktestReplayResult = z.infer<typeof backtestReplayResultSchema>;

export const evidenceConfidenceIntervalSchema = z.object({
  estimate: z.number().nullable(),
  lower: z.number().nullable(),
  upper: z.number().nullable(),
  confidenceLevel: z.literal(0.95),
  method: z.literal("DETERMINISTIC_BOOTSTRAP"),
  samples: z.number().int().nonnegative(),
  bootstrapSamples: z.number().int().nonnegative(),
});
export type EvidenceConfidenceInterval = z.infer<
  typeof evidenceConfidenceIntervalSchema
>;
export const evidenceSliceGateSchema = z.object({
  dimension: z.enum(["STRATEGY", "TIME_OF_DAY", "ATR_REGIME", "RVOL_REGIME"]),
  bucket: z.string(),
  trades: z.number().int().nonnegative(),
  minimumTrades: z.number().int().positive(),
  sufficient: z.boolean(),
});
export const walkForwardWindowSchema = z.object({
  index: z.number().int().positive(),
  trainStart: z.string().date(),
  trainEnd: z.string().date(),
  testStart: z.string().date(),
  testEnd: z.string().date(),
  trainTrades: z.number().int().nonnegative(),
  testTrades: z.number().int().nonnegative(),
  testExpectancy: z.number(),
  testWinRate: z.number(),
  testFalseBreakoutRate: z.number(),
});
export const portfolioRiskEvidenceSchema = z.object({
  maximumConcurrentTrades: z.number().int().nonnegative(),
  overlappingTradePairs: z.number().int().nonnegative(),
  sameSectorOverlappingPairs: z.number().int().nonnegative(),
  sameSectorOverlapRate: z.number(),
  maximumConcurrentGrossExposure: z.number().nonnegative(),
  warnings: z.array(z.string()),
});
export const backtestEvidenceReportSchema = z.object({
  evidenceVersion: z.literal("phase8-evidence-v1"),
  qualification: z.enum(["EXPLORATORY", "EVIDENCE_QUALIFIED"]),
  generatedAt: z.string().datetime(),
  minimumTradesPerSlice: z.number().int().positive(),
  uniqueSetupInstances: z.number().int().nonnegative(),
  duplicateReadyEventsExcluded: z.number().int().nonnegative(),
  expectancy: evidenceConfidenceIntervalSchema,
  winRate: evidenceConfidenceIntervalSchema,
  falseBreakoutRate: evidenceConfidenceIntervalSchema,
  sliceGates: z.array(evidenceSliceGateSchema),
  walkForward: z.array(walkForwardWindowSchema),
  portfolioRisk: portfolioRiskEvidenceSchema,
  adequateSamples: z.boolean(),
  positiveExpectancyRange: z.boolean(),
  warnings: z.array(z.string()),
});
export type BacktestEvidenceReport = z.infer<
  typeof backtestEvidenceReportSchema
>;

export const backtestRunSchema = z.object({
  id: z.string().uuid(),
  marketId: marketIdSchema.default("CA_TSX"),
  name: z.string(),
  status: backtestStatusSchema,
  startDate: z.string().date(),
  endDate: z.string().date(),
  strategies: z.array(setupStrategyNameSchema),
  symbols: z.array(z.string()),
  dataSource: z.literal("CAPTURED_QUOTES"),
  strategyVersion: z.string(),
  configVersion: z.string(),
  executionModelVersion: z.string().nullable().default(null),
  executionAssumptions: z
    .record(z.string(), z.unknown())
    .nullable()
    .default(null),
  supersedesBacktestRunId: z.string().uuid().nullable().default(null),
  startingCapital: z.number().positive(),
  positionSize: z.number().positive(),
  slippageBps: z.number().nonnegative(),
  feePerTrade: z.number().nonnegative(),
  parameters: strategyParametersSchema,
  metrics: backtestMetricsSchema.nullable(),
  analyses: z.array(backtestSliceSchema),
  dataQuality: backtestDataQualitySchema.nullable(),
  capturedHistoryAvailability: capturedHistoryAvailabilitySchema
    .nullable()
    .default(null),
  replayInput: replayInputSnapshotSchema.nullable().default(null),
  evidence: backtestEvidenceReportSchema.nullable().optional(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  trades: z.array(backtestTradeSchema).default([]),
  researchEvidence: researchEvidenceBindingSchema.nullable().optional(),
});
export type BacktestRun = z.infer<typeof backtestRunSchema>;
export const backtestRunListSchema = z.object({
  runs: z.array(backtestRunSchema),
});
export type BacktestRunList = z.infer<typeof backtestRunListSchema>;
export const backtestComparisonSchema = z.object({
  comparable: z.boolean(),
  differences: z.array(z.string()),
  runs: z.array(backtestRunSchema),
});
export type BacktestComparison = z.infer<typeof backtestComparisonSchema>;
