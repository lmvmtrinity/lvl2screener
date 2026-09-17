import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FUNDED_EXECUTION_FEATURE_NAMES,
  fundedExecutionChallengerSchema,
  fundedExecutionDatasetManifestSchema,
  fundedExecutionDatasetMemberSchema,
  type FundedCohortIdentity,
  type FundedExecutionChallenger,
  type FundedExecutionDatasetManifest,
  type FundedExecutionDatasetMember,
  type FundedExecutionFeatureVector,
  type FundedExecutionLabels,
  type FundedExecutionModelArtifact,
  type FundedExecutionQualificationReceipt,
  type FundedExecutionTrainingResult,
  type ResearchJob,
} from "@tsx-scanner/contracts";
import type { FundedExecutionAssembledRow } from "../src/statistical-models/funded-execution-qualification.js";
import { fundedExecutionArtifactDigest } from "../src/statistical-models/funded-execution-digest.js";
import {
  FundedExecutionTrainingService,
  type FundedExecutionTrainingClient,
} from "../src/statistical-models/funded-execution-training-service.js";
import type {
  FundedExecutionChallengerDraft,
  FundedExecutionDatasetDraft,
  FundedExecutionTrainingStore,
} from "../src/statistical-models/funded-execution-training-repository.js";
import { FundedExecutionTrainingScheduler } from "../src/statistical-models/funded-execution-training-scheduler.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

const features: FundedExecutionFeatureVector = {
  deterministicScore: 80,
  spreadPct: 0.2,
  logDisplayedSize: 6,
  logRequestedNotional: 7.3,
  logRequestedRisk: 5.5,
  quoteAgeSeconds: 1,
  minutesFromOpen: 5,
  atrPct: 0.015,
  stopDistancePct: 0.02,
  targetDistancePct: 0.05,
  logCash: 9.2,
  logOpenRisk: 0,
  logReservedRisk: 0,
  positionCount: 0,
  participation: 0.25,
  contextStrength: 2,
};

function labels(
  overrides: Partial<FundedExecutionLabels> = {},
): FundedExecutionLabels {
  const value = {
    fillProbability: 1,
    fillFraction: 1,
    slippagePerShare: 0.01,
    totalExecutionCost: 1,
    labelAvailableAt: "2026-09-08T18:00:00.000Z",
    economicOutcomeAt: "2026-09-08T17:30:00.000Z",
    terminalityProof: null,
    terminalOutcomeStatus: "FILLED",
    terminalOutcomeSequence: 2,
    terminalOutcomeSourceDigest: digestA,
    fillLabelAvailable: true,
    costLabelAvailable: true,
    ...overrides,
  } as FundedExecutionLabels;
  return {
    ...value,
    knowledge: overrides.knowledge ?? {
      provenance: "DATABASE_CAPTURE",
      runId: null,
      sequence: null,
      at: value.labelAvailableAt,
    },
  };
}

function row(
  overrides: Partial<FundedExecutionAssembledRow> = {},
): FundedExecutionAssembledRow {
  return {
    marketId: "CA_TSX",
    currency: "CAD",
    accountId: "00000000-0000-4000-8000-000000000001",
    runId: "run-1",
    observationId: "observation-1",
    decisionSequence: 1,
    decisionContentDigest: digestA,
    cohortDigest: digestB,
    sourceKind: "LIVE_PAPER",
    action: "SUBMIT",
    decisionAt: "2026-09-08T14:30:00.000Z",
    runSource: "LIVE",
    runStatus: "COMPLETED",
    instrumentId: null,
    sessionDate: "2026-09-08",
    verdict: "INCLUDED",
    exclusionReason: null,
    unknown: false,
    features,
    labels: labels(),
    outcomeSequences: [2],
    outcomeSourceDigests: [digestA],
    exposureEndAt: "2026-09-08T15:00:00.000Z",
    ...overrides,
  };
}

