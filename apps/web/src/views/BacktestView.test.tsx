import { backtestRunSchema, type BacktestRun } from "@tsx-scanner/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacktestView } from "./BacktestView.js";

const availability = {
  source: "CAPTURED_QUOTES" as const,
  observedAt: "2026-09-11T21:00:00.000Z",
  tables: {
    quoteSnapshot: {
      earliest: "2026-09-01T13:30:00.000Z",
      latest: "2026-09-11T20:00:00.000Z",
    },
    candle: {
      earliest: "2026-08-01T13:30:00.000Z",
      latest: "2026-09-11T20:00:00.000Z",
    },
  },
  replay: { earliestDate: "2026-09-01", latestDate: "2026-09-11" },
};

const automationStatus = {
  marketId: "CA_TSX",
  enabled: false,
  cadence: "DAILY_POST_SESSION",
  maxOutstanding: 2,
  asOf: "2026-09-11T21:00:00.000Z",
  nextCheckAt: null,
  interventionRequired: false,
  lastCycle: null,
  works: [],
  stages: [],
  outstandingWork: 0,
  oldestOutstandingAt: null,
  oldestWaitingAt: null,
  lastSuccessAt: null,
  lastSuccessDurationMs: null,
  lastSuccessEvaluatedThrough: null,
  retryScheduled: 0,
  blockerCounts: [],
  recentCycles: [],
};

const metrics = {
  signalsGenerated: 12,
  readySignals: 9,
  tradesSimulated: 9,
  wins: 1,
  losses: 8,
  winRate: 11.11,
  averageWin: 20,
  averageLoss: -22,
  averageR: -0.92,
  medianR: -1,
  profitFactor: 0.07,
  expectancy: -17.97,
  netPnl: -161.72,
  maximumDrawdown: 161.72,
  maximumDrawdownPct: 0.16,
  falseBreakoutRate: 66.67,
  signalToTradeConversion: 0.75,
  averageHoldMinutes: 22,
};

function automationRun(completedAt: string): BacktestRun {
  return backtestRunSchema.parse({
    id: "20000000-0000-4000-8000-000000000001",
    marketId: "CA_TSX",
    name: "Auto qualification · ORB Standard · profile-orb-standard-v1",
    status: "COMPLETED",
    startDate: "2026-08-31",
    endDate: "2026-09-11",
    strategies: ["ORB_RETEST"],
    symbols: [],
    dataSource: "CAPTURED_QUOTES",
    strategyVersion: "strategy-v1",
    configVersion: "profile-orb-standard-v1",
    executionModelVersion: "paper-execution-v7",
    startingCapital: 100_000,
    positionSize: 10_000,
    slippageBps: 2,
    feePerTrade: 0,
    parameters: {},
    metrics,
    analyses: [],
    dataQuality: null,
    error: null,
    createdAt: "2026-09-11T20:00:00.000Z",
    startedAt: null,
    completedAt,
  });
}

const latest: BacktestRun = {
  ...automationRun("2026-09-11T21:00:00.000Z"),
  dataQuality: {
    quoteSnapshots: 10,
    candles: 10,
    sessions: 3,
    spread: "CAPTURED",
    warnings: ["9 captured quote(s) were excluded from replay."],
  },
};
const older: BacktestRun = {
  ...automationRun("2026-09-10T21:00:00.000Z"),
  id: "20000000-0000-4000-8000-000000000002",
  metrics: null,
};

