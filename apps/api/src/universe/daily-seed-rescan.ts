import {
  discoveryPolicyForMarket,
  type DailySeedRescanCandidate,
  type DailySeedRescanResult,
  type DailySeedRescanStatus,
  type DailySeedRunResult,
  type MarketId,
  type UniversePolicy,
} from "@tsx-scanner/contracts";
import type { Candle } from "../questrade/types.js";
import { zonedSessionBoundary } from "../paper-bot/session-time.js";
import {
  marketLocalDate,
  passesSnapshotPrefilter,
  type DailySeedLogger,
  type DailySeedMarketData,
  type DailySeedPoolMember,
} from "./daily-list-seeder.js";
import { calendarSessionBoundaryFor } from "./market-calendar.js";

/**
 * Early-session rescan (`daily-seed-v2`, ADR-018).
 *
 * The pre-market seed ranks on the previous session only, so it cannot see a
 * stock that starts moving at the open (a TSX name gapping on overnight news
 * has almost no pre-market trading to show it). Shortly after the open this
 * rescans the seed pool's liquid survivors on completed five-minute bars:
 * volume since the open against the same minutes of recent sessions, and the
 * move since the open. The strongest passing symbols are added to a list the
 * seed filled. An operator list is left unchanged, as in v1.
 */
export const DAILY_SEED_RESCAN_VERSION = "daily-seed-v2";

const FIVE_MINUTES_MS = 5 * 60_000;
/** Questrade publishes a five-minute bar shortly after it closes. */
const PUBLICATION_DELAY_MS = 15_000;
/** Scheduled attempts stop this long after the configured run time. */
const RUN_WINDOW_MS = 35 * 60_000;
const PRIOR_SESSIONS = 10;
const MINIMUM_PRIOR_SESSIONS = 5;
const HISTORY_DAYS = 16;
const REPORTED_CANDIDATES = 15;

export interface DailySeedRescanRecord {
  marketId: MarketId;
  trigger: "SCHEDULE" | "MANUAL";
  result: DailySeedRescanResult;
  startedAt: string;
}

export interface DailySeedRescanStore {
  recordRescan(record: DailySeedRescanRecord): Promise<void>;
  latestRescan(
    marketId: MarketId,
    tradingDate: string,
  ): Promise<DailySeedRescanResult | null>;
}

/** What the rescan needs from the pre-market seeder for the same market. */
export interface DailySeedRescanSeed {
  poolMembers(): Promise<DailySeedPoolMember[]>;
  /** Today's pre-market outcome, or null when it has not run. */
  todayOutcome(): Promise<DailySeedRunResult | null>;
}

export interface DailySeedRescanOptions {
  marketId: MarketId;
  enabled: boolean;
  /** Market-local HH:MM after the open. */
  runAt: string;
  maxAdds: number;
  maxCandidates: number;
  seed: DailySeedRescanSeed;
  marketData: DailySeedMarketData;
  policy: () => UniversePolicy;
  currentList: (tradingDate: string) => Promise<string[]>;
  apply: (
    symbols: string[],
    note: string,
    tradingDate: string,
  ) => Promise<void>;
  store?: DailySeedRescanStore;
  clock?: () => Date;
  logger?: DailySeedLogger;
  tickMs?: number;
  retryMs?: number;
  maxAttempts?: number;
  candleConcurrency?: number;
}

function timezoneFor(marketId: MarketId): string {
  return marketId === "CA_TSX" ? "America/Toronto" : "America/New_York";
}

