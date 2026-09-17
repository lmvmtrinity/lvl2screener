import { describe, expect, it } from "vitest";
import {
  buildObservationPlan,
  evaluateProbeAcceptance,
  feedProbePreflightSchema,
  runFeedProbeAttempt,
  type CallOutcome,
  type FeedProbeDeps,
  type FeedProbePreflight,
  type ProbePerform,
  type WireRecord,
} from "../src/discovery-feed-probe.js";
import type { RawCandle, RawQuote, RawSymbol } from "../src/questrade/types.js";

const BOUNDARY_UTC = "2026-09-16T14:35:00.000Z";
const EXPIRY_UTC = "2026-09-16T14:36:00.000Z";

function preflight(): FeedProbePreflight {
  return feedProbePreflightSchema.parse({
    schemaVersion: "discovery-feed-probe-preflight-v1",
    market: "CA_TSX",
    sessionDate: "2026-09-16",
    boundaryLocal: "10:35",
    timezone: "America/Toronto",
    boundaryUtc: BOUNDARY_UTC,
    expiryUtc: EXPIRY_UTC,
    symbols: [
      { code: "BNS", providerSymbol: "BNS.TO", symbolId: 9339 },
      { code: "CM", providerSymbol: "CM.TO", symbolId: 12108 },
      { code: "CNR", providerSymbol: "CNR.TO", symbolId: 12175 },
      { code: "CSU", providerSymbol: "CSU.TO", symbolId: 14716 },
      { code: "AEM", providerSymbol: "AEM.TO", symbolId: 6849 },
    ],
    sourceRevision: "test-revision",
    dispatchToleranceMs: 2_000,
    responseTimeoutMs: 10_000,
    hardRequestCap: 30,
    discoverySpacingMs: 1_000,
    discoveryHourCap: 1_800,
    monitoringReserveHour: 6_000,
  });
}

function symbolFor(symbolId: number): RawSymbol {
  const match = preflight().symbols.find(
    (symbol) => symbol.symbolId === symbolId,
  )!;
  return {
    symbol: match.providerSymbol,
    symbolId,
    description: "test",
    securityType: "Common Stock",
    listingExchange: "TSX",
    isQuotable: true,
    isTradable: true,
    currency: "CAD",
  };
}

interface HarnessOptions {
  searchResults?: (code: string) => RawSymbol[];
  quoteDelay?: (symbolId: number) => boolean;
  failLabel?: string;
  dispatchDelayMs?: number;
  startAt?: string;
}

function harness(options: HarnessOptions = {}) {
  const start = Date.parse(options.startAt ?? "2026-09-16T14:20:00.000Z");
  let now = start;
  const writes = new Map<string, string>();
  const wire: WireRecord[] = [];
  const deps: FeedProbeDeps = {
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
    connect: async () => ({
      apiServer: "api01.iq.questrade.com",
      expiresAt: "2026-09-16T15:00:00.000Z",
    }),
    perform: (() => {
      throw new Error("perform not configured");
    }) as ProbePerform,
    search: async (prefix) =>
      options.searchResults?.(prefix) ?? [symbolFor(symbolIdFor(prefix))],
    quotes: async (symbolIds) =>
      symbolIds.map((symbolId): RawQuote => ({
        symbol: symbolFor(symbolId).symbol,
        symbolId,
        bidPrice: 99.99,
        bidSize: 10,
        askPrice: 100.01,
        askSize: 10,
        lastTradePrice: 100,
        lastTradeSize: 1,
        lastTradeTime: new Date(now - 2_000).toISOString(),
        volume: 1_000_000,
        openPrice: 99,
        highPrice: 101,
        lowPrice: 98,
        delay: options.quoteDelay?.(symbolId) ?? false,
        isHalted: false,
      })),
    candles: async () => [
      {
        start: new Date(Date.parse(BOUNDARY_UTC) - 300_000).toISOString(),
        end: BOUNDARY_UTC,
        open: 99,
        high: 101,
        low: 98,
        close: 100,
        volume: 100_000,
      } satisfies RawCandle,
    ],
    wire: () => wire,
    rateLimitHeaders: () => [],
    limiterCounts: () => ({ discoveryCompleted: 1 }),
    writeFile: (name, content) => writes.set(name, content),
  };

  const perform: ProbePerform = async <T>(
    label: string,
    _kind: "IDENTITY" | "QUOTE" | "CANDLE",
    _requestedItems: number,
    operation: () => Promise<T>,
  ): Promise<CallOutcome<T>> => {
    const queuedAt = new Date(now).toISOString();
    const delay = options.dispatchDelayMs ?? 0;
    now += delay;
    const dispatchedAt = new Date(now).toISOString();
    if (options.failLabel === label) {
      now += 25;
      return {
        value: null,
        outcome: "FAILED",
        error: "HTTP_500:test",
        queuedAt,
        dispatchedAt,
        settledAt: new Date(now).toISOString(),
        queueWaitMs: 0,
        executionMs: 25,
      };
    }
    const value = await operation();
    now += 25;
    wire.push({
      at: new Date(now).toISOString(),
      url: `https://api01.iq.questrade.com/v1/${label}`,
      status: 200,
      bytes: 10,
      digest: "f".repeat(64),
      text: "{}",
    });
    return {
      value,
      outcome: "COMPLETED",
      error: null,
      queuedAt,
      dispatchedAt,
      settledAt: new Date(now).toISOString(),
      queueWaitMs: 0,
      executionMs: 25,
    };
  };
  deps.perform = perform;
  return { deps, writes, wire };
}

