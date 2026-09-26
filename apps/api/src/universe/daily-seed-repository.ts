import {
  dailySeedRescanResultSchema,
  dailySeedSelectionSchema,
  type DailySeedHistoryEntry,
  type DailySeedRescanResult,
  type DailySeedLegacy,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import {
  DAILY_SEED_VERSION,
  type DailySeedRunRecord,
  type DailySeedRunStore,
} from "./daily-list-seeder.js";
import {
  DAILY_SEED_RESCAN_VERSION,
  type DailySeedRescanRecord,
  type DailySeedRescanStore,
} from "./daily-seed-rescan.js";
import { calendarSessionBoundaryFor } from "./market-calendar.js";

interface RunRow {
  id: string;
  market_id: MarketId;
  trading_date: string;
  version: string;
  trigger: DailySeedRunRecord["trigger"];
  status: DailySeedRunRecord["status"];
  symbols: string[];
  selection: unknown;
  error: string | null;
  started_at: Date;
  finished_at: Date;
}

const RUN_COLUMNS = `id,market_id,trading_date::text AS trading_date,version,trigger,status,
  symbols,selection,error,started_at,finished_at`;

function toRecord(row: RunRow): DailySeedRunRecord {
  const parsed = dailySeedSelectionSchema.safeParse(row.selection);
  return {
    marketId: row.market_id,
    tradingDate: row.trading_date,
    version: row.version,
    trigger: row.trigger,
    status: row.status,
    symbols: row.symbols,
    selection: parsed.success ? parsed.data : null,
    error: row.error,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
  };
}

/** The engine is frozen (ADR-018), so its facts are read once a day; the
 *  decision count scans the multi-gigabyte evaluation table. */
const LEGACY_CACHE_MS = 24 * 60 * 60_000;

export class PostgresDailySeedRepository
  implements DailySeedRunStore, DailySeedRescanStore
{
  private legacyCache: {
    at: number;
    value: Omit<DailySeedLegacy, "markets"> & {
      markets: Omit<DailySeedLegacy["markets"][number], "poolSize">[];
    };
  } | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async record(run: DailySeedRunRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO daily_seed_run(
         market_id,trading_date,version,trigger,status,symbols,selection,error,
         started_at,finished_at
       ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
      [
        run.marketId,
        run.tradingDate,
        run.version,
        run.trigger,
        run.status,
        JSON.stringify(run.symbols),
        run.selection ? JSON.stringify(run.selection) : null,
        run.error,
        run.startedAt,
        run.finishedAt,
      ],
    );
  }

  async latest(
    marketId: MarketId,
    tradingDate: string,
  ): Promise<DailySeedRunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM daily_seed_run
       WHERE market_id=$1 AND trading_date=$2 AND version=$3
       ORDER BY finished_at DESC LIMIT 1`,
      [marketId, tradingDate, DAILY_SEED_VERSION],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async recordRescan(record: DailySeedRescanRecord): Promise<void> {
    const { result } = record;
    await this.pool.query(
      `INSERT INTO daily_seed_run(
         market_id,trading_date,version,trigger,status,symbols,selection,error,
         started_at,finished_at
       ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
      [
        record.marketId,
        result.tradingDate,
        result.version,
        record.trigger,
        result.status,
        JSON.stringify(result.added),
        JSON.stringify(result),
        result.error,
        record.startedAt,
        result.finishedAt,
      ],
    );
  }

  async latestRescan(
    marketId: MarketId,
    tradingDate: string,
  ): Promise<DailySeedRescanResult | null> {
    const result = await this.pool.query<{ selection: unknown }>(
      `SELECT selection FROM daily_seed_run
       WHERE market_id=$1 AND trading_date=$2 AND version=$3
       ORDER BY finished_at DESC LIMIT 1`,
      [marketId, tradingDate, DAILY_SEED_RESCAN_VERSION],
    );
    const parsed = dailySeedRescanResultSchema.safeParse(
      result.rows[0]?.selection,
    );
    return parsed.success ? parsed.data : null;
  }

  /**
   * The latest outcome per trading date, newest first. Outcomes for a date's
   * symbols (READY transitions, closed quote-model paper trades and their net
   * R) are computed only after that session has closed.
   */
  async history(
    marketId: MarketId,
    limit = 30,
  ): Promise<DailySeedHistoryEntry[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT DISTINCT ON (trading_date) ${RUN_COLUMNS} FROM daily_seed_run
       WHERE market_id=$1 AND version=$3
       ORDER BY trading_date DESC, finished_at DESC
       LIMIT $2`,
      [marketId, limit, DAILY_SEED_VERSION],
    );
    const rescans = await this.pool.query<{
      trading_date: string;
      status: string;
      symbols: string[];
    }>(
      `SELECT DISTINCT ON (trading_date) trading_date::text AS trading_date,
         status, symbols
       FROM daily_seed_run
       WHERE market_id=$1 AND version=$2 AND trading_date = ANY($3::date[])
       ORDER BY trading_date DESC, finished_at DESC`,
      [
        marketId,
        DAILY_SEED_RESCAN_VERSION,
        result.rows.map((row) => row.trading_date),
      ],
    );
    const rescanByDate = new Map(
      rescans.rows
        .filter((row) => row.status === "APPLIED")
        .map((row) => [row.trading_date, row.symbols]),
    );
    const now = this.clock().getTime();
    return Promise.all(
      result.rows.map(async (row) => {
        const record = toRecord(row);
        const session = calendarSessionBoundaryFor(marketId, row.trading_date);
        const closed = session !== null && now >= Date.parse(session.close);
        const rescanSymbols = rescanByDate.get(row.trading_date) ?? [];
        const symbols = [...new Set([...record.symbols, ...rescanSymbols])];
        return {
          id: row.id,
          marketId,
          tradingDate: row.trading_date,
          trigger: record.trigger,
          status: record.status,
          symbols,
          pickCount: record.selection?.picks.length ?? 0,
          error: record.error,
          finishedAt: record.finishedAt,
          rescanSymbols,
          rescanOutcomes:
            closed && session && rescanSymbols.length > 0
              ? await this.outcomes(
                  marketId,
                  rescanSymbols,
                  session.open,
                  session.close,
                )
              : null,
          outcomes:
            closed && session && symbols.length > 0
              ? await this.outcomes(
                  marketId,
                  symbols,
                  session.open,
                  session.close,
                )
              : null,
        };
      }),
    );
  }

  private async outcomes(
    marketId: MarketId,
    symbols: string[],
    open: string,
    close: string,
  ): Promise<NonNullable<DailySeedHistoryEntry["outcomes"]>> {
    const result = await this.pool.query<{
      ready: string;
      trades: string;
      net_r: string | null;
    }>(
      `WITH seeded AS (
         SELECT id FROM instrument
         WHERE market_id=$1 AND symbol = ANY($2::text[])
       )
       SELECT
         (SELECT count(DISTINCT event.instrument_id) FROM strategy_state_event event
          WHERE event.market_id=$1 AND event.new_state='READY'
            AND event.instrument_id IN (SELECT id FROM seeded)
            AND event."timestamp" >= $3 AND event."timestamp" < $4) AS ready,
         count(execution.id) AS trades,
         sum(execution.r_multiple) AS net_r
       FROM paper_signal_observation observation
       JOIN paper_execution execution ON execution.observation_id=observation.id
       WHERE observation.instrument_id IN (SELECT id FROM seeded)
         AND observation.signal_timestamp >= $3 AND observation.signal_timestamp < $4
         AND execution.market_id=$1 AND execution.model='QUOTE'
         AND execution.status='CLOSED'`,
      [marketId, symbols, open, close],
    );
    const row = result.rows[0];
    return {
      readySymbols: Number(row?.ready ?? 0),
      paperTrades: Number(row?.trades ?? 0),
      paperNetR:
        row?.net_r === null || row?.net_r === undefined
          ? null
          : Math.round(Number(row.net_r) * 100) / 100,
    };
  }

  /** Facts about the frozen ADR-017 engine; pool sizes come from the seeders. */
  async legacy(
    poolSizes: Partial<Record<MarketId, number>>,
  ): Promise<DailySeedLegacy> {
    const now = this.clock().getTime();
    if (!this.legacyCache || now - this.legacyCache.at > LEGACY_CACHE_MS) {
      const [modes, runs, size, mappings, evaluations] = await Promise.all([
        this.pool.query<{
          market_id: MarketId;
          mode: DailySeedLegacy["markets"][number]["mode"];
        }>("SELECT market_id,mode FROM discovery_mode"),
        this.pool.query<{
          market_id: MarketId;
          first_run: Date | null;
          last_run: Date | null;
        }>(
          `SELECT market_id,min(started_at) AS first_run,max(started_at) AS last_run
           FROM discovery_run GROUP BY market_id`,
        ),
        this.pool.query<{ bytes: string | null }>(
          `SELECT sum(pg_total_relation_size(oid)) AS bytes FROM pg_class
           WHERE relkind='r' AND relname LIKE 'discovery%'`,
        ),
        this.pool.query<{ refreshed: Date | null }>(
          `SELECT max((decision->>'resolvedAt')::timestamptz) AS refreshed
           FROM discovery_symbol_mapping`,
        ),
        // A full count scans gigabytes; the planner estimate is enough here,
        // and decisions are counted once per cache period.
        this.pool.query<{ estimate: string; decisions: string }>(
          `SELECT
             greatest((SELECT reltuples FROM pg_class WHERE relname='discovery_evaluation'),0)::bigint AS estimate,
             (SELECT count(*) FROM discovery_evaluation
              WHERE result->>'state' IN ('PASS','FAIL')) AS decisions`,
        ),
      ]);
      const markets: MarketId[] = ["CA_TSX", "US_EQUITIES"];
      this.legacyCache = {
        at: now,
        value: {
          markets: markets.map((marketId) => {
            const run = runs.rows.find((row) => row.market_id === marketId);
            return {
              marketId,
              mode:
                modes.rows.find((row) => row.market_id === marketId)?.mode ??
                null,
              firstRunAt: run?.first_run?.toISOString() ?? null,
              lastRunAt: run?.last_run?.toISOString() ?? null,
            };
          }),
          evaluationsEstimate: Number(evaluations.rows[0]?.estimate ?? 0),
          decisions: Number(evaluations.rows[0]?.decisions ?? 0),
          retainedBytes: Number(size.rows[0]?.bytes ?? 0),
          mappingsRefreshedAt:
            mappings.rows[0]?.refreshed?.toISOString() ?? null,
        },
      };
    }
    const cached = this.legacyCache.value;
    return {
      ...cached,
      markets: cached.markets.map((market) => ({
        ...market,
        poolSize: poolSizes[market.marketId] ?? null,
      })),
    };
  }
}
