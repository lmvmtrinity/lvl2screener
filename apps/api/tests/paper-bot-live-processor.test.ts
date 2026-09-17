import { describe, expect, it } from "vitest";
import type { StrategyStateEvent } from "@tsx-scanner/contracts";
import {
  PaperBotLiveProcessor,
  type ProfileLookup,
} from "../src/paper-bot/paper-bot-live-processor.js";
import type {
  InsertObservationInput,
  InsertObservationResult,
  PaperBotStore,
  PaperSignalObservation,
  ReadyEventReconciliationCandidate,
  StartRunInput,
} from "../src/paper-bot/paper-bot-repository.js";
import type { PaperExecutionStore } from "../src/paper-bot/paper-execution-repository.js";
import type {
  CandleExecutionState,
  QuoteExecutionState,
} from "../src/paper-bot/execution-core.js";
import type { OpenExecutionRow } from "../src/paper-bot/paper-execution-repository.js";
import type {
  AssumptionsSnapshot,
  CandleFact,
  QuoteFact,
} from "../src/paper-bot/types.js";

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 10,
  feePerTrade: 1,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 2,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
};

const readyEvent = (
  overrides: Partial<StrategyStateEvent> = {},
): StrategyStateEvent =>
  ({
    kind: "SETUP",
    eventId: "event-1",
    eventType: "STRATEGY_STATE_CHANGED",
    previousState: "FORMING",
    state: "READY",
    instrumentId: "instrument-1",
    symbol: "ABC",
    timestamp: "2026-08-25T14:00:00.000Z",
    profileId: "profile-1",
    profileName: "Bull Flag",
    strategy: "BULL_FLAG",
    strategyVersion: "1.0.0",
    configVersion: "v1",
    score: 85,
    setupScore: 85,
    scoreVersion: "v2",
    scoreComponents: {},
    scoreExplanation: [],
    setupInstanceId: "setup-1",
    reasonCodes: ["REALTIME_DATA"],
    entryReference: 10,
    stopReference: 9.5,
    targetReference: 11,
    estimatedRr: 2,
    featureSnapshot: { atr14: 0.25 },
    ...overrides,
  }) as unknown as StrategyStateEvent;

const quote = (overrides: Partial<QuoteFact> = {}): QuoteFact => ({
  timestamp: "2026-08-25T14:00:00.000Z",
  bid: 9.99,
  ask: Math.max(10, (overrides.bid ?? 9.99) + 0.01),
  bidSize: 500,
  askSize: 500,
  dataStatus: "REALTIME",
  actionable: true,
  ...overrides,
});

class FakePaperBotStore implements PaperBotStore {
  inserted: InsertObservationInput[] = [];
  settledRunIds: string[] = [];
  persistedCloseQuotes = new Map<string, QuoteFact[]>();
  /**
   * Reconciliation backlog. Mirrors the production query: a candidate whose
   * event already produced an observation is no longer returned, so the
   * processor's bounded drain loop converges instead of reprocessing it.
   */
  unobserved: ReadyEventReconciliationCandidate[] = [];
  private observations = new Map<string, PaperSignalObservation>();
  private seq = 0;

  async startOrResumeLiveRun(input: StartRunInput) {
    return { id: "run-1", ...input } as never;
  }
  async listUnfinishedLiveRuns() {
    return [];
  }
  async findSessionCloseCandles() {
    return new Map();
  }
  async findSessionCloseQuotes() {
    return this.persistedCloseQuotes;
  }
  async startBacktestRun(input: StartRunInput) {
    return { id: "run-1", ...input } as never;
  }
  async completeRun() {}
  async failRun() {}
  async settleRunAfterCloseRequest(runId: string) {
    this.settledRunIds.push(runId);
    return "COMPLETED" as const;
  }

  async insertObservation(
    input: InsertObservationInput,
  ): Promise<InsertObservationResult> {
    this.inserted.push(input);
    const existing = [...this.observations.values()].find(
      (o) =>
        o.runId === input.runId &&
        ((input.setupInstanceId !== null &&
          o.profileConfigId === input.profileConfigId &&
          o.setupInstanceId === input.setupInstanceId) ||
          (input.setupInstanceId === null &&
            o.sourceEventId === input.sourceEventId)),
    );
    if (existing) return { observation: existing, created: false };
    const observation: PaperSignalObservation = {
      ...input,
      id: `obs-${++this.seq}`,
      marketId: "CA_TSX",
      createdAt: "now",
    };
    this.observations.set(observation.id, observation);
    return { observation, created: true };
  }

  async findObservationById(id: string) {
    return this.observations.get(id);
  }
  async findUnobservedReadyEvents(): Promise<
    ReadyEventReconciliationCandidate[]
  > {
    const observed = new Set(
      [...this.observations.values()].map((o) => o.sourceEventId),
    );
    return this.unobserved.filter(
      (candidate) => !observed.has(candidate.sourceEventId),
    );
  }
}

