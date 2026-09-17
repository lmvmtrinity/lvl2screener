import { z } from "zod";
import {
  marketIdSchema,
  marketCurrencySchema,
  normalizedExchangeSchema,
} from "./markets.js";

export const discoveryModeSchema = z.enum(["OFF", "SHADOW", "AUTO_ADD"]);
export type DiscoveryMode = z.infer<typeof discoveryModeSchema>;

// Immutable v1 definitions. A policy change requires a new version/schema branch.
const semantics = {
  securityType: z.literal("COMMON_STOCK_REVIEWED"),
  priceEndpoints: z.literal("INCLUSIVE"),
  thresholdComparison: z.literal("STRICT_GREATER_THAN"),
  averageVolumeSessions: z.literal(90),
  dollarVolumeSessions: z.literal(30),
  dailyHistorySessions: z.literal(91),
  atrPeriod: z.literal(14),
  atrMethod: z.literal("WILDER_90_TRUE_RANGES_SMA_SEED_14"),
  dollarVolumeMethod: z.literal("CURRENT_PRICE_TIMES_AVERAGE_SHARES_30"),
  relativeVolumeMethod: z.literal("COMPLETED_FIVE_MINUTE_SLOT"),
  relativeVolumeSessions: z.literal(10),
  slotAlignment: z.literal("EXCHANGE_SESSION_OPEN"),
  adjustmentRule: z.literal("VERIFIED_CONSISTENT_REVISION"),
  maximumQuoteAgeMs: z.literal(30_000),
  publicationDelayMs: z.literal(15_000),
  maximumEvaluationAgeMs: z.literal(120_000),
};

export const discoveryPolicySchema = z.discriminatedUnion("marketId", [
  z
    .object({
      ...semantics,
      marketId: z.literal("CA_TSX"),
      version: z.literal("ca-discovery-v1"),
      currency: marketCurrencySchema.extract(["CAD"]),
      exchanges: z.tuple([normalizedExchangeSchema.extract(["TSX"])]),
      minimumPrice: z.literal(5),
      maximumPrice: z.literal(150),
      minimumMarketCap: z.literal(400_000_000),
      minimumAverageVolume90d: z.literal(400_000),
      minimumAtrPct: z.literal(1.5),
      minimumRelativeVolume: z.literal(1.5),
      minimumChangeFromOpenPct: z.literal(0.75),
      minimumDollarVolume30d: z.literal(15_000_000),
    })
    .strict(),
  z
    .object({
      ...semantics,
      marketId: z.literal("US_EQUITIES"),
      version: z.literal("us-discovery-v1"),
      currency: marketCurrencySchema.extract(["USD"]),
      exchanges: z.tuple([
        normalizedExchangeSchema.extract(["NYSE"]),
        normalizedExchangeSchema.extract(["NASDAQ"]),
      ]),
      minimumPrice: z.literal(10),
      maximumPrice: z.literal(200),
      minimumMarketCap: z.literal(1_000_000_000),
      minimumAverageVolume90d: z.literal(1_000_000),
      minimumAtrPct: z.literal(2),
      minimumRelativeVolume: z.literal(1.75),
      minimumChangeFromOpenPct: z.literal(1),
      minimumDollarVolume30d: z.literal(50_000_000),
    })
    .strict(),
]);
export type DiscoveryPolicy = z.infer<typeof discoveryPolicySchema>;

const commonSemantics = {
  securityType: "COMMON_STOCK_REVIEWED",
  priceEndpoints: "INCLUSIVE",
  thresholdComparison: "STRICT_GREATER_THAN",
  averageVolumeSessions: 90,
  dollarVolumeSessions: 30,
  dailyHistorySessions: 91,
  atrPeriod: 14,
  atrMethod: "WILDER_90_TRUE_RANGES_SMA_SEED_14",
  dollarVolumeMethod: "CURRENT_PRICE_TIMES_AVERAGE_SHARES_30",
  relativeVolumeMethod: "COMPLETED_FIVE_MINUTE_SLOT",
  relativeVolumeSessions: 10,
  slotAlignment: "EXCHANGE_SESSION_OPEN",
  adjustmentRule: "VERIFIED_CONSISTENT_REVISION",
  maximumQuoteAgeMs: 30_000,
  publicationDelayMs: 15_000,
  maximumEvaluationAgeMs: 120_000,
} as const;

