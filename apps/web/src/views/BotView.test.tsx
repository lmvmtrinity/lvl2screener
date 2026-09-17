import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotView } from "./BotView.js";

const profileId = "20000000-0000-4000-8000-000000000101";
const profileConfigId = "20000000-0000-4000-8000-000000000102";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000402",
    source: "LIVE",
    sessionDate: "2026-08-31",
    sessionTimezone: "America/Toronto",
    scheduledCloseAt: "2026-08-31T20:00:00.000Z",
    status: "RUNNING",
    executionModelVersion: "paper-execution-v7",
    assumptions: {},
    startedAt: "2026-08-31T13:30:00.000Z",
    completedAt: null,
    failedAt: null,
    failureReason: null,
    ...overrides,
  };
}

function aggregate() {
  return {
    cohort: {
      marketId: "CA_TSX",
      currency: "CAD",
      signalSemanticsVersion: "signals-v1",
      replayScope: "LIVE",
      profileId,
      profileName: "Momentum core",
      profileConfigId,
      configVersion: "config-v7",
      strategyKey: "ORB_RETEST",
      strategyVersion: "1.0.0",
      source: "LIVE",
      executionModelVersion: "paper-execution-v7",
      assumptions: { notes: "fixture assumptions" },
    },
    model: "QUOTE",
    signalCount: 4,
    eligibleSignalCount: 3,
    fills: 2,
    noFills: 1,
    rejectedEconomics: 1,
    closedTrades: 2,
    openExecutions: 0,
    closePendingExecutions: 0,
    unresolvedExecutions: 0,
    fillRate: { numerator: 2, denominator: 3, value: 2 / 3 },
    winRate: { numerator: 1, denominator: 2, value: 0.5 },
    averageR: 0.4,
    expectancyR: 0.4,
    cumulativeR: 0.8,
    exitReasons: { TARGET: 1, STOP: 1 },
    noFillReasons: { MISSING_QUOTE: 1 },
    economicsReasons: { NET_TARGET_NON_POSITIVE: 1 },
    sizeCoverage: [],
    exitSizeCoverage: [],
    entrySpread: {
      sampleCount: 0,
      minimum: null,
      maximum: null,
      average: null,
    },
    delayedClose: { count: 0, totalDurationMs: 0, averageDurationMs: null },
  };
}

function evidenceFetch(
  netPnl = 24.5,
  options: {
    runs?: Record<string, unknown>[];
    aggregates?: unknown[];
    funded?: unknown;
  } = {},
) {
  const wins = netPnl > 0 ? 1 : 0;
  const runs = options.runs ?? [];
  const aggregates = options.aggregates ?? [];
  const funded = options.funded ?? fundedAccount();
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith("/api/paper-bot/activities")
      ? {
          activities: [
            {
              id: "10000000-0000-4000-8000-000000000401",
              runId: "10000000-0000-4000-8000-000000000402",
              occurredAt: "2026-08-31T13:30:00.000Z",
              eventType: "RUN_STARTED",
              severity: "INFO",
              symbol: null,
              strategyKey: null,
              model: null,
              message: "Paper bot started today's live run.",
              details: {},
            },
          ],
        }
      : url.startsWith("/api/paper-bot/funded-account")
        ? funded
        : url.startsWith("/api/paper-bot/coordination/summary")
          ? {
              summary: {
                policyVersions: ["paper-coordination-v2"],
                decisions: 2,
                approved: 1,
                deferred: 1,
                rejected: 0,
                reasons: { SELECTED_PRIMARY: 1, POST_STOP_COOLDOWN: 1 },
                openPositions: 0,
                closedTrades: 1,
                wins,
                winRate: { numerator: wins, denominator: 1, value: wins },
                netPnl,
                cumulativeR: netPnl > 0 ? 0.5 : -1.25,
                averageR: netPnl > 0 ? 0.5 : -1.25,
                exitReasons: { TARGET: 1 },
                symbolsTraded: 1,
                repeatedSymbolEntries: 0,
              },
            }
          : url.startsWith("/api/paper-bot/coordination/decisions")
            ? {
                decisions: [
                  {
                    id: "10000000-0000-4000-8000-000000000403",
                    runId: "10000000-0000-4000-8000-000000000402",
                    symbol: "ABC",
                    decisionTimestamp: "2026-08-31T14:00:00.000Z",
                    outcome: "APPROVED",
                    reason: "SELECTED_PRIMARY",
                    policyVersion: "paper-coordination-v2",
                    selectedObservationId:
                      "10000000-0000-4000-8000-000000000404",
                    selectedStrategyKey: "ORB_RETEST",
                    confirmationObservationIds: [],
                    candidateCount: 2,
                    contexts: [],
                    state: {},
                    positionStatus: "CLOSED",
                    exitReason: "TARGET",
                    exitTime: "2026-08-31T14:20:00.000Z",
                    netPnl: 24.5,
                    rMultiple: 0.5,
                    createdAt: "2026-08-31T14:00:01.000Z",
                  },
                ],
              }
            : url.startsWith("/api/paper-bot/curves")
              ? { points: [] }
              : url.startsWith("/api/paper-bot/divergences")
                ? { divergences: [] }
                : url.startsWith("/api/paper-bot/comparisons")
                  ? { comparisons: [] }
                  : url.startsWith("/api/paper-bot/qualifications")
                    ? { qualifications: [] }
                    : url.startsWith("/api/paper-bot/runs")
                      ? { runs }
                      : { aggregates };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
}

