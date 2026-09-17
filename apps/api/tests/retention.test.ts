import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { PostgresRetentionService } from "../src/observability/retention-repository.js";

/**
 * W2: exercises `prune_retention_history()` and its required Timescale schedule
 * (database/init/028-retention-correction.sql and 029-schedule-retention.sql)
 * against a real PostgreSQL instance with genuine foreign-key relationships spanning
 * instrument -> feature_snapshot -> {strategy_evaluation, context_evaluation} and
 * instrument -> strategy_signal -> strategy_state_event -> scanner_alert.
 *
 * Local contributors may run this only when PostgreSQL is available. CI sets
 * REQUIRE_POSTGRES_INTEGRATION=true, turning an unavailable database into a failure rather than
 * a skipped acceptance test.
 */
const DATABASE_URL = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
// Symbol-id space reserved for this fixture so it never collides with the W7 fixture's
// 900_000_000+ range or any other seeded data.
const SYMBOL_ID_BASE = 910_000_000;
const SETUP_PROFILE_ID = "10000000-0000-4000-8000-000000000081"; // ORB Standard, seeded in 008-phase8a.sql
const MARKET_CONTEXT_PROFILE_ID = "10000000-0000-4000-8000-000000000084"; // seeded in 013-analysis-context.sql
const FEATURE_VERSION = "w2-retention-fixture-v1";
const CONFIG_VERSION = "w2-retention-fixture-config-v1";
const ADVISORY_LOCK_ID = 748203962; // must match prune_retention_history()'s pg_try_advisory_xact_lock argument

let pool: Pool | undefined;
let reachable = false;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  const candidate = new Pool({ connectionString: DATABASE_URL, max: 5 });
  try {
    const client = await Promise.race([
      candidate.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("connect timeout")), 3_000),
      ),
    ]);
    client.release();
    await migrate(candidate);
    pool = candidate;
    reachable = true;
  } catch (error) {
    if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true") throw error;
    console.warn(
      `[retention] Skipping: no reachable PostgreSQL at ${DATABASE_URL} (${
        error instanceof Error ? error.message : String(error)
      }). Start it with \`docker compose up -d postgres\` to run this fixture.`,
    );
    await candidate.end().catch(() => {});
  }
}, 15_000);

afterAll(async () => {
  if (pool) await pool.end();
});

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

interface Fixture {
  instrumentId: string;
  symbolId: number;
  // Unprotected, past every window -- must be deleted.
  quoteTimestamp: Date;
  candleStartTime: Date;
  staleFeatureSnapshotId: string; // referenced by evaluation/context below, all past their windows
  staleEvaluationId: string;
  staleContextId: string;
  staleSignalId: string; // no state_event/alert reference -- must be deleted
  // Protected despite being past every window: an alert-linked signal/state_event chain.
  protectedSignalId: string;
  protectedStateEventId: string;
  protectedAlertId: string;
}

