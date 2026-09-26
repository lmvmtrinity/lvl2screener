import type { Pool } from "pg";
import type { ArchiveBar, ArchiveQuoteSample } from "./archive-session.js";

/** Days of candle history loaded before each session, matching captured replay. */
export const ARCHIVE_CANDLE_LOOKBACK_DAYS = 45;
/** Session payloads keep 20 days of one-minute candles; one spare day is loaded. */
export const ARCHIVE_MINUTE_LOOKBACK_DAYS = 21;

export interface ArchiveTableBounds {
  earliest: string | null;
  latest: string | null;
}

export interface ArchiveImportManifest {
  provider: "MASSIVE" | "DATABENTO";
  dataset: string;
  schemaName: "aggs-1m" | "aggs-1d" | "cbbo-1m";
  instrumentId: string;
  providerSymbol: string;
  rangeStart: string;
  rangeEnd: string;
  requestParams: Record<string, unknown>;
  responseSha256: string;
  responseBytes: number;
  costUsd: number | null;
  retrievedAt: Date;
}

export interface ArchiveImportResult {
  importId: string;
  recordCount: number;
  insertedCount: number;
  conflictingCount: number;
}

export interface ArchiveBarRecord {
  timeframe: "OneMinute" | "OneDay";
  startTime: Date;
  endTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
  tradeCount: number | null;
}

export interface ArchiveQuoteRecord {
  sampledAt: Date;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
}

interface BarRow {
  instrument_id: string;
  timeframe: "OneMinute" | "OneDay";
  start_time: Date;
  end_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface QuoteRow {
  instrument_id: string;
  sampled_at: Date;
  bid: string;
  ask: string;
  bid_size: string;
  ask_size: string;
}

export class PostgresHistoricalArchiveStore {
  constructor(private readonly pool: Pool) {}

  /** Archive bounds for one market's instruments; quotes bound what can replay. */
  async bounds(
    marketId: string,
  ): Promise<{ quote: ArchiveTableBounds; bar: ArchiveTableBounds }> {
    const result = await this.pool.query<{
      source: "quote" | "bar";
      earliest: Date | null;
      latest: Date | null;
    }>(
      `SELECT 'quote'::text AS source, min(q.sampled_at) AS earliest, max(q.sampled_at) AS latest
         FROM historical_quote_minute q JOIN instrument i ON i.id=q.instrument_id
        WHERE i.market_id=$1
       UNION ALL
       SELECT 'bar'::text, min(b.start_time), max(b.start_time)
         FROM historical_bar b JOIN instrument i ON i.id=b.instrument_id
        WHERE i.market_id=$1 AND b.timeframe='OneMinute'`,
      [marketId],
    );
    const bounds = (source: "quote" | "bar"): ArchiveTableBounds => {
      const row = result.rows.find((value) => value.source === source);
      return {
        earliest: row?.earliest?.toISOString() ?? null,
        latest: row?.latest?.toISOString() ?? null,
      };
    };
    return { quote: bounds("quote"), bar: bounds("bar") };
  }

  /**
   * Market-local dates in range where at least one candidate has both archived
   * quote samples and minute bars. Benchmark-only dates are not replayable.
   */
  async sessionDates(
    candidateIds: readonly string[],
    startDate: string,
    endDate: string,
    timezone: string,
  ): Promise<string[]> {
    if (!candidateIds.length) return [];
    const result = await this.pool.query<{ session_date: string }>(
      `SELECT q.session_date FROM (
         SELECT DISTINCT instrument_id, (sampled_at AT TIME ZONE $4)::date AS session_date
           FROM historical_quote_minute
          WHERE instrument_id=ANY($1::uuid[])
            AND sampled_at >= ($2::date::timestamp AT TIME ZONE $4)
            AND sampled_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
       ) q
       WHERE EXISTS (
         SELECT 1 FROM historical_bar b
          WHERE b.instrument_id=q.instrument_id AND b.timeframe='OneMinute'
            AND b.start_time >= (q.session_date::timestamp AT TIME ZONE $4)
            AND b.start_time < ((q.session_date + 1)::timestamp AT TIME ZONE $4)
       )
       GROUP BY q.session_date
       ORDER BY q.session_date`,
      [candidateIds, startDate, endDate, timezone],
    );
    return result.rows.map((row) =>
      typeof row.session_date === "string"
        ? row.session_date
        : (row.session_date as Date).toISOString().slice(0, 10),
    );
  }

