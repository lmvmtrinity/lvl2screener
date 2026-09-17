/**
 * Deterministic, side-effect-free selection policy for the coordinated paper
 * portfolio. Independent per-strategy executions remain outside this module
 * so qualification evidence is never silently filtered by portfolio rules.
 *
 * v2 (docs/paper-bot-performance-improvement-plan.md, Phases 4 and 5) adds
 * symbol/sector exposure limits, market and sector context freshness and veto
 * rules, a DEFERRED outcome for suppressions that can clear later in the same
 * session, and ranking by cost-inclusive economics and independent-family
 * confirmation rather than by raw score.
 *
 * v4 incorporates audit remediations (2026-09-04):
 * - Disentangled cumulative gross losses from net realized session P&L (dailyCumulativeLoss vs dailyNetRealizedPnl)
 * - Configurable daily loss limits: CUMULATIVE_LOSS vs NET_REALIZED_LOSS
 * - Proactive daily risk budget reservation (reserveRemainingDailyRisk)
 * - Reconstructed point-in-time portfolio state (openPortfolioNotional, pendingCloseCount)
 * - Chronological backlog processing with deterministic cross-symbol prioritization (F-06)
 * - Capacity-constrained portfolio execution sizing default (F-05)
 */

export const COORDINATION_POLICY_VERSION = "paper-coordination-v4";

export type StrategyFamily =
  "OPENING_RANGE" | "VWAP" | "BREAKOUT" | "CONTINUATION" | "CONTEXT";

export type CoordinationReason =
  | "SELECTED_PRIMARY"
  | "NO_FEASIBLE_CANDIDATE"
  | "SYMBOL_POSITION_OPEN"
  | "POST_STOP_COOLDOWN"
  | "MAX_CONCURRENT_POSITIONS"
  | "PORTFOLIO_RISK_LIMIT"
  | "PORTFOLIO_RECONCILIATION_REQUIRED"
  | "SYMBOL_EXPOSURE_LIMIT"
  | "SECTOR_EXPOSURE_LIMIT"
  | "DAILY_LOSS_LIMIT"
  | "CONSECUTIVE_STOP_LIMIT"
  | "CONTEXT_UNAVAILABLE"
  | "CONTEXT_STALE"
  | "SECTOR_CONTEXT_UNAVAILABLE"
  | "SECTOR_CONTEXT_STALE"
  | "CONTEXT_VETO"
  | "NON_PRIMARY_CANDIDATE"
  | "PREDICTED_LOW_EXPECTANCY";

export type CoordinationOutcome = "APPROVED" | "REJECTED" | "DEFERRED";

/**
 * A suppression that can clear later in the same session is DEFERRED; a
 * judgment about this candidate batch, or a day-terminal circuit breaker, is
 * REJECTED. Both are persisted; neither ever touches strategy state.
 */
const DEFERRABLE_REASONS: ReadonlySet<CoordinationReason> = new Set([
  "SYMBOL_POSITION_OPEN",
  "POST_STOP_COOLDOWN",
  "MAX_CONCURRENT_POSITIONS",
  "PORTFOLIO_RISK_LIMIT",
  "PORTFOLIO_RECONCILIATION_REQUIRED",
  "SYMBOL_EXPOSURE_LIMIT",
  "SECTOR_EXPOSURE_LIMIT",
  "CONTEXT_UNAVAILABLE",
  "CONTEXT_STALE",
  "SECTOR_CONTEXT_UNAVAILABLE",
  "SECTOR_CONTEXT_STALE",
]);

export interface CandidatePrediction {
  readonly modelId?: string;
  readonly modelVersion?: string;
  readonly predictionTimestamp?: string;
  readonly predictedProbability?: number;
  readonly payloadDigest?: string;
  readonly warnings?: readonly string[];
  readonly fallbackReason?: string | null;
  readonly expectedR?: number | null;
  readonly payoffDistribution?: {
    readonly winExpectedR: number;
    readonly lossExpectedR: number;
    readonly sampleCount: number;
    readonly priorSampleCount: number;
  };
}

