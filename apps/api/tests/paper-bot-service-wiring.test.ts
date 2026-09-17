import { createQuoteExecution } from "../src/paper-bot/execution-core.js";
import { describe, expect, it, vi } from "vitest";
import { QuestradeCandleService } from "../src/market-data/candle-service.js";
import { QuestradeQuoteService } from "../src/market-data/quote-service.js";
import type {
  MarketDataRepository,
  PersistedInstrument,
} from "../src/market-data/repository.js";
import { QuestradeDataService } from "../src/market-data/service.js";
import { MarketSessionManager } from "../src/market-data/session-manager.js";
import { QuestradeAdapter } from "../src/questrade/adapter.js";
import { MockQuestradeTransport } from "../src/questrade/mock-transport.js";
import { QuestradeRateLimiter } from "../src/questrade/rate-limiter.js";
import { MockRequestBudget } from "../src/questrade/request-budget.js";
import {
  InMemoryRefreshTokenStore,
  QuestradeTokenManager,
} from "../src/questrade/token-manager.js";
import type { Candle, Instrument, Quote } from "../src/questrade/types.js";
import type {
  InsertObservationInput,
  InsertObservationResult,
  PaperBotRun,
  PaperBotStore,
  ReadyEventReconciliationCandidate,
  StartRunInput,
  UnfinishedLiveRun,
} from "../src/paper-bot/paper-bot-repository.js";
import type { PaperExecutionStore } from "../src/paper-bot/paper-execution-repository.js";
import type { ProfileLookup } from "../src/paper-bot/paper-bot-live-processor.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

class MemoryRepository implements MarketDataRepository {
  async markBenchmarks(): Promise<void> {}
  readonly instruments: PersistedInstrument[] = [];
  readonly quotes: Quote[] = [];
  readonly candles: Candle[] = [];

  async upsertInstruments(
    instruments: Instrument[],
  ): Promise<PersistedInstrument[]> {
    for (const instrument of instruments) {
      const existing = this.instruments.find(
        (c) => c.symbolId === instrument.symbolId,
      );
      if (existing) Object.assign(existing, instrument);
      else
        this.instruments.push({
          ...instrument,
          id: `instrument-${instrument.symbolId}`,
          active: true,
        });
    }
    return this.listActiveInstruments();
  }
  async listActiveInstruments(): Promise<PersistedInstrument[]> {
    return this.instruments.map((instrument) => ({ ...instrument }));
  }
  async saveQuotes(quotes: Quote[]): Promise<void> {
    this.quotes.push(...quotes);
  }
  async saveCandles(candles: Candle[]): Promise<void> {
    this.candles.push(...candles);
  }
}

class TestUniverseManager {
  constructor(
    private readonly adapter: QuestradeAdapter,
    private readonly repository: MarketDataRepository,
  ) {}
  async enrich(): Promise<PersistedInstrument[]> {
    const matches = await this.adapter.searchSymbols("BTO.TO");
    return this.repository.upsertInstruments(
      matches.filter((m) => m.symbol === "BTO.TO"),
    );
  }
}

function fixture(
  initialNow = "2026-08-24T13:25:00Z",
  marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
  source: "QUESTRADE" | "QUESTRADE_MOCK" = "QUESTRADE_MOCK",
) {
  let now = new Date(initialNow);
  const clock = () => new Date(now);
  const advance = (value: string) => {
    now = new Date(value);
  };
  const repository = new MemoryRepository();
  const transport = new MockQuestradeTransport();
  const limiter = new QuestradeRateLimiter(
    2,
    2,
    clock,
    new MockRequestBudget(),
  );
  const tokenManager = new QuestradeTokenManager(
    transport,
    new InMemoryRefreshTokenStore("mock-refresh-token-0"),
    clock,
    0,
    limiter,
  );
  const adapter = new QuestradeAdapter(
    tokenManager,
    transport,
    clock,
    source,
    limiter,
  );
  const metadata = new TestUniverseManager(adapter, repository);
  const sessionManager = new MarketSessionManager(
    adapter,
    clock,
    marketId === "US_EQUITIES" ? "US" : "TSX",
    {
      timezone:
        marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto",
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:45", end: "16:00" },
      entries: {
        preferredStart: "10:00",
        preferredEnd: "11:30",
        hardEnd: "16:00",
      },
    },
    marketId,
  );
  const service = new QuestradeDataService(
    adapter,
    metadata,
    new QuestradeQuoteService(adapter, repository, 50),
    new QuestradeCandleService(adapter, repository),
    sessionManager,
    clock,
  );
  return { advance, service, repository, adapter };
}

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

class FakePaperBotStore implements PaperBotStore {
  startCalls: StartRunInput[] = [];
  async startOrResumeLiveRun(input: StartRunInput): Promise<PaperBotRun> {
    this.startCalls.push(input);
    return {
      id: "run-1",
      marketId: input.marketId ?? "CA_TSX",
      source: input.source,
      sessionDate: input.sessionDate,
      sessionTimezone: input.sessionTimezone,
      scheduledCloseAt: input.scheduledCloseAt,
      status: "RUNNING",
      executionModelVersion: input.executionModelVersion,
      assumptions: input.assumptions,
      startedAt: "2026-08-24T13:30:00.000Z",
      completedAt: null,
      failedAt: null,
      failureReason: null,
    };
  }
  async startBacktestRun(input: StartRunInput): Promise<PaperBotRun> {
    return this.startOrResumeLiveRun(input);
  }
  async listUnfinishedLiveRuns(): Promise<UnfinishedLiveRun[]> {
    return [];
  }
  async findSessionCloseCandles() {
    return new Map();
  }
  async completeRun(): Promise<void> {}
  async failRun(): Promise<void> {}
  async settleRunAfterCloseRequest(_runId: string) {
    return "COMPLETED" as const;
  }
  async insertObservation(
    _input: InsertObservationInput,
  ): Promise<InsertObservationResult> {
    throw new Error("not used in this test");
  }
  async findObservationById() {
    return undefined;
  }
  async findUnobservedReadyEvents(
    _runId: string,
  ): Promise<ReadyEventReconciliationCandidate[]> {
    return [];
  }
}

