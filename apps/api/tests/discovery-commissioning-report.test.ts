import { describe, expect, it } from "vitest";
import type { DiscoveryEvidence, DiscoveryRun } from "@tsx-scanner/contracts";
import {
  evaluateDiscoveryCommissioningSession,
  type DiscoveryCommissioningSession,
} from "../src/universe/discovery-commissioning-report.js";
import type { CatalogSnapshot } from "../src/universe/eodhd-catalog.js";

const catalog: CatalogSnapshot = {
  source: "EODHD",
  marketId: "CA_TSX",
  tradingDate: "2026-09-09",
  fetchedAt: "2026-09-09T14:00:00.000Z",
  digest: "a".repeat(64),
  providerDigest: null,
  rowCount: 3,
  admittedCount: 2,
  members: [
    {
      providerCode: "PASS",
      raw: {
        Code: "PASS",
        Name: "Passing stock",
        Exchange: "TSX",
        Currency: "CAD",
        Type: "Common Stock",
      },
      reasons: [],
      resolutionStatus: "PENDING",
    },
    {
      providerCode: "FAIL",
      raw: {
        Code: "FAIL",
        Name: "Failing stock",
        Exchange: "TSX",
        Currency: "CAD",
        Type: "Common Stock",
      },
      reasons: [],
      resolutionStatus: "PENDING",
    },
    {
      providerCode: "ETF",
      raw: {
        Code: "ETF",
        Name: "Review required",
        Exchange: "TSX",
        Currency: "CAD",
        Type: "ETF",
      },
      reasons: ["CLASSIFICATION_REVIEW_REQUIRED"],
      resolutionStatus: "REVIEW_REQUIRED",
    },
  ],
};

const run: DiscoveryRun = {
  id: "00000000-0000-4000-8000-000000000001",
  marketId: "CA_TSX",
  tradingDate: "2026-09-09",
  policyVersion: "ca-discovery-v1",
  mode: "SHADOW",
  evaluationAt: "2026-09-09T14:00:00.000Z",
  completedBarEnd: "2026-09-09T13:55:00.000Z",
  catalogDigest: catalog.digest,
  status: "COMPLETED",
  coverage: { total: 3, pass: 1, fail: 1, unevaluable: 1, deferred: 0 },
  startedAt: "2026-09-09T14:00:00.000Z",
  completedAt: "2026-09-09T14:00:01.000Z",
  failure: null,
};

function evidence(
  providerCode: string,
  state: "PASS" | "FAIL" | "UNEVALUABLE",
  reasons: DiscoveryEvidence["result"]["reasons"],
  providerExchange = "TSX",
  runId = run.id,
): DiscoveryEvidence {
  return {
    id: `00000000-0000-4000-8000-${providerCode.padStart(12, "0")}`,
    runId,
    result: {
      marketId: "CA_TSX",
      policyVersion: "ca-discovery-v1",
      providerCode,
      symbolId: state === "UNEVALUABLE" ? null : 123,
      providerExchange,
      tradingDate: run.tradingDate,
      evaluationAt: run.evaluationAt,
      computedAt: "2026-09-09T14:00:01.000Z",
      completedBarEnd: run.completedBarEnd,
      state,
      reasons,
      metrics: {
        price: { value: null, asOf: null },
        marketCap: { value: null, asOf: null },
        averageVolume90d: { value: null, asOf: null },
        averageVolume30d: { value: null, asOf: null },
        atr14: { value: null, asOf: null },
        atrPct: { value: null, asOf: null },
        relativeVolume: { value: null, asOf: null },
        changeFromOpenPct: { value: null, asOf: null },
        dollarVolume30d: { value: null, asOf: null },
      },
    },
    inputDigest: null,
    input: null,
    inputRetained: false,
  };
}

function session(
  evaluations: readonly DiscoveryEvidence[],
): DiscoveryCommissioningSession {
  return {
    sessionId: "ca-2026-09-09-session-1",
    marketId: "CA_TSX",
    catalog,
    run,
    evaluations,
    cycleP95Ms: 100_000,
    queueP95Ms: 110_000,
    activeMonitoringBaselineP95Ms: 100,
    activeMonitoringP95Ms: 109,
    requestUsage: { completed: 10, failed: 1, cancelled: 0, expired: 0 },
  };
}

/**
 * Scalable admitted denominator so the adopted ADR-017 0.99 valid-decision
 * boundary can be exercised exactly. PASS and FAIL alternate across valid
 * members; the remaining admitted rows and the structurally excluded row are
 * UNEVALUABLE.
 */
