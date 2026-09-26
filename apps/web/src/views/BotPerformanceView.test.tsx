import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperJournalProjection } from "@tsx-scanner/contracts";
import { BotPerformanceView } from "./BotPerformanceView.js";

function response(projection: PaperJournalProjection) {
  return {
    projection,
    entries: [
      {
        id: "10000000-0000-4000-8000-000000000601",
        runId: "10000000-0000-4000-8000-000000000602",
        sessionDate: "2026-08-27",
        symbol: "ABC",
        strategyKey: "ORB_RETEST",
        profileName: "Opening range",
        configVersion: "profile-v1",
        status: "CLOSED",
        entryPrice: 10,
        entryTime: "2026-08-27T14:00:00.000Z",
        stopPrice: 9.5,
        targetPrice: 11,
        shares: 100,
        initialRisk: 50,
        exitPrice: 10.5,
        exitTime: "2026-08-27T15:00:00.000Z",
        exitReason: "TARGET",
        grossPnl: 51,
        costs: 1,
        netPnl: 50,
        rMultiple: 1,
        runningNetPnl: projection === "COORDINATED" ? 50 : null,
      },
    ],
    totals: {
      closedTrades: 1,
      openPositions: 0,
      wins: 1,
      losses: 0,
      scratches: 0,
      winRate: { numerator: 1, denominator: 1, value: 1 },
      grossPnl: 51,
      costs: 1,
      netPnl: 50,
      profitFactor: null,
      cumulativeR: 1,
      averageR: 1,
      largestWin: 50,
      largestLoss: null,
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function projectionOf(url: string): PaperJournalProjection {
  return url.includes("projection=INDEPENDENT")
    ? "INDEPENDENT"
    : url.includes("projection=COORDINATED")
      ? "COORDINATED"
      : "FUNDED";
}

describe("BotPerformanceView", () => {
  beforeEach(() => {
    // Only Date is faked so waitFor's timers keep running.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-29T20:00:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads the funded account for the last 30 days and the month, then shows the latest session", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      json(response(projectionOf(String(input)))),
    );
    vi.stubGlobal("fetch", fetch);

    render(<BotPerformanceView />);

    const trades = await screen.findByRole("region", {
      name: "Session trades",
    });
    expect(within(trades).getByText("ABC")).toBeInTheDocument();
    expect(within(trades).getAllByText("+$50.00").length).toBeGreaterThan(0);
    const urls = fetch.mock.calls.map(([input]) => String(input));
    // The funded paper account is the default ledger projection.
    expect(urls.every((url) => url.includes("projection=FUNDED"))).toBe(true);
    expect(urls).toContainEqual(
      expect.stringContaining("startDate=2026-07-31&endDate=2026-08-29"),
    );
    expect(urls).toContainEqual(
      expect.stringContaining("startDate=2026-08-01&endDate=2026-08-31"),
    );
    expect(
      screen.getByRole("gridcell", { name: /Aug 27: \+\$50\.00, 1 trade/ }),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Independent" }));
    await waitFor(() =>
      expect(String(fetch.mock.calls.at(-1)?.[0])).toContain(
        "projection=INDEPENDENT",
      ),
    );
  });

  it("switches values between dollars and percent of position", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(response("FUNDED"))),
    );
    render(<BotPerformanceView />);

    const summary = await screen.findByRole("region", {
      name: "Performance summary",
    });
    await waitFor(() =>
      expect(within(summary).getAllByText("+$50.00").length).toBeGreaterThan(0),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Value unit" })).getByRole(
        "button",
        { name: "%" },
      ),
    );
    // $50 on a $1,000 entry is 5% of the position.
    expect(within(summary).getAllByText("+5.00%").length).toBeGreaterThan(0);
  });

  it("explains performance metrics in hover tooltips", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(response("FUNDED"))),
    );
    render(<BotPerformanceView />);

    const label = await screen.findByText("Last 30 days");
    fireEvent.mouseEnter(label.parentElement!);
    await waitFor(() =>
      expect(
        screen.getByRole("tooltip", {
          name: /Realized profit or loss after trading costs/i,
        }),
      ).toBeInTheDocument(),
    );
  });

  it("shows the cumulative curve for the last 30 days", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(response("FUNDED"))),
    );
    render(<BotPerformanceView />);
    await screen.findByRole("region", { name: "Session trades" });

    fireEvent.click(
      within(screen.getByRole("group", { name: "Chart view" })).getByRole(
        "button",
        { name: "Curve" },
      ),
    );
    expect(
      screen.getByRole("img", {
        name: /Cumulative realized P&L over 1 session, ending at \+\$50\.00/,
      }),
    ).toBeInTheDocument();
  });

  it("shows refresh freshness and keeps the last successful read on failure", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        // The first load makes two requests (30 days and the month).
        if (calls > 2) return json({ error: "boom" }, 500);
        return json(response("FUNDED"));
      }),
    );
    render(<BotPerformanceView />);

    await waitFor(() =>
      expect(screen.getByText(/checked/)).toBeInTheDocument(),
    );
    expect(screen.getByText("ABC")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        screen.getByText(/showing the last successful read/),
      ).toBeInTheDocument(),
    );
    // The previous journal is still rendered, explicitly marked as last known.
    expect(screen.getByText("ABC")).toBeInTheDocument();
  });

  it("shows open positions with Opened and Last activity separated and scoped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        json({
          ...response(projectionOf(String(input))),
          unresolvedPositions: [
            {
              id: "10000000-0000-4000-8000-000000000701",
              symbol: "XYZ",
              sessionDate: "2026-08-29",
              status: "CLOSE_PENDING",
              runStatus: "CLOSE_PENDING",
              entryTime: "2026-08-29T14:10:00.000Z",
              lastFactTimestamp: "2026-08-29T19:55:00.000Z",
              ageMs: 1_800_000,
            },
          ],
        }),
      ),
    );
    render(<BotPerformanceView />);

    const open = await screen.findByRole("region", { name: "Open positions" });
    await waitFor(() =>
      expect(within(open).getByText("XYZ")).toBeInTheDocument(),
    );
    expect(within(open).getByText("CLOSE PENDING")).toBeInTheDocument();
    expect(within(open).getByText(/Opened/)).toBeInTheDocument();
    expect(within(open).getByText(/Last activity/)).toBeInTheDocument();
    expect(
      within(open).getByText(/excluded from realized results until every exit/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 open/)).toBeInTheDocument();

    fireEvent.click(
      within(
        screen.getByRole("group", { name: "Performance projection" }),
      ).getByRole("button", { name: "Coordinated" }),
    );
    await waitFor(() =>
      expect(
        within(open).getByText(/funded-account results are on the Bot page/),
      ).toBeInTheDocument(),
    );
  });

  it("marks entries recovered during settlement so unfinished work is traceable", async () => {
    const base = response("FUNDED");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ...base,
          entries: [
            {
              ...base.entries[0],
              recoverySource: "SETTLEMENT_RECOVERY",
              recoveryDelayMs: 4_200,
            },
          ],
        }),
      ),
    );
    render(<BotPerformanceView />);

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });
});