describe("BacktestView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubFetch(
    automation: Record<string, unknown> = automationStatus,
    run: BacktestRun = latest,
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (value: unknown) =>
          new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json" },
          });
        if (url.includes("/api/backtest-automation/status"))
          return json({ ...automation, marketId: "CA_TSX" });
        if (url.includes("/api/funded-historical-policies"))
          return json({ policies: [] });
        if (url.includes("/api/signal-model-research/authorizations?"))
          return json({ authorizations: [] });
        if (url.includes("/api/captured-history/availability"))
          return json(availability);
        if (url.includes(`/api/backtests/${run.id}`)) return json(run);
        if (
          url.includes("/api/learning/backtest-runs/") &&
          url.includes("strategy-readiness")
        )
          return json({
            sourceKind: "BACKTEST_RUN",
            scope: {
              marketId: "CA_TSX",
              strategyKey: "ORB_RETEST",
              profileConfigId: "33333333-3333-4333-8333-333333333333",
              strategyVersion: "strategy-v1",
              configVersion: "profile-orb-standard-v1",
              executionModelVersion: "paper-execution-v7",
              executionAssumptions: { slippageBps: 2 },
            },
            state: "WAITING_FOR_EVIDENCE",
            targetDistinctTrades: 30,
            verifiedSessions: 2,
            distinctClosedTrades: 4,
            usableModelRows: 3,
            qualificationCounts: { EVIDENCE_QUALIFIED: 1, EXPLORATORY: 3 },
            exclusions: {},
            strata: { time: {}, atr: {}, rvol: {} },
            blockers: [],
            shortfall: 26,
            feasibility: {
              state: "UNAVAILABLE",
              reason: "MISSING_PREDECLARED_EXPERIMENT_CRITERIA",
            },
            collectionEstimate: {
              state: "UNAVAILABLE",
              reason: "ZERO_OUTCOME_SESSION",
              observedRateMin: 0,
              observedRateMax: 0,
              observedSessions: 2,
            },
          });
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  function openMenuItem(label: string) {
    fireEvent.click(screen.getByLabelText("More backtest tools"));
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
  }

  it("shows one row per strategy and keeps older attempts in run history", async () => {
    stubFetch();
    render(
      <BacktestView
        runs={[latest, older]}
        updateRuns={() => undefined}
        marketId="CA_TSX"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Automation paused"),
    );
    const results = screen.getByRole("region", { name: "Results" });
    expect(within(results).getAllByText("ORB Standard")).toHaveLength(1);
    expect(within(results).getByText("−$161.72")).toBeInTheDocument();
    expect(within(results).getByText("9 trades")).toBeInTheDocument();
    expect(within(results).getByText("11%")).toBeInTheDocument();
    expect(within(results).getAllByText("Not assessed").length).toBeGreaterThan(
      0,
    );

    openMenuItem("Run history");
    const history = screen.getByRole("dialog", { name: "Run history" });
    expect(within(history).getByText(/^2 attempts/)).toBeInTheDocument();
    expect(
      within(history).getByRole("region", { name: "Run history list" }),
    ).toBeInTheDocument();
    expect(within(history).getAllByText(/manual run/)).toHaveLength(2);
    expect(within(history).getAllByText("Technical details")).toHaveLength(2);
  });

  it("opens the manual replay form from the tools menu", async () => {
    stubFetch();
    render(
      <BacktestView runs={[]} updateRuns={() => undefined} marketId="CA_TSX" />,
    );
    await waitFor(() =>
      expect(screen.getByText("No backtest results yet.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("New historical replay")).not.toBeInTheDocument();
    openMenuItem("Manual replay");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("New historical replay")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLFormElement>(".backtest-form")?.dataset
          .capturedHistory ?? "",
      ).toMatch(/captured quotes/i),
    );
  });

  it("offers the historical archive for US replays and submits it as the data source", async () => {
    stubFetch();
    const fetchMock = vi.mocked(fetch);
    render(
      <BacktestView
        runs={[]}
        updateRuns={() => undefined}
        marketId="US_EQUITIES"
      />,
    );
    openMenuItem("Manual replay");
    fireEvent.change(screen.getByLabelText("Data source"), {
      target: { value: "HISTORICAL_ARCHIVE" },
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes(
            "/api/captured-history/availability?marketId=US_EQUITIES&source=HISTORICAL_ARCHIVE",
          ),
        ),
      ).toBe(true),
    );
    expect(screen.getByLabelText(/Symbols/)).toBeRequired();
    fireEvent.change(screen.getByLabelText(/Symbols/), {
      target: { value: "COIN, OKTA" },
    });
    fireEvent.submit(
      document.querySelector<HTMLFormElement>(".backtest-form")!,
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(
          ([url, init]) =>
            String(url).endsWith("/api/backtests") && init?.method === "POST",
        ),
      ).toBeDefined(),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/api/backtests") && init?.method === "POST",
    )!;
    expect(JSON.parse(String(init!.body))).toMatchObject({
      marketId: "US_EQUITIES",
      dataSource: "HISTORICAL_ARCHIVE",
      symbols: ["COIN", "OKTA"],
    });
  });

  it("keeps Canadian replays on captured quotes without a source choice", async () => {
    stubFetch();
    render(
      <BacktestView runs={[]} updateRuns={() => undefined} marketId="CA_TSX" />,
    );
    openMenuItem("Manual replay");
    expect(screen.queryByLabelText("Data source")).not.toBeInTheDocument();
  });

  it("forwards the optional universe action for replay-candidate blockers", async () => {
    const onOpenUniverse = vi.fn();
    stubFetch({
      ...automationStatus,
      enabled: true,
      nextCheckAt: "2026-09-12T21:00:00.000Z",
      works: [
        {
          workKey: "a".repeat(64),
          marketId: "CA_TSX",
          kind: "PROFILE_QUALIFICATION",
          configId: "10000000-0000-4000-8000-000000000097",
          configName: "Quiet Guide",
          configVersion: "profile-quiet-guide-v1",
          strategyKey: "QUIET_GUIDE",
          state: "WAITING",
          triggerOrigin: "SCHEDULED_CATCH_UP",
          blockerReason: "NO_REPLAY_CANDIDATES",
          inputFingerprint: "b".repeat(64),
          consumedFingerprint: "b".repeat(64),
          attemptKey: "c".repeat(64),
          jobId: null,
          jobStatus: null,
          runId: null,
          evaluatedThrough: null,
          retryCount: 0,
          nextAttemptAt: null,
          lastDispatchedAt: null,
          lastSuccessAt: null,
          lastFailureAt: null,
          waitingSince: "2026-09-10T18:00:00.000Z",
          startedAt: null,
          heartbeatAt: null,
          progress: null,
          runDurationMs: null,
          failureMessage: null,
          inputChanged: false,
          updatedAt: "2026-09-10T21:00:00.000Z",
        },
      ],
      blockerCounts: [{ reason: "NO_REPLAY_CANDIDATES", count: 1 }],
    });
    render(
      <BacktestView
        runs={[]}
        updateRuns={() => undefined}
        marketId="CA_TSX"
        onOpenUniverse={onOpenUniverse}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("No replay candidates yet")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Open universe & daily list"));
    expect(onOpenUniverse).toHaveBeenCalledTimes(1);
  });

  it("expands a result into a quick look and opens its full detail tabs", async () => {
    stubFetch();
    render(
      <BacktestView
        runs={[latest]}
        updateRuns={() => undefined}
        marketId="CA_TSX"
      />,
    );
    fireEvent.click(await screen.findByText("ORB Standard"));
    expect(screen.getByText("Max drawdown")).toBeInTheDocument();
    expect(
      screen.getByText(/No evidence assessment was recorded for this run\./),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open full result →"));
    expect(
      await screen.findByRole("dialog", { name: "ORB Standard" }),
    ).toBeInTheDocument();
    await screen.findByText("TRADES");

    // Summary: metrics plus one consolidated warning summary.
    expect(screen.getByText("TRADES")).toBeInTheDocument();
    expect(
      screen.getByText("1 limitation or warning recorded"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("1 limitation or warning recorded"));
    expect(
      screen.getByText("9 captured quote(s) were excluded from replay."),
    ).toBeInTheDocument();

    // Evidence tab: no fabricated assessment for a run without evidence.
    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(
      screen.getByText("No evidence assessment was recorded for this run."),
    ).toBeInTheDocument();

    // Trades tab: quote-path copy, not the old OHLC claim.
    fireEvent.click(screen.getByRole("tab", { name: "Trades" }));
    expect(screen.getByText("Simulated trades")).toBeInTheDocument();
    expect(
      screen.getByText(/evaluated against the captured quote path/),
    ).toBeInTheDocument();

    // Provenance tab: replay input, technical details and a copy control.
    fireEvent.click(screen.getByRole("tab", { name: "Provenance" }));
    expect(
      screen.getByText("LEGACY_UNRESOLVED_UNIVERSE", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText("Run ID")).toBeInTheDocument();
    expect(
      screen.getAllByLabelText(`COPY ${latest.id}`).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Learning readiness" }));
    expect(
      await screen.findByText(
        "4 / 30 raw distinct closed outcomes across compatible runs",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Strategy learning readiness" }),
    ).toHaveTextContent(/Evidence-qualified distinct outcomes\s*1/);
    expect(
      screen.getByRole("region", { name: "Strategy learning readiness" }),
    ).toHaveTextContent(/Exploratory distinct outcomes\s*3/);
    expect(
      screen.getByRole("region", { name: "Strategy learning readiness" }),
    ).toHaveTextContent("Counts accumulate across compatible retained runs");
  });

  it("shows the run's recorded interior no-quote limitation in its summary", async () => {
    const runWithGap: BacktestRun = {
      ...latest,
      capturedHistoryAvailability: {
        ...availability,
        limitations: [
          {
            marketId: "CA_TSX",
            kind: "INTERIOR_NO_QUOTE",
            basis: "QUOTE_GAP_WITH_BACKFILLED_CANDLES",
            startAt: "2026-09-14T13:39:05.524Z",
            endAt: "2026-09-14T15:25:29.153Z",
            sessionDates: ["2026-09-14"],
            detail:
              "No forward quotes were retained through this interval although completed candles exist inside it.",
            evaluatedFrom: "2026-08-15T00:00:00.000Z",
            evaluatedThrough: "2026-09-15T00:00:00.000Z",
          },
        ],
      },
    };
    stubFetch(automationStatus, runWithGap);
    render(
      <BacktestView
        runs={[runWithGap]}
        updateRuns={() => undefined}
        marketId="CA_TSX"
      />,
    );
    fireEvent.click(await screen.findByText("ORB Standard"));
    fireEvent.click(screen.getByText("Open full result →"));
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>(".backtest-metrics")?.dataset
          .capturedHistory ?? "",
      ).toMatch(/Forward quotes are missing/),
    );
    const summary =
      document.querySelector<HTMLElement>(".backtest-metrics")?.dataset
        .capturedHistory ?? "";
    expect(summary).toContain("2026-09-14");
    expect(summary).toContain("do not replace the missing quotes");
  });
});
