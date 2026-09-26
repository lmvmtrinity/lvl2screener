import { describe, expect, it } from "vitest";
import {
  inspectSignalModelSource,
  type CanonicalSignalOpportunityCapture,
} from "../src/backtests/signal-model-source-preflight.js";
import { estimateSignalModelPower } from "../src/backtests/signal-model-research-control.js";

const scope = {
  runId: "10000000-0000-4000-8000-000000000001",
  marketId: "CA_TSX" as const,
  strategy: "ORB_RETEST" as const,
  strategyVersion: "1.0.0",
  configVersion: "config-1",
  profileId: "20000000-0000-4000-8000-000000000001",
  profileName: "baseline",
  executionModelVersion: "captured-quote-v1",
  executionAssumptionsHash: "a".repeat(64),
};

function capture(
  overrides: Partial<CanonicalSignalOpportunityCapture> = {},
): CanonicalSignalOpportunityCapture {
  return {
    ...scope,
    sourceRunId: scope.runId,
    replayId: "30000000-0000-4000-8000-000000000001",
    evidenceId: "trade-or-opportunity-1",
    opportunityId: "opportunity-1",
    marketId: scope.marketId,
    strategy: scope.strategy,
    strategyVersion: scope.strategyVersion,
    configVersion: scope.configVersion,
    profileId: scope.profileId,
    profileName: scope.profileName,
    executionModelVersion: scope.executionModelVersion,
    executionAssumptionsHash: scope.executionAssumptionsHash,
    signalSemanticsVersion: "setup-semantics-v2",
    stage: "TRAIN",
    sessionDate: "2026-01-05",
    symbol: "SHOP",
    instrumentId: "40000000-0000-4000-8000-000000000001",
    baselineSelected: true,
    predictionInput: {
      marketId: scope.marketId,
      strategy: scope.strategy,
      timestamp: "2026-01-05T15:00:00.000Z",
      deterministicScore: 80,
      atrPct: 1.2,
      rvolAtTime: 2.1,
    },
    sourceFeatures: { atrPct: 1.2, rvolAtTime: 2.1 },
    outcome: {
      status: "CLOSED",
      entryTime: "2026-01-05T15:01:00.000Z",
      exitTime: "2026-01-05T18:00:00.000Z",
      entryPrice: 10,
      exitPrice: 11,
      shares: 100,
      netPnl: 12,
      rMultiple: 1.2,
    },
    labelAvailableAt: "2026-01-05T18:00:00.000Z",
    ...overrides,
  };
}

describe("signal model source preflight", () => {
  it("fails closed on a market or provenance mismatch", () => {
    const result = inspectSignalModelSource({
      scope: { ...scope, marketId: "US_EQUITIES" },
      run: { ...scope, status: "COMPLETED" },
      coverageStatus: "VERIFIED",
      lineageStatus: "VERIFIED",
      captures: [capture()],
      expectedSessions: {
        TRAIN: ["2026-01-05"],
        VALIDATION: ["2026-01-06"],
        TEST: ["2026-01-07"],
      },
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.reasonCodes).toContain("SOURCE_SCOPE_MISMATCH");
  });

  it("rejects duplicate evidence repeated by another replay", () => {
    const first = capture();
    const result = inspectSignalModelSource({
      scope,
      run: { ...scope, status: "COMPLETED" },
      coverageStatus: "VERIFIED",
      lineageStatus: "VERIFIED",
      captures: [
        first,
        { ...first, replayId: "30000000-0000-4000-8000-000000000002" },
      ],
      expectedSessions: {
        TRAIN: ["2026-01-05"],
        VALIDATION: ["2026-01-06"],
        TEST: ["2026-01-07"],
      },
    });
    expect(result.reasonCodes).toContain("DUPLICATE_REPLAY_EVIDENCE");
  });

  it("reports missing decision-time prediction features", () => {
    const result = inspectSignalModelSource({
      scope,
      run: { ...scope, status: "COMPLETED" },
      coverageStatus: "VERIFIED",
      lineageStatus: "VERIFIED",
      captures: [
        capture({
          predictionInput: { ...capture().predictionInput, atrPct: null },
        }),
      ],
      expectedSessions: {
        TRAIN: ["2026-01-05"],
        VALIDATION: ["2026-01-06"],
        TEST: ["2026-01-07"],
      },
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.missingFields).toContain("predictionInput.atrPct");
  });

  it("rejects labels that were unavailable at the next chronological stage", () => {
    const result = inspectSignalModelSource({
      scope,
      run: { ...scope, status: "COMPLETED" },
      coverageStatus: "VERIFIED",
      lineageStatus: "VERIFIED",
      captures: [capture({ labelAvailableAt: "2026-01-06T15:00:00.000Z" })],
      expectedSessions: {
        TRAIN: ["2026-01-05"],
        VALIDATION: ["2026-01-06"],
        TEST: ["2026-01-07"],
      },
    });
    expect(result.reasonCodes).toContain("TRAIN_LABEL_CHRONOLOGY_UNPROVEN");
  });

  it("returns unavailable with exact missing retained capture fields", () => {
    const result = inspectSignalModelSource({
      scope,
      run: { ...scope, status: "COMPLETED" },
      coverageStatus: "VERIFIED",
      lineageStatus: "VERIFIED",
      captures: [],
      expectedSessions: {
        TRAIN: ["2026-01-05"],
        VALIDATION: ["2026-01-06"],
        TEST: ["2026-01-07"],
      },
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.missingFields).toContain("canonical opportunity membership");
  });

  it("keeps verified unselected captures in complete membership while marking them baseline-ineligible", () => {
    const selected = capture({ opportunityId: "selected" });
    const unselected = capture({
      opportunityId: "below-cutoff",
      evidenceId: "event-below-cutoff",
      baselineSelected: false,
    });
    const result = inspectSignalModelSource({
      scope,
      run: { ...scope, status: "COMPLETED" },
      coverageStatus: "VERIFIED",
      lineageStatus: "VERIFIED",
      captures: [selected, unselected],
      expectedSessions: {
        TRAIN: ["2026-01-05"],
        VALIDATION: ["2026-01-06"],
        TEST: ["2026-01-07"],
      },
    });

    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.orderedCaptures.map((row) => row.opportunityId)).toEqual([
        "below-cutoff",
        "selected",
      ]);
      expect(
        result.orderedCaptures.find(
          (row) => row.opportunityId === "below-cutoff",
        )?.baselineSelected,
      ).toBe(false);
      expect(
        result.orderedCaptures
          .filter((row) => row.baselineSelected)
          .map((row) => row.opportunityId),
      ).toEqual(["selected"]);
    }
  });

  it("does not claim power from zero-variance training sessions", () => {
    const first = capture({ sessionDate: "2026-01-05" });
    const second = capture({
      sessionDate: "2026-01-06",
      opportunityId: "opportunity-2",
      evidenceId: "trade-or-opportunity-2",
      outcome: {
        status: "CLOSED",
        entryTime: "2026-01-06T15:01:00.000Z",
        exitTime: "2026-01-06T18:00:00.000Z",
        entryPrice: 10,
        exitPrice: 11,
        shares: 100,
        netPnl: 12,
        rMultiple: 1.2,
      },
      labelAvailableAt: "2026-01-06T18:00:00.000Z",
    });
    expect(estimateSignalModelPower([first, second], 0.25, 2, 0.05)).toBeNull();
  });
});
