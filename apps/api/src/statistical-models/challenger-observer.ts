import {
  statisticalPredictionSchema,
  type StatisticalModelArtifact,
  type StatisticalPrediction,
  type StatisticalPredictionInput,
} from "@tsx-scanner/contracts";
import type {
  ChallengerAttempt,
  ChallengerOutcome,
} from "@tsx-scanner/contracts";
import type {
  ChallengerAttemptStore,
  ChallengerPredictionInput,
} from "./challenger-attempt-repository.js";

export interface ChallengerObservationEngine {
  predict(
    artifact: StatisticalModelArtifact,
    input: StatisticalPredictionInput,
    signal: AbortSignal,
  ): Promise<StatisticalPrediction>;
}

export interface ChallengerWorkItem {
  attempt: ChallengerAttempt;
  input: ChallengerPredictionInput;
  artifact: StatisticalModelArtifact;
}

const deadlineError = () => new Error("DEADLINE_EXPIRED");

export async function observeBeforeDeadline(
  item: ChallengerWorkItem,
  engine: ChallengerObservationEngine,
  store: ChallengerAttemptStore,
  now: () => Date,
): Promise<void> {
  const remainingMs = Date.parse(item.attempt.deadlineAt) - now().getTime();
  if (remainingMs <= 0) {
    await finishSafely(store, item.attempt, missedDeadline(now));
    return;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerFired = false;
  try {
    const prediction = await Promise.race([
      engine.predict(item.artifact, item.input, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timerFired = true;
          controller.abort();
          reject(deadlineError());
        }, remainingMs);
      }),
    ]);
    if (now().getTime() >= Date.parse(item.attempt.deadlineAt))
      throw deadlineError();
    const parsed = statisticalPredictionSchema.parse(prediction);
    assertPredictionIdentity(parsed, item.input);
    try {
      await store.finish(item.attempt, {
        status: "PREDICTED",
        completedAt: now().toISOString(),
        prediction: parsed,
      });
    } catch (error) {
      if (isDeadlineError(error)) {
        await finishSafely(store, item.attempt, missedDeadline(now));
        return;
      }
      if (isOutcomeConflict(error)) return;
      throw error;
    }
  } catch (error) {
    if (timerFired || isDeadlineError(error)) {
      await finishSafely(store, item.attempt, missedDeadline(now));
      return;
    }
    const outcome: ChallengerOutcome = {
      status: isInputError(error) ? "INPUT_INVALID" : "ENGINE_FAILED",
      completedAt: now().toISOString(),
      reason: isInputError(error)
        ? "PREDICTION_IDENTITY_INVALID"
        : "ENGINE_FAILED",
    };
    await finishSafely(store, item.attempt, outcome);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

function assertPredictionIdentity(
  prediction: StatisticalPrediction,
  input: ChallengerPredictionInput,
): void {
  if (
    prediction.marketId !== input.marketId ||
    prediction.instrumentId !== input.instrumentId ||
    prediction.symbol !== input.symbol ||
    prediction.timestamp !== input.timestamp ||
    prediction.profileId !== input.profileId ||
    prediction.profileName !== input.profileName ||
    prediction.strategy !== input.strategy ||
    prediction.deterministicScore !== input.deterministicScore
  )
    throw new Error("PREDICTION_IDENTITY_INVALID");
}

function missedDeadline(now: () => Date): ChallengerOutcome {
  return {
    status: "MISSED_DEADLINE",
    completedAt: now().toISOString(),
    reason: "DEADLINE_EXPIRED",
  };
}

async function finishSafely(
  store: ChallengerAttemptStore,
  attempt: ChallengerAttempt,
  outcome: ChallengerOutcome,
): Promise<void> {
  try {
    await store.finish(attempt, outcome);
  } catch (error) {
    if (isOutcomeConflict(error)) return;
    throw error;
  }
}

function isDeadlineError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.toUpperCase().includes("DEADLINE")
  );
}

function isOutcomeConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "CHALLENGER_OUTCOME_CONFLICT" ||
      error.message === "23505")
  );
}

function isInputError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "PREDICTION_IDENTITY_INVALID" ||
      error.message.includes("Invalid input") ||
      error.name === "ZodError")
  );
}
