import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperPerformanceCurve } from "@tsx-scanner/contracts";
import { BotPerformanceGraph } from "./BotPerformanceGraph.js";

function curve(
  overrides: Partial<PaperPerformanceCurve> = {},
): PaperPerformanceCurve {
  return {
    account: "COORDINATED",
    marketId: "CA_TSX",
    currency: "CAD",
    granularity: "TRADE",
    startDate: "2026-09-15",
    endDate: "2026-09-15",
    points: [
      {
        sessionDate: "2026-09-15",
        closedAt: "2026-09-15T14:30:00.000Z",
        netPnl: 60,
        cumulativeNetPnl: 60,
        trades: 1,
      },
      {
        sessionDate: "2026-09-15",
        closedAt: "2026-09-15T19:00:00.000Z",
        netPnl: -25,
        cumulativeNetPnl: 35,
        trades: 1,
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function stubFetch(resolve: (url: string) => PaperPerformanceCurve) {
  const fetch = vi.fn(
    async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(resolve(String(input))), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function lastUrl(fetch: ReturnType<typeof stubFetch>): string {
  return String(fetch.mock.calls.at(-1)?.[0]);
}

describe("BotPerformanceGraph", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("defaults to the funded account, anchors 1D to the latest session, and summarizes the range", async () => {
    const fetch = stubFetch(() =>
      curve({ account: "FUNDED", granularity: "DAY" }),
    );
    render(
      <BotPerformanceGraph latestSessionDate="2026-09-15" marketId="CA_TSX" />,
    );

    await waitFor(() =>
      expect(screen.getByText("RANGE P&L")).toBeInTheDocument(),
    );
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toContain("/api/paper-bot/performance?");
    expect(url).toContain("account=FUNDED");
    expect(url).toContain("granularity=DAY");
    expect(url).toContain("startDate=2026-09-15");
    expect(url).toContain("endDate=2026-09-15");
    expect(url).toContain("source=LIVE");

    // Range P&L +$35, drawdown from the +$60 peak to +$35.
    expect(screen.getAllByText("+$35.00").length).toBeGreaterThan(0);
    expect(screen.getByText("−$25.00")).toBeInTheDocument();
    expect(screen.getByText("CLOSED TRADES")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: /Funded account equity performance curve for 1D/,
      }),
    ).toBeInTheDocument();
  });

  it("switches long ranges to one point per session", async () => {
    const fetch = stubFetch(() =>
      curve({ granularity: "DAY", startDate: "2026-06-15" }),
    );
    render(
      <BotPerformanceGraph latestSessionDate="2026-09-15" marketId="CA_TSX" />,
    );
    await waitFor(() =>
      expect(screen.getByText("RANGE P&L")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "3M" }));
    await waitFor(() => expect(lastUrl(fetch)).toContain("granularity=DAY"));
    expect(lastUrl(fetch)).toContain("startDate=2026-06-15");
    expect(lastUrl(fetch)).toContain("endDate=2026-09-15");
  });

  it("defaults to the funded account and explains an unavailable boundary", async () => {
    const fetch = stubFetch((url) =>
      url.includes("account=FUNDED")
        ? {
            account: "FUNDED",
            marketId: "US_EQUITIES",
            currency: "USD",
            granularity: "DAY",
            startDate: "2026-09-15",
            endDate: "2026-09-15",
            points: [],
            warnings: ["FUNDED_RUN_BOUNDARY_UNAVAILABLE"],
          }
        : curve({ account: "COORDINATED" }),
    );
    render(
      <BotPerformanceGraph
        latestSessionDate="2026-09-15"
        marketId="US_EQUITIES"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/priced at a later mark/)).toBeInTheDocument(),
    );
    expect(lastUrl(fetch)).toContain("account=FUNDED");
    expect(lastUrl(fetch)).toContain("granularity=DAY");
    expect(lastUrl(fetch)).toContain("marketId=US_EQUITIES");
    expect(
      screen.getByText(
        /No completed funded run has a retained run-end boundary in this range/,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "COORDINATED" }));
    await waitFor(() =>
      expect(lastUrl(fetch)).toContain("account=COORDINATED"),
    );
    await waitFor(() =>
      expect(screen.getByText("RANGE P&L")).toBeInTheDocument(),
    );
  });
});
