import {
  fundedDecisionTimeInputSchema,
  fundedExecutionInferenceInputSchema,
  fundedExecutionInferenceOutputSchema,
  fundedExecutionPredictionOutputSchema,
  type FundedExecutionPredictionOutput,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { orderChallengerCandidates } from "../paper-bot/funded-comparison-challenger-policy.js";
import {
  loadFundedShadowChallenger,
  fundedShadowInferenceModelIdentity,
  verifyFundedShadowChallengerPolicy,
  type FundedShadowChallengerRecord,
} from "./funded-shadow-gate-policy.js";
import { extractFundedExecutionFeatures } from "./funded-execution-features.js";
import type { FundedExecutionPredictionService } from "./funded-execution-prediction.js";
import {
  FundedShadowError,
  type FundedShadowPendingAttempt,
  type FundedShadowStore,
} from "./funded-shadow-repository.js";
import type {
  FundedShadowAttemptResult,
  FundedShadowEnrollment,
  FundedShadowFailureReason,
  FundedShadowObserverEventKind,
} from "@tsx-scanner/contracts";

/**
 * FP04 shadow observer.
 *
 * The observer consumes only committed durable rows. It seals one simultaneous
 * batch per funded run and exact decision clock, records a prediction for every
 * member through the FP02 forward-prediction boundary before its database-owned
 * deadline, terminalizes missed/invalid/failed/unavailable attempts honestly,
 * projects one whole-batch challenger ordering (with whole-batch champion-order
 * fallback), joins independent canonical outcome labels at their availability
 * time and persists reproducible reports. It never writes an order, ledger,
 * reservation, risk, policy, activation or authority row.
 */

export interface FundedShadowInferenceEngine {
  predictFundedExecution(
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface FundedShadowObserverDependencies {
  readonly store: FundedShadowStore;
  readonly pool: Pool;
  readonly engine: FundedShadowInferenceEngine;
  readonly predictions: FundedExecutionPredictionService;
  /** Injectable frozen-challenger loader; defaults to the durable loader. */
  readonly challengerLoader?: (
    pool: Pool,
    enrollment: FundedShadowEnrollment,
  ) => Promise<FundedShadowChallengerRecord>;
  /** Wall-clock source; injectable for deterministic deadline tests. */
  readonly now?: () => number;
  readonly maxDecisionGroups?: number;
  readonly maxPendingAttempts?: number;
  readonly maxProjections?: number;
  readonly maxLabels?: number;
}

export interface FundedShadowPassResult {
  readonly marketId: MarketId;
  readonly enrollments: number;
  readonly sealedBatches: number;
  readonly terminalAttempts: number;
  readonly projectedBatches: number;
  readonly labels: number;
  readonly lateInputs: number;
  readonly failures: number;
  readonly refusals: number;
}

const DEFAULT_MAX_DECISION_GROUPS = 5;
const DEFAULT_MAX_PENDING_ATTEMPTS = 100;
const DEFAULT_MAX_PROJECTIONS = 20;
const DEFAULT_MAX_LABELS = 200;

const DEADLINE_CODES = new Set(["FUNDED_EXECUTION_PREDICTION_AFTER_DEADLINE"]);

const INPUT_CODES = new Set([
  "FUNDED_EXECUTION_PREDICTION_DECISION_NOT_FOUND",
  "FUNDED_EXECUTION_PREDICTION_DECISION_NOT_V2",
  "FUNDED_EXECUTION_PREDICTION_SEQUENCE_MISMATCH",
  "FUNDED_EXECUTION_PREDICTION_INPUT_DIGEST_MISMATCH",
]);

const IDENTITY_CODES = new Set([
  "FUNDED_EXECUTION_PREDICTION_CHALLENGER_NOT_FOUND",
  "FUNDED_EXECUTION_PREDICTION_CHALLENGER_NOT_INACTIVE",
  "FUNDED_EXECUTION_PREDICTION_MARKET_MISMATCH",
  "FUNDED_EXECUTION_PREDICTION_CURRENCY_MISMATCH",
  "FUNDED_EXECUTION_PREDICTION_OWNERSHIP_MISMATCH",
  "FUNDED_EXECUTION_PREDICTION_COHORT_MISMATCH",
  "FUNDED_EXECUTION_PREDICTION_SOURCE_MISMATCH",
  "FUNDED_EXECUTION_PREDICTION_PRECEDES_MODEL",
  "FUNDED_EXECUTION_PREDICTION_PRECEDES_DECISION",
]);

type ResultDraft = Omit<
  FundedShadowAttemptResult,
  "recordedAt" | "resultDigest"
>;

function failureResult(
  attempt: FundedShadowPendingAttempt["attempt"],
  disposition: ResultDraft["disposition"],
  failureReason: FundedShadowFailureReason,
): ResultDraft {
  return {
    attemptId: attempt.id,
    enrollmentId: attempt.enrollmentId,
    marketId: attempt.marketId,
    currency: attempt.currency,
    disposition,
    predictionId: null,
    predictionDigest: null,
    failureReason,
  };
}

function predictionFailure(message: string): {
  disposition: ResultDraft["disposition"];
  reason: FundedShadowFailureReason;
} {
  if (DEADLINE_CODES.has(message))
    return { disposition: "MISSED_DEADLINE", reason: "DEADLINE_EXPIRED" };
  if (INPUT_CODES.has(message))
    return {
      disposition: "INPUT_UNAVAILABLE",
      reason: "DECISION_CONTENT_INVALID",
    };
  if (message === "CONFLICTING_FUNDED_EXECUTION_PREDICTION")
    return { disposition: "INVALID_IDENTITY", reason: "PREDICTION_CONFLICT" };
  if (IDENTITY_CODES.has(message))
    return {
      disposition: "INVALID_IDENTITY",
      reason: "MODEL_IDENTITY_MISMATCH",
    };
  return { disposition: "INFERENCE_FAILURE", reason: "ENGINE_FAILED" };
}

function projectionUnavailableReason(
  disposition: FundedShadowAttemptResult["disposition"],
  failureReason: FundedShadowFailureReason | null,
): string {
  if (
    disposition === "INVALID_IDENTITY" &&
    failureReason === "PREDICTION_CONFLICT"
  )
    return "PREDICTION_CONFLICT";
  switch (disposition) {
    case "MISSED_DEADLINE":
      return "PREDICTION_LATE";
    case "INVALID_IDENTITY":
      return "PREDICTION_INVALID_IDENTITY";
    case "INFERENCE_FAILURE":
      return "PREDICTION_INFERENCE_FAILED";
    case "INPUT_UNAVAILABLE":
      return "PREDICTION_INPUT_UNAVAILABLE";
    case "TIMELY_PREDICTION":
      return "PREDICTION_MISSING";
  }
}

export class FundedShadowObserver {
  constructor(private readonly deps: FundedShadowObserverDependencies) {}

  private now(): number {
    return (this.deps.now ?? (() => Date.now()))();
  }

  async runOnce(marketId: MarketId): Promise<FundedShadowPassResult> {
    const enrollments = await this.deps.store.listActiveEnrollments(marketId);
    let sealedBatches = 0;
    let terminalAttempts = 0;
    let projectedBatches = 0;
    let labels = 0;
    let lateInputs = 0;
    let failures = 0;
    let refusals = 0;
    for (const active of enrollments) {
      const enrollment = active.enrollment;
      try {
        verifyFundedShadowChallengerPolicy(enrollment);
        const challenger = await (
          this.deps.challengerLoader ?? loadFundedShadowChallenger
        )(this.deps.pool, enrollment);
        const runs = await this.deps.store.listChampionRuns(enrollment);
        const verifiedRunIds: string[] = [];
        for (const run of runs) {
          if (run.policyDigest !== enrollment.champion.policyDigest) {
            refusals += 1;
            await this.recordEvent(
              marketId,
              enrollment.currency,
              "OWNERSHIP_REFUSAL",
              `champion-run-policy-mismatch:${run.runId}`,
            );
            continue;
          }
          verifiedRunIds.push(run.runId);
        }
        sealedBatches += await this.sealPendingBatches(
          enrollment,
          verifiedRunIds,
        );
        lateInputs += await this.countLateInputs(enrollment, verifiedRunIds);
        terminalAttempts += await this.observePendingAttempts(
          enrollment,
          challenger,
        );
        projectedBatches += await this.projectClosedBatches(enrollment);
        labels += await this.joinLabels(enrollment);
      } catch (error) {
        failures += 1;
        await this.recordEvent(
          marketId,
          enrollment.currency,
          "OBSERVER_FAILURE",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return {
      marketId,
      enrollments: enrollments.length,
      sealedBatches,
      terminalAttempts,
      projectedBatches,
      labels,
      lateInputs,
      failures,
      refusals,
    };
  }

  private async recordEvent(
    marketId: MarketId,
    currency: "CAD" | "USD",
    kind: FundedShadowObserverEventKind,
    detail: string,
  ): Promise<void> {
    await this.deps.store.recordObserverEvent({
      marketId,
      currency,
      kind,
      detail: detail.slice(0, 500),
    });
  }

  private async sealPendingBatches(
    enrollment: FundedShadowEnrollment,
    runIds: readonly string[],
  ): Promise<number> {
    const groups = await this.deps.store.listUnsealedDecisionGroups(
      enrollment,
      runIds,
      this.deps.maxDecisionGroups ?? DEFAULT_MAX_DECISION_GROUPS,
    );
    let sealed = 0;
    for (const group of groups) {
      try {
        await this.deps.store.sealBatch(enrollment, group);
        sealed += 1;
      } catch (error) {
        if (
          error instanceof FundedShadowError &&
          error.reason === "CONFLICTING_FUNDED_SHADOW_BATCH"
        ) {
          await this.recordEvent(
            enrollment.marketId,
            enrollment.currency,
            "OBSERVER_FAILURE",
            error.message,
          );
          continue;
        }
        throw error;
      }
    }
    return sealed;
  }

  private async countLateInputs(
    enrollment: FundedShadowEnrollment,
    runIds: readonly string[],
  ): Promise<number> {
    const late = await this.deps.store.countLateDecisionInputs(
      enrollment,
      runIds,
    );
    if (late > 0) {
      // One durable receipt per newly observed late decision instead of one per
      // poll pass; the count is monotone for a fixed sealed population.
      const recorded = await this.deps.store.lastLateInputEventCount(
        enrollment.marketId,
      );
      if (late > recorded)
        await this.recordEvent(
          enrollment.marketId,
          enrollment.currency,
          "LATE_INPUT",
          `late-decision-inputs:${late}`,
        );
    }
    return late;
  }

  private async observePendingAttempts(
    enrollment: FundedShadowEnrollment,
    challenger: FundedShadowChallengerRecord,
  ): Promise<number> {
    const pending = await this.deps.store.listPendingAttempts(
      enrollment.id,
      this.deps.maxPendingAttempts ?? DEFAULT_MAX_PENDING_ATTEMPTS,
    );
    let terminal = 0;
    for (const item of pending) {
      const attempt = item.attempt;
      let draft: ResultDraft;
      // A durable prediction may already exist when only the result append was
      // lost to a crash; it is never discarded in favour of MISSED_DEADLINE.
      const durable =
        attempt.decisionSequence === null
          ? undefined
          : await this.deps.store.durablePredictionFor({
              modelId: enrollment.challenger.model.modelId,
              runId: attempt.runId,
              observationId: attempt.observationId,
              decisionSequence: attempt.decisionSequence,
            });
      if (durable) {
        draft =
          Date.parse(durable.predictionAt) <= Date.parse(attempt.deadlineAt)
            ? {
                attemptId: attempt.id,
                enrollmentId: attempt.enrollmentId,
                marketId: attempt.marketId,
                currency: attempt.currency,
                disposition: "TIMELY_PREDICTION",
                predictionId: durable.id,
                predictionDigest: durable.digest,
                failureReason: null,
              }
            : failureResult(attempt, "MISSED_DEADLINE", "DEADLINE_EXPIRED");
      } else if (this.now() >= Date.parse(attempt.deadlineAt)) {
        draft = failureResult(attempt, "MISSED_DEADLINE", "DEADLINE_EXPIRED");
      } else {
        draft = await this.observeAttempt(enrollment, challenger, item);
      }
      try {
        await this.deps.store.appendResult(draft);
        terminal += 1;
      } catch (error) {
        await this.recordEvent(
          enrollment.marketId,
          enrollment.currency,
          "OBSERVER_FAILURE",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return terminal;
  }

  private async observeAttempt(
    enrollment: FundedShadowEnrollment,
    challenger: FundedShadowChallengerRecord,
    item: FundedShadowPendingAttempt,
  ): Promise<ResultDraft> {
    const attempt = item.attempt;
    if (item.evidenceSchemaVersion !== 2)
      return failureResult(attempt, "INPUT_UNAVAILABLE", "DECISION_NOT_V2");
    if (item.sourceKind !== "LIVE_PAPER")
      return failureResult(attempt, "INVALID_IDENTITY", "OWNERSHIP_REFUSAL");
    if (item.cohortDigest !== enrollment.challenger.model.cohortDigest)
      return failureResult(
        attempt,
        "INVALID_IDENTITY",
        "MODEL_IDENTITY_MISMATCH",
      );
    const decision = fundedDecisionTimeInputSchema.safeParse(
      item.decisionContent,
    );
    if (
      !decision.success ||
      decision.data.observationId !== attempt.observationId ||
      Date.parse(decision.data.decisionAt) !== Date.parse(attempt.decisionAt)
    )
      return failureResult(
        attempt,
        "INPUT_UNAVAILABLE",
        "DECISION_CONTENT_INVALID",
      );
    const features = extractFundedExecutionFeatures({
      decision: decision.data,
      marketId: enrollment.marketId,
    });
    const modelIdentity = fundedShadowInferenceModelIdentity(enrollment);
    const payload = fundedExecutionInferenceInputSchema.parse({
      requestVersion: "funded-execution-inference-v1",
      marketId: enrollment.marketId,
      currency: enrollment.currency,
      model: modelIdentity,
      artifact: challenger.artifact,
      inputs: [
        {
          runId: attempt.runId,
          observationId: attempt.observationId,
          decisionSequence: attempt.decisionSequence,
          decisionInputDigest: attempt.decisionInputDigest,
          features,
        },
      ],
    });
    const remainingMs = Date.parse(attempt.deadlineAt) - this.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("FUNDED_SHADOW_DEADLINE")),
      Math.max(1, remainingMs),
    );
    let raw: unknown;
    try {
      raw = await this.deps.engine.predictFundedExecution(
        payload,
        controller.signal,
      );
    } catch {
      return this.now() >= Date.parse(attempt.deadlineAt)
        ? failureResult(attempt, "MISSED_DEADLINE", "DEADLINE_EXPIRED")
        : failureResult(attempt, "INFERENCE_FAILURE", "ENGINE_FAILED");
    } finally {
      clearTimeout(timer);
    }
    const output = fundedExecutionInferenceOutputSchema.safeParse(raw);
    if (
      !output.success ||
      output.data.marketId !== enrollment.marketId ||
      output.data.currency !== enrollment.currency ||
      JSON.stringify(output.data.model) !== JSON.stringify(modelIdentity)
    )
      return failureResult(
        attempt,
        "INVALID_IDENTITY",
        "MODEL_IDENTITY_MISMATCH",
      );
    const prediction = output.data.predictions.find(
      (candidate) => candidate.observationId === attempt.observationId,
    );
    if (
      !prediction ||
      prediction.runId !== attempt.runId ||
      prediction.decisionSequence !== attempt.decisionSequence ||
      prediction.decisionInputDigest !== attempt.decisionInputDigest
    )
      return failureResult(attempt, "INFERENCE_FAILURE", "INVALID_DIAGNOSTIC");
    const diagnostic: FundedExecutionPredictionOutput = {
      fillProbability: prediction.output.fillProbability,
      expectedFillFraction: prediction.output.expectedFillFraction,
      expectedSlippagePerShare: prediction.output.expectedSlippagePerShare,
      expectedTotalExecutionCost: prediction.output.expectedTotalExecutionCost,
    };
    try {
      await this.deps.predictions.record({
        challengerId: enrollment.challenger.model.modelId,
        marketId: enrollment.marketId,
        currency: enrollment.currency,
        sourceKind: "LIVE_PAPER",
        runId: attempt.runId,
        observationId: attempt.observationId,
        expectedDecisionSequence: attempt.decisionSequence!,
        expectedDecisionInputDigest: attempt.decisionInputDigest!,
        deadlineAt: attempt.deadlineAt,
        output: diagnostic,
        warnings: [],
      });
      const durable = await this.deps.store.durablePredictionFor({
        modelId: enrollment.challenger.model.modelId,
        runId: attempt.runId,
        observationId: attempt.observationId,
        decisionSequence: attempt.decisionSequence!,
      });
      if (!durable)
        return failureResult(
          attempt,
          "INFERENCE_FAILURE",
          "PREDICTION_NOT_RETAINED",
        );
      return {
        attemptId: attempt.id,
        enrollmentId: attempt.enrollmentId,
        marketId: attempt.marketId,
        currency: attempt.currency,
        disposition: "TIMELY_PREDICTION",
        predictionId: durable.id,
        predictionDigest: durable.digest,
        failureReason: null,
      };
    } catch (error) {
      const failure = predictionFailure(
        error instanceof Error ? error.message : String(error),
      );
      return failureResult(attempt, failure.disposition, failure.reason);
    }
  }

  private async projectClosedBatches(
    enrollment: FundedShadowEnrollment,
  ): Promise<number> {
    const batches = await this.deps.store.listProjectableBatches(
      enrollment.id,
      this.deps.maxProjections ?? DEFAULT_MAX_PROJECTIONS,
    );
    let projected = 0;
    for (const item of batches) {
      const attemptByObservation = new Map(
        item.members.map((member) => [
          member.attempt.observationId,
          member.attempt.id,
        ]),
      );
      const candidates = item.members.map((member) => {
        const decision = fundedDecisionTimeInputSchema.safeParse(
          member.decisionContent,
        );
        const diagnostic = decision.success ? usableDiagnostic(member) : null;
        return {
          sourceOpportunityId: member.attempt.observationId,
          sourceOrdinal: member.attempt.decisionSequence ?? member.ordinal,
          signalTimestamp: item.batch.decisionAt,
          deterministicScore: decision.success ? decision.data.score : 0,
          decisionAt: item.batch.decisionAt,
          prediction: diagnostic
            ? {
                expectedFillFraction: diagnostic.expectedFillFraction.value,
                expectedTotalExecutionCost:
                  diagnostic.expectedTotalExecutionCost.value,
                expectedSlippagePerShare:
                  diagnostic.expectedSlippagePerShare.value,
              }
            : null,
          predictionIdentityValid: diagnostic !== null,
          unavailableReason: diagnostic
            ? null
            : !decision.success
              ? "PREDICTION_INPUT_UNAVAILABLE"
              : projectionUnavailableReason(
                  member.disposition,
                  member.failureReason,
                ),
        };
      });
      const ordering = orderChallengerCandidates(candidates, {
        policyVersion: enrollment.challenger.policyVersion,
        policyDigest: enrollment.challenger.policyDigest,
      });
      const orderedAttemptIds = ordering.entries.map((entry) =>
        attemptByObservation.get(entry.sourceOpportunityId)!,
      );
      const timely = item.members.filter(
        (member) => member.disposition === "TIMELY_PREDICTION",
      ).length;
      const orderChanges = ordering.entries.filter(
        (entry) => entry.appliedRank !== entry.championRank,
      ).length;
      try {
        await this.deps.store.appendProjection({
          projectionVersion: "funded-shadow-projection-v1",
          batchId: item.batch.id,
          enrollmentId: enrollment.id,
          marketId: enrollment.marketId,
          currency: enrollment.currency,
          batchDisposition: ordering.batchFallback
            ? "FALLBACK_CHAMPION_ORDER"
            : "CHALLENGER_ORDER",
          fallbackReason: ordering.batchFallback
            ? fallbackReasonOf(candidates)
            : null,
          orderedAttemptIds,
          predictionCoverage: timely / item.members.length,
          orderChanges,
        });
        projected += 1;
      } catch (error) {
        await this.recordEvent(
          enrollment.marketId,
          enrollment.currency,
          "RECONCILE_FAILURE",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return projected;
  }

  private async joinLabels(
    enrollment: FundedShadowEnrollment,
  ): Promise<number> {
    const candidates = await this.deps.store.listLabelCandidates(
      enrollment.id,
      this.deps.maxLabels ?? DEFAULT_MAX_LABELS,
    );
    let joined = 0;
    for (const candidate of candidates) {
      const outcome = await this.deps.store.canonicalOutcome(
        candidate.runId,
        candidate.observationId,
      );
      if (
        outcome.executionId !== null &&
        outcome.exitTime !== null &&
        outcome.rMultiple !== null
      ) {
        try {
          await this.deps.store.appendLabel({
            labelVersion: "funded-shadow-label-v1",
            attemptId: candidate.attemptId,
            enrollmentId: candidate.enrollmentId,
            marketId: candidate.marketId,
            currency: candidate.currency,
            status: outcome.rMultiple > 0 ? "POSITIVE" : "NEGATIVE",
            rMultiple: outcome.rMultiple,
            labelAvailableAt: outcome.exitTime,
            unresolvedReason: null,
            evidenceExecutionId: outcome.executionId,
          });
          joined += 1;
        } catch (error) {
          await this.recordEvent(
            enrollment.marketId,
            enrollment.currency,
            "RECONCILE_FAILURE",
            error instanceof Error ? error.message : String(error),
          );
        }
        continue;
      }
      if (outcome.runStatus !== "COMPLETED") continue;
      try {
        await this.deps.store.appendLabel({
          labelVersion: "funded-shadow-label-v1",
          attemptId: candidate.attemptId,
          enrollmentId: candidate.enrollmentId,
          marketId: candidate.marketId,
          currency: candidate.currency,
          status: "UNRESOLVED",
          rMultiple: null,
          labelAvailableAt: null,
          unresolvedReason:
            outcome.executionId === null
              ? "CANONICAL_QUOTE_OUTCOME_NOT_RETAINED"
              : "R_MULTIPLE_NOT_RETAINED",
          evidenceExecutionId: null,
        });
        joined += 1;
      } catch (error) {
        await this.recordEvent(
          enrollment.marketId,
          enrollment.currency,
          "RECONCILE_FAILURE",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return joined;
  }
}

function usableDiagnostic(member: {
  disposition: FundedShadowAttemptResult["disposition"];
  predictionOutput: unknown;
}): FundedExecutionPredictionOutput | null {
  if (member.disposition !== "TIMELY_PREDICTION") return null;
  const parsed = fundedExecutionPredictionOutputSchema.safeParse(
    member.predictionOutput,
  );
  return parsed.success ? parsed.data : null;
}

function fallbackReasonOf(
  candidates: readonly { unavailableReason: string | null }[],
): FundedShadowFailureReason {
  const named = candidates.find(
    (candidate) => candidate.unavailableReason !== null,
  );
  const reason = named?.unavailableReason;
  switch (reason) {
    case "PREDICTION_LATE":
      return "PREDICTION_LATE";
    case "PREDICTION_INVALID_IDENTITY":
      return "PREDICTION_INVALID_IDENTITY";
    case "PREDICTION_INFERENCE_FAILED":
      return "PREDICTION_INFERENCE_FAILED";
    case "PREDICTION_INPUT_UNAVAILABLE":
      return "PREDICTION_INPUT_UNAVAILABLE";
    case "PREDICTION_CONFLICT":
      return "PREDICTION_CONFLICT";
    default:
      return "PREDICTION_MISSING";
  }
}
