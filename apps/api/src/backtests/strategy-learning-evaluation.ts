import type { BacktestTrade, MarketId } from "@tsx-scanner/contracts";

export type MatchedStrategyOpportunity = {
  opportunityId: string;
  sessionDate: string;
  symbol: string;
  regime: string | null;
  baselineSelected: boolean;
  candidateSelected: boolean;
  outcome:
    | { status: "CLOSED"; trade: BacktestTrade }
    | { status: "NO_FILL"; reason: string }
    | { status: "INVALID"; reason: string };
};

export type MatchedStrategyEvaluationInput = {
  marketId: MarketId;
  unit: "CAD" | "USD";
  sourceRunId: string;
  coverageStatus: "VERIFIED" | "MISSING";
  lineageStatus: "VERIFIED" | "UNVERIFIED";
  /** Complete expected session membership, including verified zero-opportunity sessions. */
  expectedSessions: readonly string[];
  /** Frozen shared opportunity membership; the input must contain every member exactly once. */
  expectedOpportunityIds: readonly string[];
  minimumSessions: number;
  bootstrapSamples: number;
  blockLength: number;
  seed: number;
  extraCostScenarios: readonly {
    extraSlippageBps: number;
    extraFeePerTrade: number;
  }[];
  /** One shared row per opportunity; selection decisions are supplied by existing rank/filter paths. */
  opportunities: readonly MatchedStrategyOpportunity[];
};

type SideMetrics = {
  selectedOpportunities: number;
  closedOutcomes: number;
  noFillOutcomes: number;
  invalidOutcomes: number;
  netPnl: number | null;
  meanNetPnlPerSelectedOpportunity: number | null;
  costSensitivity: {
    extraSlippageBps: number;
    extraFeePerTrade: number;
    netPnl: number | null;
  }[];
  concentration: {
    largestSymbolShare: number | null;
    largestSessionShare: number | null;
    largestRegimeShare: number | null;
  };
  missedWinnerRate: number | null;
};

export type MatchedStrategyEvaluation = {
  marketId: MarketId;
  unit: "CAD" | "USD";
  status: "AVAILABLE" | "UNVERIFIED" | "INSUFFICIENT";
  qualification: "NOT_ASSESSED";
  economicBasis: "INDEPENDENT_SELECTED_OPPORTUNITIES";
  denominators: {
    matchedOpportunities: number;
    closedOutcomes: number;
    noFillOutcomes: number;
    invalidOutcomes: number;
    rejectedByCandidate: number;
    rejectedWinners: number;
    missedWinnerDenominator: number;
  };
  baseline: SideMetrics;
  candidate: SideMetrics;
  uncertainty: {
    status: "AVAILABLE" | "UNAVAILABLE" | "INSUFFICIENT";
    estimate: number | null;
    interval: { lower: number; upper: number } | null;
    independentSessions: number;
    method: "SEEDED_CIRCULAR_SESSION_BLOCK_BOOTSTRAP" | null;
  };
  reasonCodes: string[];
};

/**
 * Evaluate already-produced baseline/candidate selections over the same frozen opportunities.
 * A CLOSED outcome is authoritative persisted backtest evidence; no-fill is a known zero fill,
 * while INVALID is explicitly omitted from economics and blocks a complete comparison if selected.
 * Totals describe independent selections, not an account-level portfolio or equity curve.
 *
 * Adapter boundary: callers must join canonical replay opportunities/executions to closed
 * BacktestTrade records by the retained opportunity identity (setupInstanceId where proven,
 * otherwise the canonical replay identity). BacktestTrade alone omits READY no-fills and cannot
 * establish complete membership; never synthesize those rows from the trade list.
 */