/** Return a fresh validated value, so callers cannot mutate future policy reads. */
export function discoveryPolicyForMarket(
  marketId: z.infer<typeof marketIdSchema>,
): DiscoveryPolicy {
  marketIdSchema.parse(marketId);
  return discoveryPolicySchema.parse(
    marketId === "CA_TSX"
      ? {
          ...commonSemantics,
          marketId,
          version: "ca-discovery-v1",
          currency: "CAD",
          exchanges: ["TSX"],
          minimumPrice: 5,
          maximumPrice: 150,
          minimumMarketCap: 400_000_000,
          minimumAverageVolume90d: 400_000,
          minimumAtrPct: 1.5,
          minimumRelativeVolume: 1.5,
          minimumChangeFromOpenPct: 0.75,
          minimumDollarVolume30d: 15_000_000,
        }
      : {
          ...commonSemantics,
          marketId,
          version: "us-discovery-v1",
          currency: "USD",
          exchanges: ["NYSE", "NASDAQ"],
          minimumPrice: 10,
          maximumPrice: 200,
          minimumMarketCap: 1_000_000_000,
          minimumAverageVolume90d: 1_000_000,
          minimumAtrPct: 2,
          minimumRelativeVolume: 1.75,
          minimumChangeFromOpenPct: 1,
          minimumDollarVolume30d: 50_000_000,
        },
  );
}

export const discoveryEvaluationStateSchema = z.enum([
  "PASS",
  "FAIL",
  "UNEVALUABLE",
  "DEFERRED",
]);
export const discoveryReasonSchema = z.enum([
  "MARKET_MISMATCH",
  "EXCHANGE_NOT_ALLOWED",
  "CURRENCY_NOT_ALLOWED",
  "CLASSIFICATION_REVIEW_REQUIRED",
  "MAPPING_UNAVAILABLE",
  "CATALOG_UNAVAILABLE",
  "QUOTE_UNAVAILABLE",
  "QUOTE_STALE",
  "QUOTE_DELAYED",
  "QUOTE_HALTED",
  "OUTSIDE_REGULAR_SESSION",
  "CALENDAR_UNVERIFIED",
  "INVALID_EVALUATION_BOUNDARY",
  "INVALID_OPEN",
  "FUTURE_OBSERVATION",
  "INSUFFICIENT_DAILY_HISTORY",
  "INSUFFICIENT_SLOT_HISTORY",
  "DUPLICATE_BAR",
  "INVALID_BAR",
  "ADJUSTMENT_UNVERIFIED",
  "ZERO_SLOT_BASELINE",
  "PRICE_OUT_OF_RANGE",
  "MARKET_CAP_THRESHOLD",
  "AVERAGE_VOLUME_THRESHOLD",
  "ATR_THRESHOLD",
  "RELATIVE_VOLUME_THRESHOLD",
  "CHANGE_FROM_OPEN_THRESHOLD",
  "DOLLAR_VOLUME_THRESHOLD",
  "METADATA_UNAVAILABLE",
  "BUDGET_DEFERRED",
  "EVALUATION_EXPIRED",
  "DISCOVERY_CANCELLED",
  "PROVIDER_FAILURE",
  "MANUAL_EXCLUSION",
]);
export type DiscoveryReason = z.infer<typeof discoveryReasonSchema>;

const metricSchema = z
  .object({
    value: z.number().finite().nullable(),
    asOf: z.string().datetime().nullable(),
  })
  .strict();
export const discoveryMetricsSchema = z
  .object({
    price: metricSchema,
    marketCap: metricSchema,
    averageVolume90d: metricSchema,
    averageVolume30d: metricSchema,
    atr14: metricSchema,
    atrPct: metricSchema,
    relativeVolume: metricSchema,
    changeFromOpenPct: metricSchema,
    dollarVolume30d: metricSchema,
  })
  .strict();
export type DiscoveryMetrics = z.infer<typeof discoveryMetricsSchema>;

