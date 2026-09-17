import type { Pool, PoolClient } from "pg";
import type { MarketId } from "@tsx-scanner/contracts";
import type { Candle, Instrument, Quote } from "../questrade/types.js";
import type { PersistenceMetrics } from "../observability/persistence-metrics.js";
import { chunkRows, countUpsertOutcome } from "./batch-utils.js";

export interface PersistedInstrument extends Instrument {
  id: string;
  /** Legacy callers can omit this during the CA_TSX compatibility window. */
  marketId?: MarketId;
  active: boolean;
  marketCap?: number | null;
  averageVolume20d?: number | null;
  averageVolume90d?: number | null;
  dollarVolume?: number | null;
  atr14?: number | null;
  atrPct?: number | null;
  sector?: string | null;
  benchmarkKind?: "MARKET" | "SECTOR" | null;
  benchmarkSector?: string | null;
}

export interface BenchmarkRole {
  symbolId: number;
  kind: "MARKET" | "SECTOR";
  sector: string | null;
}

export interface MarketDataRepository {
  upsertInstruments(
    instruments: Instrument[],
    marketId?: MarketId,
  ): Promise<PersistedInstrument[]>;
  listActiveInstruments(marketId?: MarketId): Promise<PersistedInstrument[]>;
  listRecoveryInstruments?(marketId: MarketId): Promise<PersistedInstrument[]>;
  /** Replaces the stored benchmark roles so candidates and benchmarks stay distinguishable downstream. */
  markBenchmarks(roles: BenchmarkRole[], marketId?: MarketId): Promise<void>;
  saveQuotes(quotes: Quote[]): Promise<void>;
  saveCandles(candles: Candle[]): Promise<void>;
}

interface InstrumentRow {
  id: string;
  questrade_symbol_id: string;
  symbol: string;
  description: string;
  security_type: string;
  exchange: string;
  currency: string;
  is_quotable: boolean;
  is_tradable: boolean;
  active: boolean;
  benchmark_kind: "MARKET" | "SECTOR" | null;
  benchmark_sector: string | null;
  market_id: MarketId;
}

// See batch-utils.ts for why jsonb_to_recordset was chosen over typed UNNEST arrays / COPY /
// staging tables, and why these bounds are payload-size safety valves rather than parameter-limit
// workarounds (a normal 100-200 symbol quote/candle cycle never approaches them).
const INSTRUMENT_CHUNK_SIZE = 1000;
const QUOTE_CHUNK_SIZE = 1000;
const CANDLE_CHUNK_SIZE = 2000;

export class PostgresMarketDataRepository implements MarketDataRepository {
  constructor(
    private readonly pool: Pool,
    private readonly metrics?: PersistenceMetrics,
  ) {}

