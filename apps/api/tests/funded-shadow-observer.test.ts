import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { FundedExecutionPredictionService } from "../src/statistical-models/funded-execution-prediction.js";
import { FundedShadowObserver } from "../src/statistical-models/funded-shadow-observer.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";
import {
  FakeFundedShadowStore,
  SHADOW_ACCOUNT_ID,
  shadowChallengerIdentity,
  shadowChampionIdentity,
  shadowChallengerRecord,
  shadowChampionRun,
  shadowDecisionGroup,
  shadowGatePolicyDraft,
  shadowPredictionOutput,
} from "./funded-shadow-fixtures.js";

interface Harness {
  store: FakeFundedShadowStore;
  observer: FundedShadowObserver;
  engine: ReturnType<typeof vi.fn>;
  predictions: { record: ReturnType<typeof vi.fn> };
}

async function setup(options?: {
  engine?: (payload: {
    inputs: Array<{
      runId: string;
      observationId: string;
      decisionSequence: number;
      decisionInputDigest: string;
    }>;
  }) => unknown;
}): Promise<Harness> {
  const store = new FakeFundedShadowStore();
  const saved = await store.saveGatePolicy(shadowGatePolicyDraft());
  await store.saveEnrollment({
    enrollmentVersion: "funded-shadow-enrollment-v1",
    gatePolicyId: saved.id,
    marketId: "CA_TSX",
    currency: "CAD",
    sourceKind: "LIVE_PAPER",
    champion: shadowChampionIdentity(),
    challenger: shadowChallengerIdentity(),
    evidenceCutoffAt: shadowChallengerIdentity().model.trainingEvidenceCutoffAt,
    registrationRequestId: "enroll-request",
    requestHash: "a".repeat(64),
  });
  store.championRuns = [shadowChampionRun()];
  type EnginePayload = {
    inputs: Array<{
      runId: string;
      observationId: string;
      decisionSequence: number;
      decisionInputDigest: string;
    }>;
  };
  const engine = vi.fn(async (payload: EnginePayload): Promise<unknown> =>
    options?.engine
      ? options.engine(payload)
      : {
          requestVersion: "funded-execution-inference-v1",
          marketId: "CA_TSX",
          currency: "CAD",
          model: {
            modelId: shadowChallengerIdentity().model.modelId,
            modelVersion: "1",
            modelType: "FUNDED_EXECUTION_QUALITY",
            artifactDigest: shadowChallengerIdentity().model.artifactDigest,
            cohortDigest: shadowChallengerIdentity().model.cohortDigest,
            featureVersion: "funded-execution-features-v1",
          },
          predictions: payload.inputs.map((input) => ({
            runId: input.runId,
            observationId: input.observationId,
            decisionSequence: input.decisionSequence,
            decisionInputDigest: input.decisionInputDigest,
            output: shadowPredictionOutput(),
            warnings: [],
          })),
          warnings: [],
        },
  );
  const predictions = {
    record: vi.fn(
      async (input: {
        marketId: string;
        currency: string;
        runId: string;
        observationId: string;
        expectedDecisionSequence: number;
        output: unknown;
      }) => {
        const key = `${shadowChallengerIdentity().model.modelId}:${
          input.runId
        }:${input.observationId}:${input.expectedDecisionSequence}`;
        const existing = store.predictionIds.get(key);
        if (existing)
          return {
            digest: contentHash(store.predictionOutputs.get(existing)),
          };
        const id = `00000000-0000-4000-8000-${String(
          store.predictionIds.size + 1,
        ).padStart(12, "0")}`;
        store.predictionIds.set(key, id);
        store.predictionTimes.set(key, new Date(store.nowMs()).toISOString());
        store.predictionOutputs.set(id, input.output);
        return { digest: contentHash(input.output) };
      },
    ),
  };
  const observer = new FundedShadowObserver({
    store,
    pool: {} as Pool,
    engine: { predictFundedExecution: engine },
    predictions: predictions as unknown as FundedExecutionPredictionService,
    challengerLoader: async () => shadowChallengerRecord(),
  });
  return { store, observer, engine, predictions };
}

