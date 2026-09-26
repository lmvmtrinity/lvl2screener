import type { Pool } from "pg";
import {
  ARCHIVE_CANDLE_LOOKBACK_DAYS,
  type ArchiveImportManifest,
  type PostgresHistoricalArchiveStore,
} from "./archive-repository.js";
import {
  DATABENTO_QUOTE_DATASET,
  ProviderError,
  type DatabentoHistoryClient,
  type MassiveHistoryClient,
} from "./provider-clients.js";

export const ARCHIVE_TIMEZONE = "America/New_York";
/** Earliest session XNAS.BASIC retains. */
export const DATABENTO_QUOTE_EARLIEST = "2024-07-01";
/** Daily bars reach further back than the candle lookback so ATR/EMA warm up. */
const DAILY_LOOKBACK_DAYS = 70;

export interface ArchiveImportRequest {
  symbols: readonly string[];
  startDate: string;
  endDate: string;
  includeBenchmarks: boolean;
  /** Upper bound on Databento spend for this invocation, checked before downloading. */
  maxCostUsd: number;
  dryRun: boolean;
  bars: boolean;
  quotes: boolean;
  /** Market-local date treated as "today"; ranges end before it. */
  today: string;
}

export interface ArchiveImportDeps {
  pool: Pool;
  store: PostgresHistoricalArchiveStore;
  massive?: MassiveHistoryClient;
  databento?: DatabentoHistoryClient;
  log: (line: Record<string, unknown>) => void;
}

interface Instrument {
  id: string;
  symbol: string;
}

interface Chunk {
  instrument: Instrument;
  schemaName: ArchiveImportManifest["schemaName"];
  from: string;
  to: string;
}

export interface ArchiveImportSummary {
  instruments: string[];
  missingSymbols: string[];
  plannedChunks: number;
  skippedCoveredChunks: number;
  /** Quote chunks Databento could not resolve (not listed under that symbol then). */
  unresolved: Array<{ symbol: string; from: string; to: string }>;
  estimatedCostUsd: number;
  imported: number;
  failed: Array<{
    symbol: string;
    schema: string;
    from: string;
    to: string;
    error: string;
  }>;
  insertedRows: number;
  conflictingRows: number;
  rejectedRecords: number;
}