export interface CoordinationCandidate {
  readonly observationId: string;
  readonly strategyKey: string;
  readonly strategyVersion: string;
  readonly score: number;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  /** False when execution/economics validation has already rejected it. */
  readonly economicallyViable: boolean;
  /** The gate's primary reason when `economicallyViable` is false. */
  readonly economicsReason?: string | null;
  /**
   * Cost-inclusive reward/risk from the economics gate. Ranking prefers this
   * over the raw geometric ratio, which ignores friction entirely.
   */
  readonly netRewardRisk?: number | null;
  readonly estimatedInitialRisk: number;
  readonly estimatedShares?: number;
  readonly estimatedNotional?: number;
  /** Observational prediction at signal time, if available. */
  readonly prediction?: CandidatePrediction;
}

export type ContextStatus =
  "UNAVAILABLE" | "WEAK" | "NEUTRAL" | "STRONG" | "STALE";

/** One market- or sector-level context reading at the decision time. */
export interface ContextSnapshot {
  readonly signalKey: string;
  readonly status: ContextStatus;
  readonly score: number;
  readonly timestamp: string;
}

export interface CoordinationState {
  /** A coordinated, rather than independent, position is currently open. */
  readonly hasOpenSymbolPosition: boolean;
  /** Timestamp of the most recent coordinated stop, if any. */
  readonly lastStopAt: string | null;
  readonly openPositionCount: number;
  readonly totalOpenRisk: number;
  /** Cumulative gross loss across all losing trades closed during the session (F-10). */
  readonly dailyCumulativeLoss?: number;
  /** Net realized P&L across all closed trades in the session (F-10). */
  readonly dailyNetRealizedPnl?: number;
  /** Backward-compatible alias for dailyCumulativeLoss. */
  readonly dailyRealizedLoss: number;
  readonly consecutiveStops: number;
  /** An earlier run still owns unresolved portfolio state. */
  readonly portfolioReconciliationRequired?: boolean;
  readonly sector?: string | null;
  readonly openSymbolNotional?: number;
  readonly openSectorNotional?: number;
  /** Total entry notional of all open coordinated positions (F-10). */
  readonly openPortfolioNotional?: number;
  /** Number of positions currently pending noon/session close. */
  readonly pendingCloseCount?: number;
  /** Market and sector readings captured with the decision, for the record. */
  readonly contexts?: readonly ContextSnapshot[];
}

export interface CoordinationPolicy {
  readonly cooldownMinutesAfterStop: number;
  readonly maxOpenPositions: number;
  readonly maxTotalOpenRisk: number;
  readonly maxDailyLoss: number;
  /**
   * Daily loss control definition (F-10):
   * - 'CUMULATIVE_LOSS' (default): cumulative loss on losing trades.
   * - 'NET_REALIZED_LOSS': net realized P&L (wins - losses).
   */
  readonly dailyLossLimitType?: "CUMULATIVE_LOSS" | "NET_REALIZED_LOSS";
  /** When true, reserve remaining daily risk: halt if loss + open risk + candidate risk > maxDailyLoss (F-10). */
  readonly reserveRemainingDailyRisk?: boolean;
  readonly maxConsecutiveStops: number;
  /** Shadow portfolio time stop. Strategy-specific values can be supplied by
   * the caller in a later policy version; this conservative default prevents
   * an indefinitely stalled coordinated position. */
  readonly maximumHoldingMinutes?: number;
  /** Per-strategy overrides of the holding horizon, keyed by strategy key. */
  readonly maximumHoldingMinutesByStrategy?: Readonly<Record<string, number>>;
  /**
   * A breakout that has not made this much progress toward its target, in
   * multiples of per-share initial risk, after `stalledBreakoutMinutes` is
   * treated as failed and exited. Applies only to breakout-shaped families:
   * a mean-reversion thesis is not invalidated by sitting still.
   */
  readonly stalledBreakoutMinutes?: number;
  readonly stalledBreakoutMinProgressR?: number;
  readonly maxSymbolNotional?: number;
  readonly maxSectorNotional?: number;
  /** Refuse to coordinate without a usable market/sector reading. */
  readonly requireFreshContext?: boolean;
  readonly contextMaxAgeSeconds?: number;
  /** A coordinated account may require both market and sector evidence. */
  readonly contextRequirement?: "MARKET_ONLY" | "MARKET_AND_SECTOR_REQUIRED";
  /** Treat a WEAK reading as a veto rather than as merely lower priority. */
  readonly vetoOnWeakContext?: boolean;
  /** Phase 4: Minimum expected R or probability threshold for statistical veto */
  readonly minimumExpectedR?: number;
  readonly minimumSetupProbability?: number;
  /** Phase 5: Enable bounded edge-based sizing multiplier in shadow */
  readonly edgeSizingMultiplierEnabled?: boolean;
}

