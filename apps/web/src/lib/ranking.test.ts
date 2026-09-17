import { describe, expect, it } from "vitest";
import type {
  ContextEvaluation,
  FeatureSnapshot,
  StrategyEvaluation,
  UniverseAutomation,
} from "@tsx-scanner/contracts";
import { buildCandidateLookup, buildRankedRows } from "./ranking.js";
import type { BoardFilters } from "../types.js";

const BASE_FILTERS: BoardFilters = {
  state: "ALL",
  setup: "ALL",
  sector: "ALL",
  context: "ALL",
  readiness: "ALL",
  maximumSpread: "",
};

function makeFeatureSnapshot(
  symbol: string,
  overrides: Partial<FeatureSnapshot> = {},
): FeatureSnapshot {
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
    ...overrides,
  };
}

function makeEvaluation(
  symbol: string,
  overrides: Partial<StrategyEvaluation> = {},
): StrategyEvaluation {
  return {
    kind: "SETUP",
    instrumentId: "5b1f6e2a-6c3a-4b8e-9a1d-8f2e1c4a7b90",
    symbol,
    timestamp: "2026-08-28T14:32:01.123Z",
    profileId: "9c2f3a10-4b5c-4d6e-8f70-1a2b3c4d5e6f",
    profileName: "Momentum core",
    strategy: "ORB_RETEST",
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
    scoreExplanation: [],
    setupInstanceId: "1a2b3c4d-5e6f-4708-9a0b-1c2d3e4f5061",
    reasonCodes: [],
    entryReference: 21.5,
    stopReference: 21.1,
    targetReference: 22.3,
    estimatedRr: 2.1,
    featureSnapshot: makeFeatureSnapshot(symbol),
    ...overrides,
  } as StrategyEvaluation;
}

function makeAutomation(
  overrides: Partial<UniverseAutomation> = {},
): UniverseAutomation {
  return {
    provider: "TEST",
    policy: {
      version: "tsx-liquid-momentum-v1",
      exchange: "TSX",
      currency: "CAD",
      securityTypes: ["Stock"],
      minimumPrice: 1,
      maximumPrice: 100,
      minimumMarketCap: 0,
      minimumAverageVolume90d: 0,
      minimumDollarVolume: 0,
      minimumAtrPct: 0,
      minimumHistoryDays: 20,
    },
    latestRun: null,
    members: [],
    configuredSymbols: [],
    ...overrides,
  } as UniverseAutomation;
}

describe("buildCandidateLookup", () => {
  it("groups candidates and contexts by symbol", () => {
    const lookup = buildCandidateLookup(
      [makeEvaluation("TD.TO"), makeEvaluation("RY.TO")],
      [],
    );
    expect(lookup.bySymbol.get("TD.TO")).toHaveLength(1);
    expect(lookup.bySymbol.get("RY.TO")).toHaveLength(1);
    expect(lookup.bySymbol.get("BNS.TO")).toBeUndefined();
  });
});