export const discoveryCoverageSchema = z
  .object({
    total: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    unevaluable: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (counts) =>
      counts.total ===
      counts.pass + counts.fail + counts.unevaluable + counts.deferred,
    {
      message:
        "Every catalog instrument must have an explicit coverage outcome",
    },
  );

// No ALL/default market on these routes: callers must choose an evidence domain.
export const discoveryQuerySchema = z
  .object({
    marketId: marketIdSchema,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().datetime().optional(),
  })
  .strict();
export const discoveryModeChangeSchema = z
  .object({
    marketId: marketIdSchema,
    mode: discoveryModeSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const discoveryExclusionChangeSchema = z
  .object({
    marketId: marketIdSchema,
    tradingDate: z.string().date(),
    instrumentId: z.string().uuid(),
    excluded: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const discoveryModeStateSchema = z
  .object({
    marketId: marketIdSchema,
    mode: discoveryModeSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    actor: z.string().min(1).max(200),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type DiscoveryModeState = z.infer<typeof discoveryModeStateSchema>;

export const discoverySchedulerStatusSchema = z.enum([
  "OFF",
  "MISSING_PROVIDER",
  "IDLE",
  "RUNNING",
  "DEGRADED",
]);
export type DiscoverySchedulerStatus = z.infer<
  typeof discoverySchedulerStatusSchema
>;

export const discoveryCatalogStatusSchema = z.enum([
  "UNKNOWN",
  "FRESH",
  "LAST_GOOD",
  "UNAVAILABLE",
]);

export const discoveryRequestUsageSchema = z
  .object({
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  })
  .strict();
export type DiscoveryRequestUsage = z.infer<typeof discoveryRequestUsageSchema>;

export const discoveryPerformancePhasesSchema = z
  .object({
    inputCollectionElapsedMs: z.number().int().nonnegative().nullable(),
    evaluationWorkMs: z.number().int().nonnegative().nullable(),
    serializationWorkMs: z.number().int().nonnegative().nullable(),
    persistenceWorkMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DiscoveryPerformancePhases = z.infer<
  typeof discoveryPerformancePhasesSchema
>;

export const discoveryPerformanceSchema = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    lastCycleDurationMs: z.number().int().nonnegative().nullable(),
    lastQueueLatencyMs: z.number().int().nonnegative().nullable(),
    cycleP95Ms: z.number().int().nonnegative().nullable(),
    queueP95Ms: z.number().int().nonnegative().nullable(),
    requestUsage: discoveryRequestUsageSchema,
    phases: discoveryPerformancePhasesSchema.optional(),
  })
  .strict();
export type DiscoveryPerformance = z.infer<typeof discoveryPerformanceSchema>;

const diagnosticCountSchema = z.number().int().nonnegative();
const diagnosticDurationSchema = z.number().finite().nonnegative();
const discoveryDiagnosticStageSchema = z
  .object({
    wallMs: diagnosticDurationSchema,
    cumulativeMs: diagnosticDurationSchema,
    calls: diagnosticCountSchema,
    batches: z
      .object({
        count: diagnosticCountSchema,
        minSize: diagnosticCountSchema.nullable(),
        maxSize: diagnosticCountSchema.nullable(),
        members: diagnosticCountSchema,
        uniqueSymbols: diagnosticCountSchema,
      })
      .strict(),
    cache: z
      .object({
        hit: diagnosticCountSchema,
        partialHit: diagnosticCountSchema,
        miss: diagnosticCountSchema,
      })
      .strict(),
    loadedBars: diagnosticCountSchema,
  })
  .strict();
const discoveryDiagnosticRequestSchema = z
  .object({
    queued: diagnosticCountSchema,
    dispatched: diagnosticCountSchema,
    settled: diagnosticCountSchema,
    http401Retries: diagnosticCountSchema,
    completed: diagnosticCountSchema,
    failed: diagnosticCountSchema,
    cancelled: diagnosticCountSchema,
    expired: diagnosticCountSchema,
    queueFull: diagnosticCountSchema,
    requestedItems: diagnosticCountSchema,
    queueWaitMs: diagnosticDurationSchema,
    executionMs: diagnosticDurationSchema,
  })
  .strict();

/** Aggregate-only terminal observation. No open-ended metadata or member identities. */
export const discoveryAttemptDiagnosticsDraftSchema = z
  .object({
    attemptId: z.string().uuid(),
    attemptKind: z.enum(["FRESH", "RECOVERY"]),
    marketId: marketIdSchema,
    startedAt: z.string().datetime(),
    collectionDeadlineAt: z.string().datetime(),
    wallMs: diagnosticDurationSchema,
    stages: z
      .object({
        INPUT_COLLECTION: discoveryDiagnosticStageSchema,
        MAPPING: discoveryDiagnosticStageSchema,
        ENRICHMENT: discoveryDiagnosticStageSchema,
        DAILY_HISTORY: discoveryDiagnosticStageSchema,
        SLOT_HISTORY: discoveryDiagnosticStageSchema,
        EVALUATION: discoveryDiagnosticStageSchema,
        EVIDENCE: discoveryDiagnosticStageSchema,
      })
      .strict(),
    requests: z
      .object({
        MAPPING: discoveryDiagnosticRequestSchema,
        FUNDAMENTALS: discoveryDiagnosticRequestSchema,
        QUOTE: discoveryDiagnosticRequestSchema,
        DAILY_HISTORY: discoveryDiagnosticRequestSchema,
        SLOT_HISTORY: discoveryDiagnosticRequestSchema,
      })
      .strict(),
    quoteAgeBuckets: z
      .object({
        missing: diagnosticCountSchema,
        future: diagnosticCountSchema,
        fresh: diagnosticCountSchema,
        stale: diagnosticCountSchema,
      })
      .strict(),
    reasonCounts: z.partialRecord(discoveryReasonSchema, diagnosticCountSchema),
  })
  .strict();

export const discoveryAttemptDiagnosticsSchema =
  discoveryAttemptDiagnosticsDraftSchema
    .omit({ wallMs: true, stages: true })
    .extend({
      schemaVersion: z.literal("discovery-attempt-diagnostics-v1"),
      timingBoundary: z.literal("BEFORE_COMPLETION_TRANSACTION"),
      preCompletionWallMs: diagnosticDurationSchema,
      stages: discoveryAttemptDiagnosticsDraftSchema.shape.stages
        .omit({ EVIDENCE: true })
        .extend({ PRE_COMPLETION_PERSISTENCE: discoveryDiagnosticStageSchema })
        .strict(),
      runId: z.string().uuid(),
      capturedAt: z.string().datetime(),
      frozenEvaluationAt: z.string().datetime(),
      finalRunCoverage: discoveryCoverageSchema,
    })
    .strict();
export type DiscoveryAttemptDiagnostics = z.infer<
  typeof discoveryAttemptDiagnosticsSchema
>;

const discoveryRunStatusSchema = z
  .object({
    id: z.string().uuid(),
    marketId: marketIdSchema,
    tradingDate: z.string().date(),
    policyVersion: z.enum(["ca-discovery-v1", "us-discovery-v1"]),
    mode: z.enum(["SHADOW", "AUTO_ADD"]),
    evaluationAt: z.string().datetime(),
    completedBarEnd: z.string().datetime(),
    catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["RUNNING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]),
    coverage: discoveryCoverageSchema,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    failure: z.string().max(500).nullable(),
  })
  .strict();

export const fastFunnelStatusSchema = z
  .object({
    marketId: marketIdSchema,
    enabled: z.boolean(),
    lastAcceleratedAt: z.string().datetime().nullable(),
    topMoversCount: z.number().int().nonnegative(),
    topMoverSymbols: z.array(z.string().min(1)),
    acceleratedCandidatesCount: z.number().int().nonnegative(),
    acceleratedEvaluatedCount: z.number().int().nonnegative(),
    acceleratedPassedCount: z.number().int().nonnegative(),
  })
  .strict();
export type FastFunnelStatus = z.infer<typeof fastFunnelStatusSchema>;

export const tradingViewCandidateSchema = z
  .object({
    symbol: z.string().min(1),
    exchange: z.string().min(1),
    fullSymbol: z.string().min(1),
    price: z.number().finite().nullable(),
    changeFromOpenPct: z.number().finite().nullable(),
    relativeVolume: z.number().finite().nullable(),
    averageVolume90d: z.number().finite().nullable(),
    marketCap: z.number().finite().nullable(),
    observedAt: z.string().datetime(),
  })
  .strict();
export type TradingViewCandidate = z.infer<typeof tradingViewCandidateSchema>;

export const discoveryDiscrepancyCategorySchema = z.enum([
  "FORMULA_DIFFERENCE",
  "FORMING_VS_COMPLETED_BAR",
  "VOLUME_COVERAGE",
  "TIMESTAMP_LAG",
  "CORPORATE_ACTION",
  "CLASSIFICATION_MISMATCH",
  "THRESHOLD_BOUNDARY",
  "OTHER",
]);
export type DiscoveryDiscrepancyCategory = z.infer<
  typeof discoveryDiscrepancyCategorySchema
>;

export const discoveryParityMetricDiffSchema = z
  .object({
    symbol: z.string().min(1),
    field: z.string().min(1),
    questradeValue: z.number().finite().nullable(),
    tradingViewValue: z.number().finite().nullable(),
    difference: z.number().finite().nullable(),
    pctDifference: z.number().finite().nullable(),
  })
  .strict();
export type DiscoveryParityMetricDiff = z.infer<
  typeof discoveryParityMetricDiffSchema
>;

export const discoveryParityAuditSchema = z
  .object({
    id: z.string().uuid(),
    marketId: marketIdSchema,
    tradingDate: z.string().date(),
    runId: z.string().uuid().nullable(),
    auditedAt: z.string().datetime(),
    tradingViewCount: z.number().int().nonnegative(),
    questradePassCount: z.number().int().nonnegative(),
    overlapCount: z.number().int().nonnegative(),
    overlapRatio: z.number().min(0).max(1),
    overlapSymbols: z.array(z.string().min(1)),
    missedMovers: z.array(
      z
        .object({
          symbol: z.string().min(1),
          exchange: z.string().min(1),
          tradingViewMetrics: z
            .object({
              price: z.number().nullable(),
              changeFromOpenPct: z.number().nullable(),
              relativeVolume: z.number().nullable(),
              averageVolume90d: z.number().nullable(),
              marketCap: z.number().nullable(),
            })
            .strict(),
          questradeState: discoveryEvaluationStateSchema.nullable(),
          questradeReasons: z.array(discoveryReasonSchema),
          discrepancyCategory: discoveryDiscrepancyCategorySchema,
        })
        .strict(),
    ),
    questradeOnly: z.array(
      z
        .object({
          symbol: z.string().min(1),
          exchange: z.string().min(1),
          questradeMetrics: z
            .object({
              price: z.number().nullable(),
              changeFromOpenPct: z.number().nullable(),
              relativeVolume: z.number().nullable(),
              averageVolume90d: z.number().nullable(),
              marketCap: z.number().nullable(),
            })
            .strict(),
        })
        .strict(),
    ),
    metricDifferences: z.array(discoveryParityMetricDiffSchema),
    discrepancySummary: z.record(
      discoveryDiscrepancyCategorySchema,
      z.number().int().nonnegative(),
    ),
  })
  .strict();
export type DiscoveryParityAudit = z.infer<typeof discoveryParityAuditSchema>;

export const discoveryParityStatusSchema = z
  .object({
    marketId: marketIdSchema,
    latestAudit: discoveryParityAuditSchema.nullable(),
    auditCount: z.number().int().nonnegative(),
    averageOverlapRatio: z.number().min(0).max(1).nullable(),
    lastAuditedAt: z.string().datetime().nullable(),
  })
  .strict();
export type DiscoveryParityStatus = z.infer<typeof discoveryParityStatusSchema>;

export const discoveryStatusSchema = z
  .object({
    marketId: marketIdSchema,
    mode: discoveryModeSchema,
    revision: z.number().int().nonnegative(),
    modeUpdatedAt: z.string().datetime(),
    modeActor: z.string().min(1).max(200),
    scheduler: discoverySchedulerStatusSchema,
    policy: discoveryPolicySchema,
    catalog: z
      .object({
        status: discoveryCatalogStatusSchema,
        source: z.enum(["EODHD", "MASSIVE"]).nullable(),
        tradingDate: z.string().date().nullable(),
        fetchedAt: z.string().datetime().nullable(),
        ageMs: z.number().int().nonnegative().nullable(),
        rowCount: z.number().int().nonnegative().nullable(),
        admittedCount: z.number().int().nonnegative().nullable(),
        failure: discoveryReasonSchema.nullable(),
      })
      .strict(),
    lastRun: discoveryRunStatusSchema.nullable(),
    nextEvaluationAt: z.string().datetime().nullable(),
    activeRunId: z.string().uuid().nullable(),
    queueDepth: z.number().int().nonnegative(),
    oldestQueueAgeMs: z.number().int().nonnegative(),
    lastError: z.string().max(500).nullable(),
    budget: z
      .object({
        remainingHour: z.number().int().nonnegative().nullable(),
        remainingDiscoveryHour: z.number().int().nonnegative().nullable(),
        queued: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
      })
      .strict(),
    performance: discoveryPerformanceSchema.optional(),
    latestAttemptDiagnostics: discoveryAttemptDiagnosticsSchema
      .nullable()
      .optional(),
    fastFunnel: fastFunnelStatusSchema.optional(),
    parity: discoveryParityStatusSchema.optional(),
  })
  .strict();
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;

export const discoveryPreviewSchema = z
  .object({
    marketId: marketIdSchema,
    completedBarEnd: z.string().datetime().optional(),
  })
  .strict();
export type DiscoveryPreview = z.infer<typeof discoveryPreviewSchema>;

export const discoveryParityCompareSchema = z
  .object({
    marketId: marketIdSchema,
    runId: z.string().uuid().optional(),
  })
  .strict();
export type DiscoveryParityCompare = z.infer<
  typeof discoveryParityCompareSchema
>;
