import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ArchiveBarRecord,
  ArchiveQuoteRecord,
} from "./archive-repository.js";

/**
 * Provider clients for the historical archive (ADR-019). Each fetch returns the
 * validated records plus a digest of the exact response bytes, so the import
 * manifest can prove what was retrieved. Invalid provider records are counted
 * and dropped individually; they are never repaired.
 */

export interface ProviderFetch<T> {
  records: T[];
  rejected: number;
  responseSha256: string;
  responseBytes: number;
  requests: number;
  params: Record<string, unknown>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

/** Digest over ordered page digests; one page hashes to its own body digest. */
function combinedDigest(pages: readonly string[]): string {
  if (pages.length === 1) return pages[0]!;
  return createHash("sha256").update(pages.join("\n")).digest("hex");
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

// ---------------------------------------------------------------- Massive ---

const MASSIVE_BASE_URL = "https://api.polygon.io";

export interface MassiveClientOptions {
  apiKey: string;
  /** Free plan: 5 requests/minute. Delay applies between every request. */
  requestDelayMs?: number;
  maxAttempts?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

interface MassiveAggregate {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
  n?: number;
}

export class MassiveHistoryClient {
  private lastRequestAt = 0;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: MassiveClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
  }

  /**
   * Unadjusted aggregates for one ticker over inclusive market-local dates.
   * Daily bars are aligned to local midnight by `dayEnd`.
   */
  async aggregates(
    ticker: string,
    timeframe: "OneMinute" | "OneDay",
    from: string,
    to: string,
    dayEnd: (start: Date) => Date,
  ): Promise<ProviderFetch<ArchiveBarRecord>> {
    const span = timeframe === "OneMinute" ? "minute" : "day";
    const params = {
      ticker,
      multiplier: 1,
      timespan: span,
      from,
      to,
      adjusted: false,
      sort: "asc",
      limit: 50_000,
    };
    let url: string | null =
      `${MASSIVE_BASE_URL}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/${span}/${from}/${to}` +
      `?adjusted=false&sort=asc&limit=50000`;
    const pages: string[] = [];
    let bytes = 0;
    let rejected = 0;
    const records: ArchiveBarRecord[] = [];
    while (url) {
      const body = await this.get(url);
      pages.push(sha256(body));
      bytes += Buffer.byteLength(body);
      const parsed = JSON.parse(body) as {
        status?: string;
        results?: MassiveAggregate[];
        next_url?: string | null;
      };
      if (parsed.status !== "OK" && parsed.status !== "DELAYED")
        throw new ProviderError(
          `Massive returned status ${parsed.status ?? "unknown"}`,
        );
      for (const value of parsed.results ?? []) {
        const record = massiveBar(value, timeframe, dayEnd);
        if (record) records.push(record);
        else rejected += 1;
      }
      url = parsed.next_url ?? null;
    }
    return {
      records,
      rejected,
      responseSha256: combinedDigest(pages),
      responseBytes: bytes,
      requests: pages.length,
      params,
    };
  }

  private async get(url: string): Promise<string> {
    const attempts = this.options.maxAttempts ?? 4;
    for (let attempt = 1; ; attempt += 1) {
      const wait =
        this.lastRequestAt +
        (this.options.requestDelayMs ?? 12_500) -
        Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
      });
      const body = await response.text();
      if (response.ok) return body;
      if (response.status === 429 && attempt < attempts) {
        await this.sleep(60_000);
        continue;
      }
      throw new ProviderError(
        `Massive request failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
        response.status,
      );
    }
  }
}

function massiveBar(
  value: MassiveAggregate,
  timeframe: "OneMinute" | "OneDay",
  dayEnd: (start: Date) => Date,
): ArchiveBarRecord | null {
  const numbers = [value.t, value.o, value.h, value.l, value.c, value.v];
  if (
    numbers.some(
      (number) => typeof number !== "number" || !Number.isFinite(number),
    )
  )
    return null;
  if (value.o <= 0 || value.h <= 0 || value.l <= 0 || value.c <= 0) return null;
  if (value.l > value.h || value.v < 0) return null;
  if (
    value.o > value.h ||
    value.o < value.l ||
    value.c > value.h ||
    value.c < value.l
  )
    return null;
  const startTime = new Date(value.t);
  const endTime =
    timeframe === "OneMinute" ? new Date(value.t + 60_000) : dayEnd(startTime);
  if (!(endTime > startTime)) return null;
  return {
    timeframe,
    startTime,
    endTime,
    open: value.o,
    high: value.h,
    low: value.l,
    close: value.c,
    volume: value.v,
    vwap:
      typeof value.vw === "number" && Number.isFinite(value.vw)
        ? value.vw
        : null,
    tradeCount:
      typeof value.n === "number" && Number.isInteger(value.n) ? value.n : null,
  };
}

// -------------------------------------------------------------- Databento ---

const DATABENTO_BASE_URL = "https://hist.databento.com/v0";
export const DATABENTO_QUOTE_DATASET = "XNAS.BASIC";
export const DATABENTO_QUOTE_SCHEMA = "cbbo-1m";

export interface DatabentoClientOptions {
  apiKey: string;
  fetch?: FetchLike;
}

export class DatabentoHistoryClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: DatabentoClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private query(symbol: string, start: string, end: string): URLSearchParams {
    return new URLSearchParams({
      dataset: DATABENTO_QUOTE_DATASET,
      schema: DATABENTO_QUOTE_SCHEMA,
      symbols: symbol,
      stype_in: "raw_symbol",
      start,
      end,
    });
  }

  /** Free metadata call; the importer checks it before every download. */
  async cost(symbol: string, start: string, end: string): Promise<number> {
    const body = await this.get(
      "metadata.get_cost",
      this.query(symbol, start, end),
    );
    const value = Number(body.trim());
    if (!Number.isFinite(value) || value < 0)
      throw new ProviderError(
        `Databento returned an invalid cost: ${body.slice(0, 80)}`,
      );
    return value;
  }

  /** Minute-sampled consolidated BBO for one symbol over [start, end). */
  async quotes(
    symbol: string,
    start: string,
    end: string,
  ): Promise<ProviderFetch<ArchiveQuoteRecord>> {
    const query = this.query(symbol, start, end);
    for (const [key, value] of Object.entries({
      encoding: "csv",
      pretty_px: "true",
      pretty_ts: "true",
      map_symbols: "true",
      compression: "none",
    }))
      query.set(key, value);
    const body = await this.get("timeseries.get_range", query);
    const { records, rejected } = parseDatabentoCbbo(body, symbol);
    return {
      records,
      rejected,
      responseSha256: sha256(body),
      responseBytes: Buffer.byteLength(body),
      requests: 1,
      params: Object.fromEntries(query.entries()),
    };
  }

  private async get(path: string, query: URLSearchParams): Promise<string> {
    const response = await this.fetchImpl(
      `${DATABENTO_BASE_URL}/${path}?${query}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.options.apiKey}:`).toString("base64")}`,
        },
      },
    );
    const body = await response.text();
    if (!response.ok)
      throw new ProviderError(
        `Databento ${path} failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
        response.status,
      );
    return body;
  }
}

export function parseDatabentoCbbo(
  body: string,
  symbol: string,
): { records: ArchiveQuoteRecord[]; rejected: number } {
  const lines = body.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return { records: [], rejected: 0 };
  const header = lines[0]!.split(",");
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0)
      throw new ProviderError(`Databento CSV is missing column ${name}`);
    return index;
  };
  const ts = column("ts_recv");
  const bid = column("bid_px_00");
  const ask = column("ask_px_00");
  const bidSize = column("bid_sz_00");
  const askSize = column("ask_sz_00");
  const sym = header.indexOf("symbol");
  const records: ArchiveQuoteRecord[] = [];
  let rejected = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (sym >= 0 && cells[sym] !== symbol) {
      rejected += 1;
      continue;
    }
    const sampledAt = new Date(cells[ts]!.replace(/(\.\d{3})\d*Z$/, "$1Z"));
    const record = {
      sampledAt,
      bid: Number(cells[bid]),
      ask: Number(cells[ask]),
      bidSize: Number(cells[bidSize]),
      askSize: Number(cells[askSize]),
    };
    if (
      !Number.isFinite(sampledAt.getTime()) ||
      sampledAt.getTime() % 60_000 !== 0 ||
      !cells[bid] ||
      !cells[ask] ||
      !(record.bid > 0) ||
      !(record.ask >= record.bid) ||
      !Number.isInteger(record.bidSize) ||
      !Number.isInteger(record.askSize) ||
      record.bidSize < 0 ||
      record.askSize < 0
    ) {
      rejected += 1;
      continue;
    }
    records.push(record);
  }
  return { records, rejected };
}
