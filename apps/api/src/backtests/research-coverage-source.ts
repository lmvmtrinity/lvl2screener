import {
  contentHash,
  CoverageInputLimitError,
  type ExpectedInputCell,
  type RetainedInputReceipt,
} from "./research-coverage.js";
import { hashResearchSession } from "./research-session-input.js";
import type { Pool } from "pg";
import type { FrozenCoverageRecipe, MarketId } from "@tsx-scanner/contracts";
import { marketSessionTimezone } from "./execution-provenance.js";
import {
  buildSessionPayload,
  type ReplaySessionPolicy,
} from "./backtest-repository.js";

export type CoverageRequest = {
  marketId: "CA_TSX" | "US_EQUITIES";
  manifestHash: string;
  inputCutoff: string;
  sessionDates: readonly string[];
  recipe?: FrozenCoverageRecipe;
};

/** Upper bound on materialized quote/candle records for one coverage request.
 * The report identity hashes per-cell content digests (see `readSession`), so a
 * scope this large is a policy failure, not a memory budget to squeeze. */
export const MAX_COVERAGE_RETAINED_RECORDS = 5_000_000;

export type FrozenCoverageInputs = {
  expected: ExpectedInputCell[];
  receipts: RetainedInputReceipt[];
  sessionPayloadHashes: Record<string, string>;
  sessionPayloads?: Record<string, Record<string, unknown>>;
};

export interface ResearchCoverageSource {
  readFrozenInputs(
    request: CoverageRequest,
    options?: CoverageReadOptions,
  ): Promise<FrozenCoverageInputs>;
}

/** Optional per-session progress observer; the worker uses it to publish a
 * durable completed/total count while a coverage job is still running. */
export interface CoverageReadOptions {
  onSessionVerified?: (
    completedSessions: number,
    totalSessions: number,
  ) => Promise<void> | void;
}

export type ResearchCoverageSourceOptions = {
  policies?: Partial<Record<MarketId, CoverageSessionPolicy>>;
};

export type CoverageSessionPolicy = {
  timezone: "America/Toronto" | "America/New_York";
  windowStart: string;
  windowEnd: string;
  warmupTimeframe: "Daily" | "OneMinute" | "FiveMinutes";
  warmupDays: number;
  requiredWarmupBars: number;
  maxQuoteGapMs: number;
  streamRequirements?: Array<{
    timeframe: "Daily" | "OneMinute" | "FiveMinutes";
    warmupDays: number;
    requiredWarmupBars: number;
    includeInSession: boolean;
  }>;
};

type ManifestRow = { manifest: unknown; market_id: MarketId };
type RunRow = {
  id: string;
  policy: unknown;
  started_at: Date;
  completed_at: Date | null;
};
type MemberRow = {
  instrument_id: string | null;
  symbol: string;
  eligible: boolean;
  sector: string | null;
};
type BenchmarkRow = {
  id: string;
  symbol: string;
  industry_sector: string | null;
  benchmark_kind: "MARKET" | "SECTOR";
  benchmark_sector: string | null;
};
type QuoteRow = {
  instrument_id: string;
  timestamp: Date;
  bid: string;
  ask: string;
  bid_size: string;
  ask_size: string;
  last: string;
  day_open: string;
  day_high: string;
  day_low: string;
  day_volume: string;
  spread_absolute: string;
  delay_seconds: number | null;
  is_delayed: boolean;
  is_halted: boolean;
  source: string;
};
type CandleRow = {
  instrument_id: string;
  timeframe: "OneMinute" | "FiveMinutes" | "OneDay";
  start_time: Date;
  end_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  is_complete: boolean;
  source: string;
};

/**
 * Read-only retained-input source. The database currently stores provider rows but not a
 * first-class provider-availability/adjustment ledger, so receipts deliberately remain UNKNOWN
 * until those provenance facts are present. The source still hashes and reports the actual rows;
 * it never upgrades a timestamp into evidence of availability.
 */
