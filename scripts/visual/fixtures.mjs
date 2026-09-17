// Visual-verification fixtures for the scanner web app.
//
// Every payload is sanitized through the same Zod schemas the browser app
// parses with (`@tsx-scanner/contracts` built output), so a fixture can never
// drift from the contract without failing loudly here during startup.
import * as C from "../../contracts/dist/index.js";

const CA = "CA_TSX";
const US = "US_EQUITIES";

const HASH = "a".repeat(64);
const PROFILE_ID = "9c2f3a10-4b5c-4d6e-8f70-1a2b3c4d5e6f";
const PROFILE_CONFIG_ID = "20000000-0000-4000-8000-000000000102";
const MODEL_ID = "11111111-1111-4111-8111-111111111111";
const EXPERIMENT_ID = "22222222-2222-4222-8222-222222222222";
const DATASET_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_RUN_ID = "10000000-0000-4000-8000-000000000402";
const BACKTEST_RUN_ID = "20000000-0000-4000-8000-000000000001";
const DISCOVERY_RUN_ID = "00000000-0000-4000-8000-000000000001";

// Anchor both the fixture payloads and the browser clock (screenshot.mjs sets
// this fixed time on each page) so relative labels and timestamps render
// identically across captures. The date stays current; the time of day is fixed
// inside the regular session.
const FIXTURE_NOW = new Date();
FIXTURE_NOW.setUTCHours(14, 30, 0, 0);
export const FIXTURE_NOW_MS = FIXTURE_NOW.getTime();

function iso(offsetMs = 0) {
  return new Date(FIXTURE_NOW_MS + offsetMs).toISOString();
}