export const SHADOW_COORDINATION_POLICY_VERSION =
  "paper-coordination-v4-shadow";

export interface ShadowCoordinationDecision {
  readonly policyVersion: typeof SHADOW_COORDINATION_POLICY_VERSION;
  readonly outcome: CoordinationOutcome;
  readonly reason: CoordinationReason;
  readonly selectedObservationId: string | null;
  readonly selectedStrategyKey: string | null;
  readonly rankedCandidates: readonly RankedCandidate[];
  readonly differsFromPrimary: boolean;
  readonly differenceReason: string | null;
  /** Shadow-only allocation calculation. It never changes the v3 position. */
  readonly sizing: {
    readonly baseRisk: number | null;
    readonly baseShares: number | null;
    readonly multiplier: number;
    readonly finalRisk: number | null;
    readonly finalShares: number | null;
    readonly reason: string;
  } | null;
}

export interface RankedCandidate extends CoordinationCandidate {
  readonly family: StrategyFamily;
  readonly rewardRisk: number;
  /** Feasible candidates from other families, i.e. independent confirmation. */
  readonly confirmationCount: number;
  readonly eligibleAsPrimary: boolean;
  /** False if model-informed veto excluded this candidate in v4 shadow. */
  readonly statisticallyVetoed?: boolean;
}

export interface CoordinationDecision {
  readonly policyVersion: typeof COORDINATION_POLICY_VERSION;
  readonly outcome: CoordinationOutcome;
  readonly reason: CoordinationReason;
  readonly selectedObservationId: string | null;
  readonly selectedStrategyKey: string | null;
  /** Strategies in distinct families that corroborate the selected thesis. */
  readonly confirmationObservationIds: readonly string[];
  /** Every input candidate, sorted deterministically by selection priority. */
  readonly rankedCandidates: readonly RankedCandidate[];
  /** The context readings the decision was made against. */
  readonly contexts: readonly ContextSnapshot[];
  readonly contextAlignment: number;
  readonly shadowDecision?: ShadowCoordinationDecision;
}

export function strategyFamily(strategyKey: string): StrategyFamily {
  switch (strategyKey) {
    case "ORB_RETEST":
      return "OPENING_RANGE";
    case "VWAP_HOLD":
    case "VWAP_RECLAIM":
    case "RSI_VWAP_RECLAIM":
      return "VWAP";
    case "HIGH_OF_DAY_BREAKOUT":
    case "PRIOR_DAY_HIGH_BREAKOUT":
      return "BREAKOUT";
    case "BULL_FLAG":
      return "CONTINUATION";
    case "MARKET_RELATIVE_STRENGTH":
    case "SECTOR_RELATIVE_STRENGTH":
      return "CONTEXT";
    default:
      // New strategies must remain visible and deterministic until explicitly
      // classified; grouping them with a known family would invent evidence.
      return "CONTINUATION";
  }
}

/** Context evidence is never a setup: it can confirm or veto, never lead. */
export function canLeadPosition(strategyKey: string): boolean {
  return strategyFamily(strategyKey) !== "CONTEXT";
}