class FakePaperExecutionStore implements PaperExecutionStore {
  quoteCalls: Array<{ observationId: string; state: QuoteExecutionState }> = [];
  candleCalls: Array<{ observationId: string; state: CandleExecutionState }> =
    [];
  openRows: OpenExecutionRow[] = [];
  private initialized = new Set<string>();

  async insertInitialExecutions(
    observationId: string,
    quoteState: QuoteExecutionState,
    candleState: CandleExecutionState,
  ) {
    if (this.initialized.has(observationId)) return;
    this.initialized.add(observationId);
    this.quoteCalls.push({ observationId, state: quoteState });
    this.candleCalls.push({ observationId, state: candleState });
  }

  async upsertQuoteExecution(
    observationId: string,
    state: QuoteExecutionState,
  ) {
    this.quoteCalls.push({ observationId, state });
  }
  async upsertCandleExecution(
    observationId: string,
    state: CandleExecutionState,
  ) {
    this.candleCalls.push({ observationId, state });
  }
  async findOpenAndClosePending(runId: string) {
    expect(runId).toBe("run-1");
    return this.openRows;
  }
  async runHealth() {
    return {
      open: 0,
      closePending: 0,
      closed: 0,
      noFill: 0,
      rejectedEconomics: 0,
      abandoned: 0,
      lastTransitionAt: null,
    };
  }
  async abandonUnresolvedExecutions() {
    return 0;
  }
}

const profileLookup = (
  parameters: unknown = { scoreCutoff: 70 },
): ProfileLookup => ({
  getProfileConfig: async () => ({
    configId: "config-1",
    configVersion: "v1",
    parameters,
  }),
});

