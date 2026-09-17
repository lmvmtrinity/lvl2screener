import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import {
  setImmediate as immediate,
  setTimeout as realDelay,
} from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { vi } from "vitest";
import {
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
  discoveryPolicyForMarket,
  type DiscoveryEvaluationInput,
  type DiscoveryEvaluationResult,
  type DiscoveryRun,
  type MarketId,
} from "@tsx-scanner/contracts";
import { QuestradeAdapter } from "../../../src/questrade/adapter.js";
import { QuestradeHttpError } from "../../../src/questrade/live-transport.js";
import {
  QuestradeRateLimiter,
  type RequestOptions,
  type QuestradeRequestPriority,
} from "../../../src/questrade/rate-limiter.js";
import {
  MemoryRequestBudget,
  type QuestradeRequestBudget,
} from "../../../src/questrade/request-budget.js";
import { PostgresRequestBudget } from "../../../src/questrade/postgres-request-budget.js";
import type { QuestradeRequestObservation } from "../../../src/questrade/request-observation.js";
import {
  InMemoryRefreshTokenStore,
  QuestradeTokenManager,
} from "../../../src/questrade/token-manager.js";
import type {
  CandleInterval,
  CandleRange,
  QuestradeTransport,
  RawCandle,
  RawMarket,
  RawQuote,
  RawSymbol,
} from "../../../src/questrade/types.js";
import { DiscoverySymbolMapper } from "../../../src/universe/discovery-mapping.js";
import { DiscoveryScheduler } from "../../../src/universe/discovery-scheduler.js";
import {
  PostgresDiscoveryControlStore,
  type DiscoveryLease,
} from "../../../src/universe/discovery-control-repository.js";
import { PostgresDiscoveryEvidenceStore } from "../../../src/universe/discovery-evidence-repository.js";
import {
  PostgresCatalogSnapshotStore,
  PostgresDiscoveryMappingStore,
} from "../../../src/universe/postgres-discovery-provider-store.js";
import {
  EodhdCatalogClient,
  type CatalogSnapshot,
} from "../../../src/universe/eodhd-catalog.js";
import { QuestradeDiscoveryInputSource } from "../../../src/universe/questrade-discovery-input-source.js";
import {
  getRecentRegularSessions,
  isMarketTradingDay,
} from "../../../src/universe/market-calendar.js";

type Fault = "PARTIAL" | "404" | "401" | "504";

/** Synthetic cohort members exercise one early or late screening gate each.
 * These profiles are capacity-harness data, never provider or policy facts. */
export type CohortProfile =
  | "ELIGIBLE"
  | "LOW_MARKET_CAP"
  | "MISSING_METADATA"
  | "PRICE_OUT_OF_RANGE"
  | "MISSING_QUOTE"
  | "HALTED_QUOTE"
  | "DELAYED_QUOTE"
  | "UNRESOLVED_MAPPING"
  | "MISSING_DAILY_HISTORY"
  | "SPARSE_DAILY_HISTORY"
  | "MISSING_SLOT_HISTORY";

export interface ProfileAssignment {
  profile: CohortProfile;
  count: number;
}

interface ScenarioOptions {
  fullMarket?: boolean;
  mapping?: "COINCIDENT" | "STAGGERED";
  providerLatencyMs: number;
  concurrentMonitoring?: boolean;
  quoteAgeAtFreezeMs?: number;
  fault?: Fault;
  cancelAtMs?: number;
  /** Bounded synthetic cohort. All rows stay admitted unless catalog-excluded. */
  profiles?: readonly ProfileAssignment[];
  catalogExcludedCount?: number;
  quotePrice?: number;
  /** Explicit market scope for a bounded run; defaults to the market rules above. */
  marketIds?: readonly MarketId[];
}
const MARKETS = ["CA_TSX", "US_EQUITIES"] as const;
/** Evaluator failure reasons that do not depend on five-minute slot history.
 * A member carrying one of these cannot pass, so a staged screener that had
 * already observed the same facts could have skipped its slot requests. */
const SLOT_INDEPENDENT_FAILURE_REASONS = new Set([
  "PRICE_OUT_OF_RANGE",
  "MARKET_CAP_THRESHOLD",
  "AVERAGE_VOLUME_THRESHOLD",
  "ATR_THRESHOLD",
  "DOLLAR_VOLUME_THRESHOLD",
  "CHANGE_FROM_OPEN_THRESHOLD",
]);
const DEFAULT_QUOTE_PRICE = 50;
const OUT_OF_RANGE_QUOTE_PRICE = 1_000;
const INVALID_MARKET_CAP = 0;
const LOW_MARKET_CAP = 1_000_000;
const FULL_CATALOGS = {
  CA_TSX: { rowCount: 875, admittedCount: 857 },
  US_EQUITIES: { rowCount: 5321, admittedCount: 5087 },
};

/** Real SQL and local evaluator work consume host time, never assumed broker
 * time. Track pending I/O so the virtual driver cannot skip across an unfinished
 * transaction and accidentally exhaust a market's collection deadline. */
