import {
  FUNDED_COMPARISON_MINIMUM_SESSIONS,
  FUNDED_COMPARISON_RESULT_VERSION,
  fundedComparisonResultSchema,
  fundedComparisonVetoReasonSchema,
  type FundedComparisonDeltaMetrics,
  type FundedComparisonPairedSession,
  type FundedComparisonPolicyEvaluation,
  type FundedComparisonResult,
  type FundedComparisonSide,
  type FundedComparisonSideMetrics,
  type FundedComparisonSpecification,
  type FundedComparisonVetoReason,
} from "@tsx-scanner/contracts";
import {
  fundedComparisonMetricsDigest,
  fundedComparisonPairedSessionDigest,
  fundedComparisonResultDigest,
} from "./funded-comparison-digest.js";
import type { FundedComparisonSideValuation } from "./funded-comparison-valuation.js";

/**
 * Absolute per-side metrics, challenger-minus-champion deltas and the ordered
 * paired session vector. It consumes only retained decisions, orders and the
 * proven valuation; a missing value stays explicit and an unknown veto reason
 * makes the classification UNAVAILABLE. It never emits a gate verdict.
 */

export interface FundedComparisonMetricDecision {
  readonly sourceOpportunityId: string;
  readonly action: "SUBMIT" | "DECLINE" | "DEFER";
  readonly policyReason: string | null;
  readonly vetoCode: FundedComparisonVetoReason | null;
  readonly requestedNotional: number | null;
  readonly requestedRisk: number | null;
  /** Realized value only where the retained terminal outcome is provable. */
  readonly realizedValue: number | null;
  readonly realizable: boolean;
}

export interface FundedComparisonMetricOrder {
  readonly requestedShares: number;
  readonly filledShares: number;
  readonly entryPriceMicros: number;
  readonly exitPriceMicros: number | null;
  readonly netPnlMicros: number | null;
  readonly slippageMicrosPerShare: number | null;
  readonly costsMicros: number;
}

export interface FundedComparisonSideMetricSession {
  readonly sessionDate: string;
  readonly valuation: FundedComparisonSideValuation;
  /** Mark-to-market equity immediately before this session's first effect. */
  readonly carryInEquity: number;
  readonly dailyLossLimit: number;
  readonly dailyPnl: number;
  readonly entriesAllowed: boolean;
  readonly openRisk: number;
  readonly grossNotional: number;
  readonly openPositions: number;
  readonly zeroTradeSessions: boolean;
}

export interface FundedComparisonSideMetricInput {
  readonly side: FundedComparisonSide;
  readonly specification: Pick<
    FundedComparisonSpecification,
    "marketId" | "currency" | "capital"
  >;
  readonly sessions: readonly FundedComparisonSideMetricSession[];
  readonly decisions: readonly FundedComparisonMetricDecision[];
  readonly orders: readonly FundedComparisonMetricOrder[];
  readonly evaluations: readonly FundedComparisonPolicyEvaluation[];
}

