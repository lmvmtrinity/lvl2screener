import { describe, expect, it } from "vitest";
import type {
  ChallengerAttempt,
  ChallengerReportRow,
} from "../src/statistical-models/challenger-reporting-service.js";
import type { ChallengerOutcome } from "@tsx-scanner/contracts";
import {
  buildChallengerObservationReport,
  labelVisibleAt,
} from "../src/statistical-models/challenger-reporting-service.js";

const UUID = "10000000-0000-4000-8000-000000000001";
const time = "2026-09-10T13:30:00.000Z";

function attempt(index: number): ChallengerAttempt {
  return {
    experimentId: UUID,
    observationId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    modelVersion: "model-v1",
    inputHash: "a".repeat(64),
    observedAt: time,
    recordedAt: time,
    deadlineAt: "2026-09-10T13:30:01.000Z",
  };
}

const prediction = {
  marketId: "CA_TSX" as const,
  instrumentId: "10000000-0000-4000-8000-000000000002",
  symbol: "TEST.TO",
  timestamp: time,
  profileId: "10000000-0000-4000-8000-000000000003",
  profileName: "Fixture",
  strategy: "ORB_RETEST" as const,
  deterministicScore: 70,
  setupProbability: 0.6,
  falseBreakoutProbability: 0.2,
  rankingScore: 70,
  regime: { atr: "HIGH" as const, rvol: "HIGH" as const, combined: "HIGH" },
  contributions: {},
  warnings: [],
};

function row(
  index: number,
  outcome: ChallengerOutcome | null,
  closed = false,
): ChallengerReportRow {
  return {
    ...attempt(index),
    outcome,
    quoteOutcome: closed
      ? {
          status: "CLOSED",
          rMultiple: 1,
          labelAvailableAt: "2026-09-10T13:31:00.000Z",
        }
      : null,
  };
}

describe("buildChallengerObservationReport", () => {
  it("does not expose a label before its durable availability time", () => {
    const label = {
      exitAt: "2026-09-10T16:00:00.000Z",
      labelAvailableAt: "2026-09-10T16:05:00.000Z",
    };
    expect(labelVisibleAt(label, "2026-09-10T14:00:00.000Z")).toBe(false);
    expect(labelVisibleAt(label, "2026-09-10T16:02:00.000Z")).toBe(false);
    expect(labelVisibleAt(label, "2026-09-10T16:05:00.000Z")).toBe(true);
    expect(
      labelVisibleAt(
        { ...label, labelAvailableAt: null },
        "2026-09-11T00:00:00.000Z",
      ),
    ).toBe(false);
  });
  it("keeps all five attempt states in the denominator and scores only closed timely predictions", () => {
    const report = buildChallengerObservationReport({
      experimentId: UUID,
      asOf: "2026-09-10T14:00:00.000Z",
      attempts: [
        row(
          1,
          {
            status: "PREDICTED",
            completedAt: "2026-09-10T13:30:00.500Z",
            prediction,
          },
          true,
        ),
        row(2, {
          status: "PREDICTED",
          completedAt: "2026-09-10T13:30:00.500Z",
          prediction,
        }),
        row(3, {
          status: "MISSED_DEADLINE",
          completedAt: "2026-09-10T13:31:00.000Z",
          reason: "DEADLINE_EXPIRED",
        }),
        row(4, {
          status: "ENGINE_FAILED",
          completedAt: "2026-09-10T13:30:00.500Z",
          reason: "ENGINE_FAILED",
        }),
        row(5, null),
      ],
      incompleteSessions: 1,
      coveredNoOpportunitySessions: 1,
    });
    expect(report.population.expectedEligibleObservations).toBe(5);
    expect(report.population.predicted).toBe(2);
    expect(report.population.missedDeadline).toBe(1);
    expect(report.population.engineFailed).toBe(1);
    expect(report.population.pending).toBe(1);
    expect(report.closedQuoteOutcomes).toBe(1);
    expect(report.prospectiveBrierScore).toBeCloseTo(0.16);
    expect(report.comparison).toBeNull();
    expect(report.comparisonUnavailableReason).toBe("PAIRED_INPUTS_MISSING");
    expect(report.coveredNoOpportunitySessions).toBe(1);
    expect(report.promotionAuthorized).toBe(false);
  });
});