export function evaluateMatchedStrategyEconomics(
  input: MatchedStrategyEvaluationInput,
): MatchedStrategyEvaluation {
  validateInput(input);
  const expected = new Set(input.expectedSessions);
  const expectedOpportunities = new Set(input.expectedOpportunityIds);
  if (expectedOpportunities.size !== input.expectedOpportunityIds.length)
    throw new Error("DUPLICATE_EXPECTED_OPPORTUNITY");
  const seen = new Set<string>();
  const seenTradeIds = new Set<string>();
  for (const row of input.opportunities) {
    if (seen.has(row.opportunityId))
      throw new Error(`DUPLICATE_OPPORTUNITY:${row.opportunityId}`);
    seen.add(row.opportunityId);
    if (!expectedOpportunities.has(row.opportunityId))
      throw new Error(`UNEXPECTED_OPPORTUNITY:${row.opportunityId}`);
    if (!expected.has(row.sessionDate))
      throw new Error(`UNEXPECTED_SESSION:${row.sessionDate}`);
    if (row.candidateSelected && !row.baselineSelected)
      throw new Error(`CANDIDATE_NOT_BASELINE_SELECTED:${row.opportunityId}`);
    if (row.outcome.status === "CLOSED") {
      const trade = row.outcome.trade;
      if (trade.symbol !== row.symbol)
        throw new Error(`OUTCOME_SYMBOL_MISMATCH:${row.opportunityId}`);
      if (localSessionDate(trade.entryTime, input.marketId) !== row.sessionDate)
        throw new Error(`OUTCOME_SESSION_MISMATCH:${row.opportunityId}`);
      if (seenTradeIds.has(trade.id))
        throw new Error(`DUPLICATE_TRADE:${trade.id}`);
      seenTradeIds.add(trade.id);
    }
  }

  if (
    seen.size !== expectedOpportunities.size ||
    [...expectedOpportunities].some((id) => !seen.has(id))
  )
    throw new Error("MISSING_MATCHED_OPPORTUNITY");

  const closed = input.opportunities.filter(
    (row) =>
      row.outcome.status === "CLOSED" &&
      validTrade(row.outcome.trade, input.sourceRunId),
  ).length;
  const noFill = input.opportunities.filter(
    (row) => row.outcome.status === "NO_FILL",
  ).length;
  const invalid = input.opportunities.length - closed - noFill;
  const rejected = input.opportunities.filter(
    (row) => row.baselineSelected && !row.candidateSelected,
  );
  const rejectedWinners = rejected.filter(
    (row) =>
      row.outcome.status === "CLOSED" &&
      validTrade(row.outcome.trade, input.sourceRunId) &&
      row.outcome.trade.netPnl > 0,
  ).length;
  const missedWinnerDenominator = input.opportunities.filter(
    (row) =>
      row.baselineSelected &&
      row.outcome.status === "CLOSED" &&
      validTrade(row.outcome.trade, input.sourceRunId) &&
      row.outcome.trade.netPnl > 0,
  ).length;
  const selectedInvalid = input.opportunities.some(
    (row) =>
      (row.baselineSelected || row.candidateSelected) &&
      (row.outcome.status === "INVALID" ||
        (row.outcome.status === "CLOSED" &&
          !validTrade(row.outcome.trade, input.sourceRunId))),
  );
  const evidenceVerified =
    input.coverageStatus === "VERIFIED" &&
    input.lineageStatus === "VERIFIED" &&
    !selectedInvalid;
  const baseline = summarizeSide(
    input,
    "baseline",
    undefined,
    evidenceVerified,
  );
  const candidate = summarizeSide(
    input,
    "candidate",
    {
      rejectedWinners,
      missedWinnerDenominator,
    },
    evidenceVerified,
  );
  const reasons: string[] = [];
  if (input.coverageStatus !== "VERIFIED") reasons.push("COVERAGE_UNVERIFIED");
  if (input.lineageStatus !== "VERIFIED") reasons.push("LINEAGE_UNVERIFIED");
  if (selectedInvalid) reasons.push("INVALID_SELECTED_OUTCOME");
  const uncertainty = pairedUncertainty(input);
  if (uncertainty.status === "INSUFFICIENT")
    reasons.push("MINIMUM_SESSIONS_NOT_MET");
  const status: MatchedStrategyEvaluation["status"] = !evidenceVerified
    ? "UNVERIFIED"
    : uncertainty.status === "INSUFFICIENT"
      ? "INSUFFICIENT"
      : "AVAILABLE";
  return {
    status,
    qualification: "NOT_ASSESSED",
    marketId: input.marketId,
    unit: input.unit,
    economicBasis: "INDEPENDENT_SELECTED_OPPORTUNITIES",
    denominators: {
      matchedOpportunities: input.opportunities.length,
      closedOutcomes: closed,
      noFillOutcomes: noFill,
      invalidOutcomes: invalid,
      rejectedByCandidate: rejected.length,
      rejectedWinners,
      missedWinnerDenominator,
    },
    baseline,
    candidate,
    uncertainty,
    reasonCodes: reasons,
  };
}