function qualifyingRows(): FundedExecutionAssembledRow[] {
  const rows: FundedExecutionAssembledRow[] = [];
  const trainSessions = ["2026-09-08", "2026-09-09", "2026-09-10"];
  for (let index = 0; index < 100; index += 1) {
    const sessionDate = trainSessions[index % 3]!;
    const filled = index % 2 === 0;
    rows.push(
      row({
        observationId: `train-${String(index).padStart(3, "0")}`,
        decisionAt: `${sessionDate}T14:${String(10 + (index % 40)).padStart(2, "0")}:00.000Z`,
        sessionDate,
        labels: labels({
          fillProbability: filled ? 1 : 0,
          fillFraction: filled ? 1 : 0,
          slippagePerShare: filled ? 0.01 : null,
          totalExecutionCost: filled ? 1 : null,
          costLabelAvailable: filled,
          terminalOutcomeStatus: filled ? "FILLED" : "NO_FILL",
          labelAvailableAt: `${sessionDate}T18:00:00.000Z`,
        }),
      }),
    );
  }
  for (let index = 0; index < 100; index += 1) {
    const filled = index % 2 === 0;
    rows.push(
      row({
        observationId: `test-${String(index).padStart(3, "0")}`,
        decisionAt: `2026-09-11T14:${String(10 + (index % 40)).padStart(2, "0")}:00.000Z`,
        sessionDate: "2026-09-11",
        labels: labels({
          fillProbability: filled ? 1 : 0,
          fillFraction: filled ? 1 : 0,
          slippagePerShare: filled ? 0.01 : null,
          totalExecutionCost: filled ? 1 : null,
          costLabelAvailable: filled,
          terminalOutcomeStatus: filled ? "FILLED" : "NO_FILL",
          labelAvailableAt: "2026-09-11T18:00:00.000Z",
        }),
      }),
    );
  }
  return rows;
}

/**
 * Replay rows carry their own persisted applied-fact boundary, as the contract
 * requires for every HISTORICAL_REPLAY member.
 */
function replayRows(): FundedExecutionAssembledRow[] {
  return qualifyingRows().map((entry) => ({
    ...entry,
    sourceKind: "HISTORICAL_REPLAY" as const,
    runSource: "BACKTEST",
    labels: {
      ...entry.labels!,
      knowledge: {
        provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE" as const,
        runId: entry.runId,
        sequence: 1,
        at: `${entry.sessionDate}T18:00:00.000Z`,
      },
    },
  }));
}

function cohort(
  overrides: Partial<FundedCohortIdentity> = {},
): FundedCohortIdentity {
  return {
    marketId: "CA_TSX",
    currency: "CAD",
    evidenceSchemaVersion: 2,
    fundedPolicyVersion: "funded-policy-v1",
    portfolioPolicyVersion: "funded-portfolio-v2",
    executionModelVersion: "paper-execution-v3",
    costPolicyVersion: "paper-cost-policy-2026-09-04",
    participationVersion: "participation-v1",
    sourceKind: "LIVE_PAPER",
    featureVersion: "funded-execution-features-v1",
    runtimeVersion: "runtime-v1",
    accountAssumptionDigest: digestA,
    signalModelId: null,
    signalModelVersion: null,
    cohortDigest: digestB,
    ...overrides,
  };
}

class FakeStore implements FundedExecutionTrainingStore {
  readonly datasets: FundedExecutionDatasetManifest[] = [];
  readonly members = new Map<string, FundedExecutionDatasetMember[]>();
  readonly challengers: FundedExecutionChallenger[] = [];
  createDatasetCalls = 0;

  constructor(private readonly rows: FundedExecutionAssembledRow[]) {}

  async listCohorts() {
    return [
      {
        cohort: cohort(),
        sourceKind: "LIVE_PAPER" as const,
        decisionCount: this.rows.length,
        completedLiveCount: this.rows.length,
        firstDecisionAt: this.rows[0]?.decisionAt ?? null,
        lastDecisionAt: this.rows.at(-1)?.decisionAt ?? null,
      },
    ];
  }

  async assembledRowsFor(_cohortDigest: string, _cutoff: Date) {
    return this.rows;
  }

  async countDatasets() {
    return this.datasets.length;
  }

