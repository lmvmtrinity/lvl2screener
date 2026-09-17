import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReplayInputSnapshot } from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";
import { PostgresResearchCoverageSource } from "../src/backtests/research-coverage-source.js";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { ResearchCoverageService } from "../src/backtests/research-coverage-service.js";
import { contentHash } from "../src/backtests/research-coverage.js";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!url)("retained PostgreSQL coverage extraction", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  it("hashes the actual replay projection while keeping unavailable provider provenance UNKNOWN", async () => {
    const [instrument] = await new PostgresMarketDataRepository(
      pool,
    ).upsertInstruments(
      [
        {
          symbolId: 2100000000 + Math.floor(Math.random() * 10000000),
          symbol: `COV_${randomUUID().slice(0, 8)}.TO`,
          description: "coverage fixture",
          securityType: "Stock",
          exchange: "TSX",
          currency: "CAD",
          isQuotable: true,
          isTradable: true,
        },
      ],
      "CA_TSX",
    );
    const run = randomUUID();
    await pool.query(
      `INSERT INTO universe_refresh_run(id,market_id,provider,policy_version,policy,status,started_at,completed_at) VALUES($1,'CA_TSX','FIXTURE','fixture','{}','COMPLETED','2026-09-09T12:00:00Z','2026-09-09T12:01:00Z')`,
      [run],
    );
    await pool.query(
      `INSERT INTO universe_membership(run_id,instrument_id,symbol,description,exchange,eligible,reasons,metrics_as_of) VALUES($1,$2,$3,'fixture','TSX',true,'[]','2026-09-09T12:00:00Z')`,
      [run, instrument!.id, instrument!.symbol],
    );
    await pool.query(
      `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,spread_absolute,spread_pct,is_delayed,is_halted,source) VALUES($1,'2026-09-09T13:30:00Z',10,10.01,1000,1000,10,100,10000,10,11,9,0.01,0.1,false,false,'QUESTRADE')`,
      [instrument!.id],
    );
    await pool.query(
      `INSERT INTO candle(instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,is_complete,source) VALUES($1,'OneMinute','2026-09-09T13:29:00Z','2026-09-09T13:30:00Z',10,11,9,10,1000,true,'QUESTRADE')`,
      [instrument!.id],
    );
    const manifest = {
      plan: { expectedSessions: ["2026-09-09"] },
      fixture: randomUUID(),
    };
    const evidence = new PostgresResearchEvidenceStore(pool);
    const manifestHash = contentHash(manifest);
    await evidence.saveManifest({
      hash: manifestHash,
      marketId: "CA_TSX",
      manifest,
    });
    const source = new PostgresResearchCoverageSource(pool);
    const request = {
      marketId: "CA_TSX" as const,
      manifestHash,
      inputCutoff: "2026-09-10T00:00:00.000Z",
      sessionDates: ["2026-09-09"],
    };
    const frozen = await source.readFrozenInputs(request);
    const policy = {
      marketId: "CA_TSX" as const,
      timezone: "America/Toronto" as const,
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:30", end: "16:00" },
      entries: {
        preferredStart: "09:45",
        preferredEnd: "11:30",
        hardEnd: "15:30",
      },
    };
    const snapshot = {
      candidateInstruments: [
        {
          instrumentId: instrument!.id,
          symbol: instrument!.symbol,
          sector: null,
        },
      ],
      benchmarks: [],
      sessions: [],
    } as unknown as ReplayInputSnapshot;
    const replay = await new PostgresBacktestStore(pool).loadReplaySession(
      snapshot,
      policy,
      "2026-09-09",
    );
    expect(frozen.sessionPayloads?.["2026-09-09"]).toEqual(replay);
    expect(frozen.sessionPayloadHashes["2026-09-09"]).toBe(
      contentHash({ date: "2026-09-09", payload: replay }),
    );
    const report = await new ResearchCoverageService(
      source,
      () => new Date("2026-09-10T00:00:00Z"),
    ).verify(request);
    expect(report.status).toBe("UNKNOWN");
    expect(report.cells[0]?.reasons).toContain("AVAILABILITY_UNPROVEN");
    const hash = await evidence.saveReport(report);
    await evidence.saveSessions(hash, frozen.sessionPayloads!);
    await expect(
      new PostgresBacktestStore(pool).loadVerifiedReplaySession(
        hash,
        "2026-09-09",
      ),
    ).rejects.toThrow("VERIFIED_REPLAY_SESSION_UNAVAILABLE");
  });
});