describe("PaperBotLiveProcessor", () => {
  it("ignores events that are not READY", async () => {
    const paperBotStore = new FakePaperBotStore();
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore: new FakePaperExecutionStore(),
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );
    await processor.processReadyEvent(
      readyEvent({ state: "FORMING" }),
      quote(),
    );
    expect(paperBotStore.inserted).toHaveLength(0);
  });

  it("observes an eligible READY event and opens quote and candle executions", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup({ scoreCutoff: 70 }),
        assumptions,
      },
      "run-1",
    );
    await processor.processReadyEvent(readyEvent(), quote());

    expect(paperBotStore.inserted[0]).toMatchObject({
      eligibilityStatus: "ELIGIBLE",
      eligibilityReason: null,
      profileConfigId: "config-1",
    });
    expect(paperExecutionStore.quoteCalls).toHaveLength(1);
    expect(paperExecutionStore.quoteCalls[0]?.state.status).toBe("OPEN");
    expect(paperExecutionStore.candleCalls).toHaveLength(1);
    expect(paperExecutionStore.candleCalls[0]?.state.status).toBe("OPEN");
  });

  it("resolves the exact configuration version carried by the persisted event", async () => {
    const calls: Array<[string, string]> = [];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore: new FakePaperBotStore(),
        paperExecutionStore: new FakePaperExecutionStore(),
        profiles: {
          getProfileConfig: async (profileId, configVersion) => {
            calls.push([profileId, configVersion]);
            return {
              configId: "historical-config",
              configVersion,
              parameters: { scoreCutoff: 70 },
            };
          },
        },
        assumptions,
      },
      "run-1",
    );

    await processor.processReadyEvent(
      readyEvent({ configVersion: "historical-v1" }),
      quote(),
    );
    expect(calls).toEqual([["profile-1", "historical-v1"]]);
  });

  it("skips an unprocessable candidate and still reconciles the rest of the batch", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.unobserved = [
      // An event whose persisted payload no longer parses. Before this was
      // isolated it threw out of the whole batch, and because the row is
      // never observed it returned every cycle -- halting evidence
      // collection permanently.
      {
        sourceEventId: "event-broken",
        event: null,
        parseError: "invalid previousState",
        sourceSignalId: "signal-0",
        quoteAtSignal: null,
      },
      {
        sourceEventId: "event-1",
        event: readyEvent(),
        parseError: null,
        sourceSignalId: "signal-1",
        quoteAtSignal: quote(),
      },
    ];
    const paperExecutionStore = new FakePaperExecutionStore();
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    const outcome = await processor.reconcileReadyEvents();

    // The unprocessable row is the only remaining backlog: the rest of the
    // batch was observed and the drain loop stopped on a zero-progress pass.
    expect(outcome.candidates).toBe(1);
    expect(outcome.processed).toBe(1);
    expect(outcome.skipped).toEqual([
      { sourceEventId: "event-broken", reason: "invalid previousState" },
    ]);
    expect(paperExecutionStore.quoteCalls).toHaveLength(1);
  });

  it("reconciles each persisted READY event with its captured decision-time quote", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.unobserved = [
      {
        sourceEventId: "event-1",
        event: readyEvent(),
        parseError: null,
        sourceSignalId: "signal-1",
        quoteAtSignal: quote(),
      },
    ];
    const paperExecutionStore = new FakePaperExecutionStore();
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    const result = await processor.reconcileReadyEvents();
    expect(result).toMatchObject({
      candidates: 0,
      processed: 1,
      skipped: [],
    });
    expect(result.eligibleObservations).toHaveLength(1);
    expect(paperExecutionStore.quoteCalls[0]?.state.status).toBe("OPEN");
  });

  it("writes one immutable shadow decision for all same-symbol candidates from a scan batch", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.unobserved = [
      {
        sourceEventId: "event-orb",
        event: readyEvent({
          eventId: "event-orb",
          setupInstanceId: "setup-orb",
          strategy: "ORB_RETEST",
          targetReference: 10.75,
        }),
        parseError: null,
        sourceSignalId: "signal-orb",
        quoteAtSignal: quote(),
      },
      {
        sourceEventId: "event-hod",
        event: readyEvent({
          eventId: "event-hod",
          setupInstanceId: "setup-hod",
          strategy: "HIGH_OF_DAY_BREAKOUT",
          targetReference: 11,
        }),
        parseError: null,
        sourceSignalId: "signal-hod",
        quoteAtSignal: quote(),
      },
    ];
    const decisions: unknown[] = [];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore: new FakePaperExecutionStore(),
        profiles: profileLookup(),
        assumptions,
        coordinationStore: {
          async recordDecision(input) {
            decisions.push(input);
            return { id: "decision-1", created: true };
          },
          async insertInitialQuotePosition() {},
          async findOpenPositions() {
            return [];
          },
          async updateQuotePosition() {},
          async stateForSymbol() {
            return {
              hasOpenSymbolPosition: false,
              lastStopAt: null,
              openPositionCount: 0,
              totalOpenRisk: 0,
              dailyRealizedLoss: 0,
              consecutiveStops: 0,
            };
          },
        },
      },
      "run-1",
    );

    await processor.reconcileReadyEvents();

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      symbol: "ABC",
      triggerObservationIds: ["obs-1", "obs-2"],
      decision: { selectedStrategyKey: "HIGH_OF_DAY_BREAKOUT" },
    });
  });

  it("sizes the approved coordinated position under portfolio exposure caps, leaving independent evidence unresized", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.unobserved = [
      {
        sourceEventId: "event-orb",
        event: readyEvent({
          eventId: "event-orb",
          setupInstanceId: "setup-orb",
          strategy: "ORB_RETEST",
        }),
        parseError: null,
        sourceSignalId: "signal-orb",
        quoteAtSignal: quote(),
      },
    ];
    const paperExecutionStore = new FakePaperExecutionStore();
    const positions: QuoteExecutionState[] = [];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
        coordinationStore: {
          async recordDecision() {
            return { id: "decision-1", created: true };
          },
          async insertInitialQuotePosition(_id, _observationId, state) {
            positions.push(state);
          },
          async findOpenPositions() {
            return [];
          },
          async updateQuotePosition() {},
          async stateForSymbol() {
            return {
              hasOpenSymbolPosition: false,
              lastStopAt: null,
              openPositionCount: 0,
              totalOpenRisk: 0,
              dailyRealizedLoss: 0,
              consecutiveStops: 0,
              sector: "Financial Services",
              openSymbolNotional: 0,
              openSectorNotional: 0,
              contexts: [],
            };
          },
        },
        coordinationPolicy: {
          cooldownMinutesAfterStop: 15,
          maxOpenPositions: 3,
          maxTotalOpenRisk: 1_000,
          maxDailyLoss: 1_000,
          maxConsecutiveStops: 3,
          maxSymbolNotional: 10_000,
          maxSectorNotional: 20_000,
        },
        coordinationSizing: { maxDisplayedSizeParticipation: 0.05 },
      },
      "run-1",
    );

    await processor.reconcileReadyEvents();

    const coordinated = positions[0];
    const independent = paperExecutionStore.quoteCalls[0]?.state;
    expect(coordinated?.status).toBe("OPEN");
    expect(independent?.status).toBe("OPEN");
    // 5% of the 500-share displayed ask size binds the coordinated size only.
    expect(
      coordinated?.status === "OPEN" ? coordinated.position.shares : null,
    ).toBe(25);
    expect(
      coordinated?.status === "OPEN"
        ? coordinated.sizing?.appliedCaps
        : undefined,
    ).toContain("DISPLAYED_SIZE_PARTICIPATION");
    expect(
      independent?.status === "OPEN" ? independent.position.shares : null,
    ).toBe(99);
  });

  it("recovers an approved coordination decision that is missing its position (F-01)", async () => {
    const paperBotStore = new FakePaperBotStore();
    await paperBotStore.insertObservation({
      runId: "run-1",
      sourceEventId: "event-orphan",
      sourceSignalId: "sig-orphan",
      setupInstanceId: "setup-orphan",
      instrumentId: "inst-1",
      symbol: "XYZ",
      profileId: "p1",
      profileName: "ORB",
      profileConfigId: "cfg1",
      configVersion: "v1",
      profileParameters: { scoreCutoff: 70 },
      strategyKey: "ORB_RETEST",
      strategyVersion: "1.0.0",
      signalTimestamp: "2026-08-25T14:00:00.000Z",
      score: 85,
      entryReference: 10,
      stopReference: 9.5,
      targetReference: 11,
      atr14: 0.25,
      featureSnapshot: {},
      reasonCodes: [],
      sourceEventPayload: {},
      eligibilityStatus: "ELIGIBLE",
      eligibilityReason: null,
    });

    const paperExecutionStore = new FakePaperExecutionStore();
    (
      paperExecutionStore as unknown as Record<string, unknown>
    ).findQuoteSnapshotForObservation = async () => quote();

    const insertedPositions: Array<{
      decisionId: string;
      observationId: string;
      state: QuoteExecutionState;
    }> = [];
    let orphanReturned = true;

    const coordinationStore = {
      async recordDecision() {
        return { id: "dec-1", created: true };
      },
      async insertInitialQuotePosition(
        decisionId: string,
        observationId: string,
        state: QuoteExecutionState,
      ) {
        insertedPositions.push({ decisionId, observationId, state });
      },
      async findOpenPositions() {
        return [];
      },
      async updateQuotePosition() {},
      async stateForSymbol() {
        return {
          hasOpenSymbolPosition: false,
          lastStopAt: null,
          openPositionCount: 0,
          totalOpenRisk: 0,
          dailyRealizedLoss: 0,
          consecutiveStops: 0,
        };
      },
      async findApprovedDecisionsWithoutPositions() {
        if (!orphanReturned) return [];
        orphanReturned = false;
        return [
          {
            id: "dec-orphan",
            runId: "run-1",
            symbol: "XYZ",
            decisionTimestamp: "2026-08-25T14:00:00.000Z",
            selectedObservationId: "obs-1",
            stateSnapshot: {
              hasOpenSymbolPosition: false,
              lastStopAt: null,
              openPositionCount: 0,
              totalOpenRisk: 0,
              dailyRealizedLoss: 0,
              consecutiveStops: 0,
            },
          },
        ];
      },
    };

    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
        coordinationStore,
      },
      "run-1",
    );

    const recoveredCount =
      await processor.recoverApprovedDecisionsWithoutPositions();
    expect(recoveredCount).toBe(1);
    expect(insertedPositions).toHaveLength(1);
    expect(insertedPositions[0]?.decisionId).toBe("dec-orphan");
    expect(insertedPositions[0]?.state.status).toBe("OPEN");

    // Second run should recover 0 (idempotent)
    const secondCount =
      await processor.recoverApprovedDecisionsWithoutPositions();
    expect(secondCount).toBe(0);
    expect(insertedPositions).toHaveLength(1);
  });

  it("does not skip position insertion when recordDecision returns created=false (F-01)", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.unobserved = [
      {
        sourceEventId: "event-existing-dec",
        event: readyEvent({
          eventId: "event-existing-dec",
          setupInstanceId: "setup-existing-dec",
          strategy: "ORB_RETEST",
        }),
        parseError: null,
        sourceSignalId: "signal-existing-dec",
        quoteAtSignal: quote(),
      },
    ];

    const insertedPositions: QuoteExecutionState[] = [];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore: new FakePaperExecutionStore(),
        profiles: profileLookup(),
        assumptions,
        coordinationStore: {
          async recordDecision() {
            // Simulate that the decision row was already persisted by a prior run
            return { id: "dec-pre-existing", created: false };
          },
          async insertInitialQuotePosition(_id, _obsId, state) {
            insertedPositions.push(state);
          },
          async findOpenPositions() {
            return [];
          },
          async updateQuotePosition() {},
          async stateForSymbol() {
            return {
              hasOpenSymbolPosition: false,
              lastStopAt: null,
              openPositionCount: 0,
              totalOpenRisk: 0,
              dailyRealizedLoss: 0,
              consecutiveStops: 0,
            };
          },
        },
      },
      "run-1",
    );

    await processor.reconcileReadyEvents();

    // Position must NOT have been dropped because created=false
    expect(insertedPositions).toHaveLength(1);
    expect(insertedPositions[0]?.status).toBe("OPEN");
  });

  it("processes backlog observations in strictly chronological order across different timestamps (F-06)", async () => {
    const paperBotStore = new FakePaperBotStore();
    // Two events provided in reverse chronological order
    paperBotStore.unobserved = [
      {
        sourceEventId: "ev-later",
        event: readyEvent({
          eventId: "ev-later",
          setupInstanceId: "setup-later",
          strategy: "ORB_RETEST",
          symbol: "XYZ",
          timestamp: "2026-08-25T14:10:00.000Z",
        }),
        parseError: null,
        sourceSignalId: "sig-later",
        quoteAtSignal: quote({ timestamp: "2026-08-25T14:10:00.000Z" }),
      },
      {
        sourceEventId: "ev-earlier",
        event: readyEvent({
          eventId: "ev-earlier",
          setupInstanceId: "setup-earlier",
          strategy: "ORB_RETEST",
          symbol: "ABC",
          timestamp: "2026-08-25T14:00:00.000Z",
        }),
        parseError: null,
        sourceSignalId: "sig-earlier",
        quoteAtSignal: quote({ timestamp: "2026-08-25T14:00:00.000Z" }),
      },
    ];

    const decisionOrder: Array<{ symbol: string; timestamp: string }> = [];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore: new FakePaperExecutionStore(),
        profiles: profileLookup(),
        assumptions,
        coordinationStore: {
          async recordDecision(input) {
            decisionOrder.push({
              symbol: input.symbol,
              timestamp: input.decisionTimestamp,
            });
            return { id: `dec-${input.symbol}`, created: true };
          },
          async insertInitialQuotePosition() {},
          async findOpenPositions() {
            return [];
          },
          async updateQuotePosition() {},
          async stateForSymbol() {
            return {
              hasOpenSymbolPosition: false,
              lastStopAt: null,
              openPositionCount: 0,
              totalOpenRisk: 0,
              dailyRealizedLoss: 0,
              consecutiveStops: 0,
            };
          },
        },
      },
      "run-1",
    );

    await processor.reconcileReadyEvents();

    expect(decisionOrder).toEqual([
      { symbol: "ABC", timestamp: "2026-08-25T14:00:00.000Z" },
      { symbol: "XYZ", timestamp: "2026-08-25T14:10:00.000Z" },
    ]);
  });

  it("prioritizes higher-ranking candidate over lower-ranking candidate on simultaneous signals at the same timestamp (F-06)", async () => {
    const paperBotStore = new FakePaperBotStore();
    // Two events at the same timestamp: A_SYM (lower R:R) and B_SYM (higher R:R)
    paperBotStore.unobserved = [
      {
        sourceEventId: "ev-a",
        event: readyEvent({
          eventId: "ev-a",
          setupInstanceId: "setup-a",
          strategy: "ORB_RETEST",
          symbol: "A_SYM",
          timestamp: "2026-08-25T14:00:00.000Z",
          entryReference: 10,
          stopReference: 9.0, // Risk = 1.0, Target = 11.5 => R:R = 1.5
          targetReference: 11.5,
          score: 70,
        }),
        parseError: null,
        sourceSignalId: "sig-a",
        quoteAtSignal: quote({ timestamp: "2026-08-25T14:00:00.000Z" }),
      },
      {
        sourceEventId: "ev-b",
        event: readyEvent({
          eventId: "ev-b",
          setupInstanceId: "setup-b",
          strategy: "ORB_RETEST",
          symbol: "B_SYM",
          timestamp: "2026-08-25T14:00:00.000Z",
          entryReference: 10,
          stopReference: 9.5, // Risk = 0.5, Target = 11.5 => R:R = 3.0
          targetReference: 11.5,
          score: 85,
        }),
        parseError: null,
        sourceSignalId: "sig-b",
        quoteAtSignal: quote({ timestamp: "2026-08-25T14:00:00.000Z" }),
      },
    ];

    let openCount = 0;
    const decisions: Array<{
      symbol: string;
      outcome: string;
      reason: string;
    }> = [];

    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore: new FakePaperExecutionStore(),
        profiles: profileLookup(),
        assumptions,
        coordinationPolicy: {
          maxOpenPositions: 1, // Capacity for only 1 position!
          maxTotalOpenRisk: 10_000,
          maxDailyLoss: 10_000,
          maxConsecutiveStops: 5,
          cooldownMinutesAfterStop: 15,
        },
        coordinationStore: {
          async recordDecision(input) {
            decisions.push({
              symbol: input.symbol,
              outcome: input.decision.outcome,
              reason: input.decision.reason,
            });
            if (input.decision.outcome === "APPROVED") {
              openCount += 1;
            }
            return { id: `dec-${input.symbol}`, created: true };
          },
          async insertInitialQuotePosition() {},
          async findOpenPositions() {
            return [];
          },
          async updateQuotePosition() {},
          async stateForSymbol() {
            return {
              hasOpenSymbolPosition: false,
              lastStopAt: null,
              openPositionCount: openCount,
              totalOpenRisk: 0,
              dailyRealizedLoss: 0,
              consecutiveStops: 0,
            };
          },
        },
      },
      "run-1",
    );

    await processor.reconcileReadyEvents();

    // B_SYM has R:R = 3.0 vs A_SYM R:R = 1.5.
    // Despite A_SYM being alphabetically earlier, B_SYM must be evaluated first!
    expect(decisions).toEqual([
      {
        symbol: "B_SYM",
        outcome: "APPROVED",
        reason: "SELECTED_PRIMARY",
      },
      {
        symbol: "A_SYM",
        outcome: "DEFERRED",
        reason: "MAX_CONCURRENT_POSITIONS",
      },
    ]);
  });

  it("observes a below-cutoff READY event but creates no executions", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup({ scoreCutoff: 90 }),
        assumptions,
      },
      "run-1",
    );
    await processor.processReadyEvent(readyEvent({ score: 85 }), quote());

    expect(paperBotStore.inserted[0]).toMatchObject({
      eligibilityStatus: "BELOW_SCORE_CUTOFF",
    });
    expect(paperExecutionStore.quoteCalls).toHaveLength(0);
    expect(paperExecutionStore.candleCalls).toHaveLength(0);
  });

  it("never resets an already-observed lifecycle's executions on a later cycle", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );
    const event = readyEvent();
    await processor.processReadyEvent(event, quote());
    await processor.processReadyEvent(
      event,
      quote({ timestamp: "2026-08-25T14:05:00.000Z" }),
    );

    expect(paperBotStore.inserted).toHaveLength(2);
    expect(paperExecutionStore.quoteCalls).toHaveLength(1);
    expect(paperExecutionStore.candleCalls).toHaveLength(1);
  });

  it("fails observably when an event's exact profile configuration cannot be resolved", async () => {
    const paperBotStore = new FakePaperBotStore();
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore: new FakePaperExecutionStore(),
        profiles: { getProfileConfig: async () => undefined },
        assumptions,
      },
      "run-1",
    );
    await expect(
      processor.processReadyEvent(readyEvent(), quote()),
    ).rejects.toThrow(
      "Profile configuration profile-1/v1 could not be resolved",
    );
    expect(paperBotStore.inserted).toHaveLength(0);
  });

  it("still creates an executable NO_FILL quote execution when the decision-time quote is missing", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );
    await processor.processReadyEvent(readyEvent(), null);
    expect(paperExecutionStore.quoteCalls[0]?.state).toMatchObject({
      status: "NO_FILL",
      noFillReason: "MISSING_QUOTE",
    });
    expect(paperExecutionStore.candleCalls[0]?.state.status).toBe("OPEN");
  });
});