  async createDataset(
    draft: FundedExecutionDatasetDraft,
  ): Promise<FundedExecutionDatasetManifest> {
    this.createDatasetCalls += 1;
    const existing = this.datasets.find(
      (dataset) => dataset.datasetDigest === draft.datasetDigest,
    );
    if (existing) return existing;
    const dataset = fundedExecutionDatasetManifestSchema.parse({
      id: randomUUID(),
      marketId: draft.cohort.marketId,
      currency: draft.cohort.currency,
      cohort: draft.cohort,
      sourceKind: draft.sourceKind,
      requestedCutoff: draft.requestedCutoff.toISOString(),
      effectiveCutoff: draft.effectiveCutoff.toISOString(),
      datasetPolicyVersion: draft.datasetPolicyVersion,
      labelMappingVersion: draft.labelMappingVersion,
      featureVersion: draft.featureVersion,
      qualificationPolicyVersion: draft.qualificationPolicyVersion,
      membershipDigest: draft.membershipDigest,
      datasetDigest: draft.datasetDigest,
      qualificationReceipt: draft.receipt,
      sourceWatermark: draft.sourceWatermark,
      activationEligible: draft.activationEligible,
      createdAt: "2026-09-16T20:00:00.000Z",
    });
    this.datasets.push(dataset);
    this.members.set(
      dataset.id,
      draft.members.map((member) =>
        fundedExecutionDatasetMemberSchema.parse({
          ordinal: member.ordinal,
          marketId: member.marketId,
          currency: member.currency,
          identity: {
            marketId: member.marketId,
            currency: member.currency,
            accountId: member.accountId,
            runId: member.runId,
            observationId: member.observationId,
            decisionSequence: member.decisionSequence,
            decisionContentDigest: member.decisionContentDigest,
            cohortDigest: member.cohortDigest,
            evidenceSchemaVersion: 2,
            outcomeSequences: [...member.outcomeSequences],
            outcomeSourceDigests: [...member.outcomeSourceDigests],
          },
          instrumentId: member.instrumentId,
          decisionAt: member.decisionAt,
          sessionDate: member.sessionDate,
          partition: member.partition,
          features: member.features,
          labels: member.labels,
          sourceKind: member.sourceKind,
          labelMappingVersion: "funded-execution-labels-v1",
          featureVersion: "funded-execution-features-v1",
          rowDigest: member.rowDigest,
        }),
      ),
    );
    return dataset;
  }

  async getDataset(id: string) {
    return this.datasets.find((dataset) => dataset.id === id);
  }

  async latestDatasetFor(_cohortDigest: string) {
    return this.datasets.at(-1);
  }

  async listDatasetMembers(id: string) {
    return this.members.get(id) ?? [];
  }

  async findChallengerByDatasetDigest(datasetDigest: string) {
    return this.challengers.find(
      (challenger) => challenger.datasetDigest === datasetDigest,
    );
  }

  async listChallengers() {
    return this.challengers;
  }

  async persistChallenger(
    draft: FundedExecutionChallengerDraft,
  ): Promise<FundedExecutionChallenger> {
    const existing = await this.findChallengerByDatasetDigest(
      draft.datasetDigest,
    );
    if (existing) return existing;
    const challenger = fundedExecutionChallengerSchema.parse({
      id: randomUUID(),
      marketId: draft.marketId,
      currency: draft.currency,
      cohort: draft.cohort,
      datasetId: draft.datasetId,
      datasetDigest: draft.datasetDigest,
      modelVersion: draft.modelVersion,
      modelType: "FUNDED_EXECUTION_QUALITY",
      artifactDigest: draft.artifactDigest,
      featureVersion: "funded-execution-features-v1",
      labelMappingVersion: "funded-execution-labels-v1",
      qualificationPolicyVersion: "funded-execution-qualification-v1",
      trainingPolicyVersion: "funded-execution-training-v1",
      trainingCodeVersion: draft.trainingCodeVersion,
      runtimeFingerprint: draft.runtimeFingerprint,
      status: draft.status,
      eligibleForActivation: false,
      active: false,
      artifact: draft.artifact,
      metrics: draft.metrics,
      sampleCounts: draft.sampleCounts,
      failureReceipt: draft.failureReceipt,
      createdAt: "2026-09-16T20:05:00.000Z",
    });
    this.challengers.push(challenger);
    return challenger;
  }
}

