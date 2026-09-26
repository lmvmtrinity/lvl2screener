import type { Pool } from "pg";
import type {
  DailySeedPick,
  DailySeedProgress,
  DailySeedRescanStatus,
  DailySeedRunResult,
  DailySeedSelection,
  DailySeedStatus,
  MarketId,
  UniversePolicy,
} from "@tsx-scanner/contracts";
import { normalizeExchange } from "../questrade/exchange.js";
import type {
  Candle,
  CandleInterval,
  CandleRange,
  SymbolSnapshot,
} from "../questrade/types.js";
import { zonedSessionBoundary } from "../paper-bot/session-time.js";
import { calendarSessionBoundaryFor } from "./market-calendar.js";
import { calculateAtr14 } from "./universe-service.js";

export type {
  DailySeedPick,
  DailySeedRunResult,
  DailySeedSelection,
} from "@tsx-scanner/contracts";

/**
 * Pre-market daily-list seed (`daily-seed-v1`, ADR-018).
 *
 * Before the open it screens the Questrade symbols already mapped by discovery
 * against the market's universe policy using previous-session data only, ranks
 * the survivors and adds the top picks to an empty daily list as ordinary
 * MANUAL candidates tagged `daily-seed-v1`. An operator list always wins: a
 * list that already has symbols is never changed by the schedule.
 */
export const DAILY_SEED_VERSION = "daily-seed-v1";

export interface DailySeedPoolMember {
  symbol: string;
  symbolId: number;
  exchange: string;
  description: string;
}

export interface DailySeedPoolSource {
  load(marketId: MarketId): Promise<DailySeedPoolMember[]>;
}

export interface DailySeedMarketData {
  getSymbolSnapshots(symbolIds: number[]): Promise<SymbolSnapshot[]>;
  getCandles(
    symbolId: number,
    interval: CandleInterval,
    range: CandleRange,
  ): Promise<Candle[]>;
}

