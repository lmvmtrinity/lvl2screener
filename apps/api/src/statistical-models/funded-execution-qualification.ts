import {
  FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
  type FundedCohortIdentity,
  type FundedExecutionDatasetCounts,
  type FundedExecutionExclusionReason,
  type FundedExecutionFeatureVector,
  type FundedExecutionLabels,
  type FundedExecutionPartition,
  type FundedExecutionQualificationReceipt,
} from "@tsx-scanner/contracts";

/**
 * Compatible funded-execution cohort qualification (FP02).
 *
 * This is a separate implementation from the signal-quality qualification in
 * `paper-evidence-qualification.ts`. It preserves the ADR-011 floors (200
 * usable rows and 50 new rows before a subsequent dataset) and adds funded
 * execution gates: completed LIVE runs for automatically trainable challengers,
 * chronological ordering, exposure-overlap purging, a frozen chronological
 * train/test split, label availability before the holdout boundary, and
 * class/cost-coverage requirements. A failure returns a visible NOOP reason;
 * no gate is weakened to obtain a dataset.
 */

export const FUNDED_EXECUTION_QUALIFICATION_POLICY = {
  version: FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
  minimumRows: 200,
  minimumNewRows: 50,
  minimumTrainRows: 100,
  minimumTestRows: 40,
  minimumDistinctSessions: 4,
  trainPct: 80,
} as const;

export interface FundedExecutionAssembledRow {
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly currency: "CAD" | "USD";
  readonly accountId: string;
  readonly runId: string;
  readonly observationId: string;
  readonly decisionSequence: number;
  readonly decisionContentDigest: string;
  readonly cohortDigest: string;
  readonly sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
  readonly action: "SUBMIT" | "DECLINE" | "DEFER";
  readonly decisionAt: string;
  readonly runSource: string;
  readonly runStatus: string;
  readonly instrumentId: string | null;
  readonly sessionDate: string;
  readonly verdict: "INCLUDED" | "EXCLUDED";
  readonly exclusionReason: FundedExecutionExclusionReason | null;
  readonly unknown: boolean;
  readonly features: FundedExecutionFeatureVector | null;
  readonly labels: FundedExecutionLabels | null;
  readonly outcomeSequences: readonly number[];
  readonly outcomeSourceDigests: readonly string[];
  readonly exposureEndAt: string;
}

export interface FundedExecutionQualifiedRow extends FundedExecutionAssembledRow {
  readonly partition: FundedExecutionPartition;
}

export interface FundedExecutionPriorDataset {
  readonly id: string;
  /**
   * Stable member identities (`runId:observationId`) frozen in the prior
   * dataset. New-outcome counting is by identity, so a corrected or otherwise
   * changed row for an existing decision is never counted as new.
   */
  readonly memberIdentityKeys: ReadonlySet<string>;
  readonly includedRowCount: number;
}

export interface FundedExecutionQualificationResult {
  readonly receipt: FundedExecutionQualificationReceipt;
  readonly excludedCounts: Record<string, number>;
  readonly unknownCounts: Record<string, number>;
  /** Included train/test membership after every purge. Empty on a NOOP. */
  readonly qualifiedRows: FundedExecutionQualifiedRow[];
}