function rewardRisk(candidate: CoordinationCandidate): number | null {
  const { entryPrice, stopPrice, targetPrice } = candidate;
  if (
    entryPrice === null ||
    stopPrice === null ||
    targetPrice === null ||
    !(stopPrice < entryPrice && entryPrice < targetPrice)
  ) {
    return null;
  }
  // Prefer the gate's cost-inclusive ratio; fall back to geometry only when a
  // candidate reached here without an economics evaluation.
  return (
    candidate.netRewardRisk ??
    (targetPrice - entryPrice) / (entryPrice - stopPrice)
  );
}

const ALIGNMENT_BY_STATUS: Readonly<Record<ContextStatus, number>> = {
  STRONG: 2,
  NEUTRAL: 1,
  WEAK: 0,
  STALE: 0,
  UNAVAILABLE: 0,
};

function contextAlignmentOf(contexts: readonly ContextSnapshot[]): number {
  const usable = contexts.filter(
    (context) => context.status !== "STALE" && context.status !== "UNAVAILABLE",
  );
  if (usable.length === 0) return 0;
  return (
    usable.reduce(
      (total, context) => total + ALIGNMENT_BY_STATUS[context.status],
      0,
    ) / usable.length
  );
}

export function rankCandidates(
  candidates: readonly CoordinationCandidate[],
): RankedCandidate[] {
  const feasible = candidates.flatMap((candidate) => {
    const ratio = rewardRisk(candidate);
    return candidate.economicallyViable && ratio !== null
      ? [{ candidate, ratio, family: strategyFamily(candidate.strategyKey) }]
      : [];
  });
  return feasible
    .map(({ candidate, ratio, family }) => ({
      ...candidate,
      family,
      rewardRisk: ratio,
      confirmationCount: feasible.filter((other) => other.family !== family)
        .length,
      eligibleAsPrimary: canLeadPosition(candidate.strategyKey),
    }))
    .sort(
      (left, right) =>
        Number(right.eligibleAsPrimary) - Number(left.eligibleAsPrimary) ||
        right.rewardRisk - left.rewardRisk ||
        right.confirmationCount - left.confirmationCount ||
        // Context alignment is deliberately absent here: it is a decision-level
        // fact about the symbol, identical for every candidate in the batch, so
        // it gates the decision (classifyContext) instead of ordering it.
        right.score - left.score ||
        left.strategyKey.localeCompare(right.strategyKey) ||
        left.strategyVersion.localeCompare(right.strategyVersion) ||
        left.observationId.localeCompare(right.observationId),
    );
}

function assertPolicy(policy: CoordinationPolicy): void {
  if (
    !Number.isInteger(policy.cooldownMinutesAfterStop) ||
    policy.cooldownMinutesAfterStop < 0
  ) {
    throw new Error(
      "cooldownMinutesAfterStop must be a non-negative whole number",
    );
  }
  if (
    !Number.isInteger(policy.maxOpenPositions) ||
    policy.maxOpenPositions < 1 ||
    policy.maxTotalOpenRisk <= 0 ||
    policy.maxDailyLoss <= 0 ||
    !Number.isInteger(policy.maxConsecutiveStops) ||
    policy.maxConsecutiveStops < 1
  )
    throw new Error("portfolio limits must be positive");
  if (
    (policy.maxSymbolNotional !== undefined && policy.maxSymbolNotional <= 0) ||
    (policy.maxSectorNotional !== undefined && policy.maxSectorNotional <= 0) ||
    (policy.contextMaxAgeSeconds !== undefined &&
      policy.contextMaxAgeSeconds <= 0)
  )
    throw new Error("exposure and context limits must be positive");
}

/**
 * Classifies the market/sector context. Returns the blocking reason, or null
 * when the context permits a coordinated entry. Context can never manufacture
 * a setup; it can only withhold one.
 */
