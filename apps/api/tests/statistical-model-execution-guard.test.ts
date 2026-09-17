import { describe, expect, it, vi } from "vitest";
import type { BacktestRun } from "@tsx-scanner/contracts";
import { StatisticalModelService } from "../src/statistical-models/statistical-model-service.js";

const source = {
  id: "10000000-0000-4000-8000-000000000080",
  status: "COMPLETED",
  dataQuality: { spread: "CAPTURED" },
  strategies: ["ORB_RETEST"],
  executionModelVersion: "legacy-python-v1",
} as BacktestRun;

describe("StatisticalModelService execution provenance guard", () => {
  it("refuses training from a non-authoritative backtest before creating an artifact", async () => {
    const create = vi.fn();
    const service = new StatisticalModelService(
      { create } as never,
      { get: async () => source } as never,
      {} as never,
    );

    await expect(
      service.create({
        name: "legacy model",
        backtestRunId: source.id,
        strategy: "ORB_RETEST",
        trainPct: 70,
        minimumSamples: 200,
        l2Penalty: 1,
      }),
    ).rejects.toMatchObject({ code: "BACKTEST_EXECUTION_MODEL" });
    expect(create).not.toHaveBeenCalled();
  });
});
