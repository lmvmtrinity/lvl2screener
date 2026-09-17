import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ALERT_POLICY,
  type FeatureSnapshot,
  type OperationalStatus,
  type StrategyEvaluation,
  type SystemStatus,
} from "@tsx-scanner/contracts";
import { App } from "./App.js";

const UNIVERSE_POLICY = {
  version: "tsx-liquid-momentum-v1",
  exchange: "TSX" as const,
  currency: "CAD" as const,
  securityTypes: ["Stock"],
  minimumPrice: 1,
  maximumPrice: 100,
  minimumMarketCap: 0,
  minimumAverageVolume90d: 0,
  minimumDollarVolume: 0,
  minimumAtrPct: 0,
  minimumHistoryDays: 20,
};

function operational(
  overrides: Partial<OperationalStatus> = {},
): OperationalStatus {
  return {
    serviceReady: true,
    operationalReady: true,
    actionable: true,
    reasonCodes: [],
    marketDataMode: "mock",
    session: { marketStatus: "OPEN", phase: "PREFERRED_ENTRIES" },
    auth: "CONNECTED",
    dataFreshness: {
      quoteAgeMs: 500,
      candleAgeMs: 500,
      benchmarkAgeMs: 500,
      evaluationAgeMs: 500,
    },
    universe: { configured: 3, resolved: 3, evaluated: 3 },
    benchmarkReady: true,
    scannerSynchronized: true,
    ...overrides,
  };
}

function systemStatus(mode: SystemStatus["mode"] = "live"): SystemStatus {
  return {
    service: "api",
    status: "ok",
    version: "0.12.0",
    timestamp: "2026-08-24T14:00:00.000Z",
    mode,
    checks: {
      database: { status: "ok" },
      scanner: { status: "ok" },
      config: { status: "ok" },
      marketData: { status: "ok" },
    },
    operational: operational(),
  };
}

class StubWebSocket {
  static instances: StubWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) {
    StubWebSocket.instances.push(this);
  }
  close(): void {
    this.readyState = 3;
  }
}

function makeFeatureSnapshot(symbol: string): FeatureSnapshot {
  return {
    marketId: "CA_TSX",
    instrumentId: "5b1f6e2a-6c3a-4b8e-9a1d-8f2e1c4a7b90",
    symbol,
    timestamp: "2026-08-28T14:32:01.123Z",
    timeframe: "OneMinute",
    featureVersion: "feature-v3",
    configVersion: "config-v7",
    dataStatus: "REALTIME",
    actionable: true,
    price: 21.45,
    bid: 21.44,
    ask: 21.46,
    mid: 21.45,
    spreadAbsolute: 0.02,
    spreadPct: 0.09,
    changeFromOpenPct: 1.82,
    rollingReturn5mPct: 0.34,
    vwap: 21.3,
    distanceFromVwapPct: 0.65,
    closeAboveVwap: true,
    last3ClosesAboveVwap: 3,
    vwapSlopePct: 0.04,
    touchVwap: false,
    vwapReclaim: true,
    vwapRejection: false,
    atr14: 0.41,
    atrPct: 1.9,
    rvolAtTime: 2.35,
    currentCumulativeVolume: 812_400,
    historicalMeanCumulativeVolume: 604_100,
    openingRange: null,
    swingHighs: [],
    swingLows: [],
    nearestSupport: null,
    nearestResistance: null,
    supportConfluence: null,
    resistanceConfluence: null,
    distanceFromVwapAtr: null,
    distanceFromOrhAtr: null,
    changeFromOpenAtr: null,
    consecutiveGreenCandles: 0,
    recentMoveVelocityAtr: null,
    warmingUp: [],
  };
}

function makeEvaluation(
  symbol: string,
  state: StrategyEvaluation["state"] = "READY",
): StrategyEvaluation {
  return {
    kind: "SETUP",
    marketId: "CA_TSX",
    instrumentId: "5b1f6e2a-6c3a-4b8e-9a1d-8f2e1c4a7b90",
    symbol,
    timestamp: "2026-08-28T14:32:01.123Z",
    profileId: "9c2f3a10-4b5c-4d6e-8f70-1a2b3c4d5e6f",
    profileName: "Momentum core",
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configVersion: "config-v7",
    state,
    score: 82,
    setupScore: 82,
    scoreVersion: "score-v3",
    scoreComponents: {
      pattern: 20,
      confirmation: 18,
      structure: 16,
      liquidity: 10,
      timing: 10,
      penalties: 0,
    },
    scoreExplanation: [],
    setupInstanceId: uuidFor(symbol),
    reasonCodes: [],
    entryReference: 21.5,
    stopReference: 21.1,
    targetReference: 22.3,
    estimatedRr: 2.1,
    featureSnapshot: makeFeatureSnapshot(symbol),
  };
}

function symbolsFor(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `SYM${index}.TO`);
}

function uuidFor(seed: string): string {
  const hex = Array.from(seed)
    .reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(8, "0");
  return `${hex}-0000-4000-8000-000000000000`;
}

