import { describe, expect, it, vi } from "vitest";
import { TradingViewShadowComparator } from "../src/universe/tradingview-shadow-comparator.js";
import { InMemoryDiscoveryParityStore } from "../src/universe/postgres-discovery-parity-store.js";
import type { TradingViewScannerClient } from "../src/universe/tradingview-scanner-client.js";
import type { PostgresDiscoveryEvidenceStore } from "../src/universe/discovery-evidence-repository.js";
import type {
  DiscoveryEvidence,
  DiscoveryRun,
  TradingViewCandidate,
} from "@tsx-scanner/contracts";

function makeRun(
  id: string,
  marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
): DiscoveryRun {
  return {
    id,
    marketId,
    tradingDate: "2026-11-03",
    policyVersion: "ca-discovery-v1",
    mode: "SHADOW",
    evaluationAt: "2026-11-03T14:40:00.000Z",
    completedBarEnd: "2026-11-03T14:35:00.000Z",
    catalogDigest: "b".repeat(64),
    status: "COMPLETED",
    coverage: { total: 4, pass: 2, fail: 2, unevaluable: 0, deferred: 0 },
    startedAt: "2026-11-03T14:40:00.000Z",
    completedAt: "2026-11-03T14:40:05.000Z",
    failure: null,
  };
}

function makeEvidence(
  runId: string,
  code: string,
  state: "PASS" | "FAIL" | "UNEVALUABLE",
  reasons: any[] = [],
  price = 100,
  rvol = 2.0,
): DiscoveryEvidence {
  return {
    id: `00000000-0000-4000-8000-${code.padEnd(12, "0")}`,
    runId,
    inputDigest: "c".repeat(64),
    inputRetained: true,
    input: null,
    result: {
      marketId: "CA_TSX",
      policyVersion: "ca-discovery-v1",
      providerCode: code,
      providerExchange: "TSX",
      symbolId: 1001,
      tradingDate: "2026-11-03",
      evaluationAt: "2026-11-03T14:40:00.000Z",
      completedBarEnd: "2026-11-03T14:35:00.000Z",
      computedAt: "2026-11-03T14:40:01.000Z",
      state,
      reasons,
      metrics: {
        price: { value: price, asOf: "2026-11-03T14:39:50.000Z" },
        marketCap: { value: 5000000000, asOf: "2026-11-03T14:39:50.000Z" },
        averageVolume90d: { value: 800000, asOf: "2026-11-03T14:39:50.000Z" },
        averageVolume30d: { value: 850000, asOf: "2026-11-03T14:39:50.000Z" },
        atr14: { value: 2.5, asOf: "2026-11-03T14:39:50.000Z" },
        atrPct: { value: 2.5, asOf: "2026-11-03T14:39:50.000Z" },
        relativeVolume: { value: rvol, asOf: "2026-11-03T14:39:50.000Z" },
        changeFromOpenPct: { value: 1.5, asOf: "2026-11-03T14:39:50.000Z" },
        dollarVolume30d: { value: 85000000, asOf: "2026-11-03T14:39:50.000Z" },
      },
    },
  };
}

