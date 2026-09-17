import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

function systemStatus(
  mode: SystemStatus["mode"],
  operationalOverrides: Partial<OperationalStatus> = {},
): SystemStatus {
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
    operational: operational(operationalOverrides),
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

function mockFetchFor(
  system: SystemStatus,
  marketOverrides: Record<string, unknown> = {},
  systemFor?: (url: string) => SystemStatus,
  profiles: unknown[] = [],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = (() => {
        if (url.startsWith("/api/system/status"))
          return systemFor ? systemFor(url) : system;
        if (url.startsWith("/api/market/status"))
          return {
            state: "ACTIVE",
            dataStatus: "REALTIME",
            instrumentCount: 3,
            ...marketOverrides,
          };
        if (url.startsWith("/api/universe"))
          return {
            instruments: [],
            automation: {
              provider: "TEST",
              policy: UNIVERSE_POLICY,
              latestRun: null,
              members: [],
              configuredSymbols: [],
            },
          };
        if (url.startsWith("/api/candidates")) return { candidates: [] };
        if (url.startsWith("/api/contexts")) return { contexts: [] };
        if (url.startsWith("/api/alerts/policy")) return DEFAULT_ALERT_POLICY;
        if (url.startsWith("/api/alerts")) return { alerts: [] };
        if (url.startsWith("/api/backtests")) return { runs: [] };
        if (url.startsWith("/api/calibrations")) return { calibrations: [] };
        if (url.startsWith("/api/statistical-models")) return { models: [] };
        if (url.startsWith("/api/scanner-profiles")) return { profiles };
        if (url.startsWith("/api/strategies")) return { strategies: [] };
        return {};
      })();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
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
  state: StrategyEvaluation["state"],
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
    setupInstanceId: "1a2b3c4d-5e6f-4708-9a0b-1c2d3e4f5061",
    reasonCodes: [],
    entryReference: 21.5,
    stopReference: 21.1,
    targetReference: 22.3,
    estimatedRr: 2.1,
    featureSnapshot: makeFeatureSnapshot(symbol),
  };
}

