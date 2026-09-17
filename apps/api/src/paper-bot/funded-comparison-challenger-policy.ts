import {
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  type FundedComparisonChallengerPolicyIdentity,
} from "@tsx-scanner/contracts";
import { contentHash } from "./funded-evidence-digest.js";

/**
 * Approved FP03 research-only challenger rule
 * (`funded-comparison-execution-quality-ordering-v1`).
 *
 * The module is a pure, deterministic projection of frozen FP02 diagnostics
 * onto one simultaneous batch. It reorders only: it can never decline, resize,
 * pre-approve, bypass or weaken a deterministic veto, and it accepts no
 * outcome, fill or later portfolio state. When any candidate's prediction is
 * missing, invalid or identity-mismatched, the complete batch falls back to
 * deterministic champion order so a predicted candidate can never leapfrog a
 * candidate whose inference failed.
 */

export class FundedComparisonChallengerPolicyError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "FundedComparisonChallengerPolicyError";
  }
}

export interface FundedComparisonChallengerCandidatePrediction {
  readonly expectedFillFraction: number;
  readonly expectedTotalExecutionCost: number;
  readonly expectedSlippagePerShare: number;
}

export interface FundedComparisonChallengerCandidate {
  readonly sourceOpportunityId: string;
  readonly sourceOrdinal: number;
  readonly signalTimestamp: string;
  readonly deterministicScore: number;
  readonly decisionAt: string;
  /** Diagnostic output plus its exact frozen identity validity. */
  readonly prediction: FundedComparisonChallengerCandidatePrediction | null;
  readonly predictionIdentityValid: boolean;
  /** Stable reason when the prediction cannot be used. */
  readonly unavailableReason: string | null;
}

export type FundedComparisonChallengerDisposition =
  "PREDICTED" | "FALLBACK_CHAMPION_ORDER";

export interface FundedComparisonChallengerOrderEntry {
  readonly sourceOpportunityId: string;
  readonly championRank: number;
  readonly appliedRank: number;
  readonly disposition: FundedComparisonChallengerDisposition;
  readonly fallbackReason: string | null;
}

export interface ChallengerOrdering {
  readonly batchKey: string;
  readonly batchFallback: boolean;
  readonly entries: readonly FundedComparisonChallengerOrderEntry[];
}

/** One simultaneous batch shares the exact retained signal timestamp. */
export function challengerBatchKey(
  candidates: readonly { signalTimestamp: string }[],
): string {
  const timestamps = new Set(
    candidates.map((candidate) => candidate.signalTimestamp),
  );
  if (timestamps.size !== 1)
    throw new FundedComparisonChallengerPolicyError(
      "BATCH_NOT_SIMULTANEOUS",
      "A challenger batch requires one exact retained signal timestamp",
    );
  return candidates[0]!.signalTimestamp;
}

function championOrder(
  candidates: readonly FundedComparisonChallengerCandidate[],
): readonly FundedComparisonChallengerCandidate[] {
  return [...candidates].sort((left, right) => {
    const byTimestamp =
      Date.parse(left.signalTimestamp) - Date.parse(right.signalTimestamp);
    if (byTimestamp !== 0) return byTimestamp;
    if (left.sourceOrdinal !== right.sourceOrdinal)
      return left.sourceOrdinal - right.sourceOrdinal;
    return left.sourceOpportunityId.localeCompare(right.sourceOpportunityId);
  });
}

/**
 * One truthful stable batch-wide fallback reason. If any candidate names a
 * reason, the batch reports the first such reason in champion order; a peer
 * whose own diagnostic was valid is never labelled as the failing identity.
 */
function batchFallbackReasonOf(
  candidates: readonly FundedComparisonChallengerCandidate[],
): string {
  const named = championOrder(candidates).find(
    (candidate) => candidate.unavailableReason !== null,
  );
  return named?.unavailableReason ?? "INVALID_DIAGNOSTIC";
}

function isUsable(candidate: FundedComparisonChallengerCandidate): boolean {
  if (
    candidate.prediction === null ||
    !candidate.predictionIdentityValid ||
    candidate.unavailableReason !== null
  )
    return false;
  const {
    expectedFillFraction,
    expectedTotalExecutionCost,
    expectedSlippagePerShare,
  } = candidate.prediction;
  return (
    Number.isFinite(expectedFillFraction) &&
    expectedFillFraction >= 0 &&
    expectedFillFraction <= 1 &&
    Number.isFinite(expectedTotalExecutionCost) &&
    expectedTotalExecutionCost >= 0 &&
    Number.isFinite(expectedSlippagePerShare) &&
    expectedSlippagePerShare >= 0
  );
}