export class PostgresResearchCoverageSource implements ResearchCoverageSource {
  private readonly policies: Record<MarketId, CoverageSessionPolicy>;

  constructor(
    private readonly pool: Pool,
    options: ResearchCoverageSourceOptions = {},
  ) {
    this.policies = {
      CA_TSX: defaultPolicy("CA_TSX", options.policies?.CA_TSX),
      US_EQUITIES: defaultPolicy("US_EQUITIES", options.policies?.US_EQUITIES),
    };
  }

  async readFrozenInputs(
    request: CoverageRequest,
    options: CoverageReadOptions = {},
  ): Promise<FrozenCoverageInputs> {
    const manifest = await this.pool.query<ManifestRow>(
      "SELECT market_id,manifest FROM research_manifest WHERE hash=$1",
      [request.manifestHash],
    );
    const manifestRow = manifest.rows[0];
    if (!manifestRow) throw new Error("RESEARCH_MANIFEST_NOT_FOUND");
    if (manifestRow.market_id !== request.marketId)
      throw new Error("RESEARCH_MANIFEST_MARKET_MISMATCH");
    const expectedDates = manifestDates(manifestRow.manifest);
    if (
      expectedDates.length > 0 &&
      request.sessionDates.some((date) => !expectedDates.includes(date))
    ) {
      throw new Error("COVERAGE_SESSION_NOT_IN_MANIFEST");
    }

    const expected: ExpectedInputCell[] = [];
    const receipts: RetainedInputReceipt[] = [];
    const sessionPayloadHashes: Record<string, string> = {};
    const sessionPayloads: Record<string, Record<string, unknown>> = {};
    let retainedRecords = 0;
    for (const [index, date] of request.sessionDates.entries()) {
      const session = await this.readSession(request, date);
      retainedRecords += session.retainedRecordCount;
      if (retainedRecords > MAX_COVERAGE_RETAINED_RECORDS)
        throw new CoverageInputLimitError(
          retainedRecords,
          MAX_COVERAGE_RETAINED_RECORDS,
        );
      expected.push(...session.expected);
      receipts.push(...session.receipts);
      sessionPayloadHashes[date] = session.payloadHash;
      sessionPayloads[date] = session.payload;
      await options.onSessionVerified?.(index + 1, request.sessionDates.length);
    }
    return { expected, receipts, sessionPayloadHashes, sessionPayloads };
  }