describe("TradingViewShadowComparator", () => {
  it("audits parity between Questrade discovery runs and TradingView shadow scans", async () => {
    const runId = "10000000-0000-4000-8000-000000000001";
    const run = makeRun(runId);

    // Questrade evaluated:
    // SHOP -> PASS (price: 105, rvol: 2.2)
    // CVE -> PASS (price: 24, rvol: 3.0)
    // BMO -> FAIL (ATR_THRESHOLD)
    // SU -> UNEVALUABLE (CLASSIFICATION_REVIEW_REQUIRED)
    const qtEvaluations: DiscoveryEvidence[] = [
      makeEvidence(runId, "SHOP", "PASS", [], 105, 2.2),
      makeEvidence(runId, "CVE", "PASS", [], 24, 3.0),
      makeEvidence(runId, "BMO", "FAIL", ["ATR_THRESHOLD"], 120, 1.8),
      makeEvidence(
        runId,
        "SU",
        "UNEVALUABLE",
        ["CLASSIFICATION_REVIEW_REQUIRED"],
        50,
        2.1,
      ),
    ];

    // TradingView returned:
    // SHOP (overlapping)
    // BMO (missed mover in Questrade due to ATR_THRESHOLD)
    // ENB (missed mover, not evaluated in Questrade run)
    const tvCandidates: TradingViewCandidate[] = [
      {
        symbol: "SHOP",
        exchange: "TSX",
        fullSymbol: "TSX:SHOP",
        price: 104.8,
        changeFromOpenPct: 1.45,
        relativeVolume: 2.15,
        averageVolume90d: 810000,
        marketCap: 5000000000,
        observedAt: "2026-11-03T14:40:02.000Z",
      },
      {
        symbol: "BMO",
        exchange: "TSX",
        fullSymbol: "TSX:BMO",
        price: 120.5,
        changeFromOpenPct: 0.9,
        relativeVolume: 1.85,
        averageVolume90d: 900000,
        marketCap: 90000000000,
        observedAt: "2026-11-03T14:40:02.000Z",
      },
      {
        symbol: "ENB",
        exchange: "TSX",
        fullSymbol: "TSX:ENB",
        price: 52.0,
        changeFromOpenPct: 1.1,
        relativeVolume: 1.7,
        averageVolume90d: 4000000,
        marketCap: 110000000000,
        observedAt: "2026-11-03T14:40:02.000Z",
      },
    ];

    const mockEvidenceStore = {
      listRuns: vi.fn(async () => [run]),
      listEvaluations: vi.fn(async () => qtEvaluations),
    } as unknown as PostgresDiscoveryEvidenceStore;

    const mockTvClient = {
      scan: vi.fn(async () => tvCandidates),
    } as unknown as TradingViewScannerClient;

    const parityStore = new InMemoryDiscoveryParityStore();

    const comparator = new TradingViewShadowComparator({
      marketId: "CA_TSX",
      tvClient: mockTvClient,
      evidenceStore: mockEvidenceStore,
      parityStore,
      clock: () => new Date("2026-11-03T14:40:10Z"),
    });

    const audit = await comparator.auditParity(runId);

    expect(audit.marketId).toBe("CA_TSX");
    expect(audit.runId).toBe(runId);
    expect(audit.tradingViewCount).toBe(3);
    expect(audit.questradePassCount).toBe(2); // SHOP and CVE

    // Overlap: SHOP is the only symbol that passed Questrade AND was returned by TV
    expect(audit.overlapSymbols).toEqual(["SHOP"]);
    expect(audit.overlapCount).toBe(1);

    // Missed Movers: BMO and ENB were in TV scan but did not pass Questrade
    expect(audit.missedMovers).toHaveLength(2);
    const bmoMissed = audit.missedMovers.find((m) => m.symbol === "BMO");
    expect(bmoMissed).toBeDefined();
    expect(bmoMissed?.questradeState).toBe("FAIL");
    expect(bmoMissed?.questradeReasons).toEqual(["ATR_THRESHOLD"]);
    expect(bmoMissed?.discrepancyCategory).toBe("FORMULA_DIFFERENCE");

    const enbMissed = audit.missedMovers.find((m) => m.symbol === "ENB");
    expect(enbMissed).toBeDefined();
    expect(enbMissed?.questradeState).toBeNull();
    expect(enbMissed?.discrepancyCategory).toBe("VOLUME_COVERAGE");

    // Questrade Only: CVE passed Questrade but was not in TV scan
    expect(audit.questradeOnly).toHaveLength(1);
    expect(audit.questradeOnly[0]?.symbol).toBe("CVE");

    // Metric Differences: for overlapping symbol SHOP
    const shopDiffs = audit.metricDifferences.filter(
      (d) => d.symbol === "SHOP",
    );
    expect(shopDiffs.length).toBeGreaterThan(0);
    const priceDiff = shopDiffs.find((d) => d.field === "price");
    expect(priceDiff).toBeDefined();
    expect(priceDiff?.questradeValue).toBe(105);
    expect(priceDiff?.tradingViewValue).toBe(104.8);
    expect(priceDiff?.difference).toBe(0.2);

    // Parity status retrieval
    const status = await comparator.getStatus();
    expect(status.latestAudit?.id).toBe(audit.id);
    expect(status.auditCount).toBe(1);
    expect(status.averageOverlapRatio).toBe(audit.overlapRatio);
  });

  it("throws error when requested discovery run is not found", async () => {
    const mockEvidenceStore = {
      listRuns: vi.fn(async () => []),
      listEvaluations: vi.fn(async () => []),
    } as unknown as PostgresDiscoveryEvidenceStore;

    const comparator = new TradingViewShadowComparator({
      marketId: "CA_TSX",
      tvClient: {} as TradingViewScannerClient,
      evidenceStore: mockEvidenceStore,
      parityStore: new InMemoryDiscoveryParityStore(),
    });

    await expect(
      comparator.auditParity("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("No discovery run found to audit");
  });

  it("paginates evaluations using cursor when results exceed 200 items", async () => {
    const runId = "20000000-0000-4000-8000-000000000002";
    const run = makeRun(runId);

    // Page 1: 200 evaluations
    const page1: DiscoveryEvidence[] = Array.from({ length: 200 }, (_, i) =>
      makeEvidence(runId, `SYM${String(i).padStart(3, "0")}`, "FAIL", [
        "PRICE_OUT_OF_RANGE",
      ]),
    );
    // Page 2: 1 evaluation (passes)
    const page2: DiscoveryEvidence[] = [
      makeEvidence(runId, "SHOP", "PASS", [], 105, 2.2),
    ];

    const listEvaluations = vi.fn(
      async (
        _m: any,
        _r: any,
        options: { after?: { exchange: string; code: string }; limit?: number },
      ) => {
        if (!options.after) return page1;
        if (options.after.code === "SYM199") return page2;
        return [];
      },
    );

    const mockEvidenceStore = {
      listRuns: vi.fn(async () => [run]),
      listEvaluations,
    } as unknown as PostgresDiscoveryEvidenceStore;

    const mockTvClient = {
      scan: vi.fn(async () => [
        {
          symbol: "SHOP",
          exchange: "TSX",
          fullSymbol: "TSX:SHOP",
          price: 105,
          changeFromOpenPct: 1.0,
          relativeVolume: 2.0,
          averageVolume90d: 500000,
          marketCap: 1000000000,
          observedAt: "2026-11-03T14:40:02.000Z",
        },
      ]),
    } as unknown as TradingViewScannerClient;

    const comparator = new TradingViewShadowComparator({
      marketId: "CA_TSX",
      tvClient: mockTvClient,
      evidenceStore: mockEvidenceStore,
      parityStore: new InMemoryDiscoveryParityStore(),
      clock: () => new Date("2026-11-03T14:40:10Z"),
    });

    const audit = await comparator.auditParity(runId);
    expect(listEvaluations).toHaveBeenCalledTimes(2);
    expect(listEvaluations).toHaveBeenLastCalledWith(
      "CA_TSX",
      runId,
      expect.objectContaining({
        limit: 200,
        after: { exchange: "TSX", code: "SYM199" },
      }),
    );
    expect(audit.overlapSymbols).toEqual(["SHOP"]);
  });

  it("categorizes BUDGET_DEFERRED and EVALUATION_EXPIRED as VOLUME_COVERAGE", async () => {
    const runId = "30000000-0000-4000-8000-000000000003";
    const run = makeRun(runId);

    const qtEvaluations: DiscoveryEvidence[] = [
      makeEvidence(runId, "ABC", "DEFERRED" as any, ["BUDGET_DEFERRED"]),
      makeEvidence(runId, "DEF", "DEFERRED" as any, ["EVALUATION_EXPIRED"]),
    ];

    const mockEvidenceStore = {
      listRuns: vi.fn(async () => [run]),
      listEvaluations: vi.fn(async () => qtEvaluations),
    } as unknown as PostgresDiscoveryEvidenceStore;

    const mockTvClient = {
      scan: vi.fn(async () => [
        {
          symbol: "ABC",
          exchange: "TSX",
          fullSymbol: "TSX:ABC",
          price: 20,
          changeFromOpenPct: 1.5,
          relativeVolume: 2.0,
          averageVolume90d: 500000,
          marketCap: 1000000000,
          observedAt: "2026-11-03T14:40:02.000Z",
        },
        {
          symbol: "DEF",
          exchange: "TSX",
          fullSymbol: "TSX:DEF",
          price: 30,
          changeFromOpenPct: 2.0,
          relativeVolume: 2.5,
          averageVolume90d: 600000,
          marketCap: 2000000000,
          observedAt: "2026-11-03T14:40:02.000Z",
        },
      ]),
    } as unknown as TradingViewScannerClient;

    const comparator = new TradingViewShadowComparator({
      marketId: "CA_TSX",
      tvClient: mockTvClient,
      evidenceStore: mockEvidenceStore,
      parityStore: new InMemoryDiscoveryParityStore(),
      clock: () => new Date("2026-11-03T14:40:10Z"),
    });

    const audit = await comparator.auditParity(runId);
    expect(audit.missedMovers).toHaveLength(2);
    expect(audit.missedMovers[0]?.discrepancyCategory).toBe("VOLUME_COVERAGE");
    expect(audit.missedMovers[1]?.discrepancyCategory).toBe("VOLUME_COVERAGE");
    expect(audit.discrepancySummary.VOLUME_COVERAGE).toBe(2);
  });

  it("prioritizes latest COMPLETED run over in-flight RUNNING run when runId is omitted", async () => {
    const runningRun = {
      ...makeRun("40000000-0000-4000-8000-000000000004"),
      status: "RUNNING" as const,
      completedAt: null,
    };
    const completedRun = {
      ...makeRun("50000000-0000-4000-8000-000000000005"),
      status: "COMPLETED" as const,
    };

    const mockEvidenceStore = {
      listRuns: vi.fn(async () => [runningRun, completedRun]),
      listEvaluations: vi.fn(async () => []),
    } as unknown as PostgresDiscoveryEvidenceStore;

    const mockTvClient = {
      scan: vi.fn(async () => []),
    } as unknown as TradingViewScannerClient;

    const comparator = new TradingViewShadowComparator({
      marketId: "CA_TSX",
      tvClient: mockTvClient,
      evidenceStore: mockEvidenceStore,
      parityStore: new InMemoryDiscoveryParityStore(),
      clock: () => new Date("2026-11-03T14:40:10Z"),
    });

    const audit = await comparator.auditParity();
    expect(audit.runId).toBe(completedRun.id);
    // Two empty screens are not evidence of agreement.
    expect(audit.overlapRatio).toBe(0);
  });

  it("does not persist a parity audit when the TradingView screen is unavailable", async () => {
    const run = makeRun("60000000-0000-4000-8000-000000000006");
    const evidenceStore = {
      listRuns: vi.fn(async () => [run]),
      listEvaluations: vi.fn(async () => []),
    } as unknown as PostgresDiscoveryEvidenceStore;
    const parityStore = new InMemoryDiscoveryParityStore();
    const comparator = new TradingViewShadowComparator({
      marketId: "CA_TSX",
      tvClient: {
        scan: vi.fn(async () => {
          throw new Error("TradingView scanner returned malformed response");
        }),
      } as unknown as TradingViewScannerClient,
      evidenceStore,
      parityStore,
    });

    await expect(comparator.auditParity(run.id)).rejects.toThrow(
      "TradingView scanner returned malformed response",
    );
    expect(await parityStore.countAudits("CA_TSX")).toBe(0);
  });
});
