import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperJournalProjection } from "@tsx-scanner/contracts";
import { BotPerformanceView } from "./BotPerformanceView.js";

function response(projection: PaperJournalProjection) {
  return {
    projection,
    entries: [
      {
        id: "10000000-0000-4000-8000-000000000601",
        runId: "10000000-0000-4000-8000-000000000602",
        sessionDate: "2026-08-29",
        symbol: "ABC",
        strategyKey: "ORB_RETEST",
        profileName: "Opening range",
        configVersion: "profile-v1",
        status: "CLOSED",
        entryPrice: 10,
        entryTime: "2026-08-29T14:00:00.000Z",
        stopPrice: 9.5,
        targetPrice: 11,
        shares: 100,
        initialRisk: 50,
        exitPrice: 10.5,
        exitTime: "2026-08-29T15:00:00.000Z",
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

function performanceCurveResponse(): Response {
  return new Response(
    JSON.stringify({
      account: "COORDINATED",
      marketId: "CA_TSX",
      currency: "CAD",
      granularity: "DAY",
      startDate: "2026-08-01",
      endDate: "2026-08-29",
      points: [],
      warnings: [],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function isPerformanceRequest(input: RequestInfo | URL): boolean {
  return String(input).includes("/api/paper-bot/performance");
}

describe("BotPerformanceView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the all-session ledger and organizes retained entries by session", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (isPerformanceRequest(input)) return performanceCurveResponse();
      const url = String(input);
      return new Response(
        JSON.stringify(
          response(
            url.includes("projection=INDEPENDENT")
              ? "INDEPENDENT"
              : url.includes("projection=FUNDED")
                ? "FUNDED"
                : "COORDINATED",
          ),
        ),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);

    render(<BotPerformanceView />);

    await waitFor(() =>
      expect(screen.getByText("2026-08-29")).toBeInTheDocument(),
    );
    expect(screen.getByText("ABC")).toBeInTheDocument();
    expect(screen.getAllByText("+$50.00")).not.toHaveLength(0);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/paper-bot/journal?"),
      expect.anything(),
    );
    const firstUrl = String(fetch.mock.calls[0][0]);
    // The funded paper account is the default ledger projection.
    expect(firstUrl).toContain("projection=FUNDED");
    expect(firstUrl).not.toMatch(/startDate|endDate/);

    fireEvent.click(screen.getByRole("button", { name: "INDEPENDENT" }));
    await waitFor(() =>
      expect(String(fetch.mock.calls.at(-1)?.[0])).toContain(
        "projection=INDEPENDENT",
      ),
    );
  });

  it("explains performance metrics in hover tooltips", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (isPerformanceRequest(input)) return performanceCurveResponse();
        return new Response(JSON.stringify(response("COORDINATED")), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    render(<BotPerformanceView />);

    await waitFor(() =>
      expect(screen.getByText("NET P&L")).toBeInTheDocument(),
    );
    fireEvent.mouseEnter(screen.getAllByText("NET P&L")[0].parentElement!);
    await waitFor(() =>
      expect(
        screen.getByRole("tooltip", {
          name: /Realized profit or loss after trading costs/i,
        }),
      ).toBeInTheDocument(),
    );
  });

  it("shows refresh freshness and keeps the last successful read on failure", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (isPerformanceRequest(input)) return performanceCurveResponse();
        calls += 1;
        if (calls > 1)
          return new Response(JSON.stringify({ error: "boom" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify(response("COORDINATED")), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    render(<BotPerformanceView />);

    await waitFor(() =>
      expect(screen.getByText(/Checked/)).toBeInTheDocument(),
    );
    expect(screen.getByText("ABC")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "REFRESH" }));
    await waitFor(() =>
      expect(
        screen.getByText(/showing the last successful read/),
      ).toBeInTheDocument(),
    );
    // The previous journal is still rendered, explicitly marked as last known.
    expect(screen.getByText("ABC")).toBeInTheDocument();
  });

  it("shows unfinished funded positions with Opened and Last activity separated and scoped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (isPerformanceRequest(input)) return performanceCurveResponse();
        return new Response(
          JSON.stringify({
            ...response("COORDINATED"),
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
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    render(<BotPerformanceView />);

    await waitFor(() =>
      expect(screen.getByText("Unfinished positions")).toBeInTheDocument(),
    );
    expect(screen.getByText("XYZ")).toBeInTheDocument();
    expect(screen.getAllByText("CLOSE PENDING").length).toBeGreaterThan(0);
    expect(screen.getByText("OPENED")).toBeInTheDocument();
    expect(screen.getByText("LAST ACTIVITY")).toBeInTheDocument();
    expect(screen.getByText("entry time")).toBeInTheDocument();
    expect(screen.getByText("latest processed fact")).toBeInTheDocument();
    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(
      screen.getByText(/excluded from the CLOSED results above/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(
        screen.getByRole("group", { name: "Performance projection" }),
      ).getByRole("button", { name: "COORDINATED" }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/funded-account results are reported on the BOT tab/),
      ).toBeInTheDocument(),
    );
  });

  it("marks entries recovered during settlement so unfinished work is traceable", async () => {
    const base = response("COORDINATED");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (isPerformanceRequest(input)) return performanceCurveResponse();
        return new Response(
          JSON.stringify({
            ...base,
            entries: [
              {
                ...base.entries[0],
                recoverySource: "SETTLEMENT_RECOVERY",
                recoveryDelayMs: 4_200,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    render(<BotPerformanceView />);

    await waitFor(() =>
      expect(screen.getByText("RECOVERED")).toBeInTheDocument(),
    );
  });
});
