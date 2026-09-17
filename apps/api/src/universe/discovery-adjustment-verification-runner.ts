import type { Candle, MarketDataAdapter } from "../questrade/types.js";
import type { CatalogMember } from "./eodhd-catalog.js";
import type { EodhdCorporateActionClient } from "./eodhd-corporate-actions.js";
import {
  DEFAULT_ADJUSTMENT_CRITERIA,
  VERIFICATION_INTERVALS,
  barSeriesRevision,
  evaluateAdjustmentVerification,
  sampleIdentityKey,
  sampleSetRevision,
  type BoundaryBar,
  type CorporateActionSample,
  type IdentifiedSample,
  type SampleObservation,
  type SampleRole,
  type VerificationInterval,
  type VerificationReport,
} from "./discovery-adjustment-verification.js";
import { marketIdSchema, type MarketId } from "@tsx-scanner/contracts";

export const VERIFICATION_WINDOW_DAYS = 600;
export const VERIFICATION_ROUNDS = 3;
export const CONTROL_COUNT = 12;
export const MAX_DIVIDEND_SAMPLES = 100;
export const MINIMUM_SPLIT_SAMPLES = 3;
export const MINIMUM_DIVIDEND_SAMPLES = 10;

export interface VerificationSampleRecord {
  sample: CorporateActionSample;
  /** Cash amount for dividend samples; price factor is derived per round. */
  cashAmount: number | null;
  role: SampleRole;
}

export interface FrozenSampleSet {
  protocolRevision: string;
  marketId: MarketId;
  windowDays: number;
  windowStart: string;
  frozenAt: string;
  revision: string;
  samples: VerificationSampleRecord[];
  limitations: string[];
}

export interface RoundSeriesRevision {
  /**
   * Frozen sample identity, including the corporate-action date/type. Absent on
   * rounds persisted before `37763fe`; those entries are only comparable when
   * retained identity/window evidence proves a unique frozen-sample binding.
   */
  sampleKey?: string;
  symbol: string;
  interval: VerificationInterval;
  sampleType?: CorporateActionSample["type"];
  effectiveDate?: string;
  role?: VerificationSampleRecord["role"];
  windowStart?: string;
  windowEnd?: string;
  /** Content hash over bars fully formed at the round-1 boundary only. */
  revision: string;
  /** Bars fully formed at the round-1 boundary used for comparison. */
  barCount: number;
  /** All bars returned by this round's fetch window, including later ones. */
  fetchedBarCount: number;
}

export interface RoundRevisionFinding {
  sampleKey: string;
  symbol: string;
  interval: VerificationInterval;
  sampleType: CorporateActionSample["type"];
  effectiveDate: string;
  role: VerificationSampleRecord["role"];
  windowStart: string;
  windowEnd: string;
  previousRevision: string;
  currentRevision: string;
  explainedByAction: boolean;
}

function sampleRevisionKey(record: VerificationSampleRecord): string {
  return sampleIdentityKey(record.sample, record.role);
}

/**
 * Observable outcome of comparing one round's retained series against its
 * predecessor. `INCOMPATIBLE` means the baseline cannot prove a comparison:
 * legacy unkeyed entries, ambiguous identity, a missing series or a missing
 * baseline. An incompatible comparison can never establish an unchanged
 * history, so it blocks an empirical PASS.
 */
export interface RoundRevisionComparison {
  /** The later round this comparison establishes a baseline for. */
  round: number;
  status: "BASELINE" | "COMPARED" | "INCOMPATIBLE";
  previousRound: number;
  previousEntries: number;
  currentEntries: number;
  /** Previous entries consumed by exactly one current entry. */
  matched: number;
  unmatchedPrevious: number;
  unmatchedCurrent: number;
  /** Previous entries that predate the identity key. */
  legacyEntries: number;
  findings: number;
  reasons: string[];
}

export interface VerificationRound {
  round: number;
  marketId: MarketId;
  collectedAt: string;
  /**
   * Collection boundary fixed at round 1. Only bars fully formed by this
   * instant are compared across rounds; bars added afterwards are expected
   * window growth, not provider restatements.
   */
  observedThrough: string;
  observations: SampleObservation[];
  seriesRevisions: RoundSeriesRevision[];
  missing: string[];
  revisionFindings: RoundRevisionFinding[];
  /** Absent on rounds persisted before `37763fe`; recomputed on demand. */
  revisionComparison?: RoundRevisionComparison;
}

export interface StoredVerificationReport {
  status: "PASS" | "STOP";
  report: VerificationReport;
  revisionFindings: RoundRevisionFinding[];
  /** Comparison coverage recorded when the report was finalized. */
  comparisons?: RoundRevisionComparison[];
  blockers?: string[];
}

export interface StoredVerificationEvidence {
  protocolRevision: string;
  sampleSet: FrozenSampleSet | null;
  rounds: VerificationRound[];
  report: StoredVerificationReport | null;
}

export interface VerificationEvidence {
  protocolRevision: string;
  sampleSet: FrozenSampleSet;
  rounds: VerificationRound[];
  report: StoredVerificationReport | null;
}

function dateInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Last completed bar before the effective date and first bar on/after it. */
export function extractBoundary(
  bars: readonly Candle[],
  effectiveDate: string,
  timezone: string,
): { pre: BoundaryBar; post: BoundaryBar } | null {
  const completed = bars
    .filter((bar) => bar.isComplete)
    .sort((left, right) => left.start.getTime() - right.start.getTime());
  const before = completed.filter(
    (bar) => dateInTimezone(bar.start, timezone) < effectiveDate,
  );
  const after = completed.filter(
    (bar) => dateInTimezone(bar.start, timezone) >= effectiveDate,
  );
  const pre = before.at(-1);
  const post = after[0];
  if (!pre || !post || pre.close <= 0 || post.close <= 0) return null;
  return {
    pre: {
      start: pre.start.toISOString(),
      close: pre.close,
      volume: pre.volume,
    },
    post: {
      start: post.start.toISOString(),
      close: post.close,
      volume: post.volume,
    },
  };
}

const INTERVAL_RANGE_DAYS: Record<VerificationInterval, number> = {
  OneDay: 20,
  FiveMinutes: 3,
  OneMinute: 3,
};

function seriesWindow(
  interval: VerificationInterval,
  effectiveDate: string,
): { windowStart: string; windowEnd: string } {
  const effective = new Date(`${effectiveDate}T00:00:00Z`);
  const spread = INTERVAL_RANGE_DAYS[interval];
  return {
    windowStart: addDays(effective, -spread).toISOString(),
    windowEnd: addDays(effective, spread).toISOString(),
  };
}

/**
 * Bind a legacy revision entry to a frozen sample only when its retained
 * identity and window prove exactly one mapping. Entries that only carry
 * symbol/interval cannot prove which same-symbol action they describe and stay
 * unbound; the comparison is then explicitly incompatible rather than treating
 * zero matched comparisons as unchanged history.
 */
function bindLegacySeriesRevision(
  entry: RoundSeriesRevision,
  sampleSet: FrozenSampleSet | undefined,
): string | null {
  if (
    !sampleSet ||
    !entry.sampleType ||
    !entry.effectiveDate ||
    !entry.role ||
    !entry.windowStart ||
    !entry.windowEnd
  )
    return null;
  const candidates = sampleSet.samples.filter((record) => {
    const sample = record.sample;
    if (
      sample.symbol !== entry.symbol ||
      sample.type !== entry.sampleType ||
      sample.effectiveDate !== entry.effectiveDate ||
      record.role !== entry.role
    )
      return false;
    const window = seriesWindow(entry.interval, sample.effectiveDate);
    return (
      window.windowStart === entry.windowStart &&
      window.windowEnd === entry.windowEnd
    );
  });
  if (candidates.length !== 1) return null;
  const bound = candidates[0]!;
  const key = sampleIdentityKey(bound.sample, bound.role);
  const sameKey = sampleSet.samples.filter(
    (record) => sampleIdentityKey(record.sample, record.role) === key,
  );
  return sameKey.length === 1 ? key : null;
}

export function compareRoundRevisions(
  previous: VerificationRound,
  current: VerificationRound,
  sampleSet?: FrozenSampleSet,
): RoundRevisionComparison {
  return compareRoundRevisionsDetailed(previous, current, sampleSet).comparison;
}

export function revisionsForRound(
  previous: VerificationRound,
  current: VerificationRound,
  sampleSet?: FrozenSampleSet,
): RoundRevisionFinding[] {
  return compareRoundRevisionsDetailed(previous, current, sampleSet).findings;
}

