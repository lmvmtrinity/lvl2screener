import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJson } from "../lib/api.js";
import { FundedReplayPanel } from "./FundedReplayPanel.js";

vi.mock("../lib/api.js", () => ({ getJson: vi.fn() }));

const runId = "10000000-0000-4000-8000-0000000000c1";
const fixture = {
  marketId: "CA_TSX",
  runs: [
    {
      projection: "FUNDED_PORTFOLIO_REPLAY",
      runId,
      accountId: "10000000-0000-4000-8000-0000000000c2",
      marketId: "CA_TSX",
      currency: "CAD",
      sessionDate: "2026-09-08",
      runStatus: "COMPLETED",
      executionModelVersion: "paper-execution-v7",
      temporalScope: "RUN_END",
      asOf: "2026-09-08T20:00:00.000Z",
      qualifiedForCapitalAllocation: false,
      qualificationReason:
        "Out-of-sample and walk-forward qualification is not established by execution reporting",
      isCurrentAccount: false,
      summary: {
        cash: 9_996.54,
        equity: 9_996.54,
        realizedPnl: -3.46,
        dailyPnl: -3.46,
        reservedCash: 0,
        openRisk: 0,
        remainingDailyRisk: 196.54,
        staleMarks: false,
        entriesAllowed: true,
      },
      orderCounts: { pending: 0, filled: 1, cancelled: 0, rejected: 0 },
      orders: [
        {
          orderId: "10000000-0000-4000-8000-0000000000c3",
          instrumentId: "10000000-0000-4000-8000-0000000000c4",
          status: "FILLED",
          executionStatus: "CLOSED",
          reason: null,
          shares: 25,
          entryPrice: 71.25,
          exitReason: "TIME_STOP",
          netPnl: -3.46,
          rMultiple: -0.18,
        },
      ],
      warnings: ["SIMULATED_LIQUIDITY_NOT_GUARANTEED"],
    },
  ],
};

const runningFixture = {
  marketId: "CA_TSX",
  runs: [
    {
      ...fixture.runs[0],
      runId: "10000000-0000-4000-8000-0000000000d1",
      sessionDate: "2026-09-09",
      runStatus: "RUNNING",
      orderCounts: { pending: 1, filled: 0, cancelled: 0, rejected: 0 },
      orders: [],
      summary: { ...fixture.runs[0].summary, equity: 10_000, realizedPnl: 0 },
    },
  ],
};

const path = "/api/funded-replays?marketId=CA_TSX";

describe("FundedReplayPanel", () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("separates funded account results from independent signal outcomes", async () => {
    vi.mocked(getJson).mockResolvedValue(fixture);
    render(<FundedReplayPanel marketId="CA_TSX" />);

    expect(
      await screen.findByRole("heading", { name: "Funded portfolio replay" }),
    ).toBeInTheDocument();
    expect(getJson).toHaveBeenCalledWith(path, expect.anything());
    expect(
      screen.getByText(/Independent signal outcomes above/),
    ).toBeInTheDocument();
    expect(screen.getByText("SIMULATED · NOT QUALIFIED")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("2026-09-08")).toBeInTheDocument(),
    );
    expect(screen.getByText(/1 fills · 0 rejected/)).toBeInTheDocument();
    expect(screen.getByText("FILLED · TIME STOP")).toBeInTheDocument();
    expect(screen.getByText("25 shares @ 71.25")).toBeInTheDocument();
    expect(
      screen.getByText(/not qualified for capital allocation/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Replay settled · no automatic refresh is running/),
    ).toBeInTheDocument();
  });

  it("reports an empty market without inventing results", async () => {
    vi.mocked(getJson).mockResolvedValue({
      marketId: "US_EQUITIES",
      runs: [],
    });
    render(<FundedReplayPanel marketId="US_EQUITIES" />);
    expect(
      await screen.findByText("No funded replays for this market yet."),
    ).toBeInTheDocument();
    expect(getJson).toHaveBeenCalledWith(
      "/api/funded-replays?marketId=US_EQUITIES",
      expect.anything(),
    );
  });

  it("refreshes while a replay is in flight and stops once it settles", async () => {
    vi.useFakeTimers();
    vi.mocked(getJson)
      .mockResolvedValueOnce(runningFixture)
      .mockResolvedValueOnce(fixture);
    render(<FundedReplayPanel marketId="CA_TSX" />);

    await act(async () => {});
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/1 replay in flight · results refresh automatically/),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getJson).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(/Replay settled · no automatic refresh is running/),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getJson).toHaveBeenCalledTimes(2);
  });
});
