import {
  FUNDED_COMPARISON_METRICS_POLICY_VERSION,
  FUNDED_COMPARISON_SPEC_VERSION,
  FUNDED_COMPARISON_VALUATION_POLICY_VERSION,
  fundedComparisonOpportunityMembershipSchema,
  fundedComparisonReplayConfigurationSchema,
  fundedComparisonSessionMembershipSchema,
  fundedComparisonSharedInputSchema,
  fundedComparisonSpecificationSchema,
  type FundedComparisonBaselineIdentity,
  type FundedComparisonCapital,
  type FundedComparisonChallengerPolicyIdentity,
  type FundedComparisonChampionPolicyIdentity,
  type FundedComparisonFailureReason,
  type FundedComparisonReplayProfile,
  type FundedComparisonSourceOpportunity,
  type FundedComparisonSpecification,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { CreateBacktest } from "@tsx-scanner/contracts";
import { marketSessionTimezone } from "../backtests/execution-provenance.js";
import { contentHash } from "./funded-evidence-digest.js";
import { zonedSessionBoundary } from "./session-time.js";
import {
  fundedComparisonOpportunityMembershipDigest,
  fundedComparisonReplayProfilesDigest,
  fundedComparisonReplayRequestDigest,
  fundedComparisonSessionMembershipDigest,
  fundedComparisonSharedInputMembershipDigest,
  fundedComparisonSpecDigest,
} from "./funded-comparison-digest.js";

/**
 * Pure builder for the immutable comparison specification. Every identity that
 * can change economics is frozen here and covered by `comparisonSpecDigest`;
 * the specification freeze time is supplied by the database, never by a caller
 * wall clock.
 */

/**
 * Derived TRAIN-partition lineage from the persisted FP02
 * dataset/member/artifact rows. Caller-supplied dates are never authoritative;
 * the loader computes the ordered session dates, the latest label-knowledge
 * coordinate and the partition digest from the frozen members.
 */
export interface FundedComparisonTrainingWindow {
  /** Ordered TRAIN-partition session dates derived from the frozen members. */
  readonly trainingSessionDates: readonly string[];
  /** Latest `label_available_at` the artifact actually consumed. */
  readonly trainingKnowledgeCutoffAt: string;
  /** Digest of the ordered TRAIN row digests, verified against the artifact. */
  readonly trainingPartitionDigest: string;
  /** Digest of the ordered TRAIN session dates, recomputed by the builder. */
  readonly trainingSessionDigest: string;
}

export interface FundedComparisonFrozenSessionIdentity {
  readonly sessionDate: string;
  readonly itemCount: number;
  readonly chunkCount: number;
  readonly sessionInputDigest: string;
}

export interface FundedComparisonSpecificationInput {
  readonly marketId: MarketId;
  readonly baseline: FundedComparisonBaselineIdentity;
  readonly sessionDates: readonly string[];
  readonly sessions: readonly FundedComparisonFrozenSessionIdentity[];
  readonly replay: {
    readonly request: CreateBacktest;
    readonly profiles: readonly FundedComparisonReplayProfile[];
  };
  readonly opportunities: readonly FundedComparisonSourceOpportunity[];
  readonly champion: FundedComparisonChampionPolicyIdentity;
  readonly challenger: FundedComparisonChallengerPolicyIdentity;
  readonly capital: FundedComparisonCapital;
  readonly training: FundedComparisonTrainingWindow;
  /** Latest effective time present in the frozen shared input. */
  readonly lastInputEffectiveAt: string;
  readonly evidenceCutoffAt: string;
  readonly specificationFrozenAt: string;
}

export class FundedComparisonSpecificationError extends Error {
  constructor(
    readonly reason: FundedComparisonFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "FundedComparisonSpecificationError";
  }
}

function currencyOf(marketId: MarketId): "CAD" | "USD" {
  return marketId === "CA_TSX" ? "CAD" : "USD";
}

/**
 * The ordered TRAIN session digest is recomputed here from the ordered dates, so
 * a caller can never supply a digest that disagrees with the chronology it
 * claims to describe.
 */
export function fundedComparisonTrainingSessionDigest(
  orderedSessionDates: readonly string[],
): string {
  return contentHash(orderedSessionDates);
}

/**
 * Chronology is proven before any comparison effect exists: the first
 * comparison session must open strictly after the latest TRAIN
 * label-knowledge coordinate, and no comparison session may overlap a
 * TRAIN-partition session. An unprovable boundary fails closed rather than
 * treating historical future knowledge as a valid prediction input.
 */
export function assertFundedComparisonChronology(
  input: Pick<
    FundedComparisonSpecificationInput,
    "marketId" | "sessionDates" | "training"
  >,
): void {
  const timezone = marketSessionTimezone(input.marketId);
  const first = input.sessionDates[0];
  if (!first)
    throw new FundedComparisonSpecificationError(
      "SESSION_MEMBERSHIP_MISMATCH",
      "A comparison requires at least one session",
    );
  const knowledgeCutoff = Date.parse(input.training.trainingKnowledgeCutoffAt);
  const firstOpen = Date.parse(zonedSessionBoundary(first, "09:30", timezone));
  if (!Number.isFinite(knowledgeCutoff) || !Number.isFinite(firstOpen))
    throw new FundedComparisonSpecificationError(
      "TRAINING_CHRONOLOGY_UNPROVEN",
      "The training knowledge cutoff or first session boundary is unprovable",
    );
  if (firstOpen <= knowledgeCutoff)
    throw new FundedComparisonSpecificationError(
      "COMPARISON_WINDOW_NOT_AFTER_TRAINING",
      "The first comparison session must open strictly after the latest TRAIN label knowledge",
    );
  const trainingSessions = new Set(input.training.trainingSessionDates);
  const overlap = input.sessionDates.filter((date) =>
    trainingSessions.has(date),
  );
  if (overlap.length > 0)
    throw new FundedComparisonSpecificationError(
      "TRAINING_WINDOW_OVERLAP",
      `Comparison sessions overlap TRAIN-partition sessions: ${overlap.join(", ")}`,
    );
}

export function buildFundedComparisonSpecification(
  input: FundedComparisonSpecificationInput,
): FundedComparisonSpecification {
  const currency = currencyOf(input.marketId);
  assertFundedComparisonChronology(input);
  assertFundedComparisonTrainingDigest(input.training);
  if (
    input.training.trainingPartitionDigest !==
      input.challenger.model.trainingPartitionDigest ||
    input.training.trainingKnowledgeCutoffAt !==
      input.challenger.model.trainingEvidenceCutoffAt ||
    input.training.trainingSessionDigest !==
      input.challenger.model.trainingSessionDigest
  )
    throw new FundedComparisonSpecificationError(
      "TRAINING_CHRONOLOGY_UNPROVEN",
      "The derived TRAIN lineage does not match the frozen challenger model",
    );
  if (input.evidenceCutoffAt < input.lastInputEffectiveAt)
    throw new FundedComparisonSpecificationError(
      "SOURCE_CUTOFF_AFTER_FREEZE",
      "A frozen input item is effective after the evidence cutoff",
    );
  if (input.specificationFrozenAt < input.evidenceCutoffAt)
    throw new FundedComparisonSpecificationError(
      "SOURCE_CUTOFF_AFTER_FREEZE",
      "The evidence cutoff cannot follow the specification freeze time",
    );
  if (input.replay.request.marketId !== input.marketId)
    throw new FundedComparisonSpecificationError(
      "MARKET_CURRENCY_MISMATCH",
      "The frozen replay request belongs to another market",
    );

  const sessionMembership = fundedComparisonSessionMembershipSchema.parse({
    orderedSessionDates: [...input.sessionDates],
    sessionMembershipDigest: fundedComparisonSessionMembershipDigest(
      input.sessionDates,
    ),
  });
  const sharedInput = fundedComparisonSharedInputSchema.parse({
    orderedSessions: input.sessions.map((session) => ({
      sessionDate: session.sessionDate,
      itemCount: session.itemCount,
      chunkCount: session.chunkCount,
      sessionInputDigest: session.sessionInputDigest,
    })),
    sharedInputDigest: fundedComparisonSharedInputMembershipDigest(
      input.sessions,
    ),
  });
  const replay = fundedComparisonReplayConfigurationSchema.parse({
    request: input.replay.request,
    requestDigest: fundedComparisonReplayRequestDigest(input.replay.request),
    profiles: [...input.replay.profiles],
    profilesDigest: fundedComparisonReplayProfilesDigest(input.replay.profiles),
  });
  const orderedOpportunityIds = input.opportunities.map(
    (opportunity) => opportunity.sourceOpportunityId,
  );
  const opportunityMembership =
    fundedComparisonOpportunityMembershipSchema.parse({
      orderedOpportunityIds,
      opportunityMembershipDigest: fundedComparisonOpportunityMembershipDigest(
        orderedOpportunityIds,
      ),
      opportunityCount: orderedOpportunityIds.length,
      eligibilityVersion: "funded-comparison-eligible-opportunities-v1",
    });

  const withoutDigest = {
    specVersion: FUNDED_COMPARISON_SPEC_VERSION,
    marketId: input.marketId,
    currency,
    baseline: input.baseline,
    sessionMembership,
    sharedInput,
    replay,
    opportunityMembership,
    champion: input.champion,
    challenger: input.challenger,
    capital: input.capital,
    valuationPolicyVersion: FUNDED_COMPARISON_VALUATION_POLICY_VERSION,
    metricsPolicyVersion: FUNDED_COMPARISON_METRICS_POLICY_VERSION,
    evidenceCutoffAt: input.evidenceCutoffAt,
    specificationFrozenAt: input.specificationFrozenAt,
  } as const;
  const comparisonSpecDigest = fundedComparisonSpecDigest(withoutDigest);
  return fundedComparisonSpecificationSchema.parse({
    ...withoutDigest,
    comparisonSpecDigest,
  });
}

/**
 * The training-session digest is recomputed from the derived ordered dates, so
 * a caller cannot supply dates and a digest that disagree.
 */
export function assertFundedComparisonTrainingDigest(
  training: FundedComparisonTrainingWindow,
): void {
  if (
    !datesAscendingUnique(training.trainingSessionDates) ||
    training.trainingSessionDates.length === 0
  )
    throw new FundedComparisonSpecificationError(
      "TRAINING_CHRONOLOGY_UNPROVEN",
      "The derived TRAIN session dates are empty, duplicated or unsorted",
    );
  const recomputed = fundedComparisonTrainingSessionDigest(
    training.trainingSessionDates,
  );
  if (recomputed !== training.trainingSessionDigest)
    throw new FundedComparisonSpecificationError(
      "TRAINING_CHRONOLOGY_UNPROVEN",
      "The TRAIN session digest does not match the derived ordered dates",
    );
  if (!Number.isFinite(Date.parse(training.trainingKnowledgeCutoffAt)))
    throw new FundedComparisonSpecificationError(
      "TRAINING_CHRONOLOGY_UNPROVEN",
      "The TRAIN label-knowledge coordinate is unprovable",
    );
}

function datesAscendingUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1)
    if (values[index]! <= values[index - 1]!) return false;
  return true;
}

