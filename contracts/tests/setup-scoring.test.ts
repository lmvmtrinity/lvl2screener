import { describe, expect, it } from "vitest";
import {
  ACTIVE_RANKING_FORMULA,
  ACTIVE_RANKING_FORMULA_VERSION,
  BOUNDED_CONTEXT_RESEARCH_FORMULA,
  CONTEXT_SCORE_VERSION,
  SETUP_INTERACTION_RESEARCH_FORMULA,
  SETUP_SCORE_GROUPS,
  SETUP_SCORE_GROUP_MAXIMUM,
  SETUP_SCORE_VERSION,
  compareOpportunities,
  contextEvaluationSchema,
  contextScoreForSymbol,
  projectRankingResearch,
  rankOpportunities,
  researchRankOpportunities,
  strategyEvaluationSchema,
  strategyStateEventSchema,
  type ContextEvaluation,
  type SetupScoreComponents,
  type StrategyEvaluation,
  type StrategyState,
} from "../src/index.js";

const feature = {
  instrumentId: "10000000-0000-4000-8000-000000000001",
  symbol: "BTO.TO",
  timestamp: "2026-08-27T14:00:00.000Z",
  timeframe: "OneMinute",
  featureVersion: "1.0.0",
  configVersion: "test",
  dataStatus: "REALTIME",
  actionable: true,
  price: 8,
  bid: 7.99,
  ask: 8.01,
  mid: 8,
  spreadAbsolute: 0.02,
  spreadPct: 0.25,
  changeFromOpenPct: 1,
  vwap: 7.95,
  distanceFromVwapPct: 0.63,
  closeAboveVwap: true,
  last3ClosesAboveVwap: 3,
  vwapSlopePct: 0.1,
  touchVwap: false,
  vwapReclaim: false,
  vwapRejection: false,
  atr14: 0.25,
  atrPct: 3.125,
  rvolAtTime: 2,
  currentCumulativeVolume: 100_000,
  historicalMeanCumulativeVolume: 50_000,
  openingRange: null,
  swingHighs: [],
  swingLows: [],
  nearestSupport: null,
  nearestResistance: null,
  distanceFromVwapAtr: 0.2,
  distanceFromOrhAtr: null,
  changeFromOpenAtr: 0.32,
  consecutiveGreenCandles: 2,
  recentMoveVelocityAtr: 0.1,
  warmingUp: [],
} as const;

const components: SetupScoreComponents = {
  pattern: 18,
  confirmation: 20,
  structure: 16,
  liquidity: 18,
  timing: 12,
  penalties: -6,
};
const setup = {
  kind: "SETUP",
  instrumentId: feature.instrumentId,
  symbol: feature.symbol,
  timestamp: feature.timestamp,
  profileId: "10000000-0000-4000-8000-000000000002",
  profileName: "ORB Standard",
  strategy: "ORB_RETEST",
  strategyVersion: "1.0.0",
  configVersion: "profile-orb-v1",
  state: "READY",
  score: 78,
  setupScore: 78,
  scoreVersion: SETUP_SCORE_VERSION,
  scoreComponents: components,
  scoreExplanation: [
    {
      key: "ORB_RETEST_CONFIRMED",
      group: "confirmation",
      label: "Retest held",
      points: 20,
      maximum: 20,
      value: null,
      detail: "Completed bar",
    },
  ],
  reasonCodes: ["ORB_RETEST_CONFIRMED"],
  entryReference: 8,
  stopReference: 7.8,
  targetReference: 8.4,
  estimatedRr: 3,
  featureSnapshot: feature,
} as const;

const evaluation = (
  overrides: Partial<StrategyEvaluation>,
): StrategyEvaluation =>
  strategyEvaluationSchema.parse({ ...setup, ...overrides });