function classifyContext(
  contexts: readonly ContextSnapshot[],
  policy: CoordinationPolicy,
  decisionTimestamp: string,
): CoordinationReason | null {
  if (policy.requireFreshContext !== true) return null;
  if (contexts.length === 0) return "CONTEXT_UNAVAILABLE";
  const maxAgeMs = (policy.contextMaxAgeSeconds ?? 300) * 1_000;
  const decisionMs = new Date(decisionTimestamp).getTime();
  const fresh = contexts.filter(
    (context) =>
      context.status !== "STALE" &&
      context.status !== "UNAVAILABLE" &&
      decisionMs - new Date(context.timestamp).getTime() <= maxAgeMs,
  );
  if (fresh.length === 0) return "CONTEXT_STALE";
  if (policy.contextRequirement === "MARKET_AND_SECTOR_REQUIRED") {
    const market = contexts.find(
      (context) => context.signalKey === "MARKET_RELATIVE_STRENGTH",
    );
    const sector = contexts.find(
      (context) => context.signalKey === "SECTOR_RELATIVE_STRENGTH",
    );
    if (!market) return "CONTEXT_UNAVAILABLE";
    if (!sector || sector.status === "UNAVAILABLE")
      return "SECTOR_CONTEXT_UNAVAILABLE";
    if (
      market.status === "STALE" ||
      decisionMs - new Date(market.timestamp).getTime() > maxAgeMs
    )
      return "CONTEXT_STALE";
    if (
      sector.status === "STALE" ||
      decisionMs - new Date(sector.timestamp).getTime() > maxAgeMs
    )
      return "SECTOR_CONTEXT_STALE";
  }
  if (
    policy.vetoOnWeakContext === true &&
    fresh.some((context) => context.status === "WEAK")
  )
    return "CONTEXT_VETO";
  return null;
}

/** The holding horizon for one strategy, falling back to the portfolio default. */
export function maximumHoldingMinutesFor(
  policy: CoordinationPolicy,
  strategyKey: string,
  fallbackMinutes = 45,
): number {
  return (
    policy.maximumHoldingMinutesByStrategy?.[strategyKey] ??
    policy.maximumHoldingMinutes ??
    fallbackMinutes
  );
}

/**
 * True when a breakout-shaped position has been open past the stall horizon
 * without making the required progress toward its target. Evaluated from the
 * current quote alone so live and replay reach the same verdict.
 */
export function isStalledBreakout(
  policy: CoordinationPolicy,
  strategyKey: string,
  position: {
    readonly entryPrice: number;
    readonly stop: number;
    readonly entryTime: string;
  },
  bid: number,
  at: string,
): boolean {
  const minutes = policy.stalledBreakoutMinutes;
  const minProgressR = policy.stalledBreakoutMinProgressR;
  if (minutes === undefined || minProgressR === undefined) return false;
  const family = strategyFamily(strategyKey);
  if (family !== "BREAKOUT" && family !== "OPENING_RANGE") return false;
  const heldMs =
    new Date(at).getTime() - new Date(position.entryTime).getTime();
  if (heldMs < minutes * 60_000) return false;
  const riskPerShare = position.entryPrice - position.stop;
  if (riskPerShare <= 0) return false;
  return (bid - position.entryPrice) / riskPerShare < minProgressR;
}

