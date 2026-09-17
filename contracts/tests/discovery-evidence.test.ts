import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
} from "../src/domains/discovery-evidence.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/discovery-evaluation-v1.json", import.meta.url),
    "utf8",
  ),
);
describe("discovery Python/TypeScript boundary", () => {
  it.each(fixtures)(
    "accepts the Python fixture for $input.marketId",
    ({ input, result }) => {
      expect(discoveryEvaluationInputSchema.parse(input)).toEqual(input);
      expect(discoveryEvaluationResultSchema.parse(result)).toEqual(result);
    },
  );
  it("rejects incomplete, future and expired passing evidence", () => {
    const { result } = fixtures[0];
    for (const changed of [
      {
        ...result,
        metrics: { ...result.metrics, atr14: { value: null, asOf: null } },
      },
      { ...result, computedAt: "2026-11-03T14:43:00Z" },
      {
        ...result,
        metrics: {
          ...result.metrics,
          price: { value: 50, asOf: "2026-11-03T15:00:00Z" },
        },
      },
      { ...result, policyVersion: "us-discovery-v1" },
    ])
      expect(discoveryEvaluationResultSchema.safeParse(changed).success).toBe(
        false,
      );
  });
});