/** A recorded seed outcome (previews are never recorded). */
export interface DailySeedRunRecord {
  marketId: MarketId;
  tradingDate: string;
  version: string;
  trigger: "SCHEDULE" | "MANUAL";
  status: Exclude<DailySeedRunResult["status"], "PREVIEW">;
  symbols: string[];
  selection: DailySeedSelection | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface DailySeedRunStore {
  record(run: DailySeedRunRecord): Promise<void>;
  /** The latest recorded outcome for a market and trading date. */
  latest(
    marketId: MarketId,
    tradingDate: string,
  ): Promise<DailySeedRunRecord | null>;
}

export interface DailySeedLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export interface DailyListSeederOptions {
  marketId: MarketId;
  enabled: boolean;
  /** Market-local HH:MM at or after which the seed runs on a session day. */
  runAt: string;
  count: number;
  pool: DailySeedPoolSource;
  marketData: DailySeedMarketData;
  policy: () => UniversePolicy;
  /** The current trading date's list symbols (empty when none). */
  currentList: (tradingDate: string) => Promise<string[]>;
  apply: (
    symbols: string[],
    note: string,
    tradingDate?: string,
  ) => Promise<void>;
  store?: DailySeedRunStore;
  clock?: () => Date;
  logger?: DailySeedLogger;
  tickMs?: number;
  retryMs?: number;
  maxAttempts?: number;
  candleConcurrency?: number;
}

/** Listings that are not ordinary operating-company shares. */
const EXCLUDED_DESCRIPTION =
  /\b(ETF|ETN|FUND|WARRANTS?|WTS?|RIGHTS?|PREF(ERRED)?|PFD|NOTES?|DEBENTURES?|UNITS?|CDR|DEPOSITARY|ACQUISITION)\b/i;
/** Seeding stops this long before the close; later additions cannot warm up. */
const LATEST_RUN_BEFORE_CLOSE_MS = 90 * 60_000;
const DAILY_HISTORY_DAYS = 150;
const MAX_LAST_BAR_AGE_MS = 5 * 86_400_000;
const SNAPSHOT_BATCH = 50;

function timezoneFor(marketId: MarketId): string {
  return marketId === "CA_TSX" ? "America/Toronto" : "America/New_York";
}

export function marketLocalDate(now: Date, marketId: MarketId): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezoneFor(marketId),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mean(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

/** True when a pool member's listing text marks it as a non-common share. */
export function excludedListing(description: string): boolean {
  return EXCLUDED_DESCRIPTION.test(description);
}

/** Listing-snapshot prefilter; runs before any per-symbol candle request. */
export function passesSnapshotPrefilter(
  snapshot: SymbolSnapshot,
  policy: UniversePolicy,
): boolean {
  const price = snapshot.prevDayClosePrice;
  const averageVolume = snapshot.averageVol3Months;
  if (snapshot.isQuotable === false || snapshot.isTradable === false)
    return false;
  if (
    snapshot.securityType &&
    !policy.securityTypes.some(
      (value) => value.toUpperCase() === snapshot.securityType!.toUpperCase(),
    )
  )
    return false;
  if (
    snapshot.currency &&
    !policy.allowedCurrencies.includes(
      snapshot.currency.toUpperCase() as "CAD" | "USD",
    )
  )
    return false;
  if (snapshot.description && excludedListing(snapshot.description))
    return false;
  if (price === null || price < policy.minimumPrice) return false;
  if (price > policy.maximumPrice) return false;
  if (
    snapshot.marketCap === null ||
    snapshot.marketCap < policy.minimumMarketCap
  )
    return false;
  if (averageVolume === null || averageVolume < policy.minimumAverageVolume90d)
    return false;
  return price * averageVolume >= policy.minimumDollarVolume;
}

/**
 * Scores one symbol from completed daily bars. Returns null when it fails the
 * universe policy or its history is too short or stale. Weights: previous-day
 * relative volume 40, ATR% above the policy floor 20, close location in the
 * day's range 25, close above the 20-day mean 15.
 *
 * `tradingDayStart` is local midnight of the date being seeded. Questrade ends
 * its newest daily bar at the fetch time, so a US pre-market bar for that date
 * arrives marked complete; every bar starting at or after it is ignored.
 */
export function scoreDailySeedCandidate(
  symbol: string,
  candles: Candle[],
  policy: UniversePolicy,
  now: Date,
  tradingDayStart?: Date,
): DailySeedPick | null {
  const complete = candles
    .filter(
      (value) =>
        value.isComplete &&
        (!tradingDayStart || value.start.getTime() < tradingDayStart.getTime()),
    )
    .sort((left, right) => left.start.getTime() - right.start.getTime());
  if (complete.length < Math.max(policy.minimumHistoryDays, 21)) return null;
  const last = complete.at(-1)!;
  const previous = complete.at(-2)!;
  if (now.getTime() - last.start.getTime() > MAX_LAST_BAR_AGE_MS) return null;
  const price = last.close;
  if (price < policy.minimumPrice || price > policy.maximumPrice) return null;
  const atr14 = calculateAtr14(complete);
  if (atr14 === null) return null;
  const atrPct = (atr14 / price) * 100;
  if (atrPct < policy.minimumAtrPct) return null;
  const averageVolume90d = mean(complete.slice(-90).map((bar) => bar.volume));
  if (
    averageVolume90d === null ||
    averageVolume90d < policy.minimumAverageVolume90d
  )
    return null;
  const dollarVolume = price * averageVolume90d;
  if (dollarVolume < policy.minimumDollarVolume) return null;
  const baseline = mean(complete.slice(-21, -1).map((bar) => bar.volume));
  if (!baseline) return null;
  const relativeVolume = last.volume / baseline;
  const range = last.high - last.low;
  const closeLocation = range > 0 ? (last.close - last.low) / range : 0.5;
  const sma20 = mean(complete.slice(-20).map((bar) => bar.close))!;
  const aboveSma20 = last.close > sma20;
  const changePct =
    previous.close > 0 ? (last.close / previous.close - 1) * 100 : 0;
  const score =
    40 * clamp01((relativeVolume - 0.5) / 2.5) +
    20 * clamp01((atrPct - policy.minimumAtrPct) / (2 * policy.minimumAtrPct)) +
    25 * closeLocation +
    15 * (aboveSma20 ? 1 : 0);
  const round = (value: number, digits = 2) =>
    Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    symbol,
    score: round(score, 1),
    price: round(price, 4),
    atrPct: round(atrPct),
    relativeVolume: round(relativeVolume),
    closeLocation: round(closeLocation),
    changePct: round(changePct),
    aboveSma20,
    dollarVolume: Math.round(dollarVolume),
  };
}

/** Deterministic order: score, then relative volume, then symbol. */
export function rankDailySeedPicks(
  picks: DailySeedPick[],
  count: number,
): DailySeedPick[] {
  return [...picks]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.relativeVolume - left.relativeVolume ||
        left.symbol.localeCompare(right.symbol),
    )
    .slice(0, count);
}