  /** Bulk instrument upsert: one `jsonb_to_recordset` statement per chunk instead of one
   *  round trip per instrument. Universe refresh can submit hundreds of symbols at once. */
  async upsertInstruments(
    instruments: Instrument[],
    marketId: MarketId = "CA_TSX",
  ): Promise<PersistedInstrument[]> {
    if (instruments.length === 0) return [];
    const started = performance.now();
    const client = await this.pool.connect();
    const persisted: PersistedInstrument[] = [];
    try {
      await client.query("BEGIN");
      let written = 0;
      let conflicts = 0;
      for (const chunk of chunkRows(instruments, INSTRUMENT_CHUNK_SIZE)) {
        const result = await client.query<
          InstrumentRow & { inserted: boolean }
        >(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
               symbol_id bigint, symbol text, description text, exchange text, currency text,
               security_type text, is_quotable boolean, is_tradable boolean, market_id text
             )
           )
           INSERT INTO instrument (
             market_id, questrade_symbol_id, symbol, description, exchange, currency, security_type,
             is_quotable, is_tradable, active
           )
           SELECT market_id, symbol_id, symbol, description, exchange, currency, security_type,
                  is_quotable, is_tradable, TRUE
           FROM input
           ON CONFLICT (market_id, symbol) DO UPDATE SET
             questrade_symbol_id = EXCLUDED.questrade_symbol_id,
             description = EXCLUDED.description,
             exchange = EXCLUDED.exchange,
             currency = EXCLUDED.currency,
             security_type = EXCLUDED.security_type,
             is_quotable = EXCLUDED.is_quotable,
             is_tradable = EXCLUDED.is_tradable,
             updated_at = NOW()
           RETURNING id, questrade_symbol_id, symbol, description, security_type, exchange,
                     currency, is_quotable, is_tradable, active, benchmark_kind, benchmark_sector, market_id,
                     (xmax = 0) AS inserted`,
          [
            JSON.stringify(
              chunk.map((instrument) => ({
                symbol_id: instrument.symbolId,
                symbol: instrument.symbol,
                description: instrument.description,
                exchange: instrument.exchange,
                currency: instrument.currency,
                security_type: instrument.securityType,
                is_quotable: instrument.isQuotable,
                is_tradable: instrument.isTradable,
                market_id: marketId,
              })),
            ),
          ],
        );
        const outcome = countUpsertOutcome(result.rows);
        written += outcome.written;
        conflicts += outcome.conflicts;
        for (const row of result.rows) persisted.push(mapInstrument(row));
      }
      await client.query("COMMIT");
      this.metrics?.record(
        "instrument",
        written,
        conflicts,
        Math.round((performance.now() - started) * 100) / 100,
      );
      return persisted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listActiveInstruments(
    marketId: MarketId = "CA_TSX",
  ): Promise<PersistedInstrument[]> {
    const result = await this.pool.query<InstrumentRow>(
      `SELECT id, questrade_symbol_id, symbol, description, security_type, exchange,
              currency, is_quotable, is_tradable, active, benchmark_kind, benchmark_sector, market_id
       FROM instrument WHERE market_id=$1 AND active = TRUE ORDER BY symbol`,
      [marketId],
    );
    return result.rows.map(mapInstrument);
  }

  async listRecoveryInstruments(
    marketId: MarketId,
  ): Promise<PersistedInstrument[]> {
    const result = await this.pool.query<InstrumentRow>(
      `SELECT i.* FROM instrument i WHERE i.market_id=$1 AND (
        EXISTS (SELECT 1 FROM paper_execution e
          JOIN paper_signal_observation o ON o.id=e.observation_id
          JOIN paper_bot_run r ON r.id=o.run_id
          WHERE o.instrument_id=i.id AND r.market_id=$1 AND r.source='LIVE'
            AND e.model='QUOTE' AND e.status IN ('OPEN','CLOSE_PENDING')
            AND e.close_abandoned_at IS NULL)
        OR EXISTS (SELECT 1 FROM paper_coordination_position p
          JOIN paper_signal_observation o ON o.id=p.observation_id
          JOIN paper_bot_run r ON r.id=o.run_id
          WHERE o.instrument_id=i.id AND p.market_id=$1 AND r.source='LIVE'
            AND p.status IN ('OPEN','CLOSE_PENDING'))
        OR EXISTS (SELECT 1 FROM paper_entry_order e
          JOIN paper_bot_run r ON r.id=e.run_id
          WHERE e.instrument_id=i.id AND r.market_id=$1 AND r.source='LIVE'
            AND (e.state->>'status'='PENDING'
              OR e.state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING')))
      ) ORDER BY i.symbol`,
      [marketId],
    );
    return result.rows.map(mapInstrument);
  }

  async markBenchmarks(
    roles: BenchmarkRole[],
    marketId: MarketId = "CA_TSX",
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE instrument SET benchmark_kind = NULL, benchmark_sector = NULL
         WHERE market_id=$1 AND benchmark_kind IS NOT NULL AND NOT (questrade_symbol_id = ANY($2::bigint[]))`,
        [marketId, roles.map((role) => role.symbolId)],
      );
      if (roles.length > 0) {
        await client.query(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
               symbol_id bigint, kind text, sector text
             )
           )
           UPDATE instrument i SET benchmark_kind = u.kind, benchmark_sector = u.sector, updated_at = NOW()
           FROM input u WHERE i.market_id=$2 AND i.questrade_symbol_id = u.symbol_id`,
          [
            JSON.stringify(
              roles.map((role) => ({
                symbol_id: role.symbolId,
                kind: role.kind,
                sector: role.sector,
              })),
            ),
            marketId,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Bulk quote persistence for one scan cycle: one `jsonb_to_recordset` upsert per chunk
   *  (normally one statement for a 100-200 symbol cycle) instead of one round trip per quote. */
  async saveQuotes(quotes: Quote[]): Promise<void> {
    if (quotes.length === 0) return;
    await this.runBulk(
      "quote_snapshot",
      quotes,
      QUOTE_CHUNK_SIZE,
      (client, chunk) =>
        client.query<{ inserted: boolean }>(
          `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
             symbol_id bigint, ts timestamptz, bid numeric, ask numeric, bid_size bigint,
             ask_size bigint, bid_size_raw bigint, ask_size_raw bigint, size_unit text,
             size_multiplier integer, last numeric, last_size bigint, day_volume bigint, day_open numeric,
             day_high numeric, day_low numeric, spread_absolute numeric, spread_pct numeric,
             delay_seconds integer, is_delayed boolean, is_halted boolean, source text
           )
         )
         INSERT INTO quote_snapshot (
           instrument_id, timestamp, bid, ask, bid_size, ask_size, bid_size_raw, ask_size_raw,
           size_unit, size_multiplier, last, last_size,
           day_volume, day_open, day_high, day_low, spread_absolute, spread_pct,
           delay_seconds, is_delayed, is_halted, source
         )
         SELECT i.id, u.ts, u.bid, u.ask, u.bid_size, u.ask_size, u.bid_size_raw, u.ask_size_raw,
                u.size_unit, u.size_multiplier, u.last, u.last_size,
                u.day_volume, u.day_open, u.day_high, u.day_low, u.spread_absolute, u.spread_pct,
                u.delay_seconds, u.is_delayed, u.is_halted, u.source
         FROM input u JOIN instrument i ON i.questrade_symbol_id = u.symbol_id
         ON CONFLICT (instrument_id, timestamp, source) DO UPDATE SET
           bid = EXCLUDED.bid, ask = EXCLUDED.ask, bid_size = EXCLUDED.bid_size,
           ask_size = EXCLUDED.ask_size, bid_size_raw = EXCLUDED.bid_size_raw,
           ask_size_raw = EXCLUDED.ask_size_raw, size_unit = EXCLUDED.size_unit,
           size_multiplier = EXCLUDED.size_multiplier, last = EXCLUDED.last, last_size = EXCLUDED.last_size,
           day_volume = EXCLUDED.day_volume, day_open = EXCLUDED.day_open,
           day_high = EXCLUDED.day_high, day_low = EXCLUDED.day_low,
           spread_absolute = EXCLUDED.spread_absolute, spread_pct = EXCLUDED.spread_pct,
           delay_seconds = EXCLUDED.delay_seconds, is_delayed = EXCLUDED.is_delayed,
           is_halted = EXCLUDED.is_halted
         RETURNING (xmax = 0) AS inserted`,
          [
            JSON.stringify(
              chunk.map((quote) => ({
                symbol_id: quote.symbolId,
                ts: quote.receivedAt,
                bid: quote.bid,
                ask: quote.ask,
                bid_size: quote.bidSize,
                ask_size: quote.askSize,
                bid_size_raw: quote.bidSizeRaw ?? quote.bidSize,
                ask_size_raw: quote.askSizeRaw ?? quote.askSize,
                size_unit: quote.sizeUnit ?? "SHARES",
                size_multiplier: quote.sizeMultiplier ?? 1,
                last: quote.last,
                last_size: quote.lastSize,
                day_volume: quote.volume,
                day_open: quote.dayOpen,
                day_high: quote.dayHigh,
                day_low: quote.dayLow,
                spread_absolute: quote.spreadAbsolute,
                spread_pct: quote.spreadPct,
                delay_seconds: quote.delaySeconds,
                is_delayed: quote.isDelayed,
                is_halted: quote.isHalted,
                source: quote.source,
              })),
            ),
          ],
        ),
    );
  }

  /** Bulk candle persistence: one upsert per chunk. Warmup backfill can submit tens of thousands
   *  of rows in a single call, which is what `CANDLE_CHUNK_SIZE` bounds. */
  async saveCandles(candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;
    await this.runBulk("candle", candles, CANDLE_CHUNK_SIZE, (client, chunk) =>
      client.query<{ inserted: boolean }>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
             symbol_id bigint, timeframe text, start_time timestamptz, end_time timestamptz,
             open numeric, high numeric, low numeric, close numeric, volume bigint, source text,
             is_complete boolean
           )
         )
         INSERT INTO candle (
           instrument_id, timeframe, start_time, end_time, open, high, low, close,
           volume, source, is_complete
         )
         SELECT i.id, u.timeframe, u.start_time, u.end_time, u.open, u.high, u.low, u.close,
                u.volume, u.source, u.is_complete
         FROM input u JOIN instrument i ON i.questrade_symbol_id = u.symbol_id
         ON CONFLICT (instrument_id, timeframe, start_time) DO UPDATE SET
           end_time = EXCLUDED.end_time, open = EXCLUDED.open, high = EXCLUDED.high,
           low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume,
           source = EXCLUDED.source, is_complete = EXCLUDED.is_complete
         RETURNING (xmax = 0) AS inserted`,
        [
          JSON.stringify(
            chunk.map((candle) => ({
              symbol_id: candle.symbolId,
              timeframe: candle.interval,
              start_time: candle.start,
              end_time: candle.end,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
              source: candle.source,
              is_complete: candle.isComplete,
            })),
          ),
        ],
      ),
    );
  }

  /** Shared "one transaction, chunked bulk statements, timed as one write" runner used by every
   *  entity above. Chunks execute sequentially inside a single BEGIN/COMMIT so the whole call is
   *  one logical write with no partial commits, while still issuing O(chunks) round trips instead
   *  of O(rows). */
  private async runBulk<T>(
    entity: string,
    items: T[],
    chunkSize: number,
    execute: (
      client: PoolClient,
      chunk: T[],
    ) => Promise<{ rows: { inserted: boolean }[] }>,
  ): Promise<void> {
    const started = performance.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let written = 0;
      let conflicts = 0;
      for (const chunk of chunkRows(items, chunkSize)) {
        const result = await execute(client, chunk);
        const outcome = countUpsertOutcome(result.rows);
        written += outcome.written;
        conflicts += outcome.conflicts;
      }
      await client.query("COMMIT");
      this.metrics?.record(
        entity,
        written,
        conflicts,
        Math.round((performance.now() - started) * 100) / 100,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapInstrument(row: InstrumentRow): PersistedInstrument {
  return {
    id: row.id,
    symbolId: Number(row.questrade_symbol_id),
    symbol: row.symbol,
    description: row.description,
    securityType: row.security_type,
    exchange: row.exchange,
    currency: row.currency,
    isQuotable: row.is_quotable,
    isTradable: row.is_tradable,
    active: row.active,
    benchmarkKind: row.benchmark_kind,
    benchmarkSector: row.benchmark_sector,
    marketId: row.market_id,
  };
}
