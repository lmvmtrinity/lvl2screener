import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import {
  fundedAccountSummary,
  FundedRiskVeto,
} from "../src/paper-bot/funded-ledger.js";
import {
  fundedPolicy,
  type FundedPolicy,
} from "../src/paper-bot/funded-policy.js";
import { FundedLiveAdapter } from "../src/paper-bot/funded-live-adapter.js";
import {
  PostgresPaperBotStore,
  type PaperSignalObservation,
} from "../src/paper-bot/paper-bot-repository.js";
import type {
  AssumptionsSnapshot,
  SizingContext,
} from "../src/paper-bot/types.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
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
  executionMode: "CAPACITY_CONSTRAINED",
};
const date = "2099-04-01";
const at = `${date}T14:30:00.000Z`;
const quote = (timestamp: string, bid = 10, ask = bid) => ({
  timestamp,
  bid,
  ask,
  bidSize: 10000,
  askSize: 10000,
  dataStatus: "REALTIME" as const,
  actionable: true,
});

describe.skipIf(!databaseUrl)(
  "funded gap regressions against isolated PostgreSQL",
  () => {
    let pool: Pool;
    let instrumentId: string;
    let store: PostgresPaperBotStore;
    let ledger: PostgresFundedLedgerStore;
    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 6 });
      await migrate(pool);
      instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,security_type,industry_sector,is_quotable,is_tradable,active) VALUES($1,$2,$3,'Gap regression','TSX','CAD','Stock','Technology',true,true,true)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1000000000) + 1000000000,
          `GAP_${instrumentId.slice(0, 8)}.TO`,
        ],
      );
      store = new PostgresPaperBotStore(pool);
      ledger = new PostgresFundedLedgerStore(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });

    async function setup(
      policy = fundedPolicy(),
      sessionDate = date,
      accountId = randomUUID(),
    ) {
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate,
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: `${sessionDate}T21:00:00.000Z`,
        executionModelVersion: "paper-execution-v7",
        assumptions,
      });
      await ledger.ensure(accountId, [
        "CAD",
        50000,
        sessionDate,
        `${sessionDate}T14:30:00.000Z`,
        3000,
      ]);
      const service = new FundedOrderService(pool, run.id, accountId, "CAD");
      await service.bind(policy, {
        session: sessionDate,
        at: `${sessionDate}T14:30:00.000Z`,
      });
      return { run, accountId, service, policy };
    }
    async function submit(
      service: FundedOrderService,
      timestamp = at,
      size = 1000,
      context?: SizingContext,
    ) {
      const orderId = randomUUID();
      const input = {
        orderId,
        assumptions: {
          ...assumptions,
          positionSize: size,
          riskBudget: size / 10,
        },
        signal: {
          entryReference: 10,
          stopReference: 9,
          targetReference: 30,
          atr14: 1,
          signalTimestamp: timestamp,
        },
        submittedAt: timestamp,
        expiresAt: new Date(Date.parse(timestamp) + 120000).toISOString(),
        ...(context ? { context } : {}),
      };
      await service.submit(instrumentId, input, size, size / 10);
      return input;
    }

    it("executes custom and legacy policy quotes without adding legacy controls", async () => {
      const { portfolio: _portfolio, ...legacy } = fundedPolicy();
      for (const policy of [
        fundedPolicy(1, 0, { maxOpenPositions: 2 }),
        legacy,
      ]) {
        const value = await setup(policy);
        await submit(value.service);
        await value.service.quote(instrumentId, quote(at), 1, 0);
        expect(
          Object.keys((await ledger.read(value.accountId)).positions),
        ).toHaveLength(1);
        const saved = await pool.query<{ policy: FundedPolicy }>(
          "SELECT policy FROM paper_funded_run WHERE run_id=$1",
          [value.run.id],
        );
        expect(saved.rows[0]!.policy).toEqual(policy);
        await expect(
          value.service.quote(instrumentId, quote(at), 0.5, 0),
        ).rejects.toThrow("immutable funded policy");
      }
    });

    it("retries expired live signals across restart without conflicting facts", async () => {
      const value = await setup();
      const options = {
        pool,
        runId: value.run.id,
        accountId: value.accountId,
        currency: "CAD" as const,
        marketId: "CA_TSX" as const,
        assumptions: { ...assumptions, riskBudget: 100 },
        policy: value.policy,
      };
      const observation = {
        id: randomUUID(),
        instrumentId,
        marketId: "CA_TSX",
        signalTimestamp: at,
        entryReference: 10,
        stopReference: 9,
        targetReference: 30,
        atr14: 1,
        strategyKey: "ORB_RETEST",
        profileParameters: { setupTimeoutMinutes: 20 },
      } as PaperSignalObservation;
      const input = {
        at,
        sessionDate: date,
        scheduledCloseAt: value.run.scheduledCloseAt,
        observations: [observation],
        invalidations: [],
        quotes: [],
      };
      await new FundedLiveAdapter(options).process(input);
      for (const time of ["14:51", "14:52", "14:53"])
        await new FundedLiveAdapter(options).process({
          ...input,
          at: `${date}T${time}:00.000Z`,
        });
      const order = await pool.query(
        "SELECT state FROM paper_entry_order WHERE order_id=$1",
        [observation.id],
      );
      expect(order.rows[0].state.status).toBe("CANCELLED");
      expect((await ledger.read(value.accountId)).reservations).toEqual({});
      const cancellations = await pool.query<{
        fact_id: string;
        fact: { at: string };
      }>(
        `SELECT fact_id,fact FROM paper_funded_fact
         WHERE run_id=$1 AND fact->>'type'='CANCEL' AND fact->>'orderId'=$2
         ORDER BY fact_at`,
        [value.run.id, observation.id],
      );
      expect(cancellations.rows).toHaveLength(1);
      expect(cancellations.rows[0]).toMatchObject({
        fact_id: `funded-invalidation:stale-signal:${observation.id}`,
        fact: { at: `${date}T14:50:00.000Z` },
      });
    });

    it("serializes concurrent reservations at the configured position cap", async () => {
      const value = await setup(fundedPolicy(1, 0, { maxOpenPositions: 2 }));
      const results = await Promise.allSettled([
        submit(value.service),
        submit(value.service),
        submit(value.service),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      const rejected = results.filter(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as FundedRiskVeto).code).toBe(
        "MAX_OPEN_POSITIONS",
      );
      expect(
        Object.keys((await ledger.read(value.accountId)).reservations),
      ).toHaveLength(2);
    });

    it("vetoes a fill when marks have consumed portfolio risk and preserves retries", async () => {
      const value = await setup();
      const first = await submit(value.service);
      await value.service.quote(instrumentId, quote(at), 1, 0);
      await value.service.submit(instrumentId, first, 1000, 100);
      const second = await submit(value.service, `${date}T14:30:01.000Z`, 9000);
      const moved = quote(`${date}T14:30:02.000Z`, 15);
      await value.service.quote(instrumentId, moved, 1, 0);
      await value.service.quote(instrumentId, moved, 1, 0);
      const state = await ledger.read(value.accountId);
      expect(Object.keys(state.positions)).toHaveLength(1);
      expect(fundedAccountSummary(state, moved.timestamp, 30000).openRisk).toBe(
        600,
      );
      const cancelled = await pool.query(
        "SELECT state FROM paper_entry_order WHERE order_id=$1",
        [second.orderId],
      );
      expect(cancelled.rows[0].state.reason).toBe("RISK_VETO");
    });

    it("checks captured context again at fill time", async () => {
      const value = await setup(
        fundedPolicy(1, 0, {
          requireFreshContext: true,
          contextMaxAgeSeconds: 1,
        }),
      );
      await submit(value.service, at, 1000, {
        contexts: [
          {
            signalKey: "MARKET_RELATIVE_STRENGTH",
            status: "STRONG",
            timestamp: at,
          },
        ],
      });
      await value.service.quote(
        instrumentId,
        quote(`${date}T14:30:02.000Z`),
        1,
        0,
      );
      expect((await ledger.read(value.accountId)).positions).toEqual({});
      expect((await ledger.read(value.accountId)).reservations).toEqual({});
    });

    it("enforces symbol and sector caps without partial reservations", async () => {
      for (const limits of [
        { maxSymbolNotional: 1500 },
        { maxSectorNotional: 1500 },
      ]) {
        const value = await setup(fundedPolicy(1, 0, limits));
        await submit(value.service);
        await expect(submit(value.service)).rejects.toThrow("exposure veto");
        expect(
          Object.keys((await ledger.read(value.accountId)).reservations),
        ).toHaveLength(1);
      }
    });

    it("requires separate market and sector context and vetoes weak context", async () => {
      const value = await setup(
        fundedPolicy(1, 0, {
          requireFreshContext: true,
          contextRequirement: "MARKET_AND_SECTOR_REQUIRED",
          vetoOnWeakContext: true,
        }),
      );
      const market = {
        signalKey: "MARKET_RELATIVE_STRENGTH",
        status: "STRONG" as const,
        timestamp: at,
      };
      await expect(
        submit(value.service, at, 1000, { contexts: [market] }),
      ).rejects.toThrow("context unavailable");
      await expect(
        submit(value.service, at, 1000, {
          contexts: [
            market,
            {
              signalKey: "SECTOR_RELATIVE_STRENGTH",
              status: "WEAK",
              timestamp: at,
            },
          ],
        }),
      ).rejects.toThrow("weak-context");
      await expect(
        submit(value.service, at, 1000, {
          contexts: [
            market,
            {
              signalKey: "SECTOR_RELATIVE_STRENGTH",
              status: "STRONG",
              timestamp: at,
            },
          ],
        }),
      ).resolves.toBeDefined();
    });

    it("captures retained decision-time context and excludes later improvements", async () => {
      const value = await setup(
        fundedPolicy(1, 0, {
          requireFreshContext: true,
          vetoOnWeakContext: true,
        }),
      );
      // The context capture path reads a MARKET_RELATIVE_STRENGTH profile; a
      // fresh isolated database does not inherit the live scanner's catalog, so
      // the fixture creates that minimal profile when it is absent.
      let profile = await pool.query<{ id: string }>(
        "SELECT p.id FROM scanner_profile p JOIN strategy_definition d ON d.id=p.strategy_definition_id WHERE p.market_id='CA_TSX' AND d.strategy_key='MARKET_RELATIVE_STRENGTH' LIMIT 1",
      );
      if (!profile.rows[0]) {
        const definitionId = randomUUID();
        await pool.query(
          "INSERT INTO strategy_definition(id,strategy_key,version,name,description,analysis_kind) VALUES($1,'MARKET_RELATIVE_STRENGTH','1.0.0','Market relative strength','gap fixture','CONTEXT')",
          [definitionId],
        );
        await pool.query(
          "INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order,market_id) VALUES($1,'gap-market-context', $2,false,0,'CA_TSX')",
          [randomUUID(), definitionId],
        );
        profile = await pool.query<{ id: string }>(
          "SELECT p.id FROM scanner_profile p JOIN strategy_definition d ON d.id=p.strategy_definition_id WHERE p.market_id='CA_TSX' AND d.strategy_key='MARKET_RELATIVE_STRENGTH' LIMIT 1",
        );
      }
      for (const [timestamp, status] of [
        [at, "WEAK"],
        [`${date}T14:30:01.000Z`, "STRONG"],
      ]) {
        const featureId = randomUUID();
        await pool.query(
          "INSERT INTO feature_snapshot(id,instrument_id,timestamp,timeframe,price,change_from_open_pct,spread_pct,config_version,feature_version,snapshot_json) VALUES($1,$2,$3,'FiveMinutes',10,0,0,'gap-test',$4,'{}')",
          [featureId, instrumentId, timestamp, featureId],
        );
        await pool.query(
          "INSERT INTO context_evaluation(profile_id,instrument_id,feature_snapshot_id,timestamp,signal_key,signal_version,config_version,status,context_score,benchmark_timestamp,lookback,reason_codes) VALUES($1,$2,$3,$4,'MARKET_RELATIVE_STRENGTH','1.0.0','gap-test',$5,50,$4,'SESSION_FROM_OPEN','[]')",
          [profile.rows[0]!.id, instrumentId, featureId, timestamp, status],
        );
      }
      const observation = {
        id: randomUUID(),
        instrumentId,
        marketId: "CA_TSX",
        signalTimestamp: at,
        entryReference: 10,
        stopReference: 9,
        targetReference: 30,
        atr14: 1,
        strategyKey: "ORB_RETEST",
        profileParameters: { setupTimeoutMinutes: 20 },
      } as PaperSignalObservation;
      await new FundedLiveAdapter({
        pool,
        runId: value.run.id,
        accountId: value.accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions: { ...assumptions, riskBudget: 100 },
        policy: value.policy,
      }).process({
        at,
        sessionDate: date,
        scheduledCloseAt: value.run.scheduledCloseAt,
        observations: [observation],
        invalidations: [],
        quotes: [],
      });
      const fact = await pool.query(
        "SELECT fact,outcome FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
        [value.run.id, `funded-signal:${observation.id}`],
      );
      expect(fact.rows[0].fact.order.context.contexts).toEqual([
        {
          signalKey: "MARKET_RELATIVE_STRENGTH",
          status: "WEAK",
          timestamp: at,
        },
      ]);
      expect(fact.rows[0].outcome.status).toBe("RISK_VETO");
      expect(fact.rows[0].outcome.vetoes?.[0]?.code).toBe("WEAK_CONTEXT");
    });

    it("drains already-enqueued facts as a bounded catch-up pass", async () => {
      const value = await setup();
      const adapter = new FundedLiveAdapter({
        pool,
        runId: value.run.id,
        accountId: value.accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions: { ...assumptions, riskBudget: 100 },
        policy: value.policy,
      });
      const observation = {
        id: randomUUID(),
        instrumentId,
        marketId: "CA_TSX",
        signalTimestamp: at,
        entryReference: 10,
        stopReference: 9,
        targetReference: 30,
        atr14: 1,
        strategyKey: "ORB_RETEST",
        profileParameters: { setupTimeoutMinutes: 20 },
      } as PaperSignalObservation;
      const input = {
        at,
        sessionDate: date,
        scheduledCloseAt: value.run.scheduledCloseAt,
        observations: [observation],
        invalidations: [],
        quotes: [],
      };
      // Enqueue the cycle's facts but acknowledge only one, so the bounded
      // catch-up has durable work left.
      await adapter.process(input, { maxFacts: 1, maxDurationMs: 1 });
      const before = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM paper_funded_fact WHERE run_id=$1 AND outcome IS NULL",
        [value.run.id],
      );
      expect(before.rows[0]!.count).toBeGreaterThan(0);
      const processed = await adapter.drainEnqueued({
        maxFacts: 100,
        maxDurationMs: 1000,
      });
      expect(processed).toBeGreaterThan(0);
      const after = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM paper_funded_fact WHERE run_id=$1 AND outcome IS NULL",
        [value.run.id],
      );
      expect(after.rows[0]!.count).toBeLessThan(before.rows[0]!.count);
    });

    it("enforces the bound holding policy even when a caller omits holding context", async () => {
      const value = await setup(
        fundedPolicy(1, 0, { maximumHoldingMinutes: 1 }),
      );
      await submit(value.service);
      await value.service.quote(instrumentId, quote(at), 1, 0);
      await value.service.quote(
        instrumentId,
        quote(`${date}T14:31:00.000Z`),
        1,
        0,
      );
      expect((await ledger.read(value.accountId)).positions).toEqual({});
      const order = await pool.query(
        "SELECT state FROM paper_entry_order WHERE run_id=$1",
        [value.run.id],
      );
      expect(
        order.rows[0].state.execution.position.exitFills[0].exitReason,
      ).toBe("TIME_STOP");
    });

    it("resets the stop streak at session rollover", async () => {
      const value = await setup();
      for (const time of ["14:30", "14:46", "15:02"]) {
        const timestamp = `${date}T${time}:00.000Z`;
        await submit(value.service, timestamp);
        await value.service.quote(instrumentId, quote(timestamp), 1, 0);
        await value.service.quote(
          instrumentId,
          quote(`${date}T${time}:01.000Z`, 9),
          1,
          0,
        );
      }
      await expect(
        submit(value.service, `${date}T15:20:00.000Z`),
      ).rejects.toThrow("consecutive-stop");
      await value.service.advanceClock(value.run.scheduledCloseAt);
      await store.completeRun(value.run.id);
      const next = await setup(value.policy, "2099-04-02", value.accountId);
      await expect(
        submit(next.service, "2099-04-02T14:30:00.000Z"),
      ).resolves.toBeDefined();
    });
  },
);