async function mapLimited<T, R>(
  values: T[],
  limit: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await run(values[index]!);
      }
    }),
  );
  return results;
}

const SILENT: DailySeedLogger = { info() {}, warn() {}, error() {} };

export class DailySeedSelectionUnavailableError extends Error {
  constructor() {
    super("No ranking exists for today; preview first");
  }
}

export class DailyListSeeder {
  private readonly clock: () => Date;
  private readonly logger: DailySeedLogger;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<DailySeedRunResult> | null = null;
  private progress: DailySeedProgress | null = null;
  private doneDate: string | null = null;
  private attemptDate: string | null = null;
  private attempts = 0;
  private nextAttemptAt = 0;
  private lastResult: DailySeedRunResult | null = null;
  private resultDate: string | null = null;
  private latestSelection: DailySeedSelection | null = null;
  private restoredDate: string | null = null;
  private rescan: { status(): Promise<DailySeedRescanStatus> } | null = null;
  private poolCache: {
    tradingDate: string;
    members: DailySeedPoolMember[];
  } | null = null;

  constructor(private readonly options: DailyListSeederOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? SILENT;
  }

  get marketId(): MarketId {
    return this.options.marketId;
  }

  start(): void {
    if (!this.options.enabled || this.timer) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.options.tickMs ?? 60_000,
    );
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Pool size after the exchange and listing exclusions (no broker requests). */
  async poolSize(): Promise<number> {
    return (await this.loadPool()).length;
  }

  /** The filtered pool, shared with the early-session rescan. */
  poolMembers(): Promise<DailySeedPoolMember[]> {
    return this.loadPool();
  }

  /** Today's applied, skipped or failed outcome, or null before any run. */
  async todayOutcome(): Promise<DailySeedRunResult | null> {
    const tradingDate = marketLocalDate(this.clock(), this.options.marketId);
    await this.restore(tradingDate);
    return this.resultDate === tradingDate ? this.lastResult : null;
  }

  attachRescan(rescan: { status(): Promise<DailySeedRescanStatus> }): void {
    this.rescan = rescan;
  }