function compareRoundRevisionsDetailed(
  previous: VerificationRound,
  current: VerificationRound,
  sampleSet?: FrozenSampleSet,
): { comparison: RoundRevisionComparison; findings: RoundRevisionFinding[] } {
  const reasons: string[] = [];
  const previousByKey = new Map<string, RoundSeriesRevision>();
  let legacyEntries = 0;
  let unboundLegacy = 0;
  for (const entry of previous.seriesRevisions) {
    if (entry.sampleKey) {
      previousByKey.set(`${entry.sampleKey}\u0000${entry.interval}`, entry);
      continue;
    }
    legacyEntries += 1;
    const boundKey = bindLegacySeriesRevision(entry, sampleSet);
    if (boundKey)
      previousByKey.set(`${boundKey}\u0000${entry.interval}`, entry);
    else unboundLegacy += 1;
  }

  const consumedPrevious = new Set<RoundSeriesRevision>();
  const findings: RoundRevisionFinding[] = [];
  let matched = 0;
  let unmatchedCurrent = 0;
  let duplicateCurrent = 0;
  for (const entry of current.seriesRevisions) {
    if (!entry.sampleKey) {
      unmatchedCurrent += 1;
      continue;
    }
    const previousEntry = previousByKey.get(
      `${entry.sampleKey}\u0000${entry.interval}`,
    );
    if (!previousEntry || consumedPrevious.has(previousEntry)) {
      if (previousEntry) duplicateCurrent += 1;
      unmatchedCurrent += 1;
      continue;
    }
    consumedPrevious.add(previousEntry);
    matched += 1;
    if (previousEntry.revision !== entry.revision && entry.sampleType) {
      findings.push({
        sampleKey: entry.sampleKey,
        symbol: entry.symbol,
        interval: entry.interval,
        sampleType: entry.sampleType,
        effectiveDate: entry.effectiveDate ?? "",
        role: entry.role ?? "ACTION",
        windowStart: entry.windowStart ?? "",
        windowEnd: entry.windowEnd ?? "",
        previousRevision: previousEntry.revision,
        currentRevision: entry.revision,
        explainedByAction: entry.role === "ACTION",
      });
    }
  }

  const unmatchedPrevious =
    previous.seriesRevisions.length - consumedPrevious.size;
  if (unboundLegacy > 0)
    reasons.push(`LEGACY_IDENTITY_UNAVAILABLE:${unboundLegacy}`);
  if (unmatchedPrevious - unboundLegacy > 0)
    reasons.push(
      `PREVIOUS_SERIES_NOT_COMPARED:${unmatchedPrevious - unboundLegacy}`,
    );
  if (unmatchedCurrent > 0)
    reasons.push(`MISSING_BASELINE_SERIES:${unmatchedCurrent}`);
  if (duplicateCurrent > 0)
    reasons.push(`DUPLICATE_CURRENT_SERIES:${duplicateCurrent}`);
  const comparable = unmatchedPrevious === 0 && unmatchedCurrent === 0;
  const comparison: RoundRevisionComparison = {
    round: current.round,
    status:
      current.round <= 1
        ? "BASELINE"
        : comparable
          ? "COMPARED"
          : "INCOMPATIBLE",
    previousRound: previous.round,
    previousEntries: previous.seriesRevisions.length,
    currentEntries: current.seriesRevisions.length,
    matched,
    unmatchedPrevious,
    unmatchedCurrent,
    legacyEntries,
    findings: findings.length,
    reasons,
  };
  return { comparison, findings };
}

export interface RoundRevisionReview {
  comparisons: RoundRevisionComparison[];
  /** Findings recomputed from the retained rounds, including legacy baselines. */
  findings: RoundRevisionFinding[];
}

/**
 * Recompute comparison coverage and findings for every adjacent pair of retained
 * rounds from the retained series revisions themselves. Finalization must use
 * these recomputed findings: persisted `revisionFindings` can be empty for
 * rounds written by earlier code or for legacy baselines whose comparison is
 * only recoverable now.
 */
export function reviewRoundRevisions(
  sampleSet: FrozenSampleSet | undefined,
  rounds: readonly VerificationRound[],
): RoundRevisionReview {
  const comparisons: RoundRevisionComparison[] = [];
  const findings: RoundRevisionFinding[] = [];
  for (let index = 1; index < rounds.length; index += 1) {
    const compared = compareRoundRevisionsDetailed(
      rounds[index - 1]!,
      rounds[index]!,
      sampleSet,
    );
    comparisons.push(compared.comparison);
    findings.push(...compared.findings);
  }
  return { comparisons, findings };
}

/** Comparison coverage for each adjacent pair of retained rounds. */
export function revisionComparisons(
  sampleSet: FrozenSampleSet | undefined,
  rounds: readonly VerificationRound[],
): RoundRevisionComparison[] {
  return reviewRoundRevisions(sampleSet, rounds).comparisons;
}

function revisionFindingKey(finding: RoundRevisionFinding): string {
  return JSON.stringify([
    finding.sampleKey,
    finding.symbol,
    finding.interval,
    finding.sampleType,
    finding.effectiveDate,
    finding.role,
    finding.previousRevision,
    finding.currentRevision,
  ]);
}