function artifact(
  datasetDigest: string,
  partitionDigest: string,
): FundedExecutionModelArtifact {
  const head = (output: string, kind: "LOGISTIC" | "LINEAR", unit: string) => {
    const metrics =
      kind === "LOGISTIC"
        ? {
            kind,
            samples: 40,
            positives: 20,
            negatives: 20,
            baseRate: 0.5,
            brierScore: 0.2,
            baselineBrierScore: 0.25,
            logLoss: 0.6,
            rocAuc: 0.6,
            calibration: [],
          }
        : {
            kind,
            samples: 40,
            meanPredicted: 0.5,
            meanActual: 0.5,
            meanAbsoluteError: 0.1,
            rootMeanSquaredError: 0.2,
          };
    return {
      output,
      kind,
      unit,
      lowerBound: 0,
      upperBound: unit === "PROBABILITY" || unit === "FRACTION" ? 1 : null,
      trainingSamples: 160,
      intercept: 0.1,
      coefficients: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0.01),
      means: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0),
      scales: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 1),
      medians: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0),
      trainMetrics: metrics,
      testMetrics: metrics,
    };
  };
  return {
    artifactVersion: "funded-execution-v1",
    modelType: "FUNDED_EXECUTION_QUALITY",
    featureVersion: "funded-execution-features-v1",
    featureNames: [...FUNDED_EXECUTION_FEATURE_NAMES],
    sourceDatasetDigest: datasetDigest,
    trainingPartitionDigest: partitionDigest,
    trainingRowCount: 160,
    trainingFillRowCount: 160,
    trainingCostRowCount: 80,
    outputs: [
      head("fillProbability", "LOGISTIC", "PROBABILITY"),
      head("expectedFillFraction", "LINEAR", "FRACTION"),
      head("expectedSlippagePerShare", "LINEAR", "CURRENCY_PER_SHARE"),
      head("expectedTotalExecutionCost", "LINEAR", "CURRENCY"),
    ] as unknown as FundedExecutionModelArtifact["outputs"],
    warnings: [],
  };
}

function trainingClient(
  result: (payload: {
    datasetDigest: string;
    trainingPartitionDigest: string;
  }) => FundedExecutionTrainingResult,
): FundedExecutionTrainingClient {
  return {
    async trainFundedExecution(payload: unknown) {
      const request = payload as {
        datasetDigest: string;
        trainingPartitionDigest: string;
      };
      return result(request);
    },
  };
}

describe("funded execution dataset materialization", () => {
  it("freezes identical membership and digests for identical inputs", async () => {
    const store = new FakeStore(qualifyingRows());
    const service = new FundedExecutionTrainingService(
      store,
      trainingClient(() => ({
        status: "INSUFFICIENT_DATA",
        artifact: null,
        artifactDigest: null,
        warnings: [],
      })),
    );
    const cutoff = new Date("2026-09-12T00:00:00.000Z");
    const first = await service.materialize(cohort(), cutoff);
    const second = await service.materialize(cohort(), cutoff);
    expect(first.dataset).not.toBeNull();
    expect(second.dataset).not.toBeNull();
    expect(first.dataset!.datasetDigest).toBe(second.dataset!.datasetDigest);
    expect(first.dataset!.membershipDigest).toBe(
      second.dataset!.membershipDigest,
    );
    expect(first.dataset!.activationEligible).toBe(true);
    expect(first.dataset!.qualificationReceipt.counts.includedRowCount).toBe(
      200,
    );
  });

  it("returns a visible unqualified receipt below the floors", async () => {
    const store = new FakeStore(qualifyingRows().slice(0, 199));
    const service = new FundedExecutionTrainingService(
      store,
      trainingClient(() => ({
        status: "INSUFFICIENT_DATA",
        artifact: null,
        artifactDigest: null,
        warnings: [],
      })),
    );
    const result = await service.materialize(
      cohort(),
      new Date("2026-09-12T00:00:00.000Z"),
    );
    expect(result.dataset).toBeNull();
    expect(result.receipt.qualified).toBe(false);
    expect(result.receipt.reasons.join(" ")).toContain(
      "INSUFFICIENT_USABLE_ROWS",
    );
    expect(store.createDatasetCalls).toBe(0);
  });

  it("makes the persisted correction boundary participate in every digest", async () => {
    const withBoundary = (sequence: number, at: string) =>
      replayRows().map((entry, index) =>
        index === 0
          ? {
              ...entry,
              labels: {
                ...entry.labels!,
                knowledge: {
                  provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE" as const,
                  runId: entry.runId,
                  sequence,
                  at,
                },
              },
            }
          : entry,
      );
    const materialize = async (rows: FundedExecutionAssembledRow[]) => {
      const store = new FakeStore(rows);
      const service = new FundedExecutionTrainingService(
        store,
        trainingClient(() => ({
          status: "INSUFFICIENT_DATA",
          artifact: null,
          artifactDigest: null,
          warnings: [],
        })),
      );
      const result = await service.materialize(
        cohort({ sourceKind: "HISTORICAL_REPLAY" }),
        new Date("2026-09-12T00:00:00.000Z"),
      );
      const dataset = result.dataset!;
      const members = await store.listDatasetMembers(dataset.id);
      return { dataset, rowDigest: members[0]!.rowDigest };
    };
    const early = await materialize(
      withBoundary(3, "2026-09-08T17:30:00.000Z"),
    );
    // The later correction boundary still precedes the holdout, so both
    // materializations qualify; only the frozen identity changes.
    const corrected = await materialize(
      withBoundary(9, "2026-09-10T19:00:00.000Z"),
    );
    // The correction's boundary changes the row digest, which changes the
    // membership digest and the frozen dataset identity.
    expect(corrected.rowDigest).not.toBe(early.rowDigest);
    expect(corrected.dataset.membershipDigest).not.toBe(
      early.dataset.membershipDigest,
    );
    expect(corrected.dataset.datasetDigest).not.toBe(
      early.dataset.datasetDigest,
    );
  });

  it("retains replay datasets without live-training eligibility", async () => {
    const store = new FakeStore(replayRows());
    const service = new FundedExecutionTrainingService(
      store,
      trainingClient(() => ({
        status: "INSUFFICIENT_DATA",
        artifact: null,
        artifactDigest: null,
        warnings: [],
      })),
    );
    const result = await service.materialize(
      cohort({ sourceKind: "HISTORICAL_REPLAY" }),
      new Date("2026-09-12T00:00:00.000Z"),
    );
    expect(result.dataset).not.toBeNull();
    expect(result.dataset!.activationEligible).toBe(false);
  });
});

