import type {
  BacktestEvidenceReport,
  BacktestReplayResult,
  CreateBacktest,
} from "@tsx-scanner/contracts";

export const ARCHIVE_RESULT_WARNING =
  "Historical archive replay (ADR-019): Massive bars with Databento XNAS.BASIC minute-sampled bid/ask. One synthetic quote per minute; volume and spreads follow provider rules and differ from Questrade. Exploratory only.";

export function isArchiveRun(
  input: Pick<CreateBacktest, "dataSource">,
): boolean {
  return input.dataSource === "HISTORICAL_ARCHIVE";
}

/**
 * Archive runs replay provider history, not captured Questrade quotes. Their
 * spread disclosure is `ARCHIVED` so every consumer that requires `CAPTURED`
 * (statistical training, signal-model research) keeps rejecting them.
 */
export function discloseArchiveResult(
  result: BacktestReplayResult,
): BacktestReplayResult {
  return {
    ...result,
    dataQuality: {
      ...result.dataQuality,
      spread:
        result.dataQuality.spread === "CAPTURED"
          ? "ARCHIVED"
          : result.dataQuality.spread,
      warnings: [ARCHIVE_RESULT_WARNING, ...result.dataQuality.warnings],
    },
  };
}

/** Archive evidence never qualifies, whatever its sample statistics show. */
export function discloseArchiveEvidence(
  evidence: BacktestEvidenceReport,
): BacktestEvidenceReport {
  return {
    ...evidence,
    qualification: "EXPLORATORY",
    warnings: [
      "Historical archive runs are exploratory and cannot qualify evidence (ADR-019).",
      ...evidence.warnings,
    ],
  };
}
