import { describe, expect, it } from "vitest";
import {
  createSnapshotBroadcaster,
  selectBroadcastAlerts,
  stripBroadcastTelemetry,
  WS_BROADCAST_ALERT_LIMIT,
  WS_BROADCAST_TELEMETRY_FIELDS,
  WS_PROTOCOL_VERSION,
  type SnapshotFrameInput,
} from "../src/market-data/ws-frame.js";

// Fixtures shaped like the real contracts (`StrategyEvaluation`/`FeatureSnapshot`)
// closely enough to reproduce the review's measured per-evaluation cost
// (scoreExplanation ~1.9KB, featureSnapshot ~1.7KB -> ~4.4KB/evaluation) without
// depending on zod validation, which isn't needed just to measure JSON size.
function makeFeatureLevel(seed: number) {
  return {
    price: 21.5 + seed * 0.01,
    type: "SWING_HIGH",
    strength: 0.62,
    tests: 2,
    ageBars: 14,
  };
}

function makeLevelConfluence(seed: number) {
  return {
    price: 21.4 + seed * 0.01,
    levelTypes: ["PDH", "ORH", "VWAP"],
    count: 3,
  };
}

function makeFeatureSnapshot(symbol: string, seed: number) {
  return {
    instrumentId: "5b1f6e2a-6c3a-4b8e-9a1d-8f2e1c4a7b90",
    symbol,
    timestamp: "2026-08-28T14:32:01.123Z",
    timeframe: "OneMinute",
    featureVersion: "feature-v3",
    configVersion: "config-v7",
    dataStatus: "REALTIME",
    actionable: true,
    price: 21.45 + seed * 0.01,
    bid: 21.44 + seed * 0.01,
    ask: 21.46 + seed * 0.01,
    mid: 21.45 + seed * 0.01,
    spreadAbsolute: 0.02,
    spreadPct: 0.093,
    changeFromOpenPct: 1.82,
    rollingReturn5mPct: 0.34,
    vwap: 21.3 + seed * 0.01,
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
    openingRange: {
      high: 21.6,
      low: 21.1,
      mid: 21.35,
      width: 0.5,
      widthPct: 2.34,
      widthAtr: 1.22,
      volume: 245_000,
      complete: true,
    },
    swingHighs: [
      makeFeatureLevel(seed),
      makeFeatureLevel(seed + 1),
      makeFeatureLevel(seed + 2),
    ],
    swingLows: [makeFeatureLevel(seed + 3), makeFeatureLevel(seed + 4)],
    nearestSupport: makeFeatureLevel(seed + 5),
    nearestResistance: makeFeatureLevel(seed + 6),
    supportConfluence: makeLevelConfluence(seed),
    resistanceConfluence: makeLevelConfluence(seed + 1),
    distanceFromVwapAtr: 1.58,
    distanceFromOrhAtr: 0.61,
    changeFromOpenAtr: 2.03,
    consecutiveGreenCandles: 4,
    recentMoveVelocityAtr: 0.29,
    warmingUp: [],
  };
}

const SCORE_CONTRIBUTION_LABELS = [
  ["pattern.orh_breakout", "PATTERN", "Opening range high breakout"],
  [
    "confirmation.volume_thrust",
    "CONFIRMATION",
    "Volume thrust on breakout candle",
  ],
  ["structure.higher_low", "STRUCTURE", "Higher low held above VWAP"],
  ["liquidity.spread", "LIQUIDITY", "Spread within tradable bounds"],
  ["timing.session_phase", "TIMING", "Inside preferred entry window"],
  ["penalties.late_entry", "PENALTIES", "No late-entry penalty applied"],
  ["structure.vwap_reclaim", "STRUCTURE", "Reclaimed VWAP after pullback"],
  ["confirmation.rvol", "CONFIRMATION", "Relative volume above threshold"],
] as const;

function makeScoreExplanation() {
  return SCORE_CONTRIBUTION_LABELS.map(([key, group, label]) => ({
    key,
    group,
    label,
    points: 8,
    maximum: 10,
    value: 0.82,
    detail: `${label} confirmed against the current feature snapshot with no disqualifying reason codes present.`,
  }));
}

function makeEvaluation(symbol: string, seed: number) {
  return {
    kind: "SETUP",
    instrumentId: "5b1f6e2a-6c3a-4b8e-9a1d-8f2e1c4a7b90",
    symbol,
    timestamp: "2026-08-28T14:32:01.123Z",
    profileId: "9c2f3a10-4b5c-4d6e-8f70-1a2b3c4d5e6f",
    profileName: "Momentum core",
    strategy: "ORH_BREAKOUT",
    strategyVersion: "1.0.0",
    configVersion: "config-v7",
    state: "READY",
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
    scoreExplanation: makeScoreExplanation(),
    setupInstanceId: "1a2b3c4d-5e6f-4708-9a0b-1c2d3e4f5061",
    reasonCodes: ["ORH_CONFIRMED", "VOLUME_THRUST"],
    entryReference: 21.5,
    stopReference: 21.1,
    targetReference: 22.3,
    estimatedRr: 2.1,
    featureSnapshot: makeFeatureSnapshot(symbol, seed),
  };
}

