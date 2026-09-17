import {
  candidateDetailSchema,
  type CandidateDetail,
} from "@tsx-scanner/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Detail } from "./DetailView.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function feature(overrides: Record<string, unknown> = {}) {
  return {
    marketId: "CA_TSX",
    instrumentId: "00000000-0000-4000-8000-000000000011",
    symbol: "WRN.TO",
    timestamp: "2026-09-14T14:29:00.000Z",
    timeframe: "OneMinute",
    featureVersion: "feature-v3",
    configVersion: "config-v7",
    dataStatus: "DELAYED",
    actionable: false,
    price: 10,
    bid: 9.99,
    ask: 10.01,
    mid: 10,
    spreadAbsolute: 0.02,
    spreadPct: 0.2,
    changeFromOpenPct: 0,
    vwap: 10,
    distanceFromVwapPct: 0,
    closeAboveVwap: false,
    last3ClosesAboveVwap: 0,
    vwapSlopePct: null,
    touchVwap: false,
    vwapReclaim: false,
    vwapRejection: false,
    atr14: null,
    atrPct: null,
    rvolAtTime: null,
    currentCumulativeVolume: 0,
    historicalMeanCumulativeVolume: null,
    openingRange: null,
    swingHighs: [],
    swingLows: [],
    nearestSupport: null,
    nearestResistance: null,
    distanceFromVwapAtr: null,
    distanceFromOrhAtr: null,
    changeFromOpenAtr: null,
    consecutiveGreenCandles: 0,
    recentMoveVelocityAtr: null,
    warmingUp: ["vwap", "rvol"],
    ...overrides,
  };
}

function warmingDetail(): CandidateDetail {
  return candidateDetailSchema.parse({
    symbol: "WRN.TO",
    strategies: [],
    contexts: [],
    feature: feature(),
    candles: [],
    events: [],
    member: null,
    coverage: {
      symbol: "WRN.TO",
      status: "WARMING",
      dataReadiness: "WARMING",
      warmupPending: ["vwap"],
      setupCount: 0,
      contextCount: 0,
      latestAnalysisAt: null,
      reasons: ["Waiting for the opening-range window to complete"],
    },
  });
}

function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function renderDetail() {
  return render(<Detail symbol="WRN.TO" profileId="ALL" close={() => {}} />);
}

describe("Detail", () => {
  it("shows warming and empty states when no setup or context evidence exists", async () => {
    stubFetch(warmingDetail());
    renderDetail();

    expect(
      await screen.findByText(/Waiting for the opening-range window/),
    ).toBeInTheDocument();
    expect(screen.getByText("Waiting for vwap")).toBeInTheDocument();
    expect(screen.getByText("Waiting for rvol")).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for 5-minute candles…"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No setup evaluation is available/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No context profiles are enabled or available."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No state transition has been recorded/),
    ).toBeInTheDocument();
  });

  it("surfaces a candidate detail request error instead of an empty view", async () => {
    stubFetch({ error: "Candidate detail is temporarily unavailable" }, 503);
    renderDetail();

    await waitFor(() =>
      expect(
        screen.getByText("Candidate detail is temporarily unavailable"),
      ).toBeInTheDocument(),
    );
  });
});