  async status(): Promise<DailySeedStatus> {
    const now = this.clock();
    const tradingDate = marketLocalDate(now, this.options.marketId);
    await this.restore(tradingDate);
    const session = calendarSessionBoundaryFor(
      this.options.marketId,
      tradingDate,
    );
    const scheduledAt = session ? this.scheduledFor(tradingDate) : null;
    const latestRunAt = session
      ? new Date(
          Date.parse(session.close) - LATEST_RUN_BEFORE_CLOSE_MS,
        ).toISOString()
      : null;
    const lastResult = this.resultDate === tradingDate ? this.lastResult : null;
    return {
      marketId: this.options.marketId,
      version: DAILY_SEED_VERSION,
      enabled: this.options.enabled,
      runAt: this.options.runAt,
      count: this.options.count,
      tradingDate,
      session: session ? { open: session.open, close: session.close } : null,
      scheduledAt,
      latestRunAt,
      nextRunAt: this.nextRunAt(now, tradingDate, scheduledAt, latestRunAt),
      doneDate: this.doneDate,
      attempts: this.attemptDate === tradingDate ? this.attempts : 0,
      maxAttempts: this.options.maxAttempts ?? 4,
      nextAttemptAt:
        this.attemptDate === tradingDate && this.nextAttemptAt > 0
          ? new Date(this.nextAttemptAt).toISOString()
          : null,
      running: this.progress,
      lastResult,
      latestSelection:
        this.latestSelection?.tradingDate === tradingDate
          ? this.latestSelection
          : null,
      rescan: this.rescan ? await this.rescan.status() : null,
    };
  }

  private scheduledFor(tradingDate: string): string {
    return zonedSessionBoundary(
      tradingDate,
      this.options.runAt,
      timezoneFor(this.options.marketId),
    );
  }

  private nextRunAt(
    now: Date,
    tradingDate: string,
    scheduledAt: string | null,
    latestRunAt: string | null,
  ): string | null {
    if (!this.options.enabled) return null;
    if (
      scheduledAt &&
      latestRunAt &&
      this.doneDate !== tradingDate &&
      now.getTime() <= Date.parse(latestRunAt) &&
      (this.attemptDate !== tradingDate ||
        this.attempts < (this.options.maxAttempts ?? 4))
    ) {
      const pending = Math.max(Date.parse(scheduledAt), this.nextAttemptAt);
      return new Date(Math.max(pending, now.getTime())).toISOString();
    }
    for (let offset = 1; offset <= 14; offset++) {
      const date = addDays(tradingDate, offset);
      if (calendarSessionBoundaryFor(this.options.marketId, date))
        return this.scheduledFor(date);
    }
    return null;
  }

