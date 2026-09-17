import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  freezeResearchManifest,
  researchPlanSchema,
} from "../src/backtests/research-manifest.js";

const plan = {
  version: "research-plan-v1",
  experimentId: "fixture",
  revision: "a".repeat(40),
  marketId: "CA_TSX",
  currency: "CAD",
  profileId: "baseline",
  configVersion: "v1",
  featureVersion: "v1",
  strategyVersion: "v1",
  scoreVersion: "v1",
  executionAssumptions: "fixture only",
  qualificationPolicy: "unchanged ADR-011",
  comparison: "baseline versus contraction",
  searchBudget: 2,
  minimumTradesPerSegment: 200,
  maximumDrawdownR: 5,
  minimumImprovementR: 0.1,
  uncertaintyMethod: "session blocks",
  overlapPurgeRule: "exclude labels crossing segment boundaries",
  splits: {
    TRAIN: { start: "2026-01-01", end: "2026-01-01" },
    VALIDATION: { start: "2026-02-02", end: "2026-02-02" },
    TEST: { start: "2026-03-02", end: "2026-03-02" },
  },
  expectedSessions: ["2026-01-01", "2026-02-02", "2026-03-02"],
  inputs: [
    {
      path: "input.json",
      marketId: "CA_TSX",
      sessions: ["2026-01-01"],
      role: "CANDIDATES",
    },
  ],
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("offline research manifest", () => {
  it("hashes actual bytes, preserves gaps, refuses overwrite, and detects changed input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "research-manifest-"));
    temporary.push(dir);
    const input = join(dir, "input.json");
    const source = join(dir, "plan.json");
    const output = join(dir, "manifest.json");
    await writeFile(input, "[]");
    await writeFile(source, JSON.stringify(plan));
    const first = await freezeResearchManifest(source, output);
    expect(first.coverage.missingCandidateSessions).toEqual([
      "2026-02-02",
      "2026-03-02",
    ]);
    expect(first.coverage.inputContentsValidated).toBe(false);
    await expect(freezeResearchManifest(source, output)).rejects.toThrow();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(first);
    expect(
      await freezeResearchManifest(source, join(dir, "same.json")),
    ).toEqual(first);
    await writeFile(input, "[1]");
    const changed = await freezeResearchManifest(
      source,
      join(dir, "changed.json"),
    );
    expect(changed.sha256).not.toBe(first.sha256);
    expect(changed.inputs[0]!.sha256).not.toBe(first.inputs[0]!.sha256);
  });
  it.each([
    { currency: "USD" },
    { inputs: [{ ...plan.inputs[0], marketId: "US_EQUITIES" }] },
    { expectedSessions: [...plan.expectedSessions].reverse() },
    { splits: { ...plan.splits, TEST: plan.splits.TRAIN } },
    { inputs: [{ ...plan.inputs[0], sessions: ["2027-01-01"] }] },
    { searchBudget: 0 },
    { revision: "main" },
  ])("rejects invalid ownership or study boundaries: %j", (change) => {
    expect(researchPlanSchema.safeParse({ ...plan, ...change }).success).toBe(
      false,
    );
  });
  it("accepts separate US/USD studies", () => {
    expect(
      researchPlanSchema.safeParse({
        ...plan,
        marketId: "US_EQUITIES",
        currency: "USD",
        inputs: [{ ...plan.inputs[0], marketId: "US_EQUITIES" }],
      }).success,
    ).toBe(true);
  });
});