  /** Bars in the candle lookback through the session date, and that date's quote samples. */
  async loadSession(
    instrumentIds: readonly string[],
    date: string,
    timezone: string,
  ): Promise<{ bars: ArchiveBar[]; samples: ArchiveQuoteSample[] }> {
    if (!instrumentIds.length) return { bars: [], samples: [] };
    const [bars, quotes] = await Promise.all([
      this.pool.query<BarRow>(
        `SELECT instrument_id,timeframe,start_time,end_time,open,high,low,close,volume
           FROM historical_bar
          WHERE instrument_id=ANY($1::uuid[]) AND provider='MASSIVE'
            AND start_time >= ((
              $2::date - CASE WHEN timeframe='OneMinute' THEN $5::int ELSE $4::int END
            )::timestamp AT TIME ZONE $3)
            AND start_time < (($2::date + 1)::timestamp AT TIME ZONE $3)
          ORDER BY end_time,instrument_id,timeframe`,
        [
          instrumentIds,
          date,
          timezone,
          ARCHIVE_CANDLE_LOOKBACK_DAYS,
          ARCHIVE_MINUTE_LOOKBACK_DAYS,
        ],
      ),
      this.pool.query<QuoteRow>(
        `SELECT instrument_id,sampled_at,bid,ask,bid_size,ask_size
           FROM historical_quote_minute
          WHERE instrument_id=ANY($1::uuid[]) AND provider='DATABENTO'
            AND sampled_at >= ($2::date::timestamp AT TIME ZONE $3)
            AND sampled_at < (($2::date + 1)::timestamp AT TIME ZONE $3)
          ORDER BY sampled_at,instrument_id`,
        [instrumentIds, date, timezone],
      ),
    ]);
    return {
      bars: bars.rows.map((row) => ({
        instrumentId: row.instrument_id,
        timeframe: row.timeframe,
        startTime: row.start_time,
        endTime: row.end_time,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      })),
      samples: quotes.rows.map((row) => ({
        instrumentId: row.instrument_id,
        sampledAt: row.sampled_at,
        bid: Number(row.bid),
        ask: Number(row.ask),
        bidSize: Number(row.bid_size),
        askSize: Number(row.ask_size),
      })),
    };
  }

  /** Start dates of retained imports, so the importer can skip covered ranges. */
  async importedRanges(
    instrumentId: string,
    provider: ArchiveImportManifest["provider"],
    schemaName: ArchiveImportManifest["schemaName"],
  ): Promise<Array<{ start: string; end: string }>> {
    const result = await this.pool.query<{
      range_start: string;
      range_end: string;
    }>(
      `SELECT range_start::text, range_end::text FROM historical_archive_import
        WHERE instrument_id=$1 AND provider=$2 AND schema_name=$3
        ORDER BY range_start`,
      [instrumentId, provider, schemaName],
    );
    return result.rows.map((row) => ({
      start: row.range_start,
      end: row.range_end,
    }));
  }