function rankCandidatesV4Shadow(
  candidates: readonly CoordinationCandidate[],
  policy: CoordinationPolicy,
): { ranked: RankedCandidate[]; vetoedCount: number; feasibleCount: number } {
  const feasible = candidates.flatMap((candidate) => {
    const ratio = rewardRisk(candidate);
    return candidate.economicallyViable && ratio !== null
      ? [{ candidate, ratio, family: strategyFamily(candidate.strategyKey) }]
      : [];
  });

  // A partial batch must retain exactly the deterministic order. Otherwise a
  // candidate with a prediction could leapfrog one whose model call failed.
  if (
    feasible.some(
      ({ candidate }) =>
        candidate.prediction?.predictedProbability === undefined ||
        candidate.prediction.fallbackReason,
    )
  ) {
    return {
      ranked: rankCandidates(candidates).map((candidate) => ({
        ...candidate,
        statisticallyVetoed: false,
      })),
      vetoedCount: 0,
      feasibleCount: feasible.length,
    };
  }

  let vetoedCount = 0;
  const ranked = feasible
    .map(({ candidate, ratio, family }) => {
      let statisticallyVetoed = false;
      const prob = candidate.prediction?.predictedProbability;
      const expR = candidate.prediction?.expectedR;
      if (
        policy.minimumSetupProbability !== undefined &&
        prob !== undefined &&
        prob < policy.minimumSetupProbability
      ) {
        statisticallyVetoed = true;
      }
      if (
        policy.minimumExpectedR !== undefined &&
        expR !== undefined &&
        expR !== null &&
        expR < policy.minimumExpectedR
      ) {
        statisticallyVetoed = true;
      }
      if (statisticallyVetoed) vetoedCount++;
      return {
        ...candidate,
        family,
        rewardRisk: ratio,
        confirmationCount: feasible.filter((other) => other.family !== family)
          .length,
        eligibleAsPrimary:
          canLeadPosition(candidate.strategyKey) && !statisticallyVetoed,
        statisticallyVetoed,
      };
    })
    .sort((left, right) => {
      const primaryDiff =
        Number(right.eligibleAsPrimary) - Number(left.eligibleAsPrimary);
      if (primaryDiff !== 0) return primaryDiff;

      const rrDiff = right.rewardRisk - left.rewardRisk;
      if (Math.abs(rrDiff) > 1e-6) return rrDiff;

      const leftProb = left.prediction?.predictedProbability ?? 0;
      const rightProb = right.prediction?.predictedProbability ?? 0;
      const probDiff = rightProb - leftProb;
      if (Math.abs(probDiff) > 1e-6) return probDiff;

      const leftExpR = left.prediction?.expectedR;
      const rightExpR = right.prediction?.expectedR;
      if (
        leftExpR !== undefined &&
        leftExpR !== null &&
        rightExpR !== undefined &&
        rightExpR !== null
      ) {
        const expDiff = rightExpR - leftExpR;
        if (Math.abs(expDiff) > 1e-6) return expDiff;
      }

      const confDiff = right.confirmationCount - left.confirmationCount;
      if (confDiff !== 0) return confDiff;

      const scoreDiff = right.score - left.score;
      if (scoreDiff !== 0) return scoreDiff;

      return (
        left.strategyKey.localeCompare(right.strategyKey) ||
        left.strategyVersion.localeCompare(right.strategyVersion) ||
        left.observationId.localeCompare(right.observationId)
      );
    });

  return { ranked, vetoedCount, feasibleCount: feasible.length };
}

export function calculateEdgeSizingMultiplier(
  candidate: CoordinationCandidate,
  policy: CoordinationPolicy,
): { multiplier: number; reason: string } {
  if (!policy.edgeSizingMultiplierEnabled) {
    return { multiplier: 1.0, reason: "SIZING_MULTIPLIER_DISABLED" };
  }
  const prob = candidate.prediction?.predictedProbability;
  if (prob === undefined || candidate.prediction?.fallbackReason) {
    return { multiplier: 1.0, reason: "NO_ACTIVE_PREDICTION_FALLBACK" };
  }
  const normalized = Math.max(0, Math.min(1, (prob - 0.45) / 0.25));
  const multiplier = Math.round((0.5 + 0.5 * normalized) * 100) / 100;
  return { multiplier, reason: `EDGE_SCALED_PROB_${prob.toFixed(3)}` };
}

