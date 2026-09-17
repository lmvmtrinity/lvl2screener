import { createHash } from "node:crypto";
import { z } from "zod";
import { marketIdSchema } from "@tsx-scanner/contracts";

/** Frozen verification protocol revision. Changing criteria requires a new revision. */
export const ADJUSTMENT_VERIFICATION_REVISION =
  "questrade-adjustment-verification-v2" as const;

export const adjustmentVerificationCriteriaSchema = z
  .object({
    revision: z.string().min(1),
    /** Relative tolerance for price/volume reconciliation (0.005 = 0.5%). */
    priceTolerance: z.number().positive().max(0.25),
    volumeTolerance: z.number().positive().max(0.25),
    /** Every used interval must agree on the adjustment basis. */
    requireCrossIntervalConsistency: z.literal(true),
  })
  .strict();
export type AdjustmentVerificationCriteria = z.infer<
  typeof adjustmentVerificationCriteriaSchema
>;

export const DEFAULT_ADJUSTMENT_CRITERIA: AdjustmentVerificationCriteria = {
  revision: ADJUSTMENT_VERIFICATION_REVISION,
  priceTolerance: 0.005,
  volumeTolerance: 0.005,
  requireCrossIntervalConsistency: true,
};

export const VERIFICATION_INTERVALS = [
  "OneDay",
  "FiveMinutes",
  "OneMinute",
] as const;
export type VerificationInterval = (typeof VERIFICATION_INTERVALS)[number];

const corporateActionTypeSchema = z.enum([
  "SPLIT",
  "REVERSE_SPLIT",
  "STOCK_DIVIDEND",
  "CASH_DIVIDEND",
  "CONTROL",
]);

/**
 * Reference corporate action. `priceFactor` is the multiplier the vendor
 * applies to pre-event prices when adjusting (1/shareFactor for splits and
 * reverse splits; the EODHD dividend adjustment factor for cash dividends).
 * `volumeFactor` is the multiplier applied to pre-event volumes
 * (1/priceFactor under a split-adjusted series).
 */
export const corporateActionSampleSchema = z
  .object({
    marketId: marketIdSchema,
    symbol: z.string().min(1).max(100),
    exchange: z.string().min(1).max(50),
    type: corporateActionTypeSchema,
    effectiveDate: z.string().date(),
    priceFactor: z.number().positive().max(10_000),
    volumeFactor: z.number().positive().max(10_000),
    source: z.enum(["EODHD", "MASSIVE"]),
    sourceObservedAt: z.string().datetime(),
  })
  .strict();
export type CorporateActionSample = z.infer<typeof corporateActionSampleSchema>;

export const boundaryBarSchema = z
  .object({
    start: z.string().datetime(),
    close: z.number().finite().positive(),
    volume: z.number().finite().nonnegative(),
  })
  .strict();
export type BoundaryBar = z.infer<typeof boundaryBarSchema>;

/** Frozen sample role. Part of the sample identity key. */
export type SampleRole = "ACTION" | "CONTROL";

/** A frozen sample plus its role; the identity used to bind observations. */
export interface IdentifiedSample {
  sample: CorporateActionSample;
  role: SampleRole;
}

/**
 * Content key for one frozen sample. Observations and series revisions must
 * carry this exact key so two same-symbol actions on different dates can never
 * share observations or price factors. Legacy persisted records that predate the
 * key remain unkeyed until retained identity/window evidence proves a binding.
 */
export function sampleIdentityKey(
  sample: CorporateActionSample,
  role: SampleRole,
): string {
  return JSON.stringify([
    sample.marketId,
    sample.symbol,
    sample.exchange,
    sample.type,
    sample.effectiveDate,
    sample.source,
    role,
  ]);
}

export const sampleObservationSchema = z
  .object({
    /** Exact {@link sampleIdentityKey} of the frozen sample this observed. */
    sampleKey: z.string().min(1),
    symbol: z.string().min(1),
    interval: z.enum(VERIFICATION_INTERVALS),
    pre: boundaryBarSchema,
    post: boundaryBarSchema,
    retrievedAt: z.string().datetime(),
  })
  .strict();
export type SampleObservation = z.infer<typeof sampleObservationSchema>;