function fundedAccount(realizedPnl = 12.5) {
  return {
    status: "READY",
    account: {
      projection: "FUNDED_PAPER_ACCOUNT",
      marketId: "CA_TSX",
      currency: "CAD",
      accountId: "10000000-0000-4000-8000-000000000501",
      runId: "10000000-0000-4000-8000-000000000502",
      runStatus: "COMPLETED",
      sessionDate: "2026-08-31",
      asOf: "2026-08-31T20:05:00.000Z",
      temporalScope: "CURRENT_ACCOUNT",
      qualifiedForCapitalAllocation: false,
      qualificationReason:
        "Out-of-sample and walk-forward qualification is not established by execution reporting",
      summary: {
        cash: 10_000 + realizedPnl,
        equity: 10_000 + realizedPnl,
        realizedPnl,
        dailyPnl: realizedPnl,
        reservedCash: 0,
        openRisk: 0,
        remainingDailyRisk: 200,
        staleMarks: false,
        entriesAllowed: true,
      },
      activity: {
        decisions: 3,
        closed: 1,
        open: 1,
        pending: 0,
        rejected: 1,
        cancelled: 0,
        wins: realizedPnl > 0 ? 1 : 0,
        cumulativeR: realizedPnl > 0 ? 0.5 : -1.25,
      },
      warnings: ["SIMULATED_LIQUIDITY_NOT_GUARANTEED"],
    },
  };
}