export function qualifyFundedExecutionRows(input: {
  cohort: FundedCohortIdentity;
  rows: readonly FundedExecutionAssembledRow[];
  requestedCutoff: Date;
  priorDataset?: FundedExecutionPriorDataset | null;
}): FundedExecutionQualificationResult {
  const excludedCounts: Record<string, number> = {};
  const unknownCounts: Record<string, number> = {};
  const exclude = (reason: string, unknown: boolean) => {
    excludedCounts[reason] = (excludedCounts[reason] ?? 0) + 1;
    if (unknown) unknownCounts[reason] = (unknownCounts[reason] ?? 0) + 1;
  };
  const reasons: string[] = [];
  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const liveRunRequired = input.cohort.sourceKind === "LIVE_PAPER";

  const ordered = [...input.rows].sort(
    (left, right) =>
      Date.parse(left.decisionAt) - Date.parse(right.decisionAt) ||
      left.runId.localeCompare(right.runId) ||
      left.decisionSequence - right.decisionSequence,
  );
  const included: FundedExecutionAssembledRow[] = [];
  const seen = new Set<string>();
  for (const row of ordered) {
    if (row.marketId !== input.cohort.marketId) {
      exclude("MARKET_MISMATCH", false);
      continue;
    }
    if (row.verdict === "EXCLUDED") {
      exclude(row.exclusionReason ?? "UNRESOLVED", row.unknown);
      continue;
    }
    if (
      !row.labels ||
      !row.features ||
      row.exclusionReason !== null ||
      row.unknown
    ) {
      exclude("INVALID_FEATURE_VALUE", true);
      continue;
    }
    const key = `${row.runId}:${row.observationId}`;
    if (seen.has(key)) {
      exclude("DUPLICATE_DECISION_IDENTITY", false);
      continue;
    }
    seen.add(key);
    if (
      liveRunRequired &&
      (row.runSource !== "LIVE" || row.runStatus !== "COMPLETED")
    ) {
      exclude("SOURCE_RUN_NOT_ELIGIBLE", false);
      continue;
    }
    included.push(row);
  }

  // Exposure-overlap purge: a later decision on the same instrument cannot be
  // independent while an earlier decision's exposure interval is still open.
  const afterOverlap: FundedExecutionAssembledRow[] = [];
  const exposureEndByInstrument = new Map<string, number>();
  for (const row of included) {
    const instrumentKey =
      row.instrumentId ?? `decision:${row.runId}:${row.observationId}`;
    const previousEnd = exposureEndByInstrument.get(instrumentKey);
    const decisionAt = Date.parse(row.decisionAt);
    if (previousEnd !== undefined && decisionAt < previousEnd) {
      exclude("OVERLAPPING_EXPOSURE", false);
      continue;
    }
    afterOverlap.push(row);
    exposureEndByInstrument.set(
      instrumentKey,
      Math.max(decisionAt, Date.parse(row.exposureEndAt)),
    );
  }

  const sessionDates = [
    ...new Set(afterOverlap.map((row) => row.sessionDate)),
  ].sort();
  const split = chronologicalSplit(afterOverlap, sessionDates);
  const boundaryFirst = split.test[0]
    ? Date.parse(split.test[0].decisionAt)
    : Number.POSITIVE_INFINITY;
  const train: FundedExecutionQualifiedRow[] = [];
  for (const row of split.train) {
    // A label observed at or after the first holdout decision was unavailable
    // while the model would have been trained. Chronology uses the label's
    // knowledge coordinate: for live capture it is the database knowledge time,
    // while a historical replay uses its proven applied-fact sequence point so
    // a wall-clock capture time can never leak backward into the replay.
    if (Date.parse(row.labels!.knowledge.at) >= boundaryFirst) {
      exclude("LABEL_AFTER_CHRONOLOGICAL_BOUNDARY", false);
      continue;
    }
    train.push({ ...row, partition: "TRAIN" });
  }
  const test: FundedExecutionQualifiedRow[] = split.test.map((row) => ({
    ...row,
    partition: "TEST",
  }));
  const qualifiedRows = [...train, ...test];

  const fillLabel = (row: FundedExecutionQualifiedRow) =>
    row.labels!.fillProbability;
  const trainFillPositives = train.filter((row) => fillLabel(row) === 1).length;
  const trainFillNegatives = train.filter((row) => fillLabel(row) === 0).length;
  const testFillPositives = test.filter((row) => fillLabel(row) === 1).length;
  const testFillNegatives = test.filter((row) => fillLabel(row) === 0).length;
  const trainCostLabelCount = train.filter(
    (row) => row.labels!.costLabelAvailable,
  ).length;
  const testCostLabelCount = test.filter(
    (row) => row.labels!.costLabelAvailable,
  ).length;

  const newOutcomesSincePrior = input.priorDataset
    ? qualifiedRows.filter(
        (row) =>
          !input.priorDataset!.memberIdentityKeys.has(
            `${row.runId}:${row.observationId}`,
          ),
      ).length
    : qualifiedRows.length;
  const counts: FundedExecutionDatasetCounts = {
    sourceRowCount: input.rows.length,
    usableRowCount: afterOverlap.length,
    includedRowCount: qualifiedRows.length,
    trainRowCount: train.length,
    testRowCount: test.length,
    excludedCounts,
    unknownCounts,
  };

  if (qualifiedRows.length < FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumRows)
    addReason(
      `INSUFFICIENT_USABLE_ROWS (${qualifiedRows.length} < ${FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumRows})`,
    );
  if (
    input.priorDataset &&
    newOutcomesSincePrior < FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumNewRows
  )
    addReason(
      `INSUFFICIENT_NEW_OUTCOMES (${newOutcomesSincePrior} < ${FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumNewRows})`,
    );
  if (
    sessionDates.length <
    FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumDistinctSessions
  )
    addReason(
      `INSUFFICIENT_SESSIONS (${sessionDates.length} < ${FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumDistinctSessions})`,
    );
  if (train.length < FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumTrainRows)
    addReason(
      `INSUFFICIENT_CHRONOLOGICAL_TRAIN_ROWS (${train.length} < ${FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumTrainRows})`,
    );
  if (test.length < FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumTestRows)
    addReason(
      `INSUFFICIENT_CHRONOLOGICAL_HOLDOUT_ROWS (${test.length} < ${FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumTestRows})`,
    );
  if (
    trainFillPositives === 0 ||
    trainFillNegatives === 0 ||
    testFillPositives === 0 ||
    testFillNegatives === 0
  )
    addReason("CHRONOLOGICAL_FILL_CLASS_IMBALANCE");
  if (trainCostLabelCount === 0 || testCostLabelCount === 0)
    addReason("INSUFFICIENT_COST_LABEL_COVERAGE");

  const receipt: FundedExecutionQualificationReceipt = {
    policyVersion: FUNDED_EXECUTION_QUALIFICATION_POLICY.version,
    qualified: reasons.length === 0,
    reasons,
    minimumRows: FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumRows,
    minimumNewRows: FUNDED_EXECUTION_QUALIFICATION_POLICY.minimumNewRows,
    newOutcomesSincePrior: Math.max(0, newOutcomesSincePrior),
    priorDatasetId: input.priorDataset?.id ?? null,
    priorDatasetRowCount: input.priorDataset?.includedRowCount ?? null,
    liveRunRequired,
    distinctSessionCount: sessionDates.length,
    chronologicalSplitAt: test[0]?.decisionAt ?? null,
    trainFillPositives,
    trainFillNegatives,
    testFillPositives,
    testFillNegatives,
    trainCostLabelCount,
    testCostLabelCount,
    counts,
  };

  return {
    receipt,
    excludedCounts,
    unknownCounts,
    qualifiedRows: reasons.length === 0 ? qualifiedRows : [],
  };
}

function chronologicalSplit(
  rows: readonly FundedExecutionAssembledRow[],
  dates: readonly string[],
): {
  train: FundedExecutionAssembledRow[];
  test: FundedExecutionAssembledRow[];
} {
  if (dates.length < 2) return { train: [...rows], test: [] };
  const count = Math.max(
    1,
    Math.min(
      dates.length - 1,
      Math.floor(
        (dates.length * FUNDED_EXECUTION_QUALIFICATION_POLICY.trainPct) / 100,
      ),
    ),
  );
  const trainDates = new Set(dates.slice(0, count));
  return {
    train: rows.filter((row) => trainDates.has(row.sessionDate)),
    test: rows.filter((row) => !trainDates.has(row.sessionDate)),
  };
}