const MICROS = 1_000_000;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function assembleSideMetrics(
  input: FundedComparisonSideMetricInput,
): FundedComparisonSideMetrics {
  const proven = input.sessions.filter(
    (session) => session.valuation.status === "PROVEN",
  );
  if (proven.length !== input.sessions.length)
    throw new Error(
      "A side metric tree cannot be assembled from an unavailable valuation",
    );
  const sessions = [...input.sessions].sort((left, right) =>
    left.sessionDate.localeCompare(right.sessionDate),
  );
  const sessionReturns = sessions.map((session) => {
    const finalPoint = session.valuation.equityPoints.at(-1)!;
    return {
      sessionDate: session.sessionDate,
      netReturn: finalPoint.equity - session.carryInEquity,
    };
  });
  const totalNetReturn = sum(sessionReturns.map((row) => row.netReturn));
  // Drawdown is measured over the full chronological cross-session equity
  // series, never per session in isolation: a session that starts below an
  // earlier peak must not reset the running peak.
  const equitySeries = sessions.flatMap((session) =>
    session.valuation.equityPoints.map((point) => point.equity),
  );
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdown = 0;
  for (const equity of equitySeries) {
    if (equity > peak) peak = equity;
    if (Number.isFinite(peak)) {
      const drawdown = peak - equity;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }
  const vetoCounts = new Map<FundedComparisonVetoReason, number>();
  let unknownVeto = false;
  for (const decision of input.decisions) {
    if (decision.vetoCode === null || decision.action !== "DECLINE") continue;
    const parsed = fundedComparisonVetoReasonSchema.safeParse(
      decision.vetoCode,
    );
    if (!parsed.success) {
      unknownVeto = true;
      continue;
    }
    if (parsed.data === "UNKNOWN_VETO_REASON") {
      unknownVeto = true;
      continue;
    }
    vetoCounts.set(parsed.data, (vetoCounts.get(parsed.data) ?? 0) + 1);
  }
  const declines = new Map<string, number>();
  for (const decision of input.decisions) {
    if (decision.action === "SUBMIT") continue;
    if (decision.vetoCode !== null) continue;
    const reason = decision.policyReason ?? decision.action;
    declines.set(reason, (declines.get(reason) ?? 0) + 1);
  }
  const notSubmitted = input.decisions.filter(
    (decision) => decision.action !== "SUBMIT" || decision.vetoCode !== null,
  );
  const requestedCapitalRows = notSubmitted.filter(
    (decision) =>
      decision.requestedNotional !== null && decision.requestedRisk !== null,
  );
  const requestedCapitalAvailableCount = requestedCapitalRows.length;
  const requestedCapitalUnavailableCount =
    notSubmitted.length - requestedCapitalAvailableCount;
  const forgoneRequestedNotional =
    requestedCapitalUnavailableCount > 0
      ? null
      : sum(
          requestedCapitalRows.map((decision) => decision.requestedNotional!),
        );
  const forgoneRequestedRisk =
    requestedCapitalUnavailableCount > 0
      ? null
      : sum(requestedCapitalRows.map((decision) => decision.requestedRisk!));
  const realizedValues = notSubmitted.map((decision) => decision.realizedValue);
  const provableCount = notSubmitted.filter(
    (decision) => decision.realizable && decision.realizedValue !== null,
  ).length;
  const unprovableCount = notSubmitted.length - provableCount;
  const realizedValue =
    unprovableCount === 0 && provableCount > 0
      ? sum(realizedValues as number[])
      : null;
  const requested = input.orders.length;
  const filled = input.orders.filter((order) => order.filledShares > 0);
  const fullFills = input.orders.filter(
    (order) =>
      order.filledShares >= order.requestedShares && order.requestedShares > 0,
  ).length;
  const partialFills = filled.length - fullFills;
  const zeroFills = requested - filled.length;
  const requestedShares = sum(
    input.orders.map((order) => order.requestedShares),
  );
  const filledShares = sum(input.orders.map((order) => order.filledShares));
  const fillFraction = requestedShares > 0 ? filledShares / requestedShares : 0;
  // Average slippage per share is weighted by each order's filled shares; an
  // unfilled order contributes no execution observation.
  const slippageRows = input.orders.filter(
    (order) => order.slippageMicrosPerShare !== null && order.filledShares > 0,
  );
  const slippageWeight = sum(slippageRows.map((order) => order.filledShares));
  const averageSlippagePerShare =
    slippageWeight > 0
      ? sum(
          slippageRows.map(
            (order) =>
              (order.slippageMicrosPerShare! / MICROS) * order.filledShares,
          ),
        ) / slippageWeight
      : 0;
  // Turnover is gross traded notional: entry plus exit fills.
  const turnover = sum(
    input.orders.map(
      (order) =>
        ((order.entryPriceMicros + (order.exitPriceMicros ?? 0)) *
          order.filledShares) /
        MICROS,
    ),
  );
  const totalModeledCosts = sum(
    input.orders.map((order) => order.costsMicros / MICROS),
  );
  const zeroTradeSessions = sessions.filter(
    (session) => session.zeroTradeSessions,
  ).length;
  let longestReturnSignRun = 0;
  let currentRun = 0;
  let previousSign = 0;
  for (const row of sessionReturns) {
    const sign = Math.sign(row.netReturn);
    currentRun =
      sign !== 0 && sign === previousSign ? currentRun + 1 : sign === 0 ? 0 : 1;
    previousSign = sign;
    if (currentRun > longestReturnSignRun) longestReturnSignRun = currentRun;
  }
  const fallbackDecisionCount = input.evaluations.filter(
    (evaluation) => evaluation.disposition === "FALLBACK_CHAMPION_ORDER",
  ).length;
  const predictionAvailableCount = input.evaluations.filter(
    (evaluation) => evaluation.disposition === "PREDICTED",
  ).length;
  const predictionRequiredCount = input.evaluations.filter(
    (evaluation) => evaluation.disposition !== "CHAMPION_ORDER",
  ).length;
  return {
    return: {
      totalNetReturn,
      returnPctOfInitialCash:
        totalNetReturn / input.specification.capital.initialCash,
      sessions: sessionReturns,
    },
    drawdown: {
      maxDrawdown,
      maxDrawdownPctOfInitialCash:
        maxDrawdown / input.specification.capital.initialCash,
    },
    dailyLoss: {
      limitHits: sessions.filter(
        (session) => session.dailyPnl <= -session.dailyLossLimit,
      ).length,
      mostNegativeDailyPnl: Math.min(0, ...sessions.map((s) => s.dailyPnl)),
      sessionsBlocked: sessions.filter((session) => !session.entriesAllowed)
        .length,
    },
    risk: {
      maxOpenRisk: Math.max(0, ...sessions.map((session) => session.openRisk)),
      maxGrossNotional: Math.max(
        0,
        ...sessions.map((session) => session.grossNotional),
      ),
      maxOpenPositions: Math.max(
        0,
        ...sessions.map((session) => session.openPositions),
      ),
    },
    activity: {
      turnover,
      requested,
      partialFills,
      fullFills,
      zeroFills,
    },
    execution: {
      fillFraction,
      averageSlippagePerShare,
      totalModeledCosts,
    },
    veto: {
      classification: unknownVeto ? "UNAVAILABLE" : "AVAILABLE",
      counts: [...vetoCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => ({ reason, count })),
    },
    declines: [...declines.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => ({ reason, count })),
    opportunityCost: {
      declinedOrVetoedCount: notSubmitted.length,
      forgoneRequestedNotional,
      forgoneRequestedRisk,
      requestedCapitalAvailableCount,
      requestedCapitalUnavailableCount,
      realizedValue,
      provableCount,
      unprovableCount,
    },
    stability: {
      sessionCount: sessions.length,
      zeroTradeSessions,
      longestReturnSignRun,
    },
    integrity: {
      unresolvedExposure: sessions.reduce(
        (total, session) =>
          total + (session.valuation.integrityFindings.length > 0 ? 1 : 0),
        0,
      ),
      fallbackDecisionCount,
      predictionAvailableCount,
      predictionRequiredCount,
      findings: sessions.flatMap((session) =>
        session.valuation.integrityFindings.map(
          (finding) => `${session.sessionDate}: ${finding}`,
        ),
      ),
    },
  };
}

export interface FundedComparisonAssemblyInput {
  /** Only the frozen identities a result row actually names. */
  readonly specification: Pick<
    FundedComparisonSpecification,
    | "marketId"
    | "currency"
    | "capital"
    | "comparisonSpecDigest"
    | "sessionMembership"
  >;
  readonly sessionPairs: readonly {
    sessionDate: string;
    champion: FundedComparisonSideValuation;
    challenger: FundedComparisonSideValuation;
  }[];
  readonly champion: FundedComparisonSideMetrics;
  readonly challenger: FundedComparisonSideMetrics;
  readonly championEvaluationDigest: string;
  readonly challengerEvaluationDigest: string;
}

function numberOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Every value is `challenger − champion`. Exported so finalization can
 * recompute and validate the stored delta tree instead of trusting it.
 */
export function fundedComparisonDeltaMetricsOf(
  champion: FundedComparisonSideMetrics,
  challenger: FundedComparisonSideMetrics,
  pairedSessions: readonly FundedComparisonPairedSession[],
): FundedComparisonDeltaMetrics {
  const vetoUnavailable =
    champion.veto.classification === "UNAVAILABLE" ||
    challenger.veto.classification === "UNAVAILABLE";
  const outperformed = fundedComparisonOutperformedSessions(pairedSessions);
  return {
    totalNetReturn:
      challenger.return.totalNetReturn - champion.return.totalNetReturn,
    returnPctOfInitialCash:
      challenger.return.returnPctOfInitialCash -
      champion.return.returnPctOfInitialCash,
    maxDrawdown:
      challenger.drawdown.maxDrawdown - champion.drawdown.maxDrawdown,
    maxDrawdownPctOfInitialCash:
      challenger.drawdown.maxDrawdownPctOfInitialCash -
      champion.drawdown.maxDrawdownPctOfInitialCash,
    limitHits: challenger.dailyLoss.limitHits - champion.dailyLoss.limitHits,
    mostNegativeDailyPnl:
      challenger.dailyLoss.mostNegativeDailyPnl -
      champion.dailyLoss.mostNegativeDailyPnl,
    sessionsBlocked:
      challenger.dailyLoss.sessionsBlocked - champion.dailyLoss.sessionsBlocked,
    maxOpenRisk: challenger.risk.maxOpenRisk - champion.risk.maxOpenRisk,
    maxGrossNotional:
      challenger.risk.maxGrossNotional - champion.risk.maxGrossNotional,
    maxOpenPositions:
      challenger.risk.maxOpenPositions - champion.risk.maxOpenPositions,
    turnover: challenger.activity.turnover - champion.activity.turnover,
    requested: challenger.activity.requested - champion.activity.requested,
    partialFills:
      challenger.activity.partialFills - champion.activity.partialFills,
    fullFills: challenger.activity.fullFills - champion.activity.fullFills,
    zeroFills: challenger.activity.zeroFills - champion.activity.zeroFills,
    fillFraction:
      challenger.execution.fillFraction - champion.execution.fillFraction,
    averageSlippagePerShare:
      challenger.execution.averageSlippagePerShare -
      champion.execution.averageSlippagePerShare,
    totalModeledCosts:
      challenger.execution.totalModeledCosts -
      champion.execution.totalModeledCosts,
    vetoCount: vetoUnavailable
      ? null
      : sum(challenger.veto.counts.map((row) => row.count)) -
        sum(champion.veto.counts.map((row) => row.count)),
    declineCount: vetoUnavailable
      ? null
      : sum(challenger.declines.map((row) => row.count)) -
        sum(champion.declines.map((row) => row.count)),
    declinedOrVetoedCount:
      challenger.opportunityCost.declinedOrVetoedCount -
      champion.opportunityCost.declinedOrVetoedCount,
    forgoneRequestedNotional:
      challenger.opportunityCost.forgoneRequestedNotional === null ||
      champion.opportunityCost.forgoneRequestedNotional === null
        ? null
        : challenger.opportunityCost.forgoneRequestedNotional -
          champion.opportunityCost.forgoneRequestedNotional,
    forgoneRequestedRisk:
      challenger.opportunityCost.forgoneRequestedRisk === null ||
      champion.opportunityCost.forgoneRequestedRisk === null
        ? null
        : challenger.opportunityCost.forgoneRequestedRisk -
          champion.opportunityCost.forgoneRequestedRisk,
    zeroTradeSessions:
      challenger.stability.zeroTradeSessions -
      champion.stability.zeroTradeSessions,
    longestReturnSignRun:
      challenger.stability.longestReturnSignRun -
      champion.stability.longestReturnSignRun,
    sessionCount:
      challenger.stability.sessionCount - champion.stability.sessionCount,
    challengerOutperformedSessions: outperformed.count,
    unavailable: [
      ...(vetoUnavailable ? ["vetoCount", "declineCount"] : []),
      ...(challenger.opportunityCost.forgoneRequestedNotional === null ||
      champion.opportunityCost.forgoneRequestedNotional === null
        ? ["forgoneRequestedNotional"]
        : []),
      ...(challenger.opportunityCost.forgoneRequestedRisk === null ||
      champion.opportunityCost.forgoneRequestedRisk === null
        ? ["forgoneRequestedRisk"]
        : []),
      ...(champion.opportunityCost.realizedValue === null ||
      challenger.opportunityCost.realizedValue === null
        ? ["opportunityCost.realizedValue"]
        : []),
    ],
  };
}

/** Comparable sessions where the challenger return strictly exceeds the champion. */
export function fundedComparisonOutperformedSessions(
  pairedSessions: readonly FundedComparisonPairedSession[],
): { count: number; proportion: number } {
  const count = pairedSessions.filter(
    (session) =>
      session.baselineNetReturn !== null &&
      session.challengerNetReturn !== null &&
      session.challengerNetReturn > session.baselineNetReturn,
  ).length;
  return {
    count,
    proportion: pairedSessions.length > 0 ? count / pairedSessions.length : 0,
  };
}

export function assembleComparisonResult(
  input: FundedComparisonAssemblyInput,
): FundedComparisonResult {
  const frozenSessionDates =
    input.specification.sessionMembership.orderedSessionDates;
  const suppliedSessionDates = input.sessionPairs.map(
    (pair) => pair.sessionDate,
  );
  if (
    suppliedSessionDates.length !== frozenSessionDates.length ||
    suppliedSessionDates.some(
      (sessionDate, index) => sessionDate !== frozenSessionDates[index],
    )
  )
    throw new Error(
      "A paired result must cover the exact frozen session membership",
    );
  const sessionCount = input.sessionPairs.length;
  const unproven = input.sessionPairs.filter(
    (pair) =>
      pair.champion.status !== "PROVEN" || pair.challenger.status !== "PROVEN",
  );
  if (unproven.length > 0)
    throw new Error(
      "A paired result requires both sides PROVEN for every frozen session",
    );
  const pairedSessions: FundedComparisonPairedSession[] = input.sessionPairs
    .map((pair) => ({
      sessionDate: pair.sessionDate,
      baselineNetReturn:
        pair.champion.equityPoints.at(-1)!.equity -
        pair.champion.equityPoints[0]!.equity,
      challengerNetReturn:
        pair.challenger.equityPoints.at(-1)!.equity -
        pair.challenger.equityPoints[0]!.equity,
      baselineMaxDrawdown: pair.champion.maxDrawdown,
      challengerMaxDrawdown: pair.challenger.maxDrawdown,
      valuation: "UNION_GRID_MTM" as const,
      coverage: "VERIFIED" as const,
    }))
    .sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
  const champion = input.champion;
  const challenger = input.challenger;
  const deltas = fundedComparisonDeltaMetricsOf(
    champion,
    challenger,
    pairedSessions,
  );
  const outperformed = fundedComparisonOutperformedSessions(pairedSessions);
  const championMetricsDigest = fundedComparisonMetricsDigest(champion);
  const challengerMetricsDigest = fundedComparisonMetricsDigest(challenger);
  const withoutDigest = {
    resultVersion: FUNDED_COMPARISON_RESULT_VERSION,
    comparisonSpecDigest: input.specification.comparisonSpecDigest,
    marketId: input.specification.marketId,
    currency: input.specification.currency,
    sessionCount,
    historicalVolumeStatus:
      sessionCount >= FUNDED_COMPARISON_MINIMUM_SESSIONS
        ? ("SUFFICIENT_FOR_LATER_G2" as const)
        : ("INSUFFICIENT_SESSIONS" as const),
    pairedSessions,
    champion,
    challenger,
    deltas,
    challengerOutperformedSessions: outperformed,
    championEvaluationDigest: input.championEvaluationDigest,
    challengerEvaluationDigest: input.challengerEvaluationDigest,
    championMetricsDigest,
    challengerMetricsDigest,
  };
  const resultDigest = fundedComparisonResultDigest({
    comparisonSpecDigest: input.specification.comparisonSpecDigest,
    championEvaluationDigest: input.championEvaluationDigest,
    challengerEvaluationDigest: input.challengerEvaluationDigest,
    championMetricsDigest,
    challengerMetricsDigest,
    orderedPairedSessionDigests: pairedSessions.map((session) =>
      fundedComparisonPairedSessionDigest(
        { pairedSessions: [session] },
        session.sessionDate,
      ),
    ),
  });
  void numberOrNull;
  return fundedComparisonResultSchema.parse({
    ...withoutDigest,
    resultDigest,
  });
}
