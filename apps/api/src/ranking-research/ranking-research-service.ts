/**
 * @supported (decision-gated, defaulted per private development record W10)
 * Ranking-research vertical (this service, its repository, routes/ranking-research.ts,
 * migrations 016/017, and the associated contract schemas). No product owner/roadmap
 * decision was recorded by the plan's "before PR 3" deadline, so per the plan's stated
 * default this vertical is KEPT as an API-only research surface rather than removed.
 * Re-evaluate against the plan's table: keep while API-only research is intentional and
 * supported; remove once there is no product owner or roadmap consumer. It currently has
 * zero frontend references — that is expected, not a defect.
 * Covered by apps/api/tests/ranking-research-api.test.ts,
 * apps/api/tests/ranking-research-service.test.ts, and contracts/tests/ranking-research.test.ts.
 */
import {
  type BacktestRun,
  type BacktestTrade,
  type CreateRankingResearch,
  type RankingResearchFormulaResult,
  type RankingResearchMetrics,
  type RankingResearchRun,
  type RankingResearchSlice,
} from "@tsx-scanner/contracts";
import { DomainError } from "../errors.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";

class RankingResearchError extends DomainError {
  constructor(
    readonly code:
      | "STUDY_NOT_FOUND"
      | "BACKTEST_NOT_FOUND"
      | "BACKTEST_NOT_COMPLETED"
      | "BACKTEST_EXECUTION_MODEL"
      | "RESEARCH_FAILED",
    message: string,
    readonly studyId?: string,
  ) {
    // Every current call site treats every RankingResearchError code as "not found" (404); kept
    // as-is to avoid a behavior change during this restructuring.
    super(code, message, 404);
  }
}

export interface RankingResearchStore {
  create(
    input: CreateRankingResearch,
    executionModelVersion: string,
  ): Promise<RankingResearchRun>;
  markRunning(id: string): Promise<void>;
  complete(
    id: string,
    splitAt: string | null,
    results: RankingResearchFormulaResult[],
    warnings: string[],
  ): Promise<RankingResearchRun>;
  fail(id: string, error: string): Promise<void>;
  list(limit?: number): Promise<RankingResearchRun[]>;
  get(id: string): Promise<RankingResearchRun | undefined>;
}

export interface RankingResearchBacktests {
  get(id: string): Promise<BacktestRun | undefined>;
}

export class RankingResearchService {
  constructor(
    private readonly store: RankingResearchStore,
    private readonly backtests: RankingResearchBacktests,
  ) {}

  async list(limit = 50): Promise<RankingResearchRun[]> {
    return this.store.list(limit);
  }

  async get(id: string): Promise<RankingResearchRun> {
    const value = await this.store.get(id);
    if (!value)
      throw new RankingResearchError(
        "STUDY_NOT_FOUND",
        "Ranking research study not found",
      );
    return value;
  }

