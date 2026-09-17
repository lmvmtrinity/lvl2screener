import type {
  BacktestEvidenceReport,
  BacktestReplayResult,
  BacktestTrade,
  EvidenceConfidenceInterval,
} from "@tsx-scanner/contracts";
import type { MarketId } from "@tsx-scanner/contracts";

export type StrategyBacktestEvidence = {
  strategy: BacktestTrade["strategy"];
  evidence: BacktestEvidenceReport;
};

const MINIMUM_TRADES_PER_SLICE = 30;
const BOOTSTRAP_SAMPLES = 1_000;
function marketTimeZone(
  marketId: MarketId,
): "America/Toronto" | "America/New_York" {
  return marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto";
}

function dateFormatter(marketId: MarketId): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketTimeZone(marketId),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
function timeFormatter(marketId: MarketId): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketTimeZone(marketId),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function buildBacktestEvidence(
  output: BacktestReplayResult,
  generatedAt = new Date(),
  marketId: MarketId = "CA_TSX",
): BacktestEvidenceReport {
  const trades = uniqueTrades(output.trades);
  const readyEvents = output.timeline.filter(
    (value) => value.state === "READY",
  );
  const uniqueReady = new Set(
    readyEvents.map(
      (value) =>
        value.setupInstanceId ??
        `${value.instrumentId}:${value.strategy}:${value.timestamp}`,
    ),
  );
  const slices = sliceCounts(trades, marketId);
  const sliceGates = [...slices.entries()]
    .map(([key, count]) => {
      const [dimension, bucket] = key.split("\u0000") as [
        "STRATEGY" | "TIME_OF_DAY" | "ATR_REGIME" | "RVOL_REGIME",
        string,
      ];
      return {
        dimension,
        bucket,
        trades: count,
        minimumTrades: MINIMUM_TRADES_PER_SLICE,
        sufficient: count >= MINIMUM_TRADES_PER_SLICE,
      };
    })
    .sort(
      (left, right) =>
        left.dimension.localeCompare(right.dimension) ||
        left.bucket.localeCompare(right.bucket),
    );
  const expectancy = interval(trades, "expectancy", (values) =>
    mean(values.map((value) => value.netPnl)),
  );
  const winRate = interval(trades, "win-rate", (values) =>
    rate(values, (value) => value.netPnl > 0),
  );
  const falseBreakoutRate = interval(trades, "false-breakout", (values) =>
    rate(values, (value) => value.exitReason === "STOP"),
  );
  const walkForward = walkForwardWindows(trades, marketId);
  const portfolioRisk = portfolioEvidence(trades);
  const adequateSamples =
    trades.length >= MINIMUM_TRADES_PER_SLICE &&
    sliceGates.length > 0 &&
    sliceGates.every((value) => value.sufficient);
  const positiveExpectancyRange =
    expectancy.lower !== null && expectancy.lower > 0;
  const walkForwardPositive =
    walkForward.length >= 2 &&
    walkForward.every((value) => value.testExpectancy > 0);
  const warnings: string[] = [];
  if (readyEvents.some((value) => value.setupInstanceId == null))
    warnings.push(
      "Some READY events predate setup-instance identity; compatibility fallbacks were used.",
    );
  if (readyEvents.length > uniqueReady.size)
    warnings.push(
      `${readyEvents.length - uniqueReady.size} duplicate READY event(s) were excluded from the evidence sample.`,
    );
  if (trades.length < MINIMUM_TRADES_PER_SLICE)
    warnings.push(
      `Overall sample has ${trades.length} trades; at least ${MINIMUM_TRADES_PER_SLICE} are required.`,
    );
  const insufficient = sliceGates.filter((value) => !value.sufficient);
  if (insufficient.length)
    warnings.push(
      `${insufficient.length} strategy/time/regime slice(s) do not meet the ${MINIMUM_TRADES_PER_SLICE}-trade minimum.`,
    );
  if (!positiveExpectancyRange)
    warnings.push(
      "The 95% bootstrap expectancy range does not remain above zero.",
    );
  if (walkForward.length < 2)
    warnings.push(
      "At least four market-local trading dates are required for walk-forward reporting.",
    );
  else if (!walkForwardPositive)
    warnings.push(
      "Expectancy is not positive in every fixed-configuration walk-forward test window.",
    );
  const strategyCount = new Set(trades.map((value) => value.strategy)).size;
  if (strategyCount > 1)
    warnings.push(
      `This run evaluates ${strategyCount} strategies; reported intervals are not adjusted for multiple testing.`,
    );
  warnings.push(...portfolioRisk.warnings);
  return {
    evidenceVersion: "phase8-evidence-v1",
    qualification:
      adequateSamples && positiveExpectancyRange && walkForwardPositive
        ? "EVIDENCE_QUALIFIED"
        : "EXPLORATORY",
    generatedAt: generatedAt.toISOString(),
    minimumTradesPerSlice: MINIMUM_TRADES_PER_SLICE,
    uniqueSetupInstances: uniqueReady.size,
    duplicateReadyEventsExcluded: Math.max(
      0,
      readyEvents.length - uniqueReady.size,
    ),
    expectancy,
    winRate,
    falseBreakoutRate,
    sliceGates,
    walkForward,
    portfolioRisk,
    adequateSamples,
    positiveExpectancyRange,
    warnings,
  };
}

