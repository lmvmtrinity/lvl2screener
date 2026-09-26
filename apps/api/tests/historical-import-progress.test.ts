import { describe, expect, it } from "vitest";
import {
  createImportProgress,
  readImportProgress,
} from "../src/historical-archive/import-progress.js";
describe("import progress", () => {
  it("counts completed and failed chunks and detects a dead process", async () => {
    const run = createImportProgress("Bars", "2025-01-01", "2025-12-31");
    run.event({
      event: "plan",
      plannedChunks: 3,
      skippedCoveredChunks: 2,
      estimatedCostUsd: 0,
    });
    run.event({
      event: "imported",
      inserted: 10,
      symbol: "COIN",
      schema: "aggs-1m",
      from: "2025-01-01",
      to: "2025-01-31",
    });
    run.event({ event: "failed" });
    run.state.pid = 2147483647;
    run.save();
    const state = (await readImportProgress()).find(
      (task) => task.id === run.state.id,
    )!;
    expect(state).toMatchObject({
      status: "Stopped",
      planned: 3,
      completed: 1,
      failed: 1,
      rows: 10,
      skipped: 2,
    });
    run.state.status = "Completed";
    run.save();
    expect(
      (await readImportProgress()).find((task) => task.id === run.state.id)
        ?.status,
    ).toBe("Completed");
  });
});