  async create(input: CreateRankingResearch): Promise<RankingResearchRun> {
    const backtest = await this.backtests.get(input.backtestRunId);
    if (!backtest)
      throw new RankingResearchError(
        "BACKTEST_NOT_FOUND",
        "Backtest run not found",
      );
    if (backtest.status !== "COMPLETED")
      throw new RankingResearchError(
        "BACKTEST_NOT_COMPLETED",
        "Ranking research requires a completed captured-history backtest",
      );
    if (backtest.marketId !== input.marketId)
      throw new RankingResearchError(
        "BACKTEST_NOT_COMPLETED",
        "Ranking research market must match its source backtest",
      );
    if (
      backtest.executionModelVersion !== AUTHORITATIVE_EXECUTION_MODEL_VERSION
    )
      throw new RankingResearchError(
        "BACKTEST_EXECUTION_MODEL",
        `Ranking research requires ${AUTHORITATIVE_EXECUTION_MODEL_VERSION} evidence; source run uses ${backtest.executionModelVersion ?? "legacy unknown execution"}`,
      );
    const study = await this.store.create(
      input,
      AUTHORITATIVE_EXECUTION_MODEL_VERSION,
    );
    await this.store.markRunning(study.id);
    try {
      const output = evaluateRankingResearch(backtest, input);
      return await this.store.complete(
        study.id,
        output.splitAt,
        output.results,
        output.warnings,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown ranking research failure";
      await this.store.fail(study.id, message);
      throw new RankingResearchError(
        "RESEARCH_FAILED",
        `Ranking research failed: ${message}`,
        study.id,
      );
    }
  }
}

type RankedTrade = {
  trade: BacktestTrade;
  contextScore: number;
  contextEvidence: boolean;
  rankingScore: number;
};
type Segment = { baseline: RankedTrade[]; candidate: RankedTrade[] };

export function evaluateRankingResearch(
  backtest: BacktestRun,
  input: CreateRankingResearch,
): {
  splitAt: string | null;
  results: RankingResearchFormulaResult[];
  warnings: string[];
} {
  const trades = [...backtest.trades].sort(
    (a, b) =>
      Date.parse(a.entryTime) - Date.parse(b.entryTime) ||
      a.id.localeCompare(b.id),
  );
  const sessions = [
    ...new Set(trades.map((value) => value.entryTime.slice(0, 10))),
  ];
  const warnings: string[] = [];
  if (!trades.length)
    warnings.push("The source backtest contains no simulated trades.");
  if (sessions.length < 2)
    warnings.push(
      "At least two captured sessions are required for a leakage-free chronological holdout.",
    );
  const cut =
    sessions.length < 2
      ? sessions.length
      : Math.max(
          1,
          Math.min(
            sessions.length - 1,
            Math.floor((sessions.length * input.trainPct) / 100),
          ),
        );
  const trainingDates = new Set(sessions.slice(0, cut));
  const trainTrades = trades.filter((value) =>
    trainingDates.has(value.entryTime.slice(0, 10)),
  );
  const holdoutTrades = trades.filter(
    (value) => !trainingDates.has(value.entryTime.slice(0, 10)),
  );
  const splitAt = holdoutTrades[0]?.entryTime ?? null;
  if (trades.some((value) => value.contexts.length === 0))
    warnings.push(
      "Some source trades predate captured context evidence and remain neutral.",
    );
  return {
    splitAt,
    warnings,
    results: input.formulaVersions.map((version) =>
      evaluateFormula(
        version,
        trainTrades,
        holdoutTrades,
        input,
        sessions.length >= 2,
      ),
    ),
  };
}

function evaluateFormula(
  version: CreateRankingResearch["formulaVersions"][number],
  trainTrades: BacktestTrade[],
  holdoutTrades: BacktestTrade[],
  input: CreateRankingResearch,
  chronological: boolean,
): RankingResearchFormulaResult {
  const mode =
    version === "ranking-bounded-context-research-v1"
      ? "BOUNDED_CONTEXT"
      : "SETUP_INTERACTION";
  const train = segment(trainTrades, version, input, 1);
  const holdout = segment(holdoutTrades, version, input, 1);
  const sensitivity = input.sensitivityMultipliers.map((multiplier) => ({
    multiplier,
    metrics: metrics(
      select(
        holdoutTrades,
        version,
        input,
        false,
        multiplier,
        input.topPerSession,
      ),
    ),
  }));
  const costStressedCandidate = metrics(
    holdout.candidate,
    input.slippageStressBps,
    input.feeStressPerTrade,
  );
  const costStressedBaseline = metrics(
    holdout.baseline,
    input.slippageStressBps,
    input.feeStressPerTrade,
  );
  const baselineMetrics = metrics(holdout.baseline);
  const candidateMetrics = metrics(holdout.candidate);
  const baselineSlices = slices(holdout.baseline);
  const candidateSlices = slices(holdout.candidate);
  const strategyBuckets = baselineSlices.filter(
    (value) => value.dimension === "STRATEGY",
  );
  const regimeBuckets = baselineSlices.filter(
    (value) => value.dimension === "MARKET_REGIME",
  );
  const candidateSlice = (
    dimension: RankingResearchSlice["dimension"],
    bucket: string,
  ) =>
    candidateSlices.find(
      (value) => value.dimension === dimension && value.bucket === bucket,
    );
  const adequateSamples =
    chronological &&
    [...strategyBuckets, ...regimeBuckets].length > 0 &&
    [...strategyBuckets, ...regimeBuckets].every(
      (value) =>
        value.samples >= input.minimumSamplesPerSlice &&
        (candidateSlice(value.dimension, value.bucket)?.samples ?? 0) >=
          input.minimumSamplesPerSlice,
    );
  const contextEvidenceAvailable =
    candidateMetrics.samples >= input.minimumSamplesPerSlice &&
    candidateMetrics.contextEvidenceSamples /
      Math.max(1, candidateMetrics.samples) >=
      0.8;
  const expectancyStableOrImproved =
    candidateMetrics.averageR >= baselineMetrics.averageR;
  const falseBreakoutStableOrReduced =
    candidateMetrics.falseBreakoutRate <= baselineMetrics.falseBreakoutRate;
  const allowedDrawdown =
    baselineMetrics.maximumDrawdownR *
    (1 + input.maximumDrawdownDegradationPct / 100);
  const drawdownAcceptable =
    candidateMetrics.maximumDrawdownR <= allowedDrawdown + 1e-9;
  const strategies = new Set(holdoutTrades.map((value) => value.strategy));
  const weightsComplete =
    mode !== "SETUP_INTERACTION" ||
    [...strategies].every(
      (value) => input.strategyWeights[value] !== undefined,
    );
  const enoughStrategies = mode !== "BOUNDED_CONTEXT" || strategies.size >= 2;
  const strategyGeneralizes =
    weightsComplete &&
    enoughStrategies &&
    strategyBuckets.length > 0 &&
    strategyBuckets.every((value) => {
      const candidate = candidateSlice("STRATEGY", value.bucket);
      return candidate !== undefined && candidate.averageR >= value.averageR;
    });
  const sensitivityStable =
    sensitivity.length >= 2 &&
    sensitivity.every(
      (value) =>
        value.metrics.samples > 0 &&
        value.metrics.averageR >= baselineMetrics.averageR - 0.05 &&
        value.metrics.falseBreakoutRate <=
          baselineMetrics.falseBreakoutRate + 5,
    );
  const costsAcceptable =
    costStressedCandidate.samples > 0 &&
    costStressedCandidate.averageR >= 0 &&
    costStressedCandidate.averageR >= costStressedBaseline.averageR;
  const checks = {
    adequateSamples,
    contextEvidenceAvailable,
    expectancyStableOrImproved,
    falseBreakoutStableOrReduced,
    drawdownAcceptable,
    strategyGeneralizes,
    sensitivityStable,
    costsAcceptable,
  };
  const reasons = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => gateReason(key));
  const correlatedInputFlags = correlationFlags(
    holdoutTrades,
    input.contextHorizon,
  );
  return {
    formulaVersion: version,
    mode,
    train: describeSegment(train),
    holdout: describeSegment(holdout),
    sensitivity,
    costStressedCandidate,
    costStressedBaseline,
    correlatedInputFlags,
    gate: {
      ...checks,
      eligibleForActivation: Object.values(checks).every(Boolean),
      reasons,
    },
  };
}

