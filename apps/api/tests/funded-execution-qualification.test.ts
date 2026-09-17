import { describe, expect, it } from "vitest";
import type {
  FundedCohortIdentity,
  FundedExecutionFeatureVector,
  FundedExecutionLabels,
} from "@tsx-scanner/contracts";
import {
  FUNDED_EXECUTION_QUALIFICATION_POLICY,
  qualifyFundedExecutionRows,
  type FundedExecutionAssembledRow,
} from "../src/statistical-models/funded-execution-qualification.js";

const digest = "a".repeat(64);

const features: FundedExecutionFeatureVector = {
  deterministicScore: 80,
  spreadPct: 0.2,
  logDisplayedSize: 6,
  logRequestedNotional: 7.3,
  logRequestedRisk: 5.5,
  quoteAgeSeconds: 1,
  minutesFromOpen: 5,
  atrPct: 0.015,
  stopDistancePct: 0.02,
  targetDistancePct: 0.05,
  logCash: 9.2,
  logOpenRisk: 0,
  logReservedRisk: 0,
  positionCount: 0,
  participation: 0.25,
  contextStrength: 2,
};

function labels(
  overrides: Partial<FundedExecutionLabels> = {},
): FundedExecutionLabels {
  const value = {
    fillProbability: 1,
    fillFraction: 1,
    slippagePerShare: 0.01,
    totalExecutionCost: 1,
    labelAvailableAt: "2026-09-08T18:00:00.000Z",
    economicOutcomeAt: "2026-09-08T17:00:00.000Z",
    terminalityProof: null,
    terminalOutcomeStatus: "FILLED",
    terminalOutcomeSequence: 2,
    terminalOutcomeSourceDigest: digest,
    fillLabelAvailable: true,
    costLabelAvailable: true,
    ...overrides,
  } as FundedExecutionLabels;
  return {
    ...value,
    knowledge: overrides.knowledge ?? {
      provenance: "DATABASE_CAPTURE",
      runId: null,
      sequence: null,
      at: value.labelAvailableAt,
    },
  };
}

function row(
  overrides: Partial<FundedExecutionAssembledRow> = {},
): FundedExecutionAssembledRow {
  return {
    marketId: "CA_TSX",
    currency: "CAD",
    accountId: "account-1",
    runId: "run-1",
    observationId: "observation-1",
    decisionSequence: 1,
    decisionContentDigest: digest,
    cohortDigest: digest,
    sourceKind: "LIVE_PAPER",
    action: "SUBMIT",
    decisionAt: "2026-09-08T14:30:00.000Z",
    runSource: "LIVE",
    runStatus: "COMPLETED",
    instrumentId: null,
    sessionDate: "2026-09-08",
    verdict: "INCLUDED",
    exclusionReason: null,
    unknown: false,
    features,
    labels: labels(),
    outcomeSequences: [2],
    outcomeSourceDigests: [digest],
    exposureEndAt: "2026-09-08T15:00:00.000Z",
    ...overrides,
  };
}

const cohort: FundedCohortIdentity = {
  marketId: "CA_TSX",
  currency: "CAD",
  evidenceSchemaVersion: 2,
  fundedPolicyVersion: "funded-policy-v1",
  portfolioPolicyVersion: "funded-portfolio-v2",
  executionModelVersion: "paper-execution-v3",
  costPolicyVersion: "paper-cost-policy-2026-09-04",
  participationVersion: "participation-v1",
  sourceKind: "LIVE_PAPER",
  featureVersion: "funded-execution-features-v1",
  runtimeVersion: "runtime-v1",
  accountAssumptionDigest: digest,
  signalModelId: null,
  signalModelVersion: null,
  cohortDigest: digest,
};

/**
 * 200 included rows: 100 training rows across three sessions plus 100 holdout
 * rows in a fourth session, alternating fill classes, with cost labels.
 */