describe("W9: partial bootstrap failure", () => {
  beforeEach(() => {
    StubWebSocket.instances = [];
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("still renders the live scanner board when an optional research endpoint (backtests) fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/backtests"))
          return new Response(JSON.stringify({ error: "boom" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        const body = (() => {
          if (url.startsWith("/api/system/status")) return systemStatus();
          if (url.startsWith("/api/market/status"))
            return {
              state: "ACTIVE",
              dataStatus: "REALTIME",
              instrumentCount: 1,
            };
          if (url.startsWith("/api/universe"))
            return {
              instruments: [],
              automation: {
                provider: "TEST",
                policy: UNIVERSE_POLICY,
                latestRun: null,
                members: [],
                configuredSymbols: ["TD.TO"],
              },
            };
          if (url.startsWith("/api/candidates"))
            return { candidates: [makeEvaluation("TD.TO")] };
          if (url.startsWith("/api/contexts")) return { contexts: [] };
          if (url.startsWith("/api/alerts/policy")) return DEFAULT_ALERT_POLICY;
          if (url.startsWith("/api/alerts")) return { alerts: [] };
          if (url.startsWith("/api/calibrations")) return { calibrations: [] };
          if (url.startsWith("/api/statistical-models")) return { models: [] };
          if (url.startsWith("/api/scanner-profiles")) return { profiles: [] };
          if (url.startsWith("/api/strategies")) return { strategies: [] };
          return {};
        })();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    render(<App />);

    // The critical group (system/market/universe/candidates/contexts/alerts) still rendered the
    // board even though /api/backtests — an optional research endpoint — returned a 500.
    expect(screen.getByText("LEARNING")).toBeInTheDocument();
  });
});

describe("W9: render count at 150 symbols", () => {
  beforeEach(() => {
    StubWebSocket.instances = [];
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps App's commit count bounded for a 150-symbol bootstrap plus one WS update", async () => {
    const symbols = symbolsFor(150);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = (() => {
          if (url.startsWith("/api/system/status")) return systemStatus();
          if (url.startsWith("/api/market/status"))
            return {
              state: "ACTIVE",
              dataStatus: "REALTIME",
              instrumentCount: symbols.length,
            };
          if (url.startsWith("/api/universe"))
            return {
              instruments: [],
              automation: {
                provider: "TEST",
                policy: UNIVERSE_POLICY,
                latestRun: null,
                members: [],
                configuredSymbols: symbols,
              },
            };
          if (url.startsWith("/api/candidates"))
            return {
              candidates: symbols.map((symbol) => makeEvaluation(symbol)),
            };
          if (url.startsWith("/api/contexts")) return { contexts: [] };
          if (url.startsWith("/api/alerts/policy")) return DEFAULT_ALERT_POLICY;
          if (url.startsWith("/api/alerts")) return { alerts: [] };
          if (url.startsWith("/api/backtests")) return { runs: [] };
          if (url.startsWith("/api/calibrations")) return { calibrations: [] };
          if (url.startsWith("/api/statistical-models")) return { models: [] };
          if (url.startsWith("/api/scanner-profiles")) return { profiles: [] };
          if (url.startsWith("/api/strategies")) return { strategies: [] };
          return {};
        })();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    let commitCount = 0;
    const onRender = () => {
      commitCount += 1;
    };

    render(
      <Profiler id="app-under-test" onRender={onRender}>
        <App />
      </Profiler>,
    );

    await waitFor(() =>
      expect(
        screen.getByText(`DAILY LIST · ${symbols.length}`),
      ).toBeInTheDocument(),
    );
    const commitsAfterBootstrap = commitCount;

    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    const socket = StubWebSocket.instances[0];
    socket.readyState = 1;
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        timestamp: "2026-08-28T14:32:10.000Z",
        market: { state: "ACTIVE", dataStatus: "REALTIME" },
        candidates: symbols.map((symbol) => makeEvaluation(symbol, "WATCH")),
        contexts: [],
        alerts: [],
        seq: 1,
        version: 1,
      }),
    });
    await waitFor(() =>
      expect(screen.getAllByText("WATCH").length).toBeGreaterThan(0),
    );
    const commitsAfterOneUpdate = commitCount;

    // Bounded-range assertion, not a fragile exact count: bootstrap (several independent
    // setState calls as the critical/optional resource groups resolve, some in the same React
    // batch) plus one full-snapshot WS frame should commit a small, roughly constant number of
    // times — not once per symbol. 150 symbols is the scale this was written to guard: a
    // regression that made rendering (or a lookup rebuild) scale per-row would blow this bound
    // long before it got anywhere near 150 separate commits.
    expect(commitsAfterBootstrap).toBeGreaterThan(0);
    expect(commitsAfterBootstrap).toBeLessThan(20);
    expect(commitsAfterOneUpdate - commitsAfterBootstrap).toBeGreaterThan(0);
    expect(commitsAfterOneUpdate - commitsAfterBootstrap).toBeLessThan(10);
  });
});