const contextFor = (
  symbol: string,
  contextScore: number,
  status: ContextEvaluation["status"] = "STRONG",
): ContextEvaluation => ({
  kind: "CONTEXT",
  marketId: "CA_TSX",
  instrumentId: feature.instrumentId,
  symbol,
  timestamp: feature.timestamp,
  profileId: "10000000-0000-4000-8000-000000000009",
  profileName: "Market Context",
  signal: "MARKET_RELATIVE_STRENGTH",
  signalVersion: "1.0.0",
  configVersion: "test",
  status,
  contextScore,
  observedValue: 0.8,
  benchmarkSymbol: "XIU.TO",
  contextScoreVersion: CONTEXT_SCORE_VERSION,
  contextScoreComponents: [
    {
      key: "SESSION_RELATIVE_STRENGTH",
      horizon: "SESSION_FROM_OPEN",
      candidateValue: 1,
      benchmarkValue: 0.2,
      observedDifference: 0.8,
      score: contextScore,
      available: true,
      missingDataFlags: [],
    },
  ],
  missingDataFlags: [],
  benchmarkValue: 0.2,
  benchmarkTimestamp: feature.timestamp,
  lookback: "SESSION_FROM_OPEN",
  reasonCodes: [],
  featureSnapshot: feature,
});

describe("explainable setup scoring contract", () => {
  it("carries score components and their explanation under an independent score version", () => {
    const parsed = evaluation({});
    expect(parsed.scoreVersion).toBe(SETUP_SCORE_VERSION);
    expect(parsed.scoreVersion).not.toBe(parsed.strategyVersion);
    expect(parsed.scoreVersion).not.toBe(parsed.configVersion);
    expect(
      SETUP_SCORE_GROUPS.reduce(
        (total, group) => total + parsed.scoreComponents[group],
        0,
      ),
    ).toBe(parsed.setupScore);
  });

  it("explains the difference between a 78 and a 68 component by component", () => {
    const strong = evaluation({}),
      weak = evaluation({
        score: 68,
        setupScore: 68,
        scoreComponents: { ...components, confirmation: 10 },
      });
    const differences = SETUP_SCORE_GROUPS.map(
      (group) => strong.scoreComponents[group] - weak.scoreComponents[group],
    );
    expect(differences.reduce((total, value) => total + value, 0)).toBe(
      strong.setupScore - weak.setupScore,
    );
    expect(differences[SETUP_SCORE_GROUPS.indexOf("confirmation")]).toBe(10);
  });

  it("budgets the awarding components to one hundred points", () => {
    expect(
      SETUP_SCORE_GROUPS.reduce(
        (total, group) => total + SETUP_SCORE_GROUP_MAXIMUM[group],
        0,
      ),
    ).toBe(100);
    expect(SETUP_SCORE_GROUP_MAXIMUM.penalties).toBe(0);
  });

  it("reads a pre-Phase-4 evaluation as a legacy V1 setup record", () => {
    const { scoreVersion, scoreComponents, scoreExplanation, ...legacy } =
      setup;
    const parsed = strategyEvaluationSchema.parse(legacy);
    expect(parsed.scoreVersion).toBe("legacy-v1");
    expect(parsed.scoreExplanation).toEqual([]);
    expect(parsed.scoreComponents.pattern).toBe(0);
  });

  it("carries versioned formation evidence through evaluations and state events", () => {
    const formationEvidence = {
      version: "formation-evidence-v1" as const,
      strategy: "RSI_VWAP_RECLAIM" as const,
      formationKey: "pivot-a:pivot-b",
      setupLevel: 97.5,
      stopLevel: 97.45,
      retest: null,
      rsiVwapReclaim: {
        indicatorVersion: "wilder-rsi-14-v1",
        firstPivot: { timestamp: feature.timestamp, price: 98, rsi: 40 },
        secondPivot: { timestamp: feature.timestamp, price: 97.5, rsi: 45 },
        divergenceConfirmedAt: feature.timestamp,
        divergenceVolumeContractionRatio: 0.5,
        reclaimAt: feature.timestamp,
        holdAt: feature.timestamp,
        frozenResistance: 101,
        invalidationLevel: 97.5,
      },
    };
    const parsed = evaluation({
      strategy: "RSI_VWAP_RECLAIM",
      formationEvidence,
    });
    const event = strategyStateEventSchema.parse({
      ...parsed,
      eventId: "10000000-0000-4000-8000-000000000003",
      eventType: "STRATEGY_STATE_CHANGED",
      previousState: "FORMING",
    });

    expect(parsed.formationEvidence?.version).toBe("formation-evidence-v1");
    expect(parsed.formationEvidence?.rsiVwapReclaim?.secondPivot.rsi).toBe(45);
    expect(event.formationEvidence).toEqual(parsed.formationEvidence);
  });
});