function symbolIdFor(code: string): number {
  return preflight().symbols.find((symbol) => symbol.code === code)!.symbolId;
}

async function run(deps: FeedProbeDeps, preflightValue = preflight()) {
  return runFeedProbeAttempt({
    preflight: preflightValue,
    preflightDigest: "a".repeat(64),
    preflightPath: "/evidence/preflight.json",
    attemptId: "00000000-0000-4000-8000-000000000001",
    imageId: "test-image",
    liveMode: true,
    tradingDay: true,
    deps,
  });
}

describe("discovery feed probe", () => {
  it("plans three quote reads and ten staggered candle reads", () => {
    const plan = buildObservationPlan();
    expect(plan).toHaveLength(13);
    expect(plan.filter((request) => request.kind === "QUOTE")).toHaveLength(3);
    expect(plan.filter((request) => request.kind === "CANDLE")).toHaveLength(
      10,
    );
    expect(plan.map((request) => request.offsetMs)).toEqual(
      [...plan.map((request) => request.offsetMs)].sort(
        (left, right) => left - right,
      ),
    );
    expect(
      plan
        .filter((request) => request.kind === "CANDLE")
        .map((request) => request.symbolIndex),
    ).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
  });

  it("completes and passes acceptance when access, quotes and bars are usable", async () => {
    const { deps, writes } = harness();
    const result = await run(deps);
    expect(result.status).toBe("COMPLETED_ACCEPTED");
    expect(result.acceptance?.passed).toBe(true);
    expect(result.identity.every((symbol) => symbol.accepted)).toBe(true);
    expect(result.calls).toHaveLength(18);
    expect(result.quoteReads).toHaveLength(3);
    expect(result.bars).toHaveLength(10);
    expect(result.calls.every((call) => call.outcome === "COMPLETED")).toBe(
      true,
    );
    expect(writes.has("attempt.json")).toBe(true);
    expect(JSON.parse(writes.get("attempt.json")!)).toMatchObject({
      status: "COMPLETED_ACCEPTED",
    });
  });

  it("blocks on ambiguous identity before any observation request", async () => {
    const { deps } = harness({
      searchResults: (code) => [
        symbolFor(symbolIdFor(code)),
        { ...symbolFor(symbolIdFor(code)), symbolId: 999_999 },
      ],
    });
    const result = await run(deps);
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toBe("IDENTITY_REJECTED:BNS");
    expect(result.identity[0]).toMatchObject({ matches: 2, accepted: false });
    expect(result.quoteReads).toHaveLength(0);
    expect(result.bars).toHaveLength(0);
  });

  it("stops on the first error and leaves later requests unattempted", async () => {
    const { deps } = harness({ failLabel: "quote-read-2" });
    const result = await run(deps);
    expect(result.status).toBe("STOPPED");
    expect(result.reason).toMatch(/^FIRST_ERROR:HTTP_500/);
    const failed = result.calls.find((call) => call.label === "quote-read-2")!;
    expect(failed.outcome).toBe("FAILED");
    const later = result.calls.filter(
      (call) => call.outcome === "NOT_ATTEMPTED",
    );
    expect(later.length).toBeGreaterThan(0);
    expect(result.acceptance).toBeNull();
  });

  it("stops when a quote reports delayed data", async () => {
    const { deps } = harness({ quoteDelay: (symbolId) => symbolId === 12108 });
    const result = await run(deps);
    expect(result.status).toBe("STOPPED");
    expect(result.reason).toBe("QUOTE_DELAY_OR_UNKNOWN");
    expect(result.quoteReads[0]?.delayStop).toBe(true);
  });

  it("stops when a dispatch misses its scheduled offset by more than two seconds", async () => {
    const { deps } = harness({ dispatchDelayMs: 3_000 });
    const result = await run(deps);
    expect(result.status).toBe("STOPPED");
    expect(result.reason).toBe("DISPATCH_OFFSET_EXCEEDED");
    expect(result.calls.some((call) => (call.offsetErrorMs ?? 0) > 2_000)).toBe(
      true,
    );
  });

  it("skips when the attempt window has already elapsed", async () => {
    const { deps } = harness({ startAt: "2026-09-16T14:36:30.000Z" });
    const result = await run(deps);
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toBe("WINDOW_ELAPSED");
    expect(result.calls).toHaveLength(0);
  });

  it("does not pass acceptance when the target bar is missing or unstable", () => {
    const base = {
      calls: [],
      wire: [
        {
          at: EXPIRY_UTC,
          url: "https://api01.iq.questrade.com/v1/markets/quotes",
          status: 200,
          bytes: 1,
          digest: "f".repeat(64),
          text: "{}",
        },
      ],
      identity: preflight().symbols.map((symbol) => ({
        code: symbol.code,
        providerSymbol: symbol.providerSymbol,
        symbolId: symbol.symbolId,
        matches: 1,
        resolvedSymbolId: symbol.symbolId,
        resolvedExchange: "TSX",
        resolvedCurrency: "CAD",
        accepted: true,
        reason: null,
      })),
      quoteReads: [1, 2, 3].map((readIndex) => ({
        readIndex,
        plannedOffsetMs: readIndex * 5_000,
        settledAt: EXPIRY_UTC,
        symbols: preflight().symbols.map((symbol) => ({
          code: symbol.code,
          providerSymbol: symbol.providerSymbol,
          symbolId: symbol.symbolId,
          returned: true,
          delay: false,
          isHalted: false,
          lastTradeTime: "2026-09-16T14:34:58.000Z",
          lastTradeAgeMs: 2_000,
        })),
        delayStop: false,
      })),
      bars: preflight().symbols.flatMap((symbol) =>
        [1, 2].map((readIndex) => ({
          code: symbol.code,
          symbolId: symbol.symbolId,
          readIndex,
          targetStart: "2026-09-16T14:30:00.000Z",
          targetEnd: BOUNDARY_UTC,
          present: readIndex === 1,
          ohlcv: { open: 99, high: 101, low: 98, close: 100, volume: 1_000 },
        })),
      ),
      boundaryUtc: BOUNDARY_UTC,
      expiryUtc: EXPIRY_UTC,
      completedAt: EXPIRY_UTC,
    };
    const evaluation = evaluateProbeAcceptance(base);
    expect(evaluation.checks.barsPresentBothReads).toBe(false);
    expect(evaluation.passed).toBe(false);

    const unstable = {
      ...base,
      bars: base.bars.map((bar) => ({
        ...bar,
        present: true,
        ohlcv: { ...bar.ohlcv, close: bar.readIndex === 1 ? 100 : 101 },
      })),
    };
    const unstableEvaluation = evaluateProbeAcceptance(unstable);
    expect(unstableEvaluation.checks.barsPresentBothReads).toBe(true);
    expect(unstableEvaluation.checks.barsStableAcrossReads).toBe(false);
    expect(unstableEvaluation.passed).toBe(false);
  });
});
