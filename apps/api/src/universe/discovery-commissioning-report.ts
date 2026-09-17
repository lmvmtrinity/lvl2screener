import type {
  DiscoveryEvidence,
  DiscoveryRequestUsage,
  DiscoveryRun,
  MarketId,
} from "@tsx-scanner/contracts";
import type { CatalogSnapshot } from "./eodhd-catalog.js";

/** Fixed WP6 gates. These values mirror the plan and are not runtime filters. */
export const DISCOVERY_COMMISSIONING_TARGETS = Object.freeze({
  /**
   * Evaluated-coverage target from the commissioning protocol: PASS, FAIL or
   * UNEVALUABLE over the admitted denominator.
   */
  minimumEligibleCoverage: 0.99,
  /**
   * Valid-decision coverage adopted prospectively under ADR-017: only admitted
   * PASS and FAIL count, per cycle and market, against the unchanged frozen
   * admitted denominator. Unknown, deferred, missing or structurally excluded
   * outcomes do not qualify, and a zero-opportunity cycle passes only through
   * valid FAIL decisions.
   */
  minimumValidDecisionCoverage: 0.99,
  maximumP95Ms: 120_000,
  maximumActiveMonitoringIncrease: 0.1,
});

export interface DiscoveryCommissioningSession {
  sessionId: string;
  marketId: MarketId;
  catalog: CatalogSnapshot;
  run: DiscoveryRun;
  /** All evaluations for the frozen run, not a bounded UI page. */
  evaluations: readonly DiscoveryEvidence[];
  cycleP95Ms: number | null;
  queueP95Ms: number | null;
  activeMonitoringBaselineP95Ms: number | null;
  activeMonitoringP95Ms: number | null;
  requestUsage: DiscoveryRequestUsage;
}

export interface DiscoveryCommissioningReport {
  sessionId: string;
  marketId: MarketId;
  fullCatalogRows: number;
  structurallyExcludedRows: number;
  admittedRows: number;
  evaluatedAdmittedRows: number;
  validDecisionAdmittedRows: number;
  deferredAdmittedRows: number;
  missingAdmittedRows: number;
  eligibleCoverageFraction: number | null;
  validDecisionCoverageFraction: number | null;
  deferredFraction: number | null;
  outcomes: {
    pass: number;
    fail: number;
    unevaluable: number;
    deferred: number;
  };
  cycleP95Ms: number | null;
  queueP95Ms: number | null;
  activeMonitoringBaselineP95Ms: number | null;
  activeMonitoringP95Ms: number | null;
  activeMonitoringIncreaseFraction: number | null;
  requestUsage: DiscoveryRequestUsage;
  integrityErrors: string[];
  gates: {
    completeEvidence: boolean;
    eligibleCoverage: boolean;
    validDecisionCoverage: boolean;
    cycleP95: boolean;
    queueP95: boolean;
    activeMonitoringImpact: boolean;
  };
  passed: boolean;
}

function identityKey(exchange: string, code: string): string {
  return JSON.stringify([exchange, code]);
}

