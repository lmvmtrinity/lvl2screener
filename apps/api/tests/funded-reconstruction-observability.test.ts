import { describe, expect, it } from "vitest";
import { FundedReconstructionMetricsRegistry } from "../src/paper-bot/funded-reconstruction-observability.js";

describe("funded reconstruction metrics registry", () => {
  it("shares account-scoped observations and clears checkpoint age on full replay", () => {
    const registry = new FundedReconstructionMetricsRegistry(() => 12_345_000);
    registry.observe("account-a", {
      outcome: "CHECKPOINTED",
      durationMs: 12,
      replayedEventCount: 20,
      pages: 1,
      checkpointRunId: null,
      checkpointBoundaryAt: "2099-02-02T14:00:00.000Z",
      checkpointAgeMs: 1_000,
    });
    registry.observe("account-a", {
      outcome: "FULL",
      durationMs: 18,
      replayedEventCount: 30,
      pages: 2,
      checkpointRunId: null,
      checkpointBoundaryAt: null,
      checkpointAgeMs: null,
    });
    registry.observe("account-a", {
      outcome: "UNAVAILABLE",
      failureCode: "BUDGET_EXCEEDED",
      durationMs: 25,
      replayedEventCount: 250_001,
      pages: 126,
      checkpointRunId: null,
      checkpointBoundaryAt: null,
      checkpointAgeMs: null,
    });

    expect(registry.snapshot("account-a")).toEqual({
      reconstructionDurationMs: 25,
      reconstructionDurationMaxMs: 25,
      reconstructionReplayedEvents: 250_001,
      reconstructionPages: 126,
      reconstructionCheckpointAgeMs: null,
      reconstructionLastObservedTimestampSeconds: 12_345,
      reconstructionCountTotal: 3,
      reconstructionFullReplaysTotal: 1,
      reconstructionBudgetFailuresTotal: 1,
    });
    expect(registry.snapshot("account-b")).toEqual({
      reconstructionDurationMs: null,
      reconstructionDurationMaxMs: 0,
      reconstructionReplayedEvents: null,
      reconstructionPages: null,
      reconstructionCheckpointAgeMs: null,
      reconstructionLastObservedTimestampSeconds: null,
      reconstructionCountTotal: 0,
      reconstructionFullReplaysTotal: 0,
      reconstructionBudgetFailuresTotal: 0,
    });
  });
});