  private async readSession(
    request: CoverageRequest,
    date: string,
  ): Promise<{
    expected: ExpectedInputCell[];
    receipts: RetainedInputReceipt[];
    retainedRecordCount: number;
    payloadHash: string;
    payload: Record<string, unknown>;
  }> {
    const basePolicy = this.policies[request.marketId];
    const policy: CoverageSessionPolicy = request.recipe
      ? {
          ...basePolicy,
          maxQuoteGapMs: request.recipe.maxQuoteGapMs,
          streamRequirements: request.recipe.streamRequirements,
        }
      : basePolicy;
    const start = zonedBoundary(date, policy.windowStart, policy.timezone);
    const end = zonedBoundary(date, policy.windowEnd, policy.timezone);
    const streamRequirements = policy.streamRequirements ?? [
      {
        timeframe: policy.warmupTimeframe,
        warmupDays: policy.warmupDays,
        requiredWarmupBars: policy.requiredWarmupBars,
        includeInSession: false,
      },
    ];
    const expected: ExpectedInputCell[] = [];
    const receipts: RetainedInputReceipt[] = [];
    const client = await this.pool.connect();
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const run = await client.query<RunRow>(
        `SELECT id,policy,started_at,completed_at
           FROM universe_refresh_run
          WHERE market_id=$1 AND status='COMPLETED'
            AND started_at <= $2 AND completed_at IS NOT NULL AND completed_at <= $3
          ORDER BY started_at DESC, id DESC LIMIT 1`,
        [request.marketId, end, request.inputCutoff],
      );
      const selected = run.rows[0];
      const fallback = selected
        ? selected
        : (
            await client.query<RunRow>(
              `SELECT id,policy,started_at,completed_at
                 FROM universe_refresh_run
                WHERE market_id=$1 AND status='COMPLETED'
                  AND completed_at IS NOT NULL AND completed_at <= $2
                ORDER BY completed_at DESC, id DESC LIMIT 1`,
              [request.marketId, request.inputCutoff],
            )
          ).rows[0];
      const membership = fallback
        ? await client.query<MemberRow>(
            `SELECT instrument_id,symbol,eligible,sector
               FROM universe_membership WHERE run_id=$1 AND eligible=TRUE ORDER BY symbol`,
            [fallback.id],
          )
        : { rows: [] as MemberRow[] };
      const benchmarks = await client.query<BenchmarkRow>(
        `SELECT id,symbol,industry_sector,benchmark_kind,benchmark_sector
           FROM instrument WHERE market_id=$1 AND benchmark_kind IS NOT NULL
          ORDER BY benchmark_kind,symbol,id`,
        [request.marketId],
      );
      const instruments = [
        ...membership.rows
          .filter((row) => row.instrument_id)
          .map((row) => ({
            id: row.instrument_id!,
            symbol: row.symbol,
            role: "CANDIDATE" as const,
            sector: row.sector,
            benchmarkKind: null,
            benchmarkSector: null,
          })),
        ...benchmarks.rows.map((row) => ({
          id: row.id,
          symbol: row.symbol,
          role: (row.benchmark_kind === "MARKET"
            ? "MARKET_BENCHMARK"
            : "SECTOR_BENCHMARK") as ExpectedInputCell["role"],
          sector: row.industry_sector,
          benchmarkKind: row.benchmark_kind,
          benchmarkSector: row.benchmark_sector,
        })),
      ];
      const payloadQuotes = new Map<string, QuoteRow>();
      const payloadCandles = new Map<string, CandleRow>();
      for (const instrument of instruments) {
        const membershipProvenance = fallback
          ? contentHash({
              runId: fallback.id,
              instrumentId: instrument.id,
              date,
            })
          : null;
        for (const stream of streamRequirements) {
          const warmupStart = new Date(
            start.getTime() - stream.warmupDays * 86_400_000,
          );
          const expectedCell: ExpectedInputCell = {
            cellId: `${date}:${instrument.id}:${stream.timeframe}`,
            marketId: request.marketId,
            instrumentId: instrument.id,
            sessionDate: date,
            role: instrument.role,
            membership:
              selected && instrument.role === "CANDIDATE"
                ? "REQUIRED"
                : "UNKNOWN",
            membershipSourceHash: membershipProvenance,
            calendarSourceHash: null,
            windowStart: start.toISOString(),
            windowEnd: end.toISOString(),
            maxQuoteGapMs: policy.maxQuoteGapMs,
            warmupTimeframe: stream.timeframe,
            warmupWindowStart: warmupStart.toISOString(),
            requiredWarmupBars: stream.requiredWarmupBars,
            warmupBefore: start.toISOString(),
          };
          expected.push(expectedCell);
          const quotes = await client.query<QuoteRow>(
            `SELECT instrument_id,timestamp,bid,ask,bid_size,ask_size,last,day_open,day_high,day_low,
                  day_volume,spread_absolute,delay_seconds,is_delayed,is_halted,source
             FROM quote_snapshot
            WHERE instrument_id=$1 AND timestamp >= $2 AND timestamp <= $3 AND timestamp <= $4
            ORDER BY timestamp,source`,
            [instrument.id, start, end, request.inputCutoff],
          );
          const candles = await client.query<CandleRow>(
            `SELECT instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,is_complete,source
             FROM candle
            WHERE instrument_id=$1 AND start_time >= $2 AND start_time < $3 AND end_time <= $4
              AND timeframe=$5
            ORDER BY start_time,source`,
            [
              instrument.id,
              warmupStart,
              stream.includeInSession ? end : start,
              request.inputCutoff,
              dbTimeframe(stream.timeframe),
            ],
          );
          const normalized = normalizeRows(
            instrument.id,
            quotes.rows,
            candles.rows,
          );
          for (const quote of quotes.rows)
            payloadQuotes.set(
              `${quote.instrument_id}:${quote.timestamp.toISOString()}`,
              quote,
            );
          for (const candle of candles.rows)
            if (candle.is_complete)
              payloadCandles.set(
                `${candle.instrument_id}:${candle.timeframe}:${candle.start_time.toISOString()}`,
                candle,
              );
          const receipt: RetainedInputReceipt = {
            cellId: expectedCell.cellId,
            inputHash: contentHash(normalized.records),
            provenance: "UNKNOWN",
            provenanceReasons: [
              "AVAILABILITY_UNPROVEN",
              "ADJUSTMENT_UNPROVEN",
              ...(!request.recipe?.replayPolicy
                ? ["REPLAY_POLICY_UNPROVEN"]
                : []),
            ],
            quoteTimes: normalized.quoteTimes,
            invalidQuoteCount: normalized.invalidQuoteCount,
            warmupTimeframe: stream.timeframe,
            warmupBarTimes: normalized.warmupBarTimes.filter(
              (time) => Date.parse(time) < start.getTime(),
            ),
            invalidWarmupBarCount: normalized.invalidWarmupBarCount,
            // The full-row arrays are content-addressed by `inputHash` above and
            // are not needed for coverage evaluation. Retaining them made the
            // report identity hash stringify every retained row for every cell
            // at once, which overflows the runtime string limit on real scopes.
          };
          receipts.push(receipt);
        }
      }
      const replayPolicy: ReplaySessionPolicy = request.recipe
        ?.replayPolicy ?? {
        marketId: request.marketId,
        timezone: policy.timezone,
        openingRange: { start: "09:30", end: "09:45" },
        scanning: { start: policy.windowStart, end: policy.windowEnd },
        entries: {
          preferredStart: "09:45",
          preferredEnd: "11:30",
          hardEnd: "15:30",
        },
      };
      if (
        replayPolicy.marketId !== request.marketId ||
        replayPolicy.timezone !== policy.timezone
      )
        throw new Error("COVERAGE_REPLAY_POLICY_MARKET_MISMATCH");
      if (
        request.recipe?.replayPolicy &&
        contentHash(replayPolicy) !== request.recipe.replayPolicyHash
      )
        throw new Error("COVERAGE_REPLAY_POLICY_HASH_MISMATCH");
      const payload = buildSessionPayload(
        date,
        instruments.map((i) => ({
          instrumentId: i.id,
          symbol: i.symbol,
          sector: i.sector,
          benchmarkKind: i.benchmarkKind,
          benchmarkSector: i.benchmarkSector,
        })),
        [...payloadQuotes.values()]
          .sort(
            (a, b) =>
              a.timestamp.getTime() - b.timestamp.getTime() ||
              a.instrument_id.localeCompare(b.instrument_id),
          )
          .map((row) => ({ ...row, symbol: "", session_date: date })),
        [...payloadCandles.values()]
          .sort(
            (a, b) =>
              a.end_time.getTime() - b.end_time.getTime() ||
              a.instrument_id.localeCompare(b.instrument_id) ||
              a.timeframe.localeCompare(b.timeframe),
          )
          .map((row) => ({
            ...row,
            symbol: "",
            local_date: dateInZone(row.start_time, policy.timezone),
          })),
        replayPolicy,
      );
      const payloadHash = hashResearchSession(date, payload);
      await client.query("COMMIT");
      return {
        expected,
        receipts,
        retainedRecordCount: payloadQuotes.size + payloadCandles.size,
        payloadHash,
        payload,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function dateInZone(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function defaultPolicy(
  marketId: MarketId,
  override: CoverageSessionPolicy | undefined,
): CoverageSessionPolicy {
  return (
    override ?? {
      timezone: marketSessionTimezone(marketId),
      windowStart: "09:30",
      windowEnd: "16:00",
      warmupTimeframe: "OneMinute",
      warmupDays: 20,
      requiredWarmupBars: 20,
      maxQuoteGapMs: 30_000,
    }
  );
}

function dbTimeframe(
  timeframe: CoverageSessionPolicy["warmupTimeframe"],
): string {
  return timeframe === "Daily" ? "OneDay" : timeframe;
}

function manifestDates(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const plan = (value as { plan?: unknown }).plan;
  if (typeof plan !== "object" || plan === null) return [];
  const dates = (plan as { expectedSessions?: unknown }).expectedSessions;
  return Array.isArray(dates) && dates.every((date) => typeof date === "string")
    ? [...dates]
    : [];
}

function normalizeRows(
  instrumentId: string,
  quotes: readonly QuoteRow[],
  candles: readonly CandleRow[],
) {
  const quoteRecords: Record<string, unknown>[] = [];
  const warmupBarRecords: Record<string, unknown>[] = [];
  let invalidQuoteCount = 0;
  let invalidWarmupBarCount = 0;
  const quoteTimes: string[] = [];
  const warmupBarTimes: string[] = [];
  for (const row of quotes) {
    const values = [
      Number(row.bid),
      Number(row.ask),
      Number(row.bid_size),
      Number(row.ask_size),
      Number(row.last),
      Number(row.day_open),
      Number(row.day_high),
      Number(row.day_low),
      Number(row.day_volume),
      Number(row.spread_absolute),
    ];
    const validTimestamp = Number.isFinite(row.timestamp.getTime());
    if (
      !validTimestamp ||
      values.some((value) => !Number.isFinite(value)) ||
      values[0]! <= 0 ||
      values[1]! <= 0 ||
      values[1]! < values[0]!
    ) {
      invalidQuoteCount++;
      continue;
    }
    const record = {
      instrumentId,
      timestamp: row.timestamp.toISOString(),
      bid: values[0],
      ask: values[1],
      bidSize: values[2],
      askSize: values[3],
      last: values[4],
      dayOpen: values[5],
      dayHigh: values[6],
      dayLow: values[7],
      dayVolume: values[8],
      spread: values[9],
      delaySeconds: row.delay_seconds,
      isDelayed: row.is_delayed,
      isHalted: row.is_halted,
      source: row.source,
    };
    quoteRecords.push(record);
    quoteTimes.push(record.timestamp);
  }
  const seenBars = new Set<string>();
  for (const row of candles) {
    const values = [
      Number(row.open),
      Number(row.high),
      Number(row.low),
      Number(row.close),
      Number(row.volume),
    ];
    const key = `${row.timeframe}:${row.start_time.toISOString()}`;
    if (
      !row.is_complete ||
      seenBars.has(key) ||
      values.some((value) => !Number.isFinite(value)) ||
      values[0]! <= 0 ||
      values[2]! > values[1]! ||
      values[2]! > values[0]! ||
      values[2]! > values[3]! ||
      values[1]! < values[0]! ||
      values[1]! < values[3]!
    ) {
      invalidWarmupBarCount++;
      continue;
    }
    seenBars.add(key);
    const record = {
      instrumentId,
      timeframe: row.timeframe,
      start: row.start_time.toISOString(),
      end: row.end_time.toISOString(),
      open: values[0],
      high: values[1],
      low: values[2],
      close: values[3],
      volume: values[4],
      source: row.source,
    };
    warmupBarRecords.push(record);
    warmupBarTimes.push(record.start);
  }
  return {
    quoteRecords,
    warmupBarRecords,
    quoteTimes,
    warmupBarTimes,
    invalidQuoteCount,
    invalidWarmupBarCount,
    records: { quotes: quoteRecords, candles: warmupBarRecords },
  };
}

function zonedBoundary(
  date: string,
  time: string,
  timezone: "America/Toronto" | "America/New_York",
): Date {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const localHour = Number(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(noonUtc),
  );
  const offsetHours = localHour - 12;
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
      hours! - offsetHours,
      minutes,
    ),
  );
}
