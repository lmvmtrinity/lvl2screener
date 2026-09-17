import type {
  CreateBacktest,
  FundedComparisonSide,
  MarketId,
  SetupStrategyName,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import {
  buildFundedInvalidationEnvelope,
  buildFundedQuoteEnvelope,
  buildFundedSignalEnvelope,
  fundedSignalValidityDeadline,
} from "./funded-live-adapter.js";
import { fundedReservationDebit } from "./financials.js";
import {
  comparisonSignalSortKey,
  FundedFactAdapter,
} from "./funded-fact-adapter.js";
import {
  FundedDecisionEvidenceRepository,
  type FundedDecisionRow,
} from "./funded-decision-evidence-repository.js";
import type { FundedDecisionEvidenceSource } from "./funded-decision-capture.js";
import { FundedDecisionOutcomeProjector } from "./funded-decision-outcome-projector.js";
import {
  ensureFundedHistoricalProfiles,
  type FundedHistoricalProfile,
} from "./funded-historical-signal-bridge.js";
import {
  PostgresPaperBotStore,
  type PaperSignalObservation,
} from "./paper-bot-repository.js";
import { normalizeFundedPolicy, type FundedPolicy } from "./funded-policy.js";
import type { FundedReportingService } from "./funded-reporting-service.js";
import type { AssumptionsSnapshot, QuoteFact } from "./types.js";
import type { FundedComparisonSharedInput } from "./funded-comparison-shared-input.js";
import { FundedComparisonSpecificationError } from "./funded-comparison-specification.js";
import { stableUuid } from "./stable-uuid.js";

/**
 * One side of one comparison session. It materializes the destination
 * observations from frozen source opportunities, builds the policy-neutral
 * fact stream and applies it through the existing funded inbox, order service,
 * ledger and FP01 evidence machinery. It performs no economic calculation of
 * its own and cannot read the other side's account.
 */

export interface ComparisonSideSessionInput {
  readonly specId: string;
  readonly side: FundedComparisonSide;
  readonly runId: string;
  readonly accountId: string;
  readonly currency: "CAD" | "USD";
  readonly marketId: MarketId;
  readonly shared: FundedComparisonSharedInput;
  readonly profiles: readonly FundedHistoricalProfile[];
  readonly parameters: CreateBacktest["parameters"];
  readonly assumptions: AssumptionsSnapshot;
  readonly policy: FundedPolicy;
  /**
   * Applied source order for this side. Champion (and any fallback batch) uses
   * canonical champion order; the challenger uses its approved applied order.
   */
  readonly ordering: readonly {
    readonly sourceOpportunityId: string;
    readonly appliedRank: number;
  }[];
  readonly evidenceSource: FundedDecisionEvidenceSource;
  /**
   * Exact destination observations prepared before policy evaluation. The
   * paired runner supplies this for the challenger so no funded fact can be
   * applied before the immutable evaluation rows exist.
   */
  readonly preparedObservations?: ReadonlyMap<string, string>;
}

export interface ComparisonSideSessionResult {
  readonly side: FundedComparisonSide;
  readonly runId: string;
  readonly sessionDate: string;
  readonly observations: ReadonlyMap<string, string>;
  readonly decisions: ReadonlyMap<string, FundedDecisionRow>;
  readonly appliedRanks: ReadonlyMap<string, number>;
  readonly unresolvedPositions: number;
  readonly unresolvedReservations: number;
}

export interface ComparisonSideRunnerDependencies {
  readonly pool: Pool;
  readonly reporting: FundedReportingService;
}

function destinationEventIdOf(input: {
  specId: string;
  side: FundedComparisonSide;
  sourceOpportunityId: string;
}): string {
  return stableUuid(
    `funded-comparison-event:${input.specId}:${input.side}:${input.sourceOpportunityId}`,
  );
}

/**
 * Rebuilds one side/session's projections from durable rows without applying
 * any fact. Used when a crash left an already-completed run: a completed side
 * is never rerun, only re-read for its exact source-to-destination mapping and
 * decision evidence.
 */
export async function projectComparisonSideSession(
  input: ComparisonSideSessionInput,
  deps: ComparisonSideRunnerDependencies,
): Promise<ComparisonSideSessionResult> {
  const observations = new Map<string, string>();
  for (const item of input.shared.opportunities) {
    const sourceEventId = destinationEventIdOf({
      specId: input.specId,
      side: input.side,
      sourceOpportunityId: item.sourceOpportunityId,
    });
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM paper_signal_observation
        WHERE run_id=$1 AND source_event_id=$2`,
      [input.runId, sourceEventId],
    );
    const observationId = rows[0]?.id;
    if (!observationId)
      throw new FundedComparisonSpecificationError(
        "RETAINED_INPUT_MISSING",
        `Completed ${input.side} run ${input.runId} has no destination observation for ${item.sourceOpportunityId}`,
      );
    observations.set(item.sourceOpportunityId, observationId);
  }
  const appliedRanks = new Map<string, number>();
  for (const entry of input.ordering)
    appliedRanks.set(entry.sourceOpportunityId, entry.appliedRank);
  const evidence = new FundedDecisionEvidenceRepository(
    deps.pool,
    undefined,
    input.evidenceSource,
  );
  const decisions = new Map<string, FundedDecisionRow>();
  for (const [sourceOpportunityId, observationId] of observations) {
    const decision = await evidence.findDecision(input.runId, observationId);
    if (!decision)
      throw new FundedComparisonSpecificationError(
        "PREDICTION_DECISION_UNAVAILABLE",
        `${input.side} decision evidence is missing for ${sourceOpportunityId}`,
      );
    decisions.set(sourceOpportunityId, decision);
  }
  const report = await deps.reporting.report(input.runId);
  return {
    side: input.side,
    runId: input.runId,
    sessionDate: input.shared.sessionDate,
    observations,
    decisions,
    appliedRanks,
    unresolvedPositions: Object.keys(report.positions).length,
    unresolvedReservations: Object.keys(report.reservations).length,
  };
}

function observationPayloadOf(
  input: ComparisonSideSessionInput,
  item: FundedComparisonSharedInput["opportunities"][number],
): unknown {
  const sourcePayload =
    (input.shared.opportunityItems.get(item.sourceOpportunityId)
      ?.sourceEventPayload as Record<string, unknown> | undefined) ?? {};
  return {
    ...sourcePayload,
    replayLineage: {
      type: "FUNDED_COMPARISON_REPLAY",
      specId: input.specId,
    },
  };
}

/**
 * Materializes the replay profiles before the first destination observation.
 * Observation insertion is an idempotent, effect-free preparation step; funded
 * facts, orders and ledger events are intentionally absent from this function.
 */
export async function prepareComparisonSideObservations(
  input: ComparisonSideSessionInput,
  deps: Pick<ComparisonSideRunnerDependencies, "pool">,
): Promise<ReadonlyMap<string, string>> {
  await ensureFundedHistoricalProfiles(
    deps.pool,
    input.profiles,
    input.marketId,
    input.parameters,
  );
  const profiles = new Map(
    input.profiles.map((profile) => [profile.strategy, profile]),
  );
  const observations = new Map<string, string>();
  const orderedOpportunities = [...input.shared.opportunities].sort(
    (left, right) => left.sourceOrdinal - right.sourceOrdinal,
  );
  const store = new PostgresPaperBotStore(deps.pool);
  for (const item of orderedOpportunities) {
    const frozen = input.shared.opportunityItems.get(item.sourceOpportunityId);
    if (!frozen)
      throw new FundedComparisonSpecificationError(
        "RETAINED_INPUT_MISSING",
        `Source opportunity ${item.sourceOpportunityId} has no retained input item`,
      );
    const profile = profiles.get(frozen.strategyKey as SetupStrategyName);
    if (!profile)
      throw new FundedComparisonSpecificationError(
        "REPLAY_LINEAGE_UNAVAILABLE",
        `Source opportunity ${item.sourceOpportunityId} has no comparison profile`,
      );
    const destination = await store.insertObservation({
      runId: input.runId,
      sourceEventId: destinationEventIdOf({
        specId: input.specId,
        side: input.side,
        sourceOpportunityId: item.sourceOpportunityId,
      }),
      sourceSignalId: null,
      setupInstanceId: item.setupInstanceId,
      instrumentId: item.instrumentId,
      symbol: frozen.symbol,
      profileId: profile.profileId,
      profileName: profile.profileName,
      profileConfigId: profile.profileConfigId,
      configVersion: profile.configVersion,
      profileParameters: input.parameters,
      strategyKey: frozen.strategyKey,
      strategyVersion: frozen.strategyVersion,
      signalTimestamp: frozen.signalTimestamp,
      score: frozen.score,
      entryReference: frozen.entryReference,
      stopReference: frozen.stopReference,
      targetReference: frozen.targetReference,
      atr14: frozen.atr14,
      featureSnapshot: frozen.featureSnapshot,
      reasonCodes: frozen.reasonCodes,
      sourceEventPayload: observationPayloadOf(input, item),
      eligibilityStatus: frozen.eligibilityStatus,
      eligibilityReason: frozen.eligibilityReason,
    });
    observations.set(item.sourceOpportunityId, destination.observation.id);
  }
  return observations;
}

export async function applyComparisonSideSession(
  input: ComparisonSideSessionInput,
  deps: ComparisonSideRunnerDependencies,
): Promise<ComparisonSideSessionResult> {
  const observations = new Map(
    input.preparedObservations ??
      (await prepareComparisonSideObservations(input, deps)),
  );
  const appliedRanks = new Map<string, number>();
  for (const entry of input.ordering) {
    if (!observations.has(entry.sourceOpportunityId))
      throw new FundedComparisonSpecificationError(
        "OPPORTUNITY_MEMBERSHIP_MISMATCH",
        `Applied order names ${entry.sourceOpportunityId}, which has no destination observation`,
      );
    appliedRanks.set(entry.sourceOpportunityId, entry.appliedRank);
  }
  if (appliedRanks.size !== observations.size)
    throw new FundedComparisonSpecificationError(
      "OPPORTUNITY_MEMBERSHIP_MISMATCH",
      "Applied order does not cover the session's source opportunities",
    );

  const canonical = normalizeFundedPolicy(input.policy);
  const maximumDebit = fundedReservationDebit(input.assumptions);
  const maximumRisk = input.assumptions.riskBudget ?? maximumDebit;
  const sorted = [...input.ordering].sort(
    (left, right) => left.appliedRank - right.appliedRank,
  );
  const envelopes = [];
  const refusalRequests = [];
  const signalSortKeys = new Map<string, string>();
  envelopes.push({
    id: `funded-comparison-clock:${input.runId}:${input.shared.sessionStartAt}`,
    fact: { type: "CLOCK" as const, at: input.shared.sessionStartAt },
  });
  const opportunityByInvalidation = new Map<
    string,
    { sourceOpportunityId: string; signalTimestamp: string }
  >();
  for (const invalidation of input.shared.invalidations)
    opportunityByInvalidation.set(invalidation.eventId, {
      sourceOpportunityId: invalidation.sourceOpportunityId,
      signalTimestamp:
        input.shared.opportunityItems.get(invalidation.sourceOpportunityId)
          ?.signalTimestamp ?? invalidation.at,
    });
  const consumedInvalidations = new Set<string>();
  for (const entry of sorted) {
    const opportunity = input.shared.opportunities.find(
      (value) => value.sourceOpportunityId === entry.sourceOpportunityId,
    );
    const frozen = input.shared.opportunityItems.get(entry.sourceOpportunityId);
    const observationId = observations.get(entry.sourceOpportunityId);
    if (!opportunity || !frozen || !observationId)
      throw new FundedComparisonSpecificationError(
        "OPPORTUNITY_MEMBERSHIP_MISMATCH",
        "Applied order does not match the frozen opportunity membership",
      );
    const observation = {
      id: observationId,
      runId: input.runId,
      marketId: input.marketId,
      instrumentId: opportunity.instrumentId,
      symbol: frozen.symbol,
      signalTimestamp: opportunity.signalTimestamp,
      strategyKey: frozen.strategyKey,
      strategyVersion: frozen.strategyVersion,
      score: frozen.score,
      reasonCodes: frozen.reasonCodes,
      entryReference: frozen.entryReference,
      stopReference: frozen.stopReference,
      targetReference: frozen.targetReference,
      atr14: frozen.atr14,
      featureSnapshot: frozen.featureSnapshot,
      sourceEventPayload: observationPayloadOf(input, opportunity),
      eligibilityStatus: frozen.eligibilityStatus,
    } as unknown as PaperSignalObservation;
    const preSubmission = input.shared.invalidations.find(
      (invalidation) =>
        invalidation.sourceOpportunityId === entry.sourceOpportunityId &&
        Date.parse(invalidation.at) <= Date.parse(opportunity.signalTimestamp),
    );
    if (preSubmission) {
      consumedInvalidations.add(preSubmission.eventId);
      const envelope = buildFundedInvalidationEnvelope(
        {
          eventId: preSubmission.eventId,
          orderId: observationId,
          at: preSubmission.at,
        },
        true,
      );
      if (envelope) envelopes.push(envelope);
      refusalRequests.push({
        factId: `funded-invalidation:${preSubmission.eventId}`,
        observationId,
        action: "DECLINE" as const,
        policyReason: "PRE_SUBMISSION_INVALIDATION" as const,
        decisionAt: preSubmission.at,
      });
      continue;
    }
    const expiresAt = fundedSignalValidityDeadline(
      observation,
      input.shared.sessionDate,
      input.shared.scheduledCloseAt,
      input.assumptions,
    );
    if (!expiresAt)
      throw new FundedComparisonSpecificationError(
        "RETAINED_INPUT_MISSING",
        "Source opportunity  has no provable validity deadline",
      );
    const envelope = buildFundedSignalEnvelope(
      observation,
      opportunity.signalTimestamp,
      expiresAt,
      input.assumptions,
      maximumDebit,
      maximumRisk,
      { enforceValidity: canonical.portfolio !== undefined, policy: canonical },
    );
    if (!envelope)
      throw new FundedComparisonSpecificationError(
        "RETAINED_INPUT_MISSING",
        `Source opportunity ${entry.sourceOpportunityId} cannot produce a funded submission`,
      );
    envelopes.push(envelope);
    signalSortKeys.set(
      opportunityIdOf(envelope),
      comparisonSignalSortKey(entry.appliedRank, entry.sourceOpportunityId),
    );
  }
  for (const invalidation of input.shared.invalidations) {
    if (consumedInvalidations.has(invalidation.eventId)) continue;
    const opportunity = opportunityByInvalidation.get(invalidation.eventId);
    const orderId = opportunity
      ? observations.get(opportunity.sourceOpportunityId)
      : undefined;
    if (!orderId) continue;
    const envelope = buildFundedInvalidationEnvelope({
      eventId: invalidation.eventId,
      orderId,
      at: invalidation.at,
    });
    if (envelope) envelopes.push(envelope);
  }
  for (const quote of input.shared.quotes) {
    const envelope = buildFundedQuoteEnvelope(
      { ...quoteFactOf(quote), instrumentId: quote.instrumentId },
      canonical,
    );
    if (envelope) envelopes.push(envelope);
  }
  envelopes.push({
    id: `funded-comparison-clock:${input.runId}:${input.shared.scheduledCloseAt}`,
    fact: { type: "CLOCK" as const, at: input.shared.scheduledCloseAt },
  });

  const evidence = new FundedDecisionEvidenceRepository(
    deps.pool,
    undefined,
    input.evidenceSource,
  );
  const adapter = new FundedFactAdapter(deps.pool, input.runId);
  await adapter.enqueue(envelopes, {
    repository: evidence,
    refusalRequests,
    signalSortKeys,
  });
  await adapter.drain(undefined, { repository: evidence });
  await evidence.repairMissingDecisions(input.runId);
  await new FundedDecisionOutcomeProjector(deps.pool, evidence).projectPending(
    input.runId,
  );
  const decisions = new Map<string, FundedDecisionRow>();
  for (const [sourceOpportunityId, observationId] of observations) {
    const decision = await evidence.findDecision(input.runId, observationId);
    if (!decision)
      throw new FundedComparisonSpecificationError(
        "PREDICTION_DECISION_UNAVAILABLE",
        `${input.side} decision evidence is missing for ${sourceOpportunityId}`,
      );
    decisions.set(sourceOpportunityId, decision);
  }
  await new PostgresPaperBotStore(deps.pool).completeRun(input.runId);
  const report = await deps.reporting.report(input.runId);
  return {
    side: input.side,
    runId: input.runId,
    sessionDate: input.shared.sessionDate,
    observations,
    decisions,
    appliedRanks,
    unresolvedPositions: Object.keys(report.positions).length,
    unresolvedReservations: Object.keys(report.reservations).length,
  };
}

function opportunityIdOf(envelope: {
  fact: { type: string; order?: { orderId: string } };
}): string {
  if (envelope.fact.type !== "SIGNAL" || !envelope.fact.order)
    throw new Error("Expected a funded SIGNAL envelope");
  return envelope.fact.order.orderId;
}

function quoteFactOf(
  quote: FundedComparisonSharedInput["quotes"][number],
): QuoteFact {
  return {
    timestamp: quote.timestamp,
    bid: quote.bid,
    ask: quote.ask,
    bidSize: quote.bidSize,
    askSize: quote.askSize,
    sizeUnit: quote.sizeUnit,
    sizeMultiplier: quote.sizeMultiplier,
    dataStatus: quote.dataStatus,
    actionable: quote.actionable,
  };
}
