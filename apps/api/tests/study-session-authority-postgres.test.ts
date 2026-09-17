import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { studyPlan } from "./study-fixture.js";
import {
  PostgresStudyAuthorizationRepository,
  authorizationPlanHash,
  authorizationPolicyHash,
} from "../src/backtests/study-authorization-repository.js";
import { PostgresStudySessionAuthority } from "../src/backtests/study-session-authority.js";
import { PostgresStrategyStudyStore } from "../src/backtests/strategy-study-repository.js";
import { CapturedReplayRunner } from "../src/backtests/captured-replay-runner.js";
import { contentHash } from "../src/backtests/research-coverage.js";
const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!url)("durable study session authority", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  async function fixture(direct = false, expiring = false) {
    const plan = { ...studyPlan(), experimentId: randomUUID() };
    const deadline = expiring
      ? (
          await pool.query<{ deadline: Date }>(
            "SELECT clock_timestamp()+interval '2 seconds' AS deadline",
          )
        ).rows[0]!.deadline.toISOString()
      : "2099-01-01T00:00:00.000Z";
    const repository = new PostgresStudyAuthorizationRepository(pool);
    const id = randomUUID();
    let jobId: string;
    if (direct) jobId = (await repository.createDirect(plan, id)).id;
    else {
      await repository.create(
        {
          id,
          marketId: "CA_TSX",
          frozenPlanHash: authorizationPlanHash(plan),
          prerequisitePolicyHash: authorizationPolicyHash(plan),
          sourceWindowStart: "2026-09-01",
          sourceWindowEnd: "2026-09-03",
          engineRevision: plan.binding.engineRevision,
          runtimeFingerprint: plan.binding.runtimeFingerprint,
          expiresAt: deadline,
          maxStudies: 1,
          maxSessionExecutions: 6,
          mode: "EXECUTE_WHEN_READY",
        },
        plan,
        id,
      );
      const dispatched = await repository.reserveAndEnqueue(id, id);
      if (dispatched.state !== "DISPATCHED") throw Error("not dispatched");
      jobId = dispatched.jobId;
    }
    const job = await pool.query<{
      request_payload: {
        authority:
          | { kind: "DIRECT_SUBMISSION"; grantId: string }
          | { kind: "EXECUTE_WHEN_READY"; authorizationId: string };
      };
    }>(
      "UPDATE research_job SET status='RUNNING',lease_owner='session-test',attempt_count=1,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1 RETURNING request_payload",
      [jobId],
    );
    const authority = job.rows[0]!.request_payload.authority;
    const fence = { jobId, leaseOwner: "session-test", attemptCount: 1 };
    await new PostgresStrategyStudyStore(pool, fence, authority).register(plan);
    const sessions = new PostgresStudySessionAuthority(pool, authority, plan);
    const key = {
      experimentId: plan.experimentId,
      stage: "TRAIN" as const,
      side: "baseline" as const,
      sessionDate: "2026-09-01",
    };
    return { plan, repository, id, jobId, authority, fence, sessions, key };
  }
  it("blocks acceptance and subsequent calls after revocation while retaining exposure", async () => {
    const f = await fixture();
    await f.sessions.begin(f.key, f.fence);
    await f.repository.revoke(f.id, randomUUID());
    await expect(
      f.sessions.accept(f.key, f.fence, "a".repeat(64)),
    ).rejects.toThrow("STUDY_AUTHORITY_LOST");
    await expect(
      f.sessions.begin({ ...f.key, side: "challenger" }, f.fence),
    ).rejects.toThrow("STUDY_AUTHORITY_LOST");
    expect(
      (
        await pool.query(
          "SELECT 1 FROM study_session_acceptance WHERE job_id=$1",
          [f.jobId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM study_session_receipt WHERE job_id=$1",
          [f.jobId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("admits a direct grant once and conflict-checks accepted result bytes", async () => {
    const f = await fixture(true);
    expect(f.authority.kind).toBe("DIRECT_SUBMISSION");
    await f.sessions.begin(f.key, f.fence);
    await f.sessions.accept(f.key, f.fence, "a".repeat(64));
    await expect(
      f.sessions.accept(f.key, f.fence, "b".repeat(64)),
    ).rejects.toThrow("STUDY_SESSION_RESULT_CONFLICT");
    expect(await f.sessions.begin(f.key, f.fence)).toBe("ACCEPTED");
    await pool.query(
      "UPDATE research_job SET cancellation_requested=true WHERE id=$1",
      [f.jobId],
    );
    await expect(
      f.sessions.begin({ ...f.key, side: "challenger" }, f.fence),
    ).rejects.toThrow("STUDY_AUTHORITY_LOST");
  });
  it("rejects a 41-execution budget and atomically admits 42 across concurrent dispatch", async () => {
    const plan = { ...studyPlan(), experimentId: randomUUID() };
    const train = Array.from(
      { length: 10 },
      (_, i) =>
        `2026-08-${String(3 + (i % 5) + Math.floor(i / 5) * 7).padStart(2, "0")}`,
    );
    const validation = train.map(
      (date) =>
        `2026-08-${String(Number(date.slice(-2)) + 14).padStart(2, "0")}`,
    );
    plan.sessionPlan!.sessions.TRAIN = train;
    plan.sessionPlan!.sessions.VALIDATION = validation;
    for (const side of ["baseline", "challenger"] as const) {
      plan.inputs.TRAIN[side].startDate = train[0]!;
      plan.inputs.TRAIN[side].endDate = train.at(-1)!;
      plan.inputs.VALIDATION[side].startDate = validation[0]!;
      plan.inputs.VALIDATION[side].endDate = validation.at(-1)!;
    }
    const repository = new PostgresStudyAuthorizationRepository(pool),
      id = randomUUID();
    const authorization = {
      id,
      marketId: "CA_TSX" as const,
      frozenPlanHash: authorizationPlanHash(plan),
      prerequisitePolicyHash: authorizationPolicyHash(plan),
      sourceWindowStart: train[0]!,
      sourceWindowEnd: "2026-09-03",
      engineRevision: plan.binding.engineRevision,
      runtimeFingerprint: plan.binding.runtimeFingerprint,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxStudies: 1 as const,
      maxSessionExecutions: 41,
      mode: "EXECUTE_WHEN_READY" as const,
    };
    await expect(repository.create(authorization, plan, id)).rejects.toThrow(
      "STUDY_AUTHORIZATION_BUDGET_EXCEEDED",
    );
    await repository.create(
      { ...authorization, maxSessionExecutions: 42 },
      plan,
      id,
    );
    const results = await Promise.all([
      repository.reserveAndEnqueue(id, id),
      repository.reserveAndEnqueue(id, id),
    ]);
    expect(results.map((r) => r.state).sort()).toEqual(["DISPATCHED", "USED"]);
    expect(
      (
        await pool.query(
          "SELECT admitted_executions FROM study_execution_grant WHERE id=$1",
          [id],
        )
      ).rows[0].admitted_executions,
    ).toBe(42);
  });
  it("rejects stale attempts and sessions outside the immutable grant", async () => {
    const f = await fixture(true);
    await f.sessions.begin(f.key, f.fence);
    await expect(
      f.sessions.begin({ ...f.key, sessionDate: "2026-09-04" }, f.fence),
    ).rejects.toThrow("STUDY_SESSION_NOT_IN_FROZEN_PLAN");
    await pool.query("UPDATE research_job SET attempt_count=2 WHERE id=$1", [
      f.jobId,
    ]);
    await expect(
      f.sessions.accept(f.key, f.fence, "a".repeat(64)),
    ).rejects.toThrow("STUDY_LEASE_LOST");
    await expect(
      f.sessions.accept(f.key, { ...f.fence, attemptCount: 2 }, "a".repeat(64)),
    ).rejects.toThrow("STUDY_SESSION_BEGIN_REQUIRED");
  });
  it.each(["revocation", "expiry"])(
    "discards a blocked scanner response after %s before ingest or persistence",
    async (reason) => {
      const f = await fixture(false, reason === "expiry");
      let entered!: () => void, release!: (value: unknown) => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const response = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      const payload = {
        session: { market: "CA_TSX", instruments: [] },
        quotes: [],
        candles: [],
      };
      let calls = 0,
        completed = 0;
      const runner = new CapturedReplayRunner(
        {
          loadVerifiedReplayInput: async () => ({
            marketId: "CA_TSX",
            capturedHistoryAvailability: {},
            candidateInstruments: [],
            benchmarks: [],
          }),
          loadVerifiedReplaySession: async () => payload,
          loadReplaySession: async () => payload,
          create: async () => ({ id: randomUUID() }),
          markRunning: async () => {},
          complete: async () => {
            completed++;
          },
          fail: async () => {},
        } as never,
        {
          runBacktestSignalChunk: async () => {
            calls++;
            entered();
            return response;
          },
        } as never,
        { timezone: "America/Toronto" } as never,
        {
          getReport: async () => ({
            status: "VERIFIED",
            marketId: "CA_TSX",
            inputHash: f.plan.binding.inputHash,
            sessionPayloadHashes: {
              "2026-09-01": contentHash({ date: "2026-09-01", payload }),
            },
          }),
        } as never,
        { heartbeat: async () => ({ cancellationRequested: false }) } as never,
        f.sessions,
        f.fence,
      );
      const running = runner.run(f.plan, "TRAIN");
      await started;
      if (reason === "revocation")
        await f.repository.revoke(f.id, randomUUID());
      else
        await pool.query(
          "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.01) FROM study_execution_authorization WHERE id=$1",
          [f.id],
        );
      release({});
      await expect(running).rejects.toThrow("STUDY_AUTHORITY_LOST");
      expect(calls).toBe(1);
      expect(completed).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM study_session_acceptance WHERE job_id=$1",
            [f.jobId],
          )
        ).rowCount,
      ).toBe(0);
    },
  );
});
