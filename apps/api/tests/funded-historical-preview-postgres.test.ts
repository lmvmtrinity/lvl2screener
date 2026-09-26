import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/database/migrate.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import {
  historicalFundedAccountId,
  historicalMarketRisk,
} from "../src/paper-bot/funded-historical-config.js";
import { planFundedHistoricalSession } from "../src/paper-bot/funded-historical-preview.js";
import { provisionHistoricalFundedRun } from "../src/paper-bot/funded-historical-provisioning.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const marketId = "CA_TSX" as const;
const sessionA = "2026-08-31";
const sessionB = "2026-09-01";
const symbol = "FP04PREVIEW.TO";

function replayInput(sessions: readonly string[]) {
  return {
    version: "replay-input-v1",
    marketId,
    resolvedAt: "2026-09-10T00:00:00.000Z",
    requestedSymbols: [],
    candidateInstruments: [{ instrumentId: "", symbol, sector: null }],
    benchmarks: [
      {
        instrumentId: "",
        symbol: "XIU.TO",
        sector: null,
        kind: "MARKET",
        benchmarkSector: null,
      },
    ],
    universeRefreshRunId: null,
    capturedHistoryAvailability: {
      source: "CAPTURED_QUOTES",
      observedAt: "2026-09-10T00:00:00.000Z",
      tables: {
        quoteSnapshot: { earliest: null, latest: null },
        candle: { earliest: null, latest: null },
      },
      replay: { earliestDate: sessionA, latestDate: sessionB },
    },
    warnings: [],
    sessions: sessions.map((sessionDate) => ({
      sessionDate,
      resolution: "RESOLVED",
      membershipRunId: null,
      effectiveAt: null,
      candidates: [{ instrumentId: "", symbol, sector: null }],
      reasonCodes: [],
    })),
    inputHash: "a".repeat(64),
  };
}