function makeMarketSnapshot(withTelemetry: boolean, tick = 0) {
  const base: Record<string, unknown> = {
    state: "ACTIVE",
    auth: "CONNECTED",
    dataStatus: "REALTIME",
    session: { marketStatus: "OPEN", phase: "PREFERRED_ENTRIES" },
    instrumentCount: 200,
    featureSnapshotCount: 200,
    contextEvaluationCount: 200,
    benchmarkCount: 12,
    benchmarkWarnings: [],
    lastQuoteAt: "2026-08-28T14:32:01.000Z",
    lastCandleAt: "2026-08-28T14:31:00.000Z",
  };
  if (!withTelemetry) return base;
  // These values mutate on every real broadcast cycle even when nothing a
  // browser cares about changed — the exact defect W6b's ordering guards
  // against (see the "ordering matters" test below).
  return {
    ...base,
    lastCycleDurationMs: 41.2 + tick,
    lastEngineDurationMs: 12.4 + tick,
    lastFeatureDurationMs: 6.1 + tick,
    lastEvaluationDurationMs: 3.7 + tick,
    lastEvaluationAgeMs: 205 + tick,
  };
}

function makeCandidates(count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeEvaluation(`SYM${i}.TO`, i),
  );
}

function frameInput(
  overrides: Partial<SnapshotFrameInput> = {},
): SnapshotFrameInput {
  return {
    type: "snapshot",
    timestamp: "2026-08-28T14:32:02.000Z",
    market: makeMarketSnapshot(false),
    universe: { members: [] },
    candidates: [],
    contexts: [],
    alerts: [],
    ...overrides,
  };
}

describe("W6b — stripBroadcastTelemetry", () => {
  it("removes every listed per-cycle telemetry field and nothing else", () => {
    const snapshot = makeMarketSnapshot(true) as Record<string, unknown>;
    const stripped = stripBroadcastTelemetry(snapshot) as Record<
      string,
      unknown
    >;
    for (const field of WS_BROADCAST_TELEMETRY_FIELDS) {
      expect(snapshot[field]).toBeDefined();
      expect(stripped[field]).toBeUndefined();
    }
    // Fields a browser actually renders (lastQuoteAt, state, session, ...)
    // survive untouched.
    expect(stripped.lastQuoteAt).toBe(snapshot.lastQuoteAt);
    expect(stripped.state).toBe(snapshot.state);
    expect(Object.keys(stripped)).toHaveLength(
      Object.keys(snapshot).length - WS_BROADCAST_TELEMETRY_FIELDS.length,
    );
  });

  it("passes through non-object snapshots (undefined/null) untouched", () => {
    expect(stripBroadcastTelemetry(undefined)).toBeUndefined();
    expect(stripBroadcastTelemetry(null)).toBeNull();
  });
});

describe("W6b — payload size at 50/150/300 evaluations", () => {
  // Bounded ranges, not exact byte counts: CI/host JSON.stringify output for
  // an object this shape is stable across Node versions, but pinning an exact
  // byte count invites unrelated churn. Each evaluation fixture here weighs in
  // at roughly the review's measured ~4.4KB (scoreExplanation + featureSnapshot
  // dominate); we assert order-of-magnitude bounds around that.
  const CASES: Array<{ count: number; minKB: number; maxKB: number }> = [
    { count: 50, minKB: 150, maxKB: 300 },
    { count: 150, minKB: 450, maxKB: 900 },
    { count: 300, minKB: 900, maxKB: 1800 },
  ];

  for (const { count, minKB, maxKB } of CASES) {
    it(`keeps the ${count}-evaluation frame within budget and shrinks after telemetry removal`, () => {
      const candidates = makeCandidates(count);
      const withTelemetry = JSON.stringify(
        frameInput({ market: makeMarketSnapshot(true), candidates }),
      );
      const broadcaster = createSnapshotBroadcaster();
      const result = broadcaster.next(
        frameInput({ market: makeMarketSnapshot(true), candidates }),
      );
      expect(result.suppressed).toBe(false);
      const withoutTelemetryBytes = Buffer.byteLength(result.json!, "utf8");
      const withTelemetryBytes = Buffer.byteLength(withTelemetry, "utf8");

      // The dominant cost is per-evaluation payload (scoreExplanation +
      // featureSnapshot), not the handful of telemetry scalars, so the frame
      // stays in the same broad size band before/after stripping them —
      // telemetry removal's real payoff is enabling suppression (see below),
      // not shrinking this number by itself.
      expect(withoutTelemetryBytes).toBeGreaterThanOrEqual(minKB * 1024);
      expect(withoutTelemetryBytes).toBeLessThanOrEqual(maxKB * 1024);
      // Still strictly smaller: five telemetry scalars are gone.
      expect(withoutTelemetryBytes).toBeLessThan(withTelemetryBytes);
    });
  }

  it("keeps the empty-universe floor small and telemetry-free", () => {
    const broadcaster = createSnapshotBroadcaster();
    const result = broadcaster.next(
      frameInput({ market: makeMarketSnapshot(true), candidates: [] }),
    );
    const bytes = Buffer.byteLength(result.json!, "utf8");
    // The review's ~2.19KB empty-universe floor was measured against the real
    // `getUniverseAutomation()` payload (policy, members, coverage); this
    // fixture's minimal stand-in floor is smaller, but the assertion below is
    // deliberately a loose sanity bound, not a byte-for-byte reproduction —
    // the point is "small and doesn't carry telemetry", which the field-level
    // test above already verifies precisely.
    expect(bytes).toBeGreaterThan(300);
    expect(bytes).toBeLessThan(3 * 1024);
  });
});

