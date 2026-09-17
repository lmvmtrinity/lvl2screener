import { resolveSessionClose } from "../src/paper-bot/quote-execution.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import type { LedgerEvent } from "../src/paper-bot/funded-ledger.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { FundedReportingService } from "../src/paper-bot/funded-reporting-service.js";
import { FundedFactAdapter } from "../src/paper-bot/funded-fact-adapter.js";
import { QuestradeDataService } from "../src/market-data/service.js";
import {
  buildFundedSignalEnvelope,
  FundedLiveAdapter,
} from "../src/paper-bot/funded-live-adapter.js";
import {
  replayFundedFacts,
  replayFundedHistoricalSession,
} from "../src/paper-bot/funded-replay-service.js";
import { PostgresPaperEvidenceStore } from "../src/paper-bot/paper-reporting-repository.js";
import { PostgresPendingOrderStore } from "../src/paper-bot/pending-order-repository.js";
import { applyEntryOrderQuote } from "../src/paper-bot/pending-order.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { EvidenceCohortService } from "../src/paper-bot/evidence-cohort-service.js";
import { EvidenceRegenerationService } from "../src/paper-bot/evidence-regeneration-service.js";
import type { StrategyStateEvent } from "@tsx-scanner/contracts";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { PostgresPaperExecutionStore } from "../src/paper-bot/paper-execution-repository.js";
import {
  PostgresPaperCoordinationStore,
  type RecordCoordinationDecisionInput,
} from "../src/paper-bot/paper-coordination-repository.js";
import {
  applyQuoteFact,
  createQuoteExecution,
} from "../src/paper-bot/execution-core.js";
import { COORDINATION_POLICY_VERSION } from "../src/paper-bot/coordination-policy.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../src/backtests/execution-provenance.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const assumptions: AssumptionsSnapshot = {
  positionSize: 1000,
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