function evaluatePortfolioGates(
  selected: RankedCandidate,
  state: CoordinationState,
  policy: CoordinationPolicy,
  decisionTimestamp: string,
  contexts: readonly ContextSnapshot[],
): CoordinationReason | null {
  if (state.portfolioReconciliationRequired === true)
    return "PORTFOLIO_RECONCILIATION_REQUIRED";
  if (state.hasOpenSymbolPosition) return "SYMBOL_POSITION_OPEN";
  if (state.lastStopAt !== null) {
    const cooldownEndsAt =
      new Date(state.lastStopAt).getTime() +
      policy.cooldownMinutesAfterStop * 60_000;
    if (new Date(decisionTimestamp).getTime() < cooldownEndsAt)
      return "POST_STOP_COOLDOWN";
  }
  const contextReason = classifyContext(contexts, policy, decisionTimestamp);
  if (contextReason !== null) return contextReason;
  if (state.openPositionCount >= policy.maxOpenPositions)
    return "MAX_CONCURRENT_POSITIONS";
  const currentDailyLoss =
    policy.dailyLossLimitType === "NET_REALIZED_LOSS"
      ? Math.max(0, -(state.dailyNetRealizedPnl ?? 0))
      : (state.dailyCumulativeLoss ?? state.dailyRealizedLoss);
  if (currentDailyLoss >= policy.maxDailyLoss) return "DAILY_LOSS_LIMIT";
  if (policy.reserveRemainingDailyRisk === true) {
    if (
      currentDailyLoss + state.totalOpenRisk + selected.estimatedInitialRisk >
      policy.maxDailyLoss
    ) {
      return "DAILY_LOSS_LIMIT";
    }
  }
  if (state.consecutiveStops >= policy.maxConsecutiveStops)
    return "CONSECUTIVE_STOP_LIMIT";
  if (
    state.totalOpenRisk + selected.estimatedInitialRisk >
    policy.maxTotalOpenRisk
  )
    return "PORTFOLIO_RISK_LIMIT";
  if (
    policy.maxSymbolNotional !== undefined &&
    (state.openSymbolNotional ?? 0) >= policy.maxSymbolNotional
  )
    return "SYMBOL_EXPOSURE_LIMIT";
  if (
    policy.maxSectorNotional !== undefined &&
    (state.openSectorNotional ?? 0) >= policy.maxSectorNotional
  )
    return "SECTOR_EXPOSURE_LIMIT";
  return null;
}

