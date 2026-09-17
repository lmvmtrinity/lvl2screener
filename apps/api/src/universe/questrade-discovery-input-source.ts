import type {
  DiscoveryEvaluationInput,
  DiscoveryReason,
  MarketId,
} from "@tsx-scanner/contracts";
import {
  discoveryEvaluationInputSchema,
  discoveryPolicyForMarket,
} from "@tsx-scanner/contracts";
import { normalizeExchange } from "../questrade/exchange.js";
import type {
  Candle,
  InstrumentFundamentals,
  MarketDataAdapter,
  MarketDataRequestOptions,
  Quote,
} from "../questrade/types.js";
import { DiscoverySymbolMapper } from "./discovery-mapping.js";
import type { DiscoveryAttemptDiagnosticsCollector } from "./discovery-attempt-diagnostics.js";
import type { CatalogMember } from "./eodhd-catalog.js";
import type {
  DiscoveryInputContext,
  DiscoveryInputPreparation,
  DiscoveryInputSource,
} from "./discovery-scheduler.js";
import {
  calendarProvenanceFor,
  getRecentRegularSessions,
} from "./market-calendar.js";

const DEFAULT_ADJUSTMENT_REVISION = "questrade-candles-v1";
// The evaluator policy needs 91 completed sessions and the shared contract caps
// dailyBars at 400. The cache may hold more (600-day fetch), so only the most
// recent bounded slice is sent.
const DAILY_BAR_LIMIT = 400;
// The shared contract caps slotBars at 2,000. The 21-day slot window holds about
// 1,100 regular-session bars, so this is a defensive bound.
const SLOT_BAR_LIMIT = 2_000;
// This is the existing application batching choice used by quote collection.
// It is deliberately not a claim about a provider maximum.
const DISCOVERY_ENRICHMENT_BATCH_SIZE = 50;

interface CachedCandle {
  bar: Candle;
  observedAt: string;
}

interface Enrichment {
  fundamental: InstrumentFundamentals | undefined;
  quote: Quote | undefined;
}

interface EnrichmentRequest {
  symbolId: number;
  options: MarketDataRequestOptions | undefined;
  diagnostics: DiscoveryAttemptDiagnosticsCollector | undefined;
  settled: boolean;
  resolve: (value: Enrichment) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

interface BatchRequestOptions {
  options: MarketDataRequestOptions | undefined;
  cleanup: () => void;
}

/**
 * Coalesces only the cheap, adapter-supported enrichment requests issued by a
 * single market-scoped discovery source. Mapping and candle preparation remain
 * per-member so their evidence identity, deadlines and outcome handling stay
 * unchanged.
 */
class DiscoveryEnrichmentBatcher {
  private readonly pending: EnrichmentRequest[] = [];
  private flushScheduled = false;

  constructor(private readonly adapter: MarketDataAdapter) {}