function localParts(value: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Latest five-minute boundary whose bar has been published. */
export function completedBarBoundary(now: Date): Date {
  const time = now.getTime() - PUBLICATION_DELAY_MS;
  return new Date(Math.floor(time / FIVE_MINUTES_MS) * FIVE_MINUTES_MS);
}

/**
 * Measures one symbol's opening activity from five-minute bars. Only bars that
 * ended by `boundary` count (Questrade ends the newest bar at the fetch time,
 * so a bar's own end is not trusted). Returns null without enough history.
 */
export function measureOpeningActivity(
  symbol: string,
  bars: Candle[],
  input: {
    tradingDate: string;
    sessionOpen: Date;
    boundary: Date;
    timezone: string;
    previousClose: number | null;
  },
): Omit<DailySeedRescanCandidate, "passed" | "added"> | null {
  const openMinutes = localParts(input.sessionOpen, input.timezone).minutes;
  const windowMinutes = Math.round(
    (input.boundary.getTime() - input.sessionOpen.getTime()) / 60_000,
  );
  if (windowMinutes < 5) return null;
  const byDate = new Map<string, Candle[]>();
  for (const bar of bars) {
    if (bar.start.getTime() + FIVE_MINUTES_MS > input.boundary.getTime())
      continue;
    const local = localParts(bar.start, input.timezone);
    if (
      local.minutes < openMinutes ||
      local.minutes >= openMinutes + windowMinutes
    )
      continue;
    const list = byDate.get(local.date) ?? [];
    list.push(bar);
    byDate.set(local.date, list);
  }
  const today = (byDate.get(input.tradingDate) ?? []).sort(
    (left, right) => left.start.getTime() - right.start.getTime(),
  );
  if (today.length === 0) return null;
  const volume = (list: Candle[]) =>
    list.reduce((sum, bar) => sum + bar.volume, 0);
  const prior = [...byDate.entries()]
    .filter(([date]) => date < input.tradingDate)
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, PRIOR_SESSIONS)
    .map(([, list]) => volume(list))
    .filter((value) => value > 0);
  if (prior.length < MINIMUM_PRIOR_SESSIONS) return null;
  const baseline = prior.reduce((sum, value) => sum + value, 0) / prior.length;
  const open = today[0]!.open;
  const price = today.at(-1)!.close;
  if (!(open > 0) || !(baseline > 0)) return null;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    symbol,
    relativeVolume: round(volume(today) / baseline),
    changeFromOpenPct: round((price / open - 1) * 100),
    gapPct:
      input.previousClose && input.previousClose > 0
        ? round((open / input.previousClose - 1) * 100)
        : null,
    price: Math.round(price * 10_000) / 10_000,
  };
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

export class DailySeedRescan {
  private readonly clock: () => Date;
  private readonly logger: DailySeedLogger;
  private readonly thresholds: DailySeedRescanResult["thresholds"];
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<DailySeedRescanResult> | null = null;
  private progress: DailySeedRescanStatus["running"] = null;
  private doneDate: string | null = null;
  private attemptDate: string | null = null;
  private attempts = 0;
  private nextAttemptAt = 0;
  private result: DailySeedRescanResult | null = null;
  private restoredDate: string | null = null;

