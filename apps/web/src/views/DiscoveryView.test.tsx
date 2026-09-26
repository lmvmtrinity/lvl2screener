import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DailySeedHistoryEntry,
  DailySeedLegacy,
  DailySeedSelection,
  DailySeedStatus,
} from "@tsx-scanner/contracts";
import { getJson, sendJson } from "../lib/api.js";
import { DiscoveryView, scoreParts } from "./DiscoveryView.js";

vi.mock("../lib/api.js", () => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

const selection: DailySeedSelection = {
  marketId: "US_EQUITIES",
  version: "daily-seed-v1",
  tradingDate: "2026-09-25",
  selectedAt: "2026-09-25T12:45:00.000Z",
  poolSize: 3874,
  prefiltered: 922,
  scored: 897,
  requests: 1000,
  durationMs: 87_000,
  picks: [
    {
      symbol: "BB",
      score: 98,
      price: 5,
      atrPct: 5.15,
      relativeVolume: 3.87,
      closeLocation: 0.92,
      changePct: 4.18,
      aboveSma20: true,
      dollarVolume: 90_000_000,
    },
    {
      symbol: "VKTX",
      score: 94.8,
      price: 30,
      atrPct: 7.5,
      relativeVolume: 5.99,
      closeLocation: 0.79,
      changePct: -11.63,
      aboveSma20: true,
      dollarVolume: 200_000_000,
    },
  ],
};

function seedStatus(overrides: Partial<DailySeedStatus> = {}): DailySeedStatus {
  return {
    marketId: "US_EQUITIES",
    version: "daily-seed-v1",
    enabled: true,
    runAt: "08:45",
    count: 15,
    tradingDate: "2026-09-25",
    session: {
      open: "2026-09-25T13:30:00.000Z",
      close: "2026-09-25T20:00:00.000Z",
    },
    scheduledAt: "2026-09-25T12:45:00.000Z",
    latestRunAt: "2026-09-25T18:30:00.000Z",
    nextRunAt: "2026-09-28T12:45:00.000Z",
    doneDate: "2026-09-25",
    attempts: 1,
    maxAttempts: 4,
    nextAttemptAt: null,
    running: null,
    lastResult: {
      status: "APPLIED",
      selection,
      error: null,
      finishedAt: "2026-09-25T12:46:27.000Z",
      symbols: ["BB", "VKTX"],
    },
    latestSelection: selection,
    rescan: null,
    ...overrides,
  };
}

function mockApi(status: DailySeedStatus, extra: Record<string, unknown> = {}) {
  vi.mocked(getJson).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/universe/daily-seed/history"))
      return extra.history ?? { entries: [] };
    if (path.startsWith("/api/universe/daily-seed/legacy")) return extra.legacy;
    if (path.startsWith("/api/universe/daily-seed"))
      return { seeders: [status] };
    if (path.startsWith("/api/universe")) return extra.universe ?? {};
    throw new Error(`unexpected ${path}`);
  });
}

