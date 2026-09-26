import {
  fundedShadowReportSchema,
  type FundedShadowAttempt,
  type FundedShadowCoverage,
  type FundedShadowDeltaMetrics,
  type FundedShadowEnrollment,
  type FundedShadowLabel,
  type FundedShadowOutcomeDistribution,
  type FundedShadowReport,
  type FundedShadowReportDraft,
  type FundedShadowSideMetrics,
} from "@tsx-scanner/contracts";
import { fundedShadowReportDigest } from "./funded-shadow-digest.js";
import type {
  FundedShadowReportInputs,
  FundedShadowStore,
} from "./funded-shadow-repository.js";

/**
 * Reproducible prospective reporting. The report is assembled only from frozen
 * persisted rows; identical evidence reproduces an identical digest. It reports
 * absolute decision-level metrics for the champion's actual order and the
 * challenger's counterfactual order over the same shared independent labels,
 * and never infers a challenger result from a champion funded outcome.
 */

export function defaultFundedShadowAsOf(
  inputs: FundedShadowReportInputs,
): string {
  const times = [
    inputs.active.enrollment.createdAt,
    ...inputs.batches.map((batch) => batch.sealedAt),
    ...inputs.attempts.map((attempt) => attempt.recordedAt),
    ...inputs.results.map((result) => result.recordedAt),
    ...inputs.projections.map((projection) => projection.recordedAt),
    ...inputs.labels.map((label) => label.recordedAt),
  ];
  let latest = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    const parsed = Date.parse(time);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return new Date(
    latest === Number.NEGATIVE_INFINITY ? 0 : latest,
  ).toISOString();
}