function qualifyingRows(): FundedExecutionAssembledRow[] {
  const rows: FundedExecutionAssembledRow[] = [];
  const trainSessions = ["2026-09-08", "2026-09-09", "2026-09-10"];
  for (let index = 0; index < 100; index += 1) {
    const sessionDate = trainSessions[index % 3]!;
    const filled = index % 2 === 0;
    rows.push(
      row({
        observationId: `train-${String(index).padStart(3, "0")}`,
        decisionAt: `${sessionDate}T14:${String(10 + (index % 40)).padStart(2, "0")}:00.000Z`,
        sessionDate,
        labels: labels({
          fillProbability: filled ? 1 : 0,
          fillFraction: filled ? 1 : 0,
          slippagePerShare: filled ? 0.01 : null,
          totalExecutionCost: filled ? 1 : null,
          costLabelAvailable: filled,
          terminalOutcomeStatus: filled ? "FILLED" : "NO_FILL",
          labelAvailableAt: `${sessionDate}T18:00:00.000Z`,
        }),
      }),
    );
  }
  for (let index = 0; index < 100; index += 1) {
    const filled = index % 2 === 0;
    rows.push(
      row({
        observationId: `test-${String(index).padStart(3, "0")}`,
        decisionAt: `2026-09-11T14:${String(10 + (index % 40)).padStart(2, "0")}:00.000Z`,
        sessionDate: "2026-09-11",
        labels: labels({
          fillProbability: filled ? 1 : 0,
          fillFraction: filled ? 1 : 0,
          slippagePerShare: filled ? 0.01 : null,
          totalExecutionCost: filled ? 1 : null,
          costLabelAvailable: filled,
          terminalOutcomeStatus: filled ? "FILLED" : "NO_FILL",
          labelAvailableAt: "2026-09-11T18:00:00.000Z",
        }),
      }),
    );
  }
  return rows;
}

const cutoff = new Date("2026-09-12T00:00:00.000Z");

function priorDataset(
  memberIds: string[],
  includedRowCount = memberIds.length,
): {
  id: string;
  memberIdentityKeys: Set<string>;
  includedRowCount: number;
} {
  return {
    id: "prior-1",
    memberIdentityKeys: new Set(memberIds),
    includedRowCount,
  };
}

function identityKey(row: FundedExecutionAssembledRow): string {
  return `${row.runId}:${row.observationId}`;
}

function qualify(
  rows: FundedExecutionAssembledRow[],
  priorDatasetInput: ReturnType<typeof priorDataset> | null = null,
) {
  return qualifyFundedExecutionRows({
    cohort,
    rows,
    requestedCutoff: cutoff,
    priorDataset: priorDatasetInput,
  });
}