describe("funded execution challenger training", () => {
  async function trainedService() {
    const store = new FakeStore(qualifyingRows());
    const client = trainingClient((request) => {
      const model = artifact(
        request.datasetDigest,
        request.trainingPartitionDigest,
      );
      return {
        status: "COMPLETED",
        artifact: model,
        artifactDigest: fundedExecutionArtifactDigest(model),
        warnings: [],
      };
    });
    const service = new FundedExecutionTrainingService(store, client);
    const materialized = await service.materialize(
      cohort(),
      new Date("2026-09-12T00:00:00.000Z"),
    );
    return { store, service, dataset: materialized.dataset! };
  }

  it("persists an inactive, non-activatable challenger with provenance", async () => {
    const { store, service, dataset } = await trainedService();
    const challenger = await service.train(dataset.id);
    expect(challenger.status).toBe("INACTIVE");
    expect(challenger.eligibleForActivation).toBe(false);
    expect(challenger.active).toBe(false);
    expect(challenger.datasetDigest).toBe(dataset.datasetDigest);
    expect(challenger.artifactDigest).toBe(
      fundedExecutionArtifactDigest(challenger.artifact!),
    );
    expect(challenger.sampleCounts.trainingRows).toBe(100);
    expect(challenger.sampleCounts.testRows).toBe(100);
    expect(store.challengers).toHaveLength(1);
    // Exact retry is idempotent and never persists a second challenger.
    const retry = await service.train(dataset.id);
    expect(retry.id).toBe(challenger.id);
    expect(store.challengers).toHaveLength(1);
  });

  it("persists a visible failed attempt without an artifact", async () => {
    const store = new FakeStore(qualifyingRows());
    const service = new FundedExecutionTrainingService(
      store,
      trainingClient(() => ({
        status: "INSUFFICIENT_DATA",
        artifact: null,
        artifactDigest: null,
        warnings: ["Fill classes are imbalanced."],
      })),
    );
    const dataset = (
      await service.materialize(cohort(), new Date("2026-09-12T00:00:00.000Z"))
    ).dataset!;
    const challenger = await service.train(dataset.id);
    expect(challenger.status).toBe("FAILED");
    expect(challenger.artifact).toBeNull();
    expect(challenger.failureReceipt).toContain("imbalanced");
    expect(challenger.eligibleForActivation).toBe(false);
  });

  it("fails closed on an artifact digest or dataset mismatch", async () => {
    const store = new FakeStore(qualifyingRows());
    const mismatchService = new FundedExecutionTrainingService(
      store,
      trainingClient((request) => {
        const model = artifact(request.datasetDigest, digestA);
        return {
          status: "COMPLETED",
          artifact: model,
          artifactDigest: digestA,
          warnings: [],
        };
      }),
    );
    const dataset = (
      await mismatchService.materialize(
        cohort(),
        new Date("2026-09-12T00:00:00.000Z"),
      )
    ).dataset!;
    await expect(mismatchService.train(dataset.id)).rejects.toThrow(
      "FUNDED_EXECUTION_ARTIFACT_DIGEST_MISMATCH",
    );
  });
});