/**
 * Validates that one session's retained source opportunities are exactly that
 * session's ordered slice of the frozen global membership. The global list
 * carries session ownership, so a substituted or cross-session identity fails
 * before any side effect.
 */
export function assertSessionSourceOpportunityOwnership(
  specification: Pick<
    FundedComparisonSpecification,
    "marketId" | "sessionMembership" | "opportunityMembership"
  >,
  receipt: Pick<
    { opportunities: readonly FundedComparisonSourceOpportunity[] },
    "opportunities"
  >,
  sessionDate: string,
  opportunities: readonly FundedComparisonSourceOpportunity[],
): void {
  const membership = new Set(
    specification.opportunityMembership.orderedOpportunityIds,
  );
  const expected = receipt.opportunities.filter(
    (value) => value.sessionDate === sessionDate,
  );
  if (
    !specification.sessionMembership.orderedSessionDates.includes(
      sessionDate,
    ) ||
    opportunities.length !== expected.length ||
    opportunities.some(
      (value, index) =>
        value.sourceOpportunityId !== expected[index]!.sourceOpportunityId ||
        value.sourceOrdinal !== expected[index]!.sourceOrdinal ||
        value.sessionDate !== sessionDate,
    )
  )
    throw new FundedComparisonSpecificationError(
      "OPPORTUNITY_MEMBERSHIP_MISMATCH",
      `Session ${sessionDate} opportunities do not match the frozen membership slice`,
    );
  for (const opportunity of opportunities)
    if (!membership.has(opportunity.sourceOpportunityId))
      throw new FundedComparisonSpecificationError(
        "OPPORTUNITY_MEMBERSHIP_MISMATCH",
        `Source opportunity ${opportunity.sourceOpportunityId} is outside the frozen membership`,
      );
}