/**
 * A mixed-strategy replay is useful for portfolio analysis, but it cannot
 * qualify any individual strategy. Derive evidence independently so a profile
 * can only be linked to the strategy it actually implements.
 */
export function buildStrategyBacktestEvidence(
  output: BacktestReplayResult,
  generatedAt = new Date(),
  requestedStrategies: readonly BacktestTrade["strategy"][] = [],
  marketId: MarketId = "CA_TSX",
): StrategyBacktestEvidence[] {
  const strategies = new Set<BacktestTrade["strategy"]>([
    ...requestedStrategies,
    ...output.trades.map((value) => value.strategy),
    ...output.timeline.map((value) => value.strategy),
  ]);
  return [...strategies].sort().map((strategy) => ({
    strategy,
    evidence: buildBacktestEvidence(
      {
        ...output,
        trades: output.trades.filter((value) => value.strategy === strategy),
        timeline: output.timeline.filter(
          (value) => value.strategy === strategy,
        ),
      },
      generatedAt,
      marketId,
    ),
  }));
}

function uniqueTrades(trades: BacktestTrade[]): BacktestTrade[] {
  const seen = new Set<string>();
  return [...trades]
    .sort(
      (left, right) =>
        Date.parse(left.entryTime) - Date.parse(right.entryTime) ||
        left.id.localeCompare(right.id),
    )
    .filter((value) => {
      const key = value.setupInstanceId ?? `legacy:${value.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function interval(
  trades: BacktestTrade[],
  salt: string,
  statistic: (values: BacktestTrade[]) => number,
): EvidenceConfidenceInterval {
  if (!trades.length)
    return {
      estimate: null,
      lower: null,
      upper: null,
      confidenceLevel: 0.95,
      method: "DETERMINISTIC_BOOTSTRAP",
      samples: 0,
      bootstrapSamples: 0,
    };
  const random = mulberry32(
    seed(`${salt}:${trades.map((value) => value.id).join(":")}`),
  );
  const estimates: number[] = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
    const values: BacktestTrade[] = [];
    for (let index = 0; index < trades.length; index += 1)
      values.push(trades[Math.floor(random() * trades.length)]!);
    estimates.push(statistic(values));
  }
  estimates.sort((left, right) => left - right);
  return {
    estimate: rounded(statistic(trades)),
    lower: rounded(percentile(estimates, 0.025)),
    upper: rounded(percentile(estimates, 0.975)),
    confidenceLevel: 0.95,
    method: "DETERMINISTIC_BOOTSTRAP",
    samples: trades.length,
    bootstrapSamples: BOOTSTRAP_SAMPLES,
  };
}

function sliceCounts(
  trades: BacktestTrade[],
  marketId: MarketId,
): Map<string, number> {
  const result = new Map<string, number>();
  const add = (dimension: string, bucket: string) => {
    const key = `${dimension}\u0000${bucket}`;
    result.set(key, (result.get(key) ?? 0) + 1);
  };
  for (const trade of trades) {
    add("STRATEGY", trade.strategy);
    add("TIME_OF_DAY", timeBucket(trade.entryTime, marketId));
    add("ATR_REGIME", atrBucket(trade.atrPct));
    add("RVOL_REGIME", rvolBucket(trade.rvolAtTime));
  }
  return result;
}

function walkForwardWindows(
  trades: BacktestTrade[],
  marketId: MarketId,
): BacktestEvidenceReport["walkForward"] {
  const dates = [
    ...new Set(trades.map((value) => localDate(value.entryTime, marketId))),
  ].sort();
  if (dates.length < 4) return [];
  const blockSize = Math.max(1, Math.floor(dates.length / 4));
  const blocks: string[][] = [];
  for (let index = 0; index < 4; index += 1)
    blocks.push(
      dates.slice(
        index * blockSize,
        index === 3 ? dates.length : (index + 1) * blockSize,
      ),
    );
  return [1, 2, 3].flatMap((index) => {
    const trainDates = blocks.slice(0, index).flat(),
      testDates = blocks[index]!;
    if (!trainDates.length || !testDates.length) return [];
    const train = trades.filter((value) =>
      trainDates.includes(localDate(value.entryTime, marketId)),
    );
    const test = trades.filter((value) =>
      testDates.includes(localDate(value.entryTime, marketId)),
    );
    return [
      {
        index,
        trainStart: trainDates[0]!,
        trainEnd: trainDates.at(-1)!,
        testStart: testDates[0]!,
        testEnd: testDates.at(-1)!,
        trainTrades: train.length,
        testTrades: test.length,
        testExpectancy: rounded(mean(test.map((value) => value.netPnl))),
        testWinRate: rounded(rate(test, (value) => value.netPnl > 0)),
        testFalseBreakoutRate: rounded(
          rate(test, (value) => value.exitReason === "STOP"),
        ),
      },
    ];
  });
}

function portfolioEvidence(
  trades: BacktestTrade[],
): BacktestEvidenceReport["portfolioRisk"] {
  let overlappingTradePairs = 0,
    sameSectorOverlappingPairs = 0,
    maximumConcurrentTrades = 0,
    maximumConcurrentGrossExposure = 0;
  for (let left = 0; left < trades.length; left += 1)
    for (let right = left + 1; right < trades.length; right += 1) {
      const a = trades[left]!,
        b = trades[right]!;
      if (
        Date.parse(a.entryTime) < Date.parse(b.exitTime) &&
        Date.parse(b.entryTime) < Date.parse(a.exitTime)
      ) {
        overlappingTradePairs += 1;
        if (a.sector !== null && a.sector === b.sector)
          sameSectorOverlappingPairs += 1;
      }
    }
  for (const trade of trades) {
    const timestamp = Date.parse(trade.entryTime);
    const concurrent = trades.filter(
      (value) =>
        Date.parse(value.entryTime) <= timestamp &&
        timestamp < Date.parse(value.exitTime),
    );
    maximumConcurrentTrades = Math.max(
      maximumConcurrentTrades,
      concurrent.length,
    );
    maximumConcurrentGrossExposure = Math.max(
      maximumConcurrentGrossExposure,
      concurrent.reduce(
        (sum, value) => sum + value.entryPrice * value.shares,
        0,
      ),
    );
  }
  const sameSectorOverlapRate = overlappingTradePairs
    ? (sameSectorOverlappingPairs / overlappingTradePairs) * 100
    : 0;
  const warnings: string[] = [];
  if (maximumConcurrentTrades > 1)
    warnings.push(
      `Post-hoc signal overlap: ${maximumConcurrentTrades} positions were open at once with $${rounded(maximumConcurrentGrossExposure)} gross exposure. This is unconstrained overlapping signal exposure, not a funded portfolio result.`,
    );
  if (sameSectorOverlapRate >= 50 && overlappingTradePairs > 0)
    warnings.push(
      `${rounded(sameSectorOverlapRate)}% of overlapping trade pairs share a sector proxy.`,
    );
  return {
    maximumConcurrentTrades,
    overlappingTradePairs,
    sameSectorOverlappingPairs,
    sameSectorOverlapRate: rounded(sameSectorOverlapRate),
    maximumConcurrentGrossExposure: rounded(maximumConcurrentGrossExposure),
    warnings,
  };
}

function localDate(value: string, marketId: MarketId): string {
  return dateFormatter(marketId).format(new Date(value));
}
function timeBucket(value: string, marketId: MarketId): string {
  const [hour = 0] = timeFormatter(marketId)
    .format(new Date(value))
    .split(":")
    .map(Number);
  return hour < 10 ? "09:30-09:59" : hour < 11 ? "10:00-10:59" : "11:00+";
}
function atrBucket(value: number | null): string {
  return value === null
    ? "UNKNOWN"
    : value < 1.5
      ? "<1.5%"
      : value < 2.5
        ? "1.5-2.49%"
        : "2.5%+";
}
function rvolBucket(value: number | null): string {
  return value === null
    ? "UNKNOWN"
    : value < 1.5
      ? "<1.5x"
      : value < 2.5
        ? "1.5-2.49x"
        : "2.5x+";
}
function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
function rate<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.length
    ? (values.filter(predicate).length / values.length) * 100
    : 0;
}
function percentile(values: number[], probability: number): number {
  return values[Math.floor(probability * (values.length - 1))]!;
}
function rounded(value: number): number {
  return Number(value.toFixed(6));
}
function seed(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}
function mulberry32(initial: number): () => number {
  let value = initial;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
