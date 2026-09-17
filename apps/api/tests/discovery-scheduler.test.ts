import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoveryModeStateSchema,
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
  type DiscoveryEvaluationInput,
  type DiscoveryEvaluationResult,
  type DiscoveryRun,
} from "@tsx-scanner/contracts";
import {
  EodhdCatalogClient,
  type CatalogSnapshot,
  type CatalogSnapshotStore,
} from "../src/universe/eodhd-catalog.js";
import type {
  DiscoveryControlStore,
  DiscoveryLease,
  DiscoveryLeaseKey,
  DiscoveryModeChange,
} from "../src/universe/discovery-control-repository.js";
import {
  DiscoveryScheduler,
  type DiscoveryEvaluationEngine,
  type DiscoveryInputSource,
  type DiscoveryBrokerMetrics,
} from "../src/universe/discovery-scheduler.js";
import {
  DiscoveryWritePerformanceAttempt,
  type DiscoveryScheduledRunRecovery,
} from "../src/universe/discovery-evidence-repository.js";
import type { FastFunnelAccelerator } from "../src/universe/fast-funnel-accelerator.js";
import type { TradingViewShadowComparator } from "../src/universe/tradingview-shadow-comparator.js";
import { QuestradeDiscoveryInputSource } from "../src/universe/questrade-discovery-input-source.js";
import { DiscoverySymbolMapper } from "../src/universe/discovery-mapping.js";
import type { MarketDataAdapter } from "../src/questrade/types.js";
import type { DiscoveryAttemptDiagnosticsDraft } from "../src/universe/discovery-attempt-diagnostics.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/fixtures/discovery-evaluation-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
)[0] as { input: DiscoveryEvaluationInput; result: DiscoveryEvaluationResult };

const now = new Date("2026-11-03T14:40:15Z");
const session = {
  marketStatus: "OPEN",
  startTime: new Date("2026-11-03T13:30:00Z"),
  endTime: new Date("2026-11-03T20:00:00Z"),
};

function catalogStore(): CatalogSnapshotStore & {
  snapshot: CatalogSnapshot | null;
} {
  return {
    snapshot: null,
    async loadLatest() {
      return this.snapshot;
    },
    async save(snapshot) {
      this.snapshot = snapshot;
    },
  };
}

function leaseFor(key: DiscoveryLeaseKey, ownerToken: string): DiscoveryLease {
  return {
    ...key,
    ownerToken,
    fencingGeneration: 1,
    runId: null,
    leaseExpiresAt: new Date(now.getTime() + 600_000).toISOString(),
  };
}

function runFor(input: DiscoveryEvaluationInput): DiscoveryRun {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    marketId: input.marketId,
    tradingDate: input.tradingDate,
    policyVersion: input.policyVersion,
    mode: "SHADOW",
    evaluationAt: input.evaluationAt,
    completedBarEnd: input.completedBarEnd,
    catalogDigest: "a".repeat(64),
    status: "RUNNING",
    coverage: { total: 1, pass: 0, fail: 0, unevaluable: 0, deferred: 1 },
    startedAt: input.evaluationAt,
    completedAt: null,
    failure: null,
  };
}