  collect(
    symbolId: number,
    options?: MarketDataRequestOptions,
    diagnostics?: DiscoveryAttemptDiagnosticsCollector,
  ): Promise<Enrichment> {
    return new Promise<Enrichment>((resolve, reject) => {
      const signal = options?.signal;
      const settle = (complete: () => void) => {
        if (request.settled) return;
        request.settled = true;
        request.cleanup();
        complete();
      };
      const abort = () => request.reject(cancellationError(signal));
      const request: EnrichmentRequest = {
        symbolId,
        options,
        diagnostics,
        settled: false,
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(request);
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const pending = this.pending.splice(0);
      for (const batch of this.batches(pending)) void this.execute(batch);
    });
  }

  private batches(
    requests: readonly EnrichmentRequest[],
  ): EnrichmentRequest[][] {
    const byDeadline = new Map<string, EnrichmentRequest[]>();
    for (const request of requests) {
      const groupKey = `${request.options?.observation?.attemptId ?? "none"}\u0000${request.options?.expiresAt?.getTime() ?? "none"}`;
      const group = byDeadline.get(groupKey) ?? [];
      group.push(request);
      byDeadline.set(groupKey, group);
    }
    return [...byDeadline.values()].flatMap((group) => {
      const batches: EnrichmentRequest[][] = [];
      for (
        let index = 0;
        index < group.length;
        index += DISCOVERY_ENRICHMENT_BATCH_SIZE
      )
        batches.push(
          group.slice(index, index + DISCOVERY_ENRICHMENT_BATCH_SIZE),
        );
      return batches;
    });
  }

  private async execute(requests: EnrichmentRequest[]): Promise<void> {
    const active = requests.filter((request) => !request.settled);
    if (active.length === 0) return;
    const symbolIds = [...new Set(active.map((request) => request.symbolId))];
    const diagnostics = active[0]?.diagnostics;
    diagnostics?.recordBatch("ENRICHMENT", {
      members: active.length,
      uniqueSymbols: symbolIds.length,
    });
    const stopTiming = diagnostics?.startStage("ENRICHMENT");
    const { options, cleanup } = batchOptions(active);
    try {
      const [fundamentals, quotes] = await Promise.all([
        this.adapter.getFundamentals?.(symbolIds, options) ??
          Promise.resolve([]),
        this.adapter.getQuotes(symbolIds, options),
      ]);
      const fundamentalsById = new Map(
        fundamentals.map((fundamental) => [fundamental.symbolId, fundamental]),
      );
      const quotesById = new Map(
        quotes.map((quote) => [quote.symbolId, quote]),
      );
      for (const request of active)
        request.resolve({
          fundamental: fundamentalsById.get(request.symbolId),
          quote: quotesById.get(request.symbolId),
        });
    } catch (error) {
      for (const request of active) request.reject(error);
    } finally {
      stopTiming?.();
      cleanup();
    }
  }
}

function cancellationError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  const code =
    typeof reason === "object" && reason !== null && "code" in reason
      ? reason.code
      : null;
  return Object.assign(new Error("Discovery enrichment request cancelled"), {
    code: code === "EXPIRED" ? "EXPIRED" : "CANCELLED",
  });
}

function batchOptions(
  requests: readonly EnrichmentRequest[],
): BatchRequestOptions {
  const first = requests[0]?.options;
  if (requests.every((request) => request.options?.signal === first?.signal))
    return { options: first, cleanup: () => {} };
  const controller = new AbortController();
  let activeRequests = requests.length;
  const cleanup: Array<() => void> = [];
  for (const request of requests) {
    const signal = request.options?.signal;
    if (!signal) continue;
    const abort = () => {
      activeRequests--;
      if (activeRequests === 0 && !controller.signal.aborted)
        controller.abort(signal.reason);
    };
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      cleanup.push(() => signal.removeEventListener("abort", abort));
    }
  }
  return {
    options: {
      signal: controller.signal,
      expiresAt: first?.expiresAt,
      observation: first?.observation,
    },
    cleanup: () => {
      for (const dispose of cleanup) dispose();
    },
  };
}

/**
 * Questrade-backed input assembly for WP4. Broker data is useful for shadow
 * diagnostics, but calendar and corporate-action provenance deliberately remain
 * unverified until a provider-backed validation path is supplied. That makes
 * the evaluator produce visible UNEVALUABLE results instead of false passes.
 */
export class QuestradeDiscoveryInputSource implements DiscoveryInputSource {
  private readonly candleCache = new Map<string, CachedCandle[]>();
  private readonly enrichment: DiscoveryEnrichmentBatcher;

  constructor(
    private readonly adapter: MarketDataAdapter,
    private readonly mapper: DiscoverySymbolMapper,
    private readonly marketId: MarketId,
    private readonly session: {
      getMarket(): { startTime: Date; endTime: Date };
      getSnapshot(): { observedAt: Date };
    },
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.enrichment = new DiscoveryEnrichmentBatcher(adapter);
  }