  constructor(private readonly options: DailySeedRescanOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? SILENT;
    const policy = discoveryPolicyForMarket(options.marketId);
    this.thresholds = {
      minimumRelativeVolume: policy.minimumRelativeVolume,
      minimumChangeFromOpenPct: policy.minimumChangeFromOpenPct,
    };
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

  private window(tradingDate: string) {
    const session = calendarSessionBoundaryFor(
      this.options.marketId,
      tradingDate,
    );
    if (!session) return null;
    const scheduledAt = Date.parse(
      zonedSessionBoundary(
        tradingDate,
        this.options.runAt,
        timezoneFor(this.options.marketId),
      ),
    );
    const latestRunAt = Math.min(
      scheduledAt + RUN_WINDOW_MS,
      Date.parse(session.close),
    );
    return { session, scheduledAt, latestRunAt };
  }

  async status(): Promise<DailySeedRescanStatus> {
    const tradingDate = marketLocalDate(this.clock(), this.options.marketId);
    await this.restore(tradingDate);
    const window = this.window(tradingDate);
    return {
      version: DAILY_SEED_RESCAN_VERSION,
      enabled: this.options.enabled,
      runAt: this.options.runAt,
      maxAdds: this.options.maxAdds,
      scheduledAt: window ? new Date(window.scheduledAt).toISOString() : null,
      latestRunAt: window ? new Date(window.latestRunAt).toISOString() : null,
      running: this.progress,
      result: this.result?.tradingDate === tradingDate ? this.result : null,
    };
  }

  private async restore(tradingDate: string): Promise<void> {
    if (this.restoredDate === tradingDate || !this.options.store) return;
    this.restoredDate = tradingDate;
    try {
      const stored = await this.options.store.latestRescan(
        this.options.marketId,
        tradingDate,
      );
      if (!stored || this.result?.tradingDate === tradingDate) return;
      this.result = stored;
      if (stored.status !== "FAILED") this.doneDate = tradingDate;
    } catch (error) {
      this.restoredDate = null;
      this.logger.warn({
        event: "DAILY_SEED_RESCAN_RESTORE_FAILED",
        marketId: this.options.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async tick(): Promise<DailySeedRescanResult | null> {
    if (this.running) return null;
    const now = this.clock();
    const tradingDate = marketLocalDate(now, this.options.marketId);
    await this.restore(tradingDate);
    if (this.doneDate === tradingDate) return null;
    const window = this.window(tradingDate);
    if (!window) return null;
    if (
      now.getTime() < window.scheduledAt ||
      now.getTime() > window.latestRunAt
    )
      return null;
    if (this.attemptDate !== tradingDate) {
      this.attemptDate = tradingDate;
      this.attempts = 0;
      this.nextAttemptAt = 0;
    }
    if (this.attempts >= (this.options.maxAttempts ?? 3)) return null;
    if (now.getTime() < this.nextAttemptAt) return null;
    this.attempts += 1;
    const result = await this.run(tradingDate, "SCHEDULE");
    if (result.status === "FAILED")
      this.nextAttemptAt =
        this.clock().getTime() + (this.options.retryMs ?? 5 * 60_000);
    return result;
  }

  /** Operator-triggered rescan for today; same list rule as the schedule. */
  runNow(): Promise<DailySeedRescanResult> {
    const tradingDate = marketLocalDate(this.clock(), this.options.marketId);
    return this.run(tradingDate, "MANUAL");
  }

  private run(
    tradingDate: string,
    trigger: DailySeedRescanRecord["trigger"],
  ): Promise<DailySeedRescanResult> {
    if (this.running) return this.running;
    this.running = this.execute(tradingDate, trigger).finally(() => {
      this.running = null;
      this.progress = null;
    });
    return this.running;
  }

  private async execute(
    tradingDate: string,
    trigger: DailySeedRescanRecord["trigger"],
  ): Promise<DailySeedRescanResult> {
    const { marketId } = this.options;
    const startedAt = this.clock().toISOString();
    this.progress = { checked: 0, total: 0, startedAt };
    const empty = {
      version: DAILY_SEED_RESCAN_VERSION,
      tradingDate,
      barsThrough: null,
      thresholds: this.thresholds,
      poolSize: 0,
      prefiltered: 0,
      evaluated: 0,
      candidates: [],
      added: [],
      error: null,
    };
    const finish = async (
      result: Omit<DailySeedRescanResult, "finishedAt">,
    ): Promise<DailySeedRescanResult> => {
      const complete = { ...result, finishedAt: this.clock().toISOString() };
      this.result = complete;
      if (complete.status !== "FAILED") this.doneDate = tradingDate;
      try {
        await this.options.store?.recordRescan({
          marketId,
          trigger,
          result: complete,
          startedAt,
        });
      } catch (error) {
        this.logger.error({
          event: "DAILY_SEED_RESCAN_RECORD_FAILED",
          marketId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return complete;
    };
    try {
      const outcome = await this.options.seed.todayOutcome();
      const list = await this.options.currentList(tradingDate);
      if (list.length > 0 && outcome?.status !== "APPLIED") {
        this.logger.info({
          event: "DAILY_SEED_RESCAN_SKIPPED_LIST_PRESENT",
          marketId,
          tradingDate,
        });
        return await finish({ ...empty, status: "SKIPPED_LIST_PRESENT" });
      }
      const window = this.window(tradingDate);
      if (!window) throw new Error("No regular session today");
      const now = this.clock();
      const boundary = completedBarBoundary(now);
      const policy = this.options.policy();
      const pool = await this.options.seed.poolMembers();
      const onList = new Set(list);
      const bySymbolId = new Map(
        pool
          .filter((member) => !onList.has(member.symbol))
          .map((member) => [member.symbolId, member]),
      );
      const snapshots = (
        await this.options.marketData.getSymbolSnapshots([...bySymbolId.keys()])
      ).filter(
        (snapshot) =>
          bySymbolId.has(snapshot.symbolId) &&
          passesSnapshotPrefilter(snapshot, policy),
      );
      const selected = [...snapshots]
        .sort(
          (left, right) =>
            (right.prevDayClosePrice ?? 0) * (right.averageVol3Months ?? 0) -
            (left.prevDayClosePrice ?? 0) * (left.averageVol3Months ?? 0),
        )
        .slice(0, this.options.maxCandidates);
      this.progress = { checked: 0, total: selected.length, startedAt };
      const range = {
        startTime: new Date(now.getTime() - HISTORY_DAYS * 86_400_000),
        endTime: now,
      };
      let candleFailures = 0;
      const measured = (
        await mapLimited(
          selected,
          this.options.candleConcurrency ?? 4,
          async (snapshot) => {
            const member = bySymbolId.get(snapshot.symbolId)!;
            try {
              const bars = await this.options.marketData.getCandles(
                snapshot.symbolId,
                "FiveMinutes",
                range,
              );
              return measureOpeningActivity(member.symbol, bars, {
                tradingDate,
                sessionOpen: new Date(window.session.open),
                boundary,
                timezone: timezoneFor(marketId),
                previousClose: snapshot.prevDayClosePrice,
              });
            } catch (error) {
              candleFailures += 1;
              this.logger.warn({
                event: "DAILY_SEED_RESCAN_CANDLES_FAILED",
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
      ).filter((value) => value !== null);
      if (selected.length > 0 && candleFailures === selected.length)
        throw new Error("All rescan candle requests failed; retry required");
      const ranked = measured
        .map((value) => ({
          ...value,
          passed:
            value.relativeVolume >= this.thresholds.minimumRelativeVolume &&
            value.changeFromOpenPct >=
              this.thresholds.minimumChangeFromOpenPct &&
            value.price >= policy.minimumPrice &&
            value.price <= policy.maximumPrice,
          added: false,
        }))
        .sort(
          (left, right) =>
            right.relativeVolume - left.relativeVolume ||
            right.changeFromOpenPct - left.changeFromOpenPct ||
            left.symbol.localeCompare(right.symbol),
        );
      const added = ranked
        .filter((value) => value.passed)
        .slice(0, this.options.maxAdds)
        .map((value) => value.symbol);
      const addedSet = new Set(added);
      const candidates = ranked
        .map((value) => ({ ...value, added: addedSet.has(value.symbol) }))
        .slice(0, REPORTED_CANDIDATES);
      const base = {
        ...empty,
        barsThrough: boundary.toISOString(),
        poolSize: pool.length,
        prefiltered: snapshots.length,
        evaluated: measured.length,
        candidates,
      };
      if (added.length === 0) {
        this.logger.info({
          event: "DAILY_SEED_RESCAN_NO_PICKS",
          marketId,
          tradingDate,
          evaluated: measured.length,
        });
        return await finish({ ...base, status: "NO_PICKS" });
      }
      // The operator may have pasted a list while the bars were read.
      const latest = await this.options.currentList(tradingDate);
      const latestOutcome = await this.options.seed.todayOutcome();
      if (latest.length > 0 && latestOutcome?.status !== "APPLIED")
        return await finish({ ...base, status: "SKIPPED_LIST_PRESENT" });
      await this.options.apply(
        added,
        `Early-session rescan (${DAILY_SEED_RESCAN_VERSION}), ${tradingDate}`,
        tradingDate,
      );
      this.logger.info({
        event: "DAILY_SEED_RESCAN_APPLIED",
        marketId,
        tradingDate,
        added,
        candidates,
      });
      return await finish({ ...base, status: "APPLIED", added });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "DAILY_SEED_RESCAN_LIST_NOT_OWNED")
        return finish({ ...empty, status: "SKIPPED_LIST_PRESENT" });
      this.logger.error({
        event: "DAILY_SEED_RESCAN_FAILED",
        marketId,
        tradingDate,
        error: message,
      });
      return finish({ ...empty, status: "FAILED", error: message });
    }
  }
}