describe("buildRankedRows", () => {
  it("includes every configured symbol even when it has no candidate yet", () => {
    const universe = makeAutomation({
      configuredSymbols: ["TD.TO", "RY.TO"],
      members: [
        { symbol: "TD.TO", eligible: true, sector: "Financials", reasons: [] },
        { symbol: "RY.TO", eligible: true, sector: "Financials", reasons: [] },
      ] as unknown as UniverseAutomation["members"],
    });
    const rows = buildRankedRows([], [], universe, "ALL", BASE_FILTERS);
    expect(rows.map((row) => row.symbol).sort()).toEqual(["RY.TO", "TD.TO"]);
    expect(rows.every((row) => row.setup === null)).toBe(true);
  });

  it("ranks a symbol with a READY setup ahead of one with no setup", () => {
    const universe = makeAutomation({ configuredSymbols: ["TD.TO", "RY.TO"] });
    const rows = buildRankedRows(
      [makeEvaluation("TD.TO", { state: "READY" })],
      [],
      universe,
      "ALL",
      BASE_FILTERS,
    );
    expect(rows[0]?.symbol).toBe("TD.TO");
  });

  it("filters by state", () => {
    const universe = makeAutomation({ configuredSymbols: ["TD.TO", "RY.TO"] });
    const rows = buildRankedRows(
      [
        makeEvaluation("TD.TO", { state: "READY" }),
        makeEvaluation("RY.TO", { state: "WATCH" }),
      ],
      [],
      universe,
      "ALL",
      { ...BASE_FILTERS, state: "READY" },
    );
    expect(rows.map((row) => row.symbol)).toEqual(["TD.TO"]);
  });

  it("filters by sector using the universe member's sector", () => {
    const universe = makeAutomation({
      configuredSymbols: ["TD.TO", "RY.TO"],
      members: [
        { symbol: "TD.TO", eligible: true, sector: "Financials", reasons: [] },
        { symbol: "RY.TO", eligible: true, sector: "Energy", reasons: [] },
      ] as unknown as UniverseAutomation["members"],
    });
    const rows = buildRankedRows([], [], universe, "ALL", {
      ...BASE_FILTERS,
      sector: "Energy",
    });
    expect(rows.map((row) => row.symbol)).toEqual(["RY.TO"]);
  });

  it("filters by activeProfile, excluding setups from other profiles", () => {
    const universe = makeAutomation({ configuredSymbols: ["TD.TO"] });
    const rows = buildRankedRows(
      [makeEvaluation("TD.TO", { profileId: "other-profile", state: "READY" })],
      [],
      universe,
      "profile-a",
      BASE_FILTERS,
    );
    expect(rows[0]?.setup).toBeNull();
  });

  it("computes contextStatus and contextScore from the symbol's context evaluations", () => {
    const universe = makeAutomation({ configuredSymbols: ["TD.TO"] });
    const contexts: ContextEvaluation[] = [
      {
        kind: "CONTEXT",
        instrumentId: "5b1f6e2a-6c3a-4b8e-9a1d-8f2e1c4a7b90",
        symbol: "TD.TO",
        timestamp: "2026-08-28T14:32:01.123Z",
        profileId: "9c2f3a10-4b5c-4d6e-8f70-1a2b3c4d5e6f",
        profileName: "Momentum core",
        signal: "SECTOR_STRENGTH",
        status: "STRONG",
        contextScore: 75,
      } as unknown as ContextEvaluation,
    ];
    const rows = buildRankedRows([], contexts, universe, "ALL", BASE_FILTERS);
    expect(rows[0]?.contextStatus).toBe("STRONG");
  });

  it("filters by marketId: US_EQUITIES excludes TSX candidates and TSX symbols", () => {
    const universe = makeAutomation({
      configuredSymbols: ["AAPL", "TD.TO"],
      members: [
        {
          symbol: "AAPL",
          eligible: true,
          sector: "Technology",
          marketId: "US_EQUITIES",
          reasons: [],
        },
        {
          symbol: "TD.TO",
          eligible: true,
          sector: "Financials",
          marketId: "CA_TSX",
          reasons: [],
        },
      ] as unknown as UniverseAutomation["members"],
    });
    const candidates = [
      makeEvaluation("TD.TO", { marketId: "CA_TSX", state: "READY" }),
      makeEvaluation("AAPL", { marketId: "US_EQUITIES", state: "READY" }),
    ];
    const rows = buildRankedRows(
      candidates,
      [],
      universe,
      "ALL",
      BASE_FILTERS,
      "US_EQUITIES",
    );
    expect(rows.map((row) => row.symbol)).toEqual(["AAPL"]);
    expect(rows[0]?.setup?.symbol).toBe("AAPL");
  });

  it("filters by marketId: CA_TSX excludes US candidates and US symbols", () => {
    const universe = makeAutomation({
      configuredSymbols: ["AAPL", "TD.TO"],
      members: [
        {
          symbol: "AAPL",
          eligible: true,
          sector: "Technology",
          marketId: "US_EQUITIES",
          reasons: [],
        },
        {
          symbol: "TD.TO",
          eligible: true,
          sector: "Financials",
          marketId: "CA_TSX",
          reasons: [],
        },
      ] as unknown as UniverseAutomation["members"],
    });
    const candidates = [
      makeEvaluation("TD.TO", { marketId: "CA_TSX", state: "READY" }),
      makeEvaluation("AAPL", { marketId: "US_EQUITIES", state: "READY" }),
    ];
    const rows = buildRankedRows(
      candidates,
      [],
      universe,
      "ALL",
      BASE_FILTERS,
      "CA_TSX",
    );
    expect(rows.map((row) => row.symbol)).toEqual(["TD.TO"]);
    expect(rows[0]?.setup?.symbol).toBe("TD.TO");
  });
});
