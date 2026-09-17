import { describe, expect, it, vi } from "vitest";
import { contentHash } from "../src/backtests/research-coverage.js";
import {
  observeBeforeDeadline,
  type ChallengerObservationEngine,
  type ChallengerWorkItem,
} from "../src/statistical-models/challenger-observer.js";
import type { ChallengerAttemptStore } from "../src/statistical-models/challenger-attempt-repository.js";
import type { ChallengerOutcome } from "@tsx-scanner/contracts";

const input = {
  marketId: "CA_TSX" as const,
  instrumentId: "10000000-0000-4000-8000-000000000002",
  symbol: "TEST.TO",
  timestamp: "2026-09-10T13:30:00.000Z",
  profileId: "10000000-0000-4000-8000-000000000003",
  profileName: "Fixture",
  strategy: "ORB_RETEST" as const,
  deterministicScore: 70,
  atrPct: 2,
  rvolAtTime: 1.5,
  profileConfigId: "10000000-0000-4000-8000-000000000006",
};

const attempt = {
  experimentId: "10000000-0000-4000-8000-000000000004",
  observationId: "10000000-0000-4000-8000-000000000005",
  modelVersion: "fixture-v1",
  inputHash: contentHash(input),
  observedAt: input.timestamp,
  recordedAt: input.timestamp,
  deadlineAt: "2026-09-10T13:30:01.000Z",
};

const item: ChallengerWorkItem = {
  input,
  attempt,
  artifact: {
    artifactVersion: "1.0.0",
    modelType: "LOGISTIC_SETUP_QUALITY",
    featureNames: ["a", "b", "c", "d"],
    intercept: 0,
    coefficients: [0, 0, 0, 0],
    means: [0, 0, 0, 0],
    scales: [1, 1, 1, 1],
    medians: [0, 0, 0, 0],
    atrMedian: 2,
    rvolMedian: 1.5,
  },
};

function memoryStore(): ChallengerAttemptStore & {
  outcomes: ChallengerOutcome[];
} {
  const outcomes: ChallengerOutcome[] = [];
  return {
    outcomes,
    capture: vi.fn(async () => "INSERTED" as const),
    finish: vi.fn(async (_attempt, outcome) => {
      outcomes.push(outcome);
    }),
    expire: vi.fn(async () => 0),
  };
}

describe("observeBeforeDeadline", () => {
  it("never reconstructs an overdue prediction", async () => {
    const engine: ChallengerObservationEngine = { predict: vi.fn() };
    const store = memoryStore();
    await observeBeforeDeadline(
      item,
      engine,
      store,
      () => new Date("2026-09-10T13:30:01.000Z"),
    );
    expect(engine.predict).not.toHaveBeenCalled();
    expect(store.outcomes[0]?.status).toBe("MISSED_DEADLINE");
  });

  it("turns an engine timeout into an immutable missed deadline", async () => {
    vi.useFakeTimers();
    const engine: ChallengerObservationEngine = {
      predict: vi.fn(
        (_artifact, _input, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    };
    const store = memoryStore();
    try {
      const pending = observeBeforeDeadline(
        item,
        engine,
        store,
        () => new Date("2026-09-10T13:30:00.000Z"),
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await pending;
      expect(store.outcomes[0]).toMatchObject({
        status: "MISSED_DEADLINE",
        reason: "DEADLINE_EXPIRED",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