  async recordBars(
    manifest: ArchiveImportManifest,
    records: readonly ArchiveBarRecord[],
  ): Promise<ArchiveImportResult> {
    return this.record(manifest, records.length, async (client, importId) => {
      const payload = JSON.stringify(
        records.map((value) => ({
          timeframe: value.timeframe,
          start_time: value.startTime.toISOString(),
          end_time: value.endTime.toISOString(),
          open: value.open,
          high: value.high,
          low: value.low,
          close: value.close,
          volume: value.volume,
          vwap: value.vwap,
          trade_count: value.tradeCount,
        })),
      );
      const inserted = await client.query<{ count: string }>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
             timeframe text, start_time timestamptz, end_time timestamptz, open numeric,
             high numeric, low numeric, close numeric, volume numeric, vwap numeric, trade_count integer)
         ), written AS (
           INSERT INTO historical_bar(instrument_id,provider,timeframe,start_time,end_time,open,high,low,close,volume,vwap,trade_count,import_id)
           SELECT $2,'MASSIVE',timeframe,start_time,end_time,open,high,low,close,volume,vwap,trade_count,$3 FROM input
           ON CONFLICT DO NOTHING RETURNING 1
         )
         SELECT count(*)::text AS count FROM written`,
        [payload, manifest.instrumentId, importId],
      );
      const conflicting = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM jsonb_to_recordset($1::jsonb) AS t(
             timeframe text, start_time timestamptz, open numeric, high numeric, low numeric,
             close numeric, volume numeric)
           JOIN historical_bar b ON b.instrument_id=$2 AND b.provider='MASSIVE'
            AND b.timeframe=t.timeframe AND b.start_time=t.start_time
          WHERE b.import_id<>$3
            AND (b.open,b.high,b.low,b.close,b.volume) IS DISTINCT FROM (t.open,t.high,t.low,t.close,t.volume)`,
        [payload, manifest.instrumentId, importId],
      );
      return {
        inserted: Number(inserted.rows[0]!.count),
        conflicting: Number(conflicting.rows[0]!.count),
      };
    });
  }

  async recordQuotes(
    manifest: ArchiveImportManifest,
    records: readonly ArchiveQuoteRecord[],
  ): Promise<ArchiveImportResult> {
    return this.record(manifest, records.length, async (client, importId) => {
      const payload = JSON.stringify(
        records.map((value) => ({
          sampled_at: value.sampledAt.toISOString(),
          bid: value.bid,
          ask: value.ask,
          bid_size: value.bidSize,
          ask_size: value.askSize,
        })),
      );
      const inserted = await client.query<{ count: string }>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
             sampled_at timestamptz, bid numeric, ask numeric, bid_size bigint, ask_size bigint)
         ), written AS (
           INSERT INTO historical_quote_minute(instrument_id,provider,dataset,sampled_at,bid,ask,bid_size,ask_size,import_id)
           SELECT $2,'DATABENTO',$4,sampled_at,bid,ask,bid_size,ask_size,$3 FROM input
           ON CONFLICT DO NOTHING RETURNING 1
         )
         SELECT count(*)::text AS count FROM written`,
        [payload, manifest.instrumentId, importId, manifest.dataset],
      );
      const conflicting = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM jsonb_to_recordset($1::jsonb) AS t(
             sampled_at timestamptz, bid numeric, ask numeric, bid_size bigint, ask_size bigint)
           JOIN historical_quote_minute q ON q.instrument_id=$2 AND q.provider='DATABENTO'
            AND q.dataset=$4 AND q.sampled_at=t.sampled_at
          WHERE q.import_id<>$3
            AND (q.bid,q.ask,q.bid_size,q.ask_size) IS DISTINCT FROM (t.bid,t.ask,t.bid_size,t.ask_size)`,
        [payload, manifest.instrumentId, importId, manifest.dataset],
      );
      return {
        inserted: Number(inserted.rows[0]!.count),
        conflicting: Number(conflicting.rows[0]!.count),
      };
    });
  }

  private async record(
    manifest: ArchiveImportManifest,
    recordCount: number,
    write: (
      client: import("pg").PoolClient,
      importId: string,
    ) => Promise<{ inserted: number; conflicting: number }>,
  ): Promise<ArchiveImportResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query<{ id: string }>(
        `INSERT INTO historical_archive_import(provider,dataset,schema_name,market_id,instrument_id,provider_symbol,
           range_start,range_end,request_params,response_sha256,response_bytes,record_count,inserted_count,
           conflicting_count,cost_usd,retrieved_at)
         VALUES($1,$2,$3,'US_EQUITIES',$4,$5,$6,$7,$8::jsonb,$9,$10,$11,0,0,$12,$13)
         RETURNING id`,
        [
          manifest.provider,
          manifest.dataset,
          manifest.schemaName,
          manifest.instrumentId,
          manifest.providerSymbol,
          manifest.rangeStart,
          manifest.rangeEnd,
          JSON.stringify(manifest.requestParams),
          manifest.responseSha256,
          manifest.responseBytes,
          recordCount,
          manifest.costUsd,
          manifest.retrievedAt,
        ],
      );
      const importId = created.rows[0]!.id;
      const counts = recordCount
        ? await write(client, importId)
        : { inserted: 0, conflicting: 0 };
      await client.query(
        `UPDATE historical_archive_import SET inserted_count=$2, conflicting_count=$3 WHERE id=$1`,
        [importId, counts.inserted, counts.conflicting],
      );
      await client.query("COMMIT");
      return {
        importId,
        recordCount,
        insertedCount: counts.inserted,
        conflictingCount: counts.conflicting,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