describe("initial ranking policy", () => {
  it("ranks by state before score", () => {
    const ready = evaluation({
      state: "READY",
      score: 61,
      setupScore: 61,
      symbol: "AAA.TO",
    });
    const forming = evaluation({
      state: "FORMING",
      score: 95,
      setupScore: 95,
      symbol: "BBB.TO",
    });
    const watch = evaluation({
      state: "WATCH",
      score: 99,
      setupScore: 99,
      symbol: "CCC.TO",
    });
    expect(
      rankOpportunities([watch, forming, ready]).map(
        (value) => value.setup.symbol,
      ),
    ).toEqual(["AAA.TO", "BBB.TO", "CCC.TO"]);
  });

  it("uses context only to break a tie between identical setups", () => {
    const first = evaluation({ symbol: "AAA.TO" }),
      second = evaluation({ symbol: "BBB.TO" });
    const contexts = [contextFor("BBB.TO", 90), contextFor("AAA.TO", 55)];
    expect(
      rankOpportunities([first, second], contexts).map(
        (value) => value.setup.symbol,
      ),
    ).toEqual(["BBB.TO", "AAA.TO"]);
    const stronger = evaluation({
      symbol: "AAA.TO",
      score: 80,
      setupScore: 80,
    });
    expect(
      rankOpportunities([stronger, second], contexts).map(
        (value) => value.setup.symbol,
      ),
    ).toEqual(["AAA.TO", "BBB.TO"]);
  });

  it("never lets context move a setup between states", () => {
    const forming = evaluation({ state: "FORMING", symbol: "AAA.TO" }),
      ready = evaluation({
        state: "READY",
        score: 1,
        setupScore: 1,
        symbol: "BBB.TO",
      });
    const contexts = [contextFor("AAA.TO", 100)];
    expect(
      rankOpportunities([forming, ready], contexts).map(
        (value) => value.setup.state,
      ),
    ).toEqual(["READY", "FORMING"]);
  });

  it("treats missing, unavailable, and stale context as neutral rather than favourable", () => {
    expect(contextScoreForSymbol([], "AAA.TO")).toBe(50);
    expect(
      contextScoreForSymbol(
        [
          contextFor("AAA.TO", 90, "UNAVAILABLE"),
          contextFor("AAA.TO", 95, "STALE"),
        ],
        "AAA.TO",
      ),
    ).toBe(50);
    expect(
      contextScoreForSymbol(
        [contextFor("AAA.TO", 90), contextFor("AAA.TO", 70, "WEAK")],
        "AAA.TO",
      ),
    ).toBe(80);
  });

  it("is deterministic for identical setups and context", () => {
    const a = evaluation({ symbol: "AAA.TO" }),
      b = evaluation({ symbol: "BBB.TO" });
    expect(
      compareOpportunities(
        { setup: a, contextScore: 50 },
        { setup: b, contextScore: 50 },
      ),
    ).toBeLessThan(0);
    expect(
      rankOpportunities([b, a]).map((value) => value.setup.symbol),
    ).toEqual(rankOpportunities([a, b]).map((value) => value.setup.symbol));
  });

  it("orders every terminal state below every live state", () => {
    const states: StrategyState[] = [
      "INACTIVE",
      "WATCH",
      "FORMING",
      "READY",
      "INVALIDATED",
      "EXPIRED",
      "HALTED",
      "DATA_STALE",
    ];
    const ranked = rankOpportunities(
      states.map((state, index) =>
        evaluation({
          state,
          symbol: `S${index}.TO`,
          score: 50,
          setupScore: 50,
        }),
      ),
    );
    expect(ranked.slice(0, 3).map((value) => value.setup.state)).toEqual([
      "READY",
      "FORMING",
      "WATCH",
    ]);
  });
});