describe.skipIf(!databaseUrl)(
  "audit acceptance against isolated PostgreSQL",
  () => {
    let pool: Pool;
    let sourceRunId: string;
    let observationId: string;
    let instrumentId: string;
    let symbol: string;
    let decisionInput: RecordCoordinationDecisionInput;
    const signal = {
      entryReference: 10,
      stopReference: 9.5,
      targetReference: 11,
      atr14: 1,
      signalTimestamp: "2099-02-02T14:30:00.000Z",
    };
    const quote = {
      timestamp: signal.signalTimestamp,
      bid: 9.99,
      ask: 10,
      bidSize: 100,
      askSize: 100,
      dataStatus: "REALTIME" as const,
      actionable: true,
    };

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      instrumentId = randomUUID();
      symbol = `AUDIT_${instrumentId.slice(0, 8)}.TO`;
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
      security_type,industry_sector,is_quotable,is_tradable,active)
      VALUES($1,$2,$3,'Audit fixture','TSX','CAD','Stock','Financial Services',true,true,true)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1000000000) + 1000000000,
          symbol,
        ],
      );
      const profiles = await pool.query(
        "SELECT p.id,c.id AS config FROM scanner_profile p JOIN scanner_profile_config c ON c.profile_id=p.id WHERE p.market_id='CA_TSX' ORDER BY p.display_order LIMIT 1",
      );
      const profile = profiles.rows[0];
      const store = new PostgresPaperBotStore(pool);
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-02",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-02T21:00:00Z",
        executionModelVersion: "paper-execution-v6",
        assumptions,
      });
      sourceRunId = run.id;
      const original = await store.insertObservation({
        runId: run.id,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: randomUUID(),
        instrumentId,
        symbol,
        profileId: profile.id,
        profileName: "Audit",
        profileConfigId: profile.config,
        configVersion: "audit-test",
        profileParameters: {},
        strategyKey: "ORB_RETEST",
        strategyVersion: "1.0.0",
        signalTimestamp: signal.signalTimestamp,
        score: 100,
        entryReference: 10,
        stopReference: 9.5,
        targetReference: 11,
        atr14: 1,
        featureSnapshot: {},
        reasonCodes: [],
        sourceEventPayload: {},
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      observationId = original.observation.id;
      for (const [timestamp, bid, ask] of [
        [signal.signalTimestamp, 9.99, 10],
        ["2099-02-02T14:31:00Z", 11, 11.01],
      ]) {
        await pool.query(
          `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
        spread_absolute,spread_pct,is_delayed,is_halted,source) VALUES($1,$2,$3,$4,100,100,$3,100,1000,10,11,9,0.01,0.1,false,false,'AUDIT')`,
          [instrumentId, timestamp, bid, ask],
        );
      }
      await pool.query(
        `INSERT INTO candle(instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,source,is_complete)
      VALUES($1,'OneMinute','2099-02-02T14:30:00Z','2099-02-02T14:31:00Z',10,11.1,10,11,100,'AUDIT',true)`,
        [instrumentId],
      );
      await pool.query(
        `INSERT INTO candle(instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,source,is_complete)
      VALUES($1,'OneMinute','2099-02-02T14:31:00Z','2099-02-02T14:32:00Z',11,11.2,10.9,11.1,100,'AUDIT',true)`,
        [instrumentId],
      );
      await store.completeRun(run.id);
      const position = createQuoteExecution(signal, quote, assumptions);
      decisionInput = {
        runId: run.id,
        symbol,
        decisionTimestamp: signal.signalTimestamp,
        triggerObservationIds: [observationId],
        decision: {
          policyVersion: COORDINATION_POLICY_VERSION,
          outcome: "APPROVED",
          reason: "SELECTED_PRIMARY",
          selectedObservationId: observationId,
          selectedStrategyKey: "ORB_RETEST",
          confirmationObservationIds: [],
          rankedCandidates: [],
          contexts: [],
          contextAlignment: 0,
        },
        state: {
          hasOpenSymbolPosition: false,
          lastStopAt: null,
          openPositionCount: 0,
          totalOpenRisk: 0,
          dailyRealizedLoss: 0,
          consecutiveStops: 0,
        },
        initialPosition: { observationId, state: position },
      };
    }, 60000);

    afterAll(async () => {
      await pool?.end();
    });

    it("closes from retained normalized board-lot provenance without scaling capacity twice", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,
          bid_size_raw,ask_size_raw,size_unit,size_multiplier,last,last_size,day_volume,day_open,day_high,day_low,
          spread_absolute,spread_pct,is_delayed,is_halted,source)
          VALUES($1,'2099-02-03T20:00:01Z',10,10.01,100,100,1,1,'BOARD_LOTS',100,10,100,1000,10,11,9,0.01,0.1,false,false,'AUDIT')`,
          [instrumentId],
        );
        const store = new PostgresPaperBotStore(client as unknown as Pool);
        const quotes = await store.findSessionCloseQuotes(
          [instrumentId],
          "2099-02-03T20:00:00Z",
        );
        const retained = quotes.get(instrumentId)![0]!;
        expect(retained).toMatchObject({
          bidSize: 100,
          sizeUnit: "SHARES",
          sizeMultiplier: 1,
        });
        expect(
          resolveSessionClose(
            {
              entryPrice: 10,
              entryTime: signal.signalTimestamp,
              stop: 9,
              target: 11,
              shares: 150,
              initialRisk: 150,
              executionMode: "CAPACITY_CONSTRAINED",
            },
            retained,
            "2099-02-03T20:00:00Z",
            assumptions,
          ),
        ).toMatchObject({
          status: "CLOSED",
          exit: {
            filledShares: 100,
            unfilledShares: 50,
            exitReason: "SESSION_CLOSE_DELAYED",
          },
        });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("returns ordered actionable close-quote candidates and resolves the first real bar after a missed boundary bar", async () => {
      const boundary = "2099-02-02T16:00:00Z";
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const store = new PostgresPaperBotStore(client as unknown as Pool);
        const insertQuote = (
          second: number,
          overrides: {
            bid?: number;
            bidSize?: number;
            halted?: boolean;
            delayed?: boolean;
          } = {},
        ) =>
          client.query(
            `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
        spread_absolute,spread_pct,is_delayed,is_halted,source) VALUES($1,$2,$3,$4,$5,$5,$3,$5,1000,10,11,9,0.01,0.1,$6,$7,'AUDIT')`,
            [
              instrumentId,
              `2099-02-02T16:00:0${second}Z`,
              overrides.bid ?? 10,
              (overrides.bid ?? 10) + 0.01,
              overrides.bidSize ?? 100,
              overrides.delayed ?? false,
              overrides.halted ?? false,
            ],
          );
        // The first three rows are unusable for different reasons: halted,
        // delayed, then a zero bid. A capacity-constrained exit also needs
        // real displayed size, so the fourth row cannot fill it either.
        await insertQuote(1, { halted: true });
        await insertQuote(2, { delayed: true });
        await insertQuote(3, { bid: 0 });
        await insertQuote(4, { bidSize: 0 });
        await insertQuote(5, { bidSize: 50 });

        const candidates =
          (await store.findSessionCloseQuotes([instrumentId], boundary)).get(
            instrumentId,
          ) ?? [];
        expect(candidates.map((candidate) => candidate.timestamp)).toEqual([
          "2099-02-02T16:00:04.000Z",
          "2099-02-02T16:00:05.000Z",
        ]);

        const position = {
          entryPrice: 10,
          entryTime: signal.signalTimestamp,
          stop: 9,
          target: 11,
          shares: 100,
          initialRisk: 100,
          executionMode: "CAPACITY_CONSTRAINED" as const,
        };
        expect(
          resolveSessionClose(position, candidates[0]!, boundary, assumptions),
        ).toMatchObject({ status: "CLOSE_PENDING" });
        expect(
          resolveSessionClose(position, candidates[1]!, boundary, assumptions),
        ).toMatchObject({
          status: "CLOSED",
          exit: {
            filledShares: 50,
            unfilledShares: 50,
            exitReason: "SESSION_CLOSE_DELAYED",
          },
        });

        // No bar ends exactly at the boundary; the first complete bar after it
        // is a real delayed close and must be recovered instead of stranded.
        await client.query(
          `INSERT INTO candle(instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,source,is_complete)
      VALUES($1,'OneMinute','2099-02-02T16:00:00Z','2099-02-02T16:01:00Z',10,11,9,10,100,'AUDIT',true)`,
          [instrumentId],
        );
        await client.query(
          `INSERT INTO candle(instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,source,is_complete)
      VALUES($1,'OneMinute','2099-02-02T16:01:00Z','2099-02-02T16:02:00Z',10,11,9,10.5,100,'AUDIT',true)`,
          [instrumentId],
        );
        expect(
          (await store.findSessionCloseCandles([instrumentId], boundary)).get(
            instrumentId,
          ),
        ).toMatchObject({
          start: "2099-02-02T16:00:00.000Z",
          end: "2099-02-02T16:01:00.000Z",
        });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("recovers orders and atomically serializes concurrent fills and effects", async () => {
      const store = new PostgresPendingOrderStore(pool);
      const input = {
        orderId: randomUUID(),
        signal,
        assumptions: { ...assumptions, latencyMs: 500 },
        submittedAt: signal.signalTimestamp,
        expiresAt: "2099-02-02T14:31:00Z",
      };
      const order = await store.submit(sourceRunId, instrumentId, input);
      expect(await store.submit(sourceRunId, instrumentId, input)).toEqual(
        order,
      );
      await expect(
        store.submit(sourceRunId, instrumentId, {
          ...input,
          expiresAt: "2099-02-02T14:32:00Z",
        }),
      ).rejects.toThrow("different submission");
      expect(
        await new PostgresPendingOrderStore(pool).pending(sourceRunId),
      ).toContainEqual(order);
      const evolve = (current: typeof order) =>
        applyEntryOrderQuote(current, {
          ...quote,
          timestamp: "2099-02-02T14:30:01Z",
        });
      await expect(
        store.transition(sourceRunId, order.orderId, evolve, async (client) => {
          await client.query(
            "UPDATE paper_entry_order SET revision=99 WHERE order_id=$1",
            [order.orderId],
          );
          throw new Error("Injected effect failure");
        }),
      ).rejects.toThrow("Injected effect failure");
      expect(
        (
          await pool.query(
            "SELECT revision,state FROM paper_entry_order WHERE order_id=$1",
            [order.orderId],
          )
        ).rows[0],
      ).toMatchObject({ revision: "0", state: { status: "PENDING" } });
      let effectCalls = 0;
      const results = await Promise.all(
        [1, 2].map(() =>
          store.transition(sourceRunId, order.orderId, evolve, async () => {
            effectCalls += 1;
          }),
        ),
      );
      expect(results[0]).toEqual(results[1]);
      expect(results[0]?.status).toBe("FILLED");
      expect(effectCalls).toBe(1);
      expect(await store.pending(sourceRunId)).not.toContainEqual(order);
      expect(await store.submit(sourceRunId, instrumentId, input)).toEqual(
        results[0],
      );
    });

    it("commits shared capacity once across concurrent processors and rolls back effects", async () => {
      const store = new PostgresPendingOrderStore(pool);
      const ids: string[] = [randomUUID(), randomUUID()].sort();
      for (const orderId of ids)
        await store.submit(sourceRunId, instrumentId, {
          orderId,
          signal,
          assumptions: { ...assumptions, positionSize: 600 },
          submittedAt: signal.signalTimestamp,
          expiresAt: "2099-02-02T14:32:00Z",
        });
      const fact = { ...quote, timestamp: "2099-02-02T14:30:02Z" };
      await expect(
        store.allocateQuote(sourceRunId, instrumentId, fact, 1, 0, async () => {
          throw new Error("Shared effect failure");
        }),
      ).rejects.toThrow("Shared effect failure");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_entry_liquidity WHERE run_id=$1",
            [sourceRunId],
          )
        ).rows[0].count,
      ).toBe(0);
      let effects = 0;
      const results = await Promise.all(
        [1, 2].map(() =>
          store.allocateQuote(
            sourceRunId,
            instrumentId,
            fact,
            1,
            0,
            async () => {
              effects += 1;
            },
          ),
        ),
      );
      expect(effects).toBe(1);
      expect(results[0]?.liquidity.consumedShares).toBe(100);
      expect(
        results[0]?.orders
          .filter((order) => ids.includes(order.orderId))
          .map((order) =>
            order.execution?.status === "OPEN"
              ? order.execution.position.shares
              : 0,
          ),
      ).toEqual([60, 40]);
      expect(JSON.parse(JSON.stringify(results[0]))).toEqual(
        JSON.parse(JSON.stringify(results[1])),
      );
      const recovered = await new PostgresPendingOrderStore(pool).allocateQuote(
        sourceRunId,
        instrumentId,
        fact,
        1,
        0,
      );
      expect(recovered.liquidity).toEqual(results[0]?.liquidity);
      await expect(
        store.allocateQuote(
          sourceRunId,
          instrumentId,
          { ...fact, askSize: 101 },
          1,
          0,
        ),
      ).rejects.toThrow("Conflicting");
      await expect(
        store.allocateQuote(sourceRunId, instrumentId, quote, 1, 0),
      ).rejects.toThrow("Out-of-order");
    });

    it("serializes funded spending and rolls back rejected event batches", async () => {
      const store = new PostgresFundedLedgerStore(pool);
      const accountId = randomUUID();
      const at = signal.signalTimestamp;
      await store.create(accountId, ["CAD", 1000, "2099-02-02", at, 200]);
      const reserve: LedgerEvent = {
        id: "reserve",
        at,
        currency: "CAD",
        type: "RESERVE",
        orderId: "order",
        debit: 600,
        risk: 60,
      };
      const buy: LedgerEvent = {
        id: "buy",
        at,
        currency: "CAD",
        type: "BUY",
        orderId: "order",
        positionId: "position",
        instrumentId,
        shares: 60,
        price: 10,
        fee: 0,
        stop: 9,
      };
      await expect(
        store.apply(accountId, [reserve, { ...buy, shares: 100 }]),
      ).rejects.toThrow("reservation");
      expect((await store.read(accountId)).events).toHaveLength(0);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_funded_event WHERE account_id=$1",
            [accountId],
          )
        ).rows[0].count,
      ).toBe(0);
      const results = await Promise.all(
        [1, 2].map(() => store.apply(accountId, [reserve, buy])),
      );
      expect(results[0]?.cash).toBe(400);
      expect(results[1]?.cash).toBe(400);
      const recovered = await new PostgresFundedLedgerStore(pool).read(
        accountId,
      );
      expect(recovered.events).toHaveLength(2);
      expect(recovered.positions.position?.shares).toBe(60);
      await expect(
        store.apply(accountId, [
          { ...reserve, id: "second", orderId: "second" },
        ]),
      ).rejects.toThrow("buying power");
      await expect(
        store.create(accountId, ["CAD", 2000, "2099-02-02", at, 200]),
      ).rejects.toThrow("different funding");
    });

    it("atomically connects funded reservations, shared fills and cancellation", async () => {
      const run = await new PostgresPaperBotStore(pool).startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-02",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-02T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      const ledger = new PostgresFundedLedgerStore(pool);
      await ledger.create(accountId, [
        "CAD",
        2000,
        "2099-02-02",
        signal.signalTimestamp,
        500,
      ]);
      const service = new FundedOrderService(pool, run.id, accountId, "CAD");
      await service.bind();
      await service.bind();
      await expect(
        (async () => {
          const adoptionAccountId = randomUUID();
          await ledger.create(adoptionAccountId, [
            "CAD",
            2000,
            "2099-02-02",
            signal.signalTimestamp,
            500,
          ]);
          return new FundedOrderService(
            pool,
            sourceRunId,
            adoptionAccountId,
            "CAD",
          ).bind();
        })(),
      ).rejects.toThrow("unfunded orders");
      const input = {
        orderId: randomUUID(),
        signal,
        assumptions: { ...assumptions, positionSize: 600 },
        submittedAt: "2099-02-02T14:30:02Z",
        expiresAt: "2099-02-02T14:31:00Z",
      };
      await expect(
        service.submit(instrumentId, input, 3000, 100),
      ).rejects.toThrow("buying power");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_entry_order WHERE order_id=$1",
            [input.orderId],
          )
        ).rows[0].count,
      ).toBe(0);
      await service.submit(instrumentId, input, 600, 100);
      await service.submit(instrumentId, input, 600, 100);
      await expect(
        service.submit(instrumentId, input, 601, 100),
      ).rejects.toThrow("Conflicting ledger event retry");
      await expect(
        service.submit(instrumentId, input, 600, 101),
      ).rejects.toThrow("Conflicting ledger event retry");
      await expect(
        service.submit(
          randomUUID(),
          { ...input, orderId: randomUUID() },
          600,
          100,
        ),
      ).rejects.toThrow("Instrument does not match");
      await expect(
        service.bind({
          projectionVersion: "funded-cash-v1",
          participation: 0.5,
          impactBps: 0,
          latencyPolicy: "CAPTURED_PER_ORDER",
        }),
      ).rejects.toThrow("immutable");
      await expect(
        new PostgresPaperBotStore(pool).completeRun(run.id),
      ).rejects.toThrow("unresolved");
      expect((await ledger.read(accountId)).events).toHaveLength(1);
      const fact = { ...quote, timestamp: "2099-02-02T14:30:03Z" };
      await expect(service.quote(instrumentId, fact, 0.5, 0)).rejects.toThrow(
        "immutable funded policy",
      );
      await expect(service.quote(randomUUID(), fact, 1, 0)).rejects.toThrow(
        "Instrument does not match",
      );
      await service.quote(instrumentId, fact, 1, 0);
      await service.quote(instrumentId, fact, 1, 0);
      expect((await ledger.read(accountId)).cash).toBe(1400);
      expect(
        (await ledger.read(accountId)).positions[input.orderId]?.shares,
      ).toBe(60);
      const cancelled = {
        ...input,
        orderId: randomUUID(),
        submittedAt: "2099-02-02T14:30:04Z",
      };
      await service.submit(instrumentId, cancelled, 600, 100);
      await service.cancel(
        cancelled.orderId,
        "2099-02-02T14:30:05Z",
        "USER_CANCELLED",
      );
      expect((await ledger.read(accountId)).reservations).toEqual({});
      const underfunded = {
        ...input,
        orderId: randomUUID(),
        submittedAt: "2099-02-02T14:30:05Z",
        signal: { ...signal, targetReference: 12 },
      };
      await service.submit(instrumentId, underfunded, 1, 1);
      const exitQuote = {
        ...quote,
        timestamp: "2099-02-02T14:30:06Z",
        bid: 11,
        ask: 11.01,
        bidSize: 20,
      };
      const partial = await service.quote(instrumentId, exitQuote, 1, 0);
      expect(partial.liquidity.consumedBidShares).toBe(20);
      expect(
        (
          await pool.query(
            "SELECT state FROM paper_entry_order WHERE order_id=$1",
            [underfunded.orderId],
          )
        ).rows[0].state,
      ).toMatchObject({ status: "CANCELLED", reason: "RISK_VETO" });
      expect((await ledger.read(accountId)).reservations).toEqual({});
      expect(
        (await ledger.read(accountId)).positions[input.orderId]?.shares,
      ).toBe(40);
      expect((await ledger.read(accountId)).realizedPnl).toBe(19.6667);
      await service.quote(instrumentId, exitQuote, 1, 0);
      expect((await ledger.read(accountId)).cash).toBe(1619.6667);
      await service.quote(
        instrumentId,
        { ...exitQuote, timestamp: "2099-02-02T14:30:07Z", bidSize: 40 },
        1,
        0,
      );
      expect((await ledger.read(accountId)).positions).toEqual({});
      expect((await ledger.read(accountId)).cash).toBe(2059);
      expect((await ledger.read(accountId)).realizedPnl).toBe(59);
      const report = await new FundedReportingService(pool).report(
        run.id,
        "2099-02-02T14:30:08Z",
      );
      expect(report.projection).toBe("FUNDED_CASH_SIMULATION");
      expect(report.summary.cash).toBe(2059);
      expect(report.summary.realizedPnl).toBe(59);
      expect(report.qualifiedForCapitalAllocation).toBe(false);
      expect(report.cohort.currency).toBe("CAD");
      expect(report.cohort.fundedPolicy).toMatchObject({
        participation: 1,
        impactBps: 0,
      });

      const journal = await new FundedReportingService(pool, undefined, {
        CA_TSX: accountId,
      }).journal({ marketId: "CA_TSX", source: "BACKTEST" });
      expect(journal.projection).toBe("FUNDED");
      // Only the filled, closed order is a trade. The user-cancelled and
      // risk-vetoed submissions stay decisions and never enter the ledger.
      expect(journal.entries).toHaveLength(1);
      expect(journal.entries[0]).toMatchObject({
        id: input.orderId,
        runId: run.id,
        symbol,
        status: "CLOSED",
        exitReason: "TARGET",
        netPnl: 59,
        runningNetPnl: 59,
      });
      expect(journal.totals).toMatchObject({
        closedTrades: 1,
        openPositions: 0,
        wins: 1,
        losses: 0,
        netPnl: 59,
        largestWin: 59,
      });
      expect(journal.unresolvedPositions).toEqual([]);
      // Reservation retries remain immutable even after the position has closed.
      await service.submit(instrumentId, input, 600, 100);
      await expect(
        service.submit(instrumentId, input, 601, 100),
      ).rejects.toThrow("Conflicting ledger event retry");
      const expiring = {
        ...input,
        orderId: randomUUID(),
        submittedAt: "2099-02-02T14:30:09Z",
      };
      await service.submit(instrumentId, expiring, 600, 100);
      await service.advanceClock("2099-02-02T14:31:00Z");
      await service.advanceClock("2099-02-02T14:31:00Z");
      expect((await ledger.read(accountId)).reservations).toEqual({});
      expect(
        (
          await pool.query(
            "SELECT state FROM paper_entry_order WHERE order_id=$1",
            [expiring.orderId],
          )
        ).rows[0].state.reason,
      ).toBe("EXPIRED");
      await expect(
        service.submit(
          instrumentId,
          { ...expiring, orderId: randomUUID() },
          600,
          100,
        ),
      ).rejects.toThrow("precedes funded clock");
      await expect(
        service.quote(
          instrumentId,
          { ...fact, timestamp: "2099-02-02T14:30:59Z" },
          1,
          0,
        ),
      ).rejects.toThrow("precedes funded clock");
      const held = {
        ...input,
        orderId: randomUUID(),
        submittedAt: "2099-02-02T14:31:01Z",
        expiresAt: "2099-02-02T22:00:00Z",
      };
      await service.submit(instrumentId, held, 600, 100);
      await service.quote(
        instrumentId,
        { ...quote, timestamp: held.submittedAt },
        1,
        0,
      );
      await service.submit(
        instrumentId,
        { ...held, orderId: randomUUID(), submittedAt: "2099-02-02T14:31:02Z" },
        600,
        100,
      );
      const cashBeforeClose = (await ledger.read(accountId)).cash;
      await service.advanceClock("2099-02-02T21:00:00Z");
      expect((await ledger.read(accountId)).cash).toBe(cashBeforeClose);
      expect((await ledger.read(accountId)).reservations).toEqual({});
      expect(
        (
          await pool.query(
            "SELECT state FROM paper_entry_order WHERE order_id=$1",
            [held.orderId],
          )
        ).rows[0].state.execution.status,
      ).toBe("CLOSE_PENDING");
      expect(
        await new PostgresPaperBotStore(pool).settleRunAfterCloseRequest(
          run.id,
        ),
      ).toBe("CLOSE_PENDING");
      const recovered = new FundedOrderService(pool, run.id, accountId, "CAD");
      await recovered.quote(
        instrumentId,
        { ...quote, timestamp: "2099-02-02T21:00:01Z" },
        1,
        0,
      );
      expect((await ledger.read(accountId)).positions).toEqual({});
      expect(
        await new PostgresPaperBotStore(pool).settleRunAfterCloseRequest(
          run.id,
        ),
      ).toBe("COMPLETED");
      await expect(
        new FundedReportingService(pool).report(
          sourceRunId,
          "2099-02-02T14:30:08Z",
        ),
      ).rejects.toThrow("no funded account");
    });

    it("continues a funded account into a later completed session without sharing active runs", async () => {
      const store = new PostgresPaperBotStore(pool);
      const first = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-02",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-02T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      const ledger = new PostgresFundedLedgerStore(pool);
      await ledger.create(accountId, [
        "CAD",
        2000,
        "2099-02-02",
        "2099-02-02T14:30:00Z",
        500,
      ]);
      await new FundedOrderService(pool, first.id, accountId, "CAD").bind();
      await expect(
        pool.query(
          "UPDATE paper_funded_run SET policy='{}'::jsonb WHERE run_id=$1",
          [first.id],
        ),
      ).rejects.toThrow("binding and policy are immutable");
      await expect(
        pool.query(
          "UPDATE paper_funded_account SET initial_state=jsonb_set(initial_state,'{cash}','1999'::jsonb) WHERE id=$1",
          [accountId],
        ),
      ).rejects.toThrow("initial funding is immutable");
      await store.completeRun(first.id);

      const second = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-03",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-03T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      await new FundedOrderService(pool, second.id, accountId, "CAD").bind(
        undefined,
        { session: "2099-02-03", at: "2099-02-03T14:30:00Z" },
      );
      const state = await ledger.read(accountId);
      expect(state.session).toBe("2099-02-03");
      expect(
        state.events.filter((event) => event.type === "SESSION"),
      ).toHaveLength(1);
      const secondService = new FundedOrderService(
        pool,
        second.id,
        accountId,
        "CAD",
      );
      const secondOrder = {
        orderId: randomUUID(),
        signal: {
          ...signal,
          signalTimestamp: "2099-02-03T14:30:01Z",
        },
        assumptions,
        submittedAt: "2099-02-03T14:30:01Z",
        expiresAt: "2099-02-03T14:35:00Z",
      };
      await secondService.submit(instrumentId, secondOrder, 600, 100);
      await secondService.quote(
        instrumentId,
        { ...quote, timestamp: "2099-02-03T14:30:02Z" },
        1,
        0,
      );
      const firstReport = await new FundedReportingService(pool).report(
        first.id,
      );
      expect(firstReport.temporalScope).toBe("RUN_END");
      expect(firstReport.asOf).toBe("2099-02-02T14:30:00.000Z");
      expect(firstReport.summary.cash).toBe(2_000);
      expect(firstReport.summary.realizedPnl).toBe(0);
      const secondAsOf = await new FundedReportingService(pool).report(
        second.id,
        "2099-02-03T14:30:00Z",
      );
      expect(secondAsOf.temporalScope).toBe("AS_OF");
      expect(secondAsOf.summary.cash).toBe(2_000);
      expect(secondAsOf.positions).toEqual({});

      const fundedCurve = await new FundedReportingService(pool, undefined, {
        CA_TSX: accountId,
      }).performanceCurve(
        "CA_TSX",
        { startDate: "2099-02-02", endDate: "2099-02-03" },
        "BACKTEST",
      );
      expect(fundedCurve).toMatchObject({
        account: "FUNDED",
        marketId: "CA_TSX",
        currency: "CAD",
        granularity: "DAY",
        warnings: [],
      });
      // The running second session has no retained boundary yet, so it is
      // omitted rather than marked to now.
      expect(
        fundedCurve.points.map((point) => [
          point.sessionDate,
          point.cumulativeNetPnl,
        ]),
      ).toEqual([["2099-02-02", 0]]);

      const fundedJournal = await new FundedReportingService(pool, undefined, {
        CA_TSX: accountId,
      }).journal({ marketId: "CA_TSX", source: "BACKTEST" });
      expect(fundedJournal.projection).toBe("FUNDED");
      // The quote was filled and immediately risk-vetoed, so it is a decision,
      // not a trade: it must not appear in the account ledger.
      expect(fundedJournal.entries).toEqual([]);
      expect(fundedJournal.totals).toMatchObject({
        closedTrades: 0,
        openPositions: 0,
      });

      const active = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-04",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-04T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      await expect(
        new FundedOrderService(pool, active.id, accountId, "CAD").bind(),
      ).rejects.toThrow("active run");
    });

    it("does not fabricate a run-end snapshot when a legacy completed run is resettled", async () => {
      const store = new PostgresPaperBotStore(pool);
      const legacy = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-05",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-05T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      const ledger = new PostgresFundedLedgerStore(pool);
      await ledger.create(accountId, [
        "CAD",
        2_000,
        "2099-02-05",
        "2099-02-05T14:30:00Z",
        500,
      ]);
      await new FundedOrderService(pool, legacy.id, accountId, "CAD").bind();
      await store.completeRun(legacy.id);
      await pool.query(
        "DELETE FROM paper_funded_run_snapshot WHERE run_id=$1",
        [legacy.id],
      );
      const later = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-06",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-06T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      await new FundedOrderService(pool, later.id, accountId, "CAD").bind(
        undefined,
        { session: "2099-02-06", at: "2099-02-06T14:30:00Z" },
      );
      expect(await store.settleRunAfterCloseRequest(legacy.id)).toBe(
        "COMPLETED",
      );
      await expect(
        new FundedReportingService(pool).report(legacy.id),
      ).rejects.toThrow("run-end snapshot is unavailable");
      expect((await ledger.read(accountId)).session).toBe("2099-02-06");
    });

    it("preserves first-discovery invalidations across a restart", async () => {
      const store = new PostgresPaperBotStore(pool);
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2025-02-10",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2025-02-10T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        "CAD",
        2_000,
        "2025-02-10",
        "2025-02-10T14:30:00Z",
        500,
      ]);
      const adapter = new FundedLiveAdapter({
        pool,
        runId: run.id,
        accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions,
      });
      await adapter.bind("2025-02-10", "2025-02-10T14:30:00Z", 2_000, 500);
      const profiles = await pool.query<{ id: string; config: string }>(
        "SELECT p.id,c.id AS config FROM scanner_profile p JOIN scanner_profile_config c ON c.profile_id=p.id WHERE p.market_id='CA_TSX' ORDER BY p.display_order LIMIT 1",
      );
      const profile = profiles.rows[0]!;
      // The funded path only ever sees durable observations; the refusal
      // source is committed atomically with this cycle's facts.
      const insertedObservation = await store.insertObservation({
        runId: run.id,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: randomUUID(),
        instrumentId,
        symbol,
        profileId: profile.id,
        profileName: "R1",
        profileConfigId: profile.config,
        configVersion: "r1",
        profileParameters: {},
        strategyKey: "ORB_RETEST",
        strategyVersion: "1.0.0",
        signalTimestamp: "2025-02-10T14:30:00Z",
        score: 100,
        entryReference: 10,
        stopReference: 9.5,
        targetReference: 11,
        atr14: 1,
        featureSnapshot: {},
        reasonCodes: [],
        sourceEventPayload: {},
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      const observation = insertedObservation.observation;
      const observationId = observation.id;
      const invalidation = {
        eventId: `r1-${randomUUID()}`,
        orderId: observationId,
        at: "2025-02-10T14:30:00.500Z",
      };
      const pendingSignal = buildFundedSignalEnvelope(
        observation,
        "2025-02-10T14:30:01Z",
        run.scheduledCloseAt,
        assumptions,
      );
      expect(pendingSignal).toBeDefined();
      await new FundedFactAdapter(pool, run.id).enqueue([pendingSignal!]);
      await adapter.process({
        at: "2025-02-10T14:30:01Z",
        sessionDate: "2025-02-10",
        scheduledCloseAt: run.scheduledCloseAt,
        observations: [observation],
        invalidations: [invalidation],
        quotes: [
          {
            instrumentId,
            timestamp: "2025-02-10T14:30:02Z",
            bid: 9.99,
            ask: 10,
            bidSize: 100,
            askSize: 100,
            dataStatus: "REALTIME",
            actionable: true,
          },
        ],
      });
      expect(
        (
          await pool.query(
            "SELECT outcome FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
            [run.id, `funded-invalidation:${invalidation.eventId}`],
          )
        ).rows[0].outcome,
      ).toMatchObject({ status: "PRE_SUBMISSION_SUPPRESSED" });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_entry_order WHERE run_id=$1",
            [run.id],
          )
        ).rows[0].count,
      ).toBe(0);

      const restarted = new FundedLiveAdapter({
        pool,
        runId: run.id,
        accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions,
      });
      await restarted.process({
        at: "2025-02-10T14:30:03Z",
        sessionDate: "2025-02-10",
        scheduledCloseAt: run.scheduledCloseAt,
        observations: [observation],
        invalidations: [],
        quotes: [],
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_entry_order WHERE run_id=$1",
            [run.id],
          )
        ).rows[0].count,
      ).toBe(0);
    });

    it("reuses an existing live signal on a later cycle without leaking inbox metadata", async () => {
      const store = new PostgresPaperBotStore(pool);
      const fundedAssumptions = { ...assumptions, riskBudget: 100 };
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-13",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-13T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions: fundedAssumptions,
      });
      const accountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        "CAD",
        2_000,
        "2099-02-13",
        "2099-02-13T14:30:00Z",
        500,
      ]);
      const adapter = new FundedLiveAdapter({
        pool,
        runId: run.id,
        accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions: fundedAssumptions,
      });
      await adapter.bind("2099-02-13", "2099-02-13T14:30:00Z", 2_000, 500);
      const persisted = await store.findObservationById(observationId);
      if (!persisted) throw new Error("Audit observation was not found");
      const candidate = {
        ...persisted,
        id: randomUUID(),
        runId: run.id,
        signalTimestamp: "2099-02-13T14:30:00Z",
        createdAt: "2099-02-13T14:30:00Z",
      };
      await adapter.process({
        at: "2099-02-13T14:30:01Z",
        sessionDate: "2099-02-13",
        scheduledCloseAt: run.scheduledCloseAt,
        observations: [candidate],
        invalidations: [],
        quotes: [],
      });
      await adapter.process({
        at: "2099-02-13T14:30:02Z",
        sessionDate: "2099-02-13",
        scheduledCloseAt: run.scheduledCloseAt,
        observations: [candidate],
        invalidations: [],
        quotes: [
          {
            instrumentId,
            timestamp: "2099-02-13T14:30:02Z",
            bid: 9.99,
            ask: 10,
            bidSize: 100,
            askSize: 100,
            dataStatus: "REALTIME",
            actionable: true,
          },
        ],
      });
      expect(
        (
          await pool.query(
            "SELECT state FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
            [run.id, candidate.id],
          )
        ).rows[0].state.status,
      ).toBe("FILLED");
      expect(
        (
          await pool.query(
            "SELECT outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
            [run.id, `funded-signal:${candidate.id}`],
          )
        ).rows[0].status,
      ).toBe("APPLIED");
    });

    it("preserves a committed in-flight submission when a pre-submission invalidation is discovered", async () => {
      const store = new PostgresPaperBotStore(pool);
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-14",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-14T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      const ledger = new PostgresFundedLedgerStore(pool);
      await ledger.create(accountId, [
        "CAD",
        2_000,
        "2099-02-14",
        "2099-02-14T14:30:00Z",
        500,
      ]);
      const service = new FundedOrderService(pool, run.id, accountId, "CAD");
      await service.bind();
      const persisted = await store.findObservationById(observationId);
      if (!persisted) throw new Error("Audit observation was not found");
      const candidate = {
        ...persisted,
        id: randomUUID(),
        runId: run.id,
        signalTimestamp: "2099-02-14T14:30:00Z",
        createdAt: "2099-02-14T14:30:00Z",
      };
      const order = {
        orderId: candidate.id,
        signal: {
          ...signal,
          signalTimestamp: candidate.signalTimestamp,
        },
        assumptions,
        submittedAt: "2099-02-14T14:30:01Z",
        expiresAt: "2099-02-14T14:35:00Z",
      };
      const signalFact = {
        type: "SIGNAL" as const,
        instrumentId,
        order,
        maximumDebit: 1_000,
        maximumRisk: 100,
      };
      const inbox = new FundedFactAdapter(pool, run.id);
      await inbox.enqueue([
        { id: `funded-signal:${candidate.id}`, fact: signalFact },
        {
          id: `same-time-quote:${candidate.id}`,
          fact: {
            type: "QUOTE",
            instrumentId,
            quote: { ...quote, timestamp: order.submittedAt },
            participation: 1,
            impactBps: 0,
          },
        },
      ]);
      await service.submit(
        instrumentId,
        order,
        1_000,
        100,
        `funded-signal:${candidate.id}`,
      );
      await pool.query(
        `UPDATE paper_funded_run
         SET inflight_fact_id=$2,inflight_fact_at=$3,inflight_priority=2,inflight_sort_key=$4
         WHERE run_id=$1`,
        [
          run.id,
          `funded-signal:${candidate.id}`,
          order.submittedAt,
          candidate.id,
        ],
      );
      const invalidation = {
        eventId: `r1-inflight-${randomUUID()}`,
        orderId: candidate.id,
        at: "2099-02-14T14:30:00.500Z",
      };
      // Reconciliation commits, then the process restarts before draining the
      // in-flight signal and same-time quote. Neither may recreate the entry.
      await inbox.enqueue([
        {
          id: `funded-invalidation:${invalidation.eventId}`,
          fact: {
            type: "CANCEL",
            orderId: candidate.id,
            at: invalidation.at,
            reason: "SIGNAL_INVALIDATED",
            preSubmissionEventId: invalidation.eventId,
          },
        },
      ]);
      expect((await ledger.read(accountId)).reservations).toEqual({});
      const adapter = new FundedLiveAdapter({
        pool,
        runId: run.id,
        accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions,
      });
      await adapter.process({
        at: "2099-02-14T14:30:02Z",
        sessionDate: "2099-02-14",
        scheduledCloseAt: run.scheduledCloseAt,
        observations: [candidate],
        invalidations: [invalidation],
        quotes: [],
      });
      const outcomes = (
        await pool.query(
          "SELECT fact_id,outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 ORDER BY fact_at,priority,fact_id",
          [run.id],
        )
      ).rows;
      expect(outcomes).toEqual([
        {
          fact_id: `funded-invalidation:${invalidation.eventId}`,
          status: "APPLIED",
        },
        { fact_id: `funded-signal:${candidate.id}`, status: "APPLIED" },
        { fact_id: `same-time-quote:${candidate.id}`, status: "APPLIED" },
        { fact_id: "funded-clock:2099-02-14T14:30:02Z", status: "APPLIED" },
      ]);
      expect(
        (
          await pool.query(
            "SELECT state FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
            [run.id, candidate.id],
          )
        ).rows[0].state,
      ).toMatchObject({ status: "CANCELLED", reason: "SIGNAL_INVALIDATED" });
      expect((await ledger.read(accountId)).reservations).toEqual({});
      expect((await ledger.read(accountId)).cash).toBe(2_000);
      expect((await ledger.read(accountId)).positions).toEqual({});
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_funded_event WHERE account_id=$1 AND event_id=$2",
            [accountId, `release:${candidate.id}`],
          )
        ).rows[0].count,
      ).toBe(1);
    });

    it("reports current upgraded account state without inventing historical ordering", async () => {
      const store = new PostgresPaperBotStore(pool);
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2020-02-03",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2020-02-03T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      const ledger = new PostgresFundedLedgerStore(pool);
      await ledger.create(accountId, [
        "CAD",
        2000,
        "2020-02-03",
        "2020-02-03T14:30:00Z",
        500,
      ]);
      const service = new FundedOrderService(pool, run.id, accountId, "CAD");
      await service.bind();
      const orderId = randomUUID();
      await service.submit(
        instrumentId,
        {
          orderId,
          assumptions,
          signal: { ...signal, signalTimestamp: "2020-02-03T14:30:01Z" },
          submittedAt: "2020-02-03T14:30:01Z",
          expiresAt: "2020-02-03T21:00:00Z",
        },
        1000,
        100,
      );
      await service.quote(
        instrumentId,
        { ...quote, timestamp: "2020-02-03T14:30:02Z" },
        1,
        0,
      );
      // Migration 079 marks old durable events unverified. Their current
      // account snapshot is still authoritative even after compaction.
      await pool.query(
        "UPDATE paper_funded_event SET event_sequence_verified=FALSE WHERE account_id=$1",
        [accountId],
      );
      await ledger.compact(accountId);
      const reporting = new FundedReportingService(pool);
      const current = await reporting.report(run.id, {
        mode: "CURRENT_ACCOUNT",
      });
      expect(current.temporalScope).toBe("CURRENT_ACCOUNT");
      expect(current.ordersScope).toBe("ACCOUNT");
      expect(current.accountSession).toBe("2020-02-03");
      expect(current.summary.cash).toBe(1000);
      expect(current.positions[orderId]?.shares).toBe(100);
      expect(current.orders).toHaveLength(1);
      expect(current.orders[0]).toMatchObject({
        runId: run.id,
        orderId,
        status: "FILLED",
      });
      await expect(
        reporting.report(run.id, "2020-02-03T14:30:02Z"),
      ).rejects.toThrow("event order predates temporal sequencing");
    });

    it("drains cancellation after a durable reservation veto as a no-op", async () => {
      const store = new PostgresPaperBotStore(pool);
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-11",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-11T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        "CAD",
        1_000,
        "2099-02-11",
        "2099-02-11T14:30:00Z",
        500,
      ]);
      await new FundedOrderService(pool, run.id, accountId, "CAD").bind();
      const orderId = randomUUID();
      const facts = [
        {
          id: "r2-clock",
          fact: { type: "CLOCK" as const, at: "2099-02-11T14:30:00Z" },
        },
        {
          id: "r2-signal",
          fact: {
            type: "SIGNAL" as const,
            instrumentId,
            maximumDebit: 2_000,
            maximumRisk: 100,
            order: {
              orderId,
              submittedAt: "2099-02-11T14:30:01Z",
              expiresAt: "2099-02-11T14:35:00Z",
              signal: {
                ...signal,
                signalTimestamp: "2099-02-11T14:30:01Z",
              },
              assumptions,
            },
          },
        },
        {
          id: "r2-cancel",
          fact: {
            type: "CANCEL" as const,
            orderId,
            at: "2099-02-11T14:30:02Z",
            reason: "SIGNAL_INVALIDATED" as const,
          },
        },
        {
          id: "r2-quote",
          fact: {
            type: "QUOTE" as const,
            instrumentId,
            quote: { ...quote, timestamp: "2099-02-11T14:30:03Z" },
            participation: 1,
            impactBps: 0,
          },
        },
      ];
      const adapter = new FundedFactAdapter(pool, run.id);
      await adapter.enqueue(facts);
      expect(await adapter.drain()).toBe(4);
      const outcomes = (
        await pool.query(
          "SELECT fact_id,outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 ORDER BY fact_at,priority,fact_id",
          [run.id],
        )
      ).rows;
      expect(outcomes).toEqual([
        { fact_id: "r2-clock", status: "APPLIED" },
        { fact_id: "r2-signal", status: "RISK_VETO" },
        { fact_id: "r2-cancel", status: "CANCEL_NOOP_RESERVATION_VETO" },
        { fact_id: "r2-quote", status: "APPLIED" },
      ]);
      expect(
        (await new PostgresFundedLedgerStore(pool).read(accountId))
          .reservations,
      ).toEqual({});
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_entry_order WHERE run_id=$1",
            [run.id],
          )
        ).rows[0].count,
      ).toBe(0);
      await adapter.enqueue([
        {
          id: "r2-unknown",
          fact: {
            type: "CANCEL",
            orderId: randomUUID(),
            at: "2099-02-11T14:30:04Z",
            reason: "SIGNAL_INVALIDATED",
          },
        },
      ]);
      await expect(adapter.drain()).rejects.toThrow("Order not found");
    });

    it("recovers repeated US cancellations after acknowledged pre-submission suppression", async () => {
      const run = await new PostgresPaperBotStore(pool).startBacktestRun({
        source: "BACKTEST",
        marketId: "US_EQUITIES",
        sessionDate: "2099-02-12",
        sessionTimezone: "America/New_York",
        scheduledCloseAt: "2099-02-12T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      const ledger = new PostgresFundedLedgerStore(pool);
      await ledger.create(accountId, [
        "USD",
        1_000,
        "2099-02-12",
        "2099-02-12T14:30:00Z",
        500,
      ]);
      const service = new FundedOrderService(pool, run.id, accountId, "USD");
      await service.bind();
      const orderId = randomUUID();
      const eventId = randomUUID();
      const adapter = new FundedFactAdapter(pool, run.id);
      await adapter.enqueue([
        {
          id: `funded-invalidation:${eventId}`,
          fact: {
            type: "CANCEL",
            orderId,
            at: "2099-02-12T14:30:01Z",
            reason: "SIGNAL_INVALIDATED",
            preSubmissionEventId: eventId,
          },
        },
      ]);
      // An unacknowledged marker is not proof for a later ordinary cancellation.
      await expect(
        service.cancel(orderId, "2099-02-12T14:30:02Z", "SIGNAL_INVALIDATED"),
      ).rejects.toThrow("Order not found");
      expect(await adapter.drain()).toBe(1);
      await expect(
        service.cancel(orderId, "2099-02-12T14:30:00Z", "SIGNAL_INVALIDATED"),
      ).rejects.toThrow("Order not found");
      const before = await ledger.read(accountId);
      await adapter.enqueue([
        ...[2, 3].map((second) => ({
          id: `later-cancel:${second}`,
          fact: {
            type: "CANCEL" as const,
            orderId,
            at: `2099-02-12T14:30:0${second}Z`,
            reason: "SIGNAL_INVALIDATED" as const,
          },
        })),
        {
          id: "following-clock",
          fact: { type: "CLOCK", at: "2099-02-12T14:30:04Z" },
        },
      ]);
      expect(await new FundedFactAdapter(pool, run.id).drain()).toBe(3);
      expect(await new FundedFactAdapter(pool, run.id).drain()).toBe(0);
      expect(await ledger.read(accountId)).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_entry_order WHERE run_id=$1",
            [run.id],
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 AND fact_id LIKE 'later-cancel:%'",
            [run.id],
          )
        ).rows,
      ).toEqual([
        { status: "PRE_SUBMISSION_SUPPRESSED" },
        { status: "PRE_SUBMISSION_SUPPRESSED" },
      ]);
      await expect(
        service.cancel(
          randomUUID(),
          "2099-02-12T14:30:05Z",
          "SIGNAL_INVALIDATED",
        ),
      ).rejects.toThrow("Order not found");
    });

    it.each([
      ["CA_TSX", "CAD"],
      ["US_EQUITIES", "USD"],
    ] as const)(
      "drains a retained pre-close signal through settlement in %s",
      async (marketId, currency) => {
        const localInstrument = randomUUID();
        await pool.query(
          `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,market_id,security_type,is_quotable,is_tradable,active)
        VALUES($1,$2,$3,'close recovery',$4,$5,$6,'Stock',true,true,true)`,
          [
            localInstrument,
            Math.floor(Math.random() * 1000000000) + 1000000000,
            `CLOSE_${localInstrument.slice(0, 8)}`,
            currency === "CAD" ? "TSX" : "NASDAQ",
            currency,
            marketId,
          ],
        );
        const localAssumptions = {
          ...assumptions,
          costs: {
            currency,
            entryCommission: 0,
            exitCommission: 0,
            estimatedRegulatoryFees: 0,
            slippageBps: 0,
            brokerPricingVersion: "close-recovery-test",
          },
        };
        const store = new PostgresPaperBotStore(pool);
        const run = await store.startBacktestRun({
          source: "BACKTEST",
          marketId,
          sessionDate: "2099-02-13",
          sessionTimezone: assumptions.sessionTimezone,
          scheduledCloseAt: "2099-02-13T21:00:00Z",
          executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
          assumptions: localAssumptions,
        });
        const accountId = randomUUID();
        const ledger = new PostgresFundedLedgerStore(pool);
        await ledger.create(accountId, [
          currency,
          10000,
          "2099-02-13",
          "2099-02-13T14:30:00Z",
          1000,
        ]);
        const service = new FundedOrderService(
          pool,
          run.id,
          accountId,
          currency,
        );
        await service.bind();
        const order = {
          orderId: randomUUID(),
          submittedAt: "2099-02-13T20:50:00Z",
          expiresAt: "2099-02-13T20:55:00Z",
          signal: { ...signal, signalTimestamp: "2099-02-13T20:50:00Z" },
          assumptions: localAssumptions,
        };
        const inbox = new FundedFactAdapter(pool, run.id);
        const signalId = `funded-signal:${order.orderId}`;
        await inbox.enqueue([
          {
            id: signalId,
            fact: {
              type: "SIGNAL",
              instrumentId: localInstrument,
              order,
              maximumDebit: 1000,
              maximumRisk: 100,
            },
          },
          {
            id: "close-clock",
            fact: { type: "CLOCK", at: "2099-02-13T21:00:00Z" },
          },
        ]);
        expect(await store.settleRunAfterCloseRequest(run.id)).toBe(
          "CLOSE_PENDING",
        );
        // A retained but unclaimed envelope does not open direct submissions.
        await expect(
          service.submit(localInstrument, order, 1000, 100),
        ).rejects.toThrow("closed for submissions");
        await pool.query(
          "UPDATE paper_funded_run SET inflight_fact_id=$2,inflight_fact_at=$3,inflight_priority=2,inflight_sort_key=$4 WHERE run_id=$1",
          [run.id, signalId, order.submittedAt, order.orderId],
        );
        await expect(
          service.submit(localInstrument, order, 999, 100),
        ).rejects.toThrow("closed for submissions");
        await expect(
          service.submit(
            localInstrument,
            { ...order, orderId: randomUUID() },
            1000,
            100,
          ),
        ).rejects.toThrow("closed for submissions");
        expect(await new FundedFactAdapter(pool, run.id).drain()).toBe(2);
        expect(await inbox.drain()).toBe(0);
        expect((await ledger.read(accountId)).reservations).toEqual({});
        expect(
          (
            await pool.query(
              "SELECT state->>'status' AS status FROM paper_entry_order WHERE run_id=$1",
              [run.id],
            )
          ).rows,
        ).toEqual([{ status: "CANCELLED" }]);
        expect(await store.settleRunAfterCloseRequest(run.id)).toBe(
          "COMPLETED",
        );
        // Neither terminal runs nor close-boundary signals gain submission rights.
        await expect(
          service.submit(
            localInstrument,
            {
              ...order,
              orderId: randomUUID(),
              submittedAt: "2099-02-13T21:00:00Z",
              expiresAt: "2099-02-13T21:01:00Z",
            },
            1000,
            100,
          ),
        ).rejects.toThrow("closed for submissions");
      },
    );

    it("reserves and fills the full notional cap when entry commission is nonzero", async () => {
      const costs = {
        entryCommission: 5,
        exitCommission: 5,
        estimatedRegulatoryFees: 0,
        slippageBps: 0,
        currency: "CAD" as const,
        brokerPricingVersion: "r4-v1",
      };
      const fundedAssumptions = {
        ...assumptions,
        riskBudget: 100,
        positionSize: 2_000,
        maxNotional: 1_000,
        costs,
      };
      const run = await new PostgresPaperBotStore(pool).startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-12",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-12T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions: fundedAssumptions,
      });
      const accountId = randomUUID();
      const ledger = new PostgresFundedLedgerStore(pool);
      await ledger.create(accountId, [
        "CAD",
        1_005,
        "2099-02-12",
        "2099-02-12T14:30:00Z",
        500,
      ]);
      const adapter = new FundedLiveAdapter({
        pool,
        runId: run.id,
        accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions: fundedAssumptions,
      });
      await adapter.bind("2099-02-12", "2099-02-12T14:30:00Z", 1_005, 500);
      const observation = {
        id: randomUUID(),
        marketId: "CA_TSX" as const,
        runId: run.id,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId,
        symbol,
        profileId: randomUUID(),
        profileName: "R4",
        profileConfigId: randomUUID(),
        configVersion: "r4",
        profileParameters: {},
        strategyKey: "ORB_RETEST",
        strategyVersion: "1.0.0",
        signalTimestamp: "2099-02-12T14:30:01Z",
        score: 100,
        entryReference: 10,
        stopReference: 9.5,
        targetReference: 11,
        atr14: 1,
        featureSnapshot: {},
        reasonCodes: [],
        sourceEventPayload: {},
        eligibilityStatus: "ELIGIBLE" as const,
        eligibilityReason: null,
        createdAt: "2099-02-12T14:30:01Z",
      };
      await adapter.process({
        at: "2099-02-12T14:30:01Z",
        sessionDate: "2099-02-12",
        scheduledCloseAt: run.scheduledCloseAt,
        observations: [observation],
        invalidations: [],
        quotes: [
          {
            instrumentId,
            timestamp: "2099-02-12T14:30:02Z",
            bid: 9.99,
            ask: 10,
            bidSize: 100,
            askSize: 100,
            dataStatus: "REALTIME",
            actionable: true,
          },
        ],
      });
      expect((await ledger.read(accountId)).cash).toBe(0);
      expect(
        (await ledger.read(accountId)).positions[observation.id]?.shares,
      ).toBe(100);
      expect(
        (
          await pool.query(
            "SELECT fact->>'maximumDebit' AS maximum_debit FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
            [run.id, `funded-signal:${observation.id}`],
          )
        ).rows[0].maximum_debit,
      ).toBe("1005");
    });

    it("publishes close-pending recovery backlog across the account", async () => {
      const store = new PostgresPaperBotStore(pool);
      const prior = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-13",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-13T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        "CAD",
        2_000,
        "2099-02-13",
        "2099-02-13T14:30:00Z",
        500,
      ]);
      const priorService = new FundedOrderService(
        pool,
        prior.id,
        accountId,
        "CAD",
      );
      await priorService.bind();
      const priorOrder = {
        orderId: randomUUID(),
        signal: {
          ...signal,
          signalTimestamp: "2099-02-13T14:30:01Z",
        },
        assumptions: { ...assumptions, positionSize: 600 },
        submittedAt: "2099-02-13T14:30:01Z",
        expiresAt: "2099-02-13T14:35:00Z",
      };
      await priorService.submit(instrumentId, priorOrder, 600, 100);
      await priorService.quote(
        instrumentId,
        { ...quote, timestamp: "2099-02-13T14:30:02Z" },
        1,
        0,
      );
      await priorService.advanceClock("2099-02-13T21:00:00Z");

      const current = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-14",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-14T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const snapshot = await new FundedLiveAdapter({
        pool,
        runId: current.id,
        accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions,
      }).operationalSnapshot("2099-02-14T14:30:00Z");
      expect(snapshot.closePendingOrders).toBe(1);
      expect(snapshot.oldestClosePendingAgeMs).not.toBeNull();
    });

    it("recovers a funded inbox after effects commit but acknowledgement fails", async () => {
      const run = await new PostgresPaperBotStore(pool).startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-02",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-02T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      const ledger = new PostgresFundedLedgerStore(pool);
      await ledger.create(accountId, [
        "CAD",
        2000,
        "2099-02-02",
        signal.signalTimestamp,
        500,
      ]);
      await new FundedOrderService(pool, run.id, accountId, "CAD").bind();
      const adapter = new FundedFactAdapter(pool, run.id);
      const order = {
        orderId: randomUUID(),
        signal,
        assumptions,
        submittedAt: "2099-02-02T14:30:01Z",
        expiresAt: "2099-02-02T14:35:00Z",
      };
      const facts = [
        {
          id: "quote",
          fact: {
            type: "QUOTE" as const,
            instrumentId,
            quote: { ...quote, timestamp: "2099-02-02T14:30:03Z" },
            participation: 1,
            impactBps: 0,
          },
        },
        {
          id: "signal",
          fact: {
            type: "SIGNAL" as const,
            instrumentId,
            order,
            maximumDebit: 1000,
            maximumRisk: 100,
          },
        },
        {
          id: "veto",
          fact: {
            type: "SIGNAL" as const,
            instrumentId,
            order: {
              ...order,
              orderId: randomUUID(),
              submittedAt: "2099-02-02T14:30:02Z",
            },
            maximumDebit: 3000,
            maximumRisk: 100,
          },
        },
      ] as const;
      expect((await replayFundedFacts(pool, run.id, facts)).applied).toBe(
        false,
      );
      expect(
        (
          await pool.query("SELECT 1 FROM paper_funded_fact WHERE run_id=$1", [
            run.id,
          ])
        ).rows,
      ).toHaveLength(0);
      await adapter.enqueue(facts);
      await adapter.enqueue(facts);
      await adapter.enqueue([{ ...facts[0]!, id: "quote-alias" }]);
      await expect(
        adapter.enqueue([
          {
            ...facts[0]!,
            id: "quote-conflict-alias",
            fact: { ...facts[0]!.fact, participation: 0.5 },
          },
        ]),
      ).rejects.toThrow("Conflicting funded economic fact");
      await expect(
        adapter.enqueue([
          { ...facts[0]!, fact: { ...facts[0]!.fact, participation: 0.5 } },
        ]),
      ).rejects.toThrow("Conflicting funded fact retry");
      await pool.query(
        `CREATE FUNCTION audit_fail_funded_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected acknowledgement failure'; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER audit_fail_funded_ack BEFORE UPDATE ON paper_funded_fact FOR EACH ROW EXECUTE FUNCTION audit_fail_funded_ack()",
      );
      try {
        await expect(adapter.drain()).rejects.toThrow(
          "Injected acknowledgement failure",
        );
        expect((await ledger.read(accountId)).events).toHaveLength(1);
        const barrier = await pool.query(
          `SELECT inflight_fact_id,inflight_fact_at,inflight_priority,inflight_sort_key
           FROM paper_funded_run WHERE run_id=$1`,
          [run.id],
        );
        expect(barrier.rows[0]).toMatchObject({
          inflight_fact_id: "signal",
          inflight_priority: 2,
          inflight_sort_key: expect.any(String),
        });
        await adapter.enqueue([
          {
            id: "earlier-after-crash",
            fact: {
              ...facts[1]!.fact,
              order: {
                ...order,
                orderId: randomUUID(),
                submittedAt: "2099-02-02T14:30:00.500Z",
              },
            },
          },
        ]);
        expect(
          (
            await pool.query(
              "SELECT outcome FROM paper_funded_fact WHERE run_id=$1 AND fact_id='earlier-after-crash'",
              [run.id],
            )
          ).rows[0].outcome.status,
        ).toBe("LATE_FACT");
      } finally {
        await pool.query(
          "DROP TRIGGER audit_fail_funded_ack ON paper_funded_fact",
        );
        await pool.query("DROP FUNCTION audit_fail_funded_ack()");
      }
      await Promise.all([
        adapter.drain(),
        new FundedFactAdapter(pool, run.id).drain(),
      ]);
      const state = await ledger.read(accountId);
      expect(state.positions[order.orderId]?.shares).toBe(100);
      expect(
        state.events.filter((event) => event.type === "RESERVE"),
      ).toHaveLength(1);
      expect(
        (
          await pool.query(
            "SELECT outcome FROM paper_funded_fact WHERE run_id=$1 AND fact_id='veto'",
            [run.id],
          )
        ).rows[0].outcome.status,
      ).toBe("RISK_VETO");
      await adapter.enqueue([
        {
          id: "late",
          fact: {
            ...facts[1]!.fact,
            order: { ...order, orderId: randomUUID() },
          },
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT outcome FROM paper_funded_fact WHERE run_id=$1 AND fact_id='late'",
            [run.id],
          )
        ).rows[0].outcome.status,
      ).toBe("LATE_FACT");
      expect(await adapter.drain()).toBe(0);
      await replayFundedFacts(pool, run.id, facts, true);
      expect(await ledger.read(accountId)).toEqual(state);
    });

    it("restarts the funded live adapter through close-pending and retained-quote recovery", async () => {
      const store = new PostgresPaperBotStore(pool);
      const run = await store.startOrResumeLiveRun({
        source: "LIVE",
        marketId: "CA_TSX",
        sessionDate: "2099-02-05",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-05T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions: {
          ...assumptions,
          riskBudget: 100,
          maxNotional: 1_000,
        },
      });
      const accountId = randomUUID();
      const entryAt = "2099-02-05T14:30:00.000Z";
      const closeAt = "2099-02-05T21:00:00.000Z";
      const exitAt = "2099-02-05T21:00:01.000Z";
      const sourceObservation = await store.findObservationById(observationId);
      if (!sourceObservation) throw new Error("Audit observation missing");
      const observation = {
        ...sourceObservation,
        runId: run.id,
        signalTimestamp: entryAt,
        createdAt: entryAt,
      };
      const options = {
        pool,
        runId: run.id,
        accountId,
        currency: "CAD" as const,
        marketId: "CA_TSX" as const,
        assumptions: {
          ...run.assumptions,
          riskBudget: 100,
          maxNotional: 1_000,
        },
      };
      const first = new FundedLiveAdapter(options);
      await first.bind("2099-02-05", entryAt, 2_000, 500);
      await expect(
        first.process({
          at: entryAt,
          sessionDate: "2099-02-05",
          scheduledCloseAt: run.scheduledCloseAt,
          observations: [observation],
          invalidations: [],
          quotes: [
            {
              instrumentId,
              timestamp: entryAt,
              bid: 9.99,
              ask: 10,
              bidSize: 100,
              askSize: 100,
              sizeUnit: "SHARES",
              sizeMultiplier: 1,
              dataStatus: "REALTIME",
              actionable: true,
            },
          ],
        }),
      ).resolves.toMatchObject({ processed: 3, skippedObservations: 0 });

      // The observation is returned by every live cycle. Its second enqueue
      // must reuse the first durable submission timestamp and leave the order
      // unchanged instead of creating a conflicting fact.
      await expect(
        first.process({
          at: "2099-02-05T14:30:01.000Z",
          sessionDate: "2099-02-05",
          scheduledCloseAt: run.scheduledCloseAt,
          observations: [observation],
          invalidations: [],
          quotes: [],
        }),
      ).resolves.toMatchObject({ skippedObservations: 0 });

      await first.process({
        at: closeAt,
        sessionDate: "2099-02-05",
        scheduledCloseAt: run.scheduledCloseAt,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      await expect(first.operationalSnapshot(closeAt)).resolves.toMatchObject({
        closePendingOrders: 1,
      });

      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source,size_unit,size_multiplier)
       VALUES($1,$2,11,11.01,100,100,11,100,1000,10,11,9,0.01,0.1,false,false,'AUDIT_LIVE','SHARES',1)`,
        [instrumentId, exitAt],
      );
      const restarted = new FundedLiveAdapter(options);
      await restarted.bind("2099-02-05", entryAt, 2_000, 500);
      const retained = await restarted.retainedQuotes([instrumentId], exitAt);
      expect(retained).toHaveLength(1);
      await expect(
        restarted.process({
          at: exitAt,
          sessionDate: "2099-02-05",
          scheduledCloseAt: run.scheduledCloseAt,
          observations: [],
          invalidations: [],
          quotes: retained,
        }),
      ).resolves.toMatchObject({ processed: 2, skippedQuotes: 0 });
      await expect(
        restarted.operationalSnapshot(exitAt),
      ).resolves.toMatchObject({
        closePendingOrders: 0,
      });
      const order = await pool.query<{
        state: { execution?: { status?: string } };
      }>(
        "SELECT state FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [run.id, observation.id],
      );
      expect(order.rows[0]?.state.execution?.status).toBe("CLOSED");
      const facts = await pool.query<{ outcome: { status: string } }>(
        "SELECT outcome FROM paper_funded_fact WHERE run_id=$1 ORDER BY fact_at,priority,sort_key",
        [run.id],
      );
      expect(facts.rows).toHaveLength(7);
      expect(facts.rows.every((row) => row.outcome.status === "APPLIED")).toBe(
        true,
      );
    });

    it("recovers a prior close-pending funded run before binding the next session", async () => {
      const store = new PostgresPaperBotStore(pool);
      const prior = await store.startOrResumeLiveRun({
        source: "LIVE",
        marketId: "CA_TSX",
        sessionDate: "2099-02-06",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-06T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions: { ...assumptions, riskBudget: 100, maxNotional: 1_000 },
      });
      const accountId = randomUUID();
      const priorOptions = {
        pool,
        runId: prior.id,
        accountId,
        currency: "CAD" as const,
        marketId: "CA_TSX" as const,
        assumptions: {
          ...prior.assumptions,
          riskBudget: 100,
          maxNotional: 1_000,
        },
      };
      const old = new FundedLiveAdapter(priorOptions);
      await old.bind("2099-02-06", "2099-02-06T14:30:00Z", 2_000, 500);
      const source = await store.findObservationById(observationId);
      if (!source) throw new Error("Audit observation missing");
      const observed = {
        ...source,
        id: randomUUID(),
        runId: prior.id,
        signalTimestamp: "2099-02-06T14:30:00Z",
        createdAt: "2099-02-06T14:30:00Z",
      };
      await old.process({
        at: "2099-02-06T14:30:00Z",
        sessionDate: "2099-02-06",
        scheduledCloseAt: prior.scheduledCloseAt,
        observations: [observed],
        invalidations: [],
        quotes: [
          {
            instrumentId,
            timestamp: "2099-02-06T14:30:00Z",
            bid: 9.99,
            ask: 10,
            bidSize: 100,
            askSize: 100,
            sizeUnit: "SHARES",
            sizeMultiplier: 1,
            dataStatus: "REALTIME",
            actionable: true,
          },
        ],
      });
      await old.process({
        at: "2099-02-06T21:00:00Z",
        sessionDate: "2099-02-06",
        scheduledCloseAt: prior.scheduledCloseAt,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      const next = await store.startOrResumeLiveRun({
        source: "LIVE",
        marketId: "CA_TSX",
        sessionDate: "2099-02-07",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-07T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions: { ...assumptions, riskBudget: 100, maxNotional: 1_000 },
      });
      const nextAdapter = new FundedLiveAdapter({
        ...priorOptions,
        runId: next.id,
      });
      await expect(
        nextAdapter.bind("2099-02-07", "2099-02-07T14:30:00Z", 2_000, 500),
      ).rejects.toThrow("active run");
      const recoveryQuote = {
        timestamp: "2099-02-07T14:31:00Z",
        bid: 11,
        ask: 11.01,
        bidSize: 100,
        askSize: 100,
        sizeUnit: "SHARES",
        sizeMultiplier: 1,
        dataStatus: "REALTIME",
        actionable: true,
      };
      // Exercise the actual market-data orchestration, not a manually ordered
      // pair of adapter calls: it must finish the old account before binding.
      const service = Object.create(QuestradeDataService.prototype) as Record<
        string,
        any
      >;
      Object.assign(service, {
        paperBotRunId: next.id,
        paperBotStore: store,
        paperFundedAdapter: nextAdapter,
        paperFundedBound: false,
        paperFundedConfig: {
          pool,
          accountId,
          currency: "CAD",
          initialCash: 2_000,
          dailyLossLimit: 500,
        },
        paperFundedRecoveryAdapters: new Map(),
        paperBotSessionDate: "2099-02-07",
        paperBotScheduledCloseAt: next.scheduledCloseAt,
        instruments: [{ id: instrumentId }],
        clock: () => new Date("2099-02-07T14:31:00Z"),
        sessions: {
          getMarket: () => ({ startTime: new Date("2099-02-07T14:30:00Z") }),
        },
        logger: { info: () => undefined, error: () => undefined },
      });
      const recovered = await service.processFundedPaperBot(
        new Map([[instrumentId, recoveryQuote]]),
        [],
      );
      expect(recovered, service.paperBotLastError).toBe(true);
      expect(service.paperFundedBound).toBe(true);
      const rolled = await new PostgresFundedLedgerStore(pool).read(accountId);
      expect(rolled.positions).toEqual({});
      expect(rolled.session).toBe("2099-02-07");
      expect(rolled.openingEquity).toBe(rolled.cash);
      const binding = await pool.query(
        "SELECT clock_at FROM paper_funded_run WHERE run_id=$1",
        [next.id],
      );
      expect(binding.rows[0].clock_at.toISOString()).toBe(
        "2099-02-07T14:31:00.000Z",
      );
      // A current provider snapshot older than the rollover is durable late
      // evidence, not an out-of-order ledger event that poisons the inbox.
      await nextAdapter.process({
        at: "2099-02-07T14:32:00Z",
        sessionDate: "2099-02-07",
        scheduledCloseAt: next.scheduledCloseAt,
        observations: [],
        invalidations: [],
        quotes: [
          {
            ...recoveryQuote,
            instrumentId,
            timestamp: "2099-02-07T14:30:00Z",
            sizeUnit: "SHARES",
            dataStatus: "REALTIME",
          },
        ],
      });
      const late = await pool.query(
        "SELECT outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 AND fact->>'type'='QUOTE' AND fact_at='2099-02-07T14:30:00Z'",
        [next.id],
      );
      expect(late.rows[0].status).toBe("LATE_FACT");
    });

    it("replays retained historical inputs only with semantic and quote coverage", async () => {
      const store = new PostgresPaperBotStore(pool);
      const historicalAssumptions = {
        ...assumptions,
        riskBudget: 100,
        maxNotional: 1_000,
      };
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2099-02-02",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2099-02-02T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions: historicalAssumptions,
      });
      const sourceObservation = await store.findObservationById(observationId);
      if (!sourceObservation) throw new Error("Audit observation missing");
      const {
        id: _sourceObservationId,
        marketId: _sourceMarketId,
        createdAt: _sourceCreatedAt,
        ...observationInput
      } = sourceObservation;
      const historicalObservation = await store.insertObservation({
        ...observationInput,
        runId: run.id,
        sourceEventId: randomUUID(),
        setupInstanceId: randomUUID(),
        profileName: "Audit historical",
        sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
      });
      const accountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        "CAD",
        2_000,
        "2099-02-02",
        signal.signalTimestamp,
        500,
      ]);
      await new FundedOrderService(pool, run.id, accountId, "CAD").bind();

      const preview = await replayFundedHistoricalSession(pool, run.id);
      expect(preview).toMatchObject({
        applied: false,
        replayScope: "HISTORICAL_RETAINED_RAW",
        rawCoverageVerified: true,
        coverage: {
          observationCount: 1,
          quoteCount: 2,
          coveredObservationCount: 1,
          semanticVersions: ["setup-semantics-v2"],
        },
      });
      expect(preview.factCount).toBe(5);

      const applied = await replayFundedHistoricalSession(pool, run.id, true);
      expect(applied).toMatchObject({
        applied: true,
        processed: 5,
        rawCoverageVerified: true,
      });
      expect(applied.outcomes).toHaveLength(5);
      expect(
        (applied.outcomes as { outcome: { status: string } }[]).every(
          ({ outcome }) => outcome.status === "APPLIED",
        ),
      ).toBe(true);
      expect(
        (await new PostgresFundedLedgerStore(pool).read(accountId)).positions,
      ).toEqual({});
      expect(historicalObservation.created).toBe(true);
    });

    it("keeps distinct signal semantics in separate reported cohorts", async () => {
      const copiedId = randomUUID();
      await pool.query(
        `INSERT INTO paper_signal_observation
        SELECT (jsonb_populate_record(NULL::paper_signal_observation, to_jsonb(o) || jsonb_build_object(
          'id',$2::text,'source_event_id',$3::text,'setup_instance_id',$4::text,
          'source_event_payload',jsonb_build_object('signalSemanticsVersion','test-semantics-next')))).*
        FROM paper_signal_observation o WHERE id=$1`,
        [observationId, copiedId, randomUUID(), randomUUID()],
      );
      try {
        const aggregates = await new PostgresPaperEvidenceStore(
          pool,
        ).aggregates({
          marketId: "CA_TSX",
          executionModelVersion: "paper-execution-v6",
          startDate: "2099-02-02",
          endDate: "2099-02-02",
        });
        expect(
          aggregates.some(
            (aggregate) =>
              aggregate.cohort.signalSemanticsVersion === "test-semantics-next",
          ),
        ).toBe(true);
        expect(
          aggregates.some(
            (aggregate) =>
              aggregate.cohort.signalSemanticsVersion === "UNKNOWN",
          ),
        ).toBe(true);
        expect(
          aggregates.every(
            (aggregate) =>
              aggregate.cohort.marketId === "CA_TSX" &&
              aggregate.cohort.currency === "UNKNOWN" &&
              aggregate.cohort.replayScope === "UNKNOWN",
          ),
        ).toBe(true);
      } finally {
        await pool.query("DELETE FROM paper_signal_observation WHERE id=$1", [
          copiedId,
        ]);
      }
    });

    it("executes all cohort SQL and upgrades every active version guard", async () => {
      const report = await new EvidenceCohortService(pool).auditCohorts();
      expect(report.currentAuthoritativeVersion).toBe(
        AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      );
      const guards =
        await pool.query(`SELECT prosrc FROM pg_proc WHERE proname IN
      ('require_authoritative_statistical_evidence','require_authoritative_profile_evidence','require_authoritative_calibration_source','require_authoritative_ranking_study','require_ranking_activation_evidence')`);
      expect(guards.rowCount).toBe(5);
      for (const guard of guards.rows) {
        expect(guard.prosrc).toContain("paper-execution-v7");
        expect(guard.prosrc).not.toContain("paper-execution-v1");
      }
    });

    it("rolls back the decision when position insertion fails, then retries exactly once", async () => {
      const store = new PostgresPaperCoordinationStore(pool);
      await expect(
        store.recordDecision({
          ...decisionInput,
          initialPosition: {
            ...decisionInput.initialPosition!,
            observationId: randomUUID(),
          },
        }),
      ).rejects.toThrow();
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_coordination_decision WHERE run_id=$1",
            [sourceRunId],
          )
        ).rows[0].count,
      ).toBe(0);
      await store.recordDecision(decisionInput);
      await store.recordDecision(decisionInput);
      expect((await store.findOpenPositions(sourceRunId)).length).toBe(1);
      const historical = await store.stateForSymbol(
        sourceRunId,
        symbol,
        "2099-02-02T13:00:00Z",
        instrumentId,
      );
      expect(historical.openPositionCount).toBe(0);
      expect(historical.openSectorNotional).toBe(0);
    });

    it("round-trips partial-fill state without losing quantity or timing", async () => {
      const store = new PostgresPaperExecutionStore(pool);
      const initial = createQuoteExecution(signal, quote, assumptions);
      const partial = applyQuoteFact(
        initial,
        {
          ...quote,
          timestamp: "2099-02-02T14:31:00Z",
          bid: 11,
          ask: 11.01,
          bidSize: 25,
        },
        assumptions,
      ).state;
      await store.upsertQuoteExecution(observationId, partial);
      const restored = (await store.findOpenAndClosePending(sourceRunId))[0]
        ?.executionState;
      expect(restored).toEqual(JSON.parse(JSON.stringify(partial)));
    });

    it("persists replacement evidence atomically and reuses the same request", async () => {
      const service = new EvidenceRegenerationService(pool);
      const preview = await service.run(sourceRunId);
      expect(preview).toMatchObject({
        applied: false,
        report: { reproducibility: "REPRODUCIBLE", closedQuoteCount: 1 },
      });
      const [applied, concurrent] = await Promise.all([
        service.run(sourceRunId, true),
        service.run(sourceRunId, true),
      ]);
      expect(applied).toHaveProperty("replacementRunId");
      expect(concurrent).toHaveProperty(
        "replacementRunId",
        (applied as { replacementRunId: string }).replacementRunId,
      );
      const again = await service.run(sourceRunId, true);
      expect(again).toMatchObject({
        reused: true,
        replacementRunId: (applied as { replacementRunId: string })
          .replacementRunId,
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM paper_evidence_regeneration WHERE source_run_id=$1",
            [sourceRunId],
          )
        ).rows[0].count,
      ).toBe(1);
    });

    it("reruns corrected strategy detection from retained raw inputs", async () => {
      let replayPayload:
        | {
            sessions: Array<{ quotes: unknown[]; candles: unknown[] }>;
          }
        | undefined;
      const engine = {
        runBacktestSignals: async (payload: unknown) => {
          replayPayload = payload as {
            sessions: Array<{ quotes: unknown[]; candles: unknown[] }>;
          };
          const event = {
            eventId: randomUUID(),
            eventType: "STRATEGY_STATE_CHANGED",
            kind: "SETUP",
            marketId: "CA_TSX",
            instrumentId,
            symbol,
            timestamp: signal.signalTimestamp,
            profileId: randomUUID(),
            profileName: "Corrected Audit",
            strategy: "ORB_RETEST",
            strategyVersion: "1.0.0",
            configVersion: "audit-test",
            state: "READY",
            previousState: "FORMING",
            score: 100,
            setupScore: 100,
            scoreVersion: "setup-score-v1",
            scoreComponents: {},
            scoreExplanation: [],
            setupInstanceId: randomUUID(),
            reasonCodes: [],
            entryReference: 10,
            stopReference: 9.5,
            targetReference: 11,
            estimatedRr: 2,
            signalSemanticsVersion: "setup-semantics-v2",
            stopPolicy: "HYBRID",
            patternStopReference: null,
            stopSelectionReason: null,
            featureSnapshot: { atr14: 1 },
          } as unknown as StrategyStateEvent;
          return {
            events: [event],
            dataQuality: {
              quoteSnapshots: 2,
              candles: 1,
              sessions: 1,
              spread: "CAPTURED",
              warnings: [],
            },
          };
        },
      };
      const service = new EvidenceRegenerationService(pool, engine);
      const preview = await service.run(
        sourceRunId,
        false,
        "CORRECTED_STRATEGY",
      );
      expect(preview).toMatchObject({
        applied: false,
        mode: "CORRECTED_STRATEGY",
        report: {
          evidenceScope: "CORRECTED_STRATEGY_REGENERATION",
          correctedReadyCount: 1,
          rawCoverageVerified: true,
        },
      });
      expect(replayPayload?.sessions[0]?.quotes).toHaveLength(2);
      expect(replayPayload?.sessions[0]?.candles).toHaveLength(2);
      const applied = await service.run(
        sourceRunId,
        true,
        "CORRECTED_STRATEGY",
      );
      expect(applied).toMatchObject({
        applied: true,
        mode: "CORRECTED_STRATEGY",
        report: { correctedReadyCount: 1 },
      });
      const reused = await service.run(sourceRunId, true, "CORRECTED_STRATEGY");
      expect(reused).toMatchObject({
        reused: true,
        replacementRunId: (applied as { replacementRunId: string })
          .replacementRunId,
      });
    });
  },
);