const openQuoteRow = (
  overrides: Partial<OpenExecutionRow> = {},
): OpenExecutionRow => ({
  observationId: "obs-1",
  instrumentId: "instrument-1",
  model: "QUOTE",
  status: "OPEN",
  position: {
    entryPrice: 10.01,
    entryTime: "2026-08-25T14:00:00.000Z",
    stop: 9.5,
    target: 11,
    shares: 99,
    initialRisk: 50.49,
  },
  entryMarketSnapshot: {
    bid: 9.99,
    ask: 10,
    bidSize: 500,
    askSize: 500,
    spread: 0.01,
    quoteTimestamp: "2026-08-25T14:00:00.000Z",
    dataStatus: "REALTIME",
  },
  entrySizeCoverage: 500 / 99,
  lastFactTimestamp: "2026-08-25T14:00:00.000Z",
  ...overrides,
});

describe("PaperBotLiveProcessor.evaluateOpenQuoteExecutions", () => {
  it("closes an open execution whose instrument has a triggering quote this cycle", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    const quotesByInstrument = new Map([
      [
        "instrument-1",
        quote({ timestamp: "2026-08-25T14:30:00.000Z", bid: 9.4 }),
      ],
    ]);
    await processor.evaluateOpenQuoteExecutions(quotesByInstrument);

    expect(paperExecutionStore.quoteCalls).toHaveLength(1);
    expect(paperExecutionStore.quoteCalls[0]?.state).toMatchObject({
      status: "CLOSED",
    });
  });

  it("leaves an open execution untouched when its instrument has no quote this cycle", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.evaluateOpenQuoteExecutions(new Map());
    expect(paperExecutionStore.quoteCalls).toHaveLength(0);
  });

  it("persists fact progress when the quote does not trigger an exit", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    const quotesByInstrument = new Map([
      [
        "instrument-1",
        quote({ timestamp: "2026-08-25T14:15:00.000Z", bid: 10.2 }),
      ],
    ]);
    await processor.evaluateOpenQuoteExecutions(quotesByInstrument);
    expect(paperExecutionStore.quoteCalls).toHaveLength(1);
    expect(paperExecutionStore.quoteCalls[0]?.state).toMatchObject({
      status: "OPEN",
      lastFactTimestamp: "2026-08-25T14:15:00.000Z",
    });
  });

  it("ignores CANDLE rows, which are evaluated separately", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow({ model: "CANDLE" })];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    const quotesByInstrument = new Map([
      [
        "instrument-1",
        quote({ timestamp: "2026-08-25T14:30:00.000Z", bid: 9.4 }),
      ],
    ]);
    await processor.evaluateOpenQuoteExecutions(quotesByInstrument);
    expect(paperExecutionStore.quoteCalls).toHaveLength(0);
  });
});