describe("funded execution cohort qualification floors", () => {
  it("qualifies exactly 200 usable rows and freezes the chronological split", () => {
    const result = qualify(qualifyingRows());
    expect(result.receipt.qualified).toBe(true);
    expect(result.qualifiedRows).toHaveLength(200);
    expect(result.receipt.counts.trainRowCount).toBe(100);
    expect(result.receipt.counts.testRowCount).toBe(100);
    expect(result.receipt.distinctSessionCount).toBe(4);
    expect(result.receipt.chronologicalSplitAt).toBe(
      "2026-09-11T14:10:00.000Z",
    );
    expect(result.receipt.trainFillPositives).toBe(50);
    expect(result.receipt.trainFillNegatives).toBe(50);
    expect(result.receipt.testFillPositives).toBe(50);
    expect(result.receipt.testFillNegatives).toBe(50);
  });

  it("returns a visible NOOP below the 200-row floor", () => {
    const rows = qualifyingRows();
    rows.pop();
    const result = qualify(rows);
    expect(result.receipt.qualified).toBe(false);
    expect(result.qualifiedRows).toEqual([]);
    expect(
      result.receipt.reasons.some((reason) =>
        reason.startsWith("INSUFFICIENT_USABLE_ROWS"),
      ),
    ).toBe(true);
    expect(result.receipt.minimumRows).toBe(200);
  });

  it("requires at least 50 new decision identities since the prior dataset", () => {
    const rows = qualifyingRows();
    const tooSoon = qualify(
      rows,
      priorDataset(rows.slice(0, 199).map(identityKey), 199),
    );
    expect(tooSoon.receipt.qualified).toBe(false);
    expect(tooSoon.receipt.newOutcomesSincePrior).toBe(1);
    expect(
      tooSoon.receipt.reasons.some((reason) =>
        reason.startsWith("INSUFFICIENT_NEW_OUTCOMES"),
      ),
    ).toBe(true);

    const allowed = qualify(
      rows,
      priorDataset(rows.slice(0, 150).map(identityKey), 150),
    );
    expect(allowed.receipt.qualified).toBe(true);
    expect(allowed.receipt.newOutcomesSincePrior).toBe(50);
    expect(allowed.receipt.reasons).toEqual([]);
  });

  it("passes when 50 new identities replace 50 prior members", () => {
    const rows = qualifyingRows();
    const currentKeys = rows.map(identityKey);
    const removed = Array.from(
      { length: 50 },
      (_, index) => `old-run:old-${String(index).padStart(3, "0")}`,
    );
    const result = qualify(
      rows,
      priorDataset([...currentKeys.slice(0, 150), ...removed], 200),
    );
    expect(result.receipt.priorDatasetRowCount).toBe(200);
    expect(result.receipt.newOutcomesSincePrior).toBe(50);
    expect(result.receipt.qualified).toBe(true);
  });

  it("fails when only 49 new identities replace 49 prior members", () => {
    const rows = qualifyingRows();
    const currentKeys = rows.map(identityKey);
    const removed = Array.from(
      { length: 49 },
      (_, index) => `old-run:old-${String(index).padStart(3, "0")}`,
    );
    const result = qualify(
      rows,
      priorDataset([...currentKeys.slice(0, 151), ...removed], 200),
    );
    expect(result.receipt.newOutcomesSincePrior).toBe(49);
    expect(result.receipt.qualified).toBe(false);
    expect(
      result.receipt.reasons.some((reason) =>
        reason.startsWith("INSUFFICIENT_NEW_OUTCOMES"),
      ),
    ).toBe(true);
  });

  it("does not count a corrected or changed row for an existing decision as new", () => {
    const rows = qualifyingRows();
    const changed = rows.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            labels: labels({
              slippagePerShare: 0.02,
              totalExecutionCost: 2,
            }),
          }
        : entry,
    );
    const result = qualify(changed, priorDataset(rows.map(identityKey), 200));
    expect(result.receipt.newOutcomesSincePrior).toBe(0);
    expect(result.receipt.qualified).toBe(false);
  });

  it("does not subtract removed prior members from the new-outcome count", () => {
    const rows = qualifyingRows();
    const currentKeys = rows.map(identityKey);
    const removed = Array.from(
      { length: 50 },
      (_, index) => `old-run:old-${String(index).padStart(3, "0")}`,
    );
    const result = qualify(
      rows,
      priorDataset([...currentKeys.slice(0, 199), ...removed], 249),
    );
    expect(result.receipt.priorDatasetRowCount).toBe(249);
    expect(result.receipt.newOutcomesSincePrior).toBe(1);
  });

  it("returns a visible NOOP on class, cost or session coverage failures", () => {
    const classRows = qualifyingRows().map((entry) =>
      entry.labels!.fillProbability === 0
        ? entry
        : {
            ...entry,
            labels: labels({
              costLabelAvailable: false,
              slippagePerShare: null,
              totalExecutionCost: null,
            }),
          },
    );
    // Keep the imbalanced variant disjoint from the cost-coverage failure by
    // requiring both classes to fail first.
    const imbalanced = qualify(
      classRows.map((entry) => ({
        ...entry,
        labels: labels({
          fillProbability: 1,
          fillFraction: 1,
          slippagePerShare: null,
          totalExecutionCost: null,
          costLabelAvailable: false,
        }),
      })),
    );
    expect(imbalanced.receipt.qualified).toBe(false);
    expect(imbalanced.receipt.reasons).toContain(
      "CHRONOLOGICAL_FILL_CLASS_IMBALANCE",
    );
    expect(imbalanced.receipt.reasons).toContain(
      "INSUFFICIENT_COST_LABEL_COVERAGE",
    );

    const few = qualify(
      qualifyingRows()
        .slice(0, 4)
        .map((entry, index) => {
          const day = 8 + (index % 2);
          const sessionDate = `2026-09-0${day}`;
          return {
            ...entry,
            sessionDate,
            decisionAt: `${sessionDate}T14:30:00.000Z`,
            labels: {
              ...entry.labels!,
              labelAvailableAt: `${sessionDate}T18:00:00.000Z`,
            },
          };
        }),
    );
    expect(few.receipt.qualified).toBe(false);
    expect(
      few.receipt.reasons.some((reason) =>
        reason.startsWith("INSUFFICIENT_SESSIONS"),
      ),
    ).toBe(true);
  });
});

