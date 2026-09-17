import type {
  MarketId,
  PaperEvidenceCohort,
  PaperEvidenceResearchQualification,
  PaperEvidenceTrainingRow,
  PaperEvidenceWalkForwardWindow,
} from "@tsx-scanner/contracts";

export const PAPER_EVIDENCE_RESEARCH_POLICY = {
  version: "paper-research-qualification-v2",
  minimumRows: 200,
  minimumTrainRows: 100,
  minimumHoldoutRows: 40,
  minimumRowsPerWalkForwardTest: 30,
  minimumWalkForwardWindows: 3,
  trainPct: 80,
} as const;

export type PaperEvidenceQualificationResult = {
  readonly qualification: PaperEvidenceResearchQualification;
  /** Rows after availability, identity, and overlap purging. */
  readonly acceptedRows: PaperEvidenceTrainingRow[];
  /** Rows belonging to the frozen final chronological train/holdout partition. */
  readonly qualifiedRows: PaperEvidenceTrainingRow[];
};

/**
 * Fail-closed research qualification for paper evidence. Signal time defines
 * chronology, exit time defines label availability, and overlapping labels on
 * one instrument are purged rather than allowed to leak information across a
 * chronological split.
 */
export function qualifyPaperEvidence(input: {
  cohort: PaperEvidenceCohort;
  rows: readonly PaperEvidenceTrainingRow[];
  requestedCutoff: Date;
  marketId?: MarketId;
}): PaperEvidenceQualificationResult {
  const cutoff = input.requestedCutoff.getTime();
  const excludedCounts: Record<string, number> = {};
  const exclude = (reason: string) => {
    excludedCounts[reason] = (excludedCounts[reason] ?? 0) + 1;
  };
  const reasons: string[] = [];
  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (
    !input.cohort.signalSemanticsVersion ||
    input.cohort.signalSemanticsVersion === "UNKNOWN"
  )
    addReason("MISSING_SIGNAL_SEMANTICS_PROVENANCE");
  if (!input.cohort.replayScope || input.cohort.replayScope === "UNKNOWN")
    addReason("MISSING_REPLAY_SCOPE_PROVENANCE");

  const ordered = [...input.rows].sort(
    (left, right) =>
      Date.parse(left.signalTimestamp) - Date.parse(right.signalTimestamp) ||
      left.sourceKey.localeCompare(right.sourceKey),
  );
  const usable: PaperEvidenceTrainingRow[] = [];
  const seenKeys = new Set<string>();
  for (const row of ordered) {
    if (row.marketId !== input.cohort.marketId) {
      exclude("MARKET_MISMATCH");
      continue;
    }
    if (seenKeys.has(row.sourceKey)) {
      exclude("DUPLICATE_SOURCE_KEY");
      continue;
    }
    seenKeys.add(row.sourceKey);
    if (!row.instrumentId) {
      exclude("MISSING_INSTRUMENT_PROVENANCE");
      continue;
    }
    if (!row.labelAvailableAt) {
      exclude("MISSING_LABEL_AVAILABILITY");
      continue;
    }
    const signalAt = Date.parse(row.signalTimestamp);
    const labelAt = Date.parse(row.labelAvailableAt);
    if (
      !Number.isFinite(signalAt) ||
      !Number.isFinite(labelAt) ||
      labelAt < signalAt
    ) {
      exclude("INVALID_LABEL_ORDER");
      continue;
    }
    if (labelAt > cutoff) {
      exclude("LABEL_NOT_AVAILABLE_AT_CUTOFF");
      continue;
    }
    usable.push(row);
  }

  // A later signal on the same instrument cannot enter the same frozen sample
  // while an earlier trade's label is still unresolved. Keep the earlier row
  // and purge the later one conservatively.
  const acceptedRows: PaperEvidenceTrainingRow[] = [];
  const lastLabelByInstrument = new Map<string, number>();
  for (const row of usable) {
    const signalAt = Date.parse(row.signalTimestamp);
    const previousLabelAt = lastLabelByInstrument.get(row.instrumentId!);
    if (previousLabelAt !== undefined && signalAt < previousLabelAt) {
      exclude("OVERLAPPING_LABEL");
      continue;
    }
    acceptedRows.push(row);
    lastLabelByInstrument.set(
      row.instrumentId!,
      Date.parse(row.labelAvailableAt!),
    );
  }

  const sessionDates = [
    ...new Set(
      acceptedRows.map((row) =>
        localSessionDate(row, input.marketId ?? input.cohort.marketId),
      ),
    ),
  ].sort();
  const marketId = input.marketId ?? input.cohort.marketId;
  const split = chronologicalSplit(acceptedRows, sessionDates, marketId);
  const partitionKeys = new Set([
    ...split.train.map((row) => row.sourceKey),
    ...split.test.map((row) => row.sourceKey),
  ]);
  const boundaryPurged = acceptedRows.length - partitionKeys.size;
  if (boundaryPurged > 0)
    excludedCounts.LABEL_AFTER_CHRONOLOGICAL_BOUNDARY = boundaryPurged;
  const windows = walkForwardWindows(acceptedRows, sessionDates, marketId);

  if (partitionKeys.size < PAPER_EVIDENCE_RESEARCH_POLICY.minimumRows)
    addReason(
      `INSUFFICIENT_PURGED_ROWS (${partitionKeys.size} < ${PAPER_EVIDENCE_RESEARCH_POLICY.minimumRows})`,
    );
  if (sessionDates.length < 4)
    addReason(`INSUFFICIENT_SESSIONS (${sessionDates.length} < 4)`);
  if (split.train.length < PAPER_EVIDENCE_RESEARCH_POLICY.minimumTrainRows)
    addReason(
      `INSUFFICIENT_CHRONOLOGICAL_TRAIN_ROWS (${split.train.length} < ${PAPER_EVIDENCE_RESEARCH_POLICY.minimumTrainRows})`,
    );
  if (split.test.length < PAPER_EVIDENCE_RESEARCH_POLICY.minimumHoldoutRows)
    addReason(
      `INSUFFICIENT_CHRONOLOGICAL_HOLDOUT_ROWS (${split.test.length} < ${PAPER_EVIDENCE_RESEARCH_POLICY.minimumHoldoutRows})`,
    );
  if (!bothClasses(split.train) || !bothClasses(split.test))
    addReason("CHRONOLOGICAL_CLASS_IMBALANCE");
  if (windows.length < PAPER_EVIDENCE_RESEARCH_POLICY.minimumWalkForwardWindows)
    addReason(
      `INSUFFICIENT_WALK_FORWARD_WINDOWS (${windows.length} < ${PAPER_EVIDENCE_RESEARCH_POLICY.minimumWalkForwardWindows})`,
    );
  for (const window of windows) {
    if (
      window.testRows <
      PAPER_EVIDENCE_RESEARCH_POLICY.minimumRowsPerWalkForwardTest
    )
      addReason(`INSUFFICIENT_WALK_FORWARD_TEST_ROWS (window ${window.index})`);
    if (window.testExpectancy <= 0)
      addReason(
        `NON_POSITIVE_WALK_FORWARD_EXPECTANCY (window ${window.index})`,
      );
  }

  const qualification: PaperEvidenceResearchQualification = {
    policyVersion: PAPER_EVIDENCE_RESEARCH_POLICY.version,
    qualified: reasons.length === 0,
    reasons,
    sourceRowCount: input.rows.length,
    acceptedRowCount: partitionKeys.size,
    distinctSessionCount: sessionDates.length,
    chronologicalSplitAt: split.test[0]?.signalTimestamp ?? null,
    walkForwardWindows: windows,
    excludedCounts,
    chronologicalTrainSourceKeys: split.train.map((row) => row.sourceKey),
    chronologicalTestSourceKeys: split.test.map((row) => row.sourceKey),
  };
  const qualifiedKeys = new Set([
    ...split.train.map((row) => row.sourceKey),
    ...split.test.map((row) => row.sourceKey),
  ]);
  return {
    qualification,
    acceptedRows,
    qualifiedRows: acceptedRows.filter((row) =>
      qualifiedKeys.has(row.sourceKey),
    ),
  };
}

