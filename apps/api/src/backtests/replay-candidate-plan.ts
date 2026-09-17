import type {
  ReplayCandidateProvenance,
  ReplayInputInstrument,
  ReplayInputSnapshot,
  ReplaySessionCandidates,
} from "@tsx-scanner/contracts";
import { contentHash } from "./research-coverage.js";

/**
 * Resolved candidate selection for one replay input, frozen before dispatch.
 * `sessions` is populated for historical-membership resolution: each session
 * names the retained membership snapshot that was effective before its open and
 * the candidates that snapshot produced. Explicit captured-cohort plans keep
 * `sessions` empty and rely on `candidateInstruments`.
 */
export interface ReplayCandidatePlan {
  readonly provenance: ReplayCandidateProvenance;
  readonly sessions: readonly ReplaySessionCandidates[];
  readonly candidateInstruments: readonly ReplayInputInstrument[];
  readonly universeRefreshRunId: string | null;
  readonly warnings: readonly string[];
  /** Stable identity of the resolved selection; participates in input freshness. */
  readonly digest: string;
}

/** Candidate count actually replayable across the plan's sessions. */
export function replayCandidateCount(plan: ReplayCandidatePlan): number {
  if (plan.sessions.length) {
    return plan.sessions.reduce(
      (total, session) => total + session.candidates.length,
      0,
    );
  }
  return plan.candidateInstruments.length;
}

/** Candidate count of a frozen replay input, across per-session candidates when
 * present and the legacy single list otherwise. */
export function replayInputCandidateCount(
  replayInput: Pick<ReplayInputSnapshot, "sessions" | "candidateInstruments">,
): number {
  if (replayInput.sessions.length)
    return replayInput.sessions.reduce(
      (total, session) => total + session.candidates.length,
      0,
    );
  return replayInput.candidateInstruments.length;
}

export function replayCandidatePlanDigest(
  provenance: ReplayCandidateProvenance,
  sessions: readonly ReplaySessionCandidates[],
  candidateInstruments: readonly ReplayInputInstrument[],
): string {
  if (sessions.length)
    return contentHash({
      provenance,
      sessions: sessions.map((session) => ({
        sessionDate: session.sessionDate,
        resolution: session.resolution,
        membershipRunId: session.membershipRunId,
        instrumentIds: session.candidates
          .map((candidate) => candidate.instrumentId)
          .sort(),
      })),
    });
  return contentHash({
    provenance,
    instrumentIds: candidateInstruments
      .map((candidate) => candidate.instrumentId)
      .sort(),
  });
}