describe("funded execution exposure overlap purging", () => {
  it("purges a later decision while an earlier exposure interval is open", () => {
    const first = row({
      observationId: "first",
      decisionAt: "2026-09-08T14:00:00.000Z",
      instrumentId: "10000000-0000-4000-8000-000000000001",
      exposureEndAt: "2026-09-08T15:00:00.000Z",
    });
    const overlapping = row({
      observationId: "overlapping",
      decisionAt: "2026-09-08T14:30:00.000Z",
      instrumentId: "10000000-0000-4000-8000-000000000001",
      exposureEndAt: "2026-09-08T15:30:00.000Z",
    });
    const otherInstrument = row({
      observationId: "other",
      decisionAt: "2026-09-08T14:30:00.000Z",
      instrumentId: "10000000-0000-4000-8000-000000000002",
      exposureEndAt: "2026-09-08T15:30:00.000Z",
    });
    const result = qualify([first, overlapping, otherInstrument]);
    expect(result.excludedCounts.OVERLAPPING_EXPOSURE).toBe(1);
    expect(result.receipt.counts.usableRowCount).toBe(2);
  });

  it("keeps a later decision after the earlier exposure interval ends", () => {
    const first = row({
      observationId: "first",
      decisionAt: "2026-09-08T14:00:00.000Z",
      instrumentId: "10000000-0000-4000-8000-000000000001",
      exposureEndAt: "2026-09-08T15:00:00.000Z",
    });
    const later = row({
      observationId: "later",
      decisionAt: "2026-09-08T15:30:00.000Z",
      instrumentId: "10000000-0000-4000-8000-000000000001",
      exposureEndAt: "2026-09-08T16:00:00.000Z",
    });
    const result = qualify([first, later]);
    expect(result.excludedCounts.OVERLAPPING_EXPOSURE).toBeUndefined();
    expect(result.receipt.counts.usableRowCount).toBe(2);
  });
});

