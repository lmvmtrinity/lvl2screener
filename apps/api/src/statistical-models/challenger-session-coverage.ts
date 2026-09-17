export type ChallengerSessionCoverageCell = {
  sessionDate: string;
  status: "VERIFIED" | "INCOMPLETE" | "UNKNOWN";
  coveredOpportunity: boolean;
  fullyPaused?: boolean;
};

export type ChallengerSessionCoverage = {
  verifiedSessions: number;
  incompleteSessions: number;
  unknownSessions: number;
  coveredNoOpportunitySessions: number;
  excludedPausedSessions: number;
};

/** Count each exact expected session once. Paused sessions are excluded from
 * the active denominator; covered-no-opportunity remains a VERIFIED subset. */
export function deriveChallengerSessionCoverage(
  cells: readonly ChallengerSessionCoverageCell[],
): ChallengerSessionCoverage {
  const seen = new Set<string>();
  const result: ChallengerSessionCoverage = {
    verifiedSessions: 0,
    incompleteSessions: 0,
    unknownSessions: 0,
    coveredNoOpportunitySessions: 0,
    excludedPausedSessions: 0,
  };
  for (const cell of cells) {
    if (seen.has(cell.sessionDate)) continue;
    seen.add(cell.sessionDate);
    if (cell.fullyPaused) {
      result.excludedPausedSessions += 1;
      continue;
    }
    result[
      `${cell.status.toLowerCase()}Sessions` as
        "verifiedSessions" | "incompleteSessions" | "unknownSessions"
    ] += 1;
    if (cell.status === "VERIFIED" && !cell.coveredOpportunity)
      result.coveredNoOpportunitySessions += 1;
  }
  return result;
}