function distributionOf(
  labels: readonly (FundedShadowLabel | undefined)[],
): FundedShadowOutcomeDistribution {
  let positive = 0;
  let negative = 0;
  let unresolved = 0;
  let pending = 0;
  let rSum = 0;
  let rCount = 0;
  for (const label of labels) {
    if (!label) {
      pending += 1;
      continue;
    }
    if (label.status === "POSITIVE") positive += 1;
    else if (label.status === "NEGATIVE") negative += 1;
    else unresolved += 1;
    if (label.rMultiple !== null) {
      rSum += label.rMultiple;
      rCount += 1;
    }
  }
  return {
    positive,
    negative,
    unresolved,
    pending,
    meanRMultiple: rCount === 0 ? null : rSum / rCount,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sideMetrics(
  decisions: readonly FundedShadowAttempt[],
  firstRank: readonly FundedShadowAttempt[],
  labels: ReadonlyMap<string, FundedShadowLabel>,
): FundedShadowSideMetrics {
  return {
    decisions: decisions.length,
    firstRank: distributionOf(
      firstRank.map((attempt) => labels.get(attempt.id)),
    ),
    allDecisions: distributionOf(
      decisions.map((attempt) => labels.get(attempt.id)),
    ),
  };
}

export function buildFundedShadowReport(
  inputs: FundedShadowReportInputs,
  requestedAsOf?: string,
): FundedShadowReportDraft {
  const enrollment: FundedShadowEnrollment = inputs.active.enrollment;
  const asOf = requestedAsOf ?? defaultFundedShadowAsOf(inputs);
  const asOfMs = Date.parse(asOf);
  const inWindow = <T>(rows: readonly T[], at: (row: T) => string): T[] =>
    rows.filter((row) => Date.parse(at(row)) <= asOfMs);

  const batches = inWindow(inputs.batches, (batch) => batch.sealedAt);
  const attempts = inWindow(inputs.attempts, (attempt) => attempt.recordedAt);
  const results = inWindow(inputs.results, (result) => result.recordedAt);
  const projections = inWindow(
    inputs.projections,
    (projection) => projection.recordedAt,
  );
  const labels = inWindow(inputs.labels, (label) => label.recordedAt);

  const resultByAttempt = new Map(
    results.map((result) => [result.attemptId, result]),
  );
  const labelByAttempt = new Map(
    labels.map((label) => [label.attemptId, label]),
  );
  const projectionByBatch = new Map(
    projections.map((projection) => [projection.batchId, projection]),
  );
  const terminalAttempts = attempts.filter((attempt) =>
    resultByAttempt.has(attempt.id),
  );
  const pendingAttempts = attempts.length - terminalAttempts.length;
  const timelyPredictions = results.filter(
    (result) => result.disposition === "TIMELY_PREDICTION",
  ).length;
  const missedDeadline = results.filter(
    (result) => result.disposition === "MISSED_DEADLINE",
  ).length;
  const invalidIdentity = results.filter(
    (result) => result.disposition === "INVALID_IDENTITY",
  ).length;
  const inferenceFailure = results.filter(
    (result) => result.disposition === "INFERENCE_FAILURE",
  ).length;
  const inputUnavailable = results.filter(
    (result) => result.disposition === "INPUT_UNAVAILABLE",
  ).length;
  const fallbackBatches = projections.filter(
    (projection) => projection.batchDisposition === "FALLBACK_CHAMPION_ORDER",
  ).length;
  const labelRows = terminalAttempts
    .map((attempt) => labelByAttempt.get(attempt.id))
    .filter((label): label is FundedShadowLabel => label !== undefined);
  const resolvedLabels = labelRows.filter(
    (label) => label.status !== "UNRESOLVED",
  ).length;
  const permanentlyUnresolved = labelRows.filter(
    (label) => label.status === "UNRESOLVED",
  ).length;
  const labelsPending = terminalAttempts.length - labelRows.length;

  const coverage: FundedShadowCoverage = {
    eligibleObservations: inputs.eligibleObservations,
    attemptedObservations: attempts.length,
    inputCoverage: rate(attempts.length, inputs.eligibleObservations),
    sealedBatches: batches.length,
    closedBatches: projections.length,
    fallbackBatches,
    fallbackRate: rate(fallbackBatches, projections.length),
    timelyPredictions,
    missedDeadline,
    invalidIdentity,
    inferenceFailure,
    inputUnavailable,
    pendingAttempts,
    predictionCoverage: rate(timelyPredictions, terminalAttempts.length),
    labelsAvailable: resolvedLabels,
    labelsPending,
    labelsPermanentlyUnresolved: permanentlyUnresolved,
    labelCompleteness: rate(labelRows.length, terminalAttempts.length),
  };

  const membersByBatch = new Map<string, FundedShadowAttempt[]>();
  for (const attempt of attempts) {
    const list = membersByBatch.get(attempt.batchId) ?? [];
    list.push(attempt);
    membersByBatch.set(attempt.batchId, list);
  }
  for (const list of membersByBatch.values())
    list.sort(
      (left, right) =>
        (left.decisionSequence ?? Number.MAX_SAFE_INTEGER) -
          (right.decisionSequence ?? Number.MAX_SAFE_INTEGER) ||
        left.observationId.localeCompare(right.observationId),
    );
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));

  const orderedBatches = new Map<string, FundedShadowAttempt[]>();
  for (const [batchId, members] of membersByBatch) {
    const projection = projectionByBatch.get(batchId);
    const ordered = projection
      ? projection.orderedAttemptIds
          .map((id) => attemptById.get(id))
          .filter((attempt): attempt is FundedShadowAttempt => !!attempt)
      : members;
    orderedBatches.set(batchId, ordered);
  }

  const championFirst: FundedShadowAttempt[] = [];
  const challengerFirst: FundedShadowAttempt[] = [];
  for (const [batchId, members] of membersByBatch) {
    const champion = members[0];
    const challenger = orderedBatches.get(batchId)?.[0];
    if (champion) championFirst.push(champion);
    if (challenger) challengerFirst.push(challenger);
  }

  const championMetrics = sideMetrics(
    [...membersByBatch.values()].flat(),
    championFirst,
    labelByAttempt,
  );
  const challengerMetrics = sideMetrics(
    [...orderedBatches.values()].flat(),
    challengerFirst,
    labelByAttempt,
  );

  const championFirstRate = rate(
    championMetrics.firstRank.positive,
    championMetrics.firstRank.positive +
      championMetrics.firstRank.negative +
      championMetrics.firstRank.unresolved,
  );
  const challengerFirstRate = rate(
    challengerMetrics.firstRank.positive,
    challengerMetrics.firstRank.positive +
      challengerMetrics.firstRank.negative +
      challengerMetrics.firstRank.unresolved,
  );
  const championFirstNegativeRate = rate(
    championMetrics.firstRank.negative,
    championMetrics.firstRank.positive +
      championMetrics.firstRank.negative +
      championMetrics.firstRank.unresolved,
  );
  const challengerFirstNegativeRate = rate(
    challengerMetrics.firstRank.negative,
    challengerMetrics.firstRank.positive +
      challengerMetrics.firstRank.negative +
      challengerMetrics.firstRank.unresolved,
  );
  const deltas: FundedShadowDeltaMetrics = {
    firstRankPositiveRate:
      championFirstRate === null || challengerFirstRate === null
        ? null
        : challengerFirstRate - championFirstRate,
    firstRankNegativeRate:
      championFirstNegativeRate === null || challengerFirstNegativeRate === null
        ? null
        : challengerFirstNegativeRate - championFirstNegativeRate,
    firstRankMeanRMultiple:
      championMetrics.firstRank.meanRMultiple === null ||
      challengerMetrics.firstRank.meanRMultiple === null
        ? null
        : challengerMetrics.firstRank.meanRMultiple -
          championMetrics.firstRank.meanRMultiple,
    allDecisionsMeanRMultiple:
      championMetrics.allDecisions.meanRMultiple === null ||
      challengerMetrics.allDecisions.meanRMultiple === null
        ? null
        : challengerMetrics.allDecisions.meanRMultiple -
          championMetrics.allDecisions.meanRMultiple,
  };

  const sessionDates = new Set(
    terminalAttempts.map((attempt) => attempt.sessionDate),
  );
  const orderedDecisions = terminalAttempts
    .map((attempt) => attempt.decisionAt)
    .sort();
  const changedBatches = [...membersByBatch.entries()].filter(
    ([batchId, members]) => {
      const ordered = orderedBatches.get(batchId) ?? members;
      return ordered.some(
        (attempt, index) => members[index]?.id !== attempt.id,
      );
    },
  ).length;

  const championActions = {
    submit: attempts.filter((attempt) => attempt.championAction === "SUBMIT")
      .length,
    decline: attempts.filter((attempt) => attempt.championAction === "DECLINE")
      .length,
    defer: attempts.filter((attempt) => attempt.championAction === "DEFER")
      .length,
    unavailable: attempts.filter(
      (attempt) => attempt.championAction === "UNAVAILABLE",
    ).length,
  };

  const draft = {
    reportVersion: "funded-shadow-report-v1" as const,
    enrollmentId: enrollment.id,
    marketId: enrollment.marketId,
    currency: enrollment.currency,
    enrollmentState: inputs.active.state,
    gatePolicyDigest: inputs.active.gatePolicy.gatePolicyDigest,
    challengerPolicyVersion: enrollment.challenger.policyVersion,
    challengerPolicyDigest: enrollment.challenger.policyDigest,
    maxPredictionLagMs: inputs.active.gatePolicy.maxPredictionLagMs,
    champion: enrollment.champion,
    challenger: enrollment.challenger,
    evidenceBoundary: {
      asOf,
      firstDecisionAt: orderedDecisions[0] ?? null,
      lastDecisionAt: orderedDecisions[orderedDecisions.length - 1] ?? null,
      sealedBatches: batches.length,
      closedBatches: projections.length,
      attempts: attempts.length,
      terminalAttempts: terminalAttempts.length,
    },
    coverage,
    championActions,
    championMetrics,
    challengerMetrics,
    deltas,
    orderAgreement: {
      batches: projections.length,
      changedBatches,
      orderChangeRate: rate(changedBatches, projections.length),
    },
    window: {
      minDecisions: inputs.active.gatePolicy.window.minDecisions,
      minSessions: inputs.active.gatePolicy.window.minSessions,
      horizonSessions: inputs.active.gatePolicy.window.horizonSessions,
      horizonDays: inputs.active.gatePolicy.window.horizonDays,
      decisions: terminalAttempts.length,
      sessions: sessionDates.size,
      minimumsMet:
        terminalAttempts.length >=
          inputs.active.gatePolicy.window.minDecisions &&
        sessionDates.size >= inputs.active.gatePolicy.window.minSessions,
      gateEligible:
        terminalAttempts.length >=
          inputs.active.gatePolicy.window.minDecisions &&
        sessionDates.size >= inputs.active.gatePolicy.window.minSessions &&
        fallbackBatches === 0 &&
        missedDeadline === 0 &&
        pendingAttempts === 0,
    },
    fundedEconomics: {
      status: "NOT_PROJECTED_IN_V1" as const,
      reason: "DECISION_LEVEL_SHADOW_OBSERVATION" as const,
    },
    promotionAuthorized: false as const,
    authorityEffect: "NONE" as const,
  };
  const parsed = fundedShadowReportSchema.parse({
    ...draft,
    reportDigest: "0".repeat(64),
  });
  const { reportDigest: _placeholder, ...payload } = parsed;
  return payload;
}

export class FundedShadowReportingService {
  constructor(private readonly store: FundedShadowStore) {}

  /**
   * Assembles a report from frozen rows without persisting it. Without an
   * explicit `asOf` the boundary is derived from the frozen evidence itself, so
   * identical rows reproduce an identical digest at any wall-clock time.
   */
  async preview(
    enrollmentId: string,
    asOf?: string,
  ): Promise<FundedShadowReport | undefined> {
    const inputs = await this.store.loadReportInputs(enrollmentId, asOf);
    if (!inputs) return undefined;
    const draft = buildFundedShadowReport(inputs, asOf);
    return fundedShadowReportSchema.parse({
      ...draft,
      reportDigest: fundedShadowReportDigest(draft),
    });
  }

  /** Persists one immutable report snapshot; an exact retry returns it. */
  async record(
    enrollmentId: string,
    asOf?: string,
  ): Promise<{ report: FundedShadowReport; reused: boolean } | undefined> {
    const inputs = await this.store.loadReportInputs(enrollmentId, asOf);
    if (!inputs) return undefined;
    const draft = buildFundedShadowReport(inputs, asOf);
    return this.store.saveReport(draft);
  }
}