function summarizeSide(
  input: MatchedStrategyEvaluationInput,
  side: "baseline" | "candidate",
  missedWinners?: { rejectedWinners: number; missedWinnerDenominator: number },
  evidenceVerified = input.coverageStatus === "VERIFIED" &&
    input.lineageStatus === "VERIFIED",
): SideMetrics {
  const selected = input.opportunities.filter((row) => row[`${side}Selected`]);
  const trades = selected.flatMap((row) =>
    row.outcome.status === "CLOSED" &&
    validTrade(row.outcome.trade, input.sourceRunId)
      ? [{ row, trade: row.outcome.trade }]
      : [],
  );
  const noFillOutcomes = selected.filter(
    (row) => row.outcome.status === "NO_FILL",
  ).length;
  const invalidOutcomes = selected.length - trades.length - noFillOutcomes;
  const complete = invalidOutcomes === 0 && evidenceVerified;
  const netPnl = trades.reduce((sum, value) => sum + value.trade.netPnl, 0);
  const denominator = trades.length + noFillOutcomes;
  const totalForScenario = (bps: number, fee: number) =>
    trades.reduce(
      (sum, value) =>
        sum +
        value.trade.netPnl -
        ((value.trade.entryPrice + value.trade.exitPrice) *
          value.trade.shares *
          bps) /
          10_000 -
        fee,
      0,
    );
  return {
    selectedOpportunities: selected.length,
    closedOutcomes: trades.length,
    noFillOutcomes,
    invalidOutcomes,
    netPnl: complete ? netPnl : null,
    meanNetPnlPerSelectedOpportunity:
      complete && denominator > 0 ? netPnl / denominator : null,
    costSensitivity: input.extraCostScenarios.map((scenario) => ({
      ...scenario,
      netPnl: complete
        ? roundMoney(
            totalForScenario(
              scenario.extraSlippageBps,
              scenario.extraFeePerTrade,
            ),
          )
        : null,
    })),
    concentration: {
      largestSymbolShare: concentration(
        trades.map((value) => value.row.symbol),
      ),
      largestSessionShare: concentration(
        trades.map((value) => value.row.sessionDate),
      ),
      largestRegimeShare: concentration(
        trades.flatMap((value) => (value.row.regime ? [value.row.regime] : [])),
      ),
    },
    missedWinnerRate:
      side === "candidate" && missedWinners && evidenceVerified
        ? missedWinners.missedWinnerDenominator > 0
          ? missedWinners.rejectedWinners /
            missedWinners.missedWinnerDenominator
          : null
        : null,
  };
}

