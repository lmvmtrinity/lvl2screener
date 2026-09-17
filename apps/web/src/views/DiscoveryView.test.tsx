import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoveryPolicyForMarket,
  type DiscoveryEvidence,
  type DiscoveryStatus,
} from "@tsx-scanner/contracts";
import { getJson, sendJson } from "../lib/api.js";
import { DiscoveryView } from "./DiscoveryView.js";

vi.mock("../lib/api.js", () => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

const run: NonNullable<DiscoveryStatus["lastRun"]> = {
  id: "00000000-0000-4000-8000-000000000001",
  marketId: "CA_TSX",
  tradingDate: "2026-09-09",
  policyVersion: "ca-discovery-v1",
  mode: "SHADOW",
  evaluationAt: "2026-09-09T14:00:00.000Z",
  completedBarEnd: "2026-09-09T13:55:00.000Z",
  catalogDigest: "a".repeat(64),
  status: "PARTIAL",
  coverage: {
    total: 100,
    pass: 60,
    fail: 20,
    unevaluable: 10,
    deferred: 10,
  },
  startedAt: "2026-09-09T14:00:00.000Z",
  completedAt: "2026-09-09T14:01:00.000Z",
  failure: null,
};

const evaluation: DiscoveryEvidence = {
  id: "00000000-0000-4000-8000-000000000002",
  runId: run.id,
  result: {
    marketId: "CA_TSX",
    policyVersion: "ca-discovery-v1",
    providerCode: "TEST",
    symbolId: 123,
    providerExchange: "TSX",
    tradingDate: "2026-09-09",
    evaluationAt: "2026-09-09T14:00:00.000Z",
    computedAt: "2026-09-09T14:00:01.000Z",
    completedBarEnd: "2026-09-09T13:55:00.000Z",
    state: "FAIL",
    reasons: ["QUOTE_STALE"],
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

function makeStatus(overrides: Partial<DiscoveryStatus> = {}): DiscoveryStatus {
  return {
    marketId: "CA_TSX",
    mode: "SHADOW",
    revision: 1,
    modeUpdatedAt: "2026-09-09T13:00:00.000Z",
    modeActor: "test",
    scheduler: "IDLE",
    policy: discoveryPolicyForMarket("CA_TSX"),
    catalog: {
      status: "FRESH",
      source: "EODHD",
      tradingDate: "2026-09-09",
      fetchedAt: "2026-09-09T13:59:00.000Z",
      ageMs: 60_000,
      rowCount: 120,
      admittedCount: 100,
      failure: null,
    },
    lastRun: run,
    nextEvaluationAt: "2026-09-09T14:05:00.000Z",
    activeRunId: null,
    queueDepth: 0,
    oldestQueueAgeMs: 0,
    lastError: null,
    budget: {
      remainingHour: 10_000,
      remainingDiscoveryHour: 1_500,
      queued: 0,
      active: 0,
    },
    performance: {
      sampleCount: 12,
      lastCycleDurationMs: 3_500,
      lastQueueLatencyMs: 250,
      cycleP95Ms: 4_200,
      queueP95Ms: 300,
      phases: {
        inputCollectionElapsedMs: 320,
        evaluationWorkMs: 75,
        serializationWorkMs: 8,
        persistenceWorkMs: 140,
      },
      requestUsage: { completed: 40, failed: 1, cancelled: 0, expired: 2 },
    },
    fastFunnel: {
      marketId: "CA_TSX",
      enabled: false,
      lastAcceleratedAt: null,
      topMoversCount: 0,
      topMoverSymbols: [],
      acceleratedCandidatesCount: 0,
      acceleratedEvaluatedCount: 0,
      acceleratedPassedCount: 0,
    },
    parity: {
      marketId: "CA_TSX",
      latestAudit: {
        id: "00000000-0000-4000-8000-000000000003",
        marketId: "CA_TSX",
        tradingDate: "2026-09-09",
        runId: run.id,
        auditedAt: "2026-09-09T15:00:00.000Z",
        tradingViewCount: 25,
        questradePassCount: 22,
        overlapCount: 20,
        overlapRatio: 0.8,
        overlapSymbols: ["TEST"],
        missedMovers: [
          {
            symbol: "MISS",
            exchange: "TSX",
            tradingViewMetrics: {
              price: 12,
              changeFromOpenPct: 4,
              relativeVolume: 2.5,
              averageVolume90d: 1_000_000,
              marketCap: 1_000_000_000,
            },
            questradeState: "FAIL",
            questradeReasons: ["RELATIVE_VOLUME_THRESHOLD"],
            discrepancyCategory: "FORMULA_DIFFERENCE",
          },
        ],
        questradeOnly: [],
        metricDifferences: [],
        discrepancySummary: {
          FORMULA_DIFFERENCE: 1,
          FORMING_VS_COMPLETED_BAR: 0,
          VOLUME_COVERAGE: 0,
          TIMESTAMP_LAG: 0,
          CORPORATE_ACTION: 0,
          CLASSIFICATION_MISMATCH: 0,
          THRESHOLD_BOUNDARY: 0,
          OTHER: 0,
        },
      },
      auditCount: 3,
      averageOverlapRatio: 0.82,
      lastAuditedAt: "2026-09-09T15:00:00.000Z",
    },
    ...overrides,
  };
}

function stubDiscovery(
  status: DiscoveryStatus,
  evaluationPages: DiscoveryEvidence[][] = [[evaluation]],
) {
  vi.mocked(getJson).mockImplementation(async (path?: string) => {
    const value = String(path);
    if (value.includes("/api/discovery/status")) return status;
    if (value.includes("/api/discovery/runs"))
      return { runs: status.lastRun ? [status.lastRun] : [], nextBefore: null };
    if (value.includes("afterExchange"))
      return { evaluations: evaluationPages[1] ?? [], nextAfter: null };
    const firstPage = evaluationPages[0] ?? [];
    const last = firstPage.at(-1);
    return {
      evaluations: firstPage,
      nextAfter:
        evaluationPages.length > 1 && last
          ? {
              exchange: last.result.providerExchange,
              code: last.result.providerCode,
            }
          : null,
    };
  });
}

describe("DiscoveryView", () => {
  beforeEach(() => {
    stubDiscovery(makeStatus());
  });

  afterEach(() => {
    cleanup();
    vi.mocked(getJson).mockReset();
    vi.mocked(sendJson).mockReset();
  });

  it("defaults to Overview with mode, working state and catalog freshness", async () => {
    render(<DiscoveryView marketId="CA_TSX" />);

    expect(
      await screen.findByText(
        /SHADOW evaluates the market on every completed bar/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Discovery is waiting for the next completed bar",
    );
    expect(screen.getByText(/Last checked/)).toBeInTheDocument();
    expect(screen.getByText(/Catalog is fresh/)).toBeInTheDocument();
    expect(screen.getByText("FRESH")).toBeInTheDocument();
    expect(screen.getByText(/100 catalog members/)).toBeInTheDocument();
    expect(
      screen.getByText(/no candidate is added to the daily list automatically/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AUTO_ADD" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(screen.getByText("Input collection elapsed")).toBeInTheDocument();
    expect(screen.getByText("320ms")).toBeInTheDocument();
    expect(
      screen.getByText("Evidence persistence work (cumulative)"),
    ).toBeInTheDocument();
    expect(screen.getByText("140ms")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Shared-process request outcomes during this cycle window/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cycle p95 is the wall-clock gate/),
    ).toBeInTheDocument();
  });

  it("shows a running discovery state with elapsed time", async () => {
    stubDiscovery(
      makeStatus({
        scheduler: "RUNNING",
        activeRunId: run.id,
        lastRun: {
          ...run,
          status: "RUNNING",
          completedAt: null,
          coverage: {
            total: 40,
            pass: 10,
            fail: 5,
            unevaluable: 20,
            deferred: 5,
          },
        },
      }),
    );
    render(<DiscoveryView marketId="CA_TSX" />);

    expect(await screen.findByText("Discovery is running")).toBeInTheDocument();
    expect(
      screen.getByText(/Evaluating the latest completed bar now/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Started/)).toBeInTheDocument();
    expect(screen.getByText(/run is in progress/)).toBeInTheDocument();
  });

  it("labels a last-good catalog as a fallback rather than fresh", async () => {
    stubDiscovery(
      makeStatus({
        catalog: {
          status: "LAST_GOOD",
          source: "EODHD",
          tradingDate: "2026-09-08",
          fetchedAt: "2026-09-08T20:00:00.000Z",
          ageMs: 64_800_000,
          rowCount: 120,
          admittedCount: 100,
          failure: null,
        },
      }),
    );
    render(<DiscoveryView marketId="CA_TSX" />);

    expect(await screen.findByText("LAST_GOOD")).toBeInTheDocument();
    expect(
      screen.getByText(/last good snapshot as a fallback/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Catalog is fresh/)).not.toBeInTheDocument();
  });

  it("states that Fast Funnel is disabled instead of showing zero activity", async () => {
    render(<DiscoveryView marketId="CA_TSX" />);

    expect(await screen.findByText("DISABLED")).toBeInTheDocument();
    expect(
      screen.getByText(/Fast Funnel is disabled for this market/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Prioritized/)).not.toBeInTheDocument();
  });

  it("shows a failed run and its failure text without hovering", async () => {
    stubDiscovery(
      makeStatus({
        lastRun: {
          ...run,
          status: "FAILED",
          coverage: {
            total: 100,
            pass: 0,
            fail: 0,
            unevaluable: 100,
            deferred: 0,
          },
          failure: "Catalog provider timed out",
          completedAt: "2026-09-09T14:02:00.000Z",
        },
      }),
    );
    render(<DiscoveryView marketId="CA_TSX" />);

    expect(
      await screen.findByText(/Catalog provider timed out/),
    ).toBeInTheDocument();
    expect(screen.getByText("FAILED")).toBeInTheDocument();
    expect(
      screen.getByText(/valid screening result, not a failure/),
    ).toBeInTheDocument();
  });

  it("keeps budgets and parity evidence in Diagnostics", async () => {
    render(<DiscoveryView marketId="CA_TSX" />);
    await screen.findByText("FRESH");
    expect(screen.queryByText("1500")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

    expect(screen.getByText("TradingView parity")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
    expect(screen.getByText("82.0%")).toBeInTheDocument();
    expect(screen.getByText("MISS")).toBeInTheDocument();
    expect(screen.getByText(/40 completed/)).toBeInTheDocument();
  });

  it("shows run history and latest decisions under Results", async () => {
    render(<DiscoveryView marketId="CA_TSX" />);
    await screen.findByText("FRESH");

    fireEvent.click(screen.getByRole("button", { name: "Results" }));

    expect(screen.getByText("Shadow run history")).toBeInTheDocument();
    expect(screen.getByText("PARTIAL")).toBeInTheDocument();
    expect(screen.getByText("TEST")).toBeInTheDocument();
    expect(screen.getByText("QUOTE_STALE")).toBeInTheDocument();
  });

  it("expands a run to inspect coverage, timing and failure", async () => {
    stubDiscovery(
      makeStatus({
        lastRun: {
          ...run,
          status: "FAILED",
          failure: "Catalog provider timed out",
        },
      }),
    );
    render(<DiscoveryView marketId="CA_TSX" />);
    await screen.findByText("FRESH");
    fireEvent.click(screen.getByRole("button", { name: "Results" }));

    fireEvent.click(screen.getByRole("button", { name: /FAILED/ }));

    expect(screen.getByText("ca-discovery-v1")).toBeInTheDocument();
    expect(
      screen.getByText("Failure: Catalog provider timed out"),
    ).toBeInTheDocument();
  });

  it("switches OFF/SHADOW and leaves AUTO_ADD disabled", async () => {
    vi.mocked(sendJson).mockResolvedValue({
      marketId: "CA_TSX",
      mode: "OFF",
      revision: 2,
      updatedAt: "2026-09-09T14:10:00.000Z",
      actor: "operator@127.0.0.1",
      reason: "Operator dashboard mode change",
    });
    render(<DiscoveryView marketId="CA_TSX" />);
    await screen.findByText(/SHADOW evaluates the market/);

    fireEvent.click(screen.getByRole("button", { name: "OFF" }));

    await waitFor(() =>
      expect(vi.mocked(sendJson)).toHaveBeenCalledWith(
        "/api/discovery/mode",
        "PUT",
        expect.objectContaining({
          marketId: "CA_TSX",
          mode: "OFF",
          expectedRevision: 1,
        }),
      ),
    );
    expect(
      await screen.findByText(/Discovery is off\. No bars are evaluated/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AUTO_ADD" })).toBeDisabled();
  });

  it("runs a preview and refreshes the run list", async () => {
    const previewRun = {
      ...run,
      id: "00000000-0000-4000-8000-000000000009",
      status: "RUNNING" as const,
      completedAt: null,
      coverage: { total: 0, pass: 0, fail: 0, unevaluable: 0, deferred: 0 },
    };
    vi.mocked(sendJson).mockResolvedValue(previewRun);
    render(<DiscoveryView marketId="CA_TSX" />);
    await screen.findByText(/SHADOW evaluates the market/);
    const loadsBefore = vi.mocked(getJson).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /RUN PREVIEW/ }));

    await waitFor(() =>
      expect(vi.mocked(sendJson)).toHaveBeenCalledWith(
        "/api/discovery/preview",
        "POST",
        { marketId: "CA_TSX" },
      ),
    );
    await waitFor(() =>
      expect(vi.mocked(getJson).mock.calls.length).toBeGreaterThan(loadsBefore),
    );
  });

  it("loads more decision reasons on demand", async () => {
    const second: DiscoveryEvidence = {
      ...evaluation,
      id: "00000000-0000-4000-8000-000000000004",
      result: {
        ...evaluation.result,
        providerCode: "TEST2",
        reasons: ["PRICE_OUT_OF_RANGE"],
      },
    };
    stubDiscovery(makeStatus(), [[evaluation], [second]]);
    render(<DiscoveryView marketId="CA_TSX" />);
    await screen.findByText("FRESH");

    fireEvent.click(screen.getByRole("button", { name: "Results" }));
    expect(screen.getByText("TEST")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /LOAD MORE REASONS/ }));

    expect(await screen.findByText("TEST2")).toBeInTheDocument();
    expect(
      vi
        .mocked(getJson)
        .mock.calls.some(([path]) =>
          String(path).includes("afterExchange=TSX"),
        ),
    ).toBe(true);
  });

  it("keeps the previous status visible and marks it stale when a refresh fails", async () => {
    render(<DiscoveryView marketId="CA_TSX" />);
    await screen.findByText(/Catalog is fresh/);

    vi.mocked(getJson).mockRejectedValue(new Error("Network down"));
    fireEvent(window, new Event("focus"));

    expect(
      await screen.findByText(/Showing the last known status/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Live refresh failed: Network down/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Catalog is fresh/)).toBeInTheDocument();
    expect(screen.getAllByText(/refresh failed/).length).toBeGreaterThan(0);
  });
});