function segment(
  trades: BacktestTrade[],
  version: CreateRankingResearch["formulaVersions"][number],
  input: CreateRankingResearch,
  multiplier: number,
): Segment {
  return {
    baseline: select(
      trades,
      version,
      input,
      true,
      multiplier,
      input.topPerSession,
    ),
    candidate: select(
      trades,
      version,
      input,
      false,
      multiplier,
      input.topPerSession,
    ),
  };
}

function select(
  trades: BacktestTrade[],
  version: CreateRankingResearch["formulaVersions"][number],
  input: CreateRankingResearch,
  baseline: boolean,
  multiplier: number,
  top: number,
): RankedTrade[] {
  const grouped = new Map<string, RankedTrade[]>();
  for (const trade of trades) {
    const context = researchContext(trade, input.contextHorizon);
    const weight =
      version === "ranking-bounded-context-research-v1"
        ? 0.1
        : (input.strategyWeights[trade.strategy] ?? 0);
    const adjustment = baseline
      ? 0
      : Math.round(
          Math.max(-5, Math.min(5, (context.score - 50) * weight * multiplier)),
        );
    const ranked = {
      trade,
      contextScore: context.score,
      contextEvidence: context.available,
      rankingScore: trade.score + adjustment,
    };
    const key = trade.entryTime.slice(0, 10);
    grouped.set(key, [...(grouped.get(key) ?? []), ranked]);
  }
  return [...grouped.values()].flatMap((values) =>
    values
      .sort(
        (a, b) =>
          b.rankingScore - a.rankingScore ||
          b.trade.score - a.trade.score ||
          b.contextScore - a.contextScore ||
          Date.parse(b.trade.signalTimestamp) -
            Date.parse(a.trade.signalTimestamp) ||
          a.trade.symbol.localeCompare(b.trade.symbol),
      )
      .slice(0, top),
  );
}

function researchContext(
  trade: BacktestTrade,
  horizon: CreateRankingResearch["contextHorizon"],
): { score: number; available: boolean } {
  const components = trade.contexts
    .flatMap((value) => value.contextScoreComponents)
    .filter(
      (value) =>
        value.available &&
        (horizon === "MULTI_HORIZON" || value.horizon === "SESSION_FROM_OPEN"),
    );
  if (components.length)
    return {
      score: Math.round(
        components.reduce((sum, value) => sum + value.score, 0) /
          components.length,
      ),
      available: true,
    };
  const usable = trade.contexts.filter(
    (value) => value.status !== "UNAVAILABLE" && value.status !== "STALE",
  );
  if (usable.length)
    return {
      score: Math.round(
        usable.reduce((sum, value) => sum + value.contextScore, 0) /
          usable.length,
      ),
      available: true,
    };
  return { score: 50, available: false };
}