describe("W6b — change-detection suppression (ordering matters)", () => {
  it("never suppresses when raw telemetry-bearing frames are compared directly — proving why removal must land first", () => {
    // This reproduces the *old* behavior directly (no stripBroadcastTelemetry,
    // no broadcaster): every cycle's `market` object carries fresh timing
    // telemetry, so two consecutive "identical" frames are never byte-equal.
    const candidates = makeCandidates(5);
    const cycle1 = JSON.stringify(
      frameInput({ market: makeMarketSnapshot(true, 1), candidates }),
    );
    const cycle2 = JSON.stringify(
      frameInput({ market: makeMarketSnapshot(true, 2), candidates }),
    );
    expect(cycle1).not.toBe(cycle2);
  });

  it("suppresses consecutive frames once the market is static and telemetry is stripped", () => {
    const broadcaster = createSnapshotBroadcaster();
    const candidates = makeCandidates(5);
    const staticInput = () =>
      frameInput({
        // Telemetry still mutates every cycle in real life; the broadcaster
        // must strip it before comparing, or this would never suppress either.
        market: makeMarketSnapshot(true, 7),
        candidates,
      });

    const first = broadcaster.next(staticInput());
    expect(first.suppressed).toBe(false);
    expect(first.json).toBeDefined();

    const second = broadcaster.next(staticInput());
    expect(second.suppressed).toBe(true);
    expect(second.json).toBeUndefined();

    const third = broadcaster.next(staticInput());
    expect(third.suppressed).toBe(true);
  });

  it("resumes broadcasting the instant real content changes", () => {
    const broadcaster = createSnapshotBroadcaster();
    const candidates = makeCandidates(5);
    const unchanged = () =>
      frameInput({ market: makeMarketSnapshot(true, 1), candidates });

    expect(broadcaster.next(unchanged()).suppressed).toBe(false);
    expect(broadcaster.next(unchanged()).suppressed).toBe(true);

    const changedCandidates = makeCandidates(5);
    changedCandidates[0]!.state = "INVALIDATED";
    const changed = broadcaster.next(
      frameInput({
        market: makeMarketSnapshot(true, 1),
        candidates: changedCandidates,
      }),
    );
    expect(changed.suppressed).toBe(false);
    expect(changed.json).toBeDefined();
  });

  it("suppresses when only the per-cycle frame timestamp changes and still sends it on real frames", () => {
    const broadcaster = createSnapshotBroadcaster();
    const candidates = makeCandidates(3);
    const input = (timestamp: string) =>
      frameInput({
        timestamp,
        market: makeMarketSnapshot(false),
        candidates,
      });

    const first = broadcaster.next(input("2026-08-28T14:32:02.000Z"));
    expect(first.suppressed).toBe(false);
    expect(JSON.parse(first.json!).timestamp).toBe("2026-08-28T14:32:02.000Z");

    // Identical content, next cycle's clock — must not be sent.
    const second = broadcaster.next(input("2026-08-28T14:32:04.000Z"));
    expect(second.suppressed).toBe(true);
    expect(second.json).toBeUndefined();

    const changedCandidates = makeCandidates(3);
    changedCandidates[0]!.state = "INVALIDATED";
    const third = broadcaster.next({
      ...input("2026-08-28T14:32:06.000Z"),
      candidates: changedCandidates,
    });
    expect(third.suppressed).toBe(false);
    expect(JSON.parse(third.json!).timestamp).toBe("2026-08-28T14:32:06.000Z");
  });

  it("ignores nested per-cycle telemetry but still transmits it and resumes on real change", () => {
    const broadcaster = createSnapshotBroadcaster();
    const market = (tick: number, pendingFacts: number) => ({
      ...makeMarketSnapshot(true, tick),
      session: {
        marketStatus: "CLOSED",
        phase: "CLOSED",
        observedAt: `2026-08-28T14:32:${String(tick).padStart(2, "0")}.000Z`,
      },
      paperBot: {
        lastProcessingDurationMs: 3 + tick,
        lastSuccessfulProcessingAt: `2026-08-28T14:32:${String(tick).padStart(2, "0")}.000Z`,
        fundedLastSuccessfulProcessingAt: `2026-08-28T14:32:${String(tick).padStart(2, "0")}.000Z`,
        funded: {
          pendingFacts,
          oldestPendingFactAgeMs: pendingFacts > 0 ? 5000 : null,
          lastCycleLatencyMs: 40 + tick,
          coverageGapsTotal: 100 + tick,
        },
      },
    });

    const first = broadcaster.next(
      frameInput({ market: market(1, 0), candidates: makeCandidates(2) }),
    );
    expect(first.suppressed).toBe(false);
    const transmitted = JSON.parse(first.json!);
    // Telemetry is still transmitted (the paper-bot indicator reads it)...
    expect(transmitted.market.session.observedAt).toBe(
      "2026-08-28T14:32:01.000Z",
    );
    expect(transmitted.market.paperBot.funded.lastCycleLatencyMs).toBe(41);

    // ...but next cycle's clock/latency/counter ticks alone are suppressed.
    expect(
      broadcaster.next(
        frameInput({ market: market(2, 0), candidates: makeCandidates(2) }),
      ).suppressed,
    ).toBe(true);

    const changed = broadcaster.next(
      frameInput({ market: market(3, 4), candidates: makeCandidates(2) }),
    );
    expect(changed.suppressed).toBe(false);
    expect(JSON.parse(changed.json!).market.paperBot.funded.pendingFacts).toBe(
      4,
    );
  });
});

