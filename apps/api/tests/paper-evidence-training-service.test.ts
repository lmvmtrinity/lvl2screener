import { describe, expect, it, vi } from "vitest";
import type {
  PaperEvidenceCohort,
  PaperEvidenceTrainingRow,
  StatisticalTrainingDataset,
} from "@tsx-scanner/contracts";
import {
  PAPER_EVIDENCE_POLICY_VERSION,
  PaperEvidenceTrainingService,
} from "../src/statistical-models/paper-evidence-training-service.js";
import type { PaperEvidenceTrainingStore } from "../src/statistical-models/paper-evidence-training-repository.js";

const cohort: PaperEvidenceCohort = {
  marketId: "CA_TSX",
  strategy: "ORB_RETEST",
  strategyVersion: "v1",
  profileConfigId: "10000000-0000-4000-8000-000000000001",
  configVersion: "config-v1",
  executionModelVersion: "paper-execution-v1",
  assumptions: { positionSize: 100 },
  closedQuoteCount: 2,
  positives: 1,
  negatives: 1,
  firstSignalAt: "2026-08-03T14:00:00.000Z",
  lastSignalAt: "2026-08-04T14:00:00.000Z",
  missingFeatureCount: 0,
  signalSemanticsVersion: "setup-semantics-v2",
  replayScope: "FORWARD_LIVE",
};
const rows: PaperEvidenceTrainingRow[] = [
  {
    marketId: "CA_TSX",
    sourceKey: "paper_execution:10000000-0000-4000-8000-000000000010",
    executionId: "10000000-0000-4000-8000-000000000010",
    observationId: "10000000-0000-4000-8000-000000000020",
    instrumentId: "10000000-0000-4000-8000-000000000099",
    signalTimestamp: "2026-08-03T14:00:00.000Z",
    labelAvailableAt: "2026-08-03T14:15:00.000Z",
    deterministicScore: 80,
    atrPct: 1.2,
    rvolAtTime: 2.1,
    rMultiple: 1,
  },
  {
    marketId: "CA_TSX",
    sourceKey: "paper_execution:10000000-0000-4000-8000-000000000011",
    executionId: "10000000-0000-4000-8000-000000000011",
    observationId: "10000000-0000-4000-8000-000000000021",
    instrumentId: "10000000-0000-4000-8000-000000000099",
    signalTimestamp: "2026-08-04T14:00:00.000Z",
    labelAvailableAt: "2026-08-04T14:15:00.000Z",
    deterministicScore: 75,
    atrPct: 1.1,
    rvolAtTime: 1.8,
    rMultiple: -1,
  },
];

class Store implements PaperEvidenceTrainingStore {
  async countDatasets() {
    return 0;
  }
  lastInput?: Parameters<PaperEvidenceTrainingStore["createDataset"]>[0];
  async listCohorts(): Promise<PaperEvidenceCohort[]> {
    return [cohort];
  }
  async rowsFor(): Promise<PaperEvidenceTrainingRow[]> {
    return rows;
  }
  async createDataset(
    input: Parameters<PaperEvidenceTrainingStore["createDataset"]>[0],
  ): Promise<StatisticalTrainingDataset> {
    this.lastInput = input;
    return {
      id: "10000000-0000-4000-8000-000000000030",
      sourceKind: "PAPER_EVIDENCE",
      marketId: input.cohort.marketId,
      policyVersion: input.policyVersion,
      cohort: input.cohort,
      requestedCutoff: input.requestedCutoff.toISOString(),
      effectiveCutoff: input.effectiveCutoff.toISOString(),
      sourceDigest: input.sourceDigest,
      sourceRowCount: input.rows.length,
      excludedCounts: input.excludedCounts,
      createdAt: "2026-08-05T00:00:00.000Z",
    };
  }
  async getDataset(): Promise<StatisticalTrainingDataset | undefined> {
    return undefined;
  }
  async latestDatasetFor(): Promise<StatisticalTrainingDataset | undefined> {
    return undefined;
  }
  async listDatasetRows(): Promise<PaperEvidenceTrainingRow[]> {
    return rows;
  }
}