const candle = (overrides: Partial<CandleFact> = {}): CandleFact => ({
  start: "2026-08-25T14:01:00.000Z",
  end: "2026-08-25T14:02:00.000Z",
  open: 10,
  high: 10.1,
  low: 9.9,
  close: 10.05,
  ...overrides,
});

const openCandleRow = (
  overrides: Partial<OpenExecutionRow> = {},
): OpenExecutionRow => ({
  observationId: "obs-1",
  instrumentId: "instrument-1",
  model: "CANDLE",
  status: "OPEN",
  position: {
    entryPrice: 10.01,
    entryTime: "2026-08-25T14:00:00.000Z",
    stop: 9.5,
    target: 11,
    shares: 99,
    initialRisk: 50.49,
  },
  entryMarketSnapshot: null,
  entrySizeCoverage: null,
  lastFactTimestamp: "2026-08-25T14:00:00.000Z",
  ...overrides,
});

describe("PaperBotLiveProcessor.evaluateOpenCandleExecutions", () => {
  it("closes an open candle execution whose instrument has a triggering completed bar", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openCandleRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    const candlesByInstrument = new Map([
      ["instrument-1", [candle({ low: 9.4 })]],
    ]);
    await processor.evaluateOpenCandleExecutions(candlesByInstrument);

    expect(paperExecutionStore.candleCalls).toHaveLength(1);
    expect(paperExecutionStore.candleCalls[0]?.state).toMatchObject({
      status: "CLOSED",
    });
  });

  it("leaves a candle execution untouched when no new candles arrived for its instrument", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openCandleRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.evaluateOpenCandleExecutions(new Map());
    expect(paperExecutionStore.candleCalls).toHaveLength(0);
  });

  it("ignores QUOTE rows, which are evaluated separately", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openCandleRow({ model: "QUOTE" })];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    const candlesByInstrument = new Map([
      ["instrument-1", [candle({ low: 9.4 })]],
    ]);
    await processor.evaluateOpenCandleExecutions(candlesByInstrument);
    expect(paperExecutionStore.candleCalls).toHaveLength(0);
  });
});