describe("W6b — broadcast alert cap", () => {
  it("sends at most the configured newest-first alert window", () => {
    const alerts = Array.from({ length: 200 }, (_, index) => ({
      alertId: `alert-${index}`,
    }));
    const selected = selectBroadcastAlerts(alerts);
    expect(selected).toHaveLength(WS_BROADCAST_ALERT_LIMIT);
    expect(selected[0]).toEqual({ alertId: "alert-0" });
    expect(selected.at(-1)).toEqual({
      alertId: `alert-${WS_BROADCAST_ALERT_LIMIT - 1}`,
    });
    expect(selectBroadcastAlerts(alerts, 5)).toHaveLength(5);
    expect(selectBroadcastAlerts(alerts, 0)).toHaveLength(0);
  });
});

describe("W6b — seq/version metadata", () => {
  it("assigns seq only to frames actually sent, so a client can see how many cycles were suppressed", () => {
    const broadcaster = createSnapshotBroadcaster();
    const candidates = makeCandidates(3);
    const unchanged = () =>
      frameInput({ market: makeMarketSnapshot(true, 1), candidates });

    const first = broadcaster.next(unchanged());
    const parsedFirst = JSON.parse(first.json!);
    expect(parsedFirst.seq).toBe(1);
    expect(parsedFirst.version).toBe(WS_PROTOCOL_VERSION);

    // Two suppressed cycles in between (nothing changed).
    expect(broadcaster.next(unchanged()).suppressed).toBe(true);
    expect(broadcaster.next(unchanged()).suppressed).toBe(true);

    const changedCandidates = makeCandidates(3);
    changedCandidates[0]!.state = "INVALIDATED";
    const next = broadcaster.next(
      frameInput({
        market: makeMarketSnapshot(true, 1),
        candidates: changedCandidates,
      }),
    );
    const parsedNext = JSON.parse(next.json!);
    // Cycle counter advanced through the two suppressed ticks: seq jumps from
    // 1 to 4, not 2 — the gap itself is what tells a client two frames were
    // withheld rather than lost.
    expect(parsedNext.seq).toBe(4);
    expect(parsedNext.version).toBe(WS_PROTOCOL_VERSION);
  });

  it("gives a fresh connection (reconnect) its own seq sequence starting at 1, never suppressed on the first frame", () => {
    const candidates = makeCandidates(3);
    const input = () =>
      frameInput({ market: makeMarketSnapshot(true, 1), candidates });

    const existingConnection = createSnapshotBroadcaster();
    existingConnection.next(input());
    existingConnection.next(input()); // suppressed, cycle=2

    // A brand-new connection (e.g. after the client's bounded-backoff
    // reconnect) must not inherit the old connection's suppression state.
    const reconnected = createSnapshotBroadcaster();
    const result = reconnected.next(input());
    expect(result.suppressed).toBe(false);
    expect(JSON.parse(result.json!).seq).toBe(1);
  });
});
