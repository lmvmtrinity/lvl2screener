import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  universeAutomationSchema,
  type UniverseAutomation,
  type UniverseRefreshRun,
} from "@tsx-scanner/contracts";
import { getJson } from "../lib/api.js";
import { UniverseView } from "./UniverseView.js";

vi.mock("../lib/api.js", () => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

const RUNNING_RUN_ID = "11111111-1111-4111-8111-111111111111";
const COMPLETED_RUN_ID = "22222222-2222-4222-8222-222222222222";
const FAILED_RUN_ID = "33333333-3333-4333-8333-333333333333";

function refreshRun(
  overrides: Partial<UniverseRefreshRun> = {},
): UniverseRefreshRun {
  return {
    id: COMPLETED_RUN_ID,
    marketId: "CA_TSX",
    provider: "CONFIGURED_TSX_LIVE_WATCHLIST",
    policyVersion: "tsx-liquid-momentum-v1",
    status: "COMPLETED",
    discoveredCount: 2,
    evaluatedCount: 2,
    eligibleCount: 2,
    activatedCount: 2,
    warnings: [],
    error: null,
    startedAt: "2026-09-09T13:00:00.000Z",
    completedAt: "2026-09-09T13:00:45.000Z",
    ...overrides,
  };
}

function automationWith(
  overrides: Partial<UniverseAutomation> = {},
): UniverseAutomation {
  return universeAutomationSchema.parse({
    provider: "CONFIGURED_TSX_LIVE_WATCHLIST",
    policy: {
      version: "tsx-liquid-momentum-v1",
      marketId: "CA_TSX",
      exchange: "TSX",
      currency: "CAD",
      allowedExchanges: ["TSX"],
      allowedCurrencies: ["CAD"],
      securityTypes: ["Stock", "Common Stock"],
      minimumPrice: 5,
      maximumPrice: 150,
      minimumMarketCap: 500_000_000,
      minimumAverageVolume90d: 500_000,
      minimumDollarVolume: 20_000_000,
      minimumAtrPct: 1.5,
      minimumHistoryDays: 20,
    },
    latestRun: null,
    members: [],
    editable: true,
    configuredSymbols: ["AAPL.TO"],
    candidates: [],
    watchlistDate: "2026-09-09",
    candidateStatuses: [
      {
        symbol: "AAPL.TO",
        status: "QUALIFIED",
        source: "DISCOVERY",
        discoveredAt: "2026-09-09T13:00:00.000Z",
        intakeAt: null,
        strategyReadyAt: null,
        reason: null,
        attemptCount: 0,
      },
      {
        symbol: "SHOP.TO",
        status: "EXCLUDED",
        source: "DISCOVERY",
        discoveredAt: "2026-09-09T13:00:00.000Z",
        intakeAt: null,
        strategyReadyAt: null,
        reason: "Operator exclusion",
        attemptCount: 0,
      },
    ],
    ...overrides,
  });
}

function runRequests(): number {
  return vi
    .mocked(getJson)
    .mock.calls.filter(([path]) =>
      String(path).startsWith("/api/universe/runs"),
    ).length;
}

function renderView(automation: UniverseAutomation) {
  return render(
    <UniverseView
      automation={automation}
      updated={() => undefined}
      marketId="CA_TSX"
    />,
  );
}

describe("UniverseView", () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset();
    vi.mocked(getJson).mockResolvedValue({ runs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("shows qualified and excluded lifecycle states", async () => {
    renderView(automationWith());

    expect(
      await screen.findByLabelText("Candidate lifecycle summary"),
    ).toHaveTextContent("QUALIFIED 1");
    expect(screen.getByText("AAPL.TO")).toBeInTheDocument();
    expect(screen.getByText("SHOP.TO")).toBeInTheDocument();
    expect(screen.getAllByText("EXCLUDED").length).toBeGreaterThan(0);
  });

  it("shows plain-language activity while a refresh is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T13:00:38.000Z"));
    const running = refreshRun({
      id: RUNNING_RUN_ID,
      status: "RUNNING",
      evaluatedCount: 0,
      completedAt: null,
    });
    vi.mocked(getJson).mockResolvedValue({ runs: [running] });

    await act(async () => {
      renderView(automationWith({ latestRun: running }));
    });

    expect(screen.getByRole("status")).toHaveTextContent("Refreshing now");
    expect(
      within(screen.getByLabelText("Refresh activity")).getByText(
        /started 38s ago/,
      ),
    ).toBeInTheDocument();
  });

  it("polls while running and stops once the run completes", async () => {
    vi.useFakeTimers();
    const running = refreshRun({
      id: RUNNING_RUN_ID,
      status: "RUNNING",
      evaluatedCount: 0,
      completedAt: null,
    });
    const completed = refreshRun({ id: RUNNING_RUN_ID });
    vi.mocked(getJson)
      .mockResolvedValueOnce({ runs: [running] })
      .mockResolvedValueOnce({ runs: [completed] });

    await act(async () => {
      renderView(automationWith({ latestRun: running }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing now");
    expect(runRequests()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Refresh completed");
    expect(runRequests()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(runRequests()).toBe(2);
  });

  it("shows the last successful refresh time and duration", async () => {
    await act(async () => {
      renderView(automationWith({ latestRun: refreshRun() }));
    });

    expect(screen.getByText(/Last successful refresh/)).toHaveTextContent(
      "took 45s",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Refresh completed");
  });

  it("shows the latest failure reason and notes prior analysis stays active", async () => {
    const failed = refreshRun({
      id: FAILED_RUN_ID,
      status: "FAILED",
      completedAt: null,
      error: "Questrade market data unavailable",
    });

    await act(async () => {
      renderView(automationWith({ latestRun: failed }));
    });

    expect(screen.getByRole("status")).toHaveTextContent("Refresh failed");
    expect(
      screen.getAllByText("Questrade market data unavailable").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(/previous analysis set remains active/i),
    ).toBeInTheDocument();
  });

  it("keeps the last known history with a stale note when refreshing fails", async () => {
    vi.mocked(getJson).mockRejectedValue(new Error("network down"));

    await act(async () => {
      renderView(automationWith({ latestRun: refreshRun() }));
    });

    expect(
      screen.getByText("could not refresh · showing last known"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Refresh completed");
  });

  it("shows warm-up timeline stages and attempt count for failed candidates", async () => {
    const automation = automationWith({
      candidateStatuses: [
        {
          symbol: "AAPL.TO",
          status: "FAILED",
          source: "DISCOVERY",
          discoveredAt: "2026-09-09T13:00:00.000Z",
          intakeAt: "2026-09-09T13:01:00.000Z",
          strategyReadyAt: null,
          reason: "Warm-up timed out",
          attemptCount: 3,
        },
      ],
    });

    await act(async () => {
      renderView(automation);
    });

    expect(screen.getByText(/3 ATTEMPTS/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Warm-up stages for AAPL.TO" }),
    );
    expect(screen.getByText("Discovered")).toBeInTheDocument();
    expect(screen.getByText("Intake")).toBeInTheDocument();
    expect(screen.getByText("Strategy ready")).toBeInTheDocument();
    expect(screen.getAllByText("not recorded")).toHaveLength(1);
    expect(screen.getByText("3 attempts")).toBeInTheDocument();
    expect(screen.getAllByText("Warm-up timed out").length).toBeGreaterThan(0);
  });

  it("refreshes history and automation when the window regains focus", async () => {
    const automation = automationWith({ latestRun: refreshRun() });
    vi.mocked(getJson).mockImplementation(async (path) => {
      if (String(path).startsWith("/api/universe?"))
        return { instruments: [], automation };
      return { runs: [refreshRun()] };
    });

    await act(async () => {
      renderView(automation);
    });
    vi.mocked(getJson).mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    const paths = vi.mocked(getJson).mock.calls.map(([path]) => String(path));
    expect(paths.some((path) => path.startsWith("/api/universe/runs"))).toBe(
      true,
    );
    expect(
      paths.some((path) => path.startsWith("/api/universe?marketId=CA_TSX")),
    ).toBe(true);
  });
});
