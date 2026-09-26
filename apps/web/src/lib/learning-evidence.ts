import type {
  LearningDashboardOverview,
  MarketId,
} from "@tsx-scanner/contracts";

export type EvidenceReadiness =
  LearningDashboardOverview["evidenceReadiness"][number];

/** A strategy with no new closed outcome for this many days is shown as quiet. */
export const QUIET_AFTER_DAYS = 7;

export function cohortKey(readiness: EvidenceReadiness): string {
  const { cohort } = readiness;
  return `${cohort.profileConfigId}:${cohort.configVersion}:${cohort.executionModelVersion}`;
}

/** Numeric generation of an execution model version such as
 * `paper-execution-v7`; unparseable versions sort first. */
export function executionModelRank(version: string): number {
  const match = /(\d+)$/.exec(version);
  return match ? Number(match[1]) : -1;
}

/**
 * The learning overview is not market-scoped, so the page filters it to the
 * selected market before summarizing. Cohorts on that market's newest
 * execution model are current; earlier models stay available as older
 * cohorts for audit.
 */
export function splitEvidence(
  readiness: readonly EvidenceReadiness[],
  marketId: MarketId,
): {
  market: EvidenceReadiness[];
  current: EvidenceReadiness[];
  older: EvidenceReadiness[];
  currentModel: string | null;
} {
  const market = readiness.filter((row) => row.cohort.marketId === marketId);
  const currentModel = market.reduce<string | null>(
    (best, row) =>
      best === null ||
      executionModelRank(row.cohort.executionModelVersion) >
        executionModelRank(best)
        ? row.cohort.executionModelVersion
        : best,
    null,
  );
  const current = market
    .filter((row) => row.cohort.executionModelVersion === currentModel)
    .sort((left, right) => right.closedQuoteCount - left.closedQuoteCount);
  const older = market.filter(
    (row) => row.cohort.executionModelVersion !== currentModel,
  );
  return { market, current, older, currentModel };
}

/** Whole days since the cohort's last signal, or null when none is recorded. */
export function daysSinceSignal(
  readiness: EvidenceReadiness,
  now: number,
): number | null {
  const last = readiness.cohort.lastSignalAt;
  if (!last) return null;
  return Math.floor(Math.max(0, now - Date.parse(last)) / 86_400_000);
}
