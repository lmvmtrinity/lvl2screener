import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryEvidenceCompactor,
  type DiscoveryEvidenceCompactionResult,
} from "../src/universe/discovery-evidence-compactor.js";

const result: DiscoveryEvidenceCompactionResult = { inputs: 4, runs: 1 };

describe("discovery evidence compactor", () => {
  it("coalesces overlapping passes and logs the bounded result", async () => {
    let release!: (value: DiscoveryEvidenceCompactionResult) => void;
    const compact = vi.fn(
      () =>
        new Promise<DiscoveryEvidenceCompactionResult>((resolve) => {
          release = resolve;
        }),
    );
    const info = vi.fn();
    const compactor = new DiscoveryEvidenceCompactor(
      { compact },
      { inputDays: 30, summaryDays: 365, logger: { info, error: vi.fn() } },
    );

    const first = compactor.runOnce();
    const second = compactor.runOnce();
    expect(first).toBe(second);
    expect(compact).toHaveBeenCalledTimes(1);
    release(result);
    await expect(first).resolves.toEqual(result);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "DISCOVERY_EVIDENCE_COMPACTION_COMPLETED",
        inputs: 4,
        runs: 1,
        inputDays: 30,
        summaryDays: 365,
      }),
    );
  });

  it("keeps scheduled maintenance independent and bounded", async () => {
    vi.useFakeTimers();
    try {
      const compact = vi.fn().mockResolvedValue(result);
      const compactor = new DiscoveryEvidenceCompactor(
        { compact },
        { intervalMs: 60_000 },
      );
      compactor.start();
      expect(compact).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(compact).toHaveBeenCalledTimes(1);
      await compactor.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for disabled or inverted retention settings", async () => {
    const compact = vi.fn().mockResolvedValue(result);
    const disabled = new DiscoveryEvidenceCompactor(
      { compact },
      { enabled: false },
    );
    await expect(disabled.runOnce()).rejects.toThrow("disabled");
    expect(compact).not.toHaveBeenCalled();
    expect(
      () =>
        new DiscoveryEvidenceCompactor(
          { compact },
          { inputDays: 31, summaryDays: 30 },
        ),
    ).toThrow("must not be shorter");
  });
});