function scaledSession(input: {
  validCount: number;
  unevaluableCount: number;
}): DiscoveryCommissioningSession {
  const admitted = input.validCount + input.unevaluableCount;
  const codes = Array.from(
    { length: admitted },
    (_, index) => `S${String(index).padStart(4, "0")}`,
  );
  const members: CatalogSnapshot["members"] = [
    ...codes.map((code): CatalogSnapshot["members"][number] => ({
      providerCode: code,
      raw: {
        Code: code,
        Name: "Scaled stock",
        Exchange: "TSX",
        Currency: "CAD",
        Type: "Common Stock",
      },
      reasons: [],
      resolutionStatus: "PENDING",
    })),
    {
      providerCode: "ETF",
      raw: {
        Code: "ETF",
        Name: "Review required",
        Exchange: "TSX",
        Currency: "CAD",
        Type: "ETF",
      },
      reasons: ["CLASSIFICATION_REVIEW_REQUIRED"],
      resolutionStatus: "REVIEW_REQUIRED",
    },
  ];
  const pass = Math.ceil(input.validCount / 2);
  const fail = input.validCount - pass;
  const catalogSnapshot: CatalogSnapshot = {
    ...catalog,
    digest: "b".repeat(64),
    rowCount: admitted + 1,
    admittedCount: admitted,
    members,
  };
  const runSnapshot: DiscoveryRun = {
    ...run,
    catalogDigest: catalogSnapshot.digest,
    coverage: {
      total: admitted + 1,
      pass,
      fail,
      unevaluable: input.unevaluableCount + 1,
      deferred: 0,
    },
  };
  return {
    ...session([
      ...codes
        .slice(0, pass)
        .map((code) => evidence(code, "PASS", [], "TSX", runSnapshot.id)),
      ...codes
        .slice(pass, input.validCount)
        .map((code) =>
          evidence(code, "FAIL", ["QUOTE_STALE"], "TSX", runSnapshot.id),
        ),
      ...codes
        .slice(input.validCount)
        .map((code) =>
          evidence(
            code,
            "UNEVALUABLE",
            ["QUOTE_UNAVAILABLE"],
            "TSX",
            runSnapshot.id,
          ),
        ),
      evidence(
        "ETF",
        "UNEVALUABLE",
        ["CLASSIFICATION_REVIEW_REQUIRED"],
        "TSX",
        runSnapshot.id,
      ),
    ]),
    catalog: catalogSnapshot,
    run: runSnapshot,
  };
}