function metrics(
  values: RankedTrade[],
  extraSlippageBps = 0,
  extraFee = 0,
): RankingResearchMetrics {
  const returns = values.map(({ trade }) => {
    const risk = Math.max(
      1e-9,
      (trade.entryPrice - trade.stopPrice) * trade.shares,
    );
    const extraCost =
      (trade.entryPrice * trade.shares * 2 * extraSlippageBps) / 10_000 +
      extraFee;
    return trade.rMultiple - extraCost / risk;
  });
  let equity = 0,
    peak = 0,
    maximumDrawdownR = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    maximumDrawdownR = Math.max(maximumDrawdownR, peak - equity);
  }
  const averageR = returns.length
    ? returns.reduce((sum, value) => sum + value, 0) / returns.length
    : 0;
  return {
    samples: values.length,
    averageR: rounded(averageR),
    expectancyR: rounded(averageR),
    falseBreakoutRate: rounded(
      values.length
        ? (values.filter((value) => value.trade.exitReason === "STOP").length /
            values.length) *
            100
        : 0,
    ),
    maximumDrawdownR: rounded(maximumDrawdownR),
    netR: rounded(returns.reduce((sum, value) => sum + value, 0)),
    contextEvidenceSamples: values.filter((value) => value.contextEvidence)
      .length,
  };
}

function slices(values: RankedTrade[]): RankingResearchSlice[] {
  const groups = new Map<string, RankedTrade[]>();
  for (const value of values)
    for (const [dimension, bucket] of [
      ["STRATEGY", value.trade.strategy],
      ["MARKET_REGIME", regime(value.trade)],
    ] as const) {
      const key = `${dimension}:${bucket}`;
      groups.set(key, [...(groups.get(key) ?? []), value]);
    }
  return [...groups.entries()]
    .map(([key, trades]) => {
      const [dimension, ...parts] = key.split(":");
      return {
        dimension: dimension as RankingResearchSlice["dimension"],
        bucket: parts.join(":"),
        ...metrics(trades),
      };
    })
    .sort(
      (a, b) =>
        a.dimension.localeCompare(b.dimension) ||
        a.bucket.localeCompare(b.bucket),
    );
}

function describeSegment(value: Segment) {
  const all = [...value.baseline, ...value.candidate].sort(
    (a, b) => Date.parse(a.trade.entryTime) - Date.parse(b.trade.entryTime),
  );
  return {
    start: all[0]?.trade.entryTime ?? null,
    end: all.at(-1)?.trade.entryTime ?? null,
    baseline: metrics(value.baseline),
    candidate: metrics(value.candidate),
    baselineSlices: slices(value.baseline),
    candidateSlices: slices(value.candidate),
  };
}

function regime(value: BacktestTrade): string {
  const atr =
    value.atrPct === null
      ? "ATR_UNKNOWN"
      : value.atrPct >= 2
        ? "ATR_HIGH"
        : "ATR_LOW";
  const rvol =
    value.rvolAtTime === null
      ? "RVOL_UNKNOWN"
      : value.rvolAtTime >= 1.5
        ? "RVOL_HIGH"
        : "RVOL_LOW";
  return `${atr}/${rvol}`;
}

function correlationFlags(
  trades: BacktestTrade[],
  horizon: CreateRankingResearch["contextHorizon"],
): string[] {
  const flags = new Set<string>();
  if (trades.some((value) => value.rvolAtTime !== null))
    flags.add("RVOL_PRESENT_IN_SETUP_EVIDENCE");
  if (
    trades.some(
      (value) =>
        value.reasonCodes.includes("ABOVE_VWAP") ||
        value.reasonCodes.includes("OVEREXTENDED"),
    )
  )
    flags.add("VWAP_STATE_PRESENT_IN_SETUP_SCORE");
  if (trades.some((value) => value.contexts.length > 0))
    flags.add("PRICE_MOMENTUM_PRESENT_IN_CONTEXT_INPUT");
  if (horizon === "MULTI_HORIZON")
    flags.add("SESSION_AND_ROLLING_RETURN_CORRELATION_REQUIRES_REVIEW");
  return [...flags];
}

function gateReason(key: string): string {
  const reasons: Record<string, string> = {
    adequateSamples:
      "Insufficient chronological holdout samples by strategy or market regime.",
    contextEvidenceAvailable:
      "Fewer than 80% of selected holdout observations have captured context evidence.",
    expectancyStableOrImproved:
      "Holdout average R did not remain stable or improve versus the tie-break baseline.",
    falseBreakoutStableOrReduced:
      "Holdout false-breakout rate increased versus the tie-break baseline.",
    drawdownAcceptable:
      "Holdout drawdown exceeded the configured degradation limit.",
    strategyGeneralizes:
      "The formula did not generalize across setup families or lacks explicit interaction weights.",
    sensitivityStable:
      "Neighbouring context weights did not form a stable performance plateau.",
    costsAcceptable:
      "Results were not acceptable after the configured slippage and fee stress.",
  };
  return reasons[key] ?? key;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