const fakeExecutionStore: PaperExecutionStore = {
  async insertInitialExecutions() {},
  async upsertQuoteExecution() {},
  async upsertCandleExecution() {},
  async findOpenAndClosePending() {
    return [];
  },
  async abandonUnresolvedExecutions() {
    return 0;
  },
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
  },
};

const fakeProfiles: ProfileLookup = {
  getProfileConfig: async () => undefined,
};

describe("QuestradeDataService paper-bot wiring", () => {
  it("pauses backlog catch-up when a full funded cycle is waiting", async () => {
    const { service } = fixture();
    let releaseDrain!: () => void;
    const drainStarted = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let markDrainStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    const drainEnqueued = vi.fn(async () => {
      markDrainStarted();
      await drainStarted;
      return 1;
    });
    const processFundedPaperBot = vi.fn(async () => true);
    const harness = service as unknown as {
      paperFundedAdapter: {
        drainEnqueued: typeof drainEnqueued;
        operationalSnapshot: () => Promise<{ pendingFacts: number }>;
      };
      paperFundedBound: boolean;
      paperFundedOperational: { pendingFacts: number };
      paperFundedWork?: Promise<void>;
      processFundedPaperBot: typeof processFundedPaperBot;
      scheduleFundedDrainCatchUp(): void;
      scheduleFundedPaperBot(
        quotes: ReadonlyMap<string, never>,
        observations: readonly never[],
      ): void;
    };
    harness.paperFundedAdapter = {
      drainEnqueued,
      operationalSnapshot: async () => ({ pendingFacts: 10 }),
    };
    harness.paperFundedBound = true;
    harness.paperFundedOperational = { pendingFacts: 10 };
    harness.processFundedPaperBot = processFundedPaperBot;

    harness.scheduleFundedDrainCatchUp();
    await started;
    harness.scheduleFundedPaperBot(new Map<string, never>(), []);
    releaseDrain();
    await harness.paperFundedWork;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(drainEnqueued).toHaveBeenCalledTimes(1);
    harness.scheduleFundedPaperBot(new Map<string, never>(), []);
    await harness.paperFundedWork;
    expect(processFundedPaperBot).toHaveBeenCalledTimes(1);
  });

  it("uses decoupled catch-up for an older run that blocks current binding", async () => {
    const { service } = fixture();
    const currentDrain = vi.fn(async () => 0);
    const recoveryDrain = vi.fn(async () => 1);
    const harness = service as unknown as {
      paperFundedAdapter: {
        drainEnqueued: typeof currentDrain;
        operationalSnapshot: () => Promise<{ pendingFacts: number }>;
      };
      paperFundedRecoveryAdapters: Map<
        string,
        { drainEnqueued: typeof recoveryDrain }
      >;
      paperFundedBound: boolean;
      paperFundedOperational: { pendingFacts: number };
      paperFundedWork?: Promise<void>;
      scheduleFundedDrainCatchUp(): void;
    };
    harness.paperFundedAdapter = {
      drainEnqueued: currentDrain,
      operationalSnapshot: async () => ({ pendingFacts: 0 }),
    };
    harness.paperFundedRecoveryAdapters.set("older-run", {
      drainEnqueued: recoveryDrain,
    });
    harness.paperFundedBound = false;
    harness.paperFundedOperational = { pendingFacts: 10 };

    harness.scheduleFundedDrainCatchUp();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.paperFundedWork;

    expect(recoveryDrain).toHaveBeenCalledTimes(1);
    expect(currentDrain).not.toHaveBeenCalled();
  });

  it("extends the funded drain pass with the durable backlog", async () => {
    const { service } = fixture();
    const drainEnqueued = vi.fn(async () => 0);
    const harness = service as unknown as {
      paperFundedAdapter: {
        drainEnqueued: typeof drainEnqueued;
        operationalSnapshot: () => Promise<{ pendingFacts: number }>;
      };
      paperFundedBound: boolean;
      paperFundedOperational: { pendingFacts: number };
      paperFundedWork?: Promise<void>;
      scheduleFundedDrainCatchUp(): void;
    };
    harness.paperFundedAdapter = {
      drainEnqueued,
      operationalSnapshot: async () => ({ pendingFacts: 2_500 }),
    };
    harness.paperFundedBound = true;
    harness.paperFundedOperational = { pendingFacts: 2_500 };

    harness.scheduleFundedDrainCatchUp();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.paperFundedWork;

    expect(drainEnqueued).toHaveBeenCalledWith({
      maxFacts: 300,
      maxDurationMs: 3_000,
    });
  });

  it("caps the extended funded drain pass at ten seconds", async () => {
    const { service } = fixture();
    const drainEnqueued = vi.fn(async () => 0);
    const harness = service as unknown as {
      paperFundedAdapter: {
        drainEnqueued: typeof drainEnqueued;
        operationalSnapshot: () => Promise<{ pendingFacts: number }>;
      };
      paperFundedBound: boolean;
      paperFundedOperational: { pendingFacts: number };
      paperFundedWork?: Promise<void>;
      scheduleFundedDrainCatchUp(): void;
    };
    harness.paperFundedAdapter = {
      drainEnqueued,
      operationalSnapshot: async () => ({ pendingFacts: 58_000 }),
    };
    harness.paperFundedBound = true;
    harness.paperFundedOperational = { pendingFacts: 58_000 };

    harness.scheduleFundedDrainCatchUp();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.paperFundedWork;

    expect(drainEnqueued).toHaveBeenCalledWith({
      maxFacts: 1_000,
      maxDurationMs: 10_000,
    });
  });

  it("extends the funded drain pass while the five-minute rate is behind", async () => {
    const { service } = fixture();
    const drainEnqueued = vi.fn(async () => 0);
    const harness = service as unknown as {
      paperFundedAdapter: {
        drainEnqueued: typeof drainEnqueued;
        operationalSnapshot: () => Promise<{
          pendingFacts: number;
          arrivalMinusDrainPerMinute: number;
        }>;
      };
      paperFundedBound: boolean;
      paperFundedOperational: {
        pendingFacts: number;
        arrivalMinusDrainPerMinute: number;
      };
      paperFundedWork?: Promise<void>;
      scheduleFundedDrainCatchUp(): void;
    };
    harness.paperFundedAdapter = {
      drainEnqueued,
      operationalSnapshot: async () => ({
        pendingFacts: 100,
        arrivalMinusDrainPerMinute: 240,
      }),
    };
    harness.paperFundedBound = true;
    harness.paperFundedOperational = {
      pendingFacts: 100,
      arrivalMinusDrainPerMinute: 240,
    };

    harness.scheduleFundedDrainCatchUp();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.paperFundedWork;

    expect(drainEnqueued).toHaveBeenCalledWith({
      maxFacts: 200,
      maxDurationMs: 2_000,
    });
  });

  it("keeps the documented pass budget without a durable backlog", async () => {
    const { service } = fixture();
    const drainEnqueued = vi.fn(async () => 0);
    const harness = service as unknown as {
      paperFundedAdapter: {
        drainEnqueued: typeof drainEnqueued;
        operationalSnapshot: () => Promise<{ pendingFacts: number }>;
      };
      paperFundedBound: boolean;
      paperFundedOperational: { pendingFacts: number };
      paperFundedWork?: Promise<void>;
      scheduleFundedDrainCatchUp(): void;
    };
    harness.paperFundedAdapter = {
      drainEnqueued,
      operationalSnapshot: async () => ({ pendingFacts: 10 }),
    };
    harness.paperFundedBound = true;
    harness.paperFundedOperational = { pendingFacts: 10 };

    harness.scheduleFundedDrainCatchUp();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.paperFundedWork;

    expect(drainEnqueued).toHaveBeenCalledWith({
      maxFacts: 100,
      maxDurationMs: 1_000,
    });
  });

  it("retains a recovery adapter while its funded inbox still has pending facts", async () => {
    const { service } = fixture();
    const recoveryAdapter = {
      retainedQuotes: vi.fn(async () => []),
      process: vi.fn(async () => ({ processed: 100 })),
    };
    let recoveryRunActive = true;
    const pool = {
      query: vi.fn(async (text: string) => {
        if (text.includes('r.id AS "runId"'))
          return {
            rows: recoveryRunActive
              ? [
                  {
                    runId: "older-run",
                    marketId: "CA_TSX",
                    sessionDate: "2026-08-23",
                    scheduledCloseAt: "2026-08-23T20:00:00.000Z",
                    assumptions,
                    policy: { version: "funded-v1" },
                    instrumentIds: [],
                  },
                ]
              : [],
          };
        if (text.includes("WHERE EXISTS")) return { rows: [{ retained: 1 }] };
        throw new Error(`Unexpected query: ${text}`);
      }),
    };
    const paperBotStore = new FakePaperBotStore();
    const harness = service as unknown as {
      paperFundedConfig: {
        pool: typeof pool;
        accountId: string;
        currency: "CAD";
      };
      paperBotRunId: string;
      paperBotStore: FakePaperBotStore;
      instruments: readonly never[];
      paperFundedRecoveryAdapters: Map<string, typeof recoveryAdapter>;
      processFundedRecoveryRuns(
        quotes: ReadonlyMap<string, never>,
        through: string,
      ): Promise<void>;
    };
    harness.paperFundedConfig = {
      pool,
      accountId: "account-1",
      currency: "CAD",
    };
    harness.paperBotRunId = "current-run";
    harness.paperBotStore = paperBotStore;
    harness.paperFundedRecoveryAdapters.set("older-run", recoveryAdapter);

    await harness.processFundedRecoveryRuns(
      new Map<string, never>(),
      "2026-08-24T14:00:00.000Z",
    );

    expect(recoveryAdapter.process).toHaveBeenCalledOnce();
    expect(harness.paperFundedRecoveryAdapters.has("older-run")).toBe(true);
    expect(
      pool.query.mock.calls.some(([text]) =>
        text.includes("paper_funded_fact"),
      ),
    ).toBe(true);

    recoveryRunActive = false;
    await harness.processFundedRecoveryRuns(
      new Map<string, never>(),
      "2026-08-24T14:01:00.000Z",
    );
    expect(harness.paperFundedRecoveryAdapters.has("older-run")).toBe(false);
  });

  it("does nothing when setPaperBot is never called", async () => {
    const { service } = fixture();
    await expect(service.initialize()).resolves.toBeUndefined();
  });

  it("starts a live run at initialize() once wired, using the market's own session boundaries", async () => {
    const { service } = fixture();
    const paperBotStore = new FakePaperBotStore();
    service.setPaperBot(
      paperBotStore,
      fakeExecutionStore,
      fakeProfiles,
      assumptions,
      "v1",
    );

    await service.initialize();

    expect(paperBotStore.startCalls).toHaveLength(1);
    const call = paperBotStore.startCalls[0];
    expect(call).toMatchObject({ source: "LIVE", executionModelVersion: "v1" });
    expect(call?.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Scheduled close is 150 minutes (2h30m) after the market's own open time.
    expect(new Date(call!.scheduledCloseAt).getTime()).toBeGreaterThan(
      Date.parse(call!.sessionDate),
    );
  });

  it("does not start a second run on a same-session refresh", async () => {
    const { service } = fixture();
    const paperBotStore = new FakePaperBotStore();
    service.setPaperBot(
      paperBotStore,
      fakeExecutionStore,
      fakeProfiles,
      assumptions,
      "v1",
    );

    await service.initialize();
    expect(paperBotStore.startCalls).toHaveLength(1);
  });

  it("observes a READY event and opens an execution during a live cycle, without disturbing scanner persistence", async () => {
    const { advance, service } = fixture();
    const insertedObservations: InsertObservationInput[] = [];
    const quoteExecutionCalls: unknown[] = [];
    let reconciledEvent:
      import("@tsx-scanner/contracts").StrategyStateEvent | undefined;
    const store: PaperBotStore = {
      startOrResumeLiveRun: async (
        input: StartRunInput,
      ): Promise<PaperBotRun> => ({
        id: "run-1",
        marketId: input.marketId ?? "CA_TSX",
        source: input.source,
        sessionDate: input.sessionDate,
        sessionTimezone: input.sessionTimezone,
        scheduledCloseAt: input.scheduledCloseAt,
        status: "RUNNING",
        executionModelVersion: input.executionModelVersion,
        assumptions: input.assumptions,
        startedAt: "2026-08-24T13:30:00.000Z",
        completedAt: null,
        failedAt: null,
        failureReason: null,
      }),
      startBacktestRun: async (input: StartRunInput) =>
        store.startOrResumeLiveRun(input),
      listUnfinishedLiveRuns: async () => [],
      findSessionCloseCandles: async () => new Map(),
      completeRun: async () => undefined,
      failRun: async () => undefined,
      settleRunAfterCloseRequest: async () => "COMPLETED",
      insertObservation: async (
        input: InsertObservationInput,
      ): Promise<InsertObservationResult> => {
        insertedObservations.push(input);
        return {
          observation: {
            ...input,
            id: "obs-1",
            marketId: "CA_TSX",
            createdAt: "now",
          },
          created: true,
        };
      },
      findObservationById: async () => undefined,
      findUnobservedReadyEvents: async () =>
        reconciledEvent
          ? (() => {
              const event = reconciledEvent;
              reconciledEvent = undefined;
              return [
                {
                  sourceEventId: event.eventId,
                  event,
                  parseError: null,
                  sourceSignalId: "signal-1",
                  quoteAtSignal: {
                    timestamp: event.timestamp,
                    bid: 9.99,
                    ask: 10,
                    bidSize: 500,
                    askSize: 500,
                    dataStatus: "REALTIME",
                    actionable: true,
                  },
                },
              ];
            })()
          : [],
    };
    const executionStore: PaperExecutionStore = {
      async insertInitialExecutions(_observationId, quoteState) {
        quoteExecutionCalls.push(quoteState);
      },
      async upsertQuoteExecution(_observationId, state) {
        quoteExecutionCalls.push(state);
      },
      async upsertCandleExecution() {},
      async findOpenAndClosePending() {
        return [];
      },
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
      },
      async abandonUnresolvedExecutions() {
        return 0;
      },
    };
    const profiles: ProfileLookup = {
      getProfileConfig: async () => ({
        configId: "config-1",
        configVersion: "v1",
        parameters: { scoreCutoff: 70 },
      }),
    };
    service.setPaperBot(store, executionStore, profiles, assumptions, "v1");

    const readyEvent = {
      kind: "SETUP",
      eventId: "event-1",
      eventType: "STRATEGY_STATE_CHANGED",
      previousState: "FORMING",
      state: "READY",
      instrumentId: "instrument-1001",
      symbol: "BTO.TO",
      timestamp: "2026-08-24T13:31:00.000Z",
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
      reasonCodes: [],
      entryReference: 10,
      stopReference: 9.5,
      targetReference: 11,
      estimatedRr: 2,
      featureSnapshot: { atr14: 0.25 },
    } as unknown as import("@tsx-scanner/contracts").StrategyStateEvent;
    reconciledEvent = readyEvent;

    const engine = {
      startSession: async () => undefined,
      ingestCandles: async () => undefined,
      ingestQuotes: async () => ({
        snapshots: [],
        evaluations: [],
        events: [readyEvent],
        contexts: [],
        benchmarkReadiness: { market: null, sectors: [] },
        timings: { featureMs: 0, evaluationMs: 0 },
      }),
    };
    const featureStore = { saveFeatureSnapshots: async () => undefined };
    service.setFeatureEngine(engine, featureStore, {
      saveStrategyResults: async () => undefined,
    });

    await service.initialize();
    advance("2026-08-24T13:31:00Z");
    await service.runCycle();

    expect(insertedObservations).toHaveLength(1);
    expect(insertedObservations[0]).toMatchObject({
      sourceEventId: "event-1",
      instrumentId: "instrument-1001",
      eligibilityStatus: "ELIGIBLE",
    });
    expect(quoteExecutionCalls).toHaveLength(1);
    // The scanner's own snapshot must remain unaffected by paper-bot wiring.
    expect(service.getSnapshot().state).not.toBe("DEGRADED");
  });

  it("evaluates open CANDLE executions against real one-minute candles collected during a cycle", async () => {
    const { advance, service } = fixture();
    const paperBotStore = new FakePaperBotStore();
    let findOpenAndClosePendingCalls = 0;
    let candleWrites = 0;
    const executionStore: PaperExecutionStore = {
      async insertInitialExecutions() {},
      async upsertQuoteExecution() {},
      async upsertCandleExecution() {
        candleWrites += 1;
      },
      async findOpenAndClosePending() {
        findOpenAndClosePendingCalls += 1;
        return [
          {
            observationId: "obs-1",
            instrumentId: "instrument-1001",
            model: "CANDLE",
            status: "OPEN",
            // Deliberately far outside any plausible mock price so this
            // proves the stage ran without depending on exact mock prices.
            position: {
              entryPrice: 10,
              entryTime: "2026-08-24T13:30:00.000Z",
              stop: 0.01,
              target: 100_000,
              shares: 1,
              initialRisk: 1,
            },
            entryMarketSnapshot: null,
            entrySizeCoverage: null,
            lastFactTimestamp: "2026-08-24T13:30:00.000Z",
          },
        ];
      },
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
      },
      async abandonUnresolvedExecutions() {
        return 0;
      },
    };
    service.setPaperBot(
      paperBotStore,
      executionStore,
      fakeProfiles,
      assumptions,
      "v1",
    );

    await service.initialize();
    advance("2026-08-24T13:31:00Z");
    await service.runCycle();

    expect(findOpenAndClosePendingCalls).toBeGreaterThan(0);
    // A normal pre-noon candle cycle persists its latest processed fact even
    // when no stop or target is triggered.
    expect(candleWrites).toBe(1);
  });

  it.each(
    (["CA_TSX", "US_EQUITIES"] as const).flatMap((marketId) =>
      ["healthy", "paused", "first-upload-failure"].map((scannerState) => ({
        marketId,
        scannerState,
      })),
    ),
  )(
    "collects closing facts for $marketId with scanner=$scannerState",
    async ({ marketId, scannerState }) => {
      const { advance, service, repository, adapter } = fixture(
        undefined,
        marketId,
        "QUESTRADE",
      );
      const originalGetCandles = adapter.getCandles.bind(adapter);
      vi.spyOn(adapter, "getCandles").mockImplementation(
        async (symbolId, interval, range) => {
          const candles = await originalGetCandles(symbolId, interval, range);
          // The bundled mock only contains opening bars. Publish a closing bar
          // only when the service actually requests data through the boundary.
          if (
            interval === "OneMinute" &&
            range.endTime.toISOString() === "2026-08-24T20:00:00.000Z" &&
            candles[0]
          ) {
            candles.push({
              ...candles[0],
              start: new Date("2026-08-24T19:59:00Z"),
              end: new Date("2026-08-24T20:00:00Z"),
            });
          }
          return candles;
        },
      );
      const paperBotStore = new FakePaperBotStore();
      const quoteExecutionCalls: unknown[] = [];
      const executionStore: PaperExecutionStore = {
        async insertInitialExecutions() {},
        async upsertQuoteExecution(_observationId, state) {
          quoteExecutionCalls.push(state);
        },
        async upsertCandleExecution() {},
        async findOpenAndClosePending() {
          return [
            {
              observationId: "obs-1",
              instrumentId: "instrument-1001",
              model: "QUOTE",
              status: "OPEN",
              position: {
                entryPrice: 10,
                entryTime: "2026-08-24T13:30:00.000Z",
                stop: 0.01,
                target: 100_000,
                shares: 1,
                initialRisk: 1,
              },
              entryMarketSnapshot: {
                bid: 9.99,
                ask: 10,
                bidSize: 500,
                askSize: 500,
                spread: 0.01,
                quoteTimestamp: "2026-08-24T13:30:00.000Z",
                dataStatus: "REALTIME",
              },
              entrySizeCoverage: 50,
              lastFactTimestamp: "2026-08-24T13:30:00.000Z",
            },
          ];
        },
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
        },
        async abandonUnresolvedExecutions() {
          return 0;
        },
      };
      service.setPaperBot(
        paperBotStore,
        executionStore,
        fakeProfiles,
        assumptions,
        "v1",
      );

      await service.initialize();
      // Noon Toronto is 16:00Z in August, and must not trigger closure.
      advance("2026-08-24T16:05:00Z");
      await service.runCycle();
      expect(quoteExecutionCalls).toHaveLength(0);

      const sessionStarts = vi.fn(async () => undefined);
      let rejectCandleUploads = false;
      if (scannerState !== "healthy") {
        const engine = {
          startSession: sessionStarts,
          ingestCandles: async () => {
            if (rejectCandleUploads) throw new Error("scanner unavailable");
          },
          ingestQuotes: async () => {
            throw new Error("scanner unavailable");
          },
        };
        service.setFeatureEngine(engine, {
          saveFeatureSnapshots: async () => undefined,
        });
        for (const second of scannerState === "paused"
          ? ["00", "01", "02"]
          : ["00"]) {
          advance(`2026-08-24T19:59:${second}Z`);
          await service.refreshUniverse();
        }
        if (scannerState === "paused") {
          advance("2026-08-24T19:59:58Z");
          await service.runCycle();
          expect(service.getSnapshot().lastError).toContain(
            "3 full history reloads",
          );
        }
        rejectCandleUploads = true;
      }

      // The regular 16:00 Toronto close is 20:00Z in August.
      advance("2026-08-24T20:00:01Z");
      await service.runCycle();
      expect(quoteExecutionCalls).toContainEqual(
        expect.objectContaining({
          status: "CLOSED",
          exit: expect.objectContaining({
            exitReason: "SESSION_CLOSE_DELAYED",
          }),
        }),
      );
      expect(
        repository.candles.some(
          (c) =>
            c.interval === "OneMinute" &&
            c.end.toISOString() === "2026-08-24T20:00:00.000Z",
        ),
      ).toBe(true);
      if (scannerState === "first-upload-failure") {
        expect(service.getSnapshot().lastError).toContain(
          "2026-08-24T20:00:31.000Z",
        );
        await service.runCycle();
        expect(sessionStarts).toHaveBeenCalledTimes(1);
        rejectCandleUploads = false;
      }
      const collected = repository.quotes.length;
      await service.runCycle();
      expect(repository.quotes).toHaveLength(collected);
      advance("2026-08-24T20:01:02Z");
      vi.spyOn(adapter, "getQuotes").mockRejectedValueOnce(
        new Error("temporary provider outage"),
      );
      await service.runCycle();
      expect(repository.quotes).toHaveLength(collected);
      await service.runCycle();
      expect(repository.quotes.length).toBeGreaterThan(collected);
    },
  );

  it("closes a post-market-close quote as a session close, never as a normal STOP exit", async () => {
    const { advance, service } = fixture();
    const paperBotStore = new FakePaperBotStore();
    const writes: { status: string; exitReason?: string }[] = [];
    const executionStore: PaperExecutionStore = {
      async insertInitialExecutions() {},
      async upsertQuoteExecution(_observationId, state) {
        writes.push({
          status: state.status,
          ...(state.status === "CLOSED"
            ? { exitReason: state.exit.exitReason }
            : {}),
        });
      },
      async upsertCandleExecution() {},
      async findOpenAndClosePending() {
        return [
          {
            observationId: "obs-1",
            instrumentId: "instrument-1001",
            model: "QUOTE" as const,
            status: "OPEN" as const,
            // A stop far above any plausible bid: if the normal exit stage
            // still evaluated this quote, it would necessarily close as STOP.
            position: {
              entryPrice: 10,
              entryTime: "2026-08-24T13:30:00.000Z",
              stop: 100_000,
              target: 200_000,
              shares: 1,
              initialRisk: 1,
            },
            entryMarketSnapshot: {
              bid: 9.99,
              ask: 10,
              bidSize: 500,
              askSize: 500,
              spread: 0.01,
              quoteTimestamp: "2026-08-24T13:30:00.000Z",
              dataStatus: "REALTIME",
              stalenessSeconds: 0,
            },
            entrySizeCoverage: 50,
            lastFactTimestamp: "2026-08-24T13:30:00.000Z",
          },
        ];
      },
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
      },
      async abandonUnresolvedExecutions() {
        return 0;
      },
    };
    service.setPaperBot(
      paperBotStore,
      executionStore,
      fakeProfiles,
      assumptions,
      "v1",
    );
    // The normal quote-exit stage runs inside updateFeatures, so a feature
    // engine must be wired for this test to exercise the stage ordering at
    // all rather than only the session-close stage.
    service.setFeatureEngine(
      {
        startSession: async () => undefined,
        ingestCandles: async () => undefined,
        ingestQuotes: async () => ({
          snapshots: [],
          evaluations: [],
          events: [],
          contexts: [],
          benchmarkReadiness: { market: null, sectors: [] },
          timings: { featureMs: 0, evaluationMs: 0 },
        }),
      },
      { saveFeatureSnapshots: async () => undefined },
      { saveStrategyResults: async () => undefined },
    );

    await service.initialize();
    // Past the 20:00Z Toronto regular-session close.
    advance("2026-08-24T20:05:00Z");
    await service.runCycle();

    expect(writes.length).toBeGreaterThan(0);
    expect(writes.map((write) => write.exitReason)).not.toContain("STOP");
    for (const write of writes) {
      if (write.status !== "CLOSED") continue;
      expect(["SESSION_CLOSE", "SESSION_CLOSE_DELAYED"]).toContain(
        write.exitReason,
      );
    }
  });

  it("settles an unfinished run from an earlier session instead of stranding it RUNNING", async () => {
    const { advance, service } = fixture();
    const settled: string[] = [];
    const overdue: PaperBotRun = {
      id: "run-overdue",
      marketId: "CA_TSX",
      source: "LIVE",
      sessionDate: "2026-08-17",
      sessionTimezone: "America/Toronto",
      scheduledCloseAt: "2026-08-17T16:00:00.000Z",
      status: "RUNNING",
      executionModelVersion: "v1",
      assumptions,
      startedAt: "2026-08-17T13:30:00.000Z",
      completedAt: null,
      failedAt: null,
      failureReason: null,
    };
    class OverdueStore extends FakePaperBotStore {
      override async listUnfinishedLiveRuns(): Promise<UnfinishedLiveRun[]> {
        return [{ run: overdue, laterSessions: 0 }];
      }
      override async settleRunAfterCloseRequest(runId: string) {
        settled.push(runId);
        return "COMPLETED" as const;
      }
    }
    const paperBotStore = new OverdueStore();
    service.setPaperBot(
      paperBotStore,
      fakeExecutionStore,
      fakeProfiles,
      assumptions,
      "v1",
    );

    // initialize() alone must resolve it: a process that starts after a
    // missed noon cannot wait for the market to reopen.
    await service.initialize();
    expect(settled).toContain("run-overdue");
    expect(service.getSnapshot().paperBot?.overdueRuns).toBe(1);

    advance("2026-08-24T13:31:00Z");
    await service.runCycle();
  });

  it("observes a prior run's stranded READY event before its close sweep settles it", async () => {
    const { service } = fixture();
    const settled: string[] = [];
    const inserted: InsertObservationInput[] = [];
    const overdue: PaperBotRun = {
      id: "run-overdue",
      marketId: "CA_TSX",
      source: "LIVE",
      sessionDate: "2026-08-17",
      sessionTimezone: "America/Toronto",
      scheduledCloseAt: "2026-08-17T16:00:00.000Z",
      status: "CLOSE_PENDING",
      executionModelVersion: "v1",
      assumptions,
      startedAt: "2026-08-17T13:30:00.000Z",
      completedAt: null,
      failedAt: null,
      failureReason: null,
    };
    const readyEvent = {
      kind: "SETUP",
      eventId: "event-stranded",
      eventType: "STRATEGY_STATE_CHANGED",
      previousState: "FORMING",
      state: "READY",
      instrumentId: "instrument-1001",
      symbol: "BTO.TO",
      timestamp: "2026-08-17T13:31:00.000Z",
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
      setupInstanceId: "setup-stranded",
      reasonCodes: [],
      entryReference: 10,
      stopReference: 9.5,
      targetReference: 11,
      estimatedRr: 2,
      featureSnapshot: { atr14: 0.25 },
    } as unknown as import("@tsx-scanner/contracts").StrategyStateEvent;
    let pending: ReadyEventReconciliationCandidate | null = {
      sourceEventId: "event-stranded",
      event: readyEvent,
      parseError: null,
      sourceSignalId: "signal-stranded",
      quoteAtSignal: {
        timestamp: "2026-08-17T13:31:00.000Z",
        bid: 9.99,
        ask: 10,
        bidSize: 500,
        askSize: 500,
        dataStatus: "REALTIME",
        actionable: true,
      },
    };
    class StrandedStore extends FakePaperBotStore {
      override async listUnfinishedLiveRuns(): Promise<UnfinishedLiveRun[]> {
        return [{ run: overdue, laterSessions: 0 }];
      }
      override async findUnobservedReadyEvents(
        runId: string,
      ): Promise<ReadyEventReconciliationCandidate[]> {
        if (runId !== overdue.id) return [];
        // Mirrors the production query: once observed, the candidate is no
        // longer returned, so the drain loop converges.
        const candidate = pending;
        pending = null;
        return candidate ? [candidate] : [];
      }
      override async insertObservation(
        input: InsertObservationInput,
      ): Promise<InsertObservationResult> {
        inserted.push(input);
        return {
          observation: {
            ...input,
            id: "obs-stranded",
            marketId: "CA_TSX",
            createdAt: "now",
          },
          created: true,
        };
      }
      override async settleRunAfterCloseRequest(runId: string) {
        settled.push(runId);
        return "COMPLETED" as const;
      }
    }
    service.setPaperBot(
      new StrandedStore(),
      fakeExecutionStore,
      {
        getProfileConfig: async () => ({
          configId: "config-1",
          configVersion: "v1",
          parameters: { scoreCutoff: 70 },
        }),
      },
      assumptions,
      "v1",
    );

    await service.initialize();

    expect(inserted.map((row) => [row.runId, row.sourceEventId])).toEqual([
      ["run-overdue", "event-stranded"],
    ]);
    expect(settled).toContain("run-overdue");
  });

  it.each([false, true])(
    "abandons independent evidence but retains coordinated recovery: %s",
    async (coordinated) => {
      const { service } = fixture();
      const settled: string[] = [];
      const abandoned: { runId: string; reason: string }[] = [];
      const stale: PaperBotRun = {
        id: "run-stale",
        marketId: "CA_TSX",
        source: "LIVE",
        sessionDate: "2026-08-10",
        sessionTimezone: "America/Toronto",
        scheduledCloseAt: "2026-08-10T16:00:00.000Z",
        status: "CLOSE_PENDING",
        executionModelVersion: "v1",
        assumptions,
        startedAt: "2026-08-10T13:30:00.000Z",
        completedAt: null,
        failedAt: null,
        failureReason: null,
      };
      const retainedQuote = {
        timestamp: "2026-08-11T16:00:00.000Z",
        bid: 10,
        ask: 10.01,
        bidSize: 10000,
        askSize: 10000,
        dataStatus: "REALTIME" as const,
        actionable: true,
      };
      class StaleStore extends FakePaperBotStore {
        async findSessionCloseQuotes() {
          return new Map([["instrument-1001", [retainedQuote]]]);
        }
        override async listUnfinishedLiveRuns(): Promise<UnfinishedLiveRun[]> {
          // Two later sessions have since been observed: past the horizon.
          return [{ run: stale, laterSessions: 2 }];
        }
        override async settleRunAfterCloseRequest(runId: string) {
          settled.push(runId);
          return "COMPLETED" as const;
        }
      }
      let closeAttempts = 0;
      const executionStore: PaperExecutionStore = {
        ...fakeExecutionStore,
        async findOpenAndClosePending() {
          closeAttempts += 1;
          return [];
        },
        async abandonUnresolvedExecutions(runId: string, reason: string) {
          abandoned.push({ runId, reason });
          return 1;
        },
      };
      const position = createQuoteExecution(
        {
          entryReference: 10.01,
          stopReference: 9.5,
          targetReference: 11,
          atr14: 1,
          signalTimestamp: "2026-08-10T13:30:00.000Z",
        },
        { ...retainedQuote, timestamp: "2026-08-10T13:30:00.000Z" },
        assumptions,
      );
      expect(position.status).toBe("OPEN");
      let recovered = false;
      const findOpenPositions = vi.fn(async (runId: string) =>
        runId === stale.id && !recovered
          ? [
              {
                id: "position-stale",
                observationId: "obs-stale",
                instrumentId: "instrument-1001",
                strategyKey: "OPENING_RANGE_BREAKOUT",
                state: position,
              },
            ]
          : [],
      );
      const updateQuotePosition = vi.fn(async () => {
        recovered = true;
      });
      service.setPaperBot(
        new StaleStore(),
        executionStore,
        fakeProfiles,
        assumptions,
        "v1",
        undefined,
        coordinated
          ? ({ findOpenPositions, updateQuotePosition } as never)
          : undefined,
      );

      await service.initialize();

      // initialize() sweeps twice by design -- once before authentication, and
      // once after today's run exists so its own overdue close is settled too.
      // The underlying UPDATE filters on close_abandoned_at IS NULL, so a
      // repeat is a no-op against the database.
      expect(abandoned.length).toBeGreaterThan(0);
      expect(abandoned[0]?.runId).toBe("run-stale");
      expect(abandoned[0]?.reason).toContain("2026-08-10");
      // Abandoning replaces the close attempt rather than following it.
      if (coordinated) {
        expect(findOpenPositions).toHaveBeenCalledWith("run-stale");
        expect(updateQuotePosition).toHaveBeenCalledWith(
          "position-stale",
          expect.objectContaining({ status: "CLOSED" }),
          expect.objectContaining({
            source: "PERSISTED_QUOTE",
            factTimestamp: retainedQuote.timestamp,
          }),
        );
      } else {
        expect(closeAttempts).toBe(0);
      }
      expect(settled).toContain("run-stale");
    },
  );

  it("settles overdue runs even when Questrade authentication is unavailable", async () => {
    const { service } = fixture();
    const settled: string[] = [];
    const overdue: PaperBotRun = {
      id: "run-overdue",
      marketId: "CA_TSX",
      source: "LIVE",
      sessionDate: "2026-08-17",
      sessionTimezone: "America/Toronto",
      scheduledCloseAt: "2026-08-17T16:00:00.000Z",
      status: "RUNNING",
      executionModelVersion: "v1",
      assumptions,
      startedAt: "2026-08-17T13:30:00.000Z",
      completedAt: null,
      failedAt: null,
      failureReason: null,
    };
    class OverdueStore extends FakePaperBotStore {
      override async listUnfinishedLiveRuns(): Promise<UnfinishedLiveRun[]> {
        return [{ run: overdue, laterSessions: 0 }];
      }
      override async settleRunAfterCloseRequest(runId: string) {
        settled.push(runId);
        return "COMPLETED" as const;
      }
    }
    service.setPaperBot(
      new OverdueStore(),
      fakeExecutionStore,
      fakeProfiles,
      assumptions,
      "v1",
    );
    // A stranded refresh token is exactly the situation that produces overdue
    // runs, so settlement must not sit behind authentication.
    (
      service as unknown as { adapter: { initialize: () => Promise<void> } }
    ).adapter.initialize = async () => {
      throw new Error("Questrade rejected every stored refresh token");
    };

    await expect(service.initialize()).rejects.toThrow(/refresh token/);
    expect(settled).toContain("run-overdue");
  });

  it("starts and manages paper bot runs scoped to US_EQUITIES when configured for US market", async () => {
    const { advance, service } = fixture("2026-08-24T13:25:00Z", "US_EQUITIES");
    const paperBotStore = new FakePaperBotStore();
    const usAssumptions: AssumptionsSnapshot = {
      ...assumptions,
      sessionTimezone: "America/New_York",
    };

    service.setPaperBot(
      paperBotStore,
      fakeExecutionStore,
      fakeProfiles,
      usAssumptions,
      "v1",
    );

    await service.initialize();

    // A live run scoped to US_EQUITIES is started at initialize()
    expect(paperBotStore.startCalls).toHaveLength(1);
    expect(paperBotStore.startCalls[0]?.marketId).toBe("US_EQUITIES");
    expect(paperBotStore.startCalls[0]?.sessionTimezone).toBe(
      "America/New_York",
    );
    expect(paperBotStore.startCalls[0]?.sessionDate).toBe("2026-08-24");

    // Advance to 09:30 AM New York (13:30 UTC) and run cycle
    advance("2026-08-24T13:30:00Z");
    await service.runCycle();

    // Same session run should be reused, not recreated
    expect(paperBotStore.startCalls).toHaveLength(1);
  });

  it("isolates overdue paper bot run settlement by marketId", async () => {
    const { service } = fixture("2026-08-24T13:25:00Z", "US_EQUITIES");
    const settled: string[] = [];
    const caOverdue: PaperBotRun = {
      id: "run-ca-overdue",
      marketId: "CA_TSX",
      source: "LIVE",
      sessionDate: "2026-08-17",
      sessionTimezone: "America/Toronto",
      scheduledCloseAt: "2026-08-17T16:00:00.000Z",
      status: "RUNNING",
      executionModelVersion: "v1",
      assumptions,
      startedAt: "2026-08-17T13:30:00.000Z",
      completedAt: null,
      failedAt: null,
      failureReason: null,
    };
    const usOverdue: PaperBotRun = {
      id: "run-us-overdue",
      marketId: "US_EQUITIES",
      source: "LIVE",
      sessionDate: "2026-08-17",
      sessionTimezone: "America/New_York",
      scheduledCloseAt: "2026-08-17T16:00:00.000Z",
      status: "RUNNING",
      executionModelVersion: "v1",
      assumptions: {
        ...assumptions,
        sessionTimezone: "America/New_York",
      },
      startedAt: "2026-08-17T13:30:00.000Z",
      completedAt: null,
      failedAt: null,
      failureReason: null,
    };

    class CrossMarketStore extends FakePaperBotStore {
      override async listUnfinishedLiveRuns(
        marketId?: "CA_TSX" | "US_EQUITIES",
      ): Promise<UnfinishedLiveRun[]> {
        const all = [
          { run: caOverdue, laterSessions: 0 },
          { run: usOverdue, laterSessions: 0 },
        ];
        return marketId
          ? all.filter((item) => item.run.marketId === marketId)
          : all;
      }
      override async settleRunAfterCloseRequest(runId: string) {
        settled.push(runId);
        return "COMPLETED" as const;
      }
    }

    service.setPaperBot(
      new CrossMarketStore(),
      fakeExecutionStore,
      fakeProfiles,
      {
        ...assumptions,
        sessionTimezone: "America/New_York",
      },
      "v1",
    );

    await service.initialize();

    // US service must only settle US overdue runs and ignore CA overdue runs
    expect(settled).toContain("run-us-overdue");
    expect(settled).not.toContain("run-ca-overdue");
  });
});
