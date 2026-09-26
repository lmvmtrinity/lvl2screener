import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReplayInputSnapshot } from "@tsx-scanner/contracts";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

function replayInput(
  marketId: "CA_TSX" | "US_EQUITIES",
  instrumentId: string,
  symbol: string,
): ReplayInputSnapshot {
  return {
    version: "replay-input-v1",
    marketId,
    resolvedAt: "2026-09-22T00:00:00.000Z",
    inputHash: "0".repeat(64),
    requestedSymbols: [symbol],
    candidateInstruments: [{ instrumentId, symbol, sector: null }],
    benchmarks: [],
    universeRefreshRunId: null,
    capturedHistoryAvailability: {
      source: "CAPTURED_QUOTES",
      observedAt: "2026-09-22T00:00:00.000Z",
      tables: {
        quoteSnapshot: {
          earliest: "2026-01-01T00:00:00.000Z",
          latest: "2035-12-31T23:59:59.000Z",
        },
        candle: { earliest: null, latest: null },
      },
      replay: { earliestDate: "2026-01-01", latestDate: "2035-12-31" },
    },
    warnings: [],
    candidateProvenance: "CURRENT_ACTIVE_UNIVERSE",
    sessions: [],
  };
}

async function insertQuote(
  pool: Pool,
  instrumentId: string,
  timestamp: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO quote_snapshot(
       instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,
       day_open,day_high,day_low,spread_absolute,spread_pct,is_delayed,is_halted,source
     ) VALUES($1,$2,10,10.01,1000,1000,10,100,10000,10,11,9,0.01,0.1,false,false,'QUESTRADE')`,
    [instrumentId, timestamp],
  );
}

async function insertMembershipRun(
  pool: Pool,
  instrumentId: string,
  symbol: string,
  sessionDate: string,
  completedAt: string,
): Promise<void> {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO universe_refresh_run(
       id,market_id,provider,policy_version,policy,status,started_at,completed_at,
       discovered_count,eligible_count
     ) VALUES($1,'CA_TSX','FIXTURE','calendar-fixture','{}','COMPLETED',$2,$3,1,1)`,
    [runId, completedAt, completedAt],
  );
  await pool.query(
    `INSERT INTO universe_membership(
       run_id,instrument_id,symbol,description,exchange,eligible,reasons,metrics_as_of
     ) VALUES($1,$2,$3,'calendar fixture','TSX',true,'[]',$4)`,
    [runId, instrumentId, symbol, `${sessionDate}T12:00:00Z`],
  );
}