describe("funded execution chronology and eligibility", () => {
  it("purges training labels that were unavailable before the holdout boundary", () => {
    const rows = qualifyingRows();
    const target = rows[0]!;
    const leaked = {
      ...target,
      labels: labels({
        ...target.labels!,
        labelAvailableAt: "2026-09-11T15:00:00.000Z",
        knowledge: {
          provenance: "DATABASE_CAPTURE" as const,
          runId: null,
          sequence: null,
          at: "2026-09-11T15:00:00.000Z",
        },
      }),
    };
    const result = qualify([leaked, ...rows.slice(1)]);
    expect(result.excludedCounts.LABEL_AFTER_CHRONOLOGICAL_BOUNDARY).toBe(1);
    expect(result.receipt.qualified).toBe(false);
  });

  it("purges a training label whose economic time preceded the holdout but whose knowledge time did not", () => {
    const rows = qualifyingRows();
    const target = rows[0]!;
    const leaked = {
      ...target,
      labels: labels({
        ...target.labels!,
        // The economic event was before the holdout decision, but the evidence
        // was only recorded after it: the row must still be purged from train.
        economicOutcomeAt: "2026-09-08T17:00:00.000Z",
        labelAvailableAt: "2026-09-11T15:00:00.000Z",
        knowledge: {
          provenance: "DATABASE_CAPTURE" as const,
          runId: null,
          sequence: null,
          at: "2026-09-11T15:00:00.000Z",
        },
      }),
    };
    const result = qualify([leaked, ...rows.slice(1)]);
    expect(result.excludedCounts.LABEL_AFTER_CHRONOLOGICAL_BOUNDARY).toBe(1);
    expect(result.receipt.qualified).toBe(false);
  });

  it("purges a replay training label whose applied-fact sequence is after the boundary", () => {
    const rows = qualifyingRows();
    const target = rows[0]!;
    const leaked = {
      ...target,
      sourceKind: "HISTORICAL_REPLAY" as const,
      runSource: "BACKTEST",
      labels: labels({
        ...target.labels!,
        knowledge: {
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE" as const,
          runId: "replay-run",
          sequence: 42,
          at: "2026-09-11T15:00:00.000Z",
        },
      }),
    };
    const result = qualifyFundedExecutionRows({
      cohort: { ...cohort, sourceKind: "HISTORICAL_REPLAY" },
      rows: [leaked, ...rows.slice(1)],
      requestedCutoff: cutoff,
    });
    expect(result.excludedCounts.LABEL_AFTER_CHRONOLOGICAL_BOUNDARY).toBe(1);
    expect(result.receipt.qualified).toBe(false);
  });

  it("excludes rows from runs that are not completed LIVE runs", () => {
    const rows = qualifyingRows();
    const ineligible = {
      ...rows[0]!,
      runId: "replay-run",
      runSource: "BACKTEST",
      runStatus: "RUNNING",
    };
    const result = qualify([ineligible, ...rows.slice(1)]);
    expect(result.excludedCounts.SOURCE_RUN_NOT_ELIGIBLE).toBe(1);
  });

  it("does not require LIVE runs for an isolated historical-replay cohort", () => {
    const rows = qualifyingRows().map((entry, index) => ({
      ...entry,
      sourceKind: "HISTORICAL_REPLAY" as const,
      runId: "replay-run",
      runSource: "BACKTEST",
      runStatus: "COMPLETED",
      observationId: `${entry.observationId}-${index}`,
    }));
    const result = qualifyFundedExecutionRows({
      cohort: {
        ...cohort,
        sourceKind: "HISTORICAL_REPLAY",
        cohortDigest: digest,
      },
      rows,
      requestedCutoff: cutoff,
    });
    expect(result.receipt.liveRunRequired).toBe(false);
    expect(result.receipt.qualified).toBe(true);
  });

  it("counts unknown exclusions separately from definitive exclusions", () => {
    const rows = qualifyingRows();
    const excluded = [
      {
        ...rows[0]!,
        observationId: "vetoed",
        verdict: "EXCLUDED" as const,
        exclusionReason: "RISK_VETOED" as const,
        unknown: false,
        labels: null,
      },
      {
        ...rows[1]!,
        observationId: "unresolved",
        verdict: "EXCLUDED" as const,
        exclusionReason: "UNRESOLVED" as const,
        unknown: true,
        labels: null,
      },
    ];
    const result = qualify([...rows, ...excluded]);
    expect(result.excludedCounts.RISK_VETOED).toBe(1);
    expect(result.excludedCounts.UNRESOLVED).toBe(1);
    expect(result.unknownCounts.RISK_VETOED).toBeUndefined();
    expect(result.unknownCounts.UNRESOLVED).toBe(1);
    expect(result.receipt.qualified).toBe(true);
  });

  it("exposes the frozen policy floors", () => {
    expect(FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumRows).toBe(200);
    expect(FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumNewRows).toBe(50);
    expect(FUNDED_EXECUTION_QUALIFICATION_POLICY.version).toBe(
      "funded-execution-qualification-v1",
    );
  });
});
