import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { FundedExecutionPredictionService } from "../src/statistical-models/funded-execution-prediction.js";
import { FundedShadowObserver } from "../src/statistical-models/funded-shadow-observer.js";
import { FundedShadowReportingService } from "../src/statistical-models/funded-shadow-reporting.js";
import { FundedShadowReadService } from "../src/paper-bot/funded-shadow-read-service.js";
import { PostgresFundedShadowStore } from "../src/statistical-models/funded-shadow-repository.js";
import { rm, writeFile } from "node:fs/promises";
import {
  FakeFundedShadowStore,
  shadowChallengerIdentity,
  shadowChampionIdentity,
  shadowChallengerRecord,
  shadowChampionRun,
  shadowDecisionGroup,
  shadowGatePolicyDraft,
  shadowPredictionOutput,
} from "./funded-shadow-fixtures.js";

const OBSERVATION_A = "77777777-7777-4777-8777-777777777777";
const OBSERVATION_B = "88888888-8888-4888-8888-888888888888";

async function populatedStore() {
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
  const engine = async (payload: {
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
      output:
        input.observationId === OBSERVATION_B
          ? shadowPredictionOutput(0.99, 0.1)
          : shadowPredictionOutput(0.5, 2),
      warnings: [],
    })),
    warnings: [],
  });
  const predictions = {
    record: async (input: {
      runId: string;
      observationId: string;
      expectedDecisionSequence: number;
      output: unknown;
    }) => {
      const key = `${shadowChallengerIdentity().model.modelId}:${
        input.runId
      }:${input.observationId}:${input.expectedDecisionSequence}`;
      const id =
        store.predictionIds.get(key) ??
        `00000000-0000-4000-8000-${String(
          store.predictionIds.size + 1,
        ).padStart(12, "0")}`;
      store.predictionIds.set(key, id);
      store.predictionOutputs.set(id, input.output);
      return { digest: "b".repeat(64) };
    },
  };
  const observer = new FundedShadowObserver({
    store,
    pool: {} as Pool,
    engine: { predictFundedExecution: engine },
    predictions: predictions as unknown as FundedExecutionPredictionService,
    challengerLoader: async () => shadowChallengerRecord(),
  });
  await observer.runOnce("CA_TSX");
  store.nowMs = () => Date.parse(decisionAt) + 31_000;
  await observer.runOnce("CA_TSX");
  // Independent canonical labels: observation A positive, observation B negative.
  store.canonicalOutcomes.set(OBSERVATION_A, {
    executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    exitTime: new Date(Date.parse(decisionAt) + 60_000).toISOString(),
    rMultiple: 1.5,
    runStatus: "RUNNING",
  });
  store.canonicalOutcomes.set(OBSERVATION_B, {
    executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    exitTime: new Date(Date.parse(decisionAt) + 60_000).toISOString(),
    rMultiple: -0.5,
    runStatus: "RUNNING",
  });
  await observer.runOnce("CA_TSX");
  const enrollmentId = (await store.listEnrollmentIds("CA_TSX"))[0]!;
  return { store, enrollmentId };
}

describe("funded shadow reporting", () => {
  it("reproduces an identical report digest from frozen rows", async () => {
    const { store, enrollmentId } = await populatedStore();
    const reporting = new FundedShadowReportingService(store);
    const first = await reporting.preview(enrollmentId);
    const second = await reporting.preview(enrollmentId);
    expect(first).toBeDefined();
    expect(first!.reportDigest).toBe(second!.reportDigest);
    expect(first!.promotionAuthorized).toBe(false);
    expect(first!.authorityEffect).toBe("NONE");
    expect(first!.fundedEconomics.status).toBe("NOT_PROJECTED_IN_V1");
  });

  it("reports coverage, fallback and label completeness honestly", async () => {
    const { store, enrollmentId } = await populatedStore();
    const reporting = new FundedShadowReportingService(store);
    const report = (await reporting.preview(enrollmentId))!;
    expect(report.coverage.sealedBatches).toBe(1);
    expect(report.coverage.closedBatches).toBe(1);
    expect(report.coverage.timelyPredictions).toBe(2);
    expect(report.coverage.fallbackBatches).toBe(0);
    expect(report.coverage.predictionCoverage).toBe(1);
    expect(report.coverage.labelsAvailable).toBe(2);
    expect(report.coverage.labelCompleteness).toBe(1);
    expect(report.championActions.submit).toBe(2);
    // The challenger ranks B first; A is positive, B is negative.
    expect(report.challengerMetrics.firstRank.negative).toBe(1);
    expect(report.championMetrics.firstRank.positive).toBe(1);
    expect(report.deltas.firstRankPositiveRate).toBe(-1);
    expect(report.orderAgreement.changedBatches).toBe(1);
    expect(report.window.minimumsMet).toBe(false);
  });

  it("records one immutable snapshot and returns it on exact retry", async () => {
    const { store, enrollmentId } = await populatedStore();
    const reporting = new FundedShadowReportingService(store);
    const first = await reporting.record(enrollmentId);
    const second = await reporting.record(enrollmentId);
    expect(first?.reused).toBe(false);
    expect(second?.reused).toBe(true);
    expect(first?.report.reportDigest).toBe(second?.report.reportDigest);
    expect(store.reports).toHaveLength(1);
  });

  it("keeps markets separate in the read projection", async () => {
    const { store, enrollmentId } = await populatedStore();
    const reporting = new FundedShadowReportingService(store);
    const read = new FundedShadowReadService(store, reporting);
    const ca = await read.list("CA_TSX");
    expect(ca).toHaveLength(1);
    expect(ca[0]!.marketId).toBe("CA_TSX");
    expect(await read.list("US_EQUITIES")).toHaveLength(0);
    await expect(read.list("ALL" as never)).rejects.toThrow(/market-scoped/);
    const detail = await read.get(enrollmentId);
    expect(detail.report?.reportDigest).toBe(
      ca[0]!.latestReportDigest ?? detail.report!.reportDigest,
    );
  });
});