describe("App navigation status", () => {
  beforeEach(() => {
    StubWebSocket.instances = [];
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows bot health in the BOT navigation item without the market information strip", async () => {
    mockFetchFor(systemStatus("live"), {
      paperBot: {
        runId: "10000000-0000-4000-8000-000000000501",
        sessionDate: "2026-08-31",
        scheduledCloseAt: "2026-08-31T16:00:00.000Z",
        executionModelVersion: "paper-execution-v7",
        openExecutions: 0,
        closePendingExecutions: 0,
        closedExecutions: 0,
        noFillExecutions: 0,
        reconciliationBacklog: 0,
        unreconcilableEvents: 0,
        overdueRuns: 0,
        abandonedExecutions: 0,
        lastTransitionAt: null,
        lastProcessingDurationMs: 2.5,
        lastError: null,
      },
    });
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "BOT · LIVE" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Market status")).not.toBeInTheDocument();
  });

  it("shows a compact status pill whose popover separates freshness cues", async () => {
    mockFetchFor(systemStatus("live"), {
      paperBot: {
        runId: "10000000-0000-4000-8000-000000000501",
        sessionDate: "2026-08-31",
        lastSuccessfulProcessingAt: new Date(Date.now() - 4_000).toISOString(),
        lastError: null,
      },
    });
    render(<App />);

    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    const socket = StubWebSocket.instances[0];
    socket.readyState = 1;
    socket.onopen?.();

    const pill = await screen.findByRole("button", {
      name: "System status",
    });
    expect(pill).toHaveTextContent("LIVE");
    expect(screen.queryByText(/Scanning normally/)).not.toBeInTheDocument();

    fireEvent.click(pill);
    expect(screen.getByText(/Scanning normally/)).toBeInTheDocument();
    expect(screen.getByText("STATUS")).toBeInTheDocument();
    expect(screen.getByText("LAST CYCLE")).toBeInTheDocument();
    expect(screen.getByText("EVIDENCE")).toBeInTheDocument();
  });

  it("uses the selected market's operational status instead of the default runtime's", async () => {
    const ca = systemStatus("live");
    const us = systemStatus("live", {
      actionable: false,
      operationalReady: false,
      auth: "AUTH_REQUIRED",
      reasonCodes: ["AUTH_REQUIRED"],
    });
    mockFetchFor(ca, {}, (url) => (url.includes("US_EQUITIES") ? us : ca));
    render(<App />);

    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    const socket = StubWebSocket.instances[0];
    socket.readyState = 1;
    socket.onopen?.();
    const pill = await screen.findByRole("button", {
      name: "System status",
    });
    await waitFor(() => expect(pill).toHaveTextContent("LIVE"));

    fireEvent.change(screen.getByLabelText("Market"), {
      target: { value: "US_EQUITIES" },
    });
    await waitFor(() => expect(pill).toHaveTextContent("SIGN-IN REQUIRED"));

    fireEvent.click(pill);
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Automation status")).getByText(
          /Broker sign-in required · Market data collection/,
        ),
      ).toBeInTheDocument(),
    );
  });

  it("keeps role=tab/aria-selected semantics on the Scanner profile bar", async () => {
    mockFetchFor(systemStatus("live"), {}, undefined, [
      {
        id: "9c2f3a10-4b5c-4d6e-8f70-1a2b3c4d5e6f",
        name: "Momentum core",
        marketId: "CA_TSX",
        strategyDefinitionId: "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
        analysisKind: "SETUP",
        strategyKey: "ORB_RETEST",
        strategyVersion: "1.0.0",
        configId: "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901",
        configVersion: "config-v7",
        parameters: {},
        enabled: true,
        displayOrder: 0,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    render(<App />);

    const all = await screen.findByRole("tab", { name: "ALL" });
    expect(all).toHaveAttribute("aria-selected", "true");
    const profile = screen.getByRole("tab", { name: "Momentum core" });
    expect(profile).toHaveAttribute("aria-selected", "false");

    fireEvent.click(profile);
    await waitFor(() =>
      expect(profile).toHaveAttribute("aria-selected", "true"),
    );
    expect(all).toHaveAttribute("aria-selected", "false");
  });

  it("clears a recovered market-data error when the next snapshot omits it", async () => {
    const marketOverrides: Record<string, unknown> = {
      lastError: "quote feed failed",
    };
    mockFetchFor(systemStatus("live"), marketOverrides);
    render(<App />);

    const pill = await screen.findByRole("button", {
      name: "System status",
    });
    fireEvent.click(pill);
    await waitFor(() =>
      expect(
        screen.getByText(/Last market-data error: quote feed failed/),
      ).toBeInTheDocument(),
    );

    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    // The field is omitted (not nulled) by the API once healthy; delete it from
    // the fixture before the frame so a later poll cannot re-add it.
    delete marketOverrides.lastError;
    const socket = StubWebSocket.instances[0];
    socket.readyState = 1;
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        timestamp: "2026-08-28T14:32:02.000Z",
        market: { state: "ACTIVE", dataStatus: "REALTIME" },
        candidates: [],
        contexts: [],
        alerts: [],
        seq: 1,
        version: 1,
      }),
    });

    await waitFor(() =>
      expect(
        screen.queryByText(/Last market-data error/),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("WebSocket snapshot frames (W6b)", () => {
  beforeEach(() => {
    StubWebSocket.instances = [];
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a candidate delivered over the stream, keeps it after a suppression gap, and updates on the next non-suppressed frame", async () => {
    mockFetchFor(systemStatus("live"));
    render(<App />);

    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    const socket = StubWebSocket.instances[0];
    socket.readyState = 1;
    socket.onopen?.();

    socket.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        timestamp: "2026-08-28T14:32:02.000Z",
        market: { state: "ACTIVE", dataStatus: "REALTIME" },
        candidates: [makeEvaluation("TD.TO", "READY")],
        contexts: [],
        alerts: [],
        seq: 1,
        version: 1,
      }),
    });

    await waitFor(() => expect(screen.getByText("TD.TO")).toBeInTheDocument());

    // The server suppresses byte-identical frames (W6b change detection): no
    // message arrives for several ticks even though the market is still
    // being polled every 2s server-side. Nothing a client does should change
    // because of that silence — the last known state simply stays on screen.
    expect(screen.getByText("TD.TO")).toBeInTheDocument();

    // The next frame the client actually receives jumps straight from seq 1
    // to seq 5 (three cycles suppressed in between) and carries new content —
    // exactly what change detection produces once something changes again.
    socket.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        timestamp: "2026-08-28T14:32:10.000Z",
        market: { state: "ACTIVE", dataStatus: "REALTIME" },
        candidates: [makeEvaluation("TD.TO", "INVALIDATED")],
        contexts: [],
        alerts: [],
        seq: 5,
        version: 1,
      }),
    });

    await waitFor(() =>
      expect(screen.getByText("INVALIDATED")).toBeInTheDocument(),
    );
  });

  it("requests a full snapshot on reconnect instead of assuming delta continuity", async () => {
    mockFetchFor(systemStatus("live"));
    render(<App />);

    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    const first = StubWebSocket.instances[0];
    first.readyState = 1;
    first.onopen?.();
    first.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        timestamp: "2026-08-28T14:32:02.000Z",
        market: { state: "ACTIVE", dataStatus: "REALTIME" },
        candidates: [makeEvaluation("TD.TO", "READY")],
        contexts: [],
        alerts: [],
        seq: 1,
        version: 1,
      }),
    });
    await waitFor(() => expect(screen.getByText("TD.TO")).toBeInTheDocument());

    // The connection drops. The app's bounded exponential backoff (W6)
    // schedules a reconnect rather than giving up.
    first.readyState = 3;
    first.onclose?.();
    const pill = screen.getByRole("button", { name: "System status" });
    await waitFor(() => expect(pill).toHaveTextContent("RECONNECTING"));

    // A second socket comes up — a brand-new connection, not a resumed one —
    // and, per the server's per-connection broadcaster (`createSnapshotBroadcaster`
    // in apps/api/src/market-data/ws-frame.ts), its first frame is always a
    // full, never-suppressed snapshot starting again at seq 1. The client must
    // render that as the authoritative state, not attempt to reconcile it as a
    // delta against whatever it had before the drop.
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(2), {
      timeout: 3_000,
    });
    const second = StubWebSocket.instances[1];
    second.readyState = 1;
    second.onopen?.();
    second.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        timestamp: "2026-08-28T14:32:20.000Z",
        market: { state: "ACTIVE", dataStatus: "REALTIME" },
        candidates: [makeEvaluation("RY.TO", "READY")],
        contexts: [],
        alerts: [],
        seq: 1,
        version: 1,
      }),
    });

    await waitFor(() => expect(pill).toHaveTextContent("LIVE"));
    await waitFor(() => expect(screen.getByText("RY.TO")).toBeInTheDocument());
    // The pre-drop symbol is gone: the reconnect frame fully replaced state
    // rather than being merged on top of the stale pre-drop board.
    expect(screen.queryByText("TD.TO")).not.toBeInTheDocument();
  });
});

