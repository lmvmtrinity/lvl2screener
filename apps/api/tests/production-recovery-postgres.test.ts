import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { FundedLiveAdapter } from "../src/paper-bot/funded-live-adapter.js";
import { FundedFactAdapter } from "../src/paper-bot/funded-fact-adapter.js";
import {
  PostgresFundedLedgerStore,
  FUNDED_SNAPSHOT_EVENT_LIMIT,
} from "../src/paper-bot/funded-ledger-repository.js";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!url)(
  "production recovery regression on isolated PostgreSQL",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({ connectionString: url, max: 8 });
      await migrate(pool);
    }, 30000);
    afterAll(async () => {
      await pool?.end();
    });
    const assumptions: AssumptionsSnapshot = {
      positionSize: 1000,
      slippageBps: 0,
      feePerTrade: 0,
      stopMethod: "STRUCTURAL",
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
      evidenceScope: "FORWARD_LIVE",
    };

    it("yields a large inbox between acknowledged facts, resumes after restart, and bounds only duplicate ledger history", async () => {
      const repository = new PostgresMarketDataRepository(pool);
      const [instrument] = await repository.upsertInstruments([
        {
          symbolId: 2100000000 + Math.floor(Math.random() * 10000000),
          symbol: `HEALTH_${randomUUID().slice(0, 8)}.TO`,
          description: "test",
          securityType: "Stock",
          exchange: "TSX",
          currency: "CAD",
          isQuotable: true,
          isTradable: true,
        },
      ]);
      const run = await new PostgresPaperBotStore(pool).startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-03-03",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-03-03T21:00:00Z",
        executionModelVersion: "paper-execution-v7",
        assumptions,
      });
      const accountId = randomUUID();
      const options = {
        pool,
        runId: run.id,
        accountId,
        currency: "CAD" as const,
        marketId: "CA_TSX" as const,
        assumptions,
      };
      const live = new FundedLiveAdapter(options);
      await live.bind("2099-03-03", "2099-03-03T14:30:00Z", 10000, 1000);
      const start = Date.parse("2099-03-03T14:30:00Z");
      const quotes = Array.from({ length: 1000 }, (_, i) => ({
        instrumentId: instrument!.id,
        timestamp: new Date(start + (i + 1) * 1000).toISOString(),
        bid: 10,
        ask: 10.01,
        bidSize: 1000,
        askSize: 1000,
        sizeUnit: "SHARES" as const,
        sizeMultiplier: 1,
        dataStatus: "REALTIME" as const,
        actionable: true,
      }));
      const input = {
        at: new Date(start + 1001000).toISOString(),
        sessionDate: run.sessionDate,
        scheduledCloseAt: run.scheduledCloseAt,
        observations: [],
        invalidations: [],
        quotes,
      };
      const first = await live.process(input, {
        maxFacts: 25,
        maxDurationMs: 10000,
      });
      expect(first.processed).toBe(25);
      const snapshot = await live.operationalSnapshot(input.at);
      expect(snapshot.pendingFacts).toBe(976);
      expect(
        await new PostgresPaperBotStore(pool).settleRunAfterCloseRequest(
          run.id,
        ),
      ).toBe("CLOSE_PENDING");
      const barrier = await pool.query(
        "SELECT inflight_fact_id,clock_at FROM paper_funded_run WHERE run_id=$1",
        [run.id],
      );
      expect(barrier.rows[0].inflight_fact_id).toBeNull();
      expect(new Date(barrier.rows[0].clock_at).getTime()).toBeLessThan(
        Date.parse(input.at),
      );
      // A restarted collector uses the atomically enqueued clock as its watermark.
      // The not-yet-executed facts remain in the inbox and are not fetched again.
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,spread_absolute,spread_pct,is_delayed,is_halted,source)
      VALUES($1,$2,10,10.01,1000,1000,10,100,10000,10,11,9,0.01,0.1,false,false,'QUESTRADE')`,
        [instrument!.id, quotes[0]!.timestamp],
      );
      expect(
        await new FundedLiveAdapter(options).retainedQuotes(
          [instrument!.id],
          input.at,
        ),
      ).toEqual([]);
      const inbox = new FundedFactAdapter(pool, run.id);
      let drained = first.processed;
      const started = performance.now();
      for (;;) {
        const count = await inbox.drain({ maxFacts: 100, maxDurationMs: 250 });
        if (!count) break;
        expect(count).toBeLessThanOrEqual(100);
        drained += count;
      }
      expect(drained).toBe(1001);
      expect((await live.operationalSnapshot(input.at)).pendingFacts).toBe(0);
      const ledger = new PostgresFundedLedgerStore(pool);
      const state = await ledger.read(accountId);
      expect(state.events.length).toBeLessThanOrEqual(
        FUNDED_SNAPSHOT_EVENT_LIMIT,
      );
      const events = await pool.query(
        `SELECT event,fact_run_id,fact_id
           FROM paper_funded_event WHERE account_id=$1 ORDER BY event_sequence`,
        [accountId],
      );
      expect(events.rows.length).toBeGreaterThanOrEqual(1000);
      const oldest = events.rows[0]!;
      const oldEvent = oldest.event;
      const cause =
        oldest.fact_run_id === null
          ? {}
          : {
              causeRunId: oldest.fact_run_id,
              causeFactId: oldest.fact_id,
            };
      const retried = await ledger.apply(accountId, [oldEvent], cause);
      expect(retried).toEqual(state);
      await expect(
        ledger.apply(accountId, [{ ...oldEvent, bid: 42 }], cause),
      ).rejects.toThrow("Conflicting ledger event retry");
      console.info(
        JSON.stringify({
          fixture: "1000-quote-funded-catchup",
          drainMs: Math.round(performance.now() - started),
          snapshotEvents: state.events.length,
          persistedEvents: events.rows.length,
        }),
      );
    }, 90000);

    it("collects inactive live funded positions only in their own market and drops cancelled orders", async () => {
      const repository = new PostgresMarketDataRepository(pool);
      const [instrument] = await repository.upsertInstruments([
        {
          symbolId: 2200000000 + Math.floor(Math.random() * 10000000),
          symbol: `RECOVERY_${randomUUID().slice(0, 8)}.TO`,
          description: "test",
          securityType: "Stock",
          exchange: "TSX",
          currency: "CAD",
          isQuotable: true,
          isTradable: true,
        },
      ]);
      const run = await new PostgresPaperBotStore(pool).startOrResumeLiveRun({
        source: "LIVE",
        marketId: "CA_TSX",
        sessionDate: "2099-03-04",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-03-04T21:00:00Z",
        executionModelVersion: "paper-execution-v7",
        assumptions,
      });
      const adapter = new FundedLiveAdapter({
        pool,
        runId: run.id,
        accountId: randomUUID(),
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions,
      });
      await adapter.bind(run.sessionDate, "2099-03-04T14:30:00Z", 10000, 1000);
      const orderId = randomUUID();
      const { FundedOrderService } =
        await import("../src/paper-bot/funded-order-service.js");
      const binding = (
        await pool.query(
          "SELECT account_id FROM paper_funded_run WHERE run_id=$1",
          [run.id],
        )
      ).rows[0];
      const orders = new FundedOrderService(
        pool,
        run.id,
        binding.account_id,
        "CAD",
      );
      await orders.submit(
        instrument!.id,
        {
          orderId,
          submittedAt: "2099-03-04T14:30:01Z",
          expiresAt: "2099-03-04T14:40:00Z",
          signal: {
            signalTimestamp: "2099-03-04T14:30:01Z",
            entryReference: 10,
            stopReference: 9,
            targetReference: 12,
            atr14: 1,
          },
          assumptions,
        },
        1000,
        100,
      );
      await pool.query("UPDATE instrument SET active=false WHERE id=$1", [
        instrument!.id,
      ]);
      expect(
        (await repository.listRecoveryInstruments("CA_TSX")).some(
          (i) => i.id === instrument!.id,
        ),
      ).toBe(true);
      expect(
        (await repository.listRecoveryInstruments("US_EQUITIES")).some(
          (i) => i.id === instrument!.id,
        ),
      ).toBe(false);
      await orders.cancel(orderId, "2099-03-04T14:31:00Z", "USER_CANCELLED");
      expect(
        (await repository.listRecoveryInstruments("CA_TSX")).some(
          (i) => i.id === instrument!.id,
        ),
      ).toBe(false);
    });
  },
);