  async build(
    member: CatalogMember,
    context: DiscoveryInputContext,
  ): Promise<DiscoveryInputPreparation> {
    this.assertActive(context);
    const requestOptions: MarketDataRequestOptions | undefined =
      context.signal || context.deadlineAt || context.attemptId
        ? {
            signal: context.signal,
            expiresAt: context.deadlineAt,
            observation: context.attemptId
              ? {
                  attemptId: context.attemptId,
                  observer: context.diagnostics ?? { observe: () => {} },
                }
              : undefined,
          }
        : undefined;
    const mapping = await this.mapper.resolve(
      this.marketId,
      member,
      requestOptions,
      context.diagnostics,
    );
    this.assertActive(context);
    if (mapping.status !== "RESOLVED" || !mapping.instrument) {
      return {
        input: null,
        symbolId: mapping.instrument?.symbolId ?? null,
        reasons: [mappingReason(mapping.reason)],
      };
    }
    const instrument = mapping.instrument;
    // Stage 1: identity/metadata and the current quote are the cheapest
    // rejection gates. Do not spend historical slot requests on a symbol that
    // cannot satisfy the required identity, market cap or live-price inputs.
    const { fundamental, quote } = await this.enrichment.collect(
      instrument.symbolId,
      requestOptions,
      context.diagnostics,
    );
    this.assertActive(context);
    if (!fundamental?.marketCap || fundamental.marketCap <= 0)
      return {
        input: null,
        symbolId: instrument.symbolId,
        reasons: ["METADATA_UNAVAILABLE"],
      };
    if (!quote)
      return {
        input: null,
        symbolId: instrument.symbolId,
        reasons: ["QUOTE_UNAVAILABLE"],
      };
    const market = this.session.getMarket();
    const quoteReason = quoteFailureReason(quote, market, context);
    if (quoteReason)
      return {
        input: null,
        symbolId: instrument.symbolId,
        reasons: [quoteReason],
      };
    // Stage 2: daily history is fetched before five-minute history. The
    // cache fetches only a missing prefix/suffix after the first retrieval and
    // keeps the existing bars on provider failure for the next run.
    const dailyCached = await this.getCandlesCached(
      instrument.symbolId,
      "OneDay",
      this.historyRange(context),
      requestOptions,
      context.diagnostics,
    );
    this.assertActive(context);
    const policy = discoveryPolicyForMarket(this.marketId);
    const completedDailySessions = new Set(
      dailyCached
        .filter(
          (value) =>
            value.bar.isComplete &&
            dailyTradingDate(value.bar, this.marketId) < context.tradingDate,
        )
        .map((value) => dailyTradingDate(value.bar, this.marketId)),
    );
    if (completedDailySessions.size < policy.dailyHistorySessions + 1)
      return {
        input: null,
        symbolId: instrument.symbolId,
        reasons: ["INSUFFICIENT_DAILY_HISTORY"],
      };
    // Stage 3: the expensive slot history is reserved for symbols that made
    // it through metadata, quote and daily-history gates.
    const slotCached = await this.getCandlesCached(
      instrument.symbolId,
      "FiveMinutes",
      this.slotRange(context),
      requestOptions,
      context.diagnostics,
    );
    this.assertActive(context);
    const retrievedAt = this.clock().toISOString();
    const timezone =
      this.marketId === "CA_TSX" ? "America/Toronto" : "America/New_York";
    const regularSessions = getRecentRegularSessions(
      this.marketId,
      context.tradingDate,
      110,
    );
    // Questrade returns extended-hours five-minute bars too. The evaluator
    // aligns slots to the exchange session open, so retain only bars inside a
    // regular session and keep a defensive cap below the contract limit.
    const firstSlot = slotCached[0]?.bar.start.getTime();
    const lastSlot = slotCached.at(-1)?.bar.end.getTime();
    const regularSlotBounds = regularSessions
      .map((session) => ({
        open: Date.parse(session.open),
        close: Date.parse(session.close),
      }))
      .filter(
        (bounds) =>
          Number.isFinite(bounds.open) &&
          Number.isFinite(bounds.close) &&
          firstSlot !== undefined &&
          lastSlot !== undefined &&
          bounds.close >= firstSlot &&
          bounds.open <= lastSlot,
      );
    const regularSlotBars = slotCached
      .filter((value) => {
        const start = value.bar.start.getTime();
        const end = value.bar.end.getTime();
        return regularSlotBounds.some(
          (bounds) => start >= bounds.open && end <= bounds.close,
        );
      })
      .slice(-SLOT_BAR_LIMIT);
    const sessions = regularSessions.map((s) =>
      s.tradingDate === context.tradingDate
        ? {
            tradingDate: s.tradingDate,
            open: market.startTime.toISOString(),
            close: market.endTime.toISOString(),
          }
        : s,
    );
    const calendarProvenance = calendarProvenanceFor(
      this.marketId,
      sessions.map((session) => session.tradingDate),
    );
    const dailyAdjustmentRevision = DEFAULT_ADJUSTMENT_REVISION;
    // Validate at the producer boundary: an out-of-contract input must fail as
    // a per-symbol collection error, never abort the run while being persisted.
    const input = discoveryEvaluationInputSchema.parse({
      marketId: this.marketId,
      policyVersion:
        this.marketId === "CA_TSX" ? "ca-discovery-v1" : "us-discovery-v1",
      providerCode: member.providerCode,
      providerExchange: member.raw.Exchange,
      tradingDate: context.tradingDate,
      evaluationAt: context.evaluationAt,
      completedBarEnd: context.completedBarEnd,
      identity: {
        marketId: this.marketId,
        symbolId: instrument.symbolId,
        symbol: instrument.symbol,
        exchange: normalizeExchange(instrument.exchange),
        currency: instrument.currency as "CAD" | "USD",
        classification: "COMMON_STOCK_REVIEWED",
        observedAt: retrievedAt,
        source: "QUESTRADE",
      },
      marketCap: {
        value: fundamental?.marketCap ?? null,
        currency: instrument.currency as "CAD" | "USD",
        observedAt: retrievedAt,
        source: "QUESTRADE",
      },
      quote: quote ? quoteInput(quote, market) : null,
      calendar: {
        marketId: this.marketId,
        // Published exchange schedules verify the covered years and carry a
        // content-addressed revision. Any uncovered date falls back to the
        // unverified local rules so the evaluator stays fail-closed.
        verified: calendarProvenance.verified,
        revision: calendarProvenance.revision,
        source: calendarProvenance.source,
        observedAt: this.session.getSnapshot().observedAt.toISOString(),
        sessions,
      },
      adjustment: {
        // The provider has not confirmed split/dividend adjustment or
        // corporate-action revision invalidation, so no convention is
        // asserted. Bars retain their retrieval revision only.
        verified: false,
        revision: dailyAdjustmentRevision,
        source: "questrade-candle-boundary",
        convention: "UNKNOWN",
        hasUnresolvedCorporateAction: false,
        observedAt: retrievedAt,
      },
      dailyBars: dailyCached
        .slice(-DAILY_BAR_LIMIT)
        .map((value) =>
          dailyInput(
            value.bar,
            timezone,
            value.observedAt,
            dailyAdjustmentRevision,
          ),
        ),
      slotBars: regularSlotBars.map((value) =>
        slotInput(value.bar, dailyAdjustmentRevision, value.observedAt),
      ),
    });
    return {
      input,
      symbolId: instrument.symbolId,
      reasons: [],
    };
  }