function finiteNonNegative(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/**
 * Builds a fail-closed, evidence-backed WP6 session report. The caller must provide every
 * evaluation for the frozen run; a paginated UI page is intentionally insufficient.
 */
export function evaluateDiscoveryCommissioningSession(
  input: DiscoveryCommissioningSession,
): DiscoveryCommissioningReport {
  const integrityErrors: string[] = [];
  const catalogKeys = new Set(
    input.catalog.members.map((member) =>
      identityKey(member.raw.Exchange, member.providerCode),
    ),
  );
  const admittedKeys = new Set(
    input.catalog.members
      .filter((member) => member.reasons.length === 0)
      .map((member) => identityKey(member.raw.Exchange, member.providerCode)),
  );
  const evaluationByKey = new Map<string, DiscoveryEvidence["result"]>();
  const outcomes = { pass: 0, fail: 0, unevaluable: 0, deferred: 0 };

  if (input.catalog.marketId !== input.marketId)
    integrityErrors.push("catalog market does not match session market");
  if (input.run.marketId !== input.marketId)
    integrityErrors.push("run market does not match session market");
  if (input.catalog.tradingDate !== input.run.tradingDate)
    integrityErrors.push(
      "catalog trading date does not match run trading date",
    );
  if (input.run.catalogDigest !== input.catalog.digest)
    integrityErrors.push("run catalog digest does not match frozen catalog");
  if (input.catalog.rowCount !== input.catalog.members.length)
    integrityErrors.push("catalog rowCount does not match captured members");

  for (const evidence of input.evaluations) {
    const result = evidence.result;
    const key = identityKey(result.providerExchange, result.providerCode);
    if (result.marketId !== input.marketId)
      integrityErrors.push(
        `evaluation ${result.providerCode} has wrong market`,
      );
    if (result.tradingDate !== input.run.tradingDate)
      integrityErrors.push(
        `evaluation ${result.providerCode} has wrong trading date`,
      );
    if (evidence.runId !== input.run.id)
      integrityErrors.push(`evaluation ${result.providerCode} has wrong run`);
    if (evaluationByKey.has(key)) {
      integrityErrors.push(
        `duplicate evaluation ${result.providerExchange}:${result.providerCode}`,
      );
      continue;
    }
    evaluationByKey.set(key, result);
    outcomes[result.state.toLowerCase() as keyof typeof outcomes] += 1;
    if (!catalogKeys.has(key) && result.providerCode !== "__DEFERRED__")
      integrityErrors.push(
        `evaluation ${result.providerExchange}:${result.providerCode} is not in the frozen catalog`,
      );
  }

  const admittedResults = [...admittedKeys].map((key) =>
    evaluationByKey.get(key),
  );
  const evaluatedAdmittedRows = admittedResults.filter(
    (result) =>
      result !== undefined &&
      (result.state === "PASS" ||
        result.state === "FAIL" ||
        result.state === "UNEVALUABLE"),
  ).length;
  const validDecisionAdmittedRows = admittedResults.filter(
    (result) => result?.state === "PASS" || result?.state === "FAIL",
  ).length;
  const deferredAdmittedRows = admittedResults.filter(
    (result) => result?.state === "DEFERRED",
  ).length;
  const missingAdmittedRows = admittedResults.filter(
    (result) => result === undefined,
  ).length;
  if (missingAdmittedRows > 0)
    integrityErrors.push(
      `${missingAdmittedRows} admitted catalog rows have no evaluation`,
    );

  const expectedCoverage = input.run.coverage;
  if (
    expectedCoverage.pass !== outcomes.pass ||
    expectedCoverage.fail !== outcomes.fail ||
    expectedCoverage.unevaluable !== outcomes.unevaluable ||
    expectedCoverage.deferred !== outcomes.deferred ||
    expectedCoverage.total !== input.catalog.rowCount
  )
    integrityErrors.push(
      "run coverage does not match the complete evaluation set",
    );

  const admittedRows = admittedKeys.size;
  if (input.catalog.admittedCount !== admittedRows)
    integrityErrors.push(
      "catalog admittedCount does not match admitted members",
    );
  const eligibleCoverageFraction =
    admittedRows > 0 ? evaluatedAdmittedRows / admittedRows : null;
  const validDecisionCoverageFraction =
    admittedRows > 0 ? validDecisionAdmittedRows / admittedRows : null;
  const deferredFraction =
    admittedRows > 0 ? deferredAdmittedRows / admittedRows : null;
  const activeMonitoringIncreaseFraction =
    finiteNonNegative(input.activeMonitoringBaselineP95Ms) &&
    input.activeMonitoringBaselineP95Ms !== null &&
    input.activeMonitoringBaselineP95Ms > 0 &&
    finiteNonNegative(input.activeMonitoringP95Ms) &&
    input.activeMonitoringP95Ms !== null
      ? (input.activeMonitoringP95Ms - input.activeMonitoringBaselineP95Ms) /
        input.activeMonitoringBaselineP95Ms
      : null;
  const completeEvidence = integrityErrors.length === 0;
  const eligibleCoverage =
    completeEvidence &&
    eligibleCoverageFraction !== null &&
    eligibleCoverageFraction >=
      DISCOVERY_COMMISSIONING_TARGETS.minimumEligibleCoverage;
  const validDecisionCoverage =
    completeEvidence &&
    validDecisionCoverageFraction !== null &&
    validDecisionCoverageFraction >=
      DISCOVERY_COMMISSIONING_TARGETS.minimumValidDecisionCoverage;
  const cycleP95 =
    completeEvidence &&
    finiteNonNegative(input.cycleP95Ms) &&
    input.cycleP95Ms !== null &&
    input.cycleP95Ms < DISCOVERY_COMMISSIONING_TARGETS.maximumP95Ms;
  const queueP95 =
    completeEvidence &&
    finiteNonNegative(input.queueP95Ms) &&
    input.queueP95Ms !== null &&
    input.queueP95Ms < DISCOVERY_COMMISSIONING_TARGETS.maximumP95Ms;
  const activeMonitoringImpact =
    completeEvidence &&
    activeMonitoringIncreaseFraction !== null &&
    activeMonitoringIncreaseFraction <=
      DISCOVERY_COMMISSIONING_TARGETS.maximumActiveMonitoringIncrease;

  return {
    sessionId: input.sessionId,
    marketId: input.marketId,
    fullCatalogRows: input.catalog.rowCount,
    structurallyExcludedRows: input.catalog.members.length - admittedRows,
    admittedRows,
    evaluatedAdmittedRows,
    validDecisionAdmittedRows,
    deferredAdmittedRows,
    missingAdmittedRows,
    eligibleCoverageFraction,
    validDecisionCoverageFraction,
    deferredFraction,
    outcomes,
    cycleP95Ms: input.cycleP95Ms,
    queueP95Ms: input.queueP95Ms,
    activeMonitoringBaselineP95Ms: input.activeMonitoringBaselineP95Ms,
    activeMonitoringP95Ms: input.activeMonitoringP95Ms,
    activeMonitoringIncreaseFraction,
    requestUsage: { ...input.requestUsage },
    integrityErrors,
    gates: {
      completeEvidence,
      eligibleCoverage,
      validDecisionCoverage,
      cycleP95,
      queueP95,
      activeMonitoringImpact,
    },
    passed:
      completeEvidence &&
      eligibleCoverage &&
      validDecisionCoverage &&
      cycleP95 &&
      queueP95 &&
      activeMonitoringImpact,
  };
}
