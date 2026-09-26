import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandLiveEngineResultBatch } from "../src/domains/engine.js";

const compact = JSON.parse(
  readFileSync(
    new URL("../fixtures/engine-result-batch.json", import.meta.url),
    "utf8",
  ),
);

describe("live scanner response", () => {
  it("restores feature snapshots and preserves full state-event payloads", () => {
    const expanded = expandLiveEngineResultBatch(compact);
    expect(compact.evaluations[0].featureSnapshot).toBeUndefined();
    expect(expanded.evaluations[0].featureSnapshot).toBeDefined();
    expect(expanded.events).toEqual(compact.events);
    expect(() =>
      expandLiveEngineResultBatch({ ...compact, snapshots: [] }),
    ).toThrow(/Missing live feature snapshot/);
  });
});