  private historyRange(context: DiscoveryInputContext) {
    const end = new Date(context.evaluationAt);
    return {
      startTime: new Date(end.getTime() - 600 * 86_400_000),
      endTime: end,
    };
  }

  private slotRange(context: DiscoveryInputContext) {
    const end = new Date(context.evaluationAt);
    return {
      startTime: new Date(end.getTime() - 21 * 86_400_000),
      endTime: end,
    };
  }

  private async getCandlesCached(
    symbolId: number,
    interval: "OneDay" | "FiveMinutes",
    range: { startTime: Date; endTime: Date },
    requestOptions?: MarketDataRequestOptions,
    diagnostics?: DiscoveryAttemptDiagnosticsCollector,
  ): Promise<CachedCandle[]> {
    const stage = interval === "OneDay" ? "DAILY_HISTORY" : "SLOT_HISTORY";
    const stopTiming = diagnostics?.startStage(stage);
    try {
      const key = [
        this.marketId,
        symbolId,
        interval,
        DEFAULT_ADJUSTMENT_REVISION,
      ].join(":");
      const cached = this.candleCache.get(key) ?? [];
      const bars = cached.map((value) => value.bar);
      const starts = bars.map((bar) => bar.start.getTime());
      const ends = bars.map((bar) => bar.end.getTime());
      const ranges: Array<{ startTime: Date; endTime: Date }> = [];
      const cachedStart = starts.length ? Math.min(...starts) : null;
      const cachedEnd = ends.length ? Math.max(...ends) : null;
      if (cachedStart === null)
        ranges.push({ startTime: range.startTime, endTime: range.endTime });
      else if (cachedStart > range.startTime.getTime())
        ranges.push({
          startTime: range.startTime,
          endTime: new Date(Math.min(cachedStart, range.endTime.getTime())),
        });
      if (cachedEnd !== null && cachedEnd < range.endTime.getTime())
        ranges.push({
          startTime: new Date(
            Math.max(cachedEnd - 86_400_000, range.startTime.getTime()),
          ),
          endTime: range.endTime,
        });
      diagnostics?.recordCache(
        stage,
        cached.length === 0
          ? "MISS"
          : ranges.some((missing) => missing.endTime > missing.startTime)
            ? "PARTIAL_HIT"
            : "HIT",
      );
      for (const missing of ranges) {
        if (missing.endTime <= missing.startTime) continue;
        this.assertActive({
          signal: requestOptions?.signal,
          deadlineAt: requestOptions?.expiresAt,
        });
        const loaded = await this.adapter.getCandles(
          symbolId,
          interval,
          missing,
          requestOptions,
        );
        diagnostics?.recordLoadedBars(stage, loaded.length);
        this.assertActive({
          signal: requestOptions?.signal,
          deadlineAt: requestOptions?.expiresAt,
        });
        const observedAt = this.clock().toISOString();
        for (const bar of loaded) {
          const existing = cached.find(
            (value) => value.bar.start.getTime() === bar.start.getTime(),
          );
          if (existing) {
            existing.bar = bar;
            existing.observedAt = observedAt;
          } else cached.push({ bar, observedAt });
        }
      }
      cached.sort(
        (left, right) => left.bar.start.getTime() - right.bar.start.getTime(),
      );
      this.candleCache.set(key, cached);
      return cached.filter(
        (value) =>
          value.bar.start >= range.startTime && value.bar.start < range.endTime,
      );
    } finally {
      stopTiming?.();
    }
  }