const OBSERVATION_A = "77777777-7777-4777-8777-777777777777";
const OBSERVATION_B = "88888888-8888-4888-8888-888888888888";

describe("funded shadow observer", () => {
  it("seals one batch and records timely predictions for every member", async () => {
    const { store, observer } = await setup();
    const decisionAt = new Date().toISOString();
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt,
        members: [
          { observationId: OBSERVATION_A, sequence: 1, score: 80 },
          { observationId: OBSERVATION_B, sequence: 2, score: 70 },
        ],
      }),
    ];
    const pass = await observer.runOnce("CA_TSX");
    console.log(JSON.stringify(store.results, null, 1));
    expect(pass.sealedBatches).toBe(1);
    expect(store.batches).toHaveLength(1);
    expect(store.attempts).toHaveLength(2);
    expect(store.results.map((result) => result.disposition)).toEqual([
      "TIMELY_PREDICTION",
      "TIMELY_PREDICTION",
    ]);
    store.nowMs = () => Date.parse(decisionAt) + 31_000;
    await observer.runOnce("CA_TSX");
    expect(store.projections).toHaveLength(1);
    expect(store.projections[0]!.batchDisposition).toBe("CHALLENGER_ORDER");
    expect(store.projections[0]!.predictionCoverage).toBe(1);
  });

  it("falls back to whole-batch champion order when one inference fails", async () => {
    const { store, observer } = await setup({
      engine: async (payload) => {
        const first = payload.inputs[0]!.observationId;
        if (first === OBSERVATION_A) throw new Error("engine down");
        return {
          requestVersion: "funded-execution-inference-v1",
          marketId: "CA_TSX",
          currency: "CAD",
          model: {
            modelId: shadowChallengerIdentity().model.modelId,
            modelVersion: "1",
            modelType: "FUNDED_EXECUTION_QUALITY",
            artifactDigest: shadowChallengerIdentity().model.artifactDigest,
            cohortDigest: shadowChallengerIdentity().model.cohortDigest,
            featureVersion: "funded-execution-features-v1",
          },
          predictions: payload.inputs.map((input) => ({
            runId: input.runId,
            observationId: input.observationId,
            decisionSequence: input.decisionSequence,
            decisionInputDigest: input.decisionInputDigest,
            output: shadowPredictionOutput(0.9, 0.5),
            warnings: [],
          })),
          warnings: [],
        };
      },
    });
    const decisionAt = new Date(Date.now() + 1_000).toISOString();
    store.nowMs = () => Date.parse(decisionAt) + 31_000;
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt,
        members: [
          { observationId: OBSERVATION_A, sequence: 1, score: 90 },
          { observationId: OBSERVATION_B, sequence: 2, score: 60 },
        ],
      }),
    ];
    await observer.runOnce("CA_TSX");
    expect(
      store.results.filter(
        (result) => result.disposition === "INFERENCE_FAILURE",
      ),
    ).toHaveLength(1);
    expect(store.projections).toHaveLength(1);
    const projection = store.projections[0]!;
    expect(projection.batchDisposition).toBe("FALLBACK_CHAMPION_ORDER");
    expect(projection.fallbackReason).toBe("PREDICTION_INFERENCE_FAILED");
    expect(projection.predictionCoverage).toBe(0.5);
    const championOrder = store.attempts
      .filter((attempt) => attempt.batchId === projection.batchId)
      .sort(
        (left, right) =>
          (left.decisionSequence ?? 0) - (right.decisionSequence ?? 0),
      )
      .map((attempt) => attempt.id);
    expect(projection.orderedAttemptIds).toEqual(championOrder);
  });

  it("orders the challenger batch by its own predictions", async () => {
    const { store, observer } = await setup({
      engine: async (payload) => ({
        requestVersion: "funded-execution-inference-v1",
        marketId: "CA_TSX",
        currency: "CAD",
        model: {
          modelId: shadowChallengerIdentity().model.modelId,
          modelVersion: "1",
          modelType: "FUNDED_EXECUTION_QUALITY",
          artifactDigest: shadowChallengerIdentity().model.artifactDigest,
          cohortDigest: shadowChallengerIdentity().model.cohortDigest,
          featureVersion: "funded-execution-features-v1",
        },
        predictions: payload.inputs.map((input) => ({
          runId: input.runId,
          observationId: input.observationId,
          decisionSequence: input.decisionSequence,
          decisionInputDigest: input.decisionInputDigest,
          output:
            input.observationId === OBSERVATION_B
              ? shadowPredictionOutput(0.99, 0.1)
              : shadowPredictionOutput(0.5, 2),
          warnings: [],
        })),
        warnings: [],
      }),
    });
    const decisionAt = new Date().toISOString();
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt,
        members: [
          { observationId: OBSERVATION_A, sequence: 1, score: 90 },
          { observationId: OBSERVATION_B, sequence: 2, score: 60 },
        ],
      }),
    ];
    await observer.runOnce("CA_TSX");
    store.nowMs = () => Date.parse(decisionAt) + 31_000;
    await observer.runOnce("CA_TSX");
    const projection = store.projections[0]!;
    expect(projection.batchDisposition).toBe("CHALLENGER_ORDER");
    expect(projection.orderChanges).toBe(2);
    const first = store.attempts.find(
      (attempt) => attempt.id === projection.orderedAttemptIds[0],
    );
    expect(first?.observationId).toBe(OBSERVATION_B);
  });

  it("terminalizes missed deadlines without inferring after them", async () => {
    const store = new FakeFundedShadowStore();
    const t0 = Date.now();
    store.nowMs = () => t0;
    const saved = await store.saveGatePolicy(shadowGatePolicyDraft());
    await store.saveEnrollment({
      enrollmentVersion: "funded-shadow-enrollment-v1",
      gatePolicyId: saved.id,
      marketId: "CA_TSX",
      currency: "CAD",
      sourceKind: "LIVE_PAPER",
      champion: shadowChampionIdentity(),
      challenger: shadowChallengerIdentity(),
      evidenceCutoffAt:
        shadowChallengerIdentity().model.trainingEvidenceCutoffAt,
      registrationRequestId: "enroll-request",
      requestHash: "a".repeat(64),
    });
    store.championRuns = [shadowChampionRun()];
    const decisionAt = new Date(t0).toISOString();
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt,
        members: [{ observationId: OBSERVATION_A, sequence: 1 }],
      }),
    ];
    const engine = vi.fn();
    const predictions = { record: vi.fn() };
    const observer = new FundedShadowObserver({
      store,
      pool: {} as Pool,
      engine: { predictFundedExecution: engine },
      predictions: predictions as unknown as FundedExecutionPredictionService,
      challengerLoader: async () => shadowChallengerRecord(),
      now: () => t0 + 31_000,
    });
    store.nowMs = () => t0 + 31_000;
    await observer.runOnce("CA_TSX");
    expect(engine).not.toHaveBeenCalled();
    expect(store.results).toHaveLength(1);
    expect(store.results[0]!.disposition).toBe("MISSED_DEADLINE");
    expect(store.results[0]!.failureReason).toBe("DEADLINE_EXPIRED");
  });

  it("records unversioned evidence as unavailable input", async () => {
    const { store, observer, engine } = await setup();
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt: new Date().toISOString(),
        members: [
          { observationId: OBSERVATION_A, sequence: 1, schemaVersion: 1 },
        ],
      }),
    ];
    await observer.runOnce("CA_TSX");
    expect(engine).not.toHaveBeenCalled();
    expect(store.results[0]!.disposition).toBe("INPUT_UNAVAILABLE");
    expect(store.results[0]!.failureReason).toBe("DECISION_NOT_V2");
  });

  it("records a cohort mismatch as an invalid identity", async () => {
    const { store, observer, engine } = await setup();
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt: new Date().toISOString(),
        members: [
          {
            observationId: OBSERVATION_A,
            sequence: 1,
            cohortDigest: "9".repeat(64),
          },
        ],
      }),
    ];
    await observer.runOnce("CA_TSX");
    expect(engine).not.toHaveBeenCalled();
    expect(store.results[0]!.disposition).toBe("INVALID_IDENTITY");
    expect(store.results[0]!.failureReason).toBe("MODEL_IDENTITY_MISMATCH");
  });

  it("reuses the durable prediction and result on exact retry", async () => {
    const store = new FakeFundedShadowStore();
    const t0 = Date.now();
    let clock = t0;
    store.nowMs = () => clock;
    const saved = await store.saveGatePolicy(shadowGatePolicyDraft());
    await store.saveEnrollment({
      enrollmentVersion: "funded-shadow-enrollment-v1",
      gatePolicyId: saved.id,
      marketId: "CA_TSX",
      currency: "CAD",
      sourceKind: "LIVE_PAPER",
      champion: shadowChampionIdentity(),
      challenger: shadowChallengerIdentity(),
      evidenceCutoffAt:
        shadowChallengerIdentity().model.trainingEvidenceCutoffAt,
      registrationRequestId: "enroll-request",
      requestHash: "a".repeat(64),
    });
    store.championRuns = [shadowChampionRun()];
    const decisionAt = new Date(t0).toISOString();
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt,
        members: [{ observationId: OBSERVATION_A, sequence: 1 }],
      }),
    ];
    const engine = vi.fn(
      async (payload: {
        inputs: Array<{
          runId: string;
          observationId: string;
          decisionSequence: number;
          decisionInputDigest: string;
        }>;
      }) => ({
        requestVersion: "funded-execution-inference-v1",
        marketId: "CA_TSX",
        currency: "CAD",
        model: {
          modelId: shadowChallengerIdentity().model.modelId,
          modelVersion: "1",
          modelType: "FUNDED_EXECUTION_QUALITY",
          artifactDigest: shadowChallengerIdentity().model.artifactDigest,
          cohortDigest: shadowChallengerIdentity().model.cohortDigest,
          featureVersion: "funded-execution-features-v1",
        },
        predictions: payload.inputs.map((input) => ({
          runId: input.runId,
          observationId: input.observationId,
          decisionSequence: input.decisionSequence,
          decisionInputDigest: input.decisionInputDigest,
          output: shadowPredictionOutput(),
          warnings: [],
        })),
        warnings: [],
      }),
    );
    const predictions = {
      record: vi.fn(
        async (input: {
          runId: string;
          observationId: string;
          expectedDecisionSequence: number;
          output: unknown;
        }) => {
          const key = `${shadowChallengerIdentity().model.modelId}:${
            input.runId
          }:${input.observationId}:${input.expectedDecisionSequence}`;
          const existing = store.predictionIds.get(key);
          if (existing)
            return {
              digest: contentHash(store.predictionOutputs.get(existing)),
            };
          const id = `00000000-0000-4000-8000-${String(
            store.predictionIds.size + 1,
          ).padStart(12, "0")}`;
          store.predictionIds.set(key, id);
          store.predictionTimes.set(key, new Date(clock).toISOString());
          store.predictionOutputs.set(id, input.output);
          return { digest: contentHash(input.output) };
        },
      ),
    };
    const observer = new FundedShadowObserver({
      store,
      pool: {} as Pool,
      engine: { predictFundedExecution: engine },
      predictions: predictions as unknown as FundedExecutionPredictionService,
      challengerLoader: async () => shadowChallengerRecord(),
      now: () => clock,
    });
    await observer.runOnce("CA_TSX");
    expect(store.results).toHaveLength(1);
    const first = store.results[0]!;
    // Simulate a crash after inference/prediction but before the result append.
    store.results.length = 0;
    clock = t0 + 1_000;
    await observer.runOnce("CA_TSX");
    expect(store.results).toHaveLength(1);
    expect(store.results[0]!.attemptId).toBe(first.attemptId);
    expect(store.results[0]!.predictionId).toBe(first.predictionId);
    // The durable prediction is reused; it is never re-recorded or discarded.
    expect(predictions.record).toHaveBeenCalledTimes(1);
    // A crash recovered after the deadline keeps the timely durable prediction
    // instead of rewriting immutable evidence as MISSED_DEADLINE.
    store.results.length = 0;
    clock = t0 + 31_000;
    await observer.runOnce("CA_TSX");
    expect(store.results).toHaveLength(1);
    expect(store.results[0]!.disposition).toBe("TIMELY_PREDICTION");
    expect(store.results[0]!.predictionId).toBe(first.predictionId);
    expect(predictions.record).toHaveBeenCalledTimes(1);
    // Once the batch closes, the projection is appended idempotently.
    expect(store.projections).toHaveLength(1);
    await observer.runOnce("CA_TSX");
    expect(store.projections).toHaveLength(1);
  });

  it("records a conflicting prediction retry as an invalid identity", async () => {
    const { store, observer, predictions } = await setup();
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt: new Date().toISOString(),
        members: [{ observationId: OBSERVATION_A, sequence: 1 }],
      }),
    ];
    predictions.record.mockImplementationOnce(async () => {
      throw new Error("CONFLICTING_FUNDED_EXECUTION_PREDICTION");
    });
    await observer.runOnce("CA_TSX");
    expect(store.results[0]!.disposition).toBe("INVALID_IDENTITY");
    expect(store.results[0]!.failureReason).toBe("PREDICTION_CONFLICT");
  });

  it("counts late decision inputs and records a receipt", async () => {
    const { store, observer } = await setup();
    store.lateInputs = 3;
    const pass = await observer.runOnce("CA_TSX");
    expect(pass.lateInputs).toBe(3);
    expect(store.events.some((event) => event.kind === "LATE_INPUT")).toBe(
      true,
    );
  });

  it("refuses a champion run whose policy identity changed", async () => {
    const { store, observer } = await setup();
    store.championRuns = [shadowChampionRun({ policyDigest: "0".repeat(64) })];
    const pass = await observer.runOnce("CA_TSX");
    expect(pass.refusals).toBe(1);
    expect(
      store.events.some((event) => event.kind === "OWNERSHIP_REFUSAL"),
    ).toBe(true);
    expect(store.batches).toHaveLength(0);
  });

  it("produces no work after the enrollment is revoked", async () => {
    const { store, observer } = await setup();
    const enrollmentId = (await store.listEnrollmentIds("CA_TSX"))[0]!;
    await store.transitionEnrollment(enrollmentId, "REVOKE", "revoke-request");
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt: new Date().toISOString(),
        members: [{ observationId: OBSERVATION_A, sequence: 1 }],
      }),
    ];
    const pass = await observer.runOnce("CA_TSX");
    expect(pass.enrollments).toBe(0);
    expect(store.batches).toHaveLength(0);
  });

  it("writes no funded order, ledger or account row", async () => {
    const { store, observer } = await setup();
    store.decisionGroups = [
      shadowDecisionGroup({
        decisionAt: new Date().toISOString(),
        members: [{ observationId: OBSERVATION_A, sequence: 1 }],
      }),
    ];
    await observer.runOnce("CA_TSX");
    const writes = [
      ...store.batches.map((row) => row.id),
      ...store.attempts.map((row) => row.id),
      ...store.results.map((row) => row.attemptId),
      ...store.projections.map((row) => row.batchId),
    ];
    expect(writes.length).toBeGreaterThan(0);
    expect(store.attempts[0]!.accountId).toBe(SHADOW_ACCOUNT_ID);
  });
});