describe("discovery commissioning report", () => {
  it("computes admitted coverage and passes fixed gates from complete evidence", () => {
    const report = evaluateDiscoveryCommissioningSession(
      session([
        evidence("PASS", "PASS", []),
        evidence("FAIL", "FAIL", ["QUOTE_STALE"]),
        evidence("ETF", "UNEVALUABLE", ["CLASSIFICATION_REVIEW_REQUIRED"]),
      ]),
    );
    expect(report).toMatchObject({
      fullCatalogRows: 3,
      structurallyExcludedRows: 1,
      admittedRows: 2,
      evaluatedAdmittedRows: 2,
      validDecisionAdmittedRows: 2,
      deferredAdmittedRows: 0,
      missingAdmittedRows: 0,
      eligibleCoverageFraction: 1,
      validDecisionCoverageFraction: 1,
      deferredFraction: 0,
      passed: true,
      gates: {
        completeEvidence: true,
        eligibleCoverage: true,
        cycleP95: true,
        queueP95: true,
        activeMonitoringImpact: true,
      },
    });
    expect(report.requestUsage).toEqual({
      completed: 10,
      failed: 1,
      cancelled: 0,
      expired: 0,
    });
  });

  it("fails closed when an admitted row is missing and an unknown evaluation is present", () => {
    const report = evaluateDiscoveryCommissioningSession(
      session([
        evidence("PASS", "PASS", []),
        evidence("UNKNOWN", "FAIL", ["QUOTE_STALE"]),
      ]),
    );

    expect(report.missingAdmittedRows).toBe(1);
    expect(report.eligibleCoverageFraction).toBe(0.5);
    expect(report.passed).toBe(false);
    expect(report.gates.completeEvidence).toBe(false);
    expect(report.integrityErrors).toEqual(
      expect.arrayContaining([
        "1 admitted catalog rows have no evaluation",
        "evaluation TSX:UNKNOWN is not in the frozen catalog",
        "run coverage does not match the complete evaluation set",
      ]),
    );
  });

  it("fails the latency and impact gates without changing coverage arithmetic", () => {
    const report = evaluateDiscoveryCommissioningSession({
      ...session([
        evidence("PASS", "PASS", []),
        evidence("FAIL", "FAIL", ["QUOTE_STALE"]),
        evidence("ETF", "UNEVALUABLE", ["CLASSIFICATION_REVIEW_REQUIRED"]),
      ]),
      cycleP95Ms: 120_000,
      queueP95Ms: 120_001,
      activeMonitoringP95Ms: 111,
    });

    expect(report.eligibleCoverageFraction).toBe(1);
    expect(report.gates.eligibleCoverage).toBe(true);
    expect(report.gates.cycleP95).toBe(false);
    expect(report.gates.queueP95).toBe(false);
    expect(report.gates.activeMonitoringImpact).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("adopts the 0.99 valid-decision boundary and fails below it", () => {
    const atBoundary = evaluateDiscoveryCommissioningSession(
      scaledSession({ validCount: 99, unevaluableCount: 1 }),
    );
    expect(atBoundary.admittedRows).toBe(100);
    expect(atBoundary.validDecisionAdmittedRows).toBe(99);
    expect(atBoundary.validDecisionCoverageFraction).toBe(0.99);
    expect(atBoundary.gates).toMatchObject({
      completeEvidence: true,
      eligibleCoverage: true,
      validDecisionCoverage: true,
    });
    expect(atBoundary.passed).toBe(true);

    const belowBoundary = evaluateDiscoveryCommissioningSession(
      scaledSession({ validCount: 98, unevaluableCount: 2 }),
    );
    expect(belowBoundary.validDecisionCoverageFraction).toBe(0.98);
    expect(belowBoundary.gates).toMatchObject({
      eligibleCoverage: true,
      validDecisionCoverage: false,
    });
    expect(belowBoundary.passed).toBe(false);
  });

  it("fails the valid-decision gate when every admitted outcome is unknown", () => {
    const report = evaluateDiscoveryCommissioningSession({
      ...session([
        evidence("PASS", "UNEVALUABLE", ["QUOTE_UNAVAILABLE"]),
        evidence("FAIL", "UNEVALUABLE", ["QUOTE_STALE"]),
        evidence("ETF", "UNEVALUABLE", ["CLASSIFICATION_REVIEW_REQUIRED"]),
      ]),
      run: {
        ...run,
        coverage: { total: 3, pass: 0, fail: 0, unevaluable: 3, deferred: 0 },
      },
    });

    expect(report).toMatchObject({
      admittedRows: 2,
      evaluatedAdmittedRows: 2,
      validDecisionAdmittedRows: 0,
      eligibleCoverageFraction: 1,
      validDecisionCoverageFraction: 0,
      outcomes: { pass: 0, fail: 0, unevaluable: 3, deferred: 0 },
    });
    expect(report.gates).toEqual({
      completeEvidence: true,
      eligibleCoverage: true,
      validDecisionCoverage: false,
      cycleP95: true,
      queueP95: true,
      activeMonitoringImpact: true,
    });
    expect(report.passed).toBe(false);
  });

  it("fails closed on empty admitted denominators and missing evaluations", () => {
    const excludedOnly = catalog.members.filter(
      (member) => member.reasons.length > 0,
    );
    const emptyCatalog: CatalogSnapshot = {
      ...catalog,
      digest: "c".repeat(64),
      rowCount: excludedOnly.length,
      admittedCount: 0,
      members: excludedOnly,
    };
    const empty = evaluateDiscoveryCommissioningSession({
      ...session([
        evidence("ETF", "UNEVALUABLE", ["CLASSIFICATION_REVIEW_REQUIRED"]),
      ]),
      catalog: emptyCatalog,
      run: {
        ...run,
        catalogDigest: emptyCatalog.digest,
        coverage: { total: 1, pass: 0, fail: 0, unevaluable: 1, deferred: 0 },
      },
    });
    expect(empty.admittedRows).toBe(0);
    expect(empty.eligibleCoverageFraction).toBeNull();
    expect(empty.validDecisionCoverageFraction).toBeNull();
    expect(empty.gates).toMatchObject({
      eligibleCoverage: false,
      validDecisionCoverage: false,
    });
    expect(empty.passed).toBe(false);

    const missing = evaluateDiscoveryCommissioningSession(
      session([evidence("PASS", "PASS", [])]),
    );
    expect(missing.missingAdmittedRows).toBe(1);
    expect(missing.gates).toMatchObject({
      completeEvidence: false,
      validDecisionCoverage: false,
    });
    expect(missing.passed).toBe(false);
  });

  it("rejects pooled-market and cross-run evidence instead of crediting it", () => {
    const pooled = evidence(
      "PASS",
      "PASS",
      [],
      "TSX",
      "00000000-0000-4000-8000-0000000000aa",
    );
    const crossMarket = evidence("FAIL", "FAIL", ["QUOTE_STALE"]);
    crossMarket.result = { ...crossMarket.result, marketId: "US_EQUITIES" };
    const report = evaluateDiscoveryCommissioningSession(
      session([pooled, crossMarket, evidence("ETF", "UNEVALUABLE", [])]),
    );

    expect(report.gates).toMatchObject({
      completeEvidence: false,
      validDecisionCoverage: false,
    });
    expect(report.passed).toBe(false);
    expect(report.integrityErrors).toEqual(
      expect.arrayContaining([
        "evaluation PASS has wrong run",
        "evaluation FAIL has wrong market",
      ]),
    );
  });
});