  private assertActive(context: {
    signal?: AbortSignal;
    deadlineAt?: Date;
  }): void {
    if (
      context.deadlineAt &&
      this.clock().getTime() >= context.deadlineAt.getTime()
    )
      throw Object.assign(new Error("Discovery input collection expired"), {
        code: "EXPIRED",
      });
    if (context.signal?.aborted)
      throw Object.assign(new Error("Discovery input collection cancelled"), {
        code: "CANCELLED",
      });
  }
}

function dailyTradingDate(bar: Candle, marketId: MarketId): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(bar.start);
}

function quoteFailureReason(
  quote: Quote,
  market: { startTime: Date; endTime: Date },
  context: DiscoveryInputContext,
): DiscoveryReason | null {
  if (
    context.evaluationAtFrozen !== false &&
    quote.receivedAt.getTime() > Date.parse(context.evaluationAt)
  )
    return "FUTURE_OBSERVATION";
  if (quote.isHalted) return "QUOTE_HALTED";
  if (quote.isDelayed) return "QUOTE_DELAYED";
  if (Date.parse(context.evaluationAt) - quote.receivedAt.getTime() > 30_000)
    return "QUOTE_STALE";
  if (quote.receivedAt < market.startTime || quote.receivedAt >= market.endTime)
    return "OUTSIDE_REGULAR_SESSION";
  if (!Number.isFinite(quote.last) || quote.last <= 0)
    return "QUOTE_UNAVAILABLE";
  return null;
}

function mappingReason(reason: string): DiscoveryReason {
  switch (reason) {
    case "EXCHANGE_NOT_ALLOWED":
      return "EXCHANGE_NOT_ALLOWED";
    case "CURRENCY_NOT_ALLOWED":
      return "CURRENCY_NOT_ALLOWED";
    case "CLASSIFICATION_REVIEW_REQUIRED":
      return "CLASSIFICATION_REVIEW_REQUIRED";
    default:
      return "MAPPING_UNAVAILABLE";
  }
}

function quoteInput(
  quote: Quote,
  market: { startTime: Date; endTime: Date },
): DiscoveryEvaluationInput["quote"] {
  const inRegularSession =
    quote.receivedAt >= market.startTime && quote.receivedAt < market.endTime;
  return {
    price: quote.last,
    open: quote.dayOpen,
    priceAt: quote.lastTradeAt?.toISOString() ?? null,
    observedAt: quote.receivedAt.toISOString(),
    delayed: quote.isDelayed,
    halted: quote.isHalted,
    session: inRegularSession ? "REGULAR" : "UNKNOWN",
    source: "QUESTRADE",
  };
}

function dailyInput(
  bar: Candle,
  timezone: string,
  retrievedAt: string,
  adjustmentRevision: string = DEFAULT_ADJUSTMENT_REVISION,
): DiscoveryEvaluationInput["dailyBars"][number] {
  return {
    tradingDate: new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(bar.start),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    observedAt: retrievedAt,
    complete: bar.isComplete,
    source: "QUESTRADE",
    adjustmentRevision,
  };
}

function slotInput(
  bar: Candle,
  adjustmentRevision: string,
  retrievedAt: string,
): DiscoveryEvaluationInput["slotBars"][number] {
  return {
    start: bar.start.toISOString(),
    end: bar.end.toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    observedAt: retrievedAt,
    complete: bar.isComplete,
    source: "QUESTRADE",
    adjustmentRevision,
  };
}