async function seed(pool: Pool): Promise<Fixture> {
  const symbolId = SYMBOL_ID_BASE + Math.floor(Math.random() * 1_000_000);
  const symbol = `W2RET${symbolId}`;
  const instrumentResult = await pool.query<{ id: string }>(
    `INSERT INTO instrument
       (questrade_symbol_id, symbol, description, exchange, currency, security_type, is_quotable, is_tradable, active)
     VALUES ($1, $2, 'W2 retention fixture', 'TSX', 'CAD', 'Stock', true, true, true)
     RETURNING id`,
    [symbolId, symbol],
  );
  const instrumentId = instrumentResult.rows[0]!.id;

  const staleTimestamp = daysAgo(200); // past every window (180d quote/feature, 90d eval/signal/state_event, 30d context, 365d candle is the exception below)
  const staleCandleStart = daysAgo(400); // past the 365d candle window specifically

  const staleFeatureSnapshotId = randomUUID();
  await pool.query(
    `INSERT INTO feature_snapshot
       (id, instrument_id, timestamp, timeframe, price, change_from_open_pct, spread_pct, config_version, feature_version, snapshot_json)
     VALUES ($1, $2, $3, 'OneMinute', 10, 0.5, 0.02, $4, $5, '{}'::jsonb)`,
    [
      staleFeatureSnapshotId,
      instrumentId,
      staleTimestamp,
      CONFIG_VERSION,
      FEATURE_VERSION,
    ],
  );

  const staleEvaluationId = randomUUID();
  await pool.query(
    `INSERT INTO strategy_evaluation
       (id, profile_id, instrument_id, feature_snapshot_id, timestamp, strategy_key, strategy_version, config_version, previous_state, state, score, reason_codes)
     VALUES ($1, $2, $3, $4, $5, 'ORB_RETEST', '1.0.0', $6, 'WATCH', 'WATCH', 50, '[]'::jsonb)`,
    [
      staleEvaluationId,
      SETUP_PROFILE_ID,
      instrumentId,
      staleFeatureSnapshotId,
      staleTimestamp,
      CONFIG_VERSION,
    ],
  );

  const staleContextId = randomUUID();
  await pool.query(
    `INSERT INTO context_evaluation
       (id, profile_id, instrument_id, feature_snapshot_id, timestamp, signal_key, signal_version, config_version, status, context_score, lookback, reason_codes)
     VALUES ($1, $2, $3, $4, $5, 'MARKET_RELATIVE_STRENGTH', '1.0.0', $6, 'NEUTRAL', 50, 'SESSION_FROM_OPEN', '[]'::jsonb)`,
    [
      staleContextId,
      MARKET_CONTEXT_PROFILE_ID,
      instrumentId,
      staleFeatureSnapshotId,
      staleTimestamp,
      CONFIG_VERSION,
    ],
  );

  await pool.query(
    `INSERT INTO quote_snapshot
       (instrument_id, timestamp, bid, ask, bid_size, ask_size, last, last_size, day_volume, day_open, day_high, day_low, spread_absolute, spread_pct, is_delayed, is_halted, source)
     VALUES ($1, $2, 9.99, 10.01, 100, 100, 10, 100, 10000, 10, 10.5, 9.5, 0.02, 0.002, false, false, 'W2_RETENTION_FIXTURE')`,
    [instrumentId, staleTimestamp],
  );

  await pool.query(
    `INSERT INTO candle
       (instrument_id, timeframe, start_time, end_time, open, high, low, close, volume, source, is_complete)
     VALUES ($1, 'OneMinute', $2, $3, 10, 10.5, 9.5, 10.1, 5000, 'W2_RETENTION_FIXTURE', true)`,
    [
      instrumentId,
      staleCandleStart,
      new Date(staleCandleStart.getTime() + 60_000),
    ],
  );

  const staleSignalId = randomUUID();
  await pool.query(
    `INSERT INTO strategy_signal
       (id, instrument_id, strategy_name, strategy_version, config_version, timestamp, previous_state, state, score, feature_snapshot_json, reason_codes)
     VALUES ($1, $2, 'ORB_RETEST', '1.0.0', $3, $4, 'WATCH', 'WATCH', 50, '{}'::jsonb, '[]'::jsonb)`,
    [staleSignalId, instrumentId, CONFIG_VERSION, staleTimestamp],
  );

  // Protected chain: a signal + state_event as old as the unprotected one above (offset by one
  // second so the strategy_signal UNIQUE(instrument_id, strategy_name, strategy_version,
  // timestamp) constraint doesn't collide with staleSignalId on the same instrument/strategy),
  // but with a scanner_alert pointing at the state_event -- both must survive pruning regardless
  // of age.
  const protectedTimestamp = new Date(staleTimestamp.getTime() + 1000);
  const protectedSignalId = randomUUID();
  await pool.query(
    `INSERT INTO strategy_signal
       (id, instrument_id, strategy_name, strategy_version, config_version, timestamp, previous_state, state, score, feature_snapshot_json, reason_codes)
     VALUES ($1, $2, 'ORB_RETEST', '1.0.0', $3, $4, 'WATCH', 'READY', 80, '{}'::jsonb, '[]'::jsonb)`,
    [protectedSignalId, instrumentId, CONFIG_VERSION, protectedTimestamp],
  );
  const protectedStateEventId = randomUUID();
  await pool.query(
    `INSERT INTO strategy_state_event
       (id, signal_id, instrument_id, strategy_name, strategy_version, timestamp, previous_state, new_state, score, reason_codes, payload)
     VALUES ($1, $2, $3, 'ORB_RETEST', '1.0.0', $4, 'WATCH', 'READY', 80, '[]'::jsonb, '{}'::jsonb)`,
    [
      protectedStateEventId,
      protectedSignalId,
      instrumentId,
      protectedTimestamp,
    ],
  );
  const protectedAlertId = randomUUID();
  await pool.query(
    `INSERT INTO scanner_alert
       (id, source_event_id, instrument_id, alert_type, strategy_name, strategy_version, config_version, timestamp, previous_state, state, score, title, message, reason_codes, payload, deduplication_key)
     VALUES ($1, $2, $3, 'READY', 'ORB_RETEST', '1.0.0', $4, $5, 'WATCH', 'READY', 80, 'Protected alert', 'W2 retention protected alert', '[]'::jsonb, '{}'::jsonb, $6)`,
    [
      protectedAlertId,
      protectedStateEventId,
      instrumentId,
      CONFIG_VERSION,
      protectedTimestamp,
      `READY:${protectedAlertId}`,
    ],
  );

  return {
    instrumentId,
    symbolId,
    quoteTimestamp: staleTimestamp,
    candleStartTime: staleCandleStart,
    staleFeatureSnapshotId,
    staleEvaluationId,
    staleContextId,
    staleSignalId,
    protectedSignalId,
    protectedStateEventId,
    protectedAlertId,
  };
}

