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
import { calendarPolicyHashFor } from "../src/universe/market-calendar.js";

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
    const store = new PostgresBacktestStore(pool);
    const snapshotInput: Omit<ReplayInputSnapshot, "inputHash"> = {
      version: "replay-input-v1",
      marketId: "CA_TSX",
      resolvedAt: request.inputCutoff,
      requestedSymbols: [instrument!.symbol],
      candidateInstruments: [
        {
          instrumentId: instrument!.id,
          symbol: instrument!.symbol,
          sector: null,
        },
      ],
      benchmarks: [],
      universeRefreshRunId: run,
      capturedHistoryAvailability: await store.getCapturedHistoryAvailability(
        "CA_TSX",
        { now: new Date(request.inputCutoff), source: "CAPTURED_QUOTES" },
      ),
      warnings: [],
      candidateProvenance: "EXPLICIT_CAPTURED_COHORT",
      sessions: [],
    };
    const snapshot: ReplayInputSnapshot = {
      ...snapshotInput,
      inputHash: contentHash(snapshotInput),
    };
    const replay = await store.loadReplaySession(
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
    await evidence.saveSessions(hash, frozen.sessionPayloads!);
    const payloadHash = frozen.sessionPayloadHashes["2026-09-09"]!;
    const stored = await pool.query<{ payload: unknown; count: string }>(
      `SELECT p.payload, (SELECT count(*)::text FROM research_coverage_payload
        WHERE payload_hash=$2) AS count
       FROM research_coverage_session s
       JOIN research_coverage_payload p USING (payload_hash)
       WHERE s.report_hash=$1 AND s.session_date='2026-09-09'`,
      [hash, payloadHash],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.count).toBe("1");
    expect(stored.rows[0]?.payload).toEqual(
      frozen.sessionPayloads?.["2026-09-09"],
    );
    await expect(
      pool.query(
        "UPDATE research_coverage_payload SET payload='{}'::jsonb WHERE payload_hash=$1",
        [payloadHash],
      ),
    ).rejects.toThrow();
    await expect(
      new PostgresBacktestStore(pool).loadVerifiedReplaySession(
        hash,
        "2026-09-09",
      ),
    ).rejects.toThrow("VERIFIED_REPLAY_SESSION_UNAVAILABLE");
  });

  it("uses the frozen published early-close window for SQL and replay payloads", async () => {
    const [instrument] = await new PostgresMarketDataRepository(
      pool,
    ).upsertInstruments(
      [
        {
          symbolId: 2200000000 + Math.floor(Math.random() * 10000000),
          symbol: `COV_EARLY_${randomUUID().slice(0, 8)}.US`,
          description: "early-close coverage fixture",
          securityType: "Stock",
          exchange: "NASDAQ",
          currency: "USD",
          isQuotable: true,
          isTradable: true,
        },
      ],
      "US_EQUITIES",
    );
    const run = randomUUID();
    await pool.query(
      `INSERT INTO universe_refresh_run(id,market_id,provider,policy_version,policy,status,started_at,completed_at) VALUES($1,'US_EQUITIES','FIXTURE','fixture','{}','COMPLETED','2026-11-27T12:00:00Z','2026-11-27T12:01:00Z')`,
      [run],
    );
    await pool.query(
      `INSERT INTO universe_membership(run_id,instrument_id,symbol,description,exchange,eligible,reasons,metrics_as_of) VALUES($1,$2,$3,'fixture','NASDAQ',true,'[]','2026-11-27T12:00:00Z')`,
      [run, instrument!.id, instrument!.symbol],
    );
    await pool.query(
      `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,spread_absolute,spread_pct,is_delayed,is_halted,source) VALUES($1,'2026-11-27T17:59:00Z',10,10.01,1000,1000,10,100,10000,10,11,9,0.01,0.1,false,false,'QUESTRADE'),($1,'2026-11-27T19:00:00Z',10,10.01,1000,1000,10,100,10000,10,11,9,0.01,0.1,false,false,'QUESTRADE')`,
      [instrument!.id],
    );
    const manifest = {
      plan: { expectedSessions: ["2026-11-27"] },
      fixture: randomUUID(),
    };
    const evidence = new PostgresResearchEvidenceStore(pool);
    const manifestHash = contentHash(manifest);
    await evidence.saveManifest({
      hash: manifestHash,
      marketId: "US_EQUITIES",
      manifest,
    });
    const inputCutoff = "2026-12-01T00:00:00.000Z";
    const replayPolicy = {
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
    const recipe = {
      version: "research-coverage-recipe-v2" as const,
      marketId: "US_EQUITIES" as const,
      engineRevision: "0".repeat(40),
      runtimeFingerprint: "1".repeat(64),
      featureVersion: "fixture",
      sessionDates: ["2026-11-27"],
      inputCutoff,
      streamRequirements: [
        {
          timeframe: "OneMinute" as const,
          warmupDays: 20,
          requiredWarmupBars: 20,
          includeInSession: true,
        },
      ],
      maxQuoteGapMs: 30_000,
      replayPolicy,
      replayPolicyHash: contentHash(replayPolicy),
      membershipPolicyHash: "2".repeat(64),
      calendarPolicyHash: calendarPolicyHashFor({
        marketId: "US_EQUITIES",
        timezone: "America/New_York",
        sessionDates: ["2026-11-27"],
        inputCutoff,
      }),
    };
    const frozen = await new PostgresResearchCoverageSource(
      pool,
    ).readFrozenInputs({
      marketId: "US_EQUITIES",
      manifestHash,
      inputCutoff,
      sessionDates: ["2026-11-27"],
      recipe,
    });
    expect(frozen.expected[0]?.windowEnd).toBe("2026-11-27T18:00:00.000Z");
    expect(frozen.expected[0]?.calendarSourceHash).toMatch(/^[a-f0-9]{64}$/);
    const payload = frozen.sessionPayloads?.["2026-11-27"] as {
      session: { endTime: string };
      quotes: Array<{ timestamp: string; last: number }>;
    };
    expect(payload.session.endTime).toBe("2026-11-27T18:00:00.000Z");
    expect(payload.quotes).toHaveLength(1);
    expect(payload.quotes[0]).toEqual(
      expect.objectContaining({
        timestamp: "2026-11-27T17:59:00.000Z",
        last: 10,
      }),
    );
  });
});