describe("App footer", () => {
  beforeEach(() => {
    StubWebSocket.instances = [];
    vi.stubGlobal("WebSocket", StubWebSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the real system.mode (LIVE) instead of a hardcoded mock label", async () => {
    mockFetchFor(systemStatus("live"));
    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/MODE ·/)).toHaveTextContent("MODE · LIVE"),
    );
    expect(screen.queryByText(/MODE · MOCK/)).not.toBeInTheDocument();
  });

  it("renders MODE · MOCK when the API is actually running in mock mode", async () => {
    mockFetchFor(systemStatus("mock"));
    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/MODE ·/)).toHaveTextContent("MODE · MOCK"),
    );
  });

  it("shows SAFETY · ACTIONABLE only when the shared operational contract reports actionable", async () => {
    mockFetchFor(systemStatus("live", { actionable: true, reasonCodes: [] }));
    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/SAFETY ·/)).toHaveTextContent(
        "SAFETY · ACTIONABLE",
      ),
    );
  });

  it("shows SAFETY · SIGNALS GATED when non-actionable, even though the raw data status is REALTIME", async () => {
    mockFetchFor(
      systemStatus("live", {
        actionable: false,
        reasonCodes: ["WAITING_FOR_CANDIDATES"],
      }),
    );
    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/SAFETY ·/)).toHaveTextContent(
        "SAFETY · SIGNALS GATED",
      ),
    );
  });
});
