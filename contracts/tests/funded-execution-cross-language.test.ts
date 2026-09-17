import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fundedExecutionTrainingRequestSchema,
  fundedExecutionTrainingResultSchema,
  FUNDED_EXECUTION_FEATURE_NAMES,
  FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
  FUNDED_EXECUTION_FEATURE_VERSION,
  type FundedExecutionTrainingRequest,
} from "../src/domains/funded-execution-training.js";

/**
 * Cross-language fixture boundary (FP02).
 *
 * `funded_execution_request.json` is the TypeScript-frozen request that the
 * Python trainer parses; `funded_execution_result.json` is the Python trainer's
 * output for it. This test proves the committed request is the TypeScript
 * contract object (not hand-edited) and that the Python result parses back
 * through the shared TypeScript contract. The API digest test separately
 * recomputes the artifact digest.
 */

const fixtures = fileURLToPath(
  new URL("../../services/scanner/tests/fixtures/", import.meta.url),
);

function features(
  index: number,
  missing: boolean,
): Record<string, number | null> {
  const values: Record<string, number | null> = {
    deterministicScore: 60 + index * 3,
    spreadPct: 0.1 + (index % 4) * 0.02,
    logDisplayedSize: 5 + (index % 3),
    logRequestedNotional: 7.3,
    logRequestedRisk: 5.5,
    quoteAgeSeconds: 1 + (index % 3),
    minutesFromOpen: 5 + index * 2,
    atrPct: 0.01 + (index % 5) * 0.003,
    stopDistancePct: 0.02,
    targetDistancePct: 0.05,
    logCash: 9.2,
    logOpenRisk: 0.5,
    logReservedRisk: 0.2,
    positionCount: index % 3,
    participation: 0.25,
    contextStrength: 2,
  };
  if (missing) {
    values.atrPct = null;
    values.contextStrength = null;
  }
  return values;
}

function row(index: number, partition: "TRAIN" | "TEST") {
  const filled = index % 2 === 0;
  const cost = filled && index % 3 !== 0;
  const start = Date.UTC(2026, 8, 8, 14, 30) + index * 60_000;
  return {
    marketId: "CA_TSX" as const,
    currency: "CAD" as const,
    runId: "00000000-0000-4000-8000-0000000000aa",
    observationId: `${partition.toLowerCase()}-${String(index).padStart(3, "0")}`,
    decisionSequence: index + 1,
    decisionContentDigest: "a".repeat(64),
    decisionAt: new Date(start).toISOString(),
    sessionDate: partition === "TRAIN" ? "2026-09-08" : "2026-09-15",
    partition,
    features: features(index, index % 4 === 0),
    labels: {
      fillProbability: filled ? 1 : 0,
      fillFraction: filled ? 1 : 0,
      slippagePerShare: cost ? 0.01 : null,
      totalExecutionCost: cost ? 1.5 : null,
      labelAvailableAt:
        partition === "TRAIN"
          ? "2026-09-08T18:00:00.000Z"
          : "2026-09-15T18:00:00.000Z",
      knowledge: {
        provenance: "DATABASE_CAPTURE" as const,
        runId: null,
        sequence: null,
        at:
          partition === "TRAIN"
            ? "2026-09-08T18:00:00.000Z"
            : "2026-09-15T18:00:00.000Z",
      },
      economicOutcomeAt:
        partition === "TRAIN"
          ? "2026-09-08T17:30:00.000Z"
          : "2026-09-15T17:30:00.000Z",
      terminalityProof: null,
      terminalOutcomeStatus: filled ? "FILLED" : "NO_FILL",
      terminalOutcomeSequence: 2,
      terminalOutcomeSourceDigest: "b".repeat(64),
      fillLabelAvailable: true,
      costLabelAvailable: cost,
    },
    rowDigest: "c".repeat(64),
  };
}

export function crossLanguageRequest(): FundedExecutionTrainingRequest {
  return fundedExecutionTrainingRequestSchema.parse({
    requestVersion: "funded-execution-training-v1",
    marketId: "CA_TSX",
    currency: "CAD",
    cohortDigest: "d".repeat(64),
    datasetDigest: "e".repeat(64),
    membershipDigest: "f".repeat(64),
    trainingPartitionDigest: "1".repeat(64),
    featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
    labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
    featureNames: [...FUNDED_EXECUTION_FEATURE_NAMES],
    sourceKind: "LIVE_PAPER",
    rows: [
      ...Array.from({ length: 6 }, (_, index) => row(index, "TRAIN")),
      ...Array.from({ length: 6 }, (_, index) => row(index, "TEST")),
    ],
  });
}

describe("funded execution cross-language fixtures", () => {
  it("keeps the committed request exactly as TypeScript generated it", () => {
    const committed = JSON.parse(
      readFileSync(`${fixtures}funded_execution_request.json`, "utf8"),
    ) as unknown;
    expect(committed).toEqual(crossLanguageRequest());
    expect(fundedExecutionTrainingRequestSchema.parse(committed)).toEqual(
      crossLanguageRequest(),
    );
  });

  it("parses the Python training result through the shared contract", () => {
    const result = fundedExecutionTrainingResultSchema.parse(
      JSON.parse(
        readFileSync(`${fixtures}funded_execution_result.json`, "utf8"),
      ) as unknown,
    );
    expect(result.status).toBe("COMPLETED");
    expect(result.artifact).not.toBeNull();
    expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.artifact!.featureNames).toEqual([
      ...FUNDED_EXECUTION_FEATURE_NAMES,
    ]);
    expect(result.artifact!.sourceDatasetDigest).toBe("e".repeat(64));
    expect(result.artifact!.trainingPartitionDigest).toBe("1".repeat(64));
  });
});
