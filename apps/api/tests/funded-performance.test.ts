import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { FundedFactAdapter } from "../src/paper-bot/funded-fact-adapter.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { FundedLiveAdapter } from "../src/paper-bot/funded-live-adapter.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const databaseUrl = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
const LOCK_OPERATIONS = 8;
const QUOTE_CYCLES = 20;

let pool: Pool | undefined;
let reachable = false;

beforeAll(async () => {
  if (!databaseUrl) return;
  const candidate = new Pool({ connectionString: databaseUrl, max: 12 });
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let client: PoolClient | undefined;
      try {
        client = await Promise.race([
          candidate.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("connect timeout")), 3_000),
          ),
        ]);
        client.release();
        client = undefined;
        await migrate(candidate);
        pool = candidate;
        reachable = true;
        return;
      } catch (error) {
        client?.release();
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError ?? new Error("database connection retry budget exhausted");
  } catch (error) {
    if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true") throw error;
    console.warn(
      `[funded-performance] Skipping: no reachable PostgreSQL at ${databaseUrl} (${error instanceof Error ? error.message : String(error)})`,
    );
    await candidate.end().catch(() => {});
  }
}, 15_000);

afterAll(async () => {
  await pool?.end();
});

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

describe.skipIf(!databaseUrl)("funded persistence performance fixture", () => {
  it("measures account/run locks separately from growing event snapshots", async () => {
    if (!reachable || !pool) return;
    const databasePool = pool;
    const instrumentId = randomUUID();
    const accountId = randomUUID();
    const sessionDate = "2099-02-10";
    const sessionStartAt = "2099-02-10T14:30:00.000Z";
    const scheduledCloseAt = "2099-02-10T21:00:00.000Z";
    const assumptions: AssumptionsSnapshot = {
      positionSize: 1_000,
      slippageBps: 0,
      feePerTrade: 1,
      stopMethod: "STRUCTURAL",
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
      executionMode: "CAPACITY_CONSTRAINED",
    };
    const store = new PostgresPaperBotStore(databasePool);
    const ledger = new PostgresFundedLedgerStore(databasePool);
    await databasePool.query(
      `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active)
         VALUES($1,$2,$3,'Funded performance fixture','TSX','CAD','Stock',NULL,true,true,true)`,
      [
        instrumentId,
        2_000_000_000 + Math.floor(Math.random() * 100_000_000),
        `FUNDED_PERF_${instrumentId.slice(0, 8)}.TO`,
      ],
    );
    const run = await store.startOrResumeLiveRun({
      source: "LIVE",
      marketId: "CA_TSX",
      sessionDate,
      sessionTimezone: assumptions.sessionTimezone,
      scheduledCloseAt,
      executionModelVersion: "paper-execution-v7",
      assumptions,
    });
    const runId = run.id;
    const adapter = new FundedLiveAdapter({
      pool: databasePool,
      runId,
      accountId,
      currency: "CAD",
      marketId: "CA_TSX",
      assumptions,
    });
    try {
      await adapter.bind(sessionDate, sessionStartAt, 100_000, 10_000);

      const accountLockDurations: number[] = [];
      await Promise.all(
        Array.from({ length: LOCK_OPERATIONS }, (_, index) => {
          const started = performance.now();
          return ledger
            .apply(accountId, [
              {
                id: `funded-perf-mark-${index}`,
                at: new Date(Date.parse(sessionStartAt) + 1_000).toISOString(),
                currency: "CAD",
                type: "MARK",
                instrumentId,
                bid: 10 + index / 100,
              },
            ])
            .then(() => accountLockDurations.push(performance.now() - started));
        }),
      );

      const runLockDurations: number[] = [];
      await Promise.all(
        Array.from({ length: LOCK_OPERATIONS }, async () => {
          const started = performance.now();
          await new FundedFactAdapter(databasePool, runId).drain();
          runLockDurations.push(performance.now() - started);
        }),
      );

      const cycleDurations: number[] = [];
      for (let cycle = 0; cycle < QUOTE_CYCLES; cycle += 1) {
        const timestamp = new Date(
          Date.parse(sessionStartAt) + (cycle + 2) * 2_000,
        ).toISOString();
        const started = performance.now();
        await adapter.process({
          at: timestamp,
          sessionDate,
          scheduledCloseAt,
          observations: [],
          invalidations: [],
          quotes: [
            {
              instrumentId,
              timestamp,
              bid: 10 + cycle / 100,
              ask: 10.01 + cycle / 100,
              bidSize: 100,
              askSize: 100,
              sizeUnit: "SHARES",
              sizeMultiplier: 1,
              dataStatus: "REALTIME",
              actionable: true,
            },
          ],
        });
        cycleDurations.push(performance.now() - started);
      }

      const account = await databasePool.query<{
        eventCount: string;
        stateBytes: number;
      }>(
        `SELECT jsonb_array_length(state->'events') AS "eventCount",pg_column_size(state) AS "stateBytes"
           FROM paper_funded_account WHERE id=$1`,
        [accountId],
      );
      const events = await databasePool.query<{ count: string }>(
        "SELECT count(*) FROM paper_funded_event WHERE account_id=$1",
        [accountId],
      );
      const eventCount = Number(account.rows[0]?.eventCount ?? 0);
      const eventRows = Number(events.rows[0]?.count ?? 0);
      const stateBytesBeforeCompaction = Number(
        account.rows[0]?.stateBytes ?? 0,
      );
      const compaction = await ledger.compact(accountId, 8);
      const accountLockP95Ms = p95(accountLockDurations);
      const runLockP95Ms = p95(runLockDurations);
      const cycleP95Ms = p95(cycleDurations);
      console.log(
        JSON.stringify({
          benchmark: "funded-persistence-v1",
          lockOperations: LOCK_OPERATIONS,
          quoteCycles: QUOTE_CYCLES,
          accountLockP95Ms,
          runLockP95Ms,
          cycleP95Ms,
          eventRows,
          stateEventCount: eventCount,
          stateBytesBeforeCompaction,
          stateBytesAfterCompaction: compaction.stateBytes,
          retainedSnapshotEvents: compaction.retainedEventCount,
        }),
      );
      expect(eventRows).toBe(eventCount);
      expect(eventCount).toBeGreaterThanOrEqual(LOCK_OPERATIONS + QUOTE_CYCLES);
      expect(compaction.persistedEventCount).toBe(eventRows);
      expect(compaction.retainedEventCount).toBeLessThanOrEqual(8);
      expect(compaction.stateBytes).toBeGreaterThan(0);
      expect(accountLockP95Ms).toBeLessThan(5_000);
      expect(runLockP95Ms).toBeLessThan(5_000);
      expect(cycleP95Ms).toBeLessThan(5_000);
    } finally {
      // Processed facts are immutable; the fixture owns this disposable
      // database and disables the guard only for its own cleanup.
      await databasePool.query(
        "ALTER TABLE paper_funded_fact DISABLE TRIGGER paper_funded_fact_processed_guard",
      );
      try {
        await databasePool.query(
          "DELETE FROM paper_funded_fact WHERE run_id=$1",
          [runId],
        );
      } finally {
        await databasePool.query(
          "ALTER TABLE paper_funded_fact ENABLE TRIGGER paper_funded_fact_processed_guard",
        );
      }
      await databasePool.query("DELETE FROM paper_funded_run WHERE run_id=$1", [
        runId,
      ]);
      await databasePool.query(
        "DELETE FROM paper_funded_event WHERE account_id=$1",
        [accountId],
      );
      await databasePool.query("DELETE FROM paper_funded_account WHERE id=$1", [
        accountId,
      ]);
      await databasePool.query(
        "DELETE FROM paper_entry_liquidity WHERE run_id=$1",
        [runId],
      );
      await databasePool.query("DELETE FROM paper_bot_run WHERE id=$1", [
        runId,
      ]);
      await databasePool.query("DELETE FROM instrument WHERE id=$1", [
        instrumentId,
      ]);
    }
  }, 60_000);
});