describe("PaperBotLiveProcessor.requestSessionClose", () => {
  const noon = "2026-08-25T16:00:00.000Z";

  it("closes a QUOTE execution immediately when an actionable quote is available at the boundary", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(
      noon,
      new Map([["instrument-1", quote({ timestamp: noon, bid: 10.2 })]]),
      new Map(),
    );

    expect(paperExecutionStore.quoteCalls).toHaveLength(1);
    expect(paperExecutionStore.quoteCalls[0]?.state).toMatchObject({
      status: "CLOSED",
      exit: { exitReason: "SESSION_CLOSE" },
    });
    expect(paperBotStore.settledRunIds).toEqual(["run-1"]);
  });

  it("moves a QUOTE execution to CLOSE_PENDING when no quote is available at the boundary", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(noon, new Map(), new Map());

    expect(paperExecutionStore.quoteCalls).toHaveLength(1);
    expect(paperExecutionStore.quoteCalls[0]?.state.status).toBe(
      "CLOSE_PENDING",
    );
  });

  it("recovers a QUOTE execution from the persisted boundary quote after restart", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.persistedCloseQuotes.set("instrument-1", [
      quote({ timestamp: noon, bid: 10.2 }),
    ]);
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(noon, new Map(), new Map());

    expect(paperExecutionStore.quoteCalls[0]?.state).toMatchObject({
      status: "CLOSED",
      exit: { exitReason: "SESSION_CLOSE" },
    });
  });

  it("advances to a later persisted quote when the first actionable one cannot fill a capacity-constrained exit", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.persistedCloseQuotes.set("instrument-1", [
      quote({ timestamp: noon, bid: 10.2, bidSize: 0 }),
      quote({
        timestamp: "2026-08-25T16:01:00.000Z",
        bid: 10.2,
        bidSize: 500,
      }),
    ]);
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [
      openQuoteRow({
        status: "CLOSE_PENDING",
        position: {
          ...openQuoteRow().position,
          executionMode: "CAPACITY_CONSTRAINED",
        },
      }),
    ];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(noon, new Map(), new Map());

    expect(paperExecutionStore.quoteCalls).toHaveLength(1);
    expect(paperExecutionStore.quoteCalls[0]?.state).toMatchObject({
      status: "CLOSED",
      exit: {
        exitReason: "SESSION_CLOSE_DELAYED",
        exitTime: "2026-08-25T16:01:00.000Z",
        filledShares: 99,
      },
    });
  });

  it("prefers the live batch quote but falls through to persisted candidates", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.persistedCloseQuotes.set("instrument-1", [
      quote({
        timestamp: "2026-08-25T16:01:00.000Z",
        bid: 10.2,
        bidSize: 500,
      }),
    ]);
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [
      openQuoteRow({
        status: "CLOSE_PENDING",
        position: {
          ...openQuoteRow().position,
          executionMode: "CAPACITY_CONSTRAINED",
        },
      }),
    ];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(
      noon,
      new Map([
        ["instrument-1", quote({ timestamp: noon, bid: 10.2, bidSize: 0 })],
      ]),
      new Map(),
    );

    expect(paperExecutionStore.quoteCalls[0]?.state).toMatchObject({
      status: "CLOSED",
      exit: { exitTime: "2026-08-25T16:01:00.000Z" },
    });
  });

  it("resolves a CLOSE_PENDING QUOTE execution once a later actionable quote arrives", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow({ status: "CLOSE_PENDING" })];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(
      noon,
      new Map([
        [
          "instrument-1",
          quote({ timestamp: "2026-08-25T16:05:00.000Z", bid: 10.2 }),
        ],
      ]),
      new Map(),
    );

    expect(paperExecutionStore.quoteCalls[0]?.state).toMatchObject({
      status: "CLOSED",
      exit: { exitReason: "SESSION_CLOSE_DELAYED" },
    });
  });

  it("does not use a quote captured before the noon boundary", async () => {
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openQuoteRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore: new FakePaperBotStore(),
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(
      noon,
      new Map([
        [
          "instrument-1",
          quote({ timestamp: "2026-08-25T15:59:59.000Z", bid: 10.2 }),
        ],
      ]),
      new Map(),
    );

    expect(paperExecutionStore.quoteCalls[0]?.state.status).toBe(
      "CLOSE_PENDING",
    );
  });

  it("closes a CANDLE execution at the noon candle's close when it is available", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openCandleRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(
      noon,
      new Map(),
      new Map([
        [
          "instrument-1",
          candle({ start: noon, end: "2026-08-25T16:01:00.000Z", close: 10.2 }),
        ],
      ]),
    );

    expect(paperExecutionStore.candleCalls).toHaveLength(1);
    expect(paperExecutionStore.candleCalls[0]?.state).toMatchObject({
      status: "CLOSED",
      exit: { exitReason: "SESSION_CLOSE" },
    });
  });

  it("moves a CANDLE execution to CLOSE_PENDING when the noon candle is not yet ingested", async () => {
    const paperBotStore = new FakePaperBotStore();
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openCandleRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(noon, new Map(), new Map());

    expect(paperExecutionStore.candleCalls[0]?.state.status).toBe(
      "CLOSE_PENDING",
    );
  });

  it("closes a CANDLE execution from the first persisted bar after a missed boundary bar", async () => {
    const paperBotStore = new FakePaperBotStore();
    paperBotStore.findSessionCloseCandles = async () =>
      new Map([
        [
          "instrument-1",
          candle({
            start: "2026-08-25T16:00:00.000Z",
            end: "2026-08-25T16:01:00.000Z",
            close: 10.2,
          }),
        ],
      ]);
    const paperExecutionStore = new FakePaperExecutionStore();
    paperExecutionStore.openRows = [openCandleRow()];
    const processor = new PaperBotLiveProcessor(
      {
        paperBotStore,
        paperExecutionStore,
        profiles: profileLookup(),
        assumptions,
      },
      "run-1",
    );

    await processor.requestSessionClose(noon, new Map(), new Map());

    expect(paperExecutionStore.candleCalls).toHaveLength(1);
    expect(paperExecutionStore.candleCalls[0]?.state).toMatchObject({
      status: "CLOSED",
      exit: {
        exitReason: "SESSION_CLOSE",
        exitTime: "2026-08-25T16:01:00.000Z",
      },
    });
  });
});