describe.skipIf(!databaseUrl)(
  "funded historical preview against isolated PostgreSQL",
  () => {
    let pool: Pool;
    let store: PostgresBacktestStore;
    let instrumentId: string;
    let benchmarkId: string;
    const config = loadConfig({});

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      await pool.query(
        `TRUNCATE
           funded_decision_outcome,
           funded_decision_intent,
           funded_decision_refusal,
           funded_decision_evidence,
           paper_funded_fact,
           paper_funded_event,
           paper_entry_order,
           paper_funded_run,
           paper_funded_account,
           paper_signal_observation,
           paper_bot_run,
           backtest_run,
           quote_snapshot,
           instrument
         CASCADE`,
      );
      store = new PostgresBacktestStore(pool);
      instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,
           currency,security_type,industry_sector,is_quotable,is_tradable,active,
           market_id)
         VALUES($1,1987654399,$2,'FP04 preview fixture','TSX','CAD','Stock',
           'Technology',true,true,true,$3)`,
        [instrumentId, symbol, marketId],
      );
      for (const sessionDate of [sessionA, sessionB])
        await pool.query(
          `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,
             ask_size,last,last_size,day_volume,day_open,day_high,day_low,
             spread_absolute,spread_pct,is_delayed,is_halted,source)
           VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,
             false,false,'FP04_PREVIEW')
           ON CONFLICT DO NOTHING`,
          [instrumentId, `${sessionDate}T14:30:00.000Z`],
        );
      benchmarkId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,
           currency,security_type,industry_sector,is_quotable,is_tradable,active,
           market_id)
         VALUES($1,1987654398,'XIU.TO','FP04 preview benchmark','TSX','CAD','ETF',
           'Financial Services',true,true,true,$2)`,
        [benchmarkId, marketId],
      );
      for (const sessionDate of [sessionA, sessionB])
        await pool.query(
          `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,
             ask_size,last,last_size,day_volume,day_open,day_high,day_low,
             spread_absolute,spread_pct,is_delayed,is_halted,source)
           VALUES($1,$2,29.99,30,1000,1000,29.99,1000,1000,30,31,29,0.01,0.1,
             false,false,'FP04_PREVIEW')
           ON CONFLICT DO NOTHING`,
          [benchmarkId, `${sessionDate}T14:30:00.000Z`],
        );
    });

    afterAll(async () => {
      await pool?.end();
    });

    async function seedBacktestRun(
      status: "COMPLETED" | "RUNNING",
      sessions: readonly string[],
      withReplayInput = true,
    ): Promise<string> {
      const id = randomUUID();
      const input = replayInput(sessions);
      input.candidateInstruments[0]!.instrumentId = instrumentId;
      input.benchmarks[0]!.instrumentId = benchmarkId;
      for (const session of input.sessions)
        session.candidates[0]!.instrumentId = instrumentId;
      await pool.query(
        `INSERT INTO backtest_run(id,market_id,name,status,start_date,end_date,
           strategies,symbols,data_source,strategy_version,config_version,
           execution_model_version,starting_capital,position_size,slippage_bps,
           fee_per_trade,parameters,metrics,analyses,data_quality,replay_input,
           completed_at)
         VALUES($1,$2,'fp04 preview fixture',$3,$4,$5,$6::jsonb,$7::jsonb,
           'CAPTURED_QUOTES','2026-09-01','config-1','execution-v1',25000,1000,
           2,1,'{}'::jsonb,$11::jsonb,'[]'::jsonb,$10::jsonb,
           $8::jsonb,$9)`,
        [
          id,
          marketId,
          status,
          sessionA,
          sessionB,
          JSON.stringify(["ORB_RETEST"]),
          JSON.stringify([symbol]),
          withReplayInput ? JSON.stringify(input) : null,
          status === "COMPLETED" ? "2026-09-10T20:30:00.000Z" : null,
          JSON.stringify({
            quoteSnapshots: 0,
            candles: 0,
            sessions: 1,
            spread: "UNAVAILABLE",
            warnings: [],
          }),
          JSON.stringify({
            signalsGenerated: 0,
            readySignals: 0,
            tradesSimulated: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            averageWin: 0,
            averageLoss: 0,
            averageR: 0,
            medianR: 0,
            profitFactor: null,
            expectancy: 0,
            netPnl: 0,
            maximumDrawdown: 0,
            maximumDrawdownPct: 0,
            falseBreakoutRate: 0,
            signalToTradeConversion: 0,
            averageHoldMinutes: 0,
          }),
        ],
      );
      return id;
    }

    async function fundedCounts() {
      const result = await pool.query<{ table_name: string; count: string }>(
        `SELECT 'paper_funded_account' AS table_name,count(*)::text AS count FROM paper_funded_account
         UNION ALL SELECT 'paper_funded_run',count(*)::text FROM paper_funded_run
         UNION ALL SELECT 'paper_bot_run',count(*)::text FROM paper_bot_run
         UNION ALL SELECT 'paper_signal_observation',count(*)::text FROM paper_signal_observation
         UNION ALL SELECT 'paper_entry_order',count(*)::text FROM paper_entry_order
         UNION ALL SELECT 'paper_funded_event',count(*)::text FROM paper_funded_event
         UNION ALL SELECT 'paper_funded_fact',count(*)::text FROM paper_funded_fact
         UNION ALL SELECT 'funded_decision_evidence',count(*)::text FROM funded_decision_evidence
         ORDER BY table_name`,
      );
      return Object.fromEntries(
        result.rows.map((row) => [row.table_name, row.count]),
      );
    }

    it("plans a completed session without writing any funded state", async () => {
      const runId = await seedBacktestRun("COMPLETED", [sessionA]);
      const before = await fundedCounts();
      const preview = await planFundedHistoricalSession(
        { backtestRunId: runId },
        { pool, config, store },
      );
      expect(preview).toMatchObject({
        backtestRunId: runId,
        mode: "PREVIEW",
        effectFree: true,
        applied: false,
        writesPerformed: false,
        marketId,
        currency: "CAD",
        accountExists: false,
        sessionCount: 1,
        multiSession: false,
        requiresApply: true,
      });
      expect(preview.plannedSessions).toEqual([
        expect.objectContaining({
          sessionDate: sessionA,
          existingRunId: null,
          existingRunStatus: null,
          reusableRun: false,
        }),
      ]);
      expect(preview.accountId).toBe(
        historicalFundedAccountId(
          marketId,
          historicalMarketRisk(config, marketId).initialCash,
          historicalMarketRisk(config, marketId).dailyLossLimit,
        ),
      );
      const again = await planFundedHistoricalSession(
        { backtestRunId: runId },
        { pool, config, store },
      );
      expect(again).toEqual(preview);
      expect(await fundedCounts()).toEqual(before);
    });

    it("reports an existing reusable run without mutating it", async () => {
      const runId = await seedBacktestRun("COMPLETED", [sessionA]);
      const risk = historicalMarketRisk(config, marketId);
      const accountId = historicalFundedAccountId(
        marketId,
        risk.initialCash,
        risk.dailyLossLimit,
      );
      const provisioned = await provisionHistoricalFundedRun(pool, {
        marketId,
        sessionDate: sessionA,
        sessionTimezone: risk.timezone,
        scheduledCloseAt: `${sessionA}T20:00:00.000Z`,
        sessionStartAt: `${sessionA}T13:30:00.000Z`,
        assumptions: {
          positionSize: 1_000,
          slippageBps: 2,
          feePerTrade: 1,
          stopMethod: "STRUCTURAL",
          atrStopMultiple: 1,
          rewardRiskRatio: null,
          maxQuoteAgeSeconds: 30,
          sessionTimezone: risk.timezone,
          noonCloseTime: "16:00",
          riskBudget: 250,
          maxNotional: 1_500,
        },
        policy: fundedPolicy(0.25, 0),
        accountId,
        currency: "CAD",
        initialCash: risk.initialCash,
        dailyLossLimit: risk.dailyLossLimit,
      });
      const before = await fundedCounts();
      const preview = await planFundedHistoricalSession(
        { backtestRunId: runId },
        { pool, config, store },
      );
      expect(preview.accountExists).toBe(true);
      expect(preview.plannedSessions[0]).toMatchObject({
        existingRunId: provisioned.runId,
        existingRunStatus: "RUNNING",
        reusableRun: true,
      });
      expect(await fundedCounts()).toEqual(before);
    });

    it("plans multiple sessions and refuses ineligible runs", async () => {
      const multi = await seedBacktestRun("COMPLETED", [sessionA, sessionB]);
      const preview = await planFundedHistoricalSession(
        { backtestRunId: multi },
        { pool, config, store },
      );
      expect(preview.sessionCount).toBe(2);
      expect(preview.multiSession).toBe(true);
      expect(
        preview.plannedSessions.map((session) => session.sessionDate),
      ).toEqual([sessionA, sessionB]);

      const running = await seedBacktestRun("RUNNING", [sessionA]);
      await expect(
        planFundedHistoricalSession(
          { backtestRunId: running },
          { pool, config, store },
        ),
      ).rejects.toThrow(/COMPLETED backtest run/);
      const noInput = await seedBacktestRun("COMPLETED", [sessionA], false);
      await expect(
        planFundedHistoricalSession(
          { backtestRunId: noInput },
          { pool, config, store },
        ),
      ).rejects.toThrow(/immutable replay input/);
      await expect(
        planFundedHistoricalSession(
          { backtestRunId: randomUUID() },
          { pool, config, store },
        ),
      ).rejects.toThrow(/COMPLETED backtest run/);
    });
  },
);
