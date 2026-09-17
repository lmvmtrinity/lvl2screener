import type { MarketId } from "@tsx-scanner/contracts";
import type { FundedFactEnvelope } from "./funded-fact-adapter.js";
import {
  buildFundedInvalidationEnvelope,
  buildFundedQuoteEnvelope,
  buildFundedSignalEnvelope,
  fundedSignalValidityDeadline,
  type FundedInvalidation,
} from "./funded-live-adapter.js";
import type { PaperSignalObservation } from "./paper-bot-repository.js";
import { normalizeFundedPolicy, type FundedPolicy } from "./funded-policy.js";
import { zonedSessionBoundary } from "./session-time.js";
import type { AssumptionsSnapshot, QuoteFact } from "./types.js";
import { fundedReservationDebit } from "./financials.js";

export interface FundedHistoricalReplayInput {
  readonly runId: string;
  readonly marketId: MarketId;
  readonly executionModelVersion: string;
  readonly sessionDate: string;
  readonly sessionTimezone: string;
  readonly scheduledCloseAt: string;
  readonly assumptions: AssumptionsSnapshot;
  readonly policy: FundedPolicy;
  readonly observations: readonly PaperSignalObservation[];
  readonly invalidations: readonly FundedInvalidation[];
  /** Raw retained quotes, including delayed/halted rows used for coverage checks. */
  readonly quotes: readonly (QuoteFact & { readonly instrumentId: string })[];
}

export interface FundedHistoricalCoverage {
  readonly rawCoverageVerified: true;
  readonly observationCount: number;
  readonly quoteCount: number;
  readonly coveredObservationCount: number;
  readonly semanticVersions: readonly string[];
}

/**
 * A durable refusal request prepared for a historical replay. It travels as
 * an additive sidecar bound to the pre-submission CANCEL fact inside the same
 * enqueue transaction; the ordered drain captures its chronological cursor.
 * The strict driver envelope is never extended.
 */
export interface FundedHistoricalRefusalRequest {
  readonly factId: string;
  readonly observationId: string;
  readonly action: "DECLINE";
  readonly policyReason: "PRE_SUBMISSION_INVALIDATION";
  readonly decisionAt: string;
}

export interface FundedHistoricalFacts {
  readonly envelopes: readonly FundedFactEnvelope[];
  readonly refusalRequests: readonly FundedHistoricalRefusalRequest[];
  readonly coverage: FundedHistoricalCoverage;
}

const marketCurrency: Record<MarketId, "CAD" | "USD"> = {
  CA_TSX: "CAD",
  US_EQUITIES: "USD",
};

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function semanticVersionOf(observation: PaperSignalObservation): string {
  const payload = objectRecord(observation.sourceEventPayload);
  const version = payload?.signalSemanticsVersion;
  if (
    typeof version !== "string" ||
    version.trim() === "" ||
    version === "UNKNOWN"
  )
    throw new Error(
      `Historical funded replay requires signal semantic provenance for observation ${observation.id}`,
    );
  return version;
}

function assertFactWindow(
  label: string,
  value: string,
  startMs: number,
  closeMs: number,
  inclusiveClose: boolean,
): number {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < startMs ||
    (inclusiveClose ? parsed > closeMs : parsed >= closeMs)
  )
    throw new Error(
      `Historical funded replay has ${label} outside its session`,
    );
  return parsed;
}

/**
 * Converts retained raw signals and quotes into the same durable facts used by
 * the opt-in live adapter. It fails closed when semantic signal provenance or
 * post-signal raw quote coverage is missing; an execution-only facts file does
 * not provide either guarantee.
 */
