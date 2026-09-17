import { randomUUID } from "node:crypto";
import type { ScannerProfile } from "@tsx-scanner/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { BacktestAutomationService } from "../src/backtests/backtest-automation.js";
import type { BacktestAutomationStageDefinition } from "../src/backtests/backtest-automation.js";
import { FundedHistoricalAutomationService } from "../src/paper-bot/funded-historical-automation.js";
import { PostgresBacktestAutomationStore } from "../src/backtests/backtest-automation-repository.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { ResearchJobRepository } from "../src/research-jobs/research-job-repository.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

describe.skipIf(!databaseUrl)(
  "backtest automation against isolated PostgreSQL",
  () => {
    let pool: Pool;
    let backtestStore: PostgresBacktestStore;
    let jobs: ResearchJobRepository;
    let instrumentId: string;
    let membershipRunId: string;
    const now = new Date("2026-09-10T21:00:00.000Z");

    function profile(overrides: Record<string, unknown> = {}): ScannerProfile {
      return {
        id: randomUUID(),
        name: "PG automation fixture",
        analysisKind: "SETUP",
        configId: randomUUID(),
        configVersion: "profile-pg-v1",
        strategyKey: "ORB_RETEST",
        marketId: "CA_TSX",
        parameters: { rvolAtTimeMin: 1.5 },
        ...overrides,
      } as unknown as ScannerProfile;
    }

    function service(
      profiles: ScannerProfile[] = [profile()],
      definitions?: readonly BacktestAutomationStageDefinition[],
    ) {
      return new BacktestAutomationService({
        store: new PostgresBacktestAutomationStore(pool),
        inputs: backtestStore,
        profiles: { listProfiles: async () => profiles },
        jobs,
        clock: () => now,
        ...(definitions ? { stageDefinitions: definitions } : {}),
      });
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      await pool.query("DELETE FROM backtest_automation_cycle");
      await pool.query("DELETE FROM backtest_automation_work");
      await pool.query("DELETE FROM backtest_automation_control");
      backtestStore = new PostgresBacktestStore(pool);
      jobs = new ResearchJobRepository(pool);
      instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active)
         VALUES($1,$2,$3,'A1 automation fixture','TSX','CAD','Stock','Financial Services',true,true,true)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 3_000_000_000,
          `A1_${instrumentId.slice(0, 8)}.TO`,
        ],
      );
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,false,false,'A1')`,
        [instrumentId, "2026-09-09T14:30:00.000Z"],
      );
      // Historical membership effective before the captured sessions' opens;
      // without it the automation correctly waits instead of dispatching.
      membershipRunId = randomUUID();
      await pool.query(
        `INSERT INTO universe_refresh_run(id,market_id,provider,policy_version,policy,status,started_at,completed_at,discovered_count,eligible_count)
         VALUES($1,'CA_TSX','FIXTURE','fixture','{}','COMPLETED','2026-09-09T12:00:00Z','2026-09-09T12:00:30Z',1,1)`,
        [membershipRunId],
      );
      await pool.query(
        `INSERT INTO universe_membership(run_id,instrument_id,symbol,description,exchange,eligible,reasons,metrics_as_of)
         SELECT $1,$2,symbol,'A1 automation fixture','TSX',true,'[]','2026-09-09T12:00:00Z'
           FROM instrument WHERE id=$2`,
        [membershipRunId, instrumentId],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      // Remove market-wide fixtures so later files in a shared acceptance
      // database do not resolve this file's membership history.
      await pool.query("DELETE FROM universe_membership WHERE run_id=$1", [
        membershipRunId,
      ]);
      await pool.query("DELETE FROM universe_refresh_run WHERE id=$1", [
        membershipRunId,
      ]);
      await pool.query("DELETE FROM quote_snapshot WHERE instrument_id=$1", [
        instrumentId,
      ]);
      await pool.query("DELETE FROM candle WHERE instrument_id=$1", [
        instrumentId,
      ]);
      await pool.query("DELETE FROM instrument WHERE id=$1", [instrumentId]);
      await pool.end();
    });

    it("fingerprints captured inputs per market and detects new or late data", async () => {
      const before = await backtestStore.captureInputFingerprint("CA_TSX");
      expect(before).toMatch(/^[a-f0-9]{64}$/);
      expect(await backtestStore.captureInputFingerprint("CA_TSX")).toBe(
        before,
      );

      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,false,false,'A1')`,
        [instrumentId, "2026-09-10T14:30:00.000Z"],
      );
      const after = await backtestStore.captureInputFingerprint("CA_TSX");
      expect(after).not.toBe(before);

      const usInstrument = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,market_id,
         security_type,industry_sector,is_quotable,is_tradable,active)
         VALUES($1,$2,$3,'A1 US fixture','NASDAQ','USD','US_EQUITIES','Stock','Technology',true,true,true)`,
        [
          usInstrument,
          Math.floor(Math.random() * 1_000_000_000) + 4_000_000_000,
          `A1US_${usInstrument.slice(0, 8)}`,
        ],
      );
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,4.99,5,1000,1000,4.99,1000,1000,5,6,4,0.01,0.1,false,false,'A1')`,
        [usInstrument, "2026-09-10T15:00:00.000Z"],
      );
      expect(await backtestStore.captureInputFingerprint("CA_TSX")).toBe(after);
      expect(
        await backtestStore.captureInputFingerprint("US_EQUITIES"),
      ).not.toBe(after);
    });

    it("reads live job progress, heartbeat and start time for the status surface", async () => {
      const job = await jobs.createStrictJob(
        "BACKTEST",
        { probe: "progress" },
        `pg-progress-${randomUUID()}`,
      );
      await pool.query(
        `UPDATE research_job SET status='RUNNING', started_at=$2, heartbeat_at=$3, progress=$4::jsonb WHERE id=$1`,
        [
          job.id,
          now,
          new Date("2026-09-10T20:59:48.000Z"),
          JSON.stringify({
            totalSessions: 9,
            completedSessions: 8,
            message: "Loading session",
          }),
        ],
      );
      const snapshots = await new PostgresBacktestAutomationStore(
        pool,
      ).jobSnapshots([job.id]);
      expect(snapshots.get(job.id)).toMatchObject({
        status: "RUNNING",
        startedAt: now.toISOString(),
        heartbeatAt: "2026-09-10T20:59:48.000Z",
        progress: {
          totalSessions: 9,
          completedSessions: 8,
          message: "Loading session",
        },
      });

      // A stage message without counts is preserved, but a malformed count is
      // not turned into an invented completion percentage.
      await pool.query(
        `UPDATE research_job SET progress=$2::jsonb WHERE id=$1`,
        [job.id, JSON.stringify({ message: "warming up" })],
      );
      expect(
        (
          await new PostgresBacktestAutomationStore(pool).jobSnapshots([job.id])
        ).get(job.id)?.progress,
      ).toEqual({
        totalSessions: null,
        completedSessions: null,
        message: "warming up",
      });
      await pool.query(
        `UPDATE research_job SET progress=$2::jsonb WHERE id=$1`,
        [job.id, JSON.stringify({ totalSessions: "9" })],
      );
      expect(
        (
          await new PostgresBacktestAutomationStore(pool).jobSnapshots([job.id])
        ).get(job.id)?.progress,
      ).toBeNull();
    });

    it("ignores intraday and extended-hours capture until the session closes", async () => {
      const sessionDate = "2026-09-15";
      const beforeClose = new Date("2026-09-15T18:00:00.000Z"); // 14:00 ET
      const afterClose = new Date("2026-09-15T21:00:00.000Z"); // 17:00 ET
      const baseline = await backtestStore.captureInputFingerprint(
        "CA_TSX",
        beforeClose,
      );
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,false,false,'A1')`,
        [instrumentId, `${sessionDate}T14:30:00.000Z`],
      );
      // Intraday growth for the current market-local date is not yet a change.
      expect(
        await backtestStore.captureInputFingerprint("CA_TSX", beforeClose),
      ).toBe(baseline);

      // Once the close boundary passes, the completed regular session counts.
      const closed = await backtestStore.captureInputFingerprint(
        "CA_TSX",
        afterClose,
      );
      expect(closed).not.toBe(baseline);

      // Extended-hours capture after the close never churns the fingerprint.
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,false,false,'A1')`,
        [instrumentId, `${sessionDate}T23:00:00.000Z`],
      );
      expect(
        await backtestStore.captureInputFingerprint("CA_TSX", afterClose),
      ).toBe(closed);

      // Pre-open capture on a completed earlier session cannot change a
      // replay: the engine's opening range starts at 09:30 market-local.
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,false,false,'A1')`,
        [instrumentId, "2026-09-14T12:00:00.000Z"],
      );
      await pool.query(
        `INSERT INTO candle(instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,source,is_complete)
         VALUES($1,'OneMinute',$2,$3,10,11,9,10.5,1000,'A1',true)`,
        [instrumentId, "2026-09-14T12:00:00.000Z", "2026-09-14T12:01:00.000Z"],
      );
      expect(
        await backtestStore.captureInputFingerprint("CA_TSX", afterClose),
      ).toBe(closed);

      // Daily candles always participate: their midnight start still aligns
      // them to the session whose opening range they precede.
      await pool.query(
        `INSERT INTO candle(instrument_id,timeframe,start_time,end_time,open,high,low,close,volume,source,is_complete)
         VALUES($1,'OneDay',$2,$3,10,11,9,10.5,1000,'A1',true)`,
        [instrumentId, "2026-09-14T04:00:00.000Z", "2026-09-14T20:00:00.000Z"],
      );
      const withDaily = await backtestStore.captureInputFingerprint(
        "CA_TSX",
        afterClose,
      );
      expect(withDaily).not.toBe(closed);

      // A late-arriving regular-session row still reopens the work.
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,false,false,'A1')`,
        [instrumentId, `${sessionDate}T19:59:00.000Z`],
      );
      expect(
        await backtestStore.captureInputFingerprint(
          "CA_TSX",
          new Date("2026-09-15T23:30:00.000Z"),
        ),
      ).not.toBe(withDaily);
    });

    it("survives a worker restart with durable work identity and cycle receipts", async () => {
      const target = profile();
      const first = service([target]);
      const dispatched = await first.triggerProfile(target, "PROFILE_SAVE");
      expect(dispatched.kind).toBe("DISPATCHED");
      const work = (
        await new PostgresBacktestAutomationStore(pool).listWork("CA_TSX")
      ).find((record) => record.identity.configId === target.configId);
      expect(work).toBeDefined();
      expect(work!.state).toBe("QUEUED");
      expect(work!.jobId).not.toBeNull();

      const priority = await pool.query<{ priority: number }>(
        "SELECT priority FROM research_job WHERE id=$1",
        [work!.jobId],
      );
      expect(priority.rows[0]?.priority).toBe(10);

      // Restart: a fresh service instance reconciles the durable job outcome.
      await pool.query(
        `UPDATE research_job SET status='SUCCEEDED', result_ref_id=$2, completed_at=now(), lease_owner=NULL WHERE id=$1`,
        [work!.jobId, randomUUID()],
      );
      const restarted = service([target]);
      const unchanged = await restarted.triggerProfile(
        target,
        "SCHEDULED_CATCH_UP",
      );
      expect(unchanged.kind).toBe("UNCHANGED");
      const settled = (await new PostgresBacktestAutomationStore(pool).getWork(
        work!.workKey,
      ))!;
      expect(settled.state).toBe("SUCCEEDED");
      expect(settled.consumedFingerprint).toBe(settled.dispatchedFingerprint);
      expect(settled.lastSuccessAt).not.toBeNull();

      // Cycle receipts are durable and readable after the restart.
      await restarted.configureMarket({
        marketId: "CA_TSX",
        enabled: true,
        cadence: "DAILY_POST_SESSION",
        maxOutstanding: 2,
      });
      const cycle = await restarted.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");
      expect(cycle.outcome).toBe("NO_CHANGES");
      const receipts = await new PostgresBacktestAutomationStore(
        pool,
      ).listCycles("CA_TSX", 5);
      expect(receipts.map((receipt) => receipt.cycleId)).toContain(
        cycle.cycleId,
      );

      // A late-arriving row reopens the same work item with a distinct attempt.
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,false,false,'A1')`,
        [instrumentId, "2026-09-11T14:30:00.000Z"],
      );
      const reopened = await restarted.triggerProfile(
        target,
        "SCHEDULED_CATCH_UP",
      );
      expect(reopened.kind).toBe("DISPATCHED");
      const rebuilt = (await new PostgresBacktestAutomationStore(pool).getWork(
        work!.workKey,
      ))!;
      expect(rebuilt.consumedFingerprint).not.toBe(rebuilt.inputFingerprint);
      expect(rebuilt.attemptKey).not.toBe(settled.attemptKey);
    });

    it("persists stage evaluations and clears them on a new attempt", async () => {
      const target = profile();
      const definitions: BacktestAutomationStageDefinition[] = [
        {
          key: "COVERAGE",
          authorizationScope: "AUTOMATIC",
          async evaluate() {
            return {
              kind: "COMPLETED",
              reasonCodes: ["RESEARCH_EVIDENCE_VERIFIED"],
              inputIdentityHash: "e".repeat(64),
            };
          },
        },
      ];
      const automation = service([target], definitions);
      await automation.configureMarket({
        marketId: "CA_TSX",
        enabled: true,
        cadence: "DAILY_POST_SESSION",
        maxOutstanding: 5,
      });
      const dispatched = await automation.triggerProfile(
        target,
        "PROFILE_SAVE",
      );
      expect(dispatched.kind).toBe("DISPATCHED");
      const work = (
        await new PostgresBacktestAutomationStore(pool).listWork("CA_TSX")
      ).find((record) => record.identity.configId === target.configId)!;
      await pool.query(
        `UPDATE research_job SET status='SUCCEEDED', result_ref_id=$2, completed_at=now(), lease_owner=NULL WHERE id=$1`,
        [work.jobId, randomUUID()],
      );
      await automation.runCycle("CA_TSX", "SCHEDULED_CATCH_UP");

      const stages = await new PostgresBacktestAutomationStore(pool).listStages(
        "CA_TSX",
      );
      const coverage = stages.find(
        (stageRow) => stageRow.workKey === work.workKey,
      );
      expect(coverage).toMatchObject({
        stageKey: "COVERAGE",
        state: "COMPLETED",
        reasonCodes: ["RESEARCH_EVIDENCE_VERIFIED"],
      });

      // A new attempt invalidates derived stage rows.
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
         spread_absolute,spread_pct,is_delayed,is_halted,source)
         VALUES($1,$2,9.99,10,1000,1000,9.99,1000,1000,10,11,9,0.01,0.1,false,false,'A1')`,
        [instrumentId, "2026-09-12T14:30:00.000Z"],
      );
      const redispatched = await automation.triggerProfile(
        target,
        "SCHEDULED_CATCH_UP",
      );
      expect(redispatched.kind).toBe("DISPATCHED");
      const after = await new PostgresBacktestAutomationStore(pool).listStages(
        "CA_TSX",
      );
      expect(after.some((stageRow) => stageRow.workKey === work.workKey)).toBe(
        false,
      );
    });

    it("persists explicit funded replay policies with scope and revocation", async () => {
      const policies = new FundedHistoricalAutomationService(pool, () => now);
      const input = {
        marketId: "CA_TSX" as const,
        scope: {
          kind: "PROFILE_CONFIG" as const,
          configId: randomUUID(),
          configVersion: "profile-policy-v1",
        },
        maxSessions: 5,
        approvedBy: "operator",
        approvalNote: "Bounded funded replay comparison",
        expiresAt: "2026-10-10T20:00:00.000Z",
      };
      const created = await policies.requestPolicy(input);
      expect(created.revokedAt).toBeNull();
      expect(created.policyHash).toMatch(/^[a-f0-9]{64}$/);

      const duplicate = await policies.requestPolicy(input);
      expect(duplicate.policyId).toBe(created.policyId);

      const active = await policies.activePolicyFor("CA_TSX", input.scope);
      expect(active?.policyId).toBe(created.policyId);

      await expect(
        policies.requestPolicy({
          ...input,
          scope: { ...input.scope, configId: randomUUID() },
          expiresAt: "2026-09-01T00:00:00.000Z",
        }),
      ).rejects.toThrow(/FUTURE/);

      const revoked = await policies.revokePolicy(created.policyId, {
        revokedBy: "operator",
        reason: "Superseded",
      });
      expect(revoked?.revokedAt).not.toBeNull();
      expect(revoked?.revokedReason).toBe("Superseded");
      expect(await policies.activePolicyFor("CA_TSX", input.scope)).toBeNull();
      expect(
        (await policies.listPolicies("CA_TSX")).some(
          (entry) => entry.policyId === created.policyId,
        ),
      ).toBe(true);
    });
  },
);