export type BoundaryClassification =
  "ADJUSTED" | "UNADJUSTED" | "INDISTINCT" | "INCONSISTENT";

export interface SampleEvaluation {
  sampleKey: string;
  symbol: string;
  type: CorporateActionSample["type"];
  effectiveDate: string;
  intervalResults: Array<{
    interval: VerificationInterval;
    price: BoundaryClassification;
    volume: BoundaryClassification;
  }>;
  priceBasis: BoundaryClassification;
  volumeBasis: BoundaryClassification;
  passed: boolean;
  failures: string[];
}

export interface VerificationReport {
  protocolRevision: string;
  sampleSetRevision: string;
  status: "PASS" | "STOP";
  sampleCount: number;
  passedSamples: number;
  failedSamples: number;
  priceBasis: BoundaryClassification | "MIXED" | null;
  volumeBasis: BoundaryClassification | "MIXED" | null;
  evaluations: SampleEvaluation[];
}

export function sampleSetRevision(
  samples: readonly CorporateActionSample[],
): string {
  return createHash("sha256").update(JSON.stringify(samples)).digest("hex");
}

/**
 * Content-addressed revision for a retained historical bar window. A provider
 * revision changes this value, which invalidates any baseline derived from the
 * previous revision.
 */
export function barSeriesRevision(
  bars: readonly {
    start: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[],
): string {
  const canonical = [...bars]
    .sort((left, right) => left.start.localeCompare(right.start))
    .map((bar) => [
      bar.start,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
    ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface SeriesRevisionChange {
  changedBars: number;
  addedBars: number;
  removedBars: number;
}

export function detectSeriesRevisionChange(
  previous: readonly {
    start: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[],
  current: readonly {
    start: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[],
): SeriesRevisionChange {
  const before = new Map(previous.map((bar) => [bar.start, bar]));
  const after = new Map(current.map((bar) => [bar.start, bar]));
  let changedBars = 0;
  let addedBars = 0;
  let removedBars = 0;
  for (const [start, bar] of after) {
    const prior = before.get(start);
    if (!prior) addedBars += 1;
    else if (
      prior.open !== bar.open ||
      prior.high !== bar.high ||
      prior.low !== bar.low ||
      prior.close !== bar.close ||
      prior.volume !== bar.volume
    )
      changedBars += 1;
  }
  for (const start of before.keys()) if (!after.has(start)) removedBars += 1;
  return { changedBars, addedBars, removedBars };
}

function withinTolerance(ratio: number, target: number, tolerance: number) {
  return Math.abs(ratio - target) <= tolerance * Math.max(1, target);
}

function classifyRatio(
  ratio: number,
  adjustedTarget: number,
  unadjustedTarget: number,
  tolerance: number,
): BoundaryClassification {
  const adjusted = withinTolerance(ratio, adjustedTarget, tolerance);
  const unadjusted = withinTolerance(ratio, unadjustedTarget, tolerance);
  if (adjusted && unadjusted) return "INDISTINCT";
  if (adjusted) return "ADJUSTED";
  if (unadjusted) return "UNADJUSTED";
  return "INCONSISTENT";
}

function mergeBasis(
  classifications: BoundaryClassification[],
): BoundaryClassification {
  const meaningful = classifications.filter((value) => value !== "INDISTINCT");
  if (meaningful.includes("INCONSISTENT")) return "INCONSISTENT";
  if (meaningful.length === 0) return "INDISTINCT";
  const unique = new Set(meaningful);
  return unique.size === 1 ? meaningful[0]! : "INCONSISTENT";
}

/**
 * Evaluate one corporate-action sample across the three intervals. Only
 * observations carrying this sample's exact identity key are used, so one
 * action can never borrow another same-symbol action's observations or price
 * basis. Multiple observations for the same identity and interval are
 * ambiguous and fail closed rather than selecting the first one.
 */
export function evaluateAdjustmentSample(
  identified: IdentifiedSample,
  observations: readonly SampleObservation[],
  criteria: AdjustmentVerificationCriteria = DEFAULT_ADJUSTMENT_CRITERIA,
): SampleEvaluation {
  const sample = identified.sample;
  const sampleKey = sampleIdentityKey(sample, identified.role);
  const failures: string[] = [];
  const intervalResults: SampleEvaluation["intervalResults"] = [];
  for (const interval of VERIFICATION_INTERVALS) {
    const matching = observations.filter(
      (value) =>
        value.interval === interval &&
        value.symbol === sample.symbol &&
        value.sampleKey === sampleKey,
    );
    if (matching.length === 0) {
      failures.push(`MISSING_INTERVAL:${interval}`);
      continue;
    }
    if (matching.length > 1) {
      failures.push(`AMBIGUOUS_INTERVAL:${interval}`);
      continue;
    }
    const observation = matching[0]!;
    const price = classifyRatio(
      observation.pre.close / observation.post.close,
      1,
      1 / sample.priceFactor,
      criteria.priceTolerance,
    );
    const volumeRatio =
      observation.pre.volume === 0 && observation.post.volume === 0
        ? 1
        : observation.post.volume === 0
          ? Number.POSITIVE_INFINITY
          : observation.pre.volume / observation.post.volume;
    const volume = classifyRatio(
      volumeRatio,
      sample.volumeFactor,
      1,
      criteria.volumeTolerance,
    );
    if (price === "INCONSISTENT")
      failures.push(`PRICE_UNEXPLAINED:${interval}`);
    if (volume === "INCONSISTENT")
      failures.push(`VOLUME_UNEXPLAINED:${interval}`);
    intervalResults.push({ interval, price, volume });
  }
  const priceBasis = mergeBasis(intervalResults.map((value) => value.price));
  const volumeBasis = mergeBasis(intervalResults.map((value) => value.volume));
  if (criteria.requireCrossIntervalConsistency) {
    if (priceBasis === "INCONSISTENT") failures.push("PRICE_BASIS_MISMATCH");
    if (volumeBasis === "INCONSISTENT") failures.push("VOLUME_BASIS_MISMATCH");
  }
  if (sample.type === "CONTROL" && priceBasis === "INCONSISTENT")
    failures.push("CONTROL_UNEXPLAINED_MOVE");
  return {
    sampleKey,
    symbol: sample.symbol,
    type: sample.type,
    effectiveDate: sample.effectiveDate,
    intervalResults,
    priceBasis,
    volumeBasis,
    passed: failures.length === 0,
    failures: [...new Set(failures)],
  };
}

export function evaluateAdjustmentVerification(
  identifiedSamples: readonly IdentifiedSample[],
  observations: readonly SampleObservation[],
  criteria: AdjustmentVerificationCriteria = DEFAULT_ADJUSTMENT_CRITERIA,
): VerificationReport {
  const evaluations = identifiedSamples.map((record) =>
    evaluateAdjustmentSample(record, observations, criteria),
  );
  const identityCounts = new Map<string, number>();
  for (const evaluation of evaluations)
    identityCounts.set(
      evaluation.sampleKey,
      (identityCounts.get(evaluation.sampleKey) ?? 0) + 1,
    );
  for (const evaluation of evaluations) {
    if ((identityCounts.get(evaluation.sampleKey) ?? 0) > 1) {
      evaluation.failures = [
        ...new Set([...evaluation.failures, "DUPLICATE_SAMPLE_IDENTITY"]),
      ];
      evaluation.passed = false;
    }
  }
  const actionEvaluations = evaluations.filter(
    (value) => value.type !== "CONTROL",
  );
  const bases = new Set(
    actionEvaluations.map((value) => value.priceBasis).filter(Boolean),
  );
  const volumeBases = new Set(
    actionEvaluations.map((value) => value.volumeBasis).filter(Boolean),
  );
  return {
    protocolRevision: criteria.revision,
    sampleSetRevision: sampleSetRevision(
      identifiedSamples.map((record) => record.sample),
    ),
    status: evaluations.every((value) => value.passed) ? "PASS" : "STOP",
    sampleCount: evaluations.length,
    passedSamples: evaluations.filter((value) => value.passed).length,
    failedSamples: evaluations.filter((value) => !value.passed).length,
    priceBasis:
      bases.size === 0 ? null : bases.size === 1 ? [...bases][0]! : "MIXED",
    volumeBasis:
      volumeBases.size === 0
        ? null
        : volumeBases.size === 1
          ? [...volumeBases][0]!
          : "MIXED",
    evaluations,
  };
}