describe("DiscoveryView", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-25T17:38:00Z"));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.mocked(getJson).mockReset();
    vi.mocked(sendJson).mockReset();
  });

  it("shows an applied seed with its funnel, picks and score breakdown", async () => {
    mockApi(seedStatus(), {
      universe: {
        instruments: [],
        automation: {
          provider: "CONFIGURED_US_LIVE_WATCHLIST",
          policy: {
            version: "us-liquid-momentum-v1",
            marketId: "US_EQUITIES",
            allowedExchanges: ["NASDAQ", "NYSE"],
            allowedCurrencies: ["USD"],
            securityTypes: ["Stock"],
            minimumPrice: 5,
            maximumPrice: 500,
            minimumMarketCap: 0,
            minimumAverageVolume90d: 0,
            minimumDollarVolume: 0,
            minimumAtrPct: 1.5,
            minimumHistoryDays: 20,
          },
          latestRun: null,
          members: [],
          configuredSymbols: ["BB", "VKTX"],
          coverage: [
            {
              symbol: "BB",
              status: "READY",
              dataReadiness: "READY",
              warmupPending: [],
              setupCount: 1,
              contextCount: 0,
              latestAnalysisAt: null,
              reasons: [],
            },
          ],
        },
      },
    });
    render(<DiscoveryView marketId="US_EQUITIES" />);
    expect(
      await screen.findByText("2 stocks added to an empty daily list"),
    ).toBeTruthy();
    expect(screen.getByText("3,874")).toBeTruthy();
    expect(screen.getByText("922")).toBeTruthy();
    expect(screen.getByText("Setup ready")).toBeTruthy();
    expect(screen.getByText("-11.6%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /VKTX/ }));
    expect(screen.getByText(/Traded 6\.0× its usual volume/)).toBeTruthy();
  });

  it("splits a score into the scorer's parts", () => {
    const parts = scoreParts(selection.picks[0]!);
    expect(parts.volume).toBe(40);
    expect(parts.trend).toBe(15);
    expect(parts.close).toBeCloseTo(23, 5);
    expect(parts.atr).toBeCloseTo(20, 5);
  });

  it("previews from a scheduled state and reports progress", async () => {
    mockApi(
      seedStatus({
        doneDate: null,
        attempts: 0,
        lastResult: null,
        latestSelection: null,
      }),
    );
    vi.setSystemTime(new Date("2026-09-25T11:12:00Z"));
    vi.mocked(sendJson).mockResolvedValue({});
    render(<DiscoveryView marketId="US_EQUITIES" />);
    expect(await screen.findByText(/Seeding in 1h 33m/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview ranking" }));
    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith(
        "/api/universe/daily-seed/preview?marketId=US_EQUITIES",
        "POST",
        {},
      ),
    );
  });

  it("offers adding the top picks when the operator list was kept", async () => {
    mockApi(
      seedStatus({
        lastResult: {
          status: "SKIPPED_LIST_PRESENT",
          selection: null,
          error: null,
          finishedAt: "2026-09-25T12:45:01.000Z",
          symbols: ["AAA", "BBB"],
        },
      }),
    );
    vi.mocked(sendJson).mockResolvedValue({ added: ["BB", "VKTX"] });
    render(<DiscoveryView marketId="US_EQUITIES" />);
    expect(
      await screen.findByText("Your 2 symbols were already in place"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Add top 5 to my list" }),
    );
    expect(
      await screen.findByText("Added BB, VKTX to today's list."),
    ).toBeTruthy();
    expect(sendJson).toHaveBeenCalledWith(
      "/api/universe/daily-seed/add-top?marketId=US_EQUITIES&count=5",
      "POST",
      {},
    );
  });

  it("lists history and the frozen engine facts", async () => {
    const entry: DailySeedHistoryEntry = {
      id: "00000000-0000-4000-8000-000000000001",
      marketId: "US_EQUITIES",
      tradingDate: "2026-09-24",
      trigger: "SCHEDULE",
      status: "APPLIED",
      symbols: ["BB", "VKTX"],
      pickCount: 2,
      error: null,
      finishedAt: "2026-09-24T12:46:00.000Z",
      rescanSymbols: ["MOVE"],
      rescanOutcomes: { readySymbols: 1, paperTrades: 1, paperNetR: 0.8 },
      outcomes: { readySymbols: 13, paperTrades: 11, paperNetR: -5.35 },
    };
    const legacy: DailySeedLegacy = {
      markets: [
        {
          marketId: "CA_TSX",
          mode: "OFF",
          firstRunAt: "2026-09-09T13:35:00.000Z",
          lastRunAt: "2026-09-18T19:55:00.000Z",
          poolSize: 482,
        },
        {
          marketId: "US_EQUITIES",
          mode: "OFF",
          firstRunAt: "2026-09-09T13:35:00.000Z",
          lastRunAt: "2026-09-18T15:55:00.000Z",
          poolSize: 3874,
        },
      ],
      evaluationsEstimate: 3_900_000,
      decisions: 0,
      retainedBytes: Math.round(4.6 * 1024 ** 3),
      mappingsRefreshedAt: "2026-09-18T15:00:00.000Z",
    };
    mockApi(seedStatus(), { history: { entries: [entry] }, legacy });
    render(<DiscoveryView marketId="US_EQUITIES" />);
    await screen.findByText("2 stocks added to an empty daily list");
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(await screen.findByText("-5.35 R · 11")).toBeTruthy();
    expect(screen.getByText("+1 · +0.80 R")).toBeTruthy();
    expect(screen.getByText("13")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Legacy engine" }));
    expect(await screen.findByText("FROZEN · OFF")).toBeTruthy();
    expect(screen.getByText("~3.9 M")).toBeTruthy();
    expect(screen.getByText("4.6 GB")).toBeTruthy();
  });

  it("shows the early-session rescan and starts it on request", async () => {
    mockApi(
      seedStatus({
        rescan: {
          version: "daily-seed-v2",
          enabled: true,
          runAt: "09:55",
          maxAdds: 5,
          scheduledAt: "2026-09-25T13:55:00.000Z",
          latestRunAt: "2026-09-25T14:30:00.000Z",
          running: null,
          result: {
            version: "daily-seed-v2",
            tradingDate: "2026-09-25",
            status: "APPLIED",
            barsThrough: "2026-09-25T13:55:00.000Z",
            thresholds: {
              minimumRelativeVolume: 1.75,
              minimumChangeFromOpenPct: 1,
            },
            poolSize: 3874,
            prefiltered: 922,
            evaluated: 148,
            candidates: [
              {
                symbol: "MOVE",
                relativeVolume: 3.1,
                changeFromOpenPct: 2.4,
                gapPct: 1.2,
                price: 42,
                passed: true,
                added: true,
              },
              {
                symbol: "SLOW",
                relativeVolume: 2.2,
                changeFromOpenPct: 0.3,
                gapPct: null,
                price: 30,
                passed: false,
                added: false,
              },
            ],
            added: ["MOVE"],
            error: null,
            finishedAt: "2026-09-25T13:56:10.000Z",
          },
        },
      }),
    );
    vi.mocked(sendJson).mockResolvedValue({});
    render(<DiscoveryView marketId="US_EQUITIES" />);
    expect(await screen.findByText("1 opening mover added: MOVE")).toBeTruthy();
    expect(screen.getByText("3.10×")).toBeTruthy();
    // The day timeline marks the rescan at its scheduled time.
    expect(screen.getByText("rescan")).toBeTruthy();
    expect(screen.getByText("09:55")).toBeTruthy();
    expect(screen.getByText("Below")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rescan now" }));
    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith(
        "/api/universe/daily-seed/rescan?marketId=US_EQUITIES",
        "POST",
        {},
      ),
    );
  });
});
