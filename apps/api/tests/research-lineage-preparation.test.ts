import {
  ResearchLineageService,
  stableArtifactScope,
} from "../src/backtests/research-lineage-service.js";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PaperEvidenceTrainingService } from "../src/statistical-models/paper-evidence-training-service.js";
import type { PaperEvidenceTrainingStore } from "../src/statistical-models/paper-evidence-training-repository.js";
import type { PaperEvidenceCohort } from "@tsx-scanner/contracts";

describe("automatic artifact coverage preparation", () => {
  it("keeps request identity stable across replay resolution clocks", () => {
    const input = {
      kind: "BACKTEST" as const,
      marketId: "CA_TSX" as const,
      scope: {
        replayInput: {
          resolvedAt: "first",
          inputHash: "first-audit-hash",
          capturedHistoryAvailability: {
            observedAt: "first",
            tables: { quoteSnapshot: { latest: "2026-09-09T20:00:00Z" } },
          },
          candidateInstruments: ["A"],
        },
      },
      sessionDates: ["2026-09-09"],
      inputCutoff: "2026-09-10T00:00:00.000Z",
    };
    expect(stableArtifactScope(input)).toEqual(
      stableArtifactScope({
        ...input,
        scope: {
          replayInput: {
            ...input.scope.replayInput,
            resolvedAt: "second",
            inputHash: "second-audit-hash",
            capturedHistoryAvailability: {
              ...input.scope.replayInput.capturedHistoryAvailability,
              observedAt: "second",
            },
          },
        },
      }),
    );
    expect(stableArtifactScope(input)).not.toEqual(
      stableArtifactScope({
        ...input,
        scope: {
          replayInput: {
            ...input.scope.replayInput,
            candidateInstruments: ["B"],
          },
        },
      }),
    );
  });
  it("leaves baseline execution available when optional coverage storage fails", async () => {
    const pool = {
      connect: async () => {
        throw new Error("unavailable");
      },
    } as unknown as Pool;
    const lineage = new ResearchLineageService(
      pool,
      { current: async () => null },
      {} as never,
    );
    await expect(
      lineage.resolve({
        kind: "DATASET",
        marketId: "CA_TSX",
        scope: {},
        sessionDates: [],
        inputCutoff: "2026-09-10T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves lineage for the exact qualified row snapshot before persisting a dataset", async () => {
    const binding = {
      manifestHash: "a".repeat(64),
      coverageReportHash: "b".repeat(64),
      inputHash: "c".repeat(64),
      engineRevision: "d".repeat(40),
      runtimeFingerprint: "e".repeat(64),
      verifiedAt: "2026-09-10T00:00:00.000Z",
    };
    const resolve = vi.fn(async (_input: unknown) => binding);
    const createDataset = vi.fn(
      async (
        input: Parameters<PaperEvidenceTrainingStore["createDataset"]>[0],
      ) => input,
    );
    const store = {
      rowsFor: async () => [],
      createDataset,
    } as unknown as PaperEvidenceTrainingStore;
    const cohort = {
      marketId: "CA_TSX",
      strategy: "ORB_RETEST",
      strategyVersion: "1.0.0",
      profileConfigId: "00000000-0000-4000-8000-000000000001",
      configVersion: "fixture",
      executionModelVersion: "paper-execution-v7",
      assumptions: {},
      closedQuoteCount: 0,
      positives: 0,
      negatives: 0,
      missingFeatureCount: 0,
      firstSignalAt: null,
      lastSignalAt: null,
      signalSemanticsVersion: "fixture",
      replayScope: "LIVE",
    } as unknown as PaperEvidenceCohort;
    await new PaperEvidenceTrainingService(store, { resolve }).materialize(
      cohort,
      new Date("2026-09-10T00:00:00.000Z"),
    );
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({
      kind: "DATASET",
      marketId: "CA_TSX",
      scope: { cohort, rows: [] },
    });
    expect(createDataset.mock.calls[0]?.[0].researchEvidence).toEqual(binding);
  });
});
