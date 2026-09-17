import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fundedExecutionTrainingRequestSchema,
  fundedExecutionTrainingResultSchema,
} from "@tsx-scanner/contracts";
import { fundedExecutionArtifactDigest } from "../src/statistical-models/funded-execution-digest.js";

/**
 * Cross-language fixture boundary (FP02): the TypeScript-generated request
 * parses in Python (proven by the scanner pytest suite, which reproduces the
 * committed Python result from it), and the Python artifact/result parses back
 * through the shared TypeScript contract with a digest that the TypeScript
 * canonical serializer reproduces byte for byte.
 */

const fixtures = fileURLToPath(
  new URL("../../../services/scanner/tests/fixtures/", import.meta.url),
);

describe("funded execution TypeScript/Python fixture boundary", () => {
  it("parses the committed request and Python result through the contracts", () => {
    const request = fundedExecutionTrainingRequestSchema.parse(
      JSON.parse(
        readFileSync(`${fixtures}funded_execution_request.json`, "utf8"),
      ) as unknown,
    );
    const result = fundedExecutionTrainingResultSchema.parse(
      JSON.parse(
        readFileSync(`${fixtures}funded_execution_result.json`, "utf8"),
      ) as unknown,
    );
    expect(request.marketId).toBe("CA_TSX");
    expect(result.status).toBe("COMPLETED");
    expect(result.artifact).not.toBeNull();
    expect(result.artifactDigest).not.toBeNull();
  });

  it("reproduces the Python artifact digest with the TypeScript serializer", () => {
    const result = fundedExecutionTrainingResultSchema.parse(
      JSON.parse(
        readFileSync(`${fixtures}funded_execution_result.json`, "utf8"),
      ) as unknown,
    );
    expect(result.artifact).not.toBeNull();
    expect(fundedExecutionArtifactDigest(result.artifact!)).toBe(
      result.artifactDigest,
    );
  });
});