describe("funded execution scheduler idempotency", () => {
  class FakeEvidence {
    materializeCalls = 0;
    constructor(
      private readonly dataset: FundedExecutionDatasetManifest | null,
      private readonly receipt: FundedExecutionQualificationReceipt | null,
      private readonly challenger: FundedExecutionChallenger | null,
      private readonly summaries: Awaited<
        ReturnType<FundedExecutionTrainingStore["listCohorts"]>
      >,
    ) {}
    async listCohorts() {
      return this.summaries;
    }
    async materialize() {
      this.materializeCalls += 1;
      return {
        receipt: this.receipt ?? ({} as FundedExecutionQualificationReceipt),
        dataset: this.dataset,
      };
    }
    async findChallengerByDatasetDigest() {
      return this.challenger ?? undefined;
    }
  }

  function jobRepository() {
    const created: { jobType: string; key: string | null }[] = [];
    return {
      created,
      repository: {
        async createJob(
          jobType: string,
          _payload: unknown,
          idempotencyKey?: string | null,
        ) {
          const existing = created.find(
            (job) => job.jobType === jobType && job.key === idempotencyKey,
          );
          if (existing)
            return {
              id: randomUUID(),
              jobType,
              status: "QUEUED",
            } as unknown as ResearchJob;
          created.push({ jobType, key: idempotencyKey ?? null });
          return {
            id: randomUUID(),
            jobType,
            status: "QUEUED",
          } as unknown as ResearchJob;
        },
      },
    };
  }

  const summary = {
    cohort: cohort(),
    sourceKind: "LIVE_PAPER" as const,
    decisionCount: 200,
    completedLiveCount: 200,
    firstDecisionAt: "2026-09-08T14:00:00.000Z",
    lastDecisionAt: "2026-09-11T15:00:00.000Z",
  };

  function dataset(): FundedExecutionDatasetManifest {
    return fundedExecutionDatasetManifestSchema.parse({
      id: randomUUID(),
      marketId: "CA_TSX",
      currency: "CAD",
      cohort: cohort(),
      sourceKind: "LIVE_PAPER",
      requestedCutoff: "2026-09-12T00:00:00.000Z",
      effectiveCutoff: "2026-09-11T18:00:00.000Z",
      datasetPolicyVersion: "funded-execution-dataset-v1",
      labelMappingVersion: "funded-execution-labels-v1",
      featureVersion: "funded-execution-features-v1",
      qualificationPolicyVersion: "funded-execution-qualification-v1",
      membershipDigest: digestA,
      datasetDigest: digestB,
      qualificationReceipt: {
        policyVersion: "funded-execution-qualification-v1",
        qualified: true,
        reasons: [],
        minimumRows: 200,
        minimumNewRows: 50,
        newOutcomesSincePrior: 200,
        priorDatasetId: null,
        priorDatasetRowCount: null,
        liveRunRequired: true,
        distinctSessionCount: 4,
        chronologicalSplitAt: "2026-09-11T14:10:00.000Z",
        trainFillPositives: 50,
        trainFillNegatives: 50,
        testFillPositives: 50,
        testFillNegatives: 50,
        trainCostLabelCount: 100,
        testCostLabelCount: 100,
        counts: {
          sourceRowCount: 200,
          usableRowCount: 200,
          includedRowCount: 200,
          trainRowCount: 100,
          testRowCount: 100,
          excludedCounts: {},
          unknownCounts: {},
        },
      },
      sourceWatermark: {
        latestDecisionAt: "2026-09-11T15:00:00.000Z",
        latestLabelAvailableAt: "2026-09-11T18:00:00.000Z",
        latestEconomicOutcomeAt: "2026-09-11T17:30:00.000Z",
        decisionCount: 200,
        outcomeVersionCount: 200,
      },
      activationEligible: true,
      createdAt: "2026-09-16T20:00:00.000Z",
    });
  }

  it("enqueues exactly one job per frozen dataset digest", async () => {
    const datasetValue = dataset();
    const evidence = new FakeEvidence(datasetValue, null, null, [summary]);
    const { created, repository } = jobRepository();
    const scheduler = new FundedExecutionTrainingScheduler(
      evidence,
      repository as never,
      () => new Date("2026-09-16T21:00:00.000Z"),
    );
    const first = await scheduler.run();
    expect(first.queued).toBe(1);
    expect(created).toEqual([
      {
        jobType: "FUNDED_EXECUTION_TRAINING",
        key: `funded-execution:${datasetValue.datasetDigest}`,
      },
    ]);
    // A restart with an existing challenger enqueues nothing.
    const withChallenger = new FakeEvidence(
      datasetValue,
      null,
      {
        ...(artifactChallenger(datasetValue) as FundedExecutionChallenger),
      },
      [summary],
    );
    const second = await new FundedExecutionTrainingScheduler(
      withChallenger,
      repository as never,
    ).run();
    expect(second.queued).toBe(0);
    expect(second.examined[0]?.status).toBe("CHALLENGER_INACTIVE");
  });

  it("never enqueues below the qualification floors", async () => {
    const evidence = new FakeEvidence(
      null,
      {
        policyVersion: "funded-execution-qualification-v1",
        qualified: false,
        reasons: ["INSUFFICIENT_USABLE_ROWS (12 < 200)"],
        minimumRows: 200,
        minimumNewRows: 50,
        newOutcomesSincePrior: 12,
        priorDatasetId: null,
        priorDatasetRowCount: null,
        liveRunRequired: true,
        distinctSessionCount: 1,
        chronologicalSplitAt: null,
        trainFillPositives: 6,
        trainFillNegatives: 6,
        testFillPositives: 0,
        testFillNegatives: 0,
        trainCostLabelCount: 6,
        testCostLabelCount: 0,
        counts: {
          sourceRowCount: 12,
          usableRowCount: 12,
          includedRowCount: 0,
          trainRowCount: 0,
          testRowCount: 0,
          excludedCounts: {},
          unknownCounts: {},
        },
      },
      null,
      [summary],
    );
    const { created, repository } = jobRepository();
    const result = await new FundedExecutionTrainingScheduler(
      evidence,
      repository as never,
    ).run();
    expect(result.queued).toBe(0);
    expect(result.examined[0]?.reason).toContain("INSUFFICIENT_USABLE_ROWS");
    expect(created).toEqual([]);
  });

  it("skips historical-replay cohorts entirely", async () => {
    const evidence = new FakeEvidence(dataset(), null, null, [
      {
        ...summary,
        cohort: cohort({ sourceKind: "HISTORICAL_REPLAY" }),
        sourceKind: "HISTORICAL_REPLAY",
        completedLiveCount: 0,
      },
    ]);
    const { created, repository } = jobRepository();
    const result = await new FundedExecutionTrainingScheduler(
      evidence,
      repository as never,
    ).run();
    expect(result.queued).toBe(0);
    expect(evidence.materializeCalls).toBe(0);
    expect(created).toEqual([]);
  });
});

function artifactChallenger(
  dataset: FundedExecutionDatasetManifest,
): FundedExecutionChallenger {
  return {
    id: randomUUID(),
    marketId: dataset.marketId,
    currency: dataset.currency,
    cohort: dataset.cohort,
    datasetId: dataset.id,
    datasetDigest: dataset.datasetDigest,
    modelVersion: "funded-execution-v1",
    modelType: "FUNDED_EXECUTION_QUALITY",
    artifactDigest: digestA,
    featureVersion: "funded-execution-features-v1",
    labelMappingVersion: "funded-execution-labels-v1",
    qualificationPolicyVersion: "funded-execution-qualification-v1",
    trainingPolicyVersion: "funded-execution-training-v1",
    trainingCodeVersion: "funded-execution-trainer-v1",
    runtimeFingerprint: null,
    status: "INACTIVE",
    eligibleForActivation: false,
    active: false,
    artifact: null,
    metrics: null,
    sampleCounts: {},
    failureReceipt: null,
    createdAt: "2026-09-16T20:05:00.000Z",
  };
}