function chronologicalSplit(
  rows: readonly PaperEvidenceTrainingRow[],
  dates: readonly string[],
  marketId: MarketId,
): { train: PaperEvidenceTrainingRow[]; test: PaperEvidenceTrainingRow[] } {
  if (dates.length < 2) return { train: [...rows], test: [] };
  const count = Math.max(
    1,
    Math.min(
      dates.length - 1,
      Math.floor(
        (dates.length * PAPER_EVIDENCE_RESEARCH_POLICY.trainPct) / 100,
      ),
    ),
  );
  const trainDates = new Set(dates.slice(0, count));
  const test = rows.filter(
    (row) => !trainDates.has(localSessionDate(row, marketId)),
  );
  const testStart = Math.min(
    ...test.map((row) => Date.parse(row.signalTimestamp)),
  );
  // A label observed on or after the first holdout signal was unavailable while
  // the model would have been trained. Purge it even when it belongs to an
  // earlier session; session-only splitting is insufficient for long labels.
  const train = rows.filter(
    (row) =>
      trainDates.has(localSessionDate(row, marketId)) &&
      Date.parse(row.labelAvailableAt!) < testStart,
  );
  return { train, test };
}

function walkForwardWindows(
  rows: readonly PaperEvidenceTrainingRow[],
  dates: readonly string[],
  marketId: MarketId,
): PaperEvidenceWalkForwardWindow[] {
  if (dates.length < 4) return [];
  const blockSize = Math.max(1, Math.floor(dates.length / 4));
  const blocks: string[][] = [];
  for (let index = 0; index < 4; index += 1)
    blocks.push(
      dates.slice(
        index * blockSize,
        index === 3 ? dates.length : (index + 1) * blockSize,
      ),
    );
  return [1, 2, 3].flatMap((index) => {
    const trainDates = blocks.slice(0, index).flat();
    const testDates = blocks[index] ?? [];
    const testStart = Math.min(
      ...rows
        .filter((row) => testDates.includes(localSessionDate(row, marketId)))
        .map((row) => Date.parse(row.signalTimestamp)),
    );
    const train = rows.filter(
      (row) =>
        trainDates.includes(localSessionDate(row, marketId)) &&
        Date.parse(row.labelAvailableAt!) < testStart,
    );
    const test = rows.filter((row) =>
      testDates.includes(localSessionDate(row, marketId)),
    );
    if (!train.length || !test.length) return [];
    return [
      {
        index,
        trainStart: trainDates[0]!,
        trainEnd: trainDates.at(-1)!,
        testStart: testDates[0]!,
        testEnd: testDates.at(-1)!,
        trainRows: train.length,
        testRows: test.length,
        testExpectancy: mean(test.map((row) => row.rMultiple)),
        testWinRate:
          test.filter((row) => row.rMultiple > 0).length / test.length,
      },
    ];
  });
}

function bothClasses(rows: readonly PaperEvidenceTrainingRow[]): boolean {
  return (
    rows.some((row) => row.rMultiple > 0) &&
    rows.some((row) => row.rMultiple <= 0)
  );
}

function localSessionDate(
  row: PaperEvidenceTrainingRow,
  marketId: MarketId,
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:
      marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(row.signalTimestamp));
}

function mean(values: readonly number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