export function coordinateCandidates(
  candidates: readonly CoordinationCandidate[],
  state: CoordinationState,
  policy: CoordinationPolicy,
  decisionTimestamp: string,
): CoordinationDecision {
  assertPolicy(policy);
  const contexts = state.contexts ?? [];
  const contextAlignment = contextAlignmentOf(contexts);
  const rankedCandidates = rankCandidates(candidates);

  const selected = rankedCandidates.find(
    (candidate) => candidate.eligibleAsPrimary,
  );
  let primaryOutcome: CoordinationOutcome;
  let primaryReason: CoordinationReason;
  let primarySelectedId: string | null = null;
  let primarySelectedKey: string | null = null;
  let primaryConfirmations: string[] = [];

  if (selected === undefined) {
    primaryReason = "NO_FEASIBLE_CANDIDATE";
    primaryOutcome = "REJECTED";
  } else {
    const gateReason = evaluatePortfolioGates(
      selected,
      state,
      policy,
      decisionTimestamp,
      contexts,
    );
    if (gateReason !== null) {
      primaryReason = gateReason;
      primaryOutcome = DEFERRABLE_REASONS.has(gateReason)
        ? "DEFERRED"
        : "REJECTED";
    } else {
      primaryOutcome = "APPROVED";
      primaryReason = "SELECTED_PRIMARY";
      primarySelectedId = selected.observationId;
      primarySelectedKey = selected.strategyKey;
      primaryConfirmations = rankedCandidates
        .filter((candidate) => candidate.family !== selected.family)
        .map((candidate) => candidate.observationId);
    }
  }

  // Shadow v4 evaluation
  const {
    ranked: shadowRanked,
    vetoedCount,
    feasibleCount,
  } = rankCandidatesV4Shadow(candidates, policy);
  const shadowSelected = shadowRanked.find(
    (candidate) => candidate.eligibleAsPrimary,
  );
  let shadowOutcome: CoordinationOutcome;
  let shadowReason: CoordinationReason;
  let shadowSelectedId: string | null = null;
  let shadowSelectedKey: string | null = null;

  if (feasibleCount === 0) {
    shadowOutcome = "REJECTED";
    shadowReason = "NO_FEASIBLE_CANDIDATE";
  } else if (shadowSelected === undefined && vetoedCount > 0) {
    shadowOutcome = "REJECTED";
    shadowReason = "PREDICTED_LOW_EXPECTANCY";
  } else if (shadowSelected === undefined) {
    shadowOutcome = "REJECTED";
    shadowReason = "NO_FEASIBLE_CANDIDATE";
  } else {
    const shadowGateReason = evaluatePortfolioGates(
      shadowSelected,
      state,
      policy,
      decisionTimestamp,
      contexts,
    );
    if (shadowGateReason !== null) {
      shadowReason = shadowGateReason;
      shadowOutcome = DEFERRABLE_REASONS.has(shadowGateReason)
        ? "DEFERRED"
        : "REJECTED";
    } else {
      shadowOutcome = "APPROVED";
      shadowReason = "SELECTED_PRIMARY";
      shadowSelectedId = shadowSelected.observationId;
      shadowSelectedKey = shadowSelected.strategyKey;
    }
  }

  const differsFromPrimary =
    primaryOutcome !== shadowOutcome ||
    primaryReason !== shadowReason ||
    primarySelectedId !== shadowSelectedId;

  let differenceReason: string | null = null;
  if (differsFromPrimary) {
    if (shadowReason === "PREDICTED_LOW_EXPECTANCY") {
      differenceReason = "V4_SHADOW_VETOED_LOW_EXPECTANCY";
    } else if (
      primarySelectedId !== shadowSelectedId &&
      primarySelectedId !== null &&
      shadowSelectedId !== null
    ) {
      const primaryCandidate = rankedCandidates.find(
        (c) => c.observationId === primarySelectedId,
      );
      const shadowCandidate = shadowRanked.find(
        (c) => c.observationId === shadowSelectedId,
      );
      if (
        shadowCandidate?.prediction?.expectedR !== undefined &&
        primaryCandidate?.prediction?.expectedR !== undefined &&
        (shadowCandidate.prediction.expectedR ?? -999) >
          (primaryCandidate.prediction.expectedR ?? -999)
      ) {
        differenceReason = "V4_SHADOW_HIGHER_EXPECTED_R";
      } else if (
        (shadowCandidate?.prediction?.predictedProbability ?? 0) >
        (primaryCandidate?.prediction?.predictedProbability ?? 0)
      ) {
        differenceReason = "V4_SHADOW_HIGHER_PROBABILITY";
      } else {
        differenceReason = "V4_SHADOW_RANK_ORDER";
      }
    } else {
      differenceReason = `OUTCOME_MISMATCH_V3_${primaryReason}_V4_${shadowReason}`;
    }
  }

  const shadowDecision: ShadowCoordinationDecision = {
    policyVersion: SHADOW_COORDINATION_POLICY_VERSION,
    outcome: shadowOutcome,
    reason: shadowReason,
    selectedObservationId: shadowSelectedId,
    selectedStrategyKey: shadowSelectedKey,
    rankedCandidates: shadowRanked,
    differsFromPrimary,
    differenceReason,
    sizing: shadowSelected
      ? (() => {
          const edge = calculateEdgeSizingMultiplier(shadowSelected, policy);
          return {
            baseRisk: shadowSelected.estimatedInitialRisk,
            baseShares: shadowSelected.estimatedShares ?? null,
            multiplier: edge.multiplier,
            finalRisk:
              Math.round(
                shadowSelected.estimatedInitialRisk * edge.multiplier * 100,
              ) / 100,
            reason: edge.reason,
            finalShares:
              shadowSelected.estimatedShares === undefined
                ? null
                : Math.floor(shadowSelected.estimatedShares * edge.multiplier),
          };
        })()
      : null,
  };

  return {
    policyVersion: COORDINATION_POLICY_VERSION,
    outcome: primaryOutcome,
    reason: primaryReason,
    selectedObservationId: primarySelectedId,
    selectedStrategyKey: primarySelectedKey,
    confirmationObservationIds: primaryConfirmations,
    rankedCandidates,
    contexts,
    contextAlignment,
    shadowDecision,
  };
}