describe.skipIf(!url)(
  "normal replay date discovery respects published market sessions",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: url });
      await migrate(pool);
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("excludes proven closures but preserves supported and uncovered dates per market", async () => {
      const [caInstrument] = await new PostgresMarketDataRepository(
        pool,
      ).upsertInstruments(
        [
          {
            symbolId: 2300000000 + Math.floor(Math.random() * 10000000),
            symbol: `CAL_CA_${randomUUID().slice(0, 8)}.TO`,
            description: "calendar date discovery fixture",
            securityType: "Stock",
            exchange: "TSX",
            currency: "CAD",
            isQuotable: true,
            isTradable: true,
          },
        ],
        "CA_TSX",
      );
      const [usInstrument] = await new PostgresMarketDataRepository(
        pool,
      ).upsertInstruments(
        [
          {
            symbolId: 2400000000 + Math.floor(Math.random() * 10000000),
            symbol: `CAL_US_${randomUUID().slice(0, 8)}.US`,
            description: "calendar date discovery fixture",
            securityType: "Stock",
            exchange: "NASDAQ",
            currency: "USD",
            isQuotable: true,
            isTradable: true,
          },
        ],
        "US_EQUITIES",
      );

      await Promise.all([
        // CA: Saturday and Labour Day are proven closures; Monday is a valid session.
        insertQuote(pool, caInstrument!.id, "2026-09-12T14:00:00.000Z"),
        insertQuote(pool, caInstrument!.id, "2026-09-07T14:00:00.000Z"),
        insertQuote(pool, caInstrument!.id, "2026-09-14T14:00:00.000Z"),
        // 2035 is outside the retained published calendar and must remain for fail-closed evidence.
        insertQuote(pool, caInstrument!.id, "2035-09-12T14:00:00.000Z"),
        // US: Thanksgiving is a proven closure; the Friday early-close is a valid session.
        insertQuote(pool, usInstrument!.id, "2026-11-26T14:00:00.000Z"),
        insertQuote(pool, usInstrument!.id, "2026-11-27T17:00:00.000Z"),
        insertQuote(pool, usInstrument!.id, "2026-11-28T14:00:00.000Z"),
        insertQuote(pool, usInstrument!.id, "2035-11-28T14:00:00.000Z"),
      ]);

      const store = new PostgresBacktestStore(pool);
      const caDates = await store.loadReplaySessionDates(
        {
          marketId: "CA_TSX",
          startDate: "2026-09-07",
          endDate: "2035-09-12",
        } as never,
        replayInput("CA_TSX", caInstrument!.id, caInstrument!.symbol),
      );
      const usDates = await store.loadReplaySessionDates(
        {
          marketId: "US_EQUITIES",
          startDate: "2026-11-26",
          endDate: "2035-11-28",
        } as never,
        replayInput("US_EQUITIES", usInstrument!.id, usInstrument!.symbol),
      );

      expect(caDates).toEqual(["2026-09-14", "2035-09-12"]);
      expect(usDates).toEqual(["2026-11-27", "2035-11-28"]);
      expect(caDates).not.toContain("2026-09-12");
      expect(caDates).not.toContain("2026-09-07");
      expect(usDates).not.toContain("2026-11-26");
      expect(usDates).not.toContain("2026-11-28");
      expect(caDates).not.toContain("2026-11-27");
      expect(usDates).not.toContain("2026-09-14");
    });

    it("keeps pre-publication closures UNKNOWN and shares scope with historical membership planning", async () => {
      const [instrument] = await new PostgresMarketDataRepository(
        pool,
      ).upsertInstruments(
        [
          {
            symbolId: 2500000000 + Math.floor(Math.random() * 10000000),
            symbol: `CAL_CUTOFF_${randomUUID().slice(0, 8)}.TO`,
            description: "calendar cutoff fixture",
            securityType: "Stock",
            exchange: "TSX",
            currency: "CAD",
            isQuotable: true,
            isTradable: true,
          },
        ],
        "CA_TSX",
      );
      await insertQuote(pool, instrument!.id, "2026-09-07T14:00:00.000Z");
      await insertQuote(pool, instrument!.id, "2026-09-14T14:00:00.000Z");
      await insertMembershipRun(
        pool,
        instrument!.id,
        instrument!.symbol,
        "2026-09-07",
        "2026-09-04T12:00:00Z",
      );
      await insertMembershipRun(
        pool,
        instrument!.id,
        instrument!.symbol,
        "2026-09-14",
        "2026-09-12T12:00:00Z",
      );

      const store = new PostgresBacktestStore(pool);
      const lateInput = {
        marketId: "CA_TSX" as const,
        startDate: "2026-09-07",
        endDate: "2026-09-14",
        symbols: [],
      };
      const latePlan = await store.resolveReplayCandidatePlan(lateInput);
      const lateCursorDates = await store.loadReplaySessionDates(
        lateInput as never,
        replayInput("CA_TSX", instrument!.id, instrument!.symbol),
      );
      expect(latePlan.sessions.map((session) => session.sessionDate)).toEqual([
        "2026-09-14",
      ]);
      expect(lateCursorDates).toEqual(["2026-09-14"]);

      const earlyInput = {
        ...lateInput,
        endDate: "2026-09-10",
      };
      const earlyPlan = await store.resolveReplayCandidatePlan(earlyInput);
      const earlyCursorDates = await store.loadReplaySessionDates(
        earlyInput as never,
        replayInput("CA_TSX", instrument!.id, instrument!.symbol),
      );
      expect(earlyPlan.sessions.map((session) => session.sessionDate)).toEqual([
        "2026-09-07",
      ]);
      expect(earlyCursorDates).toEqual(["2026-09-07"]);
    });
  },
);
