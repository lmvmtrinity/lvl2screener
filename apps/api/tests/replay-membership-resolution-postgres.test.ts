import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateBacktest } from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

describe.skipIf(!url)("historical replay membership resolution", () => {
  let pool: Pool;
  let candidateA: { id: string; symbol: string };
  let laterCandidate: { id: string; symbol: string };
  let benchmark: { id: string; symbol: string };
  const runIds: string[] = [];
  const instrumentIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
    const repository = new PostgresMarketDataRepository(pool);
    const suffix = randomUUID().slice(0, 8);
    const [first, second, market] = await repository.upsertInstruments(
      [
        {
          symbolId: 3100000000 + Math.floor(Math.random() * 1000000),
          symbol: `MEM_A_${suffix}`,
          description: "membership fixture A",
          securityType: "Stock",
          exchange: "NASDAQ",
          currency: "USD",
          isQuotable: true,
          isTradable: true,
        },
        {
          symbolId: 3200000000 + Math.floor(Math.random() * 1000000),
          symbol: `MEM_C_${suffix}`,
          description: "membership fixture C",
          securityType: "Stock",
          exchange: "NASDAQ",
          currency: "USD",
          isQuotable: true,
          isTradable: true,
        },
        {
          symbolId: 3300000000 + Math.floor(Math.random() * 1000000),
          symbol: `MEM_BMK_${suffix}`,
          description: "membership benchmark",
          securityType: "Stock",
          exchange: "NASDAQ",
          currency: "USD",
          isQuotable: true,
          isTradable: true,
        },
      ],
      "US_EQUITIES",
    );
    candidateA = { id: first!.id, symbol: first!.symbol };
    laterCandidate = { id: second!.id, symbol: second!.symbol };
    benchmark = { id: market!.id, symbol: market!.symbol };
    instrumentIds.push(candidateA.id, laterCandidate.id, benchmark.id);
    await pool.query(
      `UPDATE instrument SET benchmark_kind='MARKET' WHERE id=$1`,
      [benchmark.id],
    );

    for (const session of ["2026-09-08", "2026-09-09"]) {
      for (const instrument of [candidateA, laterCandidate, benchmark]) {
        await pool.query(
          `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,spread_absolute,spread_pct,is_delayed,is_halted,source)
           VALUES($1,$2,10,10.01,1000,1000,10,100,10000,10,11,9,0.01,0.1,false,false,'QUESTRADE')`,
          [instrument.id, `${session}T14:00:00Z`],
        );
      }
    }

    const zeroDiscoveryRun = randomUUID();
    runIds.push(zeroDiscoveryRun);
    await pool.query(
      `INSERT INTO universe_refresh_run(id,market_id,provider,policy_version,policy,status,started_at,completed_at,discovered_count,eligible_count)
       VALUES($1,'US_EQUITIES','FIXTURE','fixture','{}','COMPLETED','2026-09-08T11:00:00Z','2026-09-08T11:00:30Z',0,0)`,
      [zeroDiscoveryRun],
    );
    const firstRun = randomUUID();
    runIds.push(firstRun);
    await pool.query(
      `INSERT INTO universe_refresh_run(id,market_id,provider,policy_version,policy,status,started_at,completed_at,discovered_count,eligible_count)
       VALUES($1,'US_EQUITIES','FIXTURE','fixture','{}','COMPLETED','2026-09-08T12:00:00Z','2026-09-08T12:00:30Z',1,1)`,
      [firstRun],
    );
    await pool.query(
      `INSERT INTO universe_membership(run_id,instrument_id,symbol,description,exchange,eligible,reasons,metrics_as_of)
       VALUES($1,$2,$3,'fixture','NASDAQ',true,'[]','2026-09-08T12:00:00Z')`,
      [firstRun, candidateA.id, candidateA.symbol],
    );
    const laterRun = randomUUID();
    runIds.push(laterRun);
    await pool.query(
      `INSERT INTO universe_refresh_run(id,market_id,provider,policy_version,policy,status,started_at,completed_at,discovered_count,eligible_count)
       VALUES($1,'US_EQUITIES','FIXTURE','fixture','{}','COMPLETED','2026-09-09T20:00:00Z','2026-09-09T20:00:30Z',1,1)`,
      [laterRun],
    );
    await pool.query(
      `INSERT INTO universe_membership(run_id,instrument_id,symbol,description,exchange,eligible,reasons,metrics_as_of)
       VALUES($1,$2,$3,'fixture','NASDAQ',true,'[]','2026-09-09T20:00:00Z')`,
      [laterRun, laterCandidate.id, laterCandidate.symbol],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    // This file's fixtures must not leak into later files in a shared
    // acceptance database (market-wide benchmark and refresh-run queries).
    await pool.query(
      "DELETE FROM universe_membership WHERE run_id=ANY($1::uuid[])",
      [runIds],
    );
    await pool.query(
      "DELETE FROM universe_refresh_run WHERE id=ANY($1::uuid[])",
      [runIds],
    );
    await pool.query(
      "DELETE FROM quote_snapshot WHERE instrument_id=ANY($1::uuid[])",
      [instrumentIds],
    );
    await pool.query("DELETE FROM instrument WHERE id=ANY($1::uuid[])", [
      instrumentIds,
    ]);
    await pool.end();
  });

  function input(): CreateBacktest {
    return {
      name: "membership resolution",
      marketId: "US_EQUITIES",
      startDate: "2026-09-08",
      endDate: "2026-09-09",
      strategies: ["ORB_RETEST"],
      symbols: [],
      dataSource: "CAPTURED_QUOTES",
      startingCapital: 100_000,
      positionSize: 10_000,
      slippageBps: 2,
      feePerTrade: 9.95,
      parameters: {
        rvolAtTimeMin: 1.5,
        spreadHardMaxPct: 0.25,
        atrPctMin: 0,
        breakoutVolumeRatioMin: 1.5,
        retestTolerancePct: 0.15,
        scoreCutoff: 0,
        breakoutBufferPct: 0.05,
        relativeStrengthMinPct: 0.5,
        flagpoleMinAtr: 0.5,
        flagRetracementMaxPct: 50,
        setupTimeoutMinutes: 20,
        consolidationBarsMin: 3,
        consolidationRangeMaxPct: 0.75,
        flagDurationBarsMin: 1,
        flagDurationBarsMax: 2,
        flagpoleMinSlopeAtrPerBar: 0,
        volumeContractionMaxPct: 100,
      },
    };
  }

  it("resolves each session from membership effective before that session open", async () => {
    const store = new PostgresBacktestStore(pool);
    const availability =
      await store.getCapturedHistoryAvailability("US_EQUITIES");
    const snapshot = await store.resolveReplayInput(input(), availability);

    expect(snapshot.candidateProvenance).toBe("HISTORICAL_MEMBERSHIP");
    expect(snapshot.sessions).toHaveLength(2);
    const first = snapshot.sessions[0]!;
    const second = snapshot.sessions[1]!;
    expect(first).toMatchObject({
      sessionDate: "2026-09-08",
      resolution: "RESOLVED",
    });
    expect(first.candidates.map((value) => value.symbol)).toEqual([
      candidateA.symbol,
    ]);
    // The 2026-09-09T20:00Z run completed after the 09-09 open and must not
    // retroactively change that session's candidates.
    expect(second).toMatchObject({
      sessionDate: "2026-09-09",
      resolution: "RESOLVED",
      membershipRunId: first.membershipRunId,
    });
    expect(second.candidates.map((value) => value.symbol)).toEqual([
      candidateA.symbol,
    ]);
    expect(snapshot.candidateInstruments.map((value) => value.symbol)).toEqual([
      candidateA.symbol,
    ]);
  });

  it("loads a session with only that session's candidates and keeps benchmarks separate", async () => {
    const store = new PostgresBacktestStore(pool);
    const availability =
      await store.getCapturedHistoryAvailability("US_EQUITIES");
    const snapshot = await store.resolveReplayInput(input(), availability);
    const policy = {
      marketId: "US_EQUITIES" as const,
      timezone: "America/New_York" as const,
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:30", end: "16:00" },
      entries: {
        preferredStart: "09:45",
        preferredEnd: "11:30",
        hardEnd: "15:30",
      },
    };

    const dates = await store.loadReplaySessionDates(input(), snapshot, policy);
    expect(dates).toEqual(["2026-09-08", "2026-09-09"]);
    const session = (await store.loadReplaySession(
      snapshot,
      policy,
      "2026-09-09",
    )) as {
      session: {
        instruments: { instrumentId: string; role: string }[];
      };
    };
    const candidateIds = session.session.instruments
      .filter((value) => value.role === "CANDIDATE")
      .map((value) => value.instrumentId);
    const benchmarkIds = session.session.instruments
      .filter((value) => value.role === "BENCHMARK")
      .map((value) => value.instrumentId);
    expect(candidateIds).toEqual([candidateA.id]);
    expect(benchmarkIds).toEqual([benchmark.id]);
    expect(candidateIds).not.toContain(laterCandidate.id);
  });

  it("keeps a frozen replay unchanged when the live active list changes", async () => {
    const store = new PostgresBacktestStore(pool);
    const availability =
      await store.getCapturedHistoryAvailability("US_EQUITIES");
    const snapshot = await store.resolveReplayInput(input(), availability);
    const policy = {
      marketId: "US_EQUITIES" as const,
      timezone: "America/New_York" as const,
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:30", end: "16:00" },
      entries: {
        preferredStart: "09:45",
        preferredEnd: "11:30",
        hardEnd: "15:30",
      },
    };
    const before = await store.loadReplaySession(
      snapshot,
      policy,
      "2026-09-08",
    );

    await pool.query(
      `UPDATE instrument SET active=TRUE, universe_eligible=TRUE WHERE id=$1`,
      [laterCandidate.id],
    );
    await pool.query(`UPDATE instrument SET active=FALSE WHERE id=$1`, [
      candidateA.id,
    ]);
    const after = await store.loadReplaySession(snapshot, policy, "2026-09-08");
    const rerun = await store.resolveReplayInput(input(), availability);

    expect(after).toEqual(before);
    expect(rerun.inputHash).toBe(snapshot.inputHash);
    expect(rerun.sessions).toEqual(snapshot.sessions);
  });
});