function date(offsetDays = 0) {
  return new Date(FIXTURE_NOW_MS + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function parse(schema, value) {
  return schema.parse(value);
}

// ---------------------------------------------------------------------------
// Scanner bootstrap: system, market, universe, candidates, contexts, alerts
// ---------------------------------------------------------------------------

function operational(overrides = {}) {
  return {
    serviceReady: true,
    operationalReady: true,
    actionable: true,
    reasonCodes: [],
    marketDataMode: "live",
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

function systemStatus(overrides = {}) {
  const value = {
    service: "api",
    status: "ok",
    version: "0.12.0",
    timestamp: iso(-2_000),
    mode: "live",
    checks: {
      database: { status: "ok" },
      scanner: { status: "ok" },
      config: { status: "ok" },
      marketData: { status: "ok" },
    },
    operational: operational(),
    ...overrides,
  };
  if (overrides.operational)
    value.operational = operational(overrides.operational);
  return parse(C.systemStatusSchema, value);
}

const UNIVERSE_POLICY = {
  version: "tsx-liquid-momentum-v1",
  marketId: CA,
  exchange: "TSX",
  currency: "CAD",
  allowedExchanges: ["TSX"],
  allowedCurrencies: ["CAD"],
  securityTypes: ["Stock", "Common Stock"],
  minimumPrice: 5,
  maximumPrice: 150,
  minimumMarketCap: 500_000_000,
  minimumAverageVolume90d: 500_000,
  minimumDollarVolume: 20_000_000,
  minimumAtrPct: 1.5,
  minimumHistoryDays: 20,
};

function universeAutomation(symbols, overrides = {}) {
  return parse(C.universeAutomationSchema, {
    provider: "CONFIGURED_TSX_LIVE_WATCHLIST",
    policy: UNIVERSE_POLICY,
    latestRun: null,
    members: [],
    editable: true,
    configuredSymbols: symbols,
    candidates: [],
    candidateStatuses: symbols.map((symbol) => ({
      symbol,
      status: "QUALIFIED",
      source: "DISCOVERY",
      discoveredAt: iso(-86_400_000),
      intakeAt: iso(-86_000_000),
      strategyReadyAt: iso(-85_000_000),
      reason: null,
      attemptCount: 0,
    })),
    watchlistDate: date(),
    ...overrides,
  });
}

function uuidFor(seed) {
  const hex = Array.from(seed)
    .reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(8, "0");
  return `${hex}-0000-4000-8000-000000000000`;
}

function featureSnapshot(symbol, overrides = {}) {
  return parse(C.featureSnapshotSchema, {
    marketId: CA,
    instrumentId: uuidFor(symbol),
    symbol,
    timestamp: iso(-90_000),
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
    rsi14: 58.4,
    dailyEmaContext: {
      status: "BULLISH",
      ema13: 21.1,
      ema21: 20.8,
      slope13: 0.02,
      slope21: 0.01,
    },
    atr14: 0.41,
    atrPct: 1.9,
    rvolAtTime: 2.35,
    currentCumulativeVolume: 812_400,
    historicalMeanCumulativeVolume: 604_100,
    openingRange: {
      high: 21.9,
      low: 21.2,
      mid: 21.55,
      width: 0.7,
      widthPct: 3.26,
      widthAtr: 1.7,
      volume: 420_000,
      complete: true,
    },
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
  });
}

function makeEvaluation(symbol, state = "READY", overrides = {}) {
  return parse(C.strategyEvaluationSchema, {
    kind: "SETUP",
    marketId: CA,
    instrumentId: uuidFor(symbol),
    symbol,
    timestamp: iso(-90_000),
    profileId: PROFILE_ID,
    profileName: "Momentum core",
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configVersion: "config-v7",
    state,
    score: 82,
    setupScore: 82,
    scoreVersion: "score-v3",
    scoreComponents: {
      pattern: 22,
      confirmation: 20,
      structure: 18,
      liquidity: 10,
      timing: 12,
      penalties: 0,
    },
    scoreExplanation: [],
    setupInstanceId: uuidFor(`setup:${symbol}`),
    reasonCodes: [],
    entryReference: 21.5,
    stopReference: 21.1,
    targetReference: 22.3,
    estimatedRr: 2.1,
    featureSnapshot: featureSnapshot(symbol),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Candidate detail: two profiles, populated score explanation, context,
// coverage, member, 5-minute candles, state events and formation markers.
// ---------------------------------------------------------------------------

const SECOND_PROFILE_ID = "7b1e2c30-5d4f-4a61-9b82-2c3d4e5f6071";

const SCORE_CONTRIBUTIONS = [
  {
    key: "pattern.retest_hold",
    group: "pattern",
    label: "Opening-range retest held",
    points: 22,
    maximum: 25,
    value: 0.82,
    detail:
      "Two closes above the opening-range high with volume contracting into the retest.",
  },
  {
    key: "confirmation.reclaim_close",
    group: "confirmation",
    label: "Reclaim close confirmed",
    points: 20,
    maximum: 20,
    value: 21.62,
    detail: "The 5-minute bar closed back above the level it lost.",
  },
  {
    key: "structure.higher_lows",
    group: "structure",
    label: "Higher lows into the level",
    points: 18,
    maximum: 20,
    value: 3,
    detail: "Three rising five-minute lows since the first pullback.",
  },
  {
    key: "liquidity.spread",
    group: "liquidity",
    label: "Spread inside limit",
    points: 10,
    maximum: 20,
    value: 0.09,
    detail: "Median spread stayed below the 0.12% cap.",
  },
  {
    key: "timing.preferred_window",
    group: "timing",
    label: "Preferred entry window",
    points: 12,
    maximum: 15,
    value: null,
    detail: "Signal arrived before the 11:00 hard end.",
  },
];

function makeCandles(count = 48) {
  const candles = [];
  for (let index = 0; index < count; index += 1) {
    const offset = -90_000 - (count - index) * 300_000;
    const mid = 21.45 + Math.sin(index / 5) * 0.35 + index * 0.004;
    const open = mid - 0.04;
    const close = mid + 0.02;
    candles.push(
      parse(C.chartCandleSchema, {
        start: iso(offset),
        end: iso(offset + 300_000),
        open,
        high: Math.max(open, close) + 0.05 + (index % 3) * 0.01,
        low: Math.min(open, close) - 0.05 - (index % 2) * 0.01,
        close,
        volume: 118_000 + index * 1_250,
        isComplete: true,
      }),
    );
  }
  return candles;
}

function detailContext(symbol) {
  return parse(C.contextEvaluationSchema, {
    kind: "CONTEXT",
    marketId: CA,
    instrumentId: uuidFor(symbol),
    symbol,
    timestamp: iso(-60_000),
    profileId: PROFILE_ID,
    profileName: "Sector relative strength",
    signal: "SECTOR_RELATIVE_STRENGTH",
    signalVersion: "1.0.0",
    configVersion: "config-v7",
    status: "STRONG",
    contextScore: 78,
    contextScoreVersion: "context-score-v2",
    contextScoreComponents: [],
    missingDataFlags: [],
    observedValue: 1.42,
    benchmarkSymbol: "XEG.TO",
    benchmarkValue: 0.81,
    benchmarkTimestamp: iso(-120_000),
    lookback: "SESSION_FROM_OPEN",
    reasonCodes: ["SECTOR_LEADING"],
    featureSnapshot: featureSnapshot(symbol),
  });
}

function detailMember(symbol) {
  return parse(C.universeMemberSchema, {
    instrumentId: uuidFor(symbol),
    marketId: CA,
    symbol,
    description: "Visual fixture member",
    exchange: "TSX",
    normalizedExchange: "TSX",
    currency: "CAD",
    sector: "Energy",
    eligible: true,
    reasons: [],
    price: 21.45,
    marketCap: 42_000_000_000,
    averageVolume20d: 3_100_000,
    averageVolume90d: 2_800_000,
    dollarVolume: 66_500_000,
    atr14: 0.41,
    atrPct: 1.9,
    metricsAsOf: iso(-86_400_000),
  });
}

function universeMember(symbol, overrides = {}) {
  return parse(C.universeMemberSchema, {
    ...detailMember(symbol),
    ...overrides,
  });
}

function universeRun(overrides = {}) {
  return parse(C.universeRefreshRunSchema, {
    id: "33333333-3333-4333-8333-333333333333",
    marketId: CA,
    provider: "CONFIGURED_TSX_LIVE_WATCHLIST",
    policyVersion: "tsx-liquid-momentum-v1",
    status: "COMPLETED",
    discoveredCount: 3,
    evaluatedCount: 3,
    eligibleCount: 2,
    activatedCount: 3,
    warnings: [],
    error: null,
    startedAt: iso(-300_000),
    completedAt: iso(-240_000),
    ...overrides,
  });
}

function universeCoverage(symbol, overrides = {}) {
  return parse(C.candidateCoverageSchema, {
    symbol,
    status: "READY",
    dataReadiness: "READY",
    warmupPending: [],
    setupCount: 2,
    contextCount: 1,
    latestAnalysisAt: iso(-90_000),
    reasons: [],
    ...overrides,
  });
}

function intakeEntry(symbol, overrides = {}) {
  return parse(C.candidateIntakeEntrySchema, {
    source: "TRADINGVIEW",
    tradingDate: date(),
    addedAt: iso(-86_000_000),
    originalInput: symbol,
    marketId: CA,
    requestedExchange: null,
    normalizedSymbol: symbol,
    resolvedInstrumentId: uuidFor(symbol),
    resolvedSymbol: symbol,
    resolutionStatus: "RESOLVED",
    note: null,
    tags: [],
    ...overrides,
  });
}

function makeStateEvent(symbol, overrides) {
  return parse(C.strategyStateEventSchema, {
    ...makeEvaluation(symbol),
    eventId: uuidFor(`event:${symbol}:${overrides.timestamp}`),
    eventType: "STRATEGY_STATE_CHANGED",
    ...overrides,
  });
}

function candidateDetail(symbol) {
  const primary = makeEvaluation(symbol, "READY", {
    scoreExplanation: SCORE_CONTRIBUTIONS,
    reasonCodes: ["READY_CONFIRMED", "ENTRY_WINDOW_OPEN"],
    formationEvidence: {
      version: "formation-evidence-v1",
      strategy: "ORB_RETEST",
      formationKey: `${symbol}:orb-retest`,
      setupLevel: 21.5,
      stopLevel: 21.1,
      retest: {
        impulseStartAt: iso(-2_100_000),
        impulseEndAt: iso(-1_500_000),
        impulseMeanVolume: 210_000,
        retestBarEnd: iso(-1_050_000),
        retestBarHigh: 21.55,
        retestBarLow: 21.25,
        pullbackVolumeSum: 320_000,
        pullbackVolumeCount: 3,
        volumeContractionRatio: 0.48,
        volumeUnavailable: false,
        supportRejectionConfirmed: true,
      },
      rsiVwapReclaim: null,
    },
  });
  const secondary = makeEvaluation(symbol, "FORMING", {
    profileId: SECOND_PROFILE_ID,
    profileName: "Mean reversion",
    strategy: "VWAP_RECLAIM",
    score: 64,
    setupScore: 64,
    scoreVersion: "legacy-v1",
    entryReference: 21.2,
    stopReference: 20.9,
    targetReference: 21.7,
    estimatedRr: 1.7,
    reasonCodes: ["VWAP_RECLAIM_PENDING"],
  });
  return parse(C.candidateDetailSchema, {
    symbol,
    strategies: [primary, secondary],
    contexts: [detailContext(symbol)],
    feature: primary.featureSnapshot,
    candles: makeCandles(),
    events: [
      makeStateEvent(symbol, {
        timestamp: iso(-1_800_000),
        previousState: "WATCH",
        state: "FORMING",
      }),
      makeStateEvent(symbol, {
        timestamp: iso(-600_000),
        previousState: "FORMING",
        state: "READY",
      }),
    ],
    member: detailMember(symbol),
    coverage: parse(C.candidateCoverageSchema, {
      symbol,
      status: "READY",
      dataReadiness: "READY",
      warmupPending: [],
      setupCount: 2,
      contextCount: 1,
      latestAnalysisAt: iso(-90_000),
      reasons: [],
    }),
  });
}

function makeAlert(overrides) {
  return parse(C.scannerAlertSchema, {
    alertId: uuidFor(`alert:${overrides.symbol}:${overrides.type}`),
    eventId: uuidFor(`event:${overrides.symbol}:alert`),
    type: "READY",
    symbol: "TD.TO",
    strategy: "ORB_RETEST",
    profileId: PROFILE_ID,
    profileName: "Momentum core",
    strategyVersion: "1.0.0",
    configVersion: "config-v7",
    timestamp: iso(-210_000),
    previousState: "FORMING",
    state: "READY",
    score: 82,
    title: "Setup ready",
    message: "ORB retest armed above the opening range.",
    reasonCodes: ["READY_CONFIRMED"],
    setupInstanceId: uuidFor(`setup:${overrides.symbol}`),
    entryReference: 21.5,
    stopReference: 21.1,
    targetReference: 22.3,
    ...overrides,
  });
}

const HEALTHY_SYMBOLS = ["TD.TO", "RY.TO", "CNQ.TO"];

function paperBotStatus(overrides = {}) {
  return {
    runId: null,
    sessionDate: null,
    scheduledCloseAt: null,
    executionModelVersion: null,
    openExecutions: 0,
    closePendingExecutions: 0,
    closedExecutions: 0,
    noFillExecutions: 0,
    rejectedEconomicsExecutions: 0,
    reconciliationBacklog: 0,
    unreconcilableEvents: 0,
    overdueRuns: 0,
    unresolvedCoordinatedPositions: 0,
    completedRunsWithUnresolvedCoordinatedPositions: 0,
    oldestUnresolvedCoordinatedAgeMs: null,
    unknownQuoteSizeUnits: 0,
    abandonedExecutions: 0,
    lastTransitionAt: null,
    lastProcessingDurationMs: null,
    lastError: null,
    lastSuccessfulProcessingAt: null,
    fundedProcessing: false,
    fundedLastSuccessfulProcessingAt: null,
    funded: {
      pendingFacts: 0,
      oldestPendingFactAgeMs: null,
      closePendingOrders: 0,
      oldestClosePendingAgeMs: null,
      riskVetoesTotal: 0,
      coverageGapsTotal: 0,
      recoveryFailuresTotal: 0,
      lastCycleLatencyMs: 12,
    },
    ...overrides,
  };
}

function marketStatus(overrides = {}) {
  return {
    state: "ACTIVE",
    dataStatus: "REALTIME",
    lastQuoteAt: iso(-500),
    lastCandleAt: iso(-30_000),
    lastError: null,
    instrumentCount: 3,
    featureSnapshotCount: 3,
    contextEvaluationCount: 3,
    benchmarkCount: 2,
    benchmarkWarnings: [],
    session: { marketStatus: "OPEN", phase: "PREFERRED_ENTRIES" },
    paperBot: paperBotStatus(),
    ...overrides,
  };
}

const DEFAULT_ALERT_POLICY = parse(C.alertPolicySchema, {
  cooldownMinutes: 5,
  rearmRule: "NEW_SETUP_INSTANCE",
  contextNotificationsEnabled: false,
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discoveryStatus(overrides = {}) {
  return parse(C.discoveryStatusSchema, {
    marketId: CA,
    mode: "SHADOW",
    revision: 1,
    modeUpdatedAt: iso(-3_600_000),
    modeActor: "operator@127.0.0.1",
    scheduler: "IDLE",
    policy: C.discoveryPolicyForMarket(CA),
    catalog: {
      status: "FRESH",
      source: "EODHD",
      tradingDate: date(-1),
      fetchedAt: iso(-300_000),
      ageMs: 300_000,
      rowCount: 120,
      admittedCount: 100,
      failure: null,
    },
    lastRun: null,
    nextEvaluationAt: iso(120_000),
    activeRunId: null,
    queueDepth: 0,
    oldestQueueAgeMs: 0,
    lastError: null,
    budget: {
      remainingHour: 10_000,
      remainingDiscoveryHour: 1_500,
      queued: 0,
      active: 0,
    },
    performance: {
      sampleCount: 12,
      lastCycleDurationMs: 3_500,
      lastQueueLatencyMs: 250,
      cycleP95Ms: 4_200,
      queueP95Ms: 300,
      requestUsage: { completed: 40, failed: 1, cancelled: 0, expired: 2 },
    },
    fastFunnel: {
      marketId: CA,
      enabled: false,
      lastAcceleratedAt: null,
      topMoversCount: 0,
      topMoverSymbols: [],
      acceleratedCandidatesCount: 0,
      acceleratedEvaluatedCount: 0,
      acceleratedPassedCount: 0,
    },
    parity: {
      marketId: CA,
      latestAudit: null,
      auditCount: 0,
      averageOverlapRatio: null,
      lastAuditedAt: null,
    },
    ...overrides,
  });
}

function discoveryRun(overrides = {}) {
  return {
    id: DISCOVERY_RUN_ID,
    marketId: CA,
    tradingDate: date(-1),
    policyVersion: "ca-discovery-v1",
    mode: "SHADOW",
    evaluationAt: iso(-3_600_000),
    completedBarEnd: iso(-3_660_000),
    catalogDigest: HASH,
    status: "COMPLETED",
    coverage: { total: 100, pass: 60, fail: 20, unevaluable: 10, deferred: 10 },
    startedAt: iso(-3_610_000),
    completedAt: iso(-3_540_000),
    failure: null,
    ...overrides,
  };
}

function discoveryEvaluation(overrides = {}) {
  const base = {
    id: "00000000-0000-4000-8000-000000000002",
    runId: DISCOVERY_RUN_ID,
    result: {
      marketId: CA,
      policyVersion: "ca-discovery-v1",
      providerCode: "TEST",
      symbolId: 123,
      providerExchange: "TSX",
      tradingDate: date(-1),
      evaluationAt: iso(-3_600_000),
      computedAt: iso(-3_590_000),
      completedBarEnd: iso(-3_660_000),
      state: "PASS",
      reasons: [],
      metrics: {
        price: { value: 21.45, asOf: iso(-3_660_000) },
        marketCap: { value: 1_000_000_000, asOf: iso(-3_660_000) },
        averageVolume90d: { value: 1_200_000, asOf: iso(-3_660_000) },
        averageVolume30d: { value: 900_000, asOf: iso(-3_660_000) },
        atr14: { value: 0.41, asOf: iso(-3_660_000) },
        atrPct: { value: 1.9, asOf: iso(-3_660_000) },
        relativeVolume: { value: 2.35, asOf: iso(-3_660_000) },
        changeFromOpenPct: { value: 1.82, asOf: iso(-3_660_000) },
        dollarVolume30d: { value: 30_000_000, asOf: iso(-3_660_000) },
      },
    },
    inputDigest: null,
    input: null,
    inputRetained: false,
  };
  return parse(C.discoveryEvidenceSchema, { ...base, ...overrides });
}

// ---------------------------------------------------------------------------
// Paper bot evidence
// ---------------------------------------------------------------------------

function paperRun(overrides = {}) {
  return parse(C.paperBotRunSchema, {
    id: SESSION_RUN_ID,
    source: "LIVE",
    sessionDate: date(),
    sessionTimezone: "America/Toronto",
    scheduledCloseAt: iso(3 * 3_600_000),
    status: "RUNNING",
    executionModelVersion: "paper-execution-v7",
    assumptions: {},
    startedAt: iso(-2 * 3_600_000),
    completedAt: null,
    failedAt: null,
    failureReason: null,
    ...overrides,
  });
}

function aggregate(overrides = {}) {
  return parse(C.paperCohortAggregateSchema, {
    cohort: {
      marketId: CA,
      currency: "CAD",
      signalSemanticsVersion: "signals-v1",
      replayScope: "LIVE",
      profileId: PROFILE_ID,
      profileName: "Momentum core",
      profileConfigId: PROFILE_CONFIG_ID,
      configVersion: "config-v7",
      strategyKey: "ORB_RETEST",
      strategyVersion: "1.0.0",
      source: "LIVE",
      executionModelVersion: "paper-execution-v7",
      assumptions: { notes: "fixture assumptions" },
    },
    model: "QUOTE",
    signalCount: 4,
    eligibleSignalCount: 3,
    fills: 2,
    noFills: 1,
    rejectedEconomics: 1,
    closedTrades: 2,
    openExecutions: 0,
    closePendingExecutions: 0,
    unresolvedExecutions: 0,
    fillRate: { numerator: 2, denominator: 3, value: 2 / 3 },
    winRate: { numerator: 1, denominator: 2, value: 0.5 },
    averageR: 0.4,
    expectancyR: 0.4,
    cumulativeR: 0.8,
    exitReasons: { TARGET: 1, STOP: 1 },
    noFillReasons: { MISSING_QUOTE: 1 },
    economicsReasons: { NET_TARGET_NON_POSITIVE: 1 },
    sizeCoverage: [],
    exitSizeCoverage: [],
    entrySpread: {
      sampleCount: 0,
      minimum: null,
      maximum: null,
      average: null,
    },
    delayedClose: { count: 0, totalDurationMs: 0, averageDurationMs: null },
    ...overrides,
  });
}

function coordinationSummary(overrides = {}) {
  return parse(C.paperCoordinationSummarySchema, {
    policyVersions: ["paper-coordination-v2"],
    decisions: 2,
    approved: 1,
    deferred: 1,
    rejected: 0,
    reasons: { SELECTED_PRIMARY: 1, POST_STOP_COOLDOWN: 1 },
    openPositions: 0,
    closedTrades: 1,
    wins: 1,
    winRate: { numerator: 1, denominator: 1, value: 1 },
    netPnl: 24.5,
    cumulativeR: 0.5,
    averageR: 0.5,
    exitReasons: { TARGET: 1 },
    symbolsTraded: 1,
    repeatedSymbolEntries: 0,
    ...overrides,
  });
}

function coordinationDecision(overrides = {}) {
  return parse(C.paperCoordinationDecisionSchema, {
    id: "10000000-0000-4000-8000-000000000403",
    runId: SESSION_RUN_ID,
    symbol: "TD.TO",
    decisionTimestamp: iso(-3_600_000),
    outcome: "APPROVED",
    reason: "SELECTED_PRIMARY",
    policyVersion: "paper-coordination-v2",
    selectedObservationId: "10000000-0000-4000-8000-000000000404",
    selectedStrategyKey: "ORB_RETEST",
    confirmationObservationIds: [],
    candidateCount: 2,
    contexts: [],
    state: {},
    positionStatus: "CLOSED",
    exitReason: "TARGET",
    exitTime: iso(-1_800_000),
    netPnl: 24.5,
    rMultiple: 0.5,
    createdAt: iso(-3_599_000),
    ...overrides,
  });
}

function activity(overrides = {}) {
  return parse(C.paperBotActivitySchema, {
    id: "10000000-0000-4000-8000-000000000401",
    runId: SESSION_RUN_ID,
    occurredAt: iso(-3_500_000),
    eventType: "RUN_STARTED",
    severity: "INFO",
    symbol: null,
    strategyKey: null,
    model: null,
    message: "Paper bot started today's live run.",
    details: {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

const TRAINING_METRICS = {
  samples: 240,
  positives: 120,
  negatives: 120,
  baseRate: 0.5,
  brierScore: 0.18,
  baselineBrierScore: 0.24,
  logLoss: 0.55,
  rocAuc: 0.71,
};

function evidenceCohort(configVersion, closedQuoteCount, overrides = {}) {
  return {
    marketId: CA,
    strategy: "ORB_RETEST",
    strategyVersion: "strategy-v1",
    profileConfigId: PROFILE_CONFIG_ID,
    configVersion,
    executionModelVersion: "execution-v1",
    assumptions: {},
    closedQuoteCount,
    positives: Math.floor(closedQuoteCount / 2),
    negatives: closedQuoteCount - Math.floor(closedQuoteCount / 2),
    firstSignalAt: iso(-40 * 86_400_000),
    lastSignalAt: iso(-3_600_000),
    missingFeatureCount: 0,
    signalSemanticsVersion: "signals-v1",
    replayScope: "FORWARD_LIVE",
    ...overrides,
  };
}

function learningOverview(overrides = {}) {
  return parse(C.learningDashboardOverviewSchema, {
    pipelineHealth: {
      schedulerEnabled: true,
      scheduleDescription: "Daily at 5:00 p.m. Eastern, plus worker startup",
      schedulerPolicyVersion: "policy-v1",
      lastCheckAt: iso(-18 * 3_600_000),
      nextCheckAt: iso(6 * 3_600_000),
      nextCheckIsEstimate: true,
      checkOverdue: false,
      lastState: "NOOP",
      lastNoopReason: "INSUFFICIENT_CLOSED_QUOTES",
      activeJobs: 0,
      durableErrors: 0,
      explanation: "Scheduler idle: INSUFFICIENT_CLOSED_QUOTES",
    },
    evidenceReadiness: [],
    lifecycle: { datasetsCount: 0, modelsCount: 0, activeModelsCount: 0 },
    forwardMonitoring: [],
    shadowExperiments: {
      policyVersion: "paper-coordination-v4-shadow",
      comparatorPolicyVersion: "paper-coordination-v3",
      decisionsEvaluated: 0,
      selectionChangesCount: 0,
      selectionChangeRate: 0,
      differenceReasons: {},
      hypotheticalNetPnl: 0,
      primaryNetPnl: 0,
      hypotheticalCumulativeR: 0,
      primaryCumulativeR: 0,
    },
    ...overrides,
  });
}

function learningRun(state, overrides = {}) {
  return parse(C.learningAutomationRunSchema, {
    id: "55555555-5555-4555-8555-555555555555",
    schedulerVersion: "scheduler-v1",
    policyVersion: "policy-v1",
    startedAt: iso(-18 * 3_600_000),
    completedAt: iso(-18 * 3_600_000 + 5_000),
    state,
    cohortsExamined: [],
    noopReason: null,
    createdDatasetId: null,
    createdJobId: null,
    error: null,
    createdAt: iso(-18 * 3_600_000 - 1_000),
    ...overrides,
  });
}

function statisticalModel(overrides = {}) {
  return parse(C.statisticalModelSchema, {
    id: MODEL_ID,
    marketId: CA,
    name: "ORB quality · paper evidence",
    status: "COMPLETED",
    modelType: "LOGISTIC_SETUP_QUALITY",
    modelVersion: "model-v2",
    sourceKind: "PAPER_EVIDENCE",
    backtestRunId: null,
    trainingDatasetId: DATASET_ID,
    strategy: "ORB_RETEST",
    input: {
      name: "ORB quality · paper evidence",
      strategy: "ORB_RETEST",
      trainPct: 80,
      minimumSamples: 200,
      l2Penalty: 0.1,
      sourceKind: "PAPER_EVIDENCE",
      trainingDatasetId: DATASET_ID,
    },
    artifact: {
      artifactVersion: "1.0.0",
      modelType: "LOGISTIC_SETUP_QUALITY",
      featureNames: [
        "atrPct",
        "rvolAtTime",
        "spreadPct",
        "distanceFromVwapPct",
      ],
      intercept: -0.2,
      coefficients: [0.4, 0.3, -0.2, 0.1],
      means: [1.5, 1.8, 0.1, 0.4],
      scales: [0.5, 0.6, 0.05, 0.3],
      medians: [1.4, 1.7, 0.1, 0.35],
      atrMedian: 1.4,
      rvolMedian: 1.7,
    },
    trainMetrics: TRAINING_METRICS,
    testMetrics: TRAINING_METRICS,
    calibration: [],
    eligibleForActivation: true,
    active: false,
    warnings: [],
    error: null,
    trainingStart: iso(-10 * 86_400_000),
    trainingEnd: iso(-9 * 86_400_000),
    testStart: iso(-8 * 86_400_000),
    testEnd: iso(-7 * 86_400_000),
    createdAt: iso(-10 * 86_400_000),
    startedAt: iso(-10 * 86_400_000),
    completedAt: iso(-7 * 86_400_000),
    ...overrides,
  });
}

function evidenceStage(key, state, overrides = {}) {
  return {
    key,
    marketId: CA,
    scopeId: `${CA}:fixture`,
    state,
    asOf: iso(-60_000),
    lastAttemptAt: iso(-3_600_000),
    lastSuccessAt: state === "SUCCEEDED" ? iso(-3_500_000) : null,
    nextCheckAt: iso(6 * 3_600_000),
    progress: null,
    reasonCodes: [],
    nextAction: { kind: "AUTOMATIC", label: "The worker will check again" },
    jobId: null,
    reportId: null,
    ...overrides,
  };
}

const CHALLENGER_EXPERIMENT = parse(C.challengerExperimentSchema, {
  id: EXPERIMENT_ID,
  modelId: MODEL_ID,
  modelVersion: "model-v2",
  artifactHash: HASH,
  scope: {
    marketId: CA,
    currency: "CAD",
    strategy: "ORB_RETEST",
    strategyVersion: "strategy-v1",
    profileConfigId: PROFILE_CONFIG_ID,
    configVersion: "config-v1",
    executionModelVersion: "execution-v1",
    executionAssumptionsHash: HASH,
    signalSemanticsVersion: "signals-v1",
    replayScope: "sessions-v1",
  },
  researchEvidence: {
    manifestHash: HASH,
    coverageReportHash: HASH,
    inputHash: HASH,
    engineRevision: "1234567890abcdef1234567890abcdef12345678",
    runtimeFingerprint: HASH,
    verifiedAt: iso(-12 * 86_400_000),
  },
  baselineIdentityHash: HASH,
  acceptancePlanHash: HASH,
  startsAt: iso(-11 * 86_400_000),
  endsAt: iso(19 * 86_400_000),
  maxPredictionLagMs: 500,
  registeredAt: iso(-12 * 86_400_000),
  state: "ACTIVE",
});

const CHALLENGER_REPORT = parse(C.challengerObservationReportSchema, {
  experimentId: EXPERIMENT_ID,
  asOf: iso(-3_600_000),
  population: {
    expectedEligibleObservations: 5,
    predicted: 1,
    pending: 1,
    missedDeadline: 0,
    engineFailed: 0,
    inputInvalid: 0,
    revoked: 0,
    unknownCapture: 3,
  },
  verifiedSessions: 1,
  incompleteSessions: 1,
  unknownSessions: 1,
  coveredNoOpportunitySessions: 0,
  excludedPausedSessions: 0,
  closedQuoteOutcomes: 1,
  prospectiveBrierScore: 0.25,
  comparison: null,
  comparisonUnavailableReason: "PAIRED_INPUTS_MISSING",
  promotionAuthorized: false,
});

function calibrationRun(overrides = {}) {
  const metrics = {
    signalsGenerated: 0,
    readySignals: 0,
    tradesSimulated: 10,
    wins: 0,
    losses: 0,
    winRate: 0,
    averageWin: 0,
    averageLoss: 0,
    averageR: 0.5,
    medianR: 0,
    profitFactor: 0,
    expectancy: 0,
    netPnl: 0,
    maximumDrawdown: 0,
    maximumDrawdownPct: 0,
    falseBreakoutRate: 0,
    signalToTradeConversion: 0,
    averageHoldMinutes: 0,
  };
  return parse(C.calibrationRunSchema, {
    id: "10000000-0000-4000-8000-000000000099",
    name: "Holdout report",
    marketId: CA,
    status: "COMPLETED",
    startDate: date(-180),
    endDate: date(-30),
    strategy: "ORB_RETEST",
    symbols: [],
    dataSource: "CAPTURED_QUOTES",
    input: {
      name: "Holdout report",
      startDate: date(-180),
      endDate: date(-30),
      strategy: "ORB_RETEST",
      symbols: [],
      startingCapital: 100_000,
      positionSize: 10_000,
      slippageBps: 2,
      feePerTrade: 0,
      parameters: {},
    },
    combinationsTested: 1,
    totalCombinations: 1,
    truncated: false,
    splitDates: { trainEnd: date(-90), validationEnd: date(-60) },
    recommendation: "Insufficient evidence",
    recommendedConfig: null,
    trials: [
      {
        rank: 1,
        configVersion: "fixture",
        parameters: {
          openingRangeMinutes: 15,
          entryWindowEnd: "11:30",
          stopMethod: "STRUCTURAL",
          rewardRiskRatio: 2,
        },
        segments: {
          TRAIN: metrics,
          VALIDATION: metrics,
          TEST: null,
          ALL: null,
        },
        robustScore: 0.5,
        plateauSize: 1,
        sufficientSample: false,
        outOfSamplePositive: false,
        warnings: [],
        analyses: [],
        analysesScope: "VALIDATION",
      },
    ],
    error: null,
    createdAt: iso(-30 * 86_400_000),
    startedAt: iso(-30 * 86_400_000),
    completedAt: iso(-29 * 86_400_000),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Backtests
// ---------------------------------------------------------------------------

const BACKTEST_METRICS = {
  signalsGenerated: 12,
  readySignals: 9,
  tradesSimulated: 9,
  wins: 1,
  losses: 8,
  winRate: 11.11,
  averageWin: 20,
  averageLoss: -22,
  averageR: -0.92,
  medianR: -1,
  profitFactor: 0.07,
  expectancy: -17.97,
  netPnl: -161.72,
  maximumDrawdown: 161.72,
  maximumDrawdownPct: 0.16,
  falseBreakoutRate: 66.67,
  signalToTradeConversion: 0.75,
  averageHoldMinutes: 22,
};

function backtestRun(overrides = {}) {
  return parse(C.backtestRunSchema, {
    id: BACKTEST_RUN_ID,
    marketId: CA,
    name: "Auto qualification · ORB Standard · profile-orb-standard-v1",
    status: "COMPLETED",
    startDate: date(-12),
    endDate: date(-2),
    strategies: ["ORB_RETEST"],
    symbols: [],
    dataSource: "CAPTURED_QUOTES",
    strategyVersion: "strategy-v1",
    configVersion: "profile-orb-standard-v1",
    executionModelVersion: "paper-execution-v7",
    startingCapital: 100_000,
    positionSize: 10_000,
    slippageBps: 2,
    feePerTrade: 0,
    parameters: {},
    metrics: BACKTEST_METRICS,
    analyses: [],
    dataQuality: {
      quoteSnapshots: 10,
      candles: 10,
      sessions: 3,
      spread: "CAPTURED",
      warnings: ["9 captured quote(s) were excluded from replay."],
    },
    error: null,
    createdAt: iso(-6 * 86_400_000),
    startedAt: null,
    completedAt: iso(-3_600_000),
    ...overrides,
  });
}

function automationWork(overrides = {}) {
  return parse(C.backtestAutomationWorkSchema, {
    workKey: "a".repeat(64),
    marketId: CA,
    kind: "PROFILE_QUALIFICATION",
    configId: "10000000-0000-4000-8000-000000000098",
    configName: "Bull Flag",
    configVersion: "profile-bull-flag-v1",
    strategyKey: "BULL_FLAG",
    state: "SUCCEEDED",
    triggerOrigin: "SCHEDULED_CATCH_UP",
    blockerReason: null,
    inputFingerprint: "b".repeat(64),
    consumedFingerprint: "b".repeat(64),
    attemptKey: "c".repeat(64),
    jobId: null,
    jobStatus: null,
    runId: BACKTEST_RUN_ID,
    evaluatedThrough: date(-1),
    retryCount: 0,
    nextAttemptAt: null,
    lastDispatchedAt: iso(-2 * 3_600_000),
    lastSuccessAt: iso(-3_600_000),
    lastFailureAt: null,
    waitingSince: null,
    startedAt: null,
    heartbeatAt: null,
    progress: null,
    runDurationMs: 1_560_000,
    failureMessage: null,
    inputChanged: false,
    updatedAt: iso(-3_600_000),
    ...overrides,
  });
}

function automationStage(overrides = {}) {
  return parse(C.backtestAutomationStageSchema, {
    stageKey: "TRAINING",
    workKey: "a".repeat(64),
    marketId: CA,
    configId: "10000000-0000-4000-8000-000000000098",
    configName: "Bull Flag",
    state: "WAITING_FOR_EVIDENCE",
    authorizationScope: "QUALIFICATION_OWNED",
    reasonCodes: ["PAPER_QUALIFICATION_REQUIRED"],
    inputIdentityHash: "f".repeat(64),
    jobId: null,
    jobStatus: null,
    retryCount: 0,
    nextAttemptAt: null,
    failureMessage: null,
    lastEvaluatedAt: iso(-60_000),
    completedAt: null,
    updatedAt: iso(-60_000),
    ...overrides,
  });
}

const STRATEGY_DEFINITION_ID = "50000000-0000-4000-8000-000000000001";
const SECOND_STRATEGY_DEFINITION_ID = "50000000-0000-4000-8000-000000000002";

function strategyDefinition(overrides = {}) {
  return parse(C.strategyDefinitionSchema, {
    id: STRATEGY_DEFINITION_ID,
    strategyKey: "ORB_RETEST",
    version: "1.0.0",
    name: "ORB retest",
    analysisKind: "SETUP",
    description: "Opening-range breakout with a completed retest.",
    enabled: true,
    parameterSchema: {
      rvolAtTimeMin: true,
      spreadHardMaxPct: true,
      scoreCutoff: true,
    },
    createdAt: iso(-30 * 86_400_000),
    ...overrides,
  });
}

function scannerProfile(overrides = {}) {
  return parse(C.scannerProfileSchema, {
    id: PROFILE_ID,
    name: "ORB Standard",
    marketId: CA,
    strategyDefinitionId: STRATEGY_DEFINITION_ID,
    analysisKind: "SETUP",
    strategyKey: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configId: "10000000-0000-4000-8000-000000000010",
    configVersion: "profile-orb-standard-v1",
    parameters: {},
    enabled: true,
    qualification: "EXPLORATORY",
    displayOrder: 0,
    createdAt: iso(-30 * 86_400_000),
    updatedAt: iso(-86_400_000),
    ...overrides,
  });
}

function profileHistory(profile, overrides = {}) {
  return parse(C.profileConfigHistorySchema, {
    profileId: profile.id,
    profileName: profile.name,
    versions: [
      {
        configId: profile.configId,
        configVersion: profile.configVersion,
        parameters: profile.parameters,
        createdAt: iso(-86_400_000),
        current: true,
        changes: [
          {
            key: "rvolAtTimeMin",
            label: "RVOL minimum",
            unit: "×",
            previous: 1.4,
            next: 1.5,
          },
        ],
      },
      {
        configId: "60000000-0000-4000-8000-000000000002",
        configVersion: "config-v6",
        parameters: profile.parameters,
        createdAt: iso(-10 * 86_400_000),
        current: false,
        changes: [],
      },
    ],
    ...overrides,
  });
}

function profileComparison(overrides = {}) {
  return parse(C.profileComparisonSchema, {
    marketId: CA,
    source: "LIVE",
    startDate: date(-30),
    endDate: date(),
    timeStart: "09:30",
    timeEnd: "16:00",
    status: "CONTROLLED",
    controlled: true,
    differences: [],
    metrics: [
      {
        profileId: PROFILE_ID,
        profileName: "ORB Standard",
        setupCount: 42,
        trades: 18,
        wins: 11,
        winRate: 61.1,
        averageWinner: 1.42,
        averageLoser: -0.83,
        averageR: 0.38,
        profitFactor: 1.61,
        expectancy: 0.31,
        maximumDrawdown: -3.8,
        drawdownBasis: "REALIZED_CLOSED_OUTCOMES",
        drawdownStatus: "AVAILABLE",
        averageHoldMinutes: 47,
        falsePositiveRate: 22.2,
      },
      {
        profileId: SECOND_PROFILE_ID,
        profileName: "Bull Flag",
        setupCount: 27,
        trades: 9,
        wins: 4,
        winRate: 44.4,
        averageWinner: 1.18,
        averageLoser: -0.91,
        averageR: -0.02,
        profitFactor: 0.94,
        expectancy: -0.05,
        maximumDrawdown: null,
        drawdownBasis: "REALIZED_CLOSED_OUTCOMES",
        drawdownStatus: "NO_CLOSED_OUTCOMES",
        averageHoldMinutes: 63,
        falsePositiveRate: 33.3,
      },
    ],
    ...overrides,
  });
}

function journalEntry(overrides = {}) {
  return parse(C.paperJournalEntrySchema, {
    id: "70000000-0000-4000-8000-000000000001",
    runId: SESSION_RUN_ID,
    sessionDate: date(),
    symbol: "TD.TO",
    strategyKey: "ORB_RETEST",
    profileName: "ORB Standard",
    configVersion: "profile-orb-standard-v1",
    status: "CLOSED",
    entryPrice: 21.5,
    entryTime: iso(-3_600_000),
    stopPrice: 21.1,
    targetPrice: 22.3,
    shares: 100,
    initialRisk: 40,
    exitPrice: 22.1,
    exitTime: iso(-2_400_000),
    exitReason: "TARGET",
    grossPnl: 60,
    costs: 2.1,
    netPnl: 57.9,
    rMultiple: 1.45,
    runningNetPnl: 57.9,
    ...overrides,
  });
}

function emptyTradeJournal(projection) {
  return parse(C.paperTradeJournalSchema, {
    projection,
    entries: [],
    totals: {
      closedTrades: 0,
      openPositions: 0,
      wins: 0,
      losses: 0,
      scratches: 0,
      winRate: { numerator: 0, denominator: 0, value: null },
      grossPnl: 0,
      costs: 0,
      netPnl: 0,
      profitFactor: null,
      cumulativeR: 0,
      averageR: null,
      largestWin: null,
      largestLoss: null,
    },
    unresolvedPositions: [],
  });
}

function paperTradeJournal(overrides = {}) {
  return parse(C.paperTradeJournalSchema, {
    projection: "COORDINATED",
    entries: [
      journalEntry(),
      journalEntry({
        id: "70000000-0000-4000-8000-000000000002",
        symbol: "RY.TO",
        status: "CLOSED",
        entryPrice: 20.2,
        stopPrice: 19.8,
        targetPrice: 21.4,
        exitPrice: 19.85,
        exitReason: "STOP",
        grossPnl: -35,
        costs: 2.0,
        netPnl: -37,
        rMultiple: -0.93,
        runningNetPnl: 20.9,
      }),
      journalEntry({
        id: "70000000-0000-4000-8000-000000000003",
        symbol: "CNQ.TO",
        status: "CLOSE_PENDING",
        exitPrice: null,
        exitTime: null,
        exitReason: null,
        grossPnl: null,
        costs: null,
        netPnl: null,
        rMultiple: null,
        runningNetPnl: null,
        lastFactTimestamp: iso(-120_000),
      }),
      journalEntry({
        id: "70000000-0000-4000-8000-000000000004",
        symbol: "SHOP.TO",
        sessionDate: date(-1),
        status: "CLOSED",
        entryPrice: 31.2,
        stopPrice: 30.7,
        targetPrice: 32.6,
        exitPrice: 32.4,
        exitReason: "TIME_STOP",
        grossPnl: 120,
        costs: 2.4,
        netPnl: 117.6,
        rMultiple: 2.4,
        runningNetPnl: 138.5,
      }),
    ],
    totals: {
      closedTrades: 3,
      openPositions: 1,
      wins: 2,
      losses: 1,
      scratches: 0,
      winRate: { numerator: 2, denominator: 3, value: 0.6667 },
      grossPnl: 145,
      costs: 6.5,
      netPnl: 138.5,
      profitFactor: 4.74,
      cumulativeR: 2.92,
      averageR: 0.97,
      largestWin: 117.6,
      largestLoss: -37,
    },
    unresolvedPositions: [
      {
        id: "70000000-0000-4000-8000-000000000003",
        symbol: "CNQ.TO",
        sessionDate: date(),
        status: "CLOSE_PENDING",
        runStatus: "RUNNING",
        entryTime: iso(-3_600_000),
        lastFactTimestamp: iso(-120_000),
        ageMs: 120_000,
      },
    ],
    ...overrides,
  });
}

function paperPerformanceCurve(overrides = {}) {
  return parse(C.paperPerformanceCurveSchema, {
    account: "COORDINATED",
    marketId: CA,
    currency: "CAD",
    granularity: "DAY",
    startDate: date(-3),
    endDate: date(),
    points: [
      {
        sessionDate: date(-2),
        closedAt: iso(-2 * 86_400_000),
        netPnl: 57.9,
        cumulativeNetPnl: 57.9,
        trades: 1,
      },
      {
        sessionDate: date(-1),
        closedAt: iso(-86_400_000),
        netPnl: -37,
        cumulativeNetPnl: 20.9,
        trades: 1,
      },
      {
        sessionDate: date(),
        closedAt: iso(-600_000),
        netPnl: 117.6,
        cumulativeNetPnl: 138.5,
        trades: 2,
      },
    ],
    warnings: [],
    ...overrides,
  });
}

function fundedLiveAccount() {
  return parse(C.fundedLiveAccountResponseSchema, {
    status: "READY",
    account: {
      projection: "FUNDED_PAPER_ACCOUNT",
      marketId: CA,
      currency: "CAD",
      accountId: "80000000-0000-4000-8000-000000000001",
      runId: "80000000-0000-4000-8000-000000000002",
      runStatus: "COMPLETED",
      sessionDate: date(),
      asOf: iso(-600_000),
      temporalScope: "CURRENT_ACCOUNT",
      qualifiedForCapitalAllocation: false,
      qualificationReason:
        "Out-of-sample and walk-forward qualification is not established by execution reporting",
      summary: {
        cash: 10_126.4,
        equity: 10_126.4,
        realizedPnl: 126.4,
        dailyPnl: 138.5,
        reservedCash: 0,
        openRisk: 42,
        remainingDailyRisk: 61.5,
        staleMarks: false,
        entriesAllowed: true,
      },
      activity: {
        decisions: 4,
        closed: 2,
        open: 1,
        pending: 0,
        rejected: 1,
        cancelled: 0,
        wins: 2,
        cumulativeR: 1.7,
      },
      warnings: ["SIMULATED_LIQUIDITY_NOT_GUARANTEED"],
    },
  });
}

function backtestAutomationStatus(overrides = {}) {
  return parse(C.backtestAutomationStatusSchema, {
    marketId: CA,
    enabled: true,
    cadence: "DAILY_POST_SESSION",
    maxOutstanding: 2,
    asOf: iso(-1_000),
    nextCheckAt: iso(18 * 3_600_000),
    interventionRequired: false,
    lastCycle: null,
    works: [],
    stages: [],
    outstandingWork: 0,
    oldestOutstandingAt: null,
    oldestWaitingAt: null,
    lastSuccessAt: null,
    lastSuccessDurationMs: null,
    lastSuccessEvaluatedThrough: null,
    retryScheduled: 0,
    blockerCounts: [],
    recentCycles: [],
    ...overrides,
  });
}

function fundedPolicy(overrides = {}) {
  return parse(C.fundedHistoricalAutomationPolicySchema, {
    policyId: "40000000-0000-4000-8000-000000000001",
    policyHash: "9".repeat(64),
    marketId: CA,
    scope: {
      kind: "PROFILE_CONFIG",
      configId: "10000000-0000-4000-8000-000000000098",
      configVersion: "profile-bull-flag-v1",
    },
    maxSessions: 5,
    approvedBy: "operator",
    approvalNote: "Bounded funded replay comparison",
    approvedAt: iso(-86_400_000),
    expiresAt: iso(30 * 86_400_000),
    revokedAt: null,
    revokedBy: null,
    revokedReason: null,
    ...overrides,
  });
}

const FUNDED_REPLAY = parse(C.fundedHistoricalReplaySchema, {
  projection: "FUNDED_PORTFOLIO_REPLAY",
  runId: "10000000-0000-4000-8000-0000000000c1",
  accountId: "10000000-0000-4000-8000-0000000000c2",
  marketId: CA,
  currency: "CAD",
  sessionDate: date(-2),
  runStatus: "COMPLETED",
  executionModelVersion: "paper-execution-v7",
  temporalScope: "RUN_END",
  asOf: iso(-2 * 86_400_000),
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
});

const CAPTURED_HISTORY = parse(C.capturedHistoryAvailabilitySchema, {
  source: "CAPTURED_QUOTES",
  observedAt: iso(-3_600_000),
  tables: {
    quoteSnapshot: { earliest: iso(-10 * 86_400_000), latest: iso(-3_600_000) },
    candle: { earliest: iso(-40 * 86_400_000), latest: iso(-3_600_000) },
  },
  replay: { earliestDate: date(-10), latestDate: date(-1) },
  limitations: [
    {
      marketId: "CA_TSX",
      kind: "INTERIOR_NO_QUOTE",
      basis: "QUOTE_GAP_WITH_BACKFILLED_CANDLES",
      startAt: `${date(-6)}T14:05:00.000Z`,
      endAt: `${date(-6)}T15:45:00.000Z`,
      sessionDates: [date(-6)],
      detail:
        "No forward quotes were retained through this interval although completed candles exist inside it.",
      evaluatedFrom: iso(-36 * 86_400_000),
      evaluatedThrough: iso(-3_600_000),
    },
  ],
});

// ---------------------------------------------------------------------------
// Scenario set
// ---------------------------------------------------------------------------

function healthySet() {
  const succeeded = automationWork();
  const running = automationWork({
    workKey: "1".repeat(64),
    configId: "10000000-0000-4000-8000-000000000010",
    configName: "ORB Standard",
    configVersion: "profile-orb-standard-v1",
    strategyKey: "ORB_RETEST",
    state: "QUEUED",
    jobId: "50000000-0000-4000-8000-000000000001",
    jobStatus: "RUNNING",
    runId: BACKTEST_RUN_ID,
    lastSuccessAt: null,
    runDurationMs: null,
    startedAt: iso(-25 * 60_000),
    heartbeatAt: iso(-20_000),
    progress: {
      totalSessions: 9,
      completedSessions: 7,
      message: "Loading session 2026-09-10",
    },
  });
  const healthyCandidates = HEALTHY_SYMBOLS.map((symbol) =>
    makeEvaluation(symbol),
  );
  return {
    usEnabled: true,
    system: systemStatus(),
    market: marketStatus({
      paperBot: paperBotStatus({
        runId: SESSION_RUN_ID,
        sessionDate: date(),
        scheduledCloseAt: iso(3 * 3_600_000),
        executionModelVersion: "paper-execution-v7",
        openExecutions: 2,
        closePendingExecutions: 0,
        closedExecutions: 1,
        noFillExecutions: 0,
        reconciliationBacklog: 0,
        lastTransitionAt: iso(-4_000),
        lastProcessingDurationMs: 2.5,
        lastSuccessfulProcessingAt: iso(-4_000),
        fundedProcessing: true,
        fundedLastSuccessfulProcessingAt: iso(-4_000),
      }),
    }),
    universe: parse(C.universeResponseSchema, {
      instruments: [],
      automation: universeAutomation(HEALTHY_SYMBOLS, {
        latestRun: universeRun(),
        members: [
          universeMember("TD.TO"),
          universeMember("RY.TO"),
          universeMember("CNQ.TO", {
            eligible: false,
            reasons: ["AVERAGE_VOLUME_BELOW_MINIMUM"],
            averageVolume90d: 120_000,
            dollarVolume: 2_600_000,
          }),
        ],
        candidates: [
          intakeEntry("TD.TO", {
            source: "TRADINGVIEW",
            note: "Morning momentum scan",
            tags: ["gap-up"],
          }),
          intakeEntry("RY.TO", { source: "MANUAL" }),
        ],
        coverage: [
          universeCoverage("TD.TO"),
          universeCoverage("RY.TO", {
            status: "FORMING",
            dataReadiness: "WARMING",
            warmupPending: ["opening range"],
            setupCount: 1,
          }),
          universeCoverage("CNQ.TO", {
            status: "UNAVAILABLE",
            dataReadiness: "UNAVAILABLE",
            reasons: ["Average volume below minimum"],
          }),
        ],
      }),
    }),
    candidates: parse(C.candidateListSchema, {
      candidates: healthyCandidates,
    }),
    candidateDetails: Object.fromEntries(
      HEALTHY_SYMBOLS.map((symbol) => [symbol, candidateDetail(symbol)]),
    ),
    contexts: parse(C.contextEvaluationListSchema, { contexts: [] }),
    alerts: parse(C.alertListSchema, {
      alerts: [
        makeAlert({ symbol: "TD.TO" }),
        makeAlert({
          symbol: "RY.TO",
          type: "INVALIDATION",
          timestamp: iso(-150_000),
          previousState: "READY",
          state: "INVALIDATED",
          score: 41,
          title: "Setup invalidated",
          message: "Lost VWAP before the entry window closed.",
          reasonCodes: ["VWAP_LOST"],
        }),
      ],
    }),
    alertPolicy: DEFAULT_ALERT_POLICY,
    backtests: parse(C.backtestRunListSchema, { runs: [backtestRun()] }),
    profiles: parse(C.scannerProfileListSchema, {
      profiles: [
        scannerProfile(),
        scannerProfile({
          id: SECOND_PROFILE_ID,
          name: "Bull Flag",
          strategyDefinitionId: SECOND_STRATEGY_DEFINITION_ID,
          strategyKey: "BULL_FLAG",
          configId: "10000000-0000-4000-8000-000000000098",
          configVersion: "profile-bull-flag-v1",
          enabled: false,
          qualification: "PAPER_QUALIFIED",
          qualificationReason: "Qualified on retained paper evidence.",
          displayOrder: 1,
        }),
      ],
    }),
    strategies: parse(C.strategyDefinitionListSchema, {
      strategies: [
        strategyDefinition(),
        strategyDefinition({
          id: SECOND_STRATEGY_DEFINITION_ID,
          strategyKey: "BULL_FLAG",
          name: "Bull flag",
          description: "Flagpole, consolidation, and breakout continuation.",
        }),
      ],
    }),
    profileHistories: Object.fromEntries(
      [
        scannerProfile(),
        scannerProfile({
          id: SECOND_PROFILE_ID,
          name: "Bull Flag",
          strategyDefinitionId: SECOND_STRATEGY_DEFINITION_ID,
          strategyKey: "BULL_FLAG",
          configId: "10000000-0000-4000-8000-000000000098",
          configVersion: "profile-bull-flag-v1",
          enabled: false,
          qualification: "PAPER_QUALIFIED",
          displayOrder: 1,
        }),
      ].map((profile) => [profile.id, profileHistory(profile)]),
    ),
    comparison: profileComparison(),
    activePredictions: parse(C.activeStatisticalPredictionsSchema, {
      models: [],
    }),
    discovery: {
      status: discoveryStatus({
        scheduler: "IDLE",
        lastRun: discoveryRun({ status: "COMPLETED" }),
        parity: {
          marketId: CA,
          latestAudit: {
            id: "00000000-0000-4000-8000-000000000003",
            marketId: CA,
            tradingDate: date(-1),
            runId: DISCOVERY_RUN_ID,
            auditedAt: iso(-3_000_000),
            tradingViewCount: 25,
            questradePassCount: 22,
            overlapCount: 20,
            overlapRatio: 0.8,
            overlapSymbols: ["TD.TO"],
            missedMovers: [],
            questradeOnly: [],
            metricDifferences: [],
            discrepancySummary: {
              FORMULA_DIFFERENCE: 0,
              FORMING_VS_COMPLETED_BAR: 0,
              VOLUME_COVERAGE: 0,
              TIMESTAMP_LAG: 0,
              CORPORATE_ACTION: 0,
              CLASSIFICATION_MISMATCH: 0,
              THRESHOLD_BOUNDARY: 0,
              OTHER: 0,
            },
          },
          auditCount: 3,
          averageOverlapRatio: 0.82,
          lastAuditedAt: iso(-3_000_000),
        },
      }),
      runs: parse(C.discoveryRunListSchema, {
        runs: [discoveryRun({ status: "COMPLETED" })],
        nextBefore: null,
      }),
      evaluations: parse(C.discoveryEvidenceListSchema, {
        evaluations: [discoveryEvaluation()],
        nextAfter: null,
      }),
    },
    bot: {
      aggregates: parse(C.paperCohortAggregateListSchema, {
        aggregates: [aggregate()],
      }),
      today: parse(C.paperCohortAggregateListSchema, {
        aggregates: [aggregate({ openExecutions: 1 })],
      }),
      curves: parse(C.paperCohortCurveListSchema, { points: [] }),
      divergences: parse(C.paperModelDivergenceListSchema, { divergences: [] }),
      comparisons: parse(C.paperEvidenceComparisonListSchema, {
        comparisons: [],
      }),
      runs: parse(C.paperBotRunListSchema, { runs: [paperRun()] }),
      qualifications: parse(C.paperProfileQualificationListSchema, {
        qualifications: [],
      }),
      coordination: { summary: coordinationSummary() },
      decisions: parse(C.paperCoordinationDecisionListSchema, {
        decisions: [coordinationDecision()],
      }),
      todayCoordination: {
        summary: coordinationSummary({
          policyVersions: ["paper-coordination-v2"],
        }),
      },
      activities: parse(C.paperBotActivityListSchema, {
        activities: [
          activity({
            id: "10000000-0000-4000-8000-000000000401",
            occurredAt: iso(-3_400_000),
            eventType: "RUN_COMPLETED",
            severity: "SUCCESS",
            message:
              "Paper bot completed the live run with 19 READY signal observation(s) and 38 execution record(s).",
          }),
          activity({
            id: "10000000-0000-4000-8000-000000000402",
            occurredAt: iso(-3_520_000),
            eventType: "EXECUTION_CLOSED",
            symbol: "TD.TO",
            strategyKey: "PRIOR_DAY_HIGH_BREAKOUT",
            model: "QUOTE",
            message:
              "QUOTE paper position for TD.TO closed at 7.94 via TARGET; net P&L +9.00, R multiple 0.60.",
          }),
          activity({
            id: "10000000-0000-4000-8000-000000000403",
            occurredAt: iso(-3_560_000),
            eventType: "EXECUTION_OPENED",
            symbol: "TD.TO",
            strategyKey: "PRIOR_DAY_HIGH_BREAKOUT",
            model: "QUOTE",
            message:
              "QUOTE paper position for TD.TO opened at 7.85; stop 7.70, target 8.05.",
          }),
          activity({
            id: "10000000-0000-4000-8000-000000000404",
            occurredAt: iso(-3_600_000),
            eventType: "SIGNAL_ELIGIBLE",
            symbol: "TD.TO",
            strategyKey: "PRIOR_DAY_HIGH_BREAKOUT",
            model: "QUOTE",
            message: "READY signal for TD.TO · PRIOR DAY HIGH BREAKOUT.",
          }),
          activity({
            id: "10000000-0000-4000-8000-000000000405",
            occurredAt: iso(-3_620_000),
            eventType: "RUN_STARTED",
            message: "Paper bot started today's live run.",
          }),
        ],
      }),
      journal: paperTradeJournal(),
      performance: paperPerformanceCurve(),
      fundedAccount: fundedLiveAccount(),
    },
    learning: {
      overview: learningOverview({
        evidenceReadiness: [
          {
            cohort: evidenceCohort("config-v7", 120),
            closedQuoteCount: 120,
            threshold: 200,
            progressPct: 60,
            newOutcomesSinceLastDataset: 120,
            newOutcomeThreshold: 50,
            qualifies: false,
            disqualificationReason: "INSUFFICIENT_CLOSED_QUOTES (120 < 200)",
          },
          {
            cohort: evidenceCohort("config-v8", 200),
            closedQuoteCount: 200,
            threshold: 200,
            progressPct: 100,
            newOutcomesSinceLastDataset: 60,
            newOutcomeThreshold: 50,
            qualifies: true,
            disqualificationReason: null,
          },
        ],
        lifecycle: { datasetsCount: 1, modelsCount: 1, activeModelsCount: 0 },
        forwardMonitoring: [
          {
            modelId: MODEL_ID,
            modelVersion: "model-v2",
            strategy: "ORB_RETEST",
            predictions: 12,
            closedOutcomes: 8,
            positives: 5,
            observedWinRate: 0.625,
            averagePredictedProbability: 0.58,
            brierScore: 0.21,
            firstPredictionAt: iso(-5 * 86_400_000),
            lastPredictionAt: iso(-3_600_000),
          },
        ],
        shadowExperiments: {
          policyVersion: "paper-coordination-v4-shadow",
          comparatorPolicyVersion: "paper-coordination-v3",
          decisionsEvaluated: 18,
          selectionChangesCount: 2,
          selectionChangeRate: 2 / 18,
          differenceReasons: { POST_STOP_COOLDOWN: 2 },
          hypotheticalNetPnl: 41.25,
          primaryNetPnl: 24.5,
          hypotheticalCumulativeR: 0.9,
          primaryCumulativeR: 0.5,
        },
      }),
      runs: parse(C.learningAutomationRunListSchema, {
        runs: [
          learningRun("SUCCESS", {
            cohortsExamined: [
              {
                strategy: "ORB_RETEST",
                closedQuoteCount: 200,
                qualifies: true,
              },
            ],
            createdDatasetId: DATASET_ID,
            createdJobId: "66666666-6666-4666-8666-666666666666",
          }),
          learningRun("NOOP", {
            id: "55555555-5555-4555-8555-555555555556",
            startedAt: iso(-42 * 3_600_000),
            completedAt: iso(-42 * 3_600_000 + 4_000),
            createdAt: iso(-42 * 3_600_000 - 1_000),
            noopReason: "INSUFFICIENT_CLOSED_QUOTES",
            cohortsExamined: [
              {
                strategy: "ORB_RETEST",
                closedQuoteCount: 120,
                reason: "INSUFFICIENT_CLOSED_QUOTES",
              },
            ],
          }),
        ],
      }),
      decisions: parse(C.paperCoordinationDecisionListSchema, {
        decisions: [coordinationDecision()],
      }),
      models: parse(C.statisticalModelListSchema, {
        models: [statisticalModel()],
      }),
      stages: parse(C.evidenceAutomationResponseSchema, {
        stages: [
          evidenceStage("COVERAGE", "SUCCEEDED", { reportId: HASH }),
          evidenceStage("QUALIFICATION", "RUNNING", {
            progress: { completed: 3, total: 5, unit: "sessions" },
          }),
          evidenceStage("TRAINING", "WAITING"),
          evidenceStage("STUDY", "WAITING"),
          evidenceStage("FORWARD_OBSERVATION", "RUNNING", {
            progress: { completed: 8, total: 20, unit: "outcomes" },
          }),
          evidenceStage("DIAGNOSTICS", "NO_NEW_EVIDENCE"),
        ],
      }),
      experiments: parse(C.challengerExperimentListSchema, {
        experiments: [CHALLENGER_EXPERIMENT],
      }),
      report: parse(C.challengerExperimentDetailSchema, {
        experiment: CHALLENGER_EXPERIMENT,
        report: CHALLENGER_REPORT,
      }),
      calibrations: parse(C.calibrationRunListSchema, {
        calibrations: [calibrationRun()],
      }),
    },
    backtestsView: {
      automation: backtestAutomationStatus({
        interventionRequired: false,
        lastCycle: {
          cycleId: "30000000-0000-4000-8000-000000000001",
          marketId: CA,
          triggerOrigin: "SCHEDULED_CATCH_UP",
          outcome: "CHANGED",
          startedAt: iso(-3_660_000),
          finishedAt: iso(-3_600_000),
          evaluated: 8,
          dispatched: 1,
          coalesced: 0,
          blocked: 0,
          retried: 0,
          succeeded: 0,
          failed: 0,
          changes: ["ORB Standard: dispatched new replay for 2026-09-10"],
        },
        works: [running, succeeded],
        stages: [automationStage()],
        outstandingWork: 1,
        oldestOutstandingAt: iso(-25 * 60_000),
        lastSuccessAt: succeeded.lastSuccessAt,
        lastSuccessDurationMs: succeeded.runDurationMs,
        lastSuccessEvaluatedThrough: succeeded.evaluatedThrough,
      }),
      fundedPolicies: parse(C.fundedHistoricalAutomationPolicyListSchema, {
        policies: [fundedPolicy()],
      }),
      fundedReplays: parse(C.fundedHistoricalReplayListSchema, {
        marketId: CA,
        runs: [FUNDED_REPLAY],
      }),
      studies: { studies: [] },
      authorizations: { authorizations: [] },
      capturedHistory: CAPTURED_HISTORY,
    },
  };
}

function waitingSet() {
  return {
    usEnabled: false,
    system: systemStatus({
      operational: {
        actionable: false,
        reasonCodes: ["MARKET_CLOSED", "WAITING_FOR_CANDIDATES"],
        session: { marketStatus: "CLOSED", phase: "CLOSED" },
        dataFreshness: {
          quoteAgeMs: 600_000,
          candleAgeMs: 600_000,
          benchmarkAgeMs: 600_000,
          evaluationAgeMs: 600_000,
        },
      },
    }),
    market: marketStatus({
      state: "CLOSED",
      dataStatus: "DELAYED",
      lastQuoteAt: iso(-600_000),
      lastCandleAt: iso(-600_000),
      session: { marketStatus: "CLOSED", phase: "CLOSED" },
    }),
    universe: parse(C.universeResponseSchema, {
      instruments: [],
      automation: universeAutomation(HEALTHY_SYMBOLS, {
        candidateStatuses: [],
        configuredSymbols: HEALTHY_SYMBOLS,
      }),
    }),
    candidates: parse(C.candidateListSchema, { candidates: [] }),
    contexts: parse(C.contextEvaluationListSchema, { contexts: [] }),
    alerts: parse(C.alertListSchema, { alerts: [] }),
    alertPolicy: DEFAULT_ALERT_POLICY,
    backtests: parse(C.backtestRunListSchema, { runs: [] }),
    profiles: parse(C.scannerProfileListSchema, { profiles: [] }),
    strategies: parse(C.strategyDefinitionListSchema, { strategies: [] }),
    activePredictions: parse(C.activeStatisticalPredictionsSchema, {
      models: [],
    }),
    discovery: {
      status: discoveryStatus({
        scheduler: "IDLE",
        lastRun: null,
        nextEvaluationAt: iso(6 * 3_600_000),
        catalog: {
          status: "UNAVAILABLE",
          source: "EODHD",
          tradingDate: null,
          fetchedAt: null,
          ageMs: null,
          rowCount: 0,
          admittedCount: 0,
          failure: null,
        },
        performance: {
          sampleCount: 0,
          lastCycleDurationMs: null,
          lastQueueLatencyMs: null,
          cycleP95Ms: null,
          queueP95Ms: null,
          requestUsage: { completed: 0, failed: 0, cancelled: 0, expired: 0 },
        },
      }),
      runs: parse(C.discoveryRunListSchema, { runs: [], nextBefore: null }),
      evaluations: parse(C.discoveryEvidenceListSchema, {
        evaluations: [],
        nextAfter: null,
      }),
    },
    bot: {
      aggregates: parse(C.paperCohortAggregateListSchema, { aggregates: [] }),
      today: parse(C.paperCohortAggregateListSchema, { aggregates: [] }),
      curves: parse(C.paperCohortCurveListSchema, { points: [] }),
      divergences: parse(C.paperModelDivergenceListSchema, { divergences: [] }),
      comparisons: parse(C.paperEvidenceComparisonListSchema, {
        comparisons: [],
      }),
      runs: parse(C.paperBotRunListSchema, { runs: [] }),
      qualifications: parse(C.paperProfileQualificationListSchema, {
        qualifications: [],
      }),
      coordination: {
        summary: coordinationSummary({
          policyVersions: [],
          decisions: 0,
          approved: 0,
          deferred: 0,
          rejected: 0,
          reasons: {},
          openPositions: 0,
          closedTrades: 0,
          wins: 0,
          winRate: { numerator: 0, denominator: 0, value: null },
          netPnl: 0,
          cumulativeR: 0,
          averageR: null,
          exitReasons: {},
          symbolsTraded: 0,
          repeatedSymbolEntries: 0,
        }),
      },
      decisions: parse(C.paperCoordinationDecisionListSchema, {
        decisions: [],
      }),
      todayCoordination: {
        summary: coordinationSummary({
          policyVersions: [],
          decisions: 0,
          approved: 0,
          deferred: 0,
          rejected: 0,
          reasons: {},
          openPositions: 0,
          closedTrades: 0,
          wins: 0,
          winRate: { numerator: 0, denominator: 0, value: null },
          netPnl: 0,
          cumulativeR: 0,
          averageR: null,
          exitReasons: {},
          symbolsTraded: 0,
          repeatedSymbolEntries: 0,
        }),
      },
      activities: parse(C.paperBotActivityListSchema, { activities: [] }),
    },
    learning: {
      overview: learningOverview({
        pipelineHealth: {
          schedulerEnabled: true,
          scheduleDescription:
            "Daily at 5:00 p.m. Eastern, plus worker startup",
          schedulerPolicyVersion: "policy-v1",
          lastCheckAt: null,
          nextCheckAt: iso(3_600_000),
          nextCheckIsEstimate: true,
          checkOverdue: false,
          lastState: null,
          lastNoopReason: null,
          activeJobs: 0,
          durableErrors: 0,
          explanation: "Scheduler enabled; no eligibility check has run yet",
        },
      }),
      runs: parse(C.learningAutomationRunListSchema, { runs: [] }),
      decisions: parse(C.paperCoordinationDecisionListSchema, {
        decisions: [],
      }),
      models: parse(C.statisticalModelListSchema, { models: [] }),
      stages: parse(C.evidenceAutomationResponseSchema, { stages: [] }),
      experiments: parse(C.challengerExperimentListSchema, { experiments: [] }),
      report: null,
      calibrations: parse(C.calibrationRunListSchema, { calibrations: [] }),
    },
    backtestsView: {
      automation: backtestAutomationStatus({
        enabled: true,
        nextCheckAt: iso(18 * 3_600_000),
        works: [],
        stages: [],
        blockerCounts: [],
        lastCycle: null,
      }),
      fundedPolicies: parse(C.fundedHistoricalAutomationPolicyListSchema, {
        policies: [],
      }),
      fundedReplays: parse(C.fundedHistoricalReplayListSchema, {
        marketId: CA,
        runs: [],
      }),
      studies: { studies: [] },
      authorizations: { authorizations: [] },
      capturedHistory: CAPTURED_HISTORY,
    },
  };
}

function failureSet() {
  const failedWork = automationWork({
    workKey: "2".repeat(64),
    configId: "10000000-0000-4000-8000-000000000011",
    configName: "VWAP Hold",
    configVersion: "profile-vwap-hold-v1",
    strategyKey: "VWAP_HOLD",
    state: "FAILED",
    blockerReason: null,
    jobId: "50000000-0000-4000-8000-000000000002",
    jobStatus: "FAILED",
    runId: null,
    lastSuccessAt: null,
    lastFailureAt: iso(-3_600_000),
    runDurationMs: null,
    failureMessage: "Replay failed: captured quote gap for session 2026-09-10",
  });
  return {
    usEnabled: false,
    system: systemStatus({
      status: "degraded",
      checks: {
        database: { status: "ok" },
        scanner: { status: "ok" },
        config: { status: "ok" },
        marketData: { status: "error", detail: "quote feed delayed" },
      },
      operational: {
        actionable: false,
        operationalReady: false,
        reasonCodes: ["DATA_STALE"],
        dataFreshness: {
          quoteAgeMs: 95_000,
          candleAgeMs: 120_000,
          benchmarkAgeMs: 95_000,
          evaluationAgeMs: 95_000,
        },
      },
    }),
    market: marketStatus({
      state: "DEGRADED",
      dataStatus: "STALE",
      lastQuoteAt: iso(-95_000),
      lastError: "quote feed delayed for 3 symbols",
      paperBot: paperBotStatus({
        runId: SESSION_RUN_ID,
        sessionDate: date(),
        scheduledCloseAt: iso(3 * 3_600_000),
        executionModelVersion: "paper-execution-v7",
        openExecutions: 1,
        closePendingExecutions: 2,
        closedExecutions: 0,
        noFillExecutions: 1,
        reconciliationBacklog: 2,
        unreconcilableEvents: 1,
        overdueRuns: 1,
        abandonedExecutions: 0,
        lastTransitionAt: iso(-3_600_000),
        lastProcessingDurationMs: null,
        lastError: "funded recovery failed",
        lastSuccessfulProcessingAt: iso(-3_600_000),
        fundedProcessing: true,
        fundedLastSuccessfulProcessingAt: iso(-3_600_000),
        funded: {
          pendingFacts: 4,
          oldestPendingFactAgeMs: 60_000,
          closePendingOrders: 2,
          oldestClosePendingAgeMs: 90_000,
          riskVetoesTotal: 1,
          coverageGapsTotal: 2,
          recoveryFailuresTotal: 3,
          lastCycleLatencyMs: 480,
        },
      }),
    }),
    universe: parse(C.universeResponseSchema, {
      instruments: [],
      automation: universeAutomation(HEALTHY_SYMBOLS, {
        candidateStatuses: [],
        latestRun: universeRun({
          status: "FAILED",
          completedAt: null,
          eligibleCount: 0,
          activatedCount: 0,
          warnings: ["PARTIAL_COVERAGE"],
          error: "Market-data refresh timed out",
        }),
      }),
    }),
    candidates: parse(C.candidateListSchema, { candidates: [] }),
    contexts: parse(C.contextEvaluationListSchema, { contexts: [] }),
    alerts: parse(C.alertListSchema, { alerts: [] }),
    alertPolicy: DEFAULT_ALERT_POLICY,
    backtests: parse(C.backtestRunListSchema, { runs: [] }),
    profiles: parse(C.scannerProfileListSchema, { profiles: [] }),
    strategies: parse(C.strategyDefinitionListSchema, { strategies: [] }),
    activePredictions: parse(C.activeStatisticalPredictionsSchema, {
      models: [],
    }),
    discovery: {
      status: discoveryStatus({
        scheduler: "DEGRADED",
        lastError: "provider budget exhausted",
        lastRun: discoveryRun({
          status: "FAILED",
          coverage: {
            total: 100,
            pass: 0,
            fail: 0,
            unevaluable: 100,
            deferred: 0,
          },
          failure: "Catalog provider timed out",
          completedAt: iso(-3_500_000),
        }),
        catalog: {
          status: "LAST_GOOD",
          source: "EODHD",
          tradingDate: date(-2),
          fetchedAt: iso(-900_000),
          ageMs: 900_000,
          rowCount: 120,
          admittedCount: 100,
          failure: "PROVIDER_FAILURE",
        },
      }),
      runs: parse(C.discoveryRunListSchema, {
        runs: [
          discoveryRun({
            status: "FAILED",
            failure: "Catalog provider timed out",
          }),
        ],
        nextBefore: null,
      }),
      evaluations: parse(C.discoveryEvidenceListSchema, {
        evaluations: [
          discoveryEvaluation({
            result: {
              ...discoveryEvaluation().result,
              state: "UNEVALUABLE",
              reasons: ["QUOTE_STALE"],
            },
          }),
        ],
        nextAfter: null,
      }),
    },
    bot: {
      aggregates: parse(C.paperCohortAggregateListSchema, {
        aggregates: [
          aggregate({ openExecutions: 1, closePendingExecutions: 2 }),
        ],
      }),
      today: parse(C.paperCohortAggregateListSchema, { aggregates: [] }),
      curves: parse(C.paperCohortCurveListSchema, { points: [] }),
      divergences: parse(C.paperModelDivergenceListSchema, { divergences: [] }),
      comparisons: parse(C.paperEvidenceComparisonListSchema, {
        comparisons: [],
      }),
      runs: parse(C.paperBotRunListSchema, {
        runs: [
          paperRun({
            status: "FAILED",
            completedAt: null,
            failedAt: iso(-3_600_000),
            failureReason: "quote feed unavailable",
          }),
        ],
      }),
      qualifications: parse(C.paperProfileQualificationListSchema, {
        qualifications: [],
      }),
      coordination: { summary: coordinationSummary({ openPositions: 1 }) },
      decisions: parse(C.paperCoordinationDecisionListSchema, {
        decisions: [coordinationDecision()],
      }),
      todayCoordination: { summary: coordinationSummary({ netPnl: -118.25 }) },
      activities: parse(C.paperBotActivityListSchema, {
        activities: [
          activity({
            eventType: "RUN_FAILED",
            severity: "ERROR",
            message: "Funded recovery failed for close-pending order.",
          }),
        ],
      }),
    },
    learning: {
      overview: learningOverview({
        pipelineHealth: {
          schedulerEnabled: true,
          scheduleDescription:
            "Daily at 5:00 p.m. Eastern, plus worker startup",
          schedulerPolicyVersion: "policy-v1",
          lastCheckAt: iso(-30 * 3_600_000),
          nextCheckAt: iso(-6 * 3_600_000),
          nextCheckIsEstimate: true,
          checkOverdue: true,
          lastState: "FAILED",
          lastNoopReason: null,
          activeJobs: 0,
          durableErrors: 1,
          explanation: "Scheduler failed during the qualification pass",
        },
      }),
      runs: parse(C.learningAutomationRunListSchema, {
        runs: [
          learningRun("FAILED", {
            error: "Qualification query timed out",
            cohortsExamined: [],
          }),
        ],
      }),
      decisions: parse(C.paperCoordinationDecisionListSchema, {
        decisions: [],
      }),
      models: parse(C.statisticalModelListSchema, { models: [] }),
      stages: parse(C.evidenceAutomationResponseSchema, {
        stages: [
          evidenceStage("COVERAGE", "SUCCEEDED", { reportId: HASH }),
          evidenceStage("QUALIFICATION", "FAILED", {
            reasonCodes: ["JOB_FAILED"],
            lastSuccessAt: null,
            nextAction: {
              kind: "USER_REVIEW",
              label: "Review the failed qualification work",
            },
          }),
          evidenceStage("TRAINING", "WAITING"),
          evidenceStage("STUDY", "WAITING"),
          evidenceStage("FORWARD_OBSERVATION", "WAITING"),
          evidenceStage("DIAGNOSTICS", "FAILED", {
            reasonCodes: ["JOB_FAILED"],
            lastSuccessAt: null,
            nextAction: {
              kind: "USER_REVIEW",
              label: "Review the failed diagnostics work",
            },
          }),
        ],
      }),
      experiments: parse(C.challengerExperimentListSchema, { experiments: [] }),
      report: null,
      calibrations: parse(C.calibrationRunListSchema, { calibrations: [] }),
    },
    backtestsView: {
      automation: backtestAutomationStatus({
        enabled: false,
        nextCheckAt: null,
        works: [failedWork],
        stages: [],
        outstandingWork: 1,
        oldestOutstandingAt: iso(-3_600_000),
        lastSuccessAt: null,
        lastSuccessDurationMs: null,
        lastSuccessEvaluatedThrough: null,
        retryScheduled: 0,
        blockerCounts: [],
      }),
      fundedPolicies: parse(C.fundedHistoricalAutomationPolicyListSchema, {
        policies: [],
      }),
      fundedReplays: parse(C.fundedHistoricalReplayListSchema, {
        marketId: CA,
        runs: [],
      }),
      studies: { studies: [] },
      authorizations: { authorizations: [] },
      capturedHistory: CAPTURED_HISTORY,
    },
  };
}

function emptySet() {
  const zeroSummary = coordinationSummary({
    policyVersions: [],
    decisions: 0,
    approved: 0,
    deferred: 0,
    rejected: 0,
    reasons: {},
    openPositions: 0,
    closedTrades: 0,
    wins: 0,
    winRate: { numerator: 0, denominator: 0, value: null },
    netPnl: 0,
    cumulativeR: 0,
    averageR: null,
    exitReasons: {},
    symbolsTraded: 0,
    repeatedSymbolEntries: 0,
  });
  return {
    usEnabled: false,
    system: systemStatus({
      operational: {
        actionable: true,
        reasonCodes: ["EMPTY_UNIVERSE"],
        universe: { configured: 0, resolved: 0, evaluated: 0 },
      },
    }),
    market: marketStatus({
      instrumentCount: 0,
      featureSnapshotCount: 0,
      contextEvaluationCount: 0,
      benchmarkCount: 0,
      paperBot: paperBotStatus(),
    }),
    universe: parse(C.universeResponseSchema, {
      instruments: [],
      automation: universeAutomation([], {
        candidateStatuses: [],
        watchlistDate: date(),
      }),
    }),
    candidates: parse(C.candidateListSchema, { candidates: [] }),
    contexts: parse(C.contextEvaluationListSchema, { contexts: [] }),
    alerts: parse(C.alertListSchema, { alerts: [] }),
    alertPolicy: DEFAULT_ALERT_POLICY,
    backtests: parse(C.backtestRunListSchema, { runs: [] }),
    profiles: parse(C.scannerProfileListSchema, { profiles: [] }),
    strategies: parse(C.strategyDefinitionListSchema, { strategies: [] }),
    activePredictions: parse(C.activeStatisticalPredictionsSchema, {
      models: [],
    }),
    discovery: {
      status: discoveryStatus({
        mode: "OFF",
        scheduler: "OFF",
        lastRun: null,
        nextEvaluationAt: null,
        catalog: {
          status: "UNKNOWN",
          source: "EODHD",
          tradingDate: null,
          fetchedAt: null,
          ageMs: null,
          rowCount: 0,
          admittedCount: 0,
          failure: null,
        },
        performance: {
          sampleCount: 0,
          lastCycleDurationMs: null,
          lastQueueLatencyMs: null,
          cycleP95Ms: null,
          queueP95Ms: null,
          requestUsage: { completed: 0, failed: 0, cancelled: 0, expired: 0 },
        },
      }),
      runs: parse(C.discoveryRunListSchema, { runs: [], nextBefore: null }),
      evaluations: parse(C.discoveryEvidenceListSchema, {
        evaluations: [],
        nextAfter: null,
      }),
    },
    bot: {
      aggregates: parse(C.paperCohortAggregateListSchema, { aggregates: [] }),
      today: parse(C.paperCohortAggregateListSchema, { aggregates: [] }),
      curves: parse(C.paperCohortCurveListSchema, { points: [] }),
      divergences: parse(C.paperModelDivergenceListSchema, { divergences: [] }),
      comparisons: parse(C.paperEvidenceComparisonListSchema, {
        comparisons: [],
      }),
      runs: parse(C.paperBotRunListSchema, { runs: [] }),
      qualifications: parse(C.paperProfileQualificationListSchema, {
        qualifications: [],
      }),
      coordination: { summary: zeroSummary },
      decisions: parse(C.paperCoordinationDecisionListSchema, {
        decisions: [],
      }),
      todayCoordination: { summary: zeroSummary },
      activities: parse(C.paperBotActivityListSchema, { activities: [] }),
    },
    learning: {
      overview: learningOverview({
        pipelineHealth: {
          schedulerEnabled: false,
          scheduleDescription:
            "Daily at 5:00 p.m. Eastern, plus worker startup",
          schedulerPolicyVersion: "policy-v1",
          lastCheckAt: null,
          nextCheckAt: null,
          nextCheckIsEstimate: false,
          checkOverdue: false,
          lastState: null,
          lastNoopReason: null,
          activeJobs: 0,
          durableErrors: 0,
          explanation:
            "No completed live runs yet. Collection begins with the first session.",
        },
      }),
      runs: parse(C.learningAutomationRunListSchema, { runs: [] }),
      decisions: parse(C.paperCoordinationDecisionListSchema, {
        decisions: [],
      }),
      models: parse(C.statisticalModelListSchema, { models: [] }),
      stages: parse(C.evidenceAutomationResponseSchema, { stages: [] }),
      experiments: parse(C.challengerExperimentListSchema, { experiments: [] }),
      report: null,
      calibrations: parse(C.calibrationRunListSchema, { calibrations: [] }),
    },
    backtestsView: {
      automation: backtestAutomationStatus({
        enabled: false,
        nextCheckAt: null,
        works: [],
        stages: [],
        blockerCounts: [],
        lastCycle: null,
      }),
      fundedPolicies: parse(C.fundedHistoricalAutomationPolicyListSchema, {
        policies: [],
      }),
      fundedReplays: parse(C.fundedHistoricalReplayListSchema, {
        marketId: CA,
        runs: [],
      }),
      studies: { studies: [] },
      authorizations: { authorizations: [] },
      capturedHistory: CAPTURED_HISTORY,
    },
  };
}

const SCENARIO_BUILDERS = {
  healthy: healthySet,
  waiting: waitingSet,
  failure: failureSet,
  empty: emptySet,
};

export const SCENARIOS = Object.keys(SCENARIO_BUILDERS);

export function fixtureSet(name) {
  const builder = SCENARIO_BUILDERS[name];
  if (!builder) throw new Error(`Unknown scenario: ${name}`);
  return builder();
}

/**
 * Resolve an API request for the active scenario.
 * `pathname` has no query string; `searchParams` is a URLSearchParams.
 */
export function resolveRequest(name, pathname, searchParams) {
  const set = fixtureSet(name);
  const marketId = searchParams.get("marketId") ?? CA;
  const usScoped = marketId === US;
  if (usScoped && !set.usEnabled) {
    return {
      status: 409,
      body: {
        error: "Market runtime is not enabled in this visual fixture",
        code: "MARKET_RUNTIME_DISABLED",
      },
    };
  }

  const json = (body) => ({ status: 200, body });

  if (pathname === "/api/system/status") {
    if (!usScoped) return json(set.system);
    return json({
      ...set.system,
      operational: {
        ...set.system.operational,
        universe: { configured: 50, resolved: 50, evaluated: 50 },
      },
    });
  }
  if (pathname === "/api/market/status") {
    if (!usScoped) return json(set.market);
    return json(
      marketStatus({
        ...set.market,
        instrumentCount: 50,
        featureSnapshotCount: 50,
        contextEvaluationCount: 50,
      }),
    );
  }

  if (pathname === "/api/universe") return json(set.universe);
  if (pathname === "/api/universe/runs") {
    const latest = set.universe.automation.latestRun;
    return json({ runs: latest ? [latest] : [] });
  }
  if (pathname === "/api/candidates") return json(set.candidates);
  if (pathname.startsWith("/api/candidates/")) {
    if (name === "failure")
      return {
        status: 503,
        body: { error: "Candidate detail is temporarily unavailable" },
      };
    const symbol = decodeURIComponent(
      pathname.slice("/api/candidates/".length),
    );
    const detail = set.candidateDetails?.[symbol];
    if (detail) return json(detail);
    return {
      status: 404,
      body: { error: `No candidate detail for ${symbol}` },
    };
  }
  if (pathname === "/api/contexts") return json(set.contexts);
  if (pathname === "/api/alerts") return json(set.alerts);
  if (pathname === "/api/alerts/policy") return json(set.alertPolicy);
  if (pathname === "/api/backtests") return json(set.backtests);
  if (pathname.startsWith("/api/backtests/")) {
    const id = pathname.slice("/api/backtests/".length);
    const run = set.backtests.runs.find((value) => value.id === id);
    if (run) return json(run);
    return { status: 404, body: { error: `No backtest run ${id}` } };
  }
  if (pathname === "/api/scanner-profiles") return json(set.profiles);
  if (
    pathname.startsWith("/api/scanner-profiles/") &&
    pathname.endsWith("/configs")
  ) {
    const id = pathname.slice(
      "/api/scanner-profiles/".length,
      -"/configs".length,
    );
    const history = set.profileHistories?.[id];
    if (history) return json(history);
    return { status: 404, body: { error: `No config history for ${id}` } };
  }
  if (pathname === "/api/comparisons") return json(set.comparison);
  if (pathname === "/api/strategies") return json(set.strategies);
  if (pathname === "/api/statistical-models/active/predictions")
    return json(set.activePredictions);

  if (pathname === "/api/discovery/status") return json(set.discovery.status);
  if (pathname === "/api/discovery/runs") return json(set.discovery.runs);
  if (pathname === "/api/discovery/evaluations")
    return json(set.discovery.evaluations);

  if (pathname === "/api/paper-bot/aggregates") {
    const isToday = searchParams.has("startDate");
    return json(isToday ? set.bot.today : set.bot.aggregates);
  }
  if (pathname === "/api/paper-bot/curves") return json(set.bot.curves);
  if (pathname === "/api/paper-bot/divergences")
    return json(set.bot.divergences);
  if (pathname === "/api/paper-bot/comparisons")
    return json(set.bot.comparisons);
  if (pathname === "/api/paper-bot/runs") return json(set.bot.runs);
  if (pathname === "/api/paper-bot/qualifications")
    return json(set.bot.qualifications);
  if (pathname === "/api/paper-bot/coordination/summary") {
    const isToday = searchParams.has("startDate");
    return json(isToday ? set.bot.todayCoordination : set.bot.coordination);
  }
  if (pathname === "/api/paper-bot/coordination/decisions")
    return json(set.bot.decisions);
  if (pathname === "/api/paper-bot/activities") return json(set.bot.activities);
  if (pathname === "/api/paper-bot/journal") {
    const projection = searchParams.get("projection") ?? "COORDINATED";
    if (set.bot.journal) return json({ ...set.bot.journal, projection });
    if (name === "failure")
      return { status: 404, body: { error: "Journal unavailable" } };
    return json(emptyTradeJournal(projection));
  }
  if (pathname === "/api/paper-bot/performance") {
    if (set.bot.performance) {
      const account = searchParams.get("account") ?? "COORDINATED";
      return json({ ...set.bot.performance, account });
    }
    return json({
      account: searchParams.get("account") ?? "COORDINATED",
      marketId: CA,
      currency: "CAD",
      granularity: "DAY",
      startDate: searchParams.get("startDate") ?? date(-3),
      endDate: searchParams.get("endDate") ?? date(),
      points: [],
      warnings: [],
    });
  }

  if (pathname === "/api/paper-bot/funded-account") {
    if (set.bot.fundedAccount)
      return json({
        status: "READY",
        account: {
          ...set.bot.fundedAccount.account,
          marketId,
          currency: usScoped ? "USD" : "CAD",
        },
      });
    return json({
      status: "UNAVAILABLE",
      marketId,
      currency: usScoped ? "USD" : "CAD",
      reason: "NO_LIVE_FUNDED_RUN",
    });
  }

  if (pathname === "/api/learning/overview") return json(set.learning.overview);
  if (pathname === "/api/learning/automation-runs")
    return json(set.learning.runs);
  if (pathname === "/api/learning/coordination-decisions")
    return json(set.learning.decisions);
  if (pathname === "/api/statistical-models") return json(set.learning.models);
  if (pathname === "/api/learning/evidence-automation")
    return json(set.learning.stages);
  if (pathname === "/api/challenger-experiments")
    return json(set.learning.experiments);
  if (pathname.startsWith("/api/challenger-experiments/")) {
    if (set.learning.report) return json(set.learning.report);
    return { status: 404, body: { error: "Challenger report unavailable" } };
  }
  if (pathname === "/api/calibrations") return json(set.learning.calibrations);
  if (pathname === "/api/learning/evidence-artifacts/")
    return { status: 404, body: { error: "Artifact unavailable in fixture" } };

  if (pathname === "/api/backtest-automation/status")
    return json(set.backtestsView.automation);
  if (pathname === "/api/funded-historical-policies")
    return json(set.backtestsView.fundedPolicies);
  if (pathname.startsWith("/api/funded-historical-policies/"))
    return json(set.backtestsView.fundedPolicies.policies[0] ?? {});
  if (pathname === "/api/funded-replays")
    return json(set.backtestsView.fundedReplays);
  if (pathname === "/api/strategy-studies")
    return json(set.backtestsView.studies);
  if (pathname === "/api/strategy-studies/authorizations")
    return json(set.backtestsView.authorizations);
  if (pathname === "/api/captured-history/availability")
    return json(set.backtestsView.capturedHistory);

  return { status: 404, body: { error: `No fixture for ${pathname}` } };
}

/**
 * Deterministic response for the Daily List paste form. The visual harness
 * submits a fixed paste so the accepted/normalized/unsupported report groups
 * render without depending on the request body.
 */
export function resolveUniversePaste(name) {
  const set = fixtureSet(name);
  const report = parse(C.candidatePasteReportSchema, {
    accepted: [
      {
        originalInput: "SHOP.TO",
        marketId: CA,
        normalizedSymbol: "SHOP.TO",
        reason: null,
      },
    ],
    normalized: [
      {
        originalInput: "TSX:RY",
        marketId: CA,
        normalizedSymbol: "RY.TO",
        reason: "Exchange prefix normalized to TSX",
      },
    ],
    duplicate: [
      {
        originalInput: "TD.TO",
        marketId: CA,
        normalizedSymbol: "TD.TO",
        reason: "Already on today's watchlist",
      },
    ],
    unsupported: [
      {
        originalInput: "BTC:USD",
        normalizedSymbol: null,
        reason: "Only equity symbols are supported",
      },
    ],
    failed: [],
  });
  return { status: 200, body: { ...set.universe, pasteReport: report } };
}

export { CA, US };
