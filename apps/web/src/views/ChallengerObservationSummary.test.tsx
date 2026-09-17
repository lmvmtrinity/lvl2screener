import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ChallengerObservationSummary } from "./ChallengerObservationSummary.js";

it("shows unavailable predictive evidence and has no activation control", () => {
  render(
    <ChallengerObservationSummary
      report={{
        experimentId: "10000000-0000-4000-8000-000000000001",
        asOf: "2026-09-10T14:00:00.000Z",
        population: {
          expectedEligibleObservations: 1,
          predicted: 0,
          pending: 0,
          missedDeadline: 1,
          engineFailed: 0,
          inputInvalid: 0,
          revoked: 0,
          unknownCapture: 0,
        },
        verifiedSessions: 0,
        incompleteSessions: 1,
        unknownSessions: 0,
        coveredNoOpportunitySessions: 0,
        excludedPausedSessions: 0,
        closedQuoteOutcomes: 0,
        prospectiveBrierScore: null,
        comparison: null,
        comparisonUnavailableReason: "COVERAGE_UNVERIFIED",
        promotionAuthorized: false,
      }}
    />,
  );
  expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  expect(screen.getByText("Missed deadline")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /activate/i })).toBeNull();
});

it("discloses paired comparison settings without offering promotion", () => {
  render(
    <ChallengerObservationSummary
      report={{
        experimentId: "10000000-0000-4000-8000-000000000001",
        asOf: "2026-09-10T14:00:00.000Z",
        population: {
          expectedEligibleObservations: 1,
          predicted: 1,
          pending: 0,
          missedDeadline: 0,
          engineFailed: 0,
          inputInvalid: 0,
          revoked: 0,
          unknownCapture: 0,
        },
        verifiedSessions: 1,
        incompleteSessions: 0,
        unknownSessions: 0,
        coveredNoOpportunitySessions: 0,
        excludedPausedSessions: 0,
        closedQuoteOutcomes: 1,
        prospectiveBrierScore: 0.125,
        comparison: {
          version: "paired-session-v1",
          status: "AVAILABLE",
          unit: "R",
          basis: "MEAN_PAIRED_SESSION_DIFFERENCE",
          expectedSessions: 12,
          observedSessions: 10,
          estimate: 0.12,
          lower: -0.04,
          upper: 0.28,
          confidenceLevel: 0.95,
          method: {
            kind: "CIRCULAR_MOVING_BLOCK_BOOTSTRAP",
            blockLength: 3,
            bootstrapSamples: 2000,
            seed: 42,
          },
          reasonCodes: [],
        },
        comparisonUnavailableReason: null,
        promotionAuthorized: false,
      }}
    />,
  );
  expect(screen.getByText("Paired comparison")).toBeInTheDocument();
  expect(screen.getByText("R")).toBeInTheDocument();
  expect(screen.getByText("12 / 10")).toBeInTheDocument();
  expect(
    screen.getByText("CIRCULAR_MOVING_BLOCK_BOOTSTRAP"),
  ).toBeInTheDocument();
  expect(screen.getByText("3 / 2000 / 42")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /promot|activate/i })).toBeNull();
});