export function buildFundedHistoricalFacts(
  input: FundedHistoricalReplayInput,
): FundedHistoricalFacts {
  if (!input.runId || !input.executionModelVersion)
    throw new Error("Historical funded replay requires run provenance");
  const expectedCurrency = marketCurrency[input.marketId];
  const startAt = zonedSessionBoundary(
    input.sessionDate,
    "09:30",
    input.sessionTimezone,
  );
  const startMs = Date.parse(startAt);
  const closeMs = Date.parse(input.scheduledCloseAt);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(closeMs) ||
    closeMs <= startMs
  )
    throw new Error("Historical funded replay has an invalid session boundary");
  if (
    input.assumptions.costs?.currency !== undefined &&
    input.assumptions.costs.currency !== expectedCurrency
  )
    throw new Error(
      "Historical funded replay cost currency does not match market",
    );
  if (expectedCurrency === "USD" && !input.assumptions.costs)
    throw new Error(
      "Historical funded replay requires explicit USD cost provenance",
    );
  const canonicalPolicy = normalizeFundedPolicy(input.policy);

  const observations = [...input.observations].sort(
    (left, right) =>
      Date.parse(left.signalTimestamp) - Date.parse(right.signalTimestamp) ||
      left.id.localeCompare(right.id),
  );
  const { evidenceScope: _evidenceScope, ...factAssumptions } =
    input.assumptions;
  const semanticVersions = new Set<string>();
  const sortedInvalidations = [...input.invalidations].sort(
    (left, right) =>
      Date.parse(left.at) - Date.parse(right.at) ||
      left.eventId.localeCompare(right.eventId),
  );
  const preSubmissionInvalidationIds = new Set<string>();
  const preSubmissionOrderIds = new Set<string>();
  const quoteTimes = input.quotes.map((quote) => ({
    quote,
    timestamp: assertFactWindow(
      "retained quote",
      quote.timestamp,
      startMs,
      closeMs,
      true,
    ),
  }));
  const missingCoverage: string[] = [];
  for (const observation of observations) {
    if (
      observation.runId !== input.runId ||
      observation.marketId !== input.marketId ||
      observation.eligibilityStatus !== "ELIGIBLE"
    )
      throw new Error(
        `Historical funded replay observation ${observation.id} is outside the source run or is not eligible`,
      );
    const signalMs = assertFactWindow(
      `signal ${observation.id}`,
      observation.signalTimestamp,
      startMs,
      closeMs,
      false,
    );
    semanticVersions.add(semanticVersionOf(observation));
    const validityDeadline = canonicalPolicy.portfolio
      ? fundedSignalValidityDeadline(
          observation,
          input.sessionDate,
          input.scheduledCloseAt,
          factAssumptions,
        )
      : input.scheduledCloseAt;
    const validityMs = validityDeadline ? Date.parse(validityDeadline) : NaN;
    const releaseMs = signalMs + (factAssumptions.latencyMs ?? 0);
    if (
      !Number.isFinite(validityMs) ||
      !quoteTimes.some(
        ({ quote, timestamp }) =>
          quote.instrumentId === observation.instrumentId &&
          timestamp >= releaseMs &&
          timestamp <= Math.min(closeMs, validityMs),
      )
    )
      missingCoverage.push(observation.id);
  }
  if (missingCoverage.length)
    throw new Error(
      `Historical funded replay is missing retained quote coverage for observations: ${missingCoverage.join(",")}`,
    );

  const envelopes: FundedFactEnvelope[] = [
    {
      id: `funded-historical-clock:${input.runId}:${startAt}`,
      fact: { type: "CLOCK", at: startAt },
    },
  ];
  const refusalRequests: FundedHistoricalRefusalRequest[] = [];
  for (const observation of observations) {
    const preSubmissionInvalidation = sortedInvalidations.find(
      (invalidation) =>
        invalidation.orderId === observation.id &&
        Date.parse(invalidation.at) <= Date.parse(observation.signalTimestamp),
    );
    const validityDeadline = canonicalPolicy.portfolio
      ? fundedSignalValidityDeadline(
          observation,
          input.sessionDate,
          input.scheduledCloseAt,
          factAssumptions,
        )
      : input.scheduledCloseAt;
    const envelope = preSubmissionInvalidation
      ? buildFundedInvalidationEnvelope(preSubmissionInvalidation, true)
      : buildFundedSignalEnvelope(
          observation,
          observation.signalTimestamp,
          validityDeadline ?? input.scheduledCloseAt,
          factAssumptions,
          fundedReservationDebit(factAssumptions),
          factAssumptions.riskBudget ?? fundedReservationDebit(factAssumptions),
          {
            enforceValidity: canonicalPolicy.portfolio !== undefined,
            policy: canonicalPolicy,
          },
        );
    if (!envelope)
      throw new Error(
        `Historical funded replay cannot construct signal ${observation.id}`,
      );
    if (preSubmissionInvalidation) {
      preSubmissionInvalidationIds.add(preSubmissionInvalidation.eventId);
      preSubmissionOrderIds.add(observation.id);
      refusalRequests.push({
        factId: `funded-invalidation:${preSubmissionInvalidation.eventId}`,
        observationId: observation.id,
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        decisionAt: new Date(preSubmissionInvalidation.at).toISOString(),
      });
    }
    envelopes.push(envelope);
  }
  for (const invalidation of sortedInvalidations) {
    assertFactWindow(
      `invalidation ${invalidation.eventId}`,
      invalidation.at,
      startMs,
      closeMs,
      true,
    );
    if (
      preSubmissionInvalidationIds.has(invalidation.eventId) ||
      preSubmissionOrderIds.has(invalidation.orderId)
    )
      continue;
    const envelope = buildFundedInvalidationEnvelope(invalidation);
    if (envelope) envelopes.push(envelope);
  }
  for (const { quote } of quoteTimes.sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      left.quote.instrumentId.localeCompare(right.quote.instrumentId),
  )) {
    const envelope = buildFundedQuoteEnvelope(quote, input.policy);
    if (envelope) envelopes.push(envelope);
  }
  envelopes.push({
    id: `funded-historical-clock:${input.runId}:${input.scheduledCloseAt}`,
    fact: {
      type: "CLOCK",
      at: new Date(closeMs).toISOString(),
    },
  });
  return {
    envelopes,
    refusalRequests,
    coverage: {
      rawCoverageVerified: true,
      observationCount: observations.length,
      quoteCount: input.quotes.length,
      coveredObservationCount: observations.length,
      semanticVersions: [...semanticVersions].sort(),
    },
  };
}
