import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { FundedLiveAdapter } from "../src/paper-bot/funded-live-adapter.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";
import { PostgresPaperCoordinationStore } from "../src/paper-bot/paper-coordination-repository.js";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!url)("funded lookup capacity on isolated PostgreSQL", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
  }, 30000);
  afterAll(async () => {
    await pool?.end();
  }, 60_000);

  it("counts only each market's latest quote size, including inactive instruments", async () => {
    const repository = new PostgresMarketDataRepository(pool);
    const store = new PostgresPaperCoordinationStore(pool);
    const beforeCa = (await store.portfolioHealth("CA_TSX"))
      .unknownQuoteSizeUnits;
    const beforeUs = (await store.portfolioHealth("US_EQUITIES"))
      .unknownQuoteSizeUnits;
    for (const [market, currency, exchange, expected] of [
      ["CA_TSX", "CAD", "TSX", 1],
      ["US_EQUITIES", "USD", "NASDAQ", 2],
    ] as const) {
      for (let number = 0; number < 3; number += 1) {
        const [instrument] = await repository.upsertInstruments(
          [
            {
              symbolId: 2100000000 + Math.floor(Math.random() * 10000000),
              symbol: `SIZE_${randomUUID().slice(0, 8)}${currency === "CAD" ? ".TO" : ""}`,
              description: "size health regression",
              securityType: "Stock",
              exchange,
              currency,
              isQuotable: true,
              isTradable: true,
            },
          ],
          market,
        );
        // The third instrument has no quotes. Older UNKNOWN values must not count
        // after a known size; the US second instrument changes the other way.
        if (number < 2)
          await pool.query(
            `INSERT INTO quote_snapshot
          (instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,
            day_open,day_high,day_low,spread_absolute,spread_pct,is_delayed,is_halted,source,size_unit)
          SELECT $1,'2099-04-02T14:00:00Z'::timestamptz+n*interval '1 second',
            10,10.01,100,100,10,100,1000,10,11,9,0.01,0.1,false,false,'MOCK',
            CASE WHEN (n=1 AND $2::boolean) OR (n=0 AND NOT $2::boolean)
              THEN 'UNKNOWN' ELSE 'SHARES' END
          FROM generate_series(0,1) n`,
            [instrument!.id, number < expected],
          );
        await pool.query("UPDATE instrument SET active=false WHERE id=$1", [
          instrument!.id,
        ]);
      }
      expect((await store.portfolioHealth(market)).unknownQuoteSizeUnits).toBe(
        (market === "CA_TSX" ? beforeCa : beforeUs) + expected,
      );
    }
    expect((await store.portfolioHealth("CA_TSX")).unknownQuoteSizeUnits).toBe(
      beforeCa + 1,
    );
  });

  it("keeps missing-fact lookups bounded as acknowledged history grows", async () => {
    const assumptions = {
      positionSize: 1000,
      slippageBps: 0,
      feePerTrade: 0,
      stopMethod: "STRUCTURAL" as const,
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
    };
    const run = await new PostgresPaperBotStore(pool).startBacktestRun({
      source: "BACKTEST",
      marketId: "CA_TSX",
      sessionDate: "2099-04-01",
      sessionTimezone: assumptions.sessionTimezone,
      scheduledCloseAt: "2099-04-01T20:00:00Z",
      executionModelVersion: "paper-execution-v7",
      assumptions,
    });
    await new FundedLiveAdapter({
      pool,
      runId: run.id,
      accountId: randomUUID(),
      currency: "CAD",
      marketId: "CA_TSX",
      assumptions,
    }).bind(run.sessionDate, "2099-04-01T13:30:00Z", 10000, 1000);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Synthetic inbox history only, in a transaction rolled back after measurement.
      await client.query(
        `INSERT INTO paper_funded_fact
        (run_id,fact_id,fact_at,priority,sort_key,fact,outcome,processed_at)
        SELECT $1,'lookup-history:'||n,
          '2099-04-01T13:30:00Z'::timestamptz+n*interval '1 millisecond',
          3,'',jsonb_build_object('type','CLOCK','at',
            '2099-04-01T13:30:00Z'::timestamptz+n*interval '1 millisecond'),
          '{"status":"APPLIED"}'::jsonb,now()
        FROM generate_series(1,90000) n`,
        [run.id],
      );
      await client.query("ANALYZE paper_funded_fact");
      const queries = {
        signal: `SELECT fact,outcome FROM paper_funded_fact WHERE run_id=$1
          AND (fact_id='funded-signal:missing' OR (fact->>'type'='CANCEL'
            AND fact->>'orderId'='missing' AND fact->'preSubmissionEventId' IS NOT NULL))
          ORDER BY CASE WHEN fact_id='funded-signal:missing' THEN 0 ELSE 1 END LIMIT 1`,
        chronology: `SELECT 1 FROM paper_funded_fact WHERE run_id=$1
          AND outcome IS NOT NULL AND fact_at >= '2099-04-01T14:00:00Z' LIMIT 1`,
        watermark: `SELECT max(fact_at) FROM paper_funded_fact WHERE run_id=$1
          AND fact->>'type'='CLOCK' AND fact_id LIKE 'funded-clock:%'`,
      };
      type Plan = {
        Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
        "Execution Time": number;
      };
      const measure = async (sql: string): Promise<Plan> => {
        const result = await client.query(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
          [run.id],
        );
        return result.rows[0]["QUERY PLAN"][0] as Plan;
      };
      const indexed = new Map<string, Plan>();
      for (const [name, sql] of Object.entries(queries))
        indexed.set(name, await measure(sql));
      await client.query("SAVEPOINT without_indexes");
      await client.query(`DROP INDEX paper_funded_fact_processed_time,
        paper_funded_fact_pre_submission_order,paper_funded_fact_collection_clock`);
      // Later migrations added equivalent (run_id, fact_at DESC) indexes that can still
      // serve these lookups after the original three are dropped, and planner estimates
      // vary across environments. Disable index access paths for the baseline so the
      // comparison measures the indexes rather than planner choice.
      await client.query(
        "SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL enable_indexonlyscan=off",
      );
      for (const [name, sql] of Object.entries(queries)) {
        const baseline = await measure(sql);
        const improved = indexed.get(name)!;
        const blocks = (plan: Plan) =>
          plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"];
        expect(blocks(improved)).toBeLessThan(blocks(baseline) / 20);
        console.info(
          JSON.stringify({
            lookup: name,
            historyRows: 90000,
            beforeMs: baseline["Execution Time"],
            afterMs: improved["Execution Time"],
            beforeBlocks: blocks(baseline),
            afterBlocks: blocks(improved),
          }),
        );
      }
      await client.query("ROLLBACK TO SAVEPOINT without_indexes");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 120_000);
});