function pairedUncertainty(
  input: MatchedStrategyEvaluationInput,
): MatchedStrategyEvaluation["uncertainty"] {
  const hasSelectedInvalidOutcome = input.opportunities.some(
    (row) =>
      (row.baselineSelected || row.candidateSelected) &&
      (row.outcome.status === "INVALID" ||
        (row.outcome.status === "CLOSED" &&
          !validTrade(row.outcome.trade, input.sourceRunId))),
  );
  if (hasSelectedInvalidOutcome)
    return {
      status: "UNAVAILABLE",
      estimate: null,
      interval: null,
      independentSessions: 0,
      method: null,
    };
  const observedSessions = new Set(
    input.opportunities
      .filter(
        (row) =>
          row.outcome.status === "NO_FILL" ||
          (row.outcome.status === "CLOSED" &&
            validTrade(row.outcome.trade, input.sourceRunId)),
      )
      .map((row) => row.sessionDate),
  );
  const evidenceVerified =
    input.coverageStatus === "VERIFIED" && input.lineageStatus === "VERIFIED";
  // Verified expected sessions with zero eligible opportunities are genuine
  // zero-difference blocks; unverified inputs can report only observed sessions.
  const sampledSessions = evidenceVerified
    ? [...input.expectedSessions]
    : input.expectedSessions.filter((session) => observedSessions.has(session));
  const differences = sampledSessions.map((sessionDate) => {
    let baseline = 0;
    let candidate = 0;
    for (const row of input.opportunities) {
      if (row.sessionDate !== sessionDate) continue;
      if (
        (row.baselineSelected || row.candidateSelected) &&
        (row.outcome.status === "INVALID" ||
          (row.outcome.status === "CLOSED" &&
            !validTrade(row.outcome.trade, input.sourceRunId)))
      )
        return null;
      const value =
        row.outcome.status === "CLOSED" ? row.outcome.trade.netPnl : 0;
      if (row.baselineSelected) baseline += value;
      if (row.candidateSelected) candidate += value;
    }
    return candidate - baseline;
  });
  if (
    input.coverageStatus !== "VERIFIED" ||
    input.lineageStatus !== "VERIFIED" ||
    differences.some((value) => value === null)
  )
    return {
      status: "UNAVAILABLE",
      estimate: null,
      interval: null,
      independentSessions: sampledSessions.length,
      method: null,
    };
  if (differences.length < input.minimumSessions)
    return {
      status: "INSUFFICIENT",
      estimate: null,
      interval: null,
      independentSessions: differences.length,
      method: null,
    };
  const values = differences as number[];
  const estimates: number[] = [];
  let state = input.seed >>> 0;
  const next = () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  for (let sample = 0; sample < input.bootstrapSamples; sample++) {
    let sum = 0;
    let count = 0;
    while (count < values.length) {
      const start = Math.floor(next() * values.length);
      for (
        let offset = 0;
        offset < input.blockLength && count < values.length;
        offset++, count++
      )
        sum += values[(start + offset) % values.length]!;
    }
    estimates.push(sum / values.length);
  }
  estimates.sort((left, right) => left - right);
  return {
    status: "AVAILABLE",
    estimate: values.reduce((sum, value) => sum + value, 0) / values.length,
    interval: {
      lower: estimates[Math.floor((estimates.length - 1) * 0.025)]!,
      upper: estimates[Math.floor((estimates.length - 1) * 0.975)]!,
    },
    independentSessions: values.length,
    method: "SEEDED_CIRCULAR_SESSION_BLOCK_BOOTSTRAP",
  };
}

function validTrade(trade: BacktestTrade, sourceRunId: string): boolean {
  return (
    trade.runId === sourceRunId &&
    Number.isFinite(trade.netPnl) &&
    Number.isFinite(trade.grossPnl) &&
    Number.isFinite(trade.entryPrice) &&
    Number.isFinite(trade.exitPrice) &&
    Number.isFinite(trade.shares) &&
    trade.entryPrice > 0 &&
    trade.exitPrice > 0 &&
    trade.shares > 0
  );
}

function localSessionDate(timestamp: string, marketId: MarketId): string {
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return "INVALID_DATE";
  const timeZone =
    marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function concentration(values: readonly string[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Math.max(...counts.values()) / values.length;
}

function validateInput(input: MatchedStrategyEvaluationInput): void {
  if (
    (input.marketId === "CA_TSX" && input.unit !== "CAD") ||
    (input.marketId === "US_EQUITIES" && input.unit !== "USD")
  )
    throw new Error("UNIT_SCOPE_MISMATCH");
  if (
    !Number.isInteger(input.minimumSessions) ||
    input.minimumSessions < 2 ||
    !Number.isInteger(input.bootstrapSamples) ||
    input.bootstrapSamples < 1_000 ||
    !Number.isInteger(input.blockLength) ||
    input.blockLength < 1 ||
    input.blockLength > input.expectedSessions.length ||
    !Number.isInteger(input.seed) ||
    input.seed < 0 ||
    input.seed > 0xffff_ffff
  )
    throw new Error("INVALID_EVALUATION_CONFIG");
  for (let index = 0; index < input.expectedSessions.length; index++) {
    const session = input.expectedSessions[index]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(session))
      throw new Error(`INVALID_SESSION_DATE:${session}`);
    if (index > 0 && input.expectedSessions[index - 1]! >= session)
      throw new Error("EXPECTED_SESSIONS_NOT_SORTED");
  }
  for (const scenario of input.extraCostScenarios) {
    if (
      !Number.isFinite(scenario.extraSlippageBps) ||
      scenario.extraSlippageBps < 0 ||
      !Number.isFinite(scenario.extraFeePerTrade) ||
      scenario.extraFeePerTrade < 0
    )
      throw new Error("INVALID_COST_SCENARIO");
  }
}