async function cleanup(pool: Pool, instrumentId: string): Promise<void> {
  await pool.query(`DELETE FROM scanner_alert WHERE instrument_id = $1`, [
    instrumentId,
  ]);
  await pool.query(
    `DELETE FROM strategy_state_event WHERE instrument_id = $1`,
    [instrumentId],
  );
  await pool.query(`DELETE FROM context_evaluation WHERE instrument_id = $1`, [
    instrumentId,
  ]);
  await pool.query(`DELETE FROM strategy_evaluation WHERE instrument_id = $1`, [
    instrumentId,
  ]);
  await pool.query(`DELETE FROM strategy_signal WHERE instrument_id = $1`, [
    instrumentId,
  ]);
  await pool.query(`DELETE FROM feature_snapshot WHERE instrument_id = $1`, [
    instrumentId,
  ]);
  await pool.query(`DELETE FROM candle WHERE instrument_id = $1`, [
    instrumentId,
  ]);
  await pool.query(`DELETE FROM quote_snapshot WHERE instrument_id = $1`, [
    instrumentId,
  ]);
  await pool.query(`DELETE FROM instrument WHERE id = $1`, [instrumentId]);
}

describe("W2 retention correction", () => {
  it("prunes rows past every window, protects alert-linked rows regardless of age, and is idempotent", async () => {
    if (!reachable || !pool) {
      console.warn("[retention] Skipped: no live PostgreSQL reachable.");
      return;
    }
    const fixture = await seed(pool);
    try {
      await pool.query("SELECT * FROM prune_retention_history()");

      const survivors = await pool.query<{
        feature: string;
        evaluation: string;
        context: string;
        quote: string;
        candle: string;
        stale_signal: string;
        protected_signal: string;
        protected_state_event: string;
        protected_alert: string;
      }>(
        `SELECT
           (SELECT count(*) FROM feature_snapshot WHERE id = $1) AS feature,
           (SELECT count(*) FROM strategy_evaluation WHERE id = $2) AS evaluation,
           (SELECT count(*) FROM context_evaluation WHERE id = $3) AS context,
           (SELECT count(*) FROM quote_snapshot WHERE instrument_id = $4) AS quote,
           (SELECT count(*) FROM candle WHERE instrument_id = $4) AS candle,
           (SELECT count(*) FROM strategy_signal WHERE id = $5) AS stale_signal,
           (SELECT count(*) FROM strategy_signal WHERE id = $6) AS protected_signal,
           (SELECT count(*) FROM strategy_state_event WHERE id = $7) AS protected_state_event,
           (SELECT count(*) FROM scanner_alert WHERE id = $8) AS protected_alert`,
        [
          fixture.staleFeatureSnapshotId,
          fixture.staleEvaluationId,
          fixture.staleContextId,
          fixture.instrumentId,
          fixture.staleSignalId,
          fixture.protectedSignalId,
          fixture.protectedStateEventId,
          fixture.protectedAlertId,
        ],
      );
      const row = survivors.rows[0]!;
      // Everything past its window and unreferenced is gone.
      expect(Number(row.feature)).toBe(0);
      expect(Number(row.evaluation)).toBe(0);
      expect(Number(row.context)).toBe(0);
      expect(Number(row.quote)).toBe(0);
      expect(Number(row.candle)).toBe(0);
      expect(Number(row.stale_signal)).toBe(0);
      // Alert-linked chain survives despite being just as old.
      expect(Number(row.protected_signal)).toBe(1);
      expect(Number(row.protected_state_event)).toBe(1);
      expect(Number(row.protected_alert)).toBe(1);

      // Idempotent: a second run deletes nothing further and raises no error.
      const secondRun = await pool.query<{
        pruned_table: string;
        rows_deleted: string;
        prune_error: string | null;
      }>("SELECT * FROM prune_retention_history()");
      for (const result of secondRun.rows) {
        expect(result.prune_error).toBeNull();
      }
      const stillProtected = await pool.query<{ count: string }>(
        `SELECT count(*) FROM scanner_alert WHERE id = $1`,
        [fixture.protectedAlertId],
      );
      expect(Number(stillProtected.rows[0]!.count)).toBe(1);
    } finally {
      await cleanup(pool, fixture.instrumentId);
    }
  }, 30_000);

  it("logs every run to retention_job_run, including a failed one, so status/errors are visible without a database console", async () => {
    if (!reachable || !pool) {
      console.warn("[retention] Skipped: no live PostgreSQL reachable.");
      return;
    }
    const service = new PostgresRetentionService(pool);
    const run = await service.runNow();
    expect(run.status === "SUCCEEDED" || run.status === "FAILED").toBe(true);
    expect(run.tableResults.length).toBeGreaterThan(0);
    for (const tableName of [
      "quote_snapshot",
      "candle",
      "feature_snapshot",
      "strategy_evaluation",
      "context_evaluation",
      "strategy_signal",
      "strategy_state_event",
    ]) {
      expect(
        run.tableResults.some((result) => result.table === tableName),
      ).toBe(true);
    }

    const latest = await service.getLatestRun();
    expect(latest?.id).toBe(run.id);
  }, 15_000);

  it("is concurrent-safe: a run already holding the advisory lock causes a second call to skip rather than interleave", async () => {
    if (!reachable || !pool) {
      console.warn("[retention] Skipped: no live PostgreSQL reachable.");
      return;
    }
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);

      const result = await pool.query<{
        pruned_table: string;
        rows_deleted: string;
        prune_error: string | null;
      }>("SELECT * FROM prune_retention_history()");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.pruned_table).toBe("SKIPPED_CONCURRENT");

      const latestRun = await pool.query<{ status: string }>(
        `SELECT status FROM retention_job_run ORDER BY started_at DESC LIMIT 1`,
      );
      expect(latestRun.rows[0]!.status).toBe("SKIPPED_CONCURRENT");
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
  }, 15_000);

  it("schedules the retention procedure exactly once and exposes it in the Timescale job inventory", async () => {
    if (!reachable || !pool) {
      console.warn("[retention] Skipped: no live PostgreSQL reachable.");
      return;
    }
    const inventory = await pool.query<{ job_id: number; proc_name: string }>(
      `SELECT job_id, proc_name
       FROM timescaledb_information.jobs
       WHERE proc_name = 'run_scheduled_retention'`,
    );
    expect(inventory.rows).toHaveLength(1);
    expect(inventory.rows[0]?.proc_name).toBe("run_scheduled_retention");
  }, 15_000);
});
