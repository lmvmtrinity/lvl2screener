import { expect, it } from "vitest";
import { deriveChallengerSessionCoverage } from "../src/statistical-models/challenger-session-coverage.js";

it("derives verified, incomplete, unknown and paused session counts", () => {
  expect(
    deriveChallengerSessionCoverage([
      {
        sessionDate: "2026-09-01",
        status: "VERIFIED",
        coveredOpportunity: false,
      },
      {
        sessionDate: "2026-09-02",
        status: "VERIFIED",
        coveredOpportunity: true,
      },
      {
        sessionDate: "2026-09-03",
        status: "INCOMPLETE",
        coveredOpportunity: false,
      },
      {
        sessionDate: "2026-09-04",
        status: "UNKNOWN",
        coveredOpportunity: false,
      },
      {
        sessionDate: "2026-09-05",
        status: "VERIFIED",
        coveredOpportunity: true,
        fullyPaused: true,
      },
    ]),
  ).toEqual({
    verifiedSessions: 2,
    incompleteSessions: 1,
    unknownSessions: 1,
    coveredNoOpportunitySessions: 1,
    excludedPausedSessions: 1,
  });
});