function dedupeRevisionFindings(
  findings: readonly RoundRevisionFinding[],
): RoundRevisionFinding[] {
  const seen = new Set<string>();
  const result: RoundRevisionFinding[] = [];
  for (const finding of findings) {
    const key = revisionFindingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`PERSISTED_VERIFICATION_EVIDENCE_INVALID:${label}`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`PERSISTED_VERIFICATION_EVIDENCE_INVALID:${label}`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new Error(`PERSISTED_VERIFICATION_EVIDENCE_INVALID:${label}`);
  return value;
}

/**
 * Validate a persisted evidence file without inventing identity. Legacy
 * observations and series revisions that predate the identity key are retained
 * unkeyed; they are never assigned a fabricated `sampleKey`. Structural
 * corruption fails visibly instead of silently degrading to empty evidence.
 */
export function parseVerificationEvidence(
  raw: unknown,
): StoredVerificationEvidence {
  const value = requireObject(raw, "root");
  const protocolRevision = optionalString(
    value.protocolRevision,
    "protocolRevision",
  );
  if (!protocolRevision)
    throw new Error("PERSISTED_VERIFICATION_EVIDENCE_INVALID:protocolRevision");
  const sampleSet =
    value.sampleSet === null || value.sampleSet === undefined
      ? null
      : (requireObject(
          value.sampleSet,
          "sampleSet",
        ) as unknown as FrozenSampleSet);
  if (sampleSet) {
    requireArray(sampleSet.samples, "sampleSet.samples");
    if (typeof sampleSet.protocolRevision !== "string")
      throw new Error(
        "PERSISTED_VERIFICATION_EVIDENCE_INVALID:sampleSet.protocolRevision",
      );
    if (sampleSet.protocolRevision !== protocolRevision)
      throw new Error(
        "PERSISTED_VERIFICATION_EVIDENCE_INVALID:sampleSet.protocolRevision",
      );
  }
  const rounds = requireArray(value.rounds, "rounds").map(
    (entry, index): VerificationRound => {
      const round = requireObject(entry, `rounds[${index}]`);
      if (typeof round.round !== "number")
        throw new Error(
          `PERSISTED_VERIFICATION_EVIDENCE_INVALID:rounds[${index}].round`,
        );
      const observations = requireArray(
        round.observations,
        `rounds[${index}].observations`,
      ).map((observation, observationIndex): SampleObservation => {
        const parsed = requireObject(
          observation,
          `rounds[${index}].observations[${observationIndex}]`,
        );
        const sampleKey = optionalString(
          parsed.sampleKey,
          `rounds[${index}].observations[${observationIndex}].sampleKey`,
        );
        return {
          ...(sampleKey ? { sampleKey } : {}),
          symbol: String(parsed.symbol),
          interval: parsed.interval as VerificationInterval,
          pre: parsed.pre as SampleObservation["pre"],
          post: parsed.post as SampleObservation["post"],
          retrievedAt: String(parsed.retrievedAt),
        } as SampleObservation;
      });
      const seriesRevisions = requireArray(
        round.seriesRevisions,
        `rounds[${index}].seriesRevisions`,
      ).map((revision, revisionIndex): RoundSeriesRevision => {
        const parsed = requireObject(
          revision,
          `rounds[${index}].seriesRevisions[${revisionIndex}]`,
        );
        const sampleKey = optionalString(
          parsed.sampleKey,
          `rounds[${index}].seriesRevisions[${revisionIndex}].sampleKey`,
        );
        if (
          typeof parsed.symbol !== "string" ||
          typeof parsed.interval !== "string" ||
          typeof parsed.revision !== "string"
        )
          throw new Error(
            `PERSISTED_VERIFICATION_EVIDENCE_INVALID:rounds[${index}].seriesRevisions[${revisionIndex}]`,
          );
        return {
          ...(sampleKey ? { sampleKey } : {}),
          symbol: parsed.symbol,
          interval: parsed.interval as VerificationInterval,
          ...(optionalString(parsed.sampleType, "sampleType")
            ? { sampleType: parsed.sampleType as CorporateActionSample["type"] }
            : {}),
          ...(optionalString(parsed.effectiveDate, "effectiveDate")
            ? { effectiveDate: parsed.effectiveDate as string }
            : {}),
          ...(optionalString(parsed.role, "role")
            ? { role: parsed.role as SampleRole }
            : {}),
          ...(optionalString(parsed.windowStart, "windowStart")
            ? { windowStart: parsed.windowStart as string }
            : {}),
          ...(optionalString(parsed.windowEnd, "windowEnd")
            ? { windowEnd: parsed.windowEnd as string }
            : {}),
          revision: parsed.revision,
          barCount: Number(parsed.barCount ?? 0),
          fetchedBarCount: Number(parsed.fetchedBarCount ?? 0),
        };
      });
      const missing = requireArray(
        round.missing,
        `rounds[${index}].missing`,
      ).map((item) => String(item));
      const revisionFindings = requireArray(
        round.revisionFindings,
        `rounds[${index}].revisionFindings`,
      ) as unknown as RoundRevisionFinding[];
      return {
        round: round.round,
        marketId: round.marketId as MarketId,
        collectedAt: String(round.collectedAt),
        observedThrough: String(
          round.observedThrough ?? round.collectedAt ?? "",
        ),
        observations,
        seriesRevisions,
        missing,
        revisionFindings,
      };
    },
  );
  let report: StoredVerificationReport | null = null;
  if (value.report !== null && value.report !== undefined) {
    const parsedReport = requireObject(value.report, "report");
    if (
      (parsedReport.status !== "PASS" && parsedReport.status !== "STOP") ||
      typeof parsedReport.report !== "object" ||
      parsedReport.report === null
    )
      throw new Error("PERSISTED_VERIFICATION_EVIDENCE_INVALID:report");
    report = {
      status: parsedReport.status,
      report: parsedReport.report as VerificationReport,
      revisionFindings: requireArray(
        parsedReport.revisionFindings ?? [],
        "report.revisionFindings",
      ) as unknown as RoundRevisionFinding[],
      ...(Array.isArray(parsedReport.comparisons)
        ? {
            comparisons:
              parsedReport.comparisons as unknown as RoundRevisionComparison[],
          }
        : {}),
      ...(Array.isArray(parsedReport.blockers)
        ? { blockers: parsedReport.blockers.map((item) => String(item)) }
        : {}),
    };
  }
  return { protocolRevision, sampleSet, rounds, report };
}

export interface BuildMassiveSampleSetDeps {
  members: readonly CatalogMember[];
  client: {
    splits(
      from: string,
      to: string,
    ): Promise<
      Array<{
        ticker: string;
        executionDate: string;
        priceFactor: number;
        volumeFactor: number;
        adjustmentType: string | null;
      }>
    >;
    dividends(
      from: string,
      to: string,
    ): Promise<
      Array<{
        ticker: string;
        exDividendDate: string;
        cashAmount: number;
        currency: string;
      }>
    >;
  };
  now: Date;
  logger?: (fields: Record<string, unknown>) => void;
}

/**
 * US reference sample set from Massive's bulk corporate-action endpoints.
 * Queries are ticker-optional and paginated, so the whole window is retrieved
 * in a few requests and reconciled against the admitted US universe.
 */
export async function buildMassiveUsSampleSet(
  deps: BuildMassiveSampleSetDeps,
): Promise<FrozenSampleSet> {
  const marketId: MarketId = "US_EQUITIES";
  const timezone = "America/New_York";
  const today = dateInTimezone(deps.now, timezone);
  const windowStart = addDays(deps.now, -VERIFICATION_WINDOW_DAYS);
  const windowStartDate = dateInTimezone(windowStart, timezone);
  const admitted = deps.members.filter((member) => member.reasons.length === 0);
  const memberCodes = new Set(admitted.map((member) => member.providerCode));
  const [splits, dividends] = await Promise.all([
    deps.client.splits(windowStartDate, today),
    deps.client.dividends(windowStartDate, today),
  ]);

  const samples: VerificationSampleRecord[] = [];
  const actionSymbols = new Set<string>();
  let unmatchedSplits = 0;
  let unmatchedDividends = 0;
  for (const split of splits) {
    if (!memberCodes.has(split.ticker)) {
      unmatchedSplits += 1;
      continue;
    }
    actionSymbols.add(split.ticker);
    const type =
      split.adjustmentType === "stock_dividend"
        ? "STOCK_DIVIDEND"
        : split.priceFactor > 1
          ? "REVERSE_SPLIT"
          : "SPLIT";
    samples.push({
      sample: {
        marketId,
        symbol: split.ticker,
        exchange: "US",
        type,
        effectiveDate: split.executionDate,
        priceFactor: split.priceFactor,
        volumeFactor: split.volumeFactor,
        source: "MASSIVE",
        sourceObservedAt: deps.now.toISOString(),
      },
      cashAmount: null,
      role: "ACTION",
    });
  }

  const dividendCandidates: VerificationSampleRecord[] = [];
  for (const dividend of dividends) {
    if (!memberCodes.has(dividend.ticker)) {
      unmatchedDividends += 1;
      continue;
    }
    actionSymbols.add(dividend.ticker);
    dividendCandidates.push({
      sample: {
        marketId,
        symbol: dividend.ticker,
        exchange: "US",
        type: "CASH_DIVIDEND",
        effectiveDate: dividend.exDividendDate,
        priceFactor: 1,
        volumeFactor: 1,
        source: "MASSIVE",
        sourceObservedAt: deps.now.toISOString(),
      },
      cashAmount: dividend.cashAmount,
      role: "ACTION",
    });
  }
  const totalDividends = dividendCandidates.length;
  const selectedDividends =
    totalDividends <= MAX_DIVIDEND_SAMPLES
      ? dividendCandidates
      : Array.from(
          { length: MAX_DIVIDEND_SAMPLES },
          (_, index) =>
            dividendCandidates[
              Math.floor(
                ((index + 0.5) * totalDividends) / MAX_DIVIDEND_SAMPLES,
              )
            ]!,
        );
  samples.push(...selectedDividends);

  const controls = admitted
    .filter((member) => !actionSymbols.has(member.providerCode))
    .sort((left, right) => left.providerCode.localeCompare(right.providerCode))
    .slice(0, CONTROL_COUNT);
  for (const member of controls)
    samples.push({
      sample: {
        marketId,
        symbol: member.providerCode,
        exchange: "US",
        type: "CONTROL",
        effectiveDate: today,
        priceFactor: 1,
        volumeFactor: 1,
        source: "MASSIVE",
        sourceObservedAt: deps.now.toISOString(),
      },
      cashAmount: null,
      role: "CONTROL",
    });

  const splitCount = samples.filter(
    (record) => record.role === "ACTION" && record.cashAmount === null,
  ).length;
  const limitations: string[] = [];
  if (splitCount === 0)
    limitations.push("No US split events in the retained window");
  if (selectedDividends.length < totalDividends)
    limitations.push(
      `Dividend events sampled ${selectedDividends.length} of ${totalDividends}`,
    );
  if (unmatchedSplits > 0)
    limitations.push(
      `Unmatched split tickers outside the admitted universe: ${unmatchedSplits}`,
    );
  if (unmatchedDividends > 0)
    limitations.push(
      `Unmatched dividend tickers outside the admitted universe: ${unmatchedDividends}`,
    );
  if (samples.length === 0)
    throw new Error("No US corporate actions found; sample set is empty");
  deps.logger?.({
    event: "DISCOVERY_ADJUSTMENT_MASSIVE_SAMPLE_FROZEN",
    splitCount,
    dividendEvents: totalDividends,
    unmatchedSplits,
    unmatchedDividends,
  });

  return {
    protocolRevision: DEFAULT_ADJUSTMENT_CRITERIA.revision,
    marketId,
    windowDays: VERIFICATION_WINDOW_DAYS,
    windowStart: windowStartDate,
    frozenAt: deps.now.toISOString(),
    revision: sampleSetRevision(samples.map((record) => record.sample)),
    samples,
    limitations,
  };
}
export interface BuildSampleSetDeps {
  marketId: MarketId;
  members: readonly CatalogMember[];
  eodhd: Pick<EodhdCorporateActionClient, "splits" | "dividends">;
  now: Date;
  logger?: (fields: Record<string, unknown>) => void;
}

/**
 * Freeze the sample set before any snapshot is collected. Every admitted
 * symbol with a corporate action in the window is included; controls are the
 * first admitted symbols without events. EODHD failures are recorded as
 * limitations, never silently dropped.
 */
export async function buildFrozenSampleSet(
  deps: BuildSampleSetDeps,
): Promise<FrozenSampleSet> {
  marketIdSchema.parse(deps.marketId);
  if (deps.marketId !== "CA_TSX")
    throw new Error("CA-first: the adjustment verification scope is CA_TSX");
  const windowStart = addDays(deps.now, -VERIFICATION_WINDOW_DAYS);
  const windowStartDate = dateInTimezone(windowStart, "America/Toronto");
  const actionSymbols = new Set<string>();
  const samples: VerificationSampleRecord[] = [];
  const dividendCandidates: VerificationSampleRecord[] = [];
  const limitations: string[] = [];
  let splitCount = 0;
  let scannedCount = 0;
  let failedScanCount = 0;

  for (const member of [...deps.members].sort((left, right) =>
    left.providerCode.localeCompare(right.providerCode),
  )) {
    if (member.reasons.length > 0) continue;
    scannedCount += 1;
    const ticker = `${member.providerCode}.TO`;
    let splits: Awaited<ReturnType<EodhdCorporateActionClient["splits"]>>;
    let dividends: Awaited<ReturnType<EodhdCorporateActionClient["dividends"]>>;
    try {
      splits = await deps.eodhd.splits(ticker);
      dividends = await deps.eodhd.dividends(ticker);
    } catch (error) {
      failedScanCount += 1;
      limitations.push(
        `EODHD unavailable for ${member.providerCode}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      continue;
    }
    for (const split of splits) {
      if (split.date < windowStartDate) continue;
      if (!Number.isFinite(split.shareFactor) || split.shareFactor <= 0)
        continue;
      actionSymbols.add(member.providerCode);
      splitCount += 1;
      samples.push({
        sample: {
          marketId: deps.marketId,
          symbol: member.providerCode,
          exchange: "TSX",
          type: split.shareFactor >= 1 ? "SPLIT" : "REVERSE_SPLIT",
          effectiveDate: split.date,
          priceFactor: 1 / split.shareFactor,
          volumeFactor: split.shareFactor,
          source: "EODHD",
          sourceObservedAt: deps.now.toISOString(),
        },
        cashAmount: null,
        role: "ACTION",
      });
    }
    for (const dividend of dividends) {
      if (dividend.date < windowStartDate) continue;
      if (!Number.isFinite(dividend.amount) || dividend.amount <= 0) continue;
      actionSymbols.add(member.providerCode);
      dividendCandidates.push({
        sample: {
          marketId: deps.marketId,
          symbol: member.providerCode,
          exchange: "TSX",
          type: "CASH_DIVIDEND",
          effectiveDate: dividend.date,
          // Derived from the observed pre-event close during evaluation.
          priceFactor: 1,
          volumeFactor: 1,
          source: "EODHD",
          sourceObservedAt: deps.now.toISOString(),
        },
        cashAmount: dividend.amount,
        role: "ACTION",
      });
    }
    deps.logger?.({
      event: "DISCOVERY_ADJUSTMENT_SAMPLE_SCANNED",
      code: member.providerCode,
      splits: splits.length,
      dividends: dividends.length,
    });
  }

  // A quota or entitlement failure for a large share of the universe would
  // freeze a biased sample. Fail closed instead of recording one.
  if (failedScanCount > Math.max(10, Math.floor(scannedCount * 0.05)))
    throw new Error(
      `EODHD scan failed for ${failedScanCount}/${scannedCount} symbols; refusing to freeze a biased sample`,
    );

  // Quarterly dividends across the whole universe number in the thousands.
  // Freeze a deterministic, evenly spread subset so the frozen evidence and
  // the broker workload stay bounded; the selection rule is part of the sample.
  const totalDividends = dividendCandidates.length;
  const selectedDividends =
    totalDividends <= MAX_DIVIDEND_SAMPLES
      ? dividendCandidates
      : Array.from(
          { length: MAX_DIVIDEND_SAMPLES },
          (_, index) =>
            dividendCandidates[
              Math.floor(
                ((index + 0.5) * totalDividends) / MAX_DIVIDEND_SAMPLES,
              )
            ]!,
        );
  if (selectedDividends.length < totalDividends)
    limitations.push(
      `Dividend events sampled ${selectedDividends.length} of ${totalDividends}`,
    );
  samples.push(...selectedDividends);

  const controls = deps.members
    .filter(
      (member) =>
        member.reasons.length === 0 && !actionSymbols.has(member.providerCode),
    )
    .sort((left, right) => left.providerCode.localeCompare(right.providerCode))
    .slice(0, CONTROL_COUNT);
  for (const member of controls)
    samples.push({
      sample: {
        marketId: deps.marketId,
        symbol: member.providerCode,
        exchange: "TSX",
        type: "CONTROL",
        effectiveDate: dateInTimezone(deps.now, "America/Toronto"),
        priceFactor: 1,
        volumeFactor: 1,
        source: "EODHD",
        sourceObservedAt: deps.now.toISOString(),
      },
      cashAmount: null,
      role: "CONTROL",
    });

  if (splitCount < MINIMUM_SPLIT_SAMPLES)
    limitations.push(
      `Split sample ${splitCount} below minimum ${MINIMUM_SPLIT_SAMPLES}`,
    );
  if (selectedDividends.length < MINIMUM_DIVIDEND_SAMPLES)
    limitations.push(
      `Dividend sample ${selectedDividends.length} below minimum ${MINIMUM_DIVIDEND_SAMPLES}`,
    );
  if (samples.length === 0)
    throw new Error("No corporate actions found; sample set is empty");

  return {
    protocolRevision: DEFAULT_ADJUSTMENT_CRITERIA.revision,
    marketId: deps.marketId,
    windowDays: VERIFICATION_WINDOW_DAYS,
    windowStart: windowStartDate,
    frozenAt: deps.now.toISOString(),
    revision: sampleSetRevision(samples.map((record) => record.sample)),
    samples,
    limitations,
  };
}

export interface CollectRoundDeps {
  sampleSet: FrozenSampleSet;
  adapter: Pick<MarketDataAdapter, "getCandles">;
  symbolIds: ReadonlyMap<string, number>;
  previous?: VerificationRound;
  now: Date;
  timezone: string;
  logger?: (fields: Record<string, unknown>) => void;
}

export async function collectVerificationRound(
  deps: CollectRoundDeps,
): Promise<VerificationRound> {
  const observations: SampleObservation[] = [];
  const seriesRevisions: RoundSeriesRevision[] = [];
  const missing: string[] = [];
  // Fix the comparison boundary on the first round. Every later round compares
  // only bars that already existed then, so legitimate new bars in a still-open
  // window are not misread as provider revisions.
  const observedThrough =
    deps.previous?.observedThrough ??
    deps.previous?.collectedAt ??
    deps.now.toISOString();
  const baselineMs = Date.parse(observedThrough);
  for (const record of deps.sampleSet.samples) {
    const symbolId = deps.symbolIds.get(record.sample.symbol);
    if (!symbolId) {
      missing.push(`${record.sample.symbol}:MAPPING`);
      continue;
    }
    const effective = new Date(`${record.sample.effectiveDate}T00:00:00Z`);
    for (const interval of VERIFICATION_INTERVALS) {
      const spread = INTERVAL_RANGE_DAYS[interval];
      const range = {
        startTime: addDays(effective, -spread),
        endTime: addDays(effective, spread),
      };
      let bars: Candle[];
      try {
        bars = await deps.adapter.getCandles(symbolId, interval, range);
      } catch (error) {
        const detail =
          error instanceof Error ? error.message.slice(0, 80) : "unknown";
        missing.push(`${record.sample.symbol}:${interval}:FETCH:${detail}`);
        deps.logger?.({
          event: "DISCOVERY_ADJUSTMENT_FETCH_FAILED",
          symbol: record.sample.symbol,
          interval,
          error: error instanceof Error ? error.message : "unknown",
        });
        continue;
      }
      if (bars.length === 0) {
        missing.push(`${record.sample.symbol}:${interval}:EMPTY`);
        continue;
      }
      const baselineBars = bars.filter(
        (bar) => bar.end.getTime() <= baselineMs,
      );
      seriesRevisions.push({
        sampleKey: sampleRevisionKey(record),
        symbol: record.sample.symbol,
        interval,
        sampleType: record.sample.type,
        effectiveDate: record.sample.effectiveDate,
        role: record.role,
        windowStart: range.startTime.toISOString(),
        windowEnd: range.endTime.toISOString(),
        revision: barSeriesRevision(
          baselineBars.map((bar) => ({
            start: bar.start.toISOString(),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
          })),
        ),
        barCount: baselineBars.length,
        fetchedBarCount: bars.length,
      });
      const boundary = extractBoundary(
        bars,
        record.sample.effectiveDate,
        deps.timezone,
      );
      if (!boundary) {
        missing.push(`${record.sample.symbol}:${interval}:BOUNDARY`);
        continue;
      }
      observations.push({
        sampleKey: sampleRevisionKey(record),
        symbol: record.sample.symbol,
        interval,
        pre: boundary.pre,
        post: boundary.post,
        retrievedAt: deps.now.toISOString(),
      });
    }
  }

  const round: VerificationRound = {
    round: (deps.previous?.round ?? 0) + 1,
    marketId: deps.sampleSet.marketId,
    collectedAt: deps.now.toISOString(),
    observedThrough,
    observations,
    seriesRevisions,
    missing,
    revisionFindings: [],
  };
  if (deps.previous) {
    const compared = compareRoundRevisionsDetailed(
      deps.previous,
      round,
      deps.sampleSet,
    );
    round.revisionFindings = compared.findings;
    round.revisionComparison = compared.comparison;
  } else {
    round.revisionComparison = {
      round: round.round,
      status: "BASELINE",
      previousRound: 0,
      previousEntries: 0,
      currentEntries: seriesRevisions.length,
      matched: 0,
      unmatchedPrevious: 0,
      unmatchedCurrent: 0,
      legacyEntries: 0,
      findings: 0,
      reasons: [],
    };
  }
  return round;
}

/** Evaluate the latest round with dividend factors derived from its own bars. */
export function evaluateLatestRound(
  sampleSet: FrozenSampleSet,
  round: VerificationRound,
) {
  const identified: IdentifiedSample[] = sampleSet.samples.map((record) => {
    if (record.role !== "ACTION" || record.cashAmount === null)
      return { sample: record.sample, role: record.role };
    const sampleKey = sampleRevisionKey(record);
    const preClose = round.observations.find(
      (observation) =>
        observation.sampleKey === sampleKey &&
        observation.symbol === record.sample.symbol,
    )?.pre.close;
    if (!preClose || preClose <= record.cashAmount)
      return { sample: record.sample, role: record.role };
    return {
      sample: {
        ...record.sample,
        priceFactor: (preClose - record.cashAmount) / preClose,
      },
      role: record.role,
    };
  });
  return evaluateAdjustmentVerification(identified, round.observations);
}

export type RoundStatusOutcome =
  | {
      status: "PENDING";
      completedRounds: number;
      revisionComparisons: RoundRevisionComparison[];
    }
  | {
      status: "PASS" | "STOP";
      report: VerificationReport;
      revisionFindings: RoundRevisionFinding[];
      revisionComparisons: RoundRevisionComparison[];
      blockers: string[];
    };

export function roundStatus(
  sampleSet: FrozenSampleSet,
  rounds: readonly VerificationRound[],
): RoundStatusOutcome {
  const review = reviewRoundRevisions(sampleSet, rounds);
  if (rounds.length < VERIFICATION_ROUNDS)
    return {
      status: "PENDING",
      completedRounds: rounds.length,
      revisionComparisons: review.comparisons,
    };
  const latest = rounds.at(-1)!;
  const report = evaluateLatestRound(sampleSet, latest);
  // Recompute from the retained revisions so recovered legacy comparisons are
  // enforced even when the persisted per-round findings are empty.
  const revisionFindings = dedupeRevisionFindings([
    ...rounds.flatMap((round) => round.revisionFindings),
    ...review.findings,
  ]);
  const unexplained = revisionFindings.filter(
    (finding) => !finding.explainedByAction,
  );
  const blockers = [
    ...review.comparisons
      .filter((comparison) => comparison.status !== "COMPARED")
      .flatMap((comparison) =>
        comparison.reasons.length
          ? comparison.reasons.map(
              (reason) => `ROUND_${comparison.round}:${reason}`,
            )
          : [`ROUND_${comparison.round}:INCOMPARABLE`],
      ),
    ...(unexplained.length > 0
      ? [`UNEXPLAINED_REVISION_FINDINGS:${unexplained.length}`]
      : []),
    ...(report.status !== "PASS" ? [`SAMPLE_EVALUATION:${report.status}`] : []),
  ];
  const status = blockers.length === 0 ? "PASS" : "STOP";
  return {
    status,
    report,
    revisionFindings,
    revisionComparisons: review.comparisons,
    blockers,
  };
}

/**
 * Refuse a new collection before any runtime setup when retained evidence has
 * already reached a terminal result or cannot form an adjacent-round
 * comparison. A compatible two-round history remains PENDING and proceeds to
 * collect its third round under the existing protocol.
 */
export async function runWithRetainedEvidencePreflight<Runtime, Result>(
  evidence: StoredVerificationEvidence,
  setup: () => Promise<Runtime>,
  collect: (runtime: Runtime) => Promise<Result>,
): Promise<Result> {
  let terminal = evidence.report !== null;
  let incompatible = false;
  if (evidence.sampleSet) {
    const outcome = roundStatus(evidence.sampleSet, evidence.rounds);
    terminal ||= outcome.status !== "PENDING";
    incompatible = outcome.revisionComparisons.some(
      (comparison) => comparison.status === "INCOMPATIBLE",
    );
  }
  if (terminal || incompatible)
    throw new Error(
      "ADJUSTMENT_VERIFICATION_RUN_BLOCKED: retained evidence is terminal or incompatible",
    );
  return collect(await setup());
}