describe("Phase 6 context and ranking research", () => {
  it("retains raw session-horizon evidence under an independent context score version", () => {
    const parsed = contextEvaluationSchema.parse(contextFor("AAA.TO", 90));
    expect(parsed.contextScoreVersion).toBe(CONTEXT_SCORE_VERSION);
    expect(parsed.contextScoreComponents[0]).toMatchObject({
      horizon: "SESSION_FROM_OPEN",
      candidateValue: 1,
      benchmarkValue: 0.2,
      observedDifference: 0.8,
      score: 90,
      available: true,
    });
    expect(parsed.contextScoreVersion).not.toBe(parsed.signalVersion);
  });

  it("keeps historical context rows readable with neutral compatibility metadata", () => {
    const {
      contextScoreVersion,
      contextScoreComponents,
      missingDataFlags,
      ...legacy
    } = contextFor("AAA.TO", 50);
    const parsed = contextEvaluationSchema.parse(legacy);
    expect(parsed.contextScoreVersion).toBe("legacy-context-v1");
    expect(parsed.contextScoreComponents).toEqual([]);
    expect(parsed.missingDataFlags).toEqual([]);
  });

  it("keeps the tie-breaker formula active while bounded context stays opt-in research", () => {
    const higherSetup = evaluation({
      symbol: "AAA.TO",
      score: 78,
      setupScore: 78,
    });
    const lowerSetup = evaluation({
      symbol: "BBB.TO",
      score: 75,
      setupScore: 75,
    });
    const contexts = [contextFor("AAA.TO", 50), contextFor("BBB.TO", 100)];
    expect(ACTIVE_RANKING_FORMULA.version).toBe(ACTIVE_RANKING_FORMULA_VERSION);
    expect(
      rankOpportunities([lowerSetup, higherSetup], contexts)[0].setup.symbol,
    ).toBe("AAA.TO");
    const projected = researchRankOpportunities(
      [lowerSetup, higherSetup],
      contexts,
      BOUNDED_CONTEXT_RESEARCH_FORMULA,
    );
    expect(projected[0].setup.symbol).toBe("BBB.TO");
    expect(projected[0]).toMatchObject({
      rankingScore: 80,
      contextAdjustment: 5,
      rankingFormulaVersion: "ranking-bounded-context-research-v1",
    });
    expect(projected[0].setup.setupScore).toBe(75);
  });

  it("bounds adjustments and never lets a research formula cross state priority", () => {
    const forming = evaluation({
      symbol: "AAA.TO",
      state: "FORMING",
      score: 99,
      setupScore: 99,
    });
    const ready = evaluation({
      symbol: "BBB.TO",
      state: "READY",
      score: 1,
      setupScore: 1,
    });
    const projected = researchRankOpportunities(
      [forming, ready],
      [contextFor("AAA.TO", 100), contextFor("BBB.TO", 0)],
      BOUNDED_CONTEXT_RESEARCH_FORMULA,
    );
    expect(projected.map((value) => value.setup.state)).toEqual([
      "READY",
      "FORMING",
    ]);
    expect(
      projected.every((value) => Math.abs(value.contextAdjustment) <= 5),
    ).toBe(true);
  });

  it("requires an explicit setup-family weight for interaction research", () => {
    const orb = evaluation({ strategy: "ORB_RETEST" });
    expect(
      projectRankingResearch(orb, 100, SETUP_INTERACTION_RESEARCH_FORMULA)
        .contextAdjustment,
    ).toBe(0);
    const explicit = {
      ...SETUP_INTERACTION_RESEARCH_FORMULA,
      strategyWeights: { ORB_RETEST: 0.1 },
    };
    expect(projectRankingResearch(orb, 100, explicit).contextAdjustment).toBe(
      5,
    );
    expect(
      projectRankingResearch(
        evaluation({ strategy: "VWAP_HOLD" }),
        100,
        explicit,
      ).contextAdjustment,
    ).toBe(0);
  });

  it("reports correlated setup/context inputs for later double-counting analysis", () => {
    const projected = projectRankingResearch(
      evaluation({}),
      80,
      BOUNDED_CONTEXT_RESEARCH_FORMULA,
    );
    expect(projected.correlatedInputFlags).toContain(
      "PRICE_MOMENTUM_PRESENT_IN_CONTEXT_INPUT",
    );
  });
});