class HostIO {
  pending = 0;
  async track<T>(operation: Promise<T>): Promise<T> {
    this.pending++;
    try {
      return await operation;
    } finally {
      this.pending--;
    }
  }
  pool(pool: Pool): Pool {
    const client = (value: PoolClient) =>
      new Proxy(value, {
        get: (target, key) => {
          const member = Reflect.get(target, key);
          if (key === "query")
            return (...args: unknown[]) =>
              this.track(Promise.resolve(Reflect.apply(member, target, args)));
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    return new Proxy(pool, {
      get: (target, key) => {
        const member = Reflect.get(target, key);
        if (key === "query")
          return (...args: unknown[]) =>
            this.track(Promise.resolve(Reflect.apply(member, target, args)));
        if (key === "connect")
          return () => this.track(target.connect()).then(client);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }
  async drive<T>(operation: Promise<T>): Promise<T> {
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    // Attach rejection handling immediately, including cancellation cases.
    void result.catch(() => {});
    const deadline = performance.now() + 170_000;
    while (!settled) {
      await immediate();
      if (settled) break;
      if (performance.now() > deadline)
        throw new Error("Capacity fixture host I/O did not settle");
      if (this.pending > 0 || vi.getTimerCount() === 0) await realDelay(1);
      else await vi.advanceTimersToNextTimerAsync();
    }
    return result;
  }
}

/** One local evaluator process is initialized before any measured cycle. Both
 * shared TS schemas and the production Python evaluator validate every payload.
 * This is evaluator-boundary validation, never provider capacity evidence. */
async function localEvaluator(io: HostIO) {
  const scanner = fileURLToPath(
    new URL("../../../../../services/scanner/", import.meta.url),
  );
  const candidates = [
    new URL(
      "../../../../../services/scanner/.venv/Scripts/python.exe",
      import.meta.url,
    ),
    new URL(
      "../../../../../../../services/scanner/.venv/Scripts/python.exe",
      import.meta.url,
    ),
  ].map((url) => fileURLToPath(url));
  const python =
    process.env.DISCOVERY_CAPACITY_PYTHON ??
    candidates.find(existsSync) ??
    "python";
  const script = [
    "import sys,json",
    "from app.discovery import evaluate_discovery",
    "from app.discovery_models import DiscoveryInput",
    "print('READY',flush=True)",
    "for line in sys.stdin:",
    " try:",
    "  value=DiscoveryInput.model_validate_json(line)",
    "  print(evaluate_discovery(value,now=value.evaluation_at).model_dump_json(by_alias=True),flush=True)",
    " except Exception as error:",
    "  print(json.dumps({'fixtureError':str(error)}),flush=True)",
  ].join("\n");
  const processHandle = spawn(python, ["-u", "-c", script], {
    cwd: scanner,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  processHandle.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const lines = createInterface({ input: processHandle.stdout });
  const pending: Array<{
    resolve: (value: DiscoveryEvaluationResult) => void;
    reject: (error: Error) => void;
  }> = [];
  await new Promise<void>((resolve, reject) => {
    processHandle.once("error", reject);
    processHandle.once("exit", (code) => {
      if (code) reject(new Error(`Local evaluator startup: ${stderr}`));
    });
    lines.once("line", (line) =>
      line === "READY"
        ? resolve()
        : reject(new Error(`Unexpected local evaluator startup: ${line}`)),
    );
  });
  lines.on("line", (line) => {
    const request = pending.shift();
    if (!request) return;
    try {
      request.resolve(discoveryEvaluationResultSchema.parse(JSON.parse(line)));
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  processHandle.on("exit", () => {
    for (const request of pending.splice(0))
      request.reject(new Error(`Local evaluator exited: ${stderr}`));
  });
  const successfulResponses: Record<MarketId, number> = {
    CA_TSX: 0,
    US_EQUITIES: 0,
  };
  const failures: Array<{ marketId: string; error: unknown }> = [];
  return {
    successfulResponses,
    assertHealthy() {
      if (failures.length === 0) return;
      throw new AggregateError(
        failures.map((failure) => failure.error),
        [...new Set(failures.map((failure) => failure.marketId))]
          .map((marketId) => `${marketId} evaluator boundary failed`)
          .join("; "),
      );
    },
    async evaluateDiscovery(value: DiscoveryEvaluationInput) {
      try {
        const input = discoveryEvaluationInputSchema.parse(value);
        if (input.adjustment.verified)
          throw new Error(
            "Synthetic fixture cannot claim verified adjustments",
          );
        const result = await io.track(
          new Promise<DiscoveryEvaluationResult>((resolve, reject) => {
            pending.push({
              resolve: (result) => {
                if (
                  result.marketId !== input.marketId ||
                  result.symbolId !== input.identity.symbolId ||
                  result.providerCode !== input.providerCode ||
                  Date.parse(result.evaluationAt) !==
                    Date.parse(input.evaluationAt) ||
                  result.state === "PASS" ||
                  result.state === "FAIL"
                ) {
                  reject(
                    new Error(
                      "Local evaluator ownership/adjustment invariant violated",
                    ),
                  );
                } else resolve(result);
              },
              reject,
            });
            processHandle.stdin.write(`${JSON.stringify(input)}\n`);
          }),
        );
        successfulResponses[input.marketId]++;
        return result;
      } catch (error) {
        // The real scheduler deliberately converts provider/evaluator errors
        // into durable UNEVALUABLE evidence. Preserve fixture failures outside
        // that handling so those outcomes cannot certify the harness itself.
        failures.push({
          marketId: String(value?.marketId ?? "UNKNOWN"),
          error,
        });
        throw error;
      }
    },
    /** Test-only evaluator probe. It asserts synthetic "UNADJUSTED" and verified
     * calendar facts on an already-observed input so metric values become
     * visible, and it must never be recorded as run evidence. Used only to
     * verify that current-price metrics stay dynamic, that the probe cannot
     * reach PASS inside a fixture, and that a slot-independent threshold failure
     * cannot be a PASS. */
    async evaluateSyntheticAdjustmentProbe(value: DiscoveryEvaluationInput) {
      const input = discoveryEvaluationInputSchema.parse({
        ...value,
        calendar: { ...value.calendar, verified: true },
        adjustment: {
          ...value.adjustment,
          verified: true,
          convention: "UNADJUSTED",
          hasUnresolvedCorporateAction: false,
        },
      });
      return io.track(
        new Promise<DiscoveryEvaluationResult>((resolve, reject) => {
          pending.push({ resolve, reject });
          processHandle.stdin.write(`${JSON.stringify(input)}\n`);
        }),
      );
    },
    async close() {
      if (processHandle.exitCode !== null) {
        lines.close();
        return;
      }
      const exited = new Promise<void>((resolve) =>
        processHandle.once("exit", () => resolve()),
      );
      processHandle.stdin.end();
      await exited;
      lines.close();
    },
  };
}

/** Add an observer without replacing schedule(), grants, the queue, or dispatch. */
class ObservedLimiter extends QuestradeRateLimiter {
  readonly observations: Array<
    QuestradeRequestObservation & { discovery: boolean }
  > = [];
  override schedule<T>(
    priority: QuestradeRequestPriority,
    operation: () => Promise<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const original = options.observation;
    return super.schedule(
      priority,
      operation,
      original
        ? {
            ...options,
            observation: {
              ...original,
              observer: {
                observe: (event) => {
                  this.observations.push({
                    ...event,
                    discovery: options.discovery ?? false,
                  });
                  original.observer.observe(event);
                },
              },
            },
          }
        : options,
    );
  }
}

/** Only the first four already-persisted mappings are released together. This
 * declares an optimistic cache-read timing assumption while retaining every
 * real PostgreSQL load and mapper decision. Cold mappings retain provider pacing. */
class MappingTimingStore extends PostgresDiscoveryMappingStore {
  coincide = false;
  readonly warmedCodes = new Set<string>();
  private arrivals: Array<() => void> = [];
  override async load(marketId: MarketId, exchange: string, code: string) {
    const result = await super.load(marketId, exchange, code);
    if (this.coincide && this.warmedCodes.has(code)) {
      await new Promise<void>((resolve) => {
        this.arrivals.push(resolve);
        if (this.arrivals.length === 4) {
          this.coincide = false;
          for (const arrived of this.arrivals.splice(0)) arrived();
        }
      });
    }
    return result;
  }
}

class LocalTransport implements QuestradeTransport {
  readonly symbols = new Map<string, RawSymbol>();
  readonly byId = new Map<number, RawSymbol>();
  readonly profileBySymbolId = new Map<number, CohortProfile>();
  readonly candleRanges: Array<{
    symbolId: number;
    interval: CandleInterval;
    start: number;
    end: number;
  }> = [];
  readonly quoteAt = new Map<number, number>();
  readonly searchQueries: string[] = [];
  readonly detailCalls: number[][] = [];
  readonly quoteCalls: number[][] = [];
  private readonly quotePrices = new Map<number, number>();
  private faultUsed = false;
  constructor(private readonly options: ScenarioOptions) {}
  private profile(symbolId: number): CohortProfile {
    return this.profileBySymbolId.get(symbolId) ?? "ELIGIBLE";
  }
  /** Test-only price injection so a later cycle observes a changed current price
   * while the retained daily history stays byte-identical. */
  setQuotePrice(symbolId: number, price: number): void {
    this.quotePrices.set(symbolId, price);
  }
  setProfile(symbolId: number, profile: CohortProfile): void {
    this.profileBySymbolId.set(symbolId, profile);
  }
  private async latency(milliseconds = this.options.providerLatencyMs) {
    if (milliseconds > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
  async searchSymbols(_server: URL, _token: string, prefix: string) {
    await this.latency();
    this.searchQueries.push(prefix);
    const symbol = this.symbols.get(prefix);
    if (!symbol) return [];
    if (this.profile(symbol.symbolId) === "UNRESOLVED_MAPPING") return [];
    return [symbol];
  }
  async getSymbolDetails(_server: URL, _token: string, ids: number[]) {
    await this.latency();
    this.detailCalls.push([...ids]);
    return ids.map((id) => {
      const profile = this.profile(id);
      return {
        symbol: this.byId.get(id)!.symbol,
        symbolId: id,
        marketCap:
          profile === "MISSING_METADATA"
            ? INVALID_MARKET_CAP
            : profile === "LOW_MARKET_CAP"
              ? LOW_MARKET_CAP
              : 2_000_000_000,
        industrySector: "Technology",
      };
    });
  }
  async getQuotes(
    _server: URL,
    _token: string,
    ids: number[],
  ): Promise<RawQuote[]> {
    await this.latency();
    if (
      ids.includes(100_001) &&
      !this.faultUsed &&
      (this.options.fault === "401" || this.options.fault === "504")
    ) {
      this.faultUsed = true;
      throw new QuestradeHttpError(
        Number(this.options.fault),
        "Synthetic capacity response",
      );
    }
    this.quoteCalls.push([...ids]);
    return ids
      .filter((id) => !(this.options.fault === "PARTIAL" && id === 100_001))
      .filter((id) => this.profile(id) !== "MISSING_QUOTE")
      .map((id) => {
        const profile = this.profile(id);
        const price =
          profile === "PRICE_OUT_OF_RANGE"
            ? OUT_OF_RANGE_QUOTE_PRICE
            : (this.quotePrices.get(id) ??
              this.options.quotePrice ??
              DEFAULT_QUOTE_PRICE);
        this.quoteAt.set(id, Date.now());
        return {
          symbol: this.byId.get(id)!.symbol,
          symbolId: id,
          bidPrice: price - 0.01,
          bidSize: 10,
          askPrice: price + 0.01,
          askSize: 10,
          lastTradePrice: price,
          lastTradeSize: 1,
          lastTradeTime: new Date().toISOString(),
          volume: 1_000_000,
          openPrice: 49,
          highPrice: price + 1,
          lowPrice: price - 2,
          delay: profile === "DELAYED_QUOTE",
          isHalted: profile === "HALTED_QUOTE",
        };
      });
  }
  async getCandles(
    _server: URL,
    _token: string,
    symbolId: number,
    interval: CandleInterval,
    range: CandleRange,
  ): Promise<RawCandle[]> {
    this.candleRanges.push({
      symbolId,
      interval,
      start: +range.startTime,
      end: +range.endTime,
    });
    if (
      interval === "FiveMinutes" &&
      this.options.quoteAgeAtFreezeMs !== undefined
    ) {
      await this.latency(
        Math.max(
          0,
          this.quoteAt.get(symbolId)! +
            this.options.quoteAgeAtFreezeMs -
            Date.now(),
        ),
      );
    } else await this.latency();
    const profile = this.profile(symbolId);
    if (
      interval === "OneDay" &&
      (profile === "MISSING_DAILY_HISTORY" ||
        (this.options.fault === "404" && symbolId === 100_001))
    )
      throw new QuestradeHttpError(404, "Synthetic no candle history");
    if (interval === "FiveMinutes" && profile === "MISSING_SLOT_HISTORY")
      return [];
    const step = interval === "OneDay" ? 86_400_000 : 300_000;
    const bars: RawCandle[] = [];
    // Daily history is complete in shape; sparse slot history is deliberately
    // synthetic and cannot become qualified adjustment/commissioning evidence.
    const stride = interval === "OneDay" ? step : 86_400_000;
    const generationStart =
      interval === "OneDay" && profile === "SPARSE_DAILY_HISTORY"
        ? Math.max(+range.startTime, +range.endTime - 29 * step)
        : +range.startTime;
    for (let start = generationStart; start < +range.endTime; start += stride) {
      bars.push(rawCandle(start, Math.min(start + step, +range.endTime)));
    }
    const tail = +range.endTime - step;
    const lastStart = bars.at(-1)?.start;
    // A warm suffix fetch starts one day before the cached end, so the grid
    // already covers the tail; appending it would fabricate a second bar for
    // the same trading date and invalidate reused history. Only extend beyond
    // the last generated bar.
    if (
      tail >= +range.startTime &&
      (lastStart === undefined || Date.parse(lastStart) < tail)
    )
      bars.push(rawCandle(tail, +range.endTime));
    return bars;
  }
  async getMarkets(): Promise<RawMarket[]> {
    throw new Error(
      "Capacity fixture uses an explicit synthetic session; no market request is permitted",
    );
  }
}
function rawCandle(start: number, end: number): RawCandle {
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    open: 49,
    high: 51,
    low: 48,
    close: 50,
    volume: 1_000_000,
  };
}

async function fixture(
  pool: Pool,
  options: ScenarioOptions,
  budgetFactory?: (db: Pool) => QuestradeRequestBudget,
) {
  const io = new HostIO();
  const db = io.pool(pool);
  const engine = await localEvaluator(io);
  const cleanup: Array<() => void | Promise<void>> = [() => engine.close()];
  async function close() {
    const failures: unknown[] = [];
    for (const release of cleanup) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Capacity fixture cleanup failed");
  }
  try {
    let date = (
      await pool.query<{ day: string }>(
        `SELECT (GREATEST(COALESCE(max(day),'2026-11-02'::date),'2026-11-02'::date)+1)::text AS day FROM (SELECT trading_date AS day FROM discovery_run UNION ALL SELECT trading_date FROM discovery_catalog_cache UNION ALL SELECT trading_date FROM discovery_schedule_lease) dates`,
      )
    ).rows[0]!.day;
    while (!MARKETS.every((marketId) => isMarketTradingDay(date, marketId)))
      date = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
    const sessions = {
      CA_TSX: getRecentRegularSessions("CA_TSX", date, 1)[0]!,
      US_EQUITIES: getRecentRegularSessions("US_EQUITIES", date, 1)[0]!,
    };
    const initial = Date.parse(sessions.CA_TSX.open) + 30 * 60_000 + 15_000;
    vi.useFakeTimers({
      now: initial,
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    cleanup.unshift(() => {
      vi.useRealTimers();
    });
    const clock = () => new Date();
    const control = new PostgresDiscoveryControlStore(db);
    const catalogStore = new PostgresCatalogSnapshotStore(db);
    const evidence = new PostgresDiscoveryEvidenceStore(db, clock);
    const budget = budgetFactory?.(db) ?? new MemoryRequestBudget(clock);
    const limiter = new ObservedLimiter(2, 2, clock, budget);
    cleanup.unshift(() => {
      limiter.cancelPendingDiscovery();
    });
    let tokenRotations = 0;
    const tokens = new QuestradeTokenManager(
      {
        async redeemRefreshToken() {
          tokenRotations++;
          return {
            access_token: "capacity-only-access",
            refresh_token: `capacity-only-rotation-${tokenRotations}`,
            token_type: "Bearer",
            expires_in: 86_400,
            api_server: "https://capacity.invalid/",
          };
        },
      },
      new InMemoryRefreshTokenStore("capacity-only-refresh"),
      clock,
      30_000,
      limiter,
    );
    const transport = new LocalTransport(options);
    const adapter = new QuestradeAdapter(
      tokens,
      transport,
      clock,
      "QUESTRADE_MOCK",
      limiter,
    );
    await adapter.initialize(); // Authentication is outside every measured cycle.
    const discovery = adapter.forDiscovery();
    const markets = options.marketIds
      ? [...options.marketIds]
      : options.fullMarket
        ? [...MARKETS]
        : options.profiles
          ? [...MARKETS]
          : ["CA_TSX" as const];
    // Each case owns these mutable provider-cache rows in the explicitly isolated
    // database. Otherwise the real catalog-drop guard correctly retains a prior
    // full-market catalog when a later one-member boundary fixture is requested.
    // Immutable discovery_catalog_snapshot/evaluation evidence is untouched.
    await db.query(
      "DELETE FROM discovery_catalog_cache WHERE market_id=ANY($1::text[])",
      [markets],
    );
    const sources = new Map<MarketId, QuestradeDiscoveryInputSource>();
    const mappers = new Map<MarketId, DiscoverySymbolMapper>();
    const mappingStores = new Map<MarketId, MappingTimingStore>();
    const catalogs = new Map<MarketId, CatalogSnapshot>();
    const clients = new Map<MarketId, EodhdCatalogClient>();
    const session = (marketId: MarketId) => ({
      getMarket: () => ({
        startTime: new Date(sessions[marketId].open),
        endTime: new Date(sessions[marketId].close),
      }),
      getSnapshot: () => ({
        marketStatus: "OPEN",
        startTime: new Date(sessions[marketId].open),
        endTime: new Date(sessions[marketId].close),
        observedAt: new Date(initial),
      }),
    });
    for (const marketId of markets) {
      const mode = await control.getMode(marketId);
      if (mode.mode !== "SHADOW")
        await control.changeMode({
          marketId,
          mode: "SHADOW",
          expectedRevision: mode.revision,
          actor: "synthetic-capacity-fixture",
          reason: "Disposable database capacity test only",
        });
      const counts = options.fullMarket
        ? FULL_CATALOGS[marketId]
        : options.profiles
          ? {
              rowCount:
                options.profiles.reduce(
                  (total, assignment) => total + assignment.count,
                  0,
                ) + (options.catalogExcludedCount ?? 0),
              admittedCount: options.profiles.reduce(
                (total, assignment) => total + assignment.count,
                0,
              ),
            }
          : {
              rowCount: options.fault ? 4 : 1,
              admittedCount: options.fault ? 4 : 1,
            };
      const plan: CohortProfile[] = options.profiles
        ? options.profiles.flatMap((assignment) =>
            Array.from({ length: assignment.count }, () => assignment.profile),
          )
        : Array.from({ length: counts.rowCount }, () => "ELIGIBLE");
      const prefix = `CAP${marketId === "CA_TSX" ? "C" : "U"}${randomUUID().slice(0, 8)}`;
      const rows = Array.from({ length: counts.rowCount }, (_, index) => {
        const Code = `${prefix}${String(index + 1).padStart(5, "0")}`;
        const currency = marketId === "CA_TSX" ? "CAD" : "USD";
        const exchange = marketId === "CA_TSX" ? "TSX" : "NASDAQ";
        const raw: RawSymbol = {
          symbol: marketId === "CA_TSX" ? `${Code}.TO` : Code,
          symbolId: (marketId === "CA_TSX" ? 100_000 : 200_000) + index + 1,
          description: "Synthetic capacity common share",
          securityType: "Common Stock",
          listingExchange: exchange,
          isQuotable: true,
          isTradable: true,
          currency,
        };
        transport.symbols.set(Code, raw);
        transport.byId.set(raw.symbolId, raw);
        if (index < counts.admittedCount)
          transport.setProfile(raw.symbolId, plan[index]!);
        return {
          Code,
          Name: "Synthetic capacity catalog",
          Exchange: exchange,
          Currency: currency,
          Type: index < counts.admittedCount ? "Common Stock" : "ETF",
        };
      });
      const client = new EodhdCatalogClient(
        "synthetic-capacity-not-a-credential",
        catalogStore,
        async () => Response.json(rows),
        clock,
      );
      const catalog = (await client.refresh(marketId, date)).snapshot!;
      catalogs.set(marketId, catalog);
      clients.set(marketId, client);
      const store = new MappingTimingStore(db);
      const mapper = new DiscoverySymbolMapper(discovery, store, clock);
      mappingStores.set(marketId, store);
      mappers.set(marketId, mapper);
      sources.set(
        marketId,
        new QuestradeDiscoveryInputSource(
          discovery,
          mapper,
          marketId,
          session(marketId),
          clock,
        ),
      );
    }
    const schedulers: DiscoveryScheduler[] = [];
    cleanup.unshift(async () => {
      const results = await io.drive(
        Promise.allSettled(schedulers.map(async (value) => value.stop())),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          "Capacity fixture scheduler cleanup failed",
        );
    });
    const warnings: Record<string, unknown>[] = [];
    function scheduler(marketId: MarketId) {
      const value = new DiscoveryScheduler({
        marketId,
        catalogClient: clients.get(marketId)!,
        catalogStore,
        controlStore: control,
        evidenceStore: evidence,
        inputSource: sources.get(marketId)!,
        engine,
        session: session(marketId),
        brokerMetrics: limiter,
        clock,
        workerConcurrency: 4,
        logger: {
          info: () => {},
          warn: (entry) => {
            warnings.push(entry);
          },
          error: (entry) => {
            warnings.push(entry);
          },
        },
      });
      schedulers.push(value);
      return value;
    }
    return {
      io,
      db,
      engine,
      clock,
      date,
      initial,
      control,
      catalogStore,
      evidence,
      limiter,
      adapter,
      discovery,
      transport,
      markets,
      sources,
      catalogs,
      mappers,
      mappingStores,
      scheduler,
      warnings,
      restartSource(marketId: MarketId) {
        const mapper = new DiscoverySymbolMapper(
          discovery,
          new PostgresDiscoveryMappingStore(db),
          clock,
        );
        sources.set(
          marketId,
          new QuestradeDiscoveryInputSource(
            discovery,
            mapper,
            marketId,
            session(marketId),
            clock,
          ),
        );
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Capacity fixture acquisition and cleanup failed",
      );
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function marketReport(
  f: Fixture,
  marketId: MarketId,
  scheduler: DiscoveryScheduler,
  run: DiscoveryRun | null,
) {
  const catalog = f.catalogs.get(marketId)!;
  const internal = scheduler.getLastAttemptDiagnostics();
  const diagnostics = run
    ? await f.evidence.listLatestDiagnostics(marketId)
    : null;
  const rows = run
    ? (
        await f.db.query<{
          evaluations: number;
          diagnostics: number;
          wrong: number;
        }>(
          `SELECT (SELECT count(*)::int FROM discovery_evaluation WHERE run_id=$1) AS evaluations, (SELECT count(*)::int FROM discovery_run_diagnostic WHERE run_id=$1) AS diagnostics, (SELECT count(*)::int FROM discovery_evaluation WHERE run_id=$1 AND market_id <> $2) AS wrong`,
          [run.id, marketId],
        )
      ).rows[0]!
    : (
        await f.db.query<{
          evaluations: number;
          diagnostics: number;
          wrong: number;
        }>(
          `WITH owned_runs AS (SELECT id FROM discovery_run WHERE market_id=$1 AND trading_date=$2)
         SELECT (SELECT count(*)::int FROM discovery_evaluation WHERE run_id IN (SELECT id FROM owned_runs)) AS evaluations,
                (SELECT count(*)::int FROM discovery_run_diagnostic WHERE run_id IN (SELECT id FROM owned_runs)) AS diagnostics,
                (SELECT count(*)::int FROM discovery_evaluation WHERE run_id IN (SELECT id FROM owned_runs) AND market_id <> $1) AS wrong`,
          [marketId, f.date],
        )
      ).rows[0]!;
  const evaluations = run
    ? await f.evidence.listEvaluations(marketId, run.id, {
        includeInput: true,
        limit: 100,
      })
    : [];
  const retainedInputs = evaluations.flatMap((entry) =>
    entry.input ? [entry.input] : [],
  );
  if (diagnostics && diagnostics.runId !== run?.id)
    throw new Error("Capacity diagnostic run ownership mismatch");
  return {
    catalog: {
      rowCount: catalog.rowCount,
      admittedCount: catalog.admittedCount,
    },
    run,
    diagnostics,
    internal,
    evaluator: { successfulResponses: f.engine.successfulResponses[marketId] },
    retainedInputs,
    evaluationSummaries: evaluations.map((entry) => ({
      providerCode: entry.result.providerCode,
      symbolId: entry.result.symbolId,
      reasons: entry.result.reasons,
      state: entry.result.state,
      inputRetained: entry.inputRetained,
      evaluationAt: entry.result.evaluationAt,
      metrics: entry.result.metrics,
    })),
    inputsByProviderCode: new Map(
      evaluations.flatMap((entry) =>
        entry.input ? [[entry.result.providerCode, entry.input] as const] : [],
      ),
    ),
    persisted: {
      evaluations: rows.evaluations,
      diagnostics: rows.diagnostics,
      wrongMarketEvaluations: rows.wrong,
    },
  };
}

export async function runCapacityScenario(
  pool: Pool,
  options: ScenarioOptions,
) {
  const f = await fixture(pool, options);
  try {
    if (options.mapping === "COINCIDENT") {
      // Warm precisely the first four mappings through the actual adapter,
      // mapper and store, with the same shared allowance, outside cycle timing.
      await f.io.drive(
        Promise.all(
          f.markets.flatMap((marketId) =>
            f.catalogs
              .get(marketId)!
              .members.slice(0, 4)
              .map(async (member) => {
                await f.mappers.get(marketId)!.resolve(marketId, member);
                f.mappingStores
                  .get(marketId)!
                  .warmedCodes.add(member.providerCode);
              }),
          ),
        ),
      );
      for (const store of f.mappingStores.values()) store.coincide = true;
    }
    f.limiter.observations.length = 0;
    const virtualStart = Date.now();
    const hostStart = performance.now();
    const schedulers = f.markets.map((marketId) => f.scheduler(marketId));
    const runs = schedulers.map((scheduler) => scheduler.runOnce());
    let monitoringCompleted = 0;
    const monitoring = options.concurrentMonitoring
      ? [0, 10_000, 60_000].map(async (delay) => {
          if (delay)
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          const quotes = await f.adapter.getQuotes([100_001], {
            observation: {
              attemptId: randomUUID(),
              observer: { observe: () => {} },
            },
          });
          if (quotes.length === 1) monitoringCompleted++;
        })
      : [];
    if (options.cancelAtMs !== undefined)
      setTimeout(() => {
        for (const scheduler of schedulers) void scheduler.stop();
      }, options.cancelAtMs);
    const completed = await f.io.drive(
      Promise.all(runs.concat(monitoring.map((work) => work.then(() => null)))),
    );
    const virtualElapsedMs = Date.now() - virtualStart;
    const hostWallMs = performance.now() - hostStart;
    f.engine.assertHealthy();
    const markets: Partial<
      Record<MarketId, Awaited<ReturnType<typeof marketReport>>>
    > = {};
    for (const [index, marketId] of f.markets.entries())
      markets[marketId] = await marketReport(
        f,
        marketId,
        schedulers[index]!,
        completed[index]!,
      );
    const observations = f.limiter.observations.filter(
      (event) => event.discovery,
    );
    const dispatches = observations.filter(
      (event) => event.phase === "DISPATCHED",
    );
    const sharedLimiter = {
      discoveryRequests: observations.filter(
        (event) => event.phase === "QUEUED",
      ).length,
      discoveryDispatched: dispatches.length,
      minimumDiscoverySpacingMs:
        dispatches.length > 1
          ? Math.min(
              ...dispatches
                .slice(1)
                .map((event, index) => +event.at - +dispatches[index]!.at),
            )
          : null,
      monitoringCompleted,
      queuedAfterCompletion: f.limiter.requestCounts.queued,
    };
    const assumptions = {
      evidence: "SYNTHETIC_CAPACITY_ONLY",
      commissioningValidity: "UNVERIFIED",
      providerLatencyMs: options.providerLatencyMs,
      databaseVirtualLatencyMs: 0,
      workersPerMarket: 4,
      discoverySpacingMs: 1_000,
      collectionDeadlineMs: 120_000,
      quoteFreshnessMs: 30_000,
      mapping: options.mapping ?? "STAGGERED",
      quoteAgeAtFreezeMs: options.quoteAgeAtFreezeMs ?? null,
      evaluator: "LOCAL_PRODUCTION_PYTHON_WITH_SHARED_SCHEMA_VALIDATION",
      evaluatorStartup: "BEFORE_MEASURED_CYCLE",
      diagnosticStageTiming: "HOST_MONOTONIC_WALL_CLOCK",
      requestLifecycleTiming: "VIRTUAL_CLOCK",
      adjustmentVerified: false,
    };
    const summary = {
      assumptions,
      virtualElapsedMs,
      hostWallMs,
      sharedLimiter,
      markets: Object.fromEntries(
        Object.entries(markets).map(([id, value]) => [
          id,
          {
            catalog: value.catalog,
            runId: value.run?.id,
            coverage: value.run?.coverage,
            persisted: value.persisted,
            evaluator: value.evaluator,
            requests: value.internal?.requests,
            enrichment: value.internal?.stages.ENRICHMENT.batches,
            quoteAge: value.internal?.quoteAgeBuckets,
            reasons: value.internal?.reasonCounts,
            preCompletionWallMs: value.diagnostics?.preCompletionWallMs,
          },
        ]),
      ),
    };
    return {
      assumptions,
      markets,
      sharedLimiter,
      virtualElapsedMs,
      hostWallMs,
      summary,
      warnings: f.warnings,
    };
  } finally {
    await f.close();
  }
}

export async function runCandleStateScenario(pool: Pool) {
  const f = await fixture(pool, { providerLatencyMs: 100 });
  try {
    const cycle = async () => {
      const before = f.transport.candleRanges.length;
      const scheduler = f.scheduler("CA_TSX");
      const run = await f.io.drive(scheduler.runOnce());
      f.engine.assertHealthy();
      if (!run) throw new Error("Candle capacity cycle did not produce a run");
      const ranges = f.transport.candleRanges.slice(before);
      return {
        run,
        internal: scheduler.getLastAttemptDiagnostics()!,
        maximumDailyRangeMs: Math.max(
          ...ranges
            .filter((range) => range.interval === "OneDay")
            .map((range) => range.end - range.start),
        ),
        maximumSlotRangeMs: Math.max(
          ...ranges
            .filter((range) => range.interval === "FiveMinutes")
            .map((range) => range.end - range.start),
        ),
      };
    };
    await cycle();
    await vi.advanceTimersByTimeAsync(300_000);
    const warm = await cycle();
    await vi.advanceTimersByTimeAsync(300_000);
    f.restartSource("CA_TSX");
    const restarted = await cycle();
    return {
      assumptions: {
        evidence: "SYNTHETIC_CAPACITY_ONLY",
        commissioningValidity: "UNVERIFIED",
        providerLatencyMs: 100,
        cycleSeparationMs: 300_000,
        databaseVirtualLatencyMs: 0,
      },
      warm,
      restarted,
    };
  } finally {
    await f.close();
  }
}

export async function runRestartScenario(
  pool: Pool,
  boundary: "BEFORE_BEGIN" | "AFTER_BEGIN" | "POSTGRES_BUDGET",
) {
  const namespace = `capacity-restart-${randomUUID()}`;
  let cancel: (() => void) | undefined;
  class RestartBudget extends PostgresRequestBudget {
    override async acquire(discovery: boolean) {
      const result = await super.acquire(discovery);
      if (discovery && !result.granted) cancel?.();
      return result;
    }
  }
  const f = await fixture(
    pool,
    { providerLatencyMs: 100 },
    boundary === "POSTGRES_BUDGET"
      ? (db) => new RestartBudget(db, namespace)
      : undefined,
  );
  try {
    const marketId = "CA_TSX" as const;
    const completedBarEnd = new Date(f.initial - 15_000).toISOString();
    const key = {
      marketId,
      tradingDate: f.date,
      policyVersion: discoveryPolicyForMarket(marketId).version,
      completedBarEnd,
      idempotencyKey: `scheduled:${marketId}:${f.date}:${completedBarEnd}`,
    };
    const lease = (await f.control.claim(key, randomUUID(), 600_000))!;
    let original: DiscoveryRun | null = null;
    if (boundary !== "BEFORE_BEGIN") {
      // Crash after the atomic begin commit and before bindRun is a real
      // recovery boundary; reclaim must locate the immutable schedule identity.
      original = await f.evidence.begin({
        ...key,
        mode: "SHADOW",
        evaluationAt: new Date().toISOString(),
        catalog: f.catalogs.get(marketId)!,
      });
    }
    await expireFixtureLease(f, lease);
    let budget: {
      grantsBefore: number;
      discoveryGrantedAfterRestart: boolean;
      monitoringGrantedAfterRestart: boolean;
      discoveryGrantsAfter: number;
    } | null = null;
    if (boundary === "POSTGRES_BUDGET") {
      await f.db.query(
        "INSERT INTO questrade_request_budget(namespace,blocked_until) VALUES($1,clock_timestamp()-interval '1 hour')",
        [namespace],
      );
      await f.db.query(
        "INSERT INTO questrade_request_grant(namespace,started_at,discovery) SELECT $1,clock_timestamp()-interval '1 minute',false FROM generate_series(1,9000)",
        [namespace],
      );
      const restarted = new PostgresRequestBudget(f.db, namespace);
      const grantsBefore = (
        await f.db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM questrade_request_grant WHERE namespace=$1",
          [namespace],
        )
      ).rows[0]!.n;
      const discovery = await restarted.acquire(true);
      const monitoring = await restarted.acquire(false);
      budget = {
        grantsBefore,
        discoveryGrantedAfterRestart: discovery.granted,
        monitoringGrantedAfterRestart: monitoring.granted,
        discoveryGrantsAfter: -1,
      };
    }
    await vi.advanceTimersByTimeAsync(300_000);
    const scheduler = f.scheduler(marketId);
    cancel = () => {
      void scheduler.stop();
    };
    const run = await f.io.drive(scheduler.runOnce());
    f.engine.assertHealthy();
    if (!run) throw new Error("Restart capacity cycle did not produce a run");
    const oldLeaseStatus = (
      await f.db.query<{ status: string }>(
        "SELECT status FROM discovery_schedule_lease WHERE idempotency_key=$1 AND market_id=$2",
        [key.idempotencyKey, marketId],
      )
    ).rows[0]!.status;
    const diagnosticCount = (
      await f.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM discovery_run_diagnostic WHERE run_id=$1",
        [run.id],
      )
    ).rows[0]!.n;
    const orphanDiagnosticCount = (
      await f.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM discovery_run_diagnostic d LEFT JOIN discovery_run r ON r.id=d.run_id WHERE r.id IS NULL",
      )
    ).rows[0]!.n;
    const abandonedScheduleRunCount = (
      await f.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM discovery_run WHERE market_id=$1 AND idempotency_key=$2",
        [marketId, key.idempotencyKey],
      )
    ).rows[0]!.n;
    if (budget)
      budget.discoveryGrantsAfter = (
        await f.db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM questrade_request_grant WHERE namespace=$1 AND discovery",
          [namespace],
        )
      ).rows[0]!.n;
    return {
      assumptions: {
        evidence: "SYNTHETIC_CAPACITY_ONLY",
        commissioningValidity: "UNVERIFIED",
        providerLatencyMs: 100,
        leaseClock: "POSTGRES_WALL_CLOCK",
        budgetClock:
          boundary === "POSTGRES_BUDGET"
            ? "POSTGRES_WALL_CLOCK"
            : "VIRTUAL_CLOCK",
        databaseVirtualLatencyMs: 0,
      },
      run,
      internal: scheduler.getLastAttemptDiagnostics()!,
      oldLeaseStatus,
      diagnosticCount,
      orphanDiagnosticCount,
      abandonedScheduleRunCount,
      recoveredSameRun: original?.id === run.id,
      frozenBoundaryUnchanged: original?.evaluationAt === run.evaluationAt,
      budget,
    };
  } finally {
    await f.close();
  }
}

type MarketReport = Awaited<ReturnType<typeof marketReport>>;
interface ProfileMemberAttribution {
  providerCode: string;
  symbolId: number | null;
  profile: CohortProfile | null;
  catalogReasons: readonly string[];
  state: string | null;
  reasons: readonly string[];
  inputRetained: boolean;
  quotePrice: number | null;
  evaluationAt: string | null;
  requests: {
    searches: number;
    details: number;
    quotes: number;
    daily: number;
    slot: number;
  };
}
interface ProfileMarketReport {
  catalog: MarketReport["catalog"];
  run: MarketReport["run"];
  diagnostics: MarketReport["diagnostics"];
  internal: MarketReport["internal"];
  evaluator: MarketReport["evaluator"];
  members: ProfileMemberAttribution[];
  stagedPruningProjection: {
    boundary: string;
    admittedMembers: number;
    membersWithSlotIndependentFailures: number;
    slotRequestsIssued: number;
    avoidableSlotRequests: number;
    dailyRequestsIssued: number;
    metadataQuoteMembers: number;
  };
}

/**
 * Bounded mixed-profile cohort with the real scheduler, shared limiter, broker
 * adapter, production Python evaluator and isolated PostgreSQL evidence stores.
 * It attributes every broker call to a member so staged-gate suppression and the
 * evaluator-derived staged-pruning projection can be checked per member.
 */
export async function runProfileCohortScenario(
  pool: Pool,
  options: {
    profiles: readonly ProfileAssignment[];
    catalogExcludedCount?: number;
    providerLatencyMs?: number;
    concurrentMonitoring?: boolean;
    marketIds?: readonly MarketId[];
  },
) {
  const f = await fixture(pool, {
    profiles: options.profiles,
    catalogExcludedCount: options.catalogExcludedCount ?? 0,
    providerLatencyMs: options.providerLatencyMs ?? 100,
    concurrentMonitoring: options.concurrentMonitoring ?? false,
    marketIds: options.marketIds,
  });
  try {
    f.limiter.observations.length = 0;
    const virtualStart = Date.now();
    const hostStart = performance.now();
    const schedulers = f.markets.map((marketId) => f.scheduler(marketId));
    const runs = schedulers.map((scheduler) => scheduler.runOnce());
    let monitoringCompleted = 0;
    const monitoring = options.concurrentMonitoring
      ? [0, 10_000, 60_000].map(async (delay) => {
          if (delay)
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          const quotes = await f.adapter.getQuotes([200_001], {
            observation: {
              attemptId: randomUUID(),
              observer: { observe: () => {} },
            },
          });
          if (quotes.length === 1) monitoringCompleted++;
        })
      : [];
    const completed = await f.io.drive(
      Promise.all(runs.concat(monitoring.map((work) => work.then(() => null)))),
    );
    const virtualElapsedMs = Date.now() - virtualStart;
    const hostWallMs = performance.now() - hostStart;
    f.engine.assertHealthy();
    const markets: Partial<Record<MarketId, ProfileMarketReport>> = {};
    for (const [index, marketId] of f.markets.entries()) {
      const report = await marketReport(
        f,
        marketId,
        schedulers[index]!,
        completed[index]!,
      );
      const catalog = f.catalogs.get(marketId)!;
      const members = catalog.members.map((member) => {
        const symbolId =
          f.transport.symbols.get(member.providerCode)?.symbolId ?? null;
        const evaluation = report.evaluationSummaries.find(
          (entry) => entry.providerCode === member.providerCode,
        );
        const input =
          report.inputsByProviderCode.get(member.providerCode) ?? null;
        const includes = (ids: number[]) =>
          symbolId !== null && ids.includes(symbolId);
        return {
          providerCode: member.providerCode,
          symbolId,
          profile:
            symbolId === null
              ? null
              : (f.transport.profileBySymbolId.get(symbolId) ?? "ELIGIBLE"),
          catalogReasons: member.reasons,
          state: evaluation?.state ?? null,
          reasons: evaluation?.reasons ?? [],
          inputRetained: evaluation?.inputRetained ?? false,
          quotePrice: input?.quote?.price ?? null,
          evaluationAt: evaluation?.evaluationAt ?? null,
          requests: {
            searches: f.transport.searchQueries.filter(
              (code) => code === member.providerCode,
            ).length,
            details: f.transport.detailCalls.filter(includes).length,
            quotes: f.transport.quoteCalls.filter(includes).length,
            daily: f.transport.candleRanges.filter(
              (range) =>
                range.symbolId === symbolId && range.interval === "OneDay",
            ).length,
            slot: f.transport.candleRanges.filter(
              (range) =>
                range.symbolId === symbolId && range.interval === "FiveMinutes",
            ).length,
          },
        };
      });
      const admitted = members.filter(
        (member) => member.catalogReasons.length === 0,
      );
      const avoidable = admitted.filter((member) =>
        member.reasons.some((reason) =>
          SLOT_INDEPENDENT_FAILURE_REASONS.has(reason),
        ),
      );
      markets[marketId] = {
        catalog: report.catalog,
        run: report.run,
        diagnostics: report.diagnostics,
        internal: report.internal,
        evaluator: report.evaluator,
        members,
        stagedPruningProjection: {
          boundary: "EVALUATOR_DERIVED_PROJECTION_NOT_A_MEASURED_STAGED_RUN",
          admittedMembers: admitted.length,
          membersWithSlotIndependentFailures: avoidable.length,
          slotRequestsIssued: admitted.reduce(
            (total, member) => total + member.requests.slot,
            0,
          ),
          avoidableSlotRequests: avoidable.reduce(
            (total, member) => total + member.requests.slot,
            0,
          ),
          dailyRequestsIssued: admitted.reduce(
            (total, member) => total + member.requests.daily,
            0,
          ),
          metadataQuoteMembers: admitted.filter(
            (member) => member.requests.quotes > 0,
          ).length,
        },
      };
    }
    const observations = f.limiter.observations.filter(
      (event) => event.discovery,
    );
    const dispatches = observations.filter(
      (event) => event.phase === "DISPATCHED",
    );
    return {
      assumptions: {
        evidence: "SYNTHETIC_CAPACITY_ONLY",
        commissioningValidity: "UNVERIFIED",
        providerLatencyMs: options.providerLatencyMs ?? 100,
        databaseVirtualLatencyMs: 0,
        workersPerMarket: 4,
        discoverySpacingMs: 1_000,
        collectionDeadlineMs: 120_000,
        quoteFreshnessMs: 30_000,
        profiles: options.profiles,
        catalogExcludedCount: options.catalogExcludedCount ?? 0,
        evaluator: "LOCAL_PRODUCTION_PYTHON_WITH_SHARED_SCHEMA_VALIDATION",
        stagedScreening:
          "PROJECTION_ONLY_EVALUATOR_DERIVED_NO_PRODUCTION_PRUNE",
      },
      virtualElapsedMs,
      hostWallMs,
      sharedLimiter: {
        discoveryRequests: observations.filter(
          (event) => event.phase === "QUEUED",
        ).length,
        discoveryDispatched: dispatches.length,
        minimumDiscoverySpacingMs:
          dispatches.length > 1
            ? Math.min(
                ...dispatches
                  .slice(1)
                  .map((event, index) => +event.at - +dispatches[index]!.at),
              )
            : null,
        monitoringCompleted,
        queuedAfterCompletion: f.limiter.requestCounts.queued,
      },
      markets,
      warnings: f.warnings,
    };
  } finally {
    await f.close();
  }
}

/**
 * Two consecutive CA_TSX cycles over the identical retained daily history with a
 * changed current quote. The synthetic evaluator probe makes price, ATR percent
 * and dollar volume visible so the dynamic-versus-reusable separation can be
 * checked without turning synthetic inputs into commissioning evidence.
 */
export async function runDynamicMetricScenario(pool: Pool) {
  const f = await fixture(pool, {
    profiles: [{ profile: "ELIGIBLE", count: 1 }],
    providerLatencyMs: 100,
  });
  try {
    const marketId = "CA_TSX" as const;
    const member = f.catalogs.get(marketId)!.members[0]!;
    const symbolId = f.transport.symbols.get(member.providerCode)!.symbolId;
    const candleMark = f.transport.candleRanges.length;
    const first = f.scheduler(marketId);
    const firstRun = await f.io.drive(first.runOnce());
    f.engine.assertHealthy();
    const firstReport = await marketReport(f, marketId, first, firstRun);
    const firstInput = firstReport.inputsByProviderCode.get(
      member.providerCode,
    )!;
    const firstProbe =
      await f.engine.evaluateSyntheticAdjustmentProbe(firstInput);
    const firstRanges = f.transport.candleRanges.slice(candleMark);
    f.transport.setQuotePrice(symbolId, OUT_OF_RANGE_QUOTE_PRICE);
    await vi.advanceTimersByTimeAsync(300_000);
    f.transport.candleRanges.length = candleMark;
    const second = f.scheduler(marketId);
    const secondRun = await f.io.drive(second.runOnce());
    f.engine.assertHealthy();
    const secondReport = await marketReport(f, marketId, second, secondRun);
    const secondInput = secondReport.inputsByProviderCode.get(
      member.providerCode,
    )!;
    const secondProbe =
      await f.engine.evaluateSyntheticAdjustmentProbe(secondInput);
    const secondRanges = f.transport.candleRanges.slice(candleMark);
    const dailyRanges = (ranges: typeof firstRanges) =>
      ranges
        .filter((range) => range.interval === "OneDay")
        .map((range) => range.end - range.start);
    return {
      assumptions: {
        evidence: "SYNTHETIC_CAPACITY_ONLY",
        commissioningValidity: "UNVERIFIED",
        providerLatencyMs: 100,
        cycleSeparationMs: 300_000,
        databaseVirtualLatencyMs: 0,
        probe: "SYNTHETIC_UNADJUSTED_CONVENTION_NOT_EVIDENCE",
        evaluator: "LOCAL_PRODUCTION_PYTHON_WITH_SHARED_SCHEMA_VALIDATION",
      },
      symbolId,
      first: {
        run: firstRun,
        input: firstInput,
        probe: firstProbe,
        dailyRanges: dailyRanges(firstRanges),
        dailyCache: firstReport.internal?.stages.DAILY_HISTORY.cache,
        slotRequests: firstRanges.filter(
          (range) => range.interval === "FiveMinutes",
        ).length,
      },
      second: {
        run: secondRun,
        input: secondInput,
        probe: secondProbe,
        dailyRanges: dailyRanges(secondRanges),
        dailyCache: secondReport.internal?.stages.DAILY_HISTORY.cache,
        slotRequests: secondRanges.filter(
          (range) => range.interval === "FiveMinutes",
        ).length,
      },
    };
  } finally {
    await f.close();
  }
}

async function expireFixtureLease(f: Fixture, lease: DiscoveryLease) {
  const result = await f.db.query(
    `UPDATE discovery_schedule_lease SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE market_id=$1 AND idempotency_key=$2 AND owner_token=$3 AND fencing_generation=$4`,
    [
      lease.marketId,
      lease.idempotencyKey,
      lease.ownerToken,
      lease.fencingGeneration,
    ],
  );
  if (result.rowCount !== 1)
    throw new Error("Capacity fixture lease identity was not unique");
}
