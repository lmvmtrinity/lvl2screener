import type { MarketId } from "@tsx-scanner/contracts";
import type {
  FundedCohortComponents,
  FundedDecisionAction,
  FundedDecisionContext,
  FundedDecisionEvidenceIdentity,
  FundedDecisionTimeInput,
  FundedExecutionAssumptions,
  FundedSizingContext,
} from "@tsx-scanner/contracts";
import type {
  AssumptionsSnapshot,
  QuoteFact,
  SignalFact,
  SizingContext,
} from "./types.js";
import { normalizeFundedPolicy, type FundedPolicy } from "./funded-policy.js";
import { fundedAccountSummary, type FundedLedger } from "./funded-ledger.js";
import {
  accountAssumptionDigest,
  contentHash,
} from "./funded-evidence-digest.js";

/** Transaction-capable query surface shared with the evidence repository. */
export interface FundedEvidenceQueryable {
  query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface FundedDecisionDraft {
  /** Exact decision-time input; sequence, capture time and digest are DB-owned. */
  readonly decision: FundedDecisionTimeInput;
  /** Cohort components only; a runtime digest is stripped/rejected at capture. */
  readonly cohort: FundedCohortComponents;
  /** Optional assertion checked against the recomputed digest. */
  readonly expectedContentDigest?: string;
  readonly expectedCohortDigest?: string;
}

export interface CapturedDecisionEvidence {
  readonly identity: FundedDecisionEvidenceIdentity;
  readonly contentDigest: string;
  readonly cohortDigest: string;
  readonly capturedAt: string;
}

export interface FundedModelEvidenceInput {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly strategyName: string;
  readonly prediction: number;
  readonly inputDigest: string;
  readonly predictionAt: string;
}

export interface FundedDecisionCaptureContext {
  readonly marketId: MarketId;
  readonly accountId: string;
  readonly runId: string;
  readonly sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
  readonly fundedPolicyVersion: string;
  readonly executionModelVersion: string;
  readonly featureVersion: string;
  readonly runtimeVersion: string;
  readonly costPolicyVersion: string;
  readonly participationVersion: string;
  readonly policy: FundedPolicy;
  /**
   * Decision-time account state reconstructed from the durable ledger and
   * order history under the run/account locks. `cooldownActive` and
   * `consecutiveStops` stay null when the bound policy has no portfolio
   * control defining them; they are never defaulted to false/0.
   */
  readonly accountState?: {
    cash: number;
    reservedCash: number;
    openRisk: number;
    reservedRisk: number;
    positionCount: number;
    sectorExposure: Record<string, number> | null;
    dailyPnl: number;
    entriesAllowed: boolean;
    cooldownActive: boolean | null;
    consecutiveStops: number | null;
  } | null;
  /** Signal-model prediction retained at decision time, when one existed. */
  readonly model?: FundedModelEvidenceInput | null;
}

/** The durable observation fields a decision-time input retains. */
export interface FundedDecisionObservation {
  readonly id: string;
  readonly strategyKey: string;
  readonly strategyVersion: string;
  readonly score: number;
  readonly reasonCodes: unknown;
  readonly fundedContexts?: readonly {
    readonly signalKey: string;
    readonly status: "UNAVAILABLE" | "WEAK" | "NEUTRAL" | "STRONG" | "STALE";
    readonly timestamp: string;
  }[];
}

export interface FundedDecisionInputs {
  readonly observation: FundedDecisionObservation;
  readonly order: {
    readonly signal: SignalFact;
    readonly assumptions: AssumptionsSnapshot;
    readonly context?: SizingContext;
    readonly submittedAt: string;
  };
  /**
   * Exact capital constraints supplied with the SIGNAL fact, retained as
   * supplied. `null` records that no funded submission existed for this
   * decision (decline/defer); it is never re-derived from current assumptions.
   */
  readonly requestedCapital: {
    readonly maximumDebit: number;
    readonly maximumRisk: number;
  } | null;
  /** The exact quote retained at decision time; null when none was available. */
  readonly quote: QuoteFact | null;
  readonly context: FundedDecisionCaptureContext;
  /** Defaults to a submission; DECLINE/DEFER carry an explicit policy reason. */
  readonly action?: FundedDecisionAction;
  readonly policyReason?: string | null;
}

function contextEvidence(
  observation: FundedDecisionObservation,
  decisionAt: string,
): FundedDecisionContext {
  const contexts = observation.fundedContexts;
  if (!contexts || contexts.length === 0)
    return {
      status: "UNAVAILABLE",
      reason: "No funded context was retained at decision time",
    };
  const retained = contexts.map((entry) => ({
    signalKey: entry.signalKey,
    status: entry.status,
    timestamp: entry.timestamp,
  }));
  const market = retained.find(
    (entry) => entry.signalKey === "MARKET_RELATIVE_STRENGTH",
  );
  return {
    status: "AVAILABLE",
    contexts: retained,
    contextStatus: market?.status ?? null,
    contextTimestamp:
      market && Date.parse(market.timestamp) <= Date.parse(decisionAt)
        ? market.timestamp
        : null,
  };
}

function sizingContextEvidence(
  context: SizingContext | undefined,
): FundedSizingContext | null {
  if (!context) return null;
  return {
    displayedSize: context.displayedSize ?? null,
    openSymbolNotional: context.openSymbolNotional ?? null,
    openSectorNotional: context.openSectorNotional ?? null,
    openPortfolioRisk: context.openPortfolioRisk ?? null,
    maxDisplayedSizeParticipation:
      context.maxDisplayedSizeParticipation ?? null,
    maxSymbolNotional: context.maxSymbolNotional ?? null,
    maxSectorNotional: context.maxSectorNotional ?? null,
    maxPortfolioRisk: context.maxPortfolioRisk ?? null,
    executionMode: context.executionMode ?? null,
    latencyMs: context.latencyMs ?? null,
    strategyKey: context.strategyKey ?? null,
    maximumHoldingMinutes: context.maximumHoldingMinutes ?? null,
    stalledBreakoutMinutes: context.stalledBreakoutMinutes ?? null,
    stalledBreakoutMinProgressR: context.stalledBreakoutMinProgressR ?? null,
  };
}

/** Exact execution assumptions actually used, with legacy gaps left null. */
export function executionAssumptionsEvidence(
  assumptions: AssumptionsSnapshot,
): FundedExecutionAssumptions {
  return {
    positionSize: assumptions.positionSize,
    slippageBps: assumptions.slippageBps,
    feePerTrade: assumptions.feePerTrade,
    costs: assumptions.costs
      ? {
          entryCommission: assumptions.costs.entryCommission,
          exitCommission: assumptions.costs.exitCommission,
          estimatedRegulatoryFees: assumptions.costs.estimatedRegulatoryFees,
          slippageBps: assumptions.costs.slippageBps,
          currency: assumptions.costs.currency,
          brokerPricingVersion: assumptions.costs.brokerPricingVersion,
        }
      : null,
    riskBudget: assumptions.riskBudget ?? null,
    maxNotional: assumptions.maxNotional ?? null,
    economics: assumptions.economics
      ? {
          minNetRewardRisk: assumptions.economics.minNetRewardRisk,
          minStopFrictionMultiple:
            assumptions.economics.minStopFrictionMultiple,
          minTargetFrictionMultiple:
            assumptions.economics.minTargetFrictionMultiple,
          maxSpreadPct: assumptions.economics.maxSpreadPct,
        }
      : null,
    stopMethod: assumptions.stopMethod,
    atrStopMultiple: assumptions.atrStopMultiple,
    rewardRiskRatio: assumptions.rewardRiskRatio,
    maxQuoteAgeSeconds: assumptions.maxQuoteAgeSeconds,
    sessionTimezone: assumptions.sessionTimezone,
    noonCloseTime: assumptions.noonCloseTime,
    executionMode: assumptions.executionMode ?? null,
    latencyMs: assumptions.latencyMs ?? null,
    evidenceScope: assumptions.evidenceScope ?? null,
  };
}

/**
 * Builds the immutable decision-time input from the durable observation, the
 * exact SIGNAL fact, the retained quote and the decision-time account and
 * model evidence. Every absent value is an explicit `UNAVAILABLE` variant or
 * null; nothing is fabricated and no later reading is substituted.
 */
export function buildFundedDecisionDraft(
  input: FundedDecisionInputs,
): FundedDecisionTimeInput {
  const { observation, order, quote, context } = input;
  const decisionAt = order.submittedAt;
  const currency = context.marketId === "CA_TSX" ? "CAD" : "USD";
  const model = context.model;
  return {
    marketId: context.marketId,
    currency,
    accountId: context.accountId,
    runId: context.runId,
    observationId: observation.id,
    fundedPolicyVersion: context.fundedPolicyVersion,
    executionModelVersion: context.executionModelVersion,
    featureVersion: context.featureVersion,
    sourceKind: context.sourceKind,
    action: input.action ?? "SUBMIT",
    policyReason: input.policyReason ?? null,
    decisionAt,
    evidenceSchemaVersion: 2,
    strategyKey: observation.strategyKey,
    strategyVersion: observation.strategyVersion,
    score: observation.score,
    reasonCodes: Array.isArray(observation.reasonCodes)
      ? (observation.reasonCodes as unknown[]).map(String)
      : [],
    requestedCapital: input.requestedCapital
      ? {
          status: "AVAILABLE",
          maximumDebit: input.requestedCapital.maximumDebit,
          maximumRisk: input.requestedCapital.maximumRisk,
        }
      : {
          status: "UNAVAILABLE",
          reason: "No funded signal submission was retained for this decision",
        },
    quote: quote
      ? {
          status: "AVAILABLE",
          snapshot: {
            timestamp: quote.timestamp,
            bid: quote.bid,
            ask: quote.ask,
            bidSize: quote.bidSize,
            askSize: quote.askSize,
            sizeUnit: quote.sizeUnit ?? null,
            sizeMultiplier: quote.sizeMultiplier ?? null,
            dataStatus: quote.dataStatus,
            actionable: quote.actionable,
          },
        }
      : {
          status: "UNAVAILABLE",
          reason: "No funded quote was retained at decision time",
        },
    model: model
      ? {
          status: "AVAILABLE",
          modelId: model.modelId,
          modelVersion: model.modelVersion,
          strategyName: model.strategyName,
          prediction: model.prediction,
          inputDigest: model.inputDigest,
          predictionAt: model.predictionAt,
        }
      : {
          status: "UNAVAILABLE",
          reason: "No signal-model prediction was retained at decision time",
        },
    portfolio: context.accountState
      ? {
          status: "AVAILABLE",
          cash: context.accountState.cash,
          reservedCash: context.accountState.reservedCash,
          openRisk: context.accountState.openRisk,
          reservedRisk: context.accountState.reservedRisk,
          positionCount: context.accountState.positionCount,
          sectorExposure: context.accountState.sectorExposure,
          dailyPnl: context.accountState.dailyPnl,
          entriesAllowed: context.accountState.entriesAllowed,
          cooldownActive: context.accountState.cooldownActive ?? null,
          consecutiveStops: context.accountState.consecutiveStops ?? null,
        }
      : {
          status: "UNAVAILABLE",
          reason: "No decision-time funded account snapshot was retained",
        },
    context: contextEvidence(observation, decisionAt),
    execution: executionAssumptionsEvidence(order.assumptions),
    sizingContext: sizingContextEvidence(order.context),
    policy: {
      projectionVersion: context.policy.projectionVersion,
      participation: context.policy.participation,
      impactBps: context.policy.impactBps,
      latencyPolicy: context.policy.latencyPolicy,
      portfolio: context.policy.portfolio
        ? {
            version: context.policy.portfolio.version,
            maxOpenPositions: context.policy.portfolio.maxOpenPositions,
            maxTotalOpenRisk: context.policy.portfolio.maxTotalOpenRisk,
            maxSymbolNotional:
              context.policy.portfolio.maxSymbolNotional ?? null,
            maxSectorNotional:
              context.policy.portfolio.maxSectorNotional ?? null,
            cooldownMinutesAfterStop:
              context.policy.portfolio.cooldownMinutesAfterStop,
            maxConsecutiveStops: context.policy.portfolio.maxConsecutiveStops,
            requireFreshContext: context.policy.portfolio.requireFreshContext,
            contextMaxAgeSeconds: context.policy.portfolio.contextMaxAgeSeconds,
            vetoOnWeakContext: context.policy.portfolio.vetoOnWeakContext,
            contextRequirement:
              context.policy.portfolio.contextRequirement ?? null,
            maximumHoldingMinutes:
              context.policy.portfolio.maximumHoldingMinutes ?? null,
            maximumHoldingMinutesByStrategy:
              context.policy.portfolio.maximumHoldingMinutesByStrategy ?? null,
            stalledBreakoutMinutes:
              context.policy.portfolio.stalledBreakoutMinutes ?? null,
            stalledBreakoutMinProgressR:
              context.policy.portfolio.stalledBreakoutMinProgressR ?? null,
          }
        : null,
    },
    signal: {
      signalTimestamp: order.signal.signalTimestamp,
      entryReference: order.signal.entryReference,
      stopReference: order.signal.stopReference,
      targetReference: order.signal.targetReference,
      atr14: order.signal.atr14,
    },
  };
}

/**
 * Content-addressed identity of the exact funded policy applied. The policy is
 * not versioned by name, so its canonical content is the identity; nothing is
 * invented when no named version exists.
 */
export function fundedPolicyVersion(policy: FundedPolicy): string {
  return contentHash(normalizeFundedPolicy(policy));
}

/** Content-addressed identity of the liquidity participation policy actually used. */
export function participationPolicyVersion(policy: FundedPolicy): string {
  const canonical = normalizeFundedPolicy(policy);
  return contentHash({
    projectionVersion: canonical.projectionVersion,
    participation: canonical.participation,
    impactBps: canonical.impactBps,
    latencyPolicy: canonical.latencyPolicy,
  });
}

/**
 * Decision-time portfolio evidence from a ledger reconstructed at `at` plus
 * the durable order history that defines cooldown and consecutive-stop state.
 * `cooldownActive`/`consecutiveStops` stay null when no portfolio control
 * defines them; sector exposure is not retained by the funded ledger and stays
 * null rather than an empty object that would imply a measured zero.
 */
export function fundedAccountStateEvidence(
  ledger: FundedLedger,
  at: string,
  policyState: {
    cooldownActive: boolean | null;
    consecutiveStops: number | null;
  },
): NonNullable<FundedDecisionCaptureContext["accountState"]> {
  const summary = fundedAccountSummary(ledger, at, 30_000);
  return {
    cash: summary.cash,
    reservedCash: summary.reservedCash,
    openRisk: summary.openRisk,
    reservedRisk: summary.reservedRisk,
    positionCount: Object.keys(ledger.positions).length,
    sectorExposure: null,
    dailyPnl: summary.dailyPnl,
    entriesAllowed: summary.entriesAllowed,
    cooldownActive: policyState.cooldownActive,
    consecutiveStops: policyState.consecutiveStops,
  };
}

/**
 * Compatible-cohort components for one captured decision. The returned value
 * deliberately carries no digest: the repository computes and verifies
 * `fundedCohortDigest` from exactly these components before persisting them.
 */
export function buildFundedCohortComponents(input: {
  marketId: MarketId;
  sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
  fundedPolicyVersion: string;
  portfolioPolicyVersion: string;
  executionModelVersion: string;
  costPolicyVersion: string;
  participationVersion: string;
  featureVersion: string;
  runtimeVersion: string;
  assumptions: AssumptionsSnapshot;
  signalModelId: string | null;
  signalModelVersion: string | null;
}): FundedCohortComponents {
  return {
    marketId: input.marketId,
    currency: input.marketId === "CA_TSX" ? "CAD" : "USD",
    evidenceSchemaVersion: 2,
    fundedPolicyVersion: input.fundedPolicyVersion,
    portfolioPolicyVersion: input.portfolioPolicyVersion,
    executionModelVersion: input.executionModelVersion,
    costPolicyVersion: input.costPolicyVersion,
    participationVersion: input.participationVersion,
    sourceKind: input.sourceKind,
    featureVersion: input.featureVersion,
    runtimeVersion: input.runtimeVersion,
    accountAssumptionDigest: accountAssumptionDigest(
      executionAssumptionsEvidence(input.assumptions),
    ),
    signalModelId: input.signalModelId,
    signalModelVersion: input.signalModelVersion,
  };
}