describe("BOT evidence dashboard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("defaults to Overview with the liveness panel and local section navigation", async () => {
    vi.stubGlobal("fetch", evidenceFetch());

    render(<BotView />);

    expect(screen.getByLabelText("Bot liveness")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Results" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Diagnostics" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText(/Today’s bot activity/)).toBeInTheDocument();
    expect(
      screen.queryByText("Independent evidence results"),
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText("Close pending")).toBeInTheDocument(),
    );
  });

  it("leads the overview with today's funded account and switches to the shadow", async () => {
    const fetch = evidenceFetch();
    vi.stubGlobal("fetch", fetch);

    render(<BotView />);

    const journal = screen.getByRole("button", {
      name: "Today’s bot activity journal",
    });
    expect(journal).toHaveAttribute("aria-expanded", "true");

    // The disclosure's stretched overlay must be scoped to the title row.
    // Without a positioned row it covered the whole page and swallowed every
    // other click, and the projection controls must stay above it.
    expect(journal.closest("div")).toHaveClass("tw:relative");
    expect(
      screen.getByRole("group", { name: "Bot activity projection" }),
    ).toHaveClass("tw:relative", "tw:z-[1]");

    await waitFor(() =>
      expect(screen.getByText("+$12.50")).toBeInTheDocument(),
    );
    const panel = journal.closest("section");
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(screen.getByText("+$12.50"));
    expect(panel).toContainElement(
      screen.getByText("Paper bot started today's live run."),
    );
    expect(panel).toContainElement(screen.getByRole("status"));
    expect(
      screen.getByRole("button", { name: "Funded account" }),
    ).toHaveAttribute("aria-pressed", "true");

    // The coordinated projection stays one explicit click away, is never
    // added to the funded account's numbers, and the funded read is scoped
    // to the selected market.
    fireEvent.click(screen.getByRole("button", { name: "Coordinated shadow" }));
    await waitFor(() =>
      expect(screen.getByText("+$24.50")).toBeInTheDocument(),
    );
    expect(screen.queryByText("+$12.50")).not.toBeInTheDocument();
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).startsWith("/api/paper-bot/funded-account?marketId=CA_TSX"),
      ),
    ).toBe(true);

    // The top journal is scoped to the current session; the retained journal
    // request for Diagnostics stays unfiltered by date.
    const activityUrls = fetch.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/paper-bot/activities"));
    const scoped = activityUrls.filter((url) => url.includes("startDate="));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((url) => /startDate=\d{4}-\d{2}-\d{2}/.test(url))).toBe(
      true,
    );
    expect(activityUrls.some((url) => !url.includes("startDate="))).toBe(true);
  });

  it("loads only aggregate evidence endpoints and keeps incomplete evidence visible", async () => {
    const fetch = evidenceFetch();
    vi.stubGlobal("fetch", fetch);

    render(<BotView />);

    await waitFor(() =>
      expect(screen.getByText("Close pending")).toBeInTheDocument(),
    );
    expect(screen.getByText("Economics rejected")).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByText("Economics rejected").parentElement!);
    await waitFor(() =>
      expect(
        screen.getByRole("tooltip", {
          name: /intentionally declined because their expected trading economics/i,
        }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Results" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "No canonical forward evidence matches these filters.",
        ),
      ).toBeInTheDocument(),
    );

    // The coordinated projection is shown with its own totals, never folded
    // into the independent per-strategy evidence; it lives in Diagnostics.
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(
      screen.getByText("Coordinated portfolio · shadow"),
    ).toBeInTheDocument();
    expect(screen.getByText("coordinated only")).toBeInTheDocument();
    expect(screen.getByText(/ABC · selected primary/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText("Paper bot started today's live run."),
      ).toBeInTheDocument(),
    );

    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).startsWith("/api/paper-bot/executions"),
      ),
    ).toBe(false);
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).startsWith("/api/paper-bot/aggregates"),
      ),
    ).toBe(true);
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).startsWith("/api/paper-bot/journal"),
      ),
    ).toBe(false);
  });

  // The panels stack far past one screen, so each one folds from its title and
  // the supplementary ones start folded.
  it("folds panels from their titles, defaults the filters folded, and remembers the fold", async () => {
    vi.stubGlobal("fetch", evidenceFetch());

    render(<BotView />);

    await waitFor(() =>
      expect(
        screen.getByText("Paper bot started today's live run."),
      ).toBeInTheDocument(),
    );

    const filters = screen.getByRole("button", {
      name: "Forward paper evidence",
    });
    expect(filters).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(filters);
    expect(filters).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Profile configuration")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Results" }));
    const quality = screen.getByRole("button", {
      name: "Fillability and data quality",
    });
    expect(quality).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(quality);
    expect(quality).toHaveAttribute("aria-expanded", "true");
    expect(
      JSON.parse(localStorage.getItem("tsx-scanner-bot-collapsed") ?? "{}"),
    ).toMatchObject({ filters: false, quality: false });

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    const journal = screen.getByRole("button", {
      name: "Bot activity journal",
    });
    expect(journal).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(journal);

    expect(journal).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByText("Paper bot started today's live run."),
    ).not.toBeVisible();
    expect(
      JSON.parse(localStorage.getItem("tsx-scanner-bot-collapsed") ?? "{}"),
    ).toMatchObject({ activity: true });
  });

  it("shows today's unresolved executions without treating the reconciliation batch as backlog", async () => {
    vi.stubGlobal(
      "fetch",
      evidenceFetch(24.5, {
        aggregates: [
          { ...aggregate(), openExecutions: 2, closePendingExecutions: 1 },
        ],
      }),
    );

    render(
      <BotView
        paperBot={{
          runId: null,
          sessionDate: null,
          scheduledCloseAt: null,
          executionModelVersion: null,
          openExecutions: 0,
          closePendingExecutions: 0,
          closedExecutions: 0,
          noFillExecutions: 0,
          reconciliationBacklog: 2,
          unreconcilableEvents: 0,
          overdueRuns: 0,
          abandonedExecutions: 0,
          lastTransitionAt: null,
          lastProcessingDurationMs: null,
          lastError: null,
        }}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          /3 independent quote execution\(s\) still open or close-pending/,
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/Stuck events and overdue runs are shown separately/),
    ).not.toBeInTheDocument();
  });

  it("derives plain-language session status from a running run", async () => {
    vi.stubGlobal("fetch", evidenceFetch(24.5, { runs: [run()] }));

    render(<BotView />);

    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Collecting now"));
    expect(screen.getByText("paper-execution-v7")).toBeInTheDocument();
    expect(screen.getByText(/Session closes/)).toBeInTheDocument();
    expect(
      screen.queryByText("Next session opens automatically"),
    ).not.toBeInTheDocument();
  });

  it("announces a completed session with its finish time", async () => {
    vi.stubGlobal(
      "fetch",
      evidenceFetch(24.5, {
        runs: [
          run({
            status: "COMPLETED",
            completedAt: "2026-08-31T20:05:00.000Z",
          }),
        ],
      }),
    );

    render(<BotView />);

    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Session finished"));
    expect(
      screen.getByText("Next session opens automatically"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Completed").nextElementSibling,
    ).not.toHaveTextContent("—");
  });

  it("surfaces a failed run with its recorded reason", async () => {
    vi.stubGlobal(
      "fetch",
      evidenceFetch(24.5, {
        runs: [
          run({
            status: "FAILED",
            failedAt: "2026-08-31T15:00:00.000Z",
            failureReason: "quote feed unavailable",
          }),
        ],
      }),
    );

    render(<BotView />);

    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Needs attention"));
    expect(screen.getByText(/quote feed unavailable/)).toBeInTheDocument();
    expect(screen.getByText("Failed").nextElementSibling).not.toHaveTextContent(
      "—",
    );
  });

  it("switches to Results for the independent cohort evidence", async () => {
    vi.stubGlobal("fetch", evidenceFetch(24.5, { aggregates: [aggregate()] }));

    render(<BotView />);

    fireEvent.click(screen.getByRole("button", { name: "Results" }));

    expect(
      screen.getByText("Independent evidence results"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Momentum core")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Canonical performance by exact cohort"),
    ).toBeInTheDocument();

    // The assumptions JSON is a disclosure, not part of the default scan.
    const assumptions = screen
      .getByText("Assumptions snapshot")
      .closest("details");
    expect(assumptions).not.toBeNull();
    expect(assumptions).not.toHaveAttribute("open");
  });

  it("switches to Diagnostics for the full journal, decisions and raw identifiers", async () => {
    vi.stubGlobal("fetch", evidenceFetch());

    render(<BotView />);

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

    expect(
      screen.getByText("Diagnostics and raw identifiers"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Coordinated portfolio · shadow"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText("Paper bot started today's live run."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/ABC · selected primary/)).toBeInTheDocument();
    expect(
      screen.getByText(/10000000-0000-4000-8000-000000000401/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/10000000-0000-4000-8000-000000000403/),
    ).toBeInTheDocument();
  });

  it("links from the Overview preview into the full Diagnostics journal", async () => {
    vi.stubGlobal("fetch", evidenceFetch());

    render(<BotView />);

    await waitFor(() =>
      expect(
        screen.getByText("Paper bot started today's live run."),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "View full activity in Diagnostics" }),
    );
    expect(screen.getByRole("button", { name: "Diagnostics" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Bot activity journal" }),
    ).toBeInTheDocument();
  });

  // The glance answers "how did today go?" from the funded paper account by
  // default; the coordinated shadow remains a separate projection.
  it("colours the funded glance by its result and scopes it to today", async () => {
    const fetch = evidenceFetch();
    vi.stubGlobal("fetch", fetch);

    render(<BotView />);

    await waitFor(() =>
      expect(screen.getByText("+$12.50")).toBeInTheDocument(),
    );
    expect(screen.getByText("+$12.50").closest("article")).toHaveClass(
      "bot-glance",
      "positive",
    );
    expect(screen.getByText("+0.50R · 100% WIN (1/1)")).toBeInTheDocument();
    expect(
      screen.getByText(/TODAY · FUNDED PAPER ACCOUNT/),
    ).toBeInTheDocument();
    expect(
      fetch.mock.calls.some(([url]) =>
        /^\/api\/paper-bot\/funded-account\?marketId=CA_TSX/.test(String(url)),
      ),
    ).toBe(true);
    expect(
      fetch.mock.calls.some(([url]) =>
        /^\/api\/paper-bot\/coordination\/summary\?.*startDate=/.test(
          String(url),
        ),
      ),
    ).toBe(true);
  });

  it("marks a losing funded session in the glance", async () => {
    vi.stubGlobal(
      "fetch",
      evidenceFetch(24.5, { funded: fundedAccount(-118.25) }),
    );

    render(<BotView />);

    await waitFor(() =>
      expect(screen.getByText("−$118.25")).toBeInTheDocument(),
    );
    expect(screen.getByText("−$118.25").closest("article")).toHaveClass(
      "negative",
    );
  });

  it("opens retained results through the optional performance action", async () => {
    const onOpenPerformance = vi.fn();
    vi.stubGlobal("fetch", evidenceFetch());

    render(<BotView onOpenPerformance={onOpenPerformance} />);

    await waitFor(() =>
      expect(screen.getByText("Close pending")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "View retained results" }),
    );
    expect(onOpenPerformance).toHaveBeenCalledTimes(1);
  });

  it("omits the retained results action when no handler is provided", async () => {
    vi.stubGlobal("fetch", evidenceFetch());

    render(<BotView />);

    expect(
      screen.queryByRole("button", { name: "View retained results" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Close pending")).toBeInTheDocument(),
    );
  });

  it("scopes fetch requests to US_EQUITIES when marketId is US_EQUITIES", async () => {
    const fetch = evidenceFetch(50);
    vi.stubGlobal("fetch", fetch);

    render(<BotView marketId="US_EQUITIES" />);

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    await waitFor(() =>
      expect(
        screen.getByText("Coordinated portfolio · shadow"),
      ).toBeInTheDocument(),
    );

    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("marketId=US_EQUITIES"))).toBe(true);
    const marketScopedUrls = urls.filter(
      (url) =>
        url.startsWith("/api/paper-bot/aggregates") ||
        url.startsWith("/api/paper-bot/coordination/summary") ||
        url.startsWith("/api/paper-bot/funded-account") ||
        url.startsWith("/api/paper-bot/runs") ||
        url.startsWith("/api/paper-bot/activities"),
    );
    expect(marketScopedUrls.length).toBeGreaterThan(0);
    for (const url of marketScopedUrls) {
      expect(url).toContain("marketId=US_EQUITIES");
    }
  });
});