/**
 * Exact approved rule. Caller passes one batch whose candidates share the exact
 * retained signal timestamp; the persisted specification identity is asserted
 * before use.
 */
export function orderChallengerCandidates(
  candidates: readonly FundedComparisonChallengerCandidate[],
  specification: Pick<
    FundedComparisonChallengerPolicyIdentity,
    "policyVersion" | "policyDigest"
  >,
): ChallengerOrdering {
  if (
    specification.policyVersion !== FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION
  )
    throw new FundedComparisonChallengerPolicyError(
      "CHALLENGER_POLICY_IDENTITY_MISMATCH",
      "The frozen specification does not name the approved challenger rule",
    );
  if (candidates.length === 0)
    throw new FundedComparisonChallengerPolicyError(
      "EMPTY_BATCH",
      "A challenger batch requires at least one candidate",
    );
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.sourceOpportunityId))
      throw new FundedComparisonChallengerPolicyError(
        "DUPLICATE_CANDIDATE",
        "A challenger batch contains a duplicate source opportunity",
      );
    seen.add(candidate.sourceOpportunityId);
  }
  const batchKey = challengerBatchKey(candidates);
  const champion = championOrder(candidates);
  const championRank = new Map(
    champion.map((candidate, index) => [
      candidate.sourceOpportunityId,
      index + 1,
    ]),
  );
  const complete = candidates.every(isUsable);
  if (!complete) {
    const batchReason = batchFallbackReasonOf(candidates);
    return {
      batchKey,
      batchFallback: true,
      entries: champion.map((candidate, index) => ({
        sourceOpportunityId: candidate.sourceOpportunityId,
        championRank: index + 1,
        appliedRank: index + 1,
        disposition: "FALLBACK_CHAMPION_ORDER",
        fallbackReason: batchReason,
      })),
    };
  }
  const predicted = [...candidates].sort((left, right) => {
    const leftPrediction = left.prediction!;
    const rightPrediction = right.prediction!;
    if (
      leftPrediction.expectedFillFraction !==
      rightPrediction.expectedFillFraction
    )
      return (
        rightPrediction.expectedFillFraction -
        leftPrediction.expectedFillFraction
      );
    if (
      leftPrediction.expectedTotalExecutionCost !==
      rightPrediction.expectedTotalExecutionCost
    )
      return (
        leftPrediction.expectedTotalExecutionCost -
        rightPrediction.expectedTotalExecutionCost
      );
    if (
      leftPrediction.expectedSlippagePerShare !==
      rightPrediction.expectedSlippagePerShare
    )
      return (
        leftPrediction.expectedSlippagePerShare -
        rightPrediction.expectedSlippagePerShare
      );
    if (left.deterministicScore !== right.deterministicScore)
      return right.deterministicScore - left.deterministicScore;
    const byDecisionAt =
      Date.parse(left.decisionAt) - Date.parse(right.decisionAt);
    if (byDecisionAt !== 0) return byDecisionAt;
    return left.sourceOpportunityId.localeCompare(right.sourceOpportunityId);
  });
  return {
    batchKey,
    batchFallback: false,
    entries: predicted.map((candidate, index) => ({
      sourceOpportunityId: candidate.sourceOpportunityId,
      championRank: championRank.get(candidate.sourceOpportunityId)!,
      appliedRank: index + 1,
      disposition: "PREDICTED",
      fallbackReason: null,
    })),
  };
}

/** Digest of the exact approved rule identity (no numeric threshold). */
export function fundedComparisonChallengerPolicyDigest(): string {
  return contentHash({
    policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
    rule: "EXECUTION_QUALITY_LEXICOGRAPHIC_TOTAL_REORDER",
    key: [
      "expectedFillFraction:DESC",
      "expectedTotalExecutionCost:ASC",
      "expectedSlippagePerShare:ASC",
      "deterministicScore:DESC",
      "decisionAt:ASC",
      "sourceOpportunityId:ASC",
    ],
    fallback: "WHOLE_BATCH_CHAMPION_ORDER",
    declines: false,
  });
}
