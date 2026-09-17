import { describe, expect, it } from "vitest";
import type {
  PaperEvidenceCohort,
  PaperEvidenceTrainingRow,
} from "@tsx-scanner/contracts";
import { qualifyPaperEvidence } from "../src/statistical-models/paper-evidence-qualification.js";

const cohort: PaperEvidenceCohort = {
  marketId: "CA_TSX",
  strategy: "ORB_RETEST",
  strategyVersion: "1.0.0",
  profileConfigId: "10000000-0000-4000-8000-000000000001",
  configVersion: "config-v1",
  executionModelVersion: "paper-execution-v7",
  assumptions: { positionSize: 100 },
  closedQuoteCount: 200,
  positives: 150,
  negatives: 50,
  firstSignalAt: "2026-08-03T14:00:00.000Z",
  lastSignalAt: "2026-08-06T15:38:00.000Z",
  missingFeatureCount: 0,
  signalSemanticsVersion: "setup-semantics-v2",
  replayScope: "FORWARD_LIVE",
};

function row(index: number, day: number): PaperEvidenceTrainingRow {
  const signal = new Date(Date.UTC(2026, 7, day, 14, 0, 0) + index * 120_000);
  const id = index + (day - 3) * 50 + 1;
  const uuid = (suffix: number) =>
    `10000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;
  return {
    marketId: "CA_TSX",
    sourceKey: `paper_execution:${uuid(id)}`,
    executionId: uuid(id),
    observationId: uuid(10_000 + id),
    instrumentId: "20000000-0000-4000-8000-000000000001",
    signalTimestamp: signal.toISOString(),
    labelAvailableAt: new Date(signal.getTime() + 60_000).toISOString(),
    deterministicScore: index % 4 === 0 ? 60 : 85,
    atrPct: 1.2,
    rvolAtTime: 2,
    rMultiple: index % 4 === 0 ? -1 : 1,
  };
}

const completeRows = [3, 4, 5, 6].flatMap((day) =>
  Array.from({ length: 50 }, (_, index) => row(index, day)),
);

describe("paper evidence research qualification", () => {
  it("requires label availability, purges overlap, and qualifies chronological windows", () => {
    const result = qualifyPaperEvidence({
      cohort,
      rows: completeRows,
      requestedCutoff: new Date("2026-08-07T00:00:00.000Z"),
    });

    expect(result.qualification.qualified).toBe(true);
    expect(result.qualification.distinctSessionCount).toBe(4);
    expect(result.qualification.walkForwardWindows).toHaveLength(3);
    expect(result.qualification.chronologicalTrainSourceKeys).toHaveLength(150);
    expect(result.qualification.chronologicalTestSourceKeys).toHaveLength(50);
    expect(
      result.qualification.walkForwardWindows.every(
        (value) => value.testExpectancy > 0,
      ),
    ).toBe(true);
  });

  it("purges training labels that become available after the holdout starts", () => {
    const rows = completeRows.map((value) => ({
      ...value,
      labelAvailableAt:
        value.signalTimestamp.slice(0, 10) === "2026-08-05"
          ? "2026-08-06T14:00:00.000Z"
          : value.labelAvailableAt,
    }));
    const result = qualifyPaperEvidence({
      cohort,
      rows,
      requestedCutoff: new Date("2026-08-07T00:00:00.000Z"),
    });
    expect(result.qualification.chronologicalTrainSourceKeys).toHaveLength(100);
    expect(result.qualification.chronologicalTrainSourceKeys).not.toContain(
      rows.find((value) => value.signalTimestamp.startsWith("2026-08-05"))!
        .sourceKey,
    );
  });

  it("fails closed for missing provenance and labels crossing the cutoff", () => {
    const missingInstrument = { ...completeRows[0]!, instrumentId: undefined };
    const missingLabel = { ...completeRows[1]!, labelAvailableAt: undefined };
    const late = {
      ...completeRows[1]!,
      labelAvailableAt: "2026-08-08T00:00:00.000Z",
    };
    const result = qualifyPaperEvidence({
      cohort: {
        ...cohort,
        replayScope: "UNKNOWN",
        signalSemanticsVersion: "UNKNOWN",
      },
      rows: [missingInstrument, missingLabel, late],
      requestedCutoff: new Date("2026-08-07T00:00:00.000Z"),
    });

    expect(result.qualification.qualified).toBe(false);
    expect(result.qualification.reasons).toEqual(
      expect.arrayContaining([
        "MISSING_SIGNAL_SEMANTICS_PROVENANCE",
        "MISSING_REPLAY_SCOPE_PROVENANCE",
        expect.stringContaining("INSUFFICIENT_PURGED_ROWS"),
      ]),
    );
    expect(result.qualification.excludedCounts).toMatchObject({
      MISSING_INSTRUMENT_PROVENANCE: 1,
      MISSING_LABEL_AVAILABILITY: 1,
    });
  });

  it("purges later overlapping labels on the same instrument", () => {
    const first = row(0, 3);
    const overlap = {
      ...row(1, 3),
      signalTimestamp: "2026-08-03T14:00:30.000Z",
      labelAvailableAt: "2026-08-03T14:02:00.000Z",
    };
    const result = qualifyPaperEvidence({
      cohort,
      rows: [first, overlap],
      requestedCutoff: new Date("2026-08-04T00:00:00.000Z"),
    });

    expect(result.acceptedRows).toHaveLength(1);
    expect(result.qualification.excludedCounts.OVERLAPPING_LABEL).toBe(1);
  });
});