/**
 * Validates that an immutable source opportunity belongs to the specification
 * membership and market it claims. Used before any side effect so a
 * substituted source/destination identity fails visibly.
 */
export function assertSourceOpportunityOwnership(
  specification: Pick<
    FundedComparisonSpecification,
    "marketId" | "sessionMembership" | "opportunityMembership"
  >,
  opportunities: readonly FundedComparisonSourceOpportunity[],
): void {
  const sessions = new Set(specification.sessionMembership.orderedSessionDates);
  const orderedIds = specification.opportunityMembership.orderedOpportunityIds;
  if (
    opportunities.length !== orderedIds.length ||
    opportunities.some(
      (value, index) => value.sourceOpportunityId !== orderedIds[index],
    )
  )
    throw new FundedComparisonSpecificationError(
      "OPPORTUNITY_MEMBERSHIP_MISMATCH",
      "Retained source opportunities do not match the frozen membership",
    );
  let previousSession = "";
  let previousOrdinal = 0;
  for (const opportunity of opportunities) {
    if (!sessions.has(opportunity.sessionDate))
      throw new FundedComparisonSpecificationError(
        "SESSION_MEMBERSHIP_MISMATCH",
        `Source opportunity ${opportunity.sourceOpportunityId} is outside the frozen sessions`,
      );
    if (
      opportunity.sessionDate < previousSession ||
      (opportunity.sessionDate === previousSession &&
        opportunity.sourceOrdinal <= previousOrdinal)
    )
      throw new FundedComparisonSpecificationError(
        "OPPORTUNITY_MEMBERSHIP_MISMATCH",
        "Source opportunities are not in canonical (session, ordinal) order",
      );
    previousSession = opportunity.sessionDate;
    previousOrdinal = opportunity.sourceOrdinal;
  }
}
