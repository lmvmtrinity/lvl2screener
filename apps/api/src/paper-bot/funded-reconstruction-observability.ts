import type { FundedReconstructionObservation } from "./funded-ledger-repository.js";

export interface FundedReconstructionMetricsSnapshot {
  readonly reconstructionDurationMs: number | null;
  readonly reconstructionDurationMaxMs: number;
  readonly reconstructionReplayedEvents: number | null;
  readonly reconstructionPages: number | null;
  readonly reconstructionCheckpointAgeMs: number | null;
  readonly reconstructionLastObservedTimestampSeconds: number | null;
  readonly reconstructionCountTotal: number;
  readonly reconstructionFullReplaysTotal: number;
  readonly reconstructionBudgetFailuresTotal: number;
}

function emptySnapshot(): FundedReconstructionMetricsSnapshot {
  return {
    reconstructionDurationMs: null,
    reconstructionDurationMaxMs: 0,
    reconstructionReplayedEvents: null,
    reconstructionPages: null,
    reconstructionCheckpointAgeMs: null,
    reconstructionLastObservedTimestampSeconds: null,
    reconstructionCountTotal: 0,
    reconstructionFullReplaysTotal: 0,
    reconstructionBudgetFailuresTotal: 0,
  };
}

/**
 * Process-local reconstruction telemetry keyed by funded account. Keeping the
 * registry outside an adapter makes recovery-run and reporting reconstructions
 * visible through the current market adapter's operational snapshot.
 */
export class FundedReconstructionMetricsRegistry {
  private readonly accounts = new Map<
    string,
    FundedReconstructionMetricsSnapshot
  >();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  observe(accountId: string, observation: FundedReconstructionObservation) {
    const current = this.accounts.get(accountId) ?? emptySnapshot();
    this.accounts.set(accountId, {
      reconstructionDurationMs: observation.durationMs,
      reconstructionDurationMaxMs: Math.max(
        current.reconstructionDurationMaxMs,
        observation.durationMs,
      ),
      reconstructionReplayedEvents: observation.replayedEventCount,
      reconstructionPages: observation.pages,
      reconstructionCheckpointAgeMs: observation.checkpointAgeMs,
      reconstructionLastObservedTimestampSeconds: this.clock() / 1_000,
      reconstructionCountTotal: current.reconstructionCountTotal + 1,
      reconstructionFullReplaysTotal:
        current.reconstructionFullReplaysTotal +
        (observation.outcome === "FULL" ? 1 : 0),
      reconstructionBudgetFailuresTotal:
        current.reconstructionBudgetFailuresTotal +
        (observation.failureCode === "BUDGET_EXCEEDED" ? 1 : 0),
    });
  }

  snapshot(accountId: string): FundedReconstructionMetricsSnapshot {
    return this.accounts.get(accountId) ?? emptySnapshot();
  }
}

export const fundedReconstructionMetrics =
  new FundedReconstructionMetricsRegistry();