describe("funded shadow CLI validation", () => {
  it("rejects a gate policy without a Stage B approval before any database read", async () => {
    const { resolveFundedShadowPlan } = await import("../src/funded-shadow.js");
    const file = `${process.env.TEMP ?? "."}/fp04-invalid-gate-policy-${Date.now()}.json`;
    await writeFile(
      file,
      JSON.stringify({
        gatePolicyVersion: "funded-shadow-gate-policy-v1",
        marketId: "CA_TSX",
        currency: "CAD",
        window: {
          minDecisions: 40,
          minSessions: 20,
          horizonSessions: 40,
          horizonDays: 90,
        },
        challengerPolicyVersion:
          "funded-comparison-execution-quality-ordering-v1",
        maxPredictionLagMs: 30_000,
      }),
    );
    try {
      await expect(
        resolveFundedShadowPlan(
          {
            mode: "plan",
            apply: false,
            record: false,
            market: "CA_TSX",
            challengerId: "99999999-9999-4999-8999-999999999999",
            fundedAccountId: "66666666-6666-4666-8666-666666666666",
            gatePolicyFile: file,
            enrollmentId: "",
          },
          {
            pool: {
              query: () => {
                throw new Error("database must not be read");
              },
            } as unknown as Pool,
            now: () => new Date(),
          },
        ),
      ).rejects.toThrow();
    } finally {
      await rm(file, { force: true });
    }
  });

  it("refuses a requested prediction lag above the operator ceiling", async () => {
    const { resolveFundedShadowPlan } = await import("../src/funded-shadow.js");
    const file = `${process.env.TEMP ?? "."}/fp04-lag-ceiling-${Date.now()}.json`;
    await writeFile(file, JSON.stringify(shadowGatePolicyDraft()));
    const previous = process.env.FUNDED_SHADOW_MAX_PREDICTION_LAG_MS;
    process.env.FUNDED_SHADOW_MAX_PREDICTION_LAG_MS = "5000";
    try {
      await expect(
        resolveFundedShadowPlan(
          {
            mode: "plan",
            apply: false,
            record: false,
            market: "CA_TSX",
            challengerId: "99999999-9999-4999-8999-999999999999",
            fundedAccountId: "66666666-6666-4666-8666-666666666666",
            gatePolicyFile: file,
            enrollmentId: "",
          },
          {
            pool: {
              query: () => {
                throw new Error("database must not be read");
              },
            } as unknown as Pool,
            now: () => new Date(),
          },
        ),
      ).rejects.toThrow(/exceeds the configured FP04 ceiling/);
    } finally {
      if (previous === undefined)
        delete process.env.FUNDED_SHADOW_MAX_PREDICTION_LAG_MS;
      else process.env.FUNDED_SHADOW_MAX_PREDICTION_LAG_MS = previous;
      await rm(file, { force: true });
    }
  });
});

describe("funded shadow PostgreSQL store wiring", () => {
  it("exposes no authority or activation surface", () => {
    const methods = Object.getOwnPropertyNames(
      PostgresFundedShadowStore.prototype,
    );
    for (const forbidden of [
      "activate",
      "promote",
      "rollback",
      "setActivePolicy",
      "grantAuthority",
    ])
      expect(methods).not.toContain(forbidden);
  });
});
