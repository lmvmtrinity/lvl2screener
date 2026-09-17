import type { BacktestRun } from "@tsx-scanner/contracts";
import { describe, expect, it } from "vitest";
import {
  coverageLabel,
  evidenceLabel,
  executionLabel,
  groupBacktestResults,
} from "./backtest-results.js";

function run(overrides: Partial<BacktestRun>): BacktestRun {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Baseline replay",
    status: "COMPLETED",
    startDate: "2026-08-31",
    endDate: "2026-09-11",
    configVersion: "phase8-abc123",
    createdAt: "2026-09-11T20:00:00.000Z",
    startedAt: null,
    completedAt: "2026-09-11T21:00:00.000Z",
    metrics: null,
    evidence: null,
    dataQuality: null,
    ...overrides,
  } as unknown as BacktestRun;
}

function autoRun(
  configName: string,
  configVersion: string,
  completedAt: string,
  overrides: Partial<BacktestRun> = {},
): BacktestRun {
  return run({
    name: `Auto qualification · ${configName} · ${configVersion}`,
    configVersion,
    completedAt,
    ...overrides,
  });
}

describe("groupBacktestResults", () => {
  it("keeps one latest row per profile configuration with older attempts", () => {
    const older = autoRun(
      "ORB Standard",
      "profile-orb-standard-v1",
      "2026-09-09T21:00:00.000Z",
    );
    const latest = autoRun(
      "ORB Standard",
      "profile-orb-standard-v1",
      "2026-09-11T21:00:00.000Z",
    );
    const other = autoRun(
      "VWAP Hold",
      "profile-vwap-hold-v1",
      "2026-09-10T21:00:00.000Z",
    );
    const groups = groupBacktestResults([older, other, latest]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.title).toBe("ORB Standard");
    expect(groups[0]!.latest.id).toBe(latest.id);
    expect(groups[0]!.older.map((value) => value.id)).toEqual([older.id]);
    expect(groups[1]!.title).toBe("VWAP Hold");
  });

  it("keeps manual runs individually addressable", () => {
    const first = run({ id: "10000000-0000-4000-8000-0000000000a1" });
    const second = run({ id: "10000000-0000-4000-8000-0000000000a2" });
    const groups = groupBacktestResults([first, second]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.title)).toEqual([
      "Baseline replay",
      "Baseline replay",
    ]);
  });
});

describe("result labels", () => {
  it("labels a completed negative result neutrally", () => {
    const value = run({
      status: "COMPLETED",
      metrics: {
        netPnl: -161.72,
        tradesSimulated: 9,
      } as BacktestRun["metrics"],
    });
    expect(executionLabel(value)).toBe("Completed");
  });

  it("distinguishes qualified, exploratory and insufficient evidence", () => {
    expect(
      evidenceLabel(
        run({
          evidence: {
            qualification: "EVIDENCE_QUALIFIED",
            adequateSamples: true,
          } as BacktestRun["evidence"],
        }),
      ),
    ).toBe("Qualified");
    expect(
      evidenceLabel(
        run({
          evidence: {
            qualification: "EXPLORATORY",
            adequateSamples: true,
          } as BacktestRun["evidence"],
        }),
      ),
    ).toBe("Exploratory");
    expect(
      evidenceLabel(
        run({
          evidence: {
            qualification: "EXPLORATORY",
            adequateSamples: false,
          } as BacktestRun["evidence"],
        }),
      ),
    ).toBe("Insufficient sample");
  });

  it("reports evaluated-through coverage with limitations", () => {
    expect(coverageLabel(run({}))).toBe("through 2026-09-11");
    expect(
      coverageLabel(
        run({
          dataQuality: { warnings: ["gap"] } as BacktestRun["dataQuality"],
          evidence: { warnings: ["thin"] } as BacktestRun["evidence"],
        }),
      ),
    ).toBe("through 2026-09-11 · 2 limitations");
  });
});