describe("PaperEvidenceTrainingService", () => {
  it("freezes an ordered closed-quote membership with a stable digest", async () => {
    const store = new Store();
    const service = new PaperEvidenceTrainingService(store);
    const cutoff = new Date("2026-08-10T00:00:00.000Z");
    const first = await service.materialize(cohort, cutoff);
    const second = await service.materialize(cohort, cutoff);
    expect(first.policyVersion).toBe(PAPER_EVIDENCE_POLICY_VERSION);
    expect(first.sourceDigest).toBe(second.sourceDigest);
    expect(store.lastInput?.rows).toEqual(rows);
    expect(store.lastInput?.researchDerivation).toBeNull();
    expect(store.lastInput?.effectiveCutoff.toISOString()).toBe(
      "2026-08-04T14:00:00.000Z",
    );
  });

  it("persists the manifest-defined derivation returned by the lineage resolver", async () => {
    const store = new Store();
    const derivation = {
      version: "dataset-derivation-v1" as const,
      complete: true,
      featureVersion: "1.2.0",
      engineRevision: "e".repeat(40),
      runtimeFingerprint: "f".repeat(64),
      sourceDigest: "d".repeat(64),
      rowsDigest: "a".repeat(64),
      rowCount: rows.length,
      sessionPayloadHashes: {
        "2026-08-03": "b".repeat(64),
        "2026-08-04": "c".repeat(64),
      },
      coverageManifestHash: "1".repeat(64),
      coverageReportHash: "2".repeat(64),
      reasons: [],
      capturedAt: "2026-08-05T00:00:00.000Z",
    };
    const binding = {
      manifestHash: "1".repeat(64),
      coverageReportHash: "2".repeat(64),
      inputHash: "3".repeat(64),
      engineRevision: "e".repeat(40),
      runtimeFingerprint: "f".repeat(64),
      verifiedAt: "2026-08-05T00:00:00.000Z",
    };
    const service = new PaperEvidenceTrainingService(store, {
      resolve: async () => binding,
      resolveArtifact: async () => ({ binding, derivation }),
    } as never);

    await service.materialize(cohort, new Date("2026-08-10T00:00:00.000Z"));

    expect(store.lastInput?.researchDerivation).toEqual(derivation);
    expect(store.lastInput?.researchEvidence).toEqual(binding);
  });

  it("resumes one frozen preparation and leaves no dataset while coverage is pending", async () => {
    const store = new Store();
    let pending: any;
    let verified = false;
    const preparationStore = {
      create: vi.fn(async (input: any) => {
        pending = {
          id: "10000000-0000-4000-8000-000000000040",
          marketId: input.marketId,
          cohort: input.cohort,
          requestedCutoff: input.requestedCutoff.toISOString(),
          effectiveCutoff: input.effectiveCutoff.toISOString(),
          sourceDigest: input.sourceDigest,
          excludedCounts: input.excludedCounts,
          researchQualification: input.researchQualification,
          rows: input.rows,
          createdAt: "2026-08-05T00:00:00.000Z",
        };
        return pending;
      }),
      findPending: vi.fn(async () => pending),
    };
    const lineage = {
      resolveArtifact: vi.fn(async () =>
        verified
          ? {
              binding: {
                manifestHash: "1".repeat(64),
                coverageReportHash: "2".repeat(64),
                inputHash: "3".repeat(64),
                engineRevision: "e".repeat(40),
                runtimeFingerprint: "f".repeat(64),
                verifiedAt: "2026-08-05T00:00:00.000Z",
              },
              derivation: {
                version: "dataset-derivation-v1" as const,
                complete: true,
                featureVersion: "1.2.0",
                engineRevision: "e".repeat(40),
                runtimeFingerprint: "f".repeat(64),
                sourceDigest: pending.sourceDigest,
                rowsDigest: "a".repeat(64),
                rowCount: rows.length,
                sessionPayloadHashes: { "2026-08-03": "b".repeat(64) },
                coverageManifestHash: "1".repeat(64),
                coverageReportHash: "2".repeat(64),
                reasons: [],
                capturedAt: "2026-08-05T00:00:00.000Z",
              },
            }
          : {
              derivation: {
                version: "dataset-derivation-v1" as const,
                complete: false,
                featureVersion: null,
                engineRevision: null,
                runtimeFingerprint: null,
                sourceDigest: pending.sourceDigest,
                rowsDigest: "a".repeat(64),
                rowCount: rows.length,
                sessionPayloadHashes: null,
                coverageManifestHash: null,
                coverageReportHash: null,
                reasons: ["COVERAGE_REPORT_UNVERIFIED"],
                capturedAt: "2026-08-05T00:00:00.000Z",
              },
            },
      ),
    };
    const qualification = {
      qualification: {
        policyVersion: "paper-research-qualification-v2",
        qualified: true,
        reasons: [],
        sourceRowCount: rows.length,
        acceptedRowCount: rows.length,
        distinctSessionCount: 2,
        chronologicalSplitAt: rows[1]!.signalTimestamp,
        walkForwardWindows: [],
        excludedCounts: {},
      },
      acceptedRows: rows,
      qualifiedRows: rows,
    };
    const service = new PaperEvidenceTrainingService(
      store,
      lineage as never,
      preparationStore as never,
    );
    const first = await service.prepareAndMaterialize(
      cohort,
      new Date("2026-08-10T00:00:00.000Z"),
      qualification,
    );
    expect(first).toEqual({ dataset: undefined, pending: true });
    expect(store.lastInput).toBeUndefined();
    verified = true;
    const second = await service.prepareAndMaterialize(
      { ...cohort, closedQuoteCount: 99 },
      new Date("2026-08-11T00:00:00.000Z"),
      qualification,
    );
    expect(second.dataset).toBeDefined();
    expect(preparationStore.create).toHaveBeenCalledOnce();
    expect(store.lastInput?.requestedCutoff.toISOString()).toBe(
      "2026-08-10T00:00:00.000Z",
    );
    expect(store.lastInput?.sourceDigest).toBe(pending.sourceDigest);
    expect(store.lastInput?.rows).toEqual(rows);
  });

  it("rejects evidence that would mix markets in one frozen dataset", async () => {
    const store = new Store();
    store.rowsFor = async () => [{ ...rows[0]!, marketId: "US_EQUITIES" }];
    const service = new PaperEvidenceTrainingService(store);
    await expect(
      service.materialize({ ...cohort, marketId: "CA_TSX" }, new Date()),
    ).rejects.toThrow("match the cohort market");
  });

  it("materializes only the qualified partition after purging some long labels", async () => {
    const store = new Store();
    const sample = Array.from({ length: 220 }, (_, index) => {
      const signal = new Date(
        Date.UTC(2026, 7, 3 + Math.floor(index / 55), 14, index % 55),
      );
      return {
        ...rows[0]!,
        sourceKey: `row-${index}`,
        instrumentId: `instrument-${index}`,
        signalTimestamp: signal.toISOString(),
        labelAvailableAt:
          index < 5
            ? "2026-08-06T20:00:00.000Z"
            : new Date(signal.getTime() + 30_000).toISOString(),
        rMultiple: index % 4 === 0 ? -1 : 1,
      };
    });
    store.rowsFor = async () => sample;
    await new PaperEvidenceTrainingService(store).materialize(
      cohort,
      new Date("2026-08-07T00:00:00Z"),
    );
    const frozen = store.lastInput!;
    expect(frozen.researchQualification.qualified).toBe(true);
    expect(frozen.rows).toHaveLength(215);
    expect(frozen.researchQualification.acceptedRowCount).toBe(215);
    expect(frozen.excludedCounts.LABEL_AFTER_CHRONOLOGICAL_BOUNDARY).toBe(5);
    expect(frozen.rows.map((row) => row.sourceKey)).toEqual([
      ...frozen.researchQualification.chronologicalTrainSourceKeys!,
      ...frozen.researchQualification.chronologicalTestSourceKeys!,
    ]);
  });
});