export async function runArchiveImport(
  deps: ArchiveImportDeps,
  request: ArchiveImportRequest,
): Promise<ArchiveImportSummary> {
  const { instruments, missing } = await resolveInstruments(deps.pool, request);
  const lastDate = minDate(request.endDate, addDays(request.today, -1));
  const summary: ArchiveImportSummary = {
    instruments: instruments.map((value) => value.symbol),
    missingSymbols: missing,
    plannedChunks: 0,
    skippedCoveredChunks: 0,
    unresolved: [],
    estimatedCostUsd: 0,
    imported: 0,
    failed: [],
    insertedRows: 0,
    conflictingRows: 0,
    rejectedRecords: 0,
  };
  if (lastDate < request.startDate) return summary;

  const chunks: Chunk[] = [];
  for (const instrument of instruments) {
    if (request.bars) {
      chunks.push({
        instrument,
        schemaName: "aggs-1d",
        from: addDays(request.startDate, -DAILY_LOOKBACK_DAYS),
        to: lastDate,
      });
      for (const [from, to] of monthChunks(
        addDays(request.startDate, -ARCHIVE_CANDLE_LOOKBACK_DAYS),
        lastDate,
      ))
        chunks.push({ instrument, schemaName: "aggs-1m", from, to });
    }
    if (request.quotes) {
      const quoteStart = maxDate(request.startDate, DATABENTO_QUOTE_EARLIEST);
      for (const [from, to] of monthChunks(quoteStart, lastDate))
        chunks.push({ instrument, schemaName: "cbbo-1m", from, to });
    }
  }

  const pending: Array<Chunk & { cost: number | null }> = [];
  for (const chunk of chunks) {
    deps.log({
      event: "planning",
      symbol: chunk.instrument.symbol,
      schema: chunk.schemaName,
      from: chunk.from,
      to: chunk.to,
    });
    const provider = chunk.schemaName === "cbbo-1m" ? "DATABENTO" : "MASSIVE";
    const ranges = await deps.store.importedRanges(
      chunk.instrument.id,
      provider,
      chunk.schemaName,
    );
    if (
      ranges.some((range) => range.start <= chunk.from && range.end >= chunk.to)
    ) {
      summary.skippedCoveredChunks += 1;
      continue;
    }
    let cost: number | null = null;
    if (chunk.schemaName === "cbbo-1m") {
      if (!deps.databento)
        throw new Error("DATABENTO_API_KEY is required to import quotes");
      try {
        cost = await deps.databento.cost(
          chunk.instrument.symbol,
          utcDayStart(chunk.from),
          utcDayStart(addDays(chunk.to, 1)),
        );
      } catch (error) {
        // A symbol that did not trade under this ticker during the chunk is
        // skipped and reported; nothing is recorded, so a later run retries it.
        if (!isUnresolvedSymbol(error)) throw error;
        summary.unresolved.push({
          symbol: chunk.instrument.symbol,
          from: chunk.from,
          to: chunk.to,
        });
        continue;
      }
      summary.estimatedCostUsd += cost;
    } else if (!deps.massive)
      throw new Error("MASSIVE_API_KEY is required to import bars");
    pending.push({ ...chunk, cost });
  }
  summary.plannedChunks = pending.length;
  summary.estimatedCostUsd = Math.round(summary.estimatedCostUsd * 1e6) / 1e6;
  deps.log({
    event: "plan",
    instruments: summary.instruments,
    missingSymbols: missing,
    plannedChunks: pending.length,
    skippedCoveredChunks: summary.skippedCoveredChunks,
    unresolved: summary.unresolved,
    estimatedCostUsd: summary.estimatedCostUsd,
    maxCostUsd: request.maxCostUsd,
  });
  if (summary.estimatedCostUsd > request.maxCostUsd)
    throw new Error(
      `Estimated Databento cost $${summary.estimatedCostUsd} exceeds --max-cost $${request.maxCostUsd}; nothing was downloaded.`,
    );
  if (request.dryRun) return summary;

  // Quotes first: they are fast and cheap, while Massive is rate limited.
  pending.sort(
    (left, right) =>
      (left.schemaName === "cbbo-1m" ? 0 : 1) -
      (right.schemaName === "cbbo-1m" ? 0 : 1),
  );
  for (const chunk of pending) {
    try {
      const result = await importChunk(deps, chunk);
      summary.imported += 1;
      summary.insertedRows += result.insertedCount;
      summary.conflictingRows += result.conflictingCount;
      summary.rejectedRecords += result.rejected;
      deps.log({
        event: "imported",
        symbol: chunk.instrument.symbol,
        schema: chunk.schemaName,
        from: chunk.from,
        to: chunk.to,
        records: result.recordCount,
        inserted: result.insertedCount,
        conflicting: result.conflictingCount,
        rejected: result.rejected,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed.push({
        symbol: chunk.instrument.symbol,
        schema: chunk.schemaName,
        from: chunk.from,
        to: chunk.to,
        error: message,
      });
      deps.log({
        event: "failed",
        symbol: chunk.instrument.symbol,
        schema: chunk.schemaName,
        from: chunk.from,
        to: chunk.to,
        error: message,
      });
    }
  }
  return summary;
}

async function importChunk(
  deps: ArchiveImportDeps,
  chunk: Chunk & { cost: number | null },
) {
  const retrievedAt = new Date();
  if (chunk.schemaName === "cbbo-1m") {
    const fetched = await deps.databento!.quotes(
      chunk.instrument.symbol,
      utcDayStart(chunk.from),
      utcDayStart(addDays(chunk.to, 1)),
    );
    // Replay reads only regular-session samples, so extended-hours samples
    // are counted in the manifest and not stored.
    const records = fetched.records.filter((record) =>
      inRegularHours(record.sampledAt),
    );
    const result = await deps.store.recordQuotes(
      {
        provider: "DATABENTO",
        dataset: DATABENTO_QUOTE_DATASET,
        schemaName: "cbbo-1m",
        instrumentId: chunk.instrument.id,
        providerSymbol: chunk.instrument.symbol,
        rangeStart: chunk.from,
        rangeEnd: chunk.to,
        requestParams: {
          ...fetched.params,
          rejectedRecords: fetched.rejected,
          outsideRegularHoursRecords: fetched.records.length - records.length,
        },
        responseSha256: fetched.responseSha256,
        responseBytes: fetched.responseBytes,
        costUsd: chunk.cost,
        retrievedAt,
      },
      records,
    );
    return { ...result, rejected: fetched.rejected };
  }
  const timeframe = chunk.schemaName === "aggs-1d" ? "OneDay" : "OneMinute";
  const fetched = await deps.massive!.aggregates(
    chunk.instrument.symbol,
    timeframe,
    chunk.from,
    chunk.to,
    nextLocalMidnight,
  );
  // Daily bars must start at a market-local midnight to align with captured candles.
  const records = fetched.records.filter(
    (record) =>
      timeframe === "OneMinute" ||
      localMidnight(localDate(record.startTime)).getTime() ===
        record.startTime.getTime(),
  );
  const rejected = fetched.rejected + fetched.records.length - records.length;
  const result = await deps.store.recordBars(
    {
      provider: "MASSIVE",
      dataset: "stocks",
      schemaName: chunk.schemaName,
      instrumentId: chunk.instrument.id,
      providerSymbol: chunk.instrument.symbol,
      rangeStart: chunk.from,
      rangeEnd: chunk.to,
      requestParams: {
        ...fetched.params,
        requests: fetched.requests,
        rejectedRecords: rejected,
      },
      responseSha256: fetched.responseSha256,
      responseBytes: fetched.responseBytes,
      costUsd: null,
      retrievedAt,
    },
    records,
  );
  return { ...result, rejected };
}

function isUnresolvedSymbol(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.status === 422 &&
    error.message.includes("symbology_invalid_request")
  );
}

async function resolveInstruments(
  pool: Pool,
  request: ArchiveImportRequest,
): Promise<{ instruments: Instrument[]; missing: string[] }> {
  const symbols = [
    ...new Set(request.symbols.map((value) => value.trim().toUpperCase())),
  ]
    .filter(Boolean)
    .sort();
  const result = await pool.query<Instrument & { benchmark: boolean }>(
    `SELECT id, symbol, benchmark_kind IS NOT NULL AS benchmark FROM instrument
      WHERE market_id='US_EQUITIES' AND (symbol=ANY($1) OR ($2 AND benchmark_kind IS NOT NULL))
      ORDER BY symbol`,
    [symbols, request.includeBenchmarks],
  );
  const found = new Set(result.rows.map((row) => row.symbol));
  return {
    instruments: result.rows.map((row) => ({ id: row.id, symbol: row.symbol })),
    missing: symbols.filter((symbol) => !found.has(symbol)),
  };
}

// ------------------------------------------------------------ date helpers ---

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

function maxDate(left: string, right: string): string {
  return left > right ? left : right;
}

/** Inclusive [from, to] pairs split at calendar-month boundaries. */
export function monthChunks(from: string, to: string): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  let cursor = from;
  while (cursor <= to) {
    const monthEnd = addDays(`${cursor.slice(0, 7)}-01`, 0);
    const next = new Date(`${monthEnd}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const lastOfMonth = addDays(next.toISOString().slice(0, 10), -1);
    const end = minDate(lastOfMonth, to);
    chunks.push([cursor, end]);
    cursor = addDays(end, 1);
  }
  return chunks;
}

function utcDayStart(date: string): string {
  return `${date}T00:00:00Z`;
}

export function localDate(value: Date, timezone = ARCHIVE_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function offsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) =>
    Number(parts.find((value) => value.type === type)!.value);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
  );
  return Math.round((local - instant.getTime()) / 60_000);
}

/** UTC instant of local midnight on a market-local date, DST-safe. */
export function localMidnight(date: string, timezone = ARCHIVE_TIMEZONE): Date {
  const naive = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  let guess = naive - offsetMinutes(new Date(naive), timezone) * 60_000;
  guess = naive - offsetMinutes(new Date(guess), timezone) * 60_000;
  return new Date(guess);
}

/** Samples after 09:30 through 16:00 market-local; early closes are a subset. */
export function inRegularHours(
  value: Date,
  timezone = ARCHIVE_TIMEZONE,
): boolean {
  const minutes = localMinutes(value, timezone);
  return minutes > 9 * 60 + 30 && minutes <= 16 * 60;
}

function localMinutes(value: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(value);
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)!.value);
  return part("hour") * 60 + part("minute");
}

export function nextLocalMidnight(start: Date): Date {
  return localMidnight(addDays(localDate(start), 1));
}