function setup(
  overrides: {
    source?: DiscoveryInputSource;
    engine?: DiscoveryEvaluationEngine;
    brokerMetrics?: DiscoveryBrokerMetrics;
    onBuild?: (advanceClock: () => void, signal?: AbortSignal) => void;
    recovery?: DiscoveryScheduledRunRecovery;
    recoveryLeaseRunId?: boolean;
    failRecoveryLoad?: boolean;
    reclaimedLease?: DiscoveryLease;
    writePerformance?: { serializationMs: number; persistenceMs: number };
    fastFunnelAccelerator?: FastFunnelAccelerator;
    shadowComparator?: TradingViewShadowComparator;
    catalogRows?: Array<Record<string, string>>;
    workerConcurrency?: number;
    failRecord?: boolean;
    onComplete?: () => void;
  } = {},
) {
  const store = catalogStore();
  if (overrides.recovery) store.snapshot = overrides.recovery.catalog;
  let clockNow = new Date(now);
  const control: DiscoveryControlStore = {
    mode: discoveryModeStateSchema.parse({
      marketId: "CA_TSX",
      mode: "OFF",
      revision: 0,
      updatedAt: now.toISOString(),
      actor: "test",
      reason: "fixture",
    }),
    async getMode() {
      return this.mode;
    },
    async changeMode(input: DiscoveryModeChange) {
      this.mode = discoveryModeStateSchema.parse({
        marketId: input.marketId,
        mode: input.mode,
        revision: this.mode.revision + 1,
        updatedAt: now.toISOString(),
        actor: input.actor,
        reason: input.reason,
      });
      return this.mode;
    },
    claimed: new Set<string>(),
    async claim(key, ownerToken) {
      if (this.claimed.has(key.idempotencyKey)) return null;
      this.claimed.add(key.idempotencyKey);
      return {
        ...leaseFor(key, ownerToken),
        runId:
          overrides.recovery && overrides.recoveryLeaseRunId !== false
            ? overrides.recovery.run.id
            : null,
      };
    },
    async reclaimExpired() {
      return overrides.reclaimedLease ?? null;
    },
    async bindRun(lease, runId) {
      return { ...lease, runId };
    },
    async renew(lease) {
      return lease;
    },
    async release() {
      return true;
    },
  } as DiscoveryControlStore & {
    mode: ReturnType<typeof discoveryModeStateSchema.parse>;
    claimed: Set<string>;
  };
  const records: DiscoveryEvaluationResult[] = [];
  const writePerformanceAttempts: DiscoveryWritePerformanceAttempt[] = [];
  const beginWritePerformanceAttempt = vi.fn(() => {
    const attempt = new DiscoveryWritePerformanceAttempt();
    if (overrides.writePerformance)
      attempt.record(
        overrides.writePerformance.serializationMs,
        overrides.writePerformance.persistenceMs,
      );
    writePerformanceAttempts.push(attempt);
    return attempt;
  });
  let completed: DiscoveryRun | null = null;
  const completionDiagnostics: Array<
    DiscoveryAttemptDiagnosticsDraft | undefined
  > = [];
  let activeRun: DiscoveryRun | null = overrides.recovery?.run ?? null;
  const begin = vi.fn(
    async (request: {
      catalog: CatalogSnapshot;
      mode: "SHADOW";
      evaluationAt: string;
      completedBarEnd: string;
      marketId: "CA_TSX";
      tradingDate: string;
      idempotencyKey: string;
    }) => {
      activeRun = runFor({ ...fixture.input, ...request });
      return activeRun;
    },
  );
  const evidence = {
    begin,
    async recordOwned(
      _runId: string,
      _lease: DiscoveryLease,
      result: DiscoveryEvaluationResult,
      _input: DiscoveryEvaluationInput | null,
      _performanceAttempt: DiscoveryWritePerformanceAttempt,
    ) {
      if (overrides.failRecord) throw new Error("fixture persistence failure");
      records.push(result);
      return {};
    },
    async completeOwned(
      runId: string,
      _lease: DiscoveryLease,
      _failure?: unknown,
      diagnostics?: DiscoveryAttemptDiagnosticsDraft,
    ) {
      completionDiagnostics.push(diagnostics);
      overrides.onComplete?.();
      completed = {
        ...runFor({
          ...fixture.input,
          evaluationAt: activeRun?.evaluationAt ?? now.toISOString(),
          completedBarEnd: activeRun?.completedBarEnd ?? "2026-11-03T14:40:00Z",
        }),
        id: runId,
        status: "COMPLETED",
        completedAt: now.toISOString(),
        coverage: {
          total: 1,
          pass:
            records.filter((value) => value.state === "PASS").length +
            (overrides.recovery?.evaluated.length ?? 0),
          fail: records.filter((value) => value.state === "FAIL").length,
          unevaluable: records.filter((value) => value.state === "UNEVALUABLE")
            .length,
          deferred: records.filter((value) => value.state === "DEFERRED")
            .length,
        },
      };
      return completed;
    },
    async complete() {
      throw new Error("unfenced completion should not be used");
    },
    beginWritePerformanceAttempt,
    async listRuns() {
      return completed ? [completed] : [];
    },
    async loadScheduledRun() {
      if (overrides.failRecoveryLoad)
        throw new Error("fixture recovery load failure");
      return overrides.recovery ?? null;
    },
    async loadScheduledRunByKey() {
      return overrides.recovery ?? null;
    },
  };
  const client = new EodhdCatalogClient(
    "fixture-token",
    store,
    async () =>
      Response.json(
        overrides.catalogRows ?? [
          {
            Code: "EXAMPLE",
            Name: "Example common stock",
            Exchange: "TSX",
            Currency: "CAD",
            Type: "Common Stock",
          },
        ],
      ),
    () => now,
  );
  const source: DiscoveryInputSource = {
    async build(_member, context) {
      overrides.onBuild?.(() => {
        clockNow = new Date(clockNow.getTime() + 1_000);
      }, context.signal);
      return {
        input: discoveryEvaluationInputSchema.parse({
          ...fixture.input,
          evaluationAt: context.evaluationAt,
          completedBarEnd: context.completedBarEnd,
        }),
        reasons: [],
        symbolId: 123,
      };
    },
  };
  const engine: DiscoveryEvaluationEngine = {
    async evaluateDiscovery(input) {
      return discoveryEvaluationResultSchema.parse({
        ...fixture.result,
        evaluationAt: input.evaluationAt,
        completedBarEnd: input.completedBarEnd,
        computedAt: input.evaluationAt,
      });
    },
  };
  const scheduler = new DiscoveryScheduler({
    marketId: "CA_TSX",
    catalogClient: client,
    catalogStore: store,
    controlStore: control,
    evidenceStore: evidence as never,
    inputSource: overrides.source ?? source,
    engine: overrides.engine ?? engine,
    session: { getSnapshot: () => session },
    brokerMetrics: overrides.brokerMetrics,
    clock: () => clockNow,
    pollIntervalMs: 60_000,
    workerConcurrency: overrides.workerConcurrency ?? 1,
    fastFunnelAccelerator: overrides.fastFunnelAccelerator,
    shadowComparator: overrides.shadowComparator,
  });
  return {
    scheduler,
    control,
    records,
    getCompleted: () => completed,
    begin,
    beginWritePerformanceAttempt,
    writePerformanceAttempts,
    completionDiagnostics,
    advanceClock: (ms: number) => {
      clockNow = new Date(clockNow.getTime() + ms);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("discovery shadow scheduler", () => {
  it("labels a known recovery whose load rejects without persisting an unloaded run diagnostic", async () => {
    const f = setup({
      failRecoveryLoad: true,
      reclaimedLease: {
        ...leaseFor(
          {
            marketId: "CA_TSX",
            tradingDate: "2026-11-03",
            policyVersion: "ca-discovery-v1",
            completedBarEnd: "2026-11-03T14:35:00.000Z",
            idempotencyKey:
              "scheduled:CA_TSX:2026-11-03:2026-11-03T14:35:00.000Z",
          },
          "reclaimed-owner",
        ),
        runId: "10000000-0000-4000-8000-000000000001",
      },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "recovery load rejection fixture",
      actor: "test",
    });

    expect(await f.scheduler.runOnce()).toBeNull();
    expect(f.scheduler.getLastAttemptDiagnostics()).toMatchObject({
      marketId: "CA_TSX",
      attemptKind: "RECOVERY",
    });
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(0);
    expect(f.completionDiagnostics).toHaveLength(0);
    expect(f.getCompleted()).toBeNull();
  });

  it.each([false, true])(
    "hands the terminal draft to fenced completion (write failure=%s)",
    async (failRecord) => {
      const f = setup({ failRecord });
      const run = await f.scheduler.preview();
      expect(run).not.toBeNull();
      expect(f.completionDiagnostics).toHaveLength(1);
      expect(f.completionDiagnostics[0]).toMatchObject({
        marketId: "CA_TSX",
        attemptKind: "FRESH",
      });
      expect(f.completionDiagnostics[0]?.attemptId).toEqual(
        f.scheduler.getLastAttemptDiagnostics()?.attemptId,
      );
    },
  );
  it("freezes durable timing before completion while retaining its latency in the transient terminal draft", async () => {
    let monotonicNow = 0;
    const timer = vi
      .spyOn(performance, "now")
      .mockImplementation(() => monotonicNow);
    try {
      const f = setup({
        onComplete: () => {
          monotonicNow += 250;
        },
      });
      await f.scheduler.preview();
      expect(f.completionDiagnostics[0]).toMatchObject({
        wallMs: 0,
        stages: { EVIDENCE: { calls: 2, wallMs: 0, cumulativeMs: 0 } },
      });
      expect(f.scheduler.getLastAttemptDiagnostics()).toMatchObject({
        wallMs: 250,
        stages: { EVIDENCE: { calls: 3, wallMs: 250, cumulativeMs: 250 } },
      });
    } finally {
      timer.mockRestore();
    }
  });
  it("includes failure finalization in evidence timing without counting unwritten results", async () => {
    const f = setup({ failRecord: true });
    await f.scheduler.preview();
    expect(f.scheduler.getLastAttemptDiagnostics()).toMatchObject({
      stages: { EVIDENCE: { calls: 3 } },
      reasonCounts: {},
      quoteAgeBuckets: { missing: 0, future: 0, fresh: 0, stale: 0 },
    });
  });
  it.each([false, true])(
    "attributes real four-worker enrichment occupancy (coincident=%s)",
    async (coincident) => {
      const releases: Array<() => void> = [];
      const quoteBatches: number[][] = [];
      const adapter = {
        searchSymbols: async (prefix: string) => {
          await new Promise<void>((resolve) => releases.push(resolve));
          return [
            {
              symbol: `${prefix}.TO`,
              symbolId: Number(prefix.slice(1)) + 1,
              description: "Fixture",
              securityType: "Common Stock",
              exchange: "TSX",
              currency: "CAD",
              isQuotable: true,
              isTradable: true,
            },
          ];
        },
        getFundamentals: async () => [],
        getQuotes: async (ids: number[]) => {
          quoteBatches.push(ids);
          return [];
        },
      } as unknown as MarketDataAdapter;
      const source = new QuestradeDiscoveryInputSource(
        adapter,
        new DiscoverySymbolMapper(
          adapter,
          { load: async () => null, save: async () => {} },
          () => now,
        ),
        "CA_TSX",
        { getMarket: () => session, getSnapshot: () => ({ observedAt: now }) },
        () => now,
      );
      const f = setup({
        source,
        workerConcurrency: 4,
        catalogRows: Array.from({ length: 4 }, (_, index) => ({
          Code: `S${index}`,
          Name: "Fixture",
          Exchange: "TSX",
          Currency: "CAD",
          Type: "Common Stock",
        })),
      });
      const operation = f.scheduler.preview();
      await vi.waitFor(() => expect(releases).toHaveLength(4));
      if (coincident) releases.forEach((release) => release());
      else
        for (const [index, release] of releases.entries()) {
          release();
          await vi.waitFor(() => expect(quoteBatches).toHaveLength(index + 1));
        }
      await operation;
      const diagnostics = f.scheduler.getLastAttemptDiagnostics();
      expect(diagnostics).toMatchObject({
        marketId: "CA_TSX",
        attemptKind: "FRESH",
        stages: {
          ENRICHMENT: {
            batches: {
              count: coincident ? 1 : 4,
              minSize: coincident ? 4 : 1,
              maxSize: coincident ? 4 : 1,
              members: 4,
              uniqueSymbols: 4,
            },
          },
          EVIDENCE: { calls: 6 },
        },
        reasonCounts: { METADATA_UNAVAILABLE: 4 },
        quoteAgeBuckets: { missing: 4, future: 0, fresh: 0, stale: 0 },
      });
      expect(f.records).toHaveLength(4);
      expect(f.begin.mock.calls[0]![0]).not.toHaveProperty("attemptId");
      expect(f.begin.mock.calls[0]![0]).not.toHaveProperty("diagnostics");
    },
  );
  it("records expired collection as deferred instead of letting a run wait indefinitely", async () => {
    let expiryReason: unknown;
    const f = setup({
      onBuild: (advance, signal) => {
        signal?.addEventListener(
          "abort",
          () => {
            expiryReason = signal.reason;
          },
          { once: true },
        );
        for (let i = 0; i < 121; i++) advance();
      },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "test",
      actor: "test",
    });
    await f.scheduler.runOnce();
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      state: "DEFERRED",
      reasons: ["EVALUATION_EXPIRED"],
    });
    expect(expiryReason).toMatchObject({ code: "EXPIRED" });
  });
  it("aborts provider work at the same fixed collection deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = setup({
      source: {
        async build(_member, context) {
          signal = context.signal;
          started();
          return new Promise(() => {});
        },
      },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "fixed deadline cancellation fixture",
      actor: "test",
    });

    const cycle = f.scheduler.runOnce();
    await buildStarted;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(cycle).resolves.toMatchObject({
      coverage: { total: 1, deferred: 1 },
    });
    expect(signal?.aborted).toBe(true);
  });
  it("aborts queued sibling provider work when input assembly fails", async () => {
    let signal: AbortSignal | undefined;
    let siblingAborted = false;
    const f = setup({
      source: {
        async build(_member, context) {
          signal = context.signal;
          const queuedSibling = new Promise<never>((_, reject) => {
            context.signal?.addEventListener(
              "abort",
              () => {
                siblingAborted = true;
                reject(context.signal?.reason);
              },
              { once: true },
            );
          });
          await Promise.all([
            Promise.reject(new Error("fundamentals request failed")),
            queuedSibling,
          ]);
          throw new Error("unreachable");
        },
      },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "sibling cancellation fixture",
      actor: "test",
    });

    await f.scheduler.runOnce();

    expect(signal?.aborted).toBe(true);
    expect(siblingAborted).toBe(true);
  });
  it("does no work while the authoritative mode is OFF", async () => {
    const f = setup();
    expect(await f.scheduler.runOnce()).toBeNull();
    expect(f.records).toEqual([]);
  });

  it("claims one completed bar and records a durable shadow result", async () => {
    const f = setup();
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "shadow fixture",
      actor: "test",
    });
    const run = await f.scheduler.runOnce();
    expect(run).toMatchObject({ status: "COMPLETED", coverage: { pass: 1 } });
    expect(f.records).toHaveLength(1);
    expect(await f.scheduler.runOnce()).toBeNull();
  });

  it("exposes bounded cycle and queue performance after a completed run", async () => {
    const f = setup();
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "performance fixture",
      actor: "test",
    });

    await f.scheduler.runOnce();

    await expect(f.scheduler.getStatus()).resolves.toMatchObject({
      queueDepth: 0,
      performance: {
        sampleCount: 1,
        lastCycleDurationMs: 0,
        lastQueueLatencyMs: 0,
        cycleP95Ms: 0,
        queueP95Ms: 0,
        phases: {
          inputCollectionElapsedMs: expect.any(Number),
          evaluationWorkMs: expect.any(Number),
          serializationWorkMs: null,
          persistenceWorkMs: expect.any(Number),
        },
      },
    });
  });

  it("attributes broker request outcomes to the completed discovery run", async () => {
    const counts = {
      completed: 0,
      failed: 0,
      queued: 0,
      active: 0,
      discoveryCompleted: 0,
      discoveryFailed: 0,
      discoveryCancelled: 0,
      discoveryExpired: 0,
    };
    const f = setup({
      brokerMetrics: { requestCounts: counts },
      onBuild: () => {
        counts.discoveryCompleted = 2;
        counts.discoveryFailed = 1;
        counts.discoveryCancelled = 1;
        counts.discoveryExpired = 1;
      },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "request usage fixture",
      actor: "test",
    });

    await f.scheduler.runOnce();

    await expect(f.scheduler.getStatus()).resolves.toMatchObject({
      performance: {
        requestUsage: {
          completed: 2,
          failed: 1,
          cancelled: 1,
          expired: 1,
        },
      },
    });
  });

  it("freezes evaluationAt only after input collection and preserves observations", async () => {
    let builds = 0;
    const f = setup({
      onBuild: (advanceClock) => {
        builds += 1;
        advanceClock();
      },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "post-collection boundary fixture",
      actor: "test",
    });

    const run = await f.scheduler.runOnce();

    expect(builds).toBe(1);
    expect(run?.evaluationAt).toBe("2026-11-03T14:40:16.000Z");
    expect(f.records[0]?.evaluationAt).toBe(run?.evaluationAt);
  });

  it("classifies quote ages against completion of collection rather than its start", async () => {
    const f = setup({
      source: {
        async build(_member, context) {
          f.advanceClock(40_000);
          return {
            symbolId: 123,
            reasons: [],
            input: discoveryEvaluationInputSchema.parse({
              ...fixture.input,
              evaluationAt: context.evaluationAt,
              completedBarEnd: context.completedBarEnd,
              quote: {
                ...fixture.input.quote,
                observedAt: now.toISOString(),
                priceAt: now.toISOString(),
              },
            }),
          };
        },
      },
    });
    await f.scheduler.preview();
    expect(f.scheduler.getLastAttemptDiagnostics()?.quoteAgeBuckets).toEqual({
      missing: 0,
      future: 0,
      fresh: 0,
      stale: 1,
    });
  });

  it("reclaims a running run with its original catalog and starts isolated phase timing", async () => {
    const catalog = {
      source: "EODHD" as const,
      marketId: "CA_TSX" as const,
      tradingDate: "2026-11-03",
      fetchedAt: "2026-11-03T13:40:00.000Z",
      digest: "a".repeat(64),
      providerDigest: null,
      rowCount: 1,
      admittedCount: 1,
      members: [
        {
          providerCode: "EXAMPLE",
          raw: {
            Code: "EXAMPLE",
            Name: "Example common stock",
            Exchange: "TSX",
            Currency: "CAD",
            Type: "Common Stock",
          },
          reasons: [],
          resolutionStatus: "PENDING" as const,
        },
      ],
    };
    const recoveryRun = runFor(fixture.input);
    const f = setup({
      recovery: {
        run: recoveryRun,
        catalog,
        evaluated: [
          {
            providerExchange: "TSX",
            providerCode: "EXAMPLE",
          },
        ],
      },
      recoveryLeaseRunId: false,
      writePerformance: { serializationMs: 777, persistenceMs: 888 },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "recovery fixture",
      actor: "test",
    });

    const run = await f.scheduler.runOnce();

    expect(run).toMatchObject({ id: recoveryRun.id, status: "COMPLETED" });
    expect(f.records).toHaveLength(0);
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.beginWritePerformanceAttempt).toHaveBeenCalledTimes(1);
    expect(f.writePerformanceAttempts[0]?.take()).toBeNull();
    await expect(f.scheduler.getStatus()).resolves.toMatchObject({
      performance: {
        phases: {
          serializationWorkMs: 777,
          persistenceWorkMs: 888,
        },
      },
    });
    const firstAttempt = f.scheduler.getLastAttemptDiagnostics();
    expect(firstAttempt).toMatchObject({
      attemptKind: "RECOVERY",
      marketId: "CA_TSX",
      reasonCounts: {},
    });
    expect(firstAttempt?.attemptId).not.toBe(recoveryRun.id);
    const retriedRun = await f.scheduler.preview();
    expect(retriedRun?.id).toBe(recoveryRun.id);
    expect(f.scheduler.getLastAttemptDiagnostics()?.attemptId).not.toBe(
      firstAttempt?.attemptId,
    );
    expect(f.scheduler.getLastAttemptDiagnostics()?.attemptKind).toBe(
      "RECOVERY",
    );
  });

  it("reconciles an expired run before claiming a later bar cycle", async () => {
    const recoveryRun = runFor(fixture.input);
    const f = setup({
      recovery: {
        run: recoveryRun,
        catalog: {
          source: "EODHD",
          marketId: "CA_TSX",
          tradingDate: "2026-11-03",
          fetchedAt: "2026-11-03T13:40:00.000Z",
          digest: "a".repeat(64),
          providerDigest: null,
          rowCount: 1,
          admittedCount: 1,
          members: [],
        },
        evaluated: [],
      },
      reclaimedLease: {
        ...leaseFor(
          {
            marketId: "CA_TSX",
            tradingDate: "2026-11-03",
            policyVersion: "ca-discovery-v1",
            completedBarEnd: "2026-11-03T14:35:00.000Z",
            idempotencyKey:
              "scheduled:CA_TSX:2026-11-03:2026-11-03T14:35:00.000Z",
          },
          "reclaimed-owner",
        ),
        runId: recoveryRun.id,
      },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "later-cycle recovery fixture",
      actor: "test",
    });

    const run = await f.scheduler.runOnce();

    expect(run).toMatchObject({ id: recoveryRun.id, status: "COMPLETED" });
    expect(f.begin).not.toHaveBeenCalled();
  });

  it("preview remains shadow-only even when the configured mode is OFF", async () => {
    const f = setup();
    const run = await f.scheduler.preview();
    expect(run).toMatchObject({ mode: "SHADOW", status: "COMPLETED" });
    expect(f.records[0]?.state).toBe("PASS");
  });

  it("records provider failures as unevaluable instead of budget deferral", async () => {
    const f = setup({
      source: {
        async build() {
          throw new Error("provider unavailable");
        },
      },
    });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "provider failure fixture",
      actor: "test",
    });
    const run = await f.scheduler.runOnce();
    expect(run).toMatchObject({
      status: "COMPLETED",
      coverage: { unevaluable: 1, deferred: 0 },
    });
    expect(f.records[0]).toMatchObject({
      state: "UNEVALUABLE",
      reasons: ["PROVIDER_FAILURE"],
    });
  });

  it("prioritizes catalog members when fastFunnelAccelerator is enabled", async () => {
    const prioritizeCatalogMembers = vi.fn((members) => [...members]);
    const recordCycleResults = vi.fn();
    const mockAccelerator = {
      isEnabled: () => true,
      getTopMovers: vi.fn(async () => ["EXAMPLE"]),
      prioritizeCatalogMembers,
      recordCycleResults,
      getStatus: vi.fn(() => ({
        marketId: "CA_TSX" as const,
        enabled: true,
        lastAcceleratedAt: "2026-11-03T14:40:15.000Z",
        topMoversCount: 1,
        topMoverSymbols: ["EXAMPLE"],
        acceleratedCandidatesCount: 1,
        acceleratedEvaluatedCount: 1,
        acceleratedPassedCount: 1,
      })),
    } as unknown as FastFunnelAccelerator;

    const f = setup({ fastFunnelAccelerator: mockAccelerator });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "fast funnel test",
      actor: "test",
    });

    await f.scheduler.runOnce();

    expect(mockAccelerator.getTopMovers).toHaveBeenCalled();
    expect(prioritizeCatalogMembers).toHaveBeenCalled();
    expect(recordCycleResults).toHaveBeenCalledWith({
      acceleratedCount: 1,
      evaluatedCount: 1,
      passedCount: 1,
    });

    const status = await f.scheduler.getStatus();
    expect(status.fastFunnel).toMatchObject({
      enabled: true,
      topMoversCount: 1,
      topMoverSymbols: ["EXAMPLE"],
    });
  });

  it("triggers parity audit when shadowComparator is configured", async () => {
    const auditParity = vi.fn(async () => ({}) as any);
    const mockComparator = {
      auditParity,
      getStatus: vi.fn(async () => ({
        marketId: "CA_TSX" as const,
        lastAuditedAt: "2026-11-03T14:40:15.000Z",
        auditCount: 1,
        averageOverlapRatio: 0.9,
        latestAudit: null,
      })),
    } as unknown as TradingViewShadowComparator;

    const f = setup({ shadowComparator: mockComparator });
    await f.control.changeMode({
      marketId: "CA_TSX",
      mode: "SHADOW",
      expectedRevision: 0,
      reason: "shadow comparator test",
      actor: "test",
    });

    const run = await f.scheduler.runOnce();
    expect(run).not.toBeNull();
    expect(auditParity).toHaveBeenCalledWith(run?.id);

    const status = await f.scheduler.getStatus();
    expect(status.parity).toMatchObject({
      marketId: "CA_TSX",
      auditCount: 1,
      averageOverlapRatio: 0.9,
    });
  });

  it("does not audit parity for preview runs that persist no evaluations", async () => {
    const auditParity = vi.fn(async () => ({}) as any);
    const mockComparator = {
      auditParity,
      getStatus: vi.fn(async () => ({
        marketId: "CA_TSX" as const,
        lastAuditedAt: null,
        auditCount: 0,
        averageOverlapRatio: null,
        latestAudit: null,
      })),
    } as unknown as TradingViewShadowComparator;

    const f = setup({ shadowComparator: mockComparator });
    const run = await f.scheduler.preview();
    expect(run).not.toBeNull();
    expect(auditParity).not.toHaveBeenCalled();
  });
});