  /** Restores today's recorded outcome once per trading date (after a restart). */
  private async restore(tradingDate: string): Promise<void> {
    if (this.restoredDate === tradingDate || !this.options.store) return;
    this.restoredDate = tradingDate;
    try {
      const record = await this.options.store.latest(
        this.options.marketId,
        tradingDate,
      );
      if (!record || this.resultDate === tradingDate) return;
      this.lastResult = {
        status: record.status,
        selection: record.selection,
        error: record.error,
        finishedAt: record.finishedAt,
        symbols: record.symbols,
      };
      this.resultDate = tradingDate;
      if (record.selection && !this.latestSelection)
        this.latestSelection = record.selection;
      if (
        record.status === "APPLIED" ||
        record.status === "SKIPPED_LIST_PRESENT"
      )
        this.doneDate = tradingDate;
    } catch (error) {
      this.restoredDate = null;
      this.logger.warn({
        event: "DAILY_SEED_RESTORE_FAILED",
        marketId: this.options.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** True while the scheduled seed should run for this market right now. */
  private due(now: Date, tradingDate: string): boolean {
    if (this.doneDate === tradingDate) return false;
    const session = calendarSessionBoundaryFor(
      this.options.marketId,
      tradingDate,
    );
    if (!session) return false;
    if (now.getTime() < Date.parse(this.scheduledFor(tradingDate)))
      return false;
    if (now.getTime() > Date.parse(session.close) - LATEST_RUN_BEFORE_CLOSE_MS)
      return false;
    if (this.attemptDate !== tradingDate) {
      this.attemptDate = tradingDate;
      this.attempts = 0;
      this.nextAttemptAt = 0;
    }
    if (this.attempts >= (this.options.maxAttempts ?? 4)) return false;
    return now.getTime() >= this.nextAttemptAt;
  }

  async tick(): Promise<DailySeedRunResult | null> {
    if (this.running) return null;
    const now = this.clock();
    const tradingDate = marketLocalDate(now, this.options.marketId);
    await this.restore(tradingDate);
    if (!this.due(now, tradingDate)) return null;
    this.attempts += 1;
    const result = await this.run(tradingDate, true, "SCHEDULE");
    if (result.status !== "APPLIED" && result.status !== "SKIPPED_LIST_PRESENT")
      this.nextAttemptAt =
        this.clock().getTime() + (this.options.retryMs ?? 15 * 60_000);
    return result;
  }

  /** Operator-triggered run for the current trading date; same empty-list rule. */
  async runNow(): Promise<DailySeedRunResult> {
    const tradingDate = marketLocalDate(this.clock(), this.options.marketId);
    await this.restore(tradingDate);
    return this.run(tradingDate, true, "MANUAL");
  }

  /** Read-only selection; uses broker requests but never edits the list. */
  preview(): Promise<DailySeedRunResult> {
    return this.run(
      marketLocalDate(this.clock(), this.options.marketId),
      false,
      "MANUAL",
    );
  }

  /**
   * Adds the top `count` symbols of today's latest ranking to the list,
   * whether or not it already has symbols. Duplicates are ignored by intake.
   */
  async addTop(count: number): Promise<string[]> {
    const tradingDate = marketLocalDate(this.clock(), this.options.marketId);
    await this.restore(tradingDate);
    const selection =
      this.latestSelection?.tradingDate === tradingDate
        ? this.latestSelection
        : null;
    if (!selection || selection.picks.length === 0)
      throw new DailySeedSelectionUnavailableError();
    const symbols = selection.picks
      .slice(0, Math.max(1, count))
      .map((pick) => pick.symbol);
    await this.options.apply(
      symbols,
      `Added from the pre-market ranking (${DAILY_SEED_VERSION}), ${tradingDate}`,
    );
    this.logger.info({
      event: "DAILY_SEED_TOP_ADDED",
      marketId: this.options.marketId,
      tradingDate,
      symbols,
    });
    return symbols;
  }

  private run(
    tradingDate: string,
    apply: boolean,
    trigger: DailySeedRunRecord["trigger"],
  ): Promise<DailySeedRunResult> {
    if (this.running) return this.running;
    this.running = this.execute(tradingDate, apply, trigger).finally(() => {
      this.running = null;
      this.progress = null;
    });
    return this.running;
  }

  private async execute(
    tradingDate: string,
    apply: boolean,
    trigger: DailySeedRunRecord["trigger"],
  ): Promise<DailySeedRunResult> {
    const { marketId } = this.options;
    const startedAt = this.clock().toISOString();
    this.progress = {
      phase: "POOL",
      checked: 0,
      total: 0,
      poolSize: 0,
      prefiltered: 0,
      startedAt,
      apply,
    };
    const finish = async (
      status: DailySeedRunResult["status"],
      selection: DailySeedSelection | null,
      error: string | null = null,
      symbols: string[] = [],
    ): Promise<DailySeedRunResult> => {
      const result: DailySeedRunResult = {
        status,
        selection,
        error,
        finishedAt: this.clock().toISOString(),
        symbols,
      };
      if (selection) this.latestSelection = selection;
      if (!apply || status === "PREVIEW") return result;
      this.lastResult = result;
      this.resultDate = tradingDate;
      if (status === "APPLIED" || status === "SKIPPED_LIST_PRESENT")
        this.doneDate = tradingDate;
      try {
        await this.options.store?.record({
          marketId,
          tradingDate,
          version: DAILY_SEED_VERSION,
          trigger,
          status,
          symbols,
          selection,
          error,
          startedAt,
          finishedAt: result.finishedAt,
        });
      } catch (recordError) {
        this.logger.error({
          event: "DAILY_SEED_RECORD_FAILED",
          marketId,
          tradingDate,
          error:
            recordError instanceof Error
              ? recordError.message
              : String(recordError),
        });
      }
      return result;
    };
    try {
      if (apply) {
        const present = await this.options.currentList(tradingDate);
        if (present.length > 0) {
          this.logger.info({
            event: "DAILY_SEED_SKIPPED_LIST_PRESENT",
            marketId,
            tradingDate,
          });
          return await finish("SKIPPED_LIST_PRESENT", null, null, present);
        }
      }
      const selection = await this.select(tradingDate);
      if (selection.picks.length === 0) {
        this.logger.warn({
          event: "DAILY_SEED_NO_PICKS",
          marketId,
          tradingDate,
          poolSize: selection.poolSize,
          prefiltered: selection.prefiltered,
          scored: selection.scored,
        });
        return await finish(apply ? "NO_PICKS" : "PREVIEW", selection);
      }
      if (!apply) return await finish("PREVIEW", selection);
      // The list may have been filled while the selection ran.
      const present = await this.options.currentList(tradingDate);
      if (present.length > 0) {
        this.logger.info({
          event: "DAILY_SEED_SKIPPED_LIST_PRESENT",
          marketId,
          tradingDate,
        });
        return await finish("SKIPPED_LIST_PRESENT", selection, null, present);
      }
      const symbols = selection.picks.map((pick) => pick.symbol);
      this.progress = { ...this.progress!, phase: "APPLYING" };
      await this.options.apply(
        symbols,
        `Automatic pre-market seed (${DAILY_SEED_VERSION}), ${tradingDate}`,
        tradingDate,
      );
      this.logger.info({
        event: "DAILY_SEED_APPLIED",
        marketId,
        tradingDate,
        poolSize: selection.poolSize,
        prefiltered: selection.prefiltered,
        scored: selection.scored,
        picks: selection.picks,
      });
      return await finish("APPLIED", selection, null, symbols);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "DAILY_SEED_LIST_NOT_EMPTY")
        return finish("SKIPPED_LIST_PRESENT", null);
      this.logger.error({
        event: "DAILY_SEED_FAILED",
        marketId,
        tradingDate,
        error: message,
      });
      return finish("FAILED", null, message);
    }
  }

  /** The pool changes only when mappings do, so it is read once per trading date. */
  private async loadPool(): Promise<DailySeedPoolMember[]> {
    const tradingDate = marketLocalDate(this.clock(), this.options.marketId);
    if (this.poolCache?.tradingDate === tradingDate)
      return this.poolCache.members;
    const policy = this.options.policy();
    const members = (
      await this.options.pool.load(this.options.marketId)
    ).filter((member) => {
      const exchange = normalizeExchange(member.exchange);
      return (
        exchange !== "UNKNOWN" &&
        policy.allowedExchanges.includes(exchange) &&
        !excludedListing(member.description)
      );
    });
    this.poolCache = { tradingDate, members };
    return members;
  }

  private async select(tradingDate: string): Promise<DailySeedSelection> {
    const { marketId, marketData } = this.options;
    const policy = this.options.policy();
    const now = this.clock();
    const pool = await this.loadPool();
    const bySymbolId = new Map(pool.map((member) => [member.symbolId, member]));
    this.progress = {
      ...this.progress!,
      phase: "SNAPSHOTS",
      poolSize: pool.length,
      total: pool.length,
    };
    const snapshots = await marketData.getSymbolSnapshots([
      ...bySymbolId.keys(),
    ]);
    const survivors = snapshots.filter(
      (snapshot) =>
        bySymbolId.has(snapshot.symbolId) &&
        passesSnapshotPrefilter(snapshot, policy),
    );
    this.progress = {
      ...this.progress!,
      phase: "CANDLES",
      prefiltered: survivors.length,
      checked: 0,
      total: survivors.length,
    };
    const range = {
      startTime: new Date(now.getTime() - DAILY_HISTORY_DAYS * 86_400_000),
      endTime: now,
    };
    const tradingDayStart = new Date(
      zonedSessionBoundary(tradingDate, "00:00", timezoneFor(marketId)),
    );
    const scored = (
      await mapLimited(
        survivors,
        this.options.candleConcurrency ?? 4,
        async (snapshot) => {
          const member = bySymbolId.get(snapshot.symbolId)!;
          try {
            const candles = await marketData.getCandles(
              snapshot.symbolId,
              "OneDay",
              range,
            );
            return scoreDailySeedCandidate(
              member.symbol,
              candles,
              policy,
              now,
              tradingDayStart,
            );
          } catch (error) {
            this.logger.warn({
              event: "DAILY_SEED_CANDLES_FAILED",
              marketId,
              symbol: member.symbol,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          } finally {
            if (this.progress)
              this.progress = {
                ...this.progress,
                checked: this.progress.checked + 1,
              };
          }
        },
      )
    ).filter((value): value is DailySeedPick => value !== null);
    return {
      marketId,
      version: DAILY_SEED_VERSION,
      tradingDate,
      selectedAt: now.toISOString(),
      poolSize: pool.length,
      prefiltered: survivors.length,
      scored: scored.length,
      picks: rankDailySeedPicks(scored, this.options.count),
      requests: Math.ceil(pool.length / SNAPSHOT_BATCH) + survivors.length,
      durationMs: Math.max(0, this.clock().getTime() - now.getTime()),
    };
  }
}

/**
 * Seed pool: quotable, tradable stock listings that discovery has already
 * mapped to a Questrade symbol ID. The description includes the latest catalog
 * name, which marks CDRs that Questrade describes as the underlying company.
 * Mapping expiry does not matter here because Questrade symbol IDs are stable
 * and every run re-reads the listing snapshot.
 */
export class PostgresDailySeedPool implements DailySeedPoolSource {
  constructor(private readonly pool: Pool) {}

  // Two plain queries joined here: in one SQL statement the planner
  // under-estimates both sides and re-expands the catalog JSON for every
  // mapping row (27 s for US on September 24, 2026; 13 ms each apart).
  async load(marketId: MarketId): Promise<DailySeedPoolMember[]> {
    const [mappings, catalog] = await Promise.all([
      this.pool.query<{
        provider_code: string;
        symbol: string;
        symbol_id: string;
        exchange: string;
        description: string;
      }>(
        `SELECT DISTINCT ON (decision->'instrument'->>'symbolId')
           provider_code,
           decision->'instrument'->>'symbol' AS symbol,
           decision->'instrument'->>'symbolId' AS symbol_id,
           decision->'instrument'->>'exchange' AS exchange,
           coalesce(decision->'instrument'->>'description','') AS description
         FROM discovery_symbol_mapping
         WHERE market_id=$1
           AND decision->>'status' IN ('RESOLVED','REVIEW_REQUIRED')
           AND (decision->'instrument'->>'isQuotable')::boolean
           AND (decision->'instrument'->>'isTradable')::boolean
           AND decision->'instrument'->>'securityType'='Stock'
         ORDER BY decision->'instrument'->>'symbolId', expires_at DESC`,
        [marketId],
      ),
      this.pool.query<{ provider_code: string | null; name: string | null }>(
        `SELECT member->>'providerCode' AS provider_code,
                member->'raw'->>'Name' AS name
         FROM (
           SELECT snapshot FROM discovery_catalog_snapshot
           WHERE market_id=$1 ORDER BY fetched_at DESC LIMIT 1
         ) latest, jsonb_array_elements(latest.snapshot->'members') member`,
        [marketId],
      ),
    ]);
    const names = new Map<string, string>();
    for (const row of catalog.rows)
      if (row.provider_code && row.name && !names.has(row.provider_code))
        names.set(row.provider_code, row.name);
    return mappings.rows.map((row) => ({
      symbol: row.symbol,
      symbolId: Number(row.symbol_id),
      exchange: row.exchange,
      description: [row.description, names.get(row.provider_code)]
        .filter(Boolean)
        .join(" "),
    }));
  }
}
