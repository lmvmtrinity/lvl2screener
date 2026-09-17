import { describe, expect, it } from "vitest";
import { reconcileOrphanedResearch } from "../src/database/reconcile-orphaned-research.js";

describe("reconcileOrphanedResearch", () => {
  it("converts orphaned RUNNING/TRAINING research rows to INTERRUPTED on restart", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const rowCounts: Record<string, number> = {
      backtest_run: 2,
      calibration_run: 1,
      statistical_model: 1,
      ranking_research_run: 0,
    };
    const pool = {
      query: async (text: string, params: unknown[]) => {
        calls.push({ text, params });
        const table = /UPDATE (\w+)/.exec(text)?.[1] ?? "";
        return { rowCount: rowCounts[table] ?? 0 };
      },
    };

    const results = await reconcileOrphanedResearch(pool as never);

    expect(results).toEqual([
      { table: "backtest_run", interruptedCount: 2 },
      { table: "calibration_run", interruptedCount: 1 },
      { table: "statistical_model", interruptedCount: 1 },
      { table: "ranking_research_run", interruptedCount: 0 },
    ]);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.text).toContain("SET status = 'INTERRUPTED'");
    expect(calls[0]?.params).toEqual([["RUNNING"]]);
    expect(calls[2]?.params).toEqual([["TRAINING"]]);
  });
});
