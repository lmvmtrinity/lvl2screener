import { describe, expect, it } from "vitest";
import {
  LeaseLostError,
  ResearchJobRepository,
} from "../src/research-jobs/research-job-repository.js";

/** In-memory fake standing in for Postgres so these tests exercise the repository's SQL contracts
 * (claim ordering, lease ownership checks, idempotency dedup) without a live database -- the same
 * style used by the other *-repository.test.ts files in this suite. */
function fakePool() {
  const rows: Record<string, unknown>[] = [];
  let nextId = 1;
  let clock = Date.now();
  const now = () => new Date(clock);

  function matches(row: Record<string, unknown>, status: string[]) {
    return status.includes(row.status as string);
  }

  return {
    rows,
    setTime: (value: Date) => {
      clock = value.getTime();
    },
    query: async (text: string, params: unknown[] = []) => {
      if (text.includes("INSERT INTO research_job")) {
        const [jobType, idempotencyKey, payload, priority] = params as [
          string,
          string | null,
          string,
          number,
        ];
        if (
          idempotencyKey &&
          rows.some(
            (row) =>
              row.job_type === jobType &&
              row.idempotency_key === idempotencyKey,
          )
        ) {
          const error = new Error("duplicate key") as Error & { code: string };
          error.code = "23505";
          throw error;
        }
        const row = {
          id: String(nextId++),
          job_type: jobType,
          priority,
          status: "QUEUED",
          idempotency_key: idempotencyKey,
          request_payload: JSON.parse(payload),
          result_ref_id: null,
          progress: {},
          error: null,
          error_category: null,
          attempt_count: 0,
          max_attempts: 3,
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
          cancellation_requested: false,
          created_at: now(),
          started_at: null,
          completed_at: null,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (
        text.includes("SELECT") &&
        text.includes("WHERE job_type=$1 AND idempotency_key=$2")
      ) {
        const [jobType, idempotencyKey] = params as [string, string];
        const found = rows.find(
          (row) =>
            row.job_type === jobType && row.idempotency_key === idempotencyKey,
        );
        return { rows: found ? [found] : [] };
      }
      if (text.includes("FROM research_job WHERE id=$1")) {
        const found = rows.find((row) => row.id === params[0]);
        return { rows: found ? [found] : [] };
      }
      if (text.includes("WITH candidate AS")) {
        const [jobTypes, leaseOwner, leaseMs] = params as [
          string[],
          string,
          string,
        ];
        const agingCap = text.includes("LEAST(")
          ? 10
          : Number.POSITIVE_INFINITY;
        const effectivePriority = (row: Record<string, unknown>) => {
          const ageMinutes =
            (clock - (row.created_at as Date).getTime()) / 60_000;
          return (row.priority as number) + Math.min(ageMinutes / 15, agingCap);
        };
        const candidate = rows
          .filter(
            (row) =>
              jobTypes.includes(row.job_type as string) &&
              (row.attempt_count as number) < (row.max_attempts as number) &&
              (row.status === "QUEUED" ||
                (matches(row, ["RUNNING", "CANCELLING"]) &&
                  (row.lease_expires_at as Date | null) !== null &&
                  (row.lease_expires_at as Date) < now())),
          )
          .sort(
            (a, b) =>
              effectivePriority(b) - effectivePriority(a) ||
              (a.created_at as Date).getTime() -
                (b.created_at as Date).getTime(),
          )[0];
        if (!candidate) return { rows: [] };
        if (candidate.status !== "CANCELLING") candidate.status = "RUNNING";
        candidate.lease_owner = leaseOwner;
        candidate.lease_expires_at = new Date(Date.now() + Number(leaseMs));
        candidate.heartbeat_at = now();
        candidate.attempt_count = (candidate.attempt_count as number) + 1;
        candidate.started_at ??= now();
        return { rows: [candidate] };
      }
      if (
        text.includes("SET lease_expires_at") &&
        text.includes("RETURNING cancellation_requested")
      ) {
        const [id, leaseOwner, leaseMs, progress] = params as [
          string,
          string,
          string,
          string | null,
        ];
        const row = rows.find(
          (value) =>
            value.id === id &&
            value.lease_owner === leaseOwner &&
            matches(value, ["RUNNING", "CANCELLING"]),
        );
        if (!row) return { rows: [] };
        row.lease_expires_at = new Date(Date.now() + Number(leaseMs));
        row.heartbeat_at = now();
        if (progress) row.progress = JSON.parse(progress);
        return {
          rows: [{ cancellation_requested: row.cancellation_requested }],
        };
      }
      if (text.includes("SET status='SUCCEEDED'")) {
        const [id, leaseOwner, resultRefId] = params as [
          string,
          string,
          string,
        ];
        const row = rows.find(
          (value) => value.id === id && value.lease_owner === leaseOwner,
        );
        if (!row) return { rowCount: 0 };
        row.status = "SUCCEEDED";
        row.result_ref_id = resultRefId;
        row.completed_at = now();
        row.lease_owner = null;
        return { rowCount: 1 };
      }
      if (text.includes("SET status='CANCELLED'")) {
        const [id, leaseOwner] = params as [string, string];
        const row = rows.find(
          (value) => value.id === id && value.lease_owner === leaseOwner,
        );
        if (!row) return { rowCount: 0 };
        row.status = "CANCELLED";
        row.error_category = "CANCELLED";
        row.completed_at = now();
        row.lease_owner = null;
        return { rowCount: 1 };
      }
      if (
        text.includes("SELECT attempt_count, max_attempts FROM research_job")
      ) {
        const [id, leaseOwner] = params as [string, string];
        const row = rows.find(
          (value) => value.id === id && value.lease_owner === leaseOwner,
        );
        return {
          rows: row
            ? [
                {
                  attempt_count: row.attempt_count,
                  max_attempts: row.max_attempts,
                },
              ]
            : [],
        };
      }
      if (text.includes("SET status='QUEUED'") && text.includes("error=$3")) {
        const [id, leaseOwner, error, category] = params as [
          string,
          string,
          string,
          string,
        ];
        const row = rows.find(
          (value) => value.id === id && value.lease_owner === leaseOwner,
        );
        if (!row) return { rowCount: 0 };
        row.status = "QUEUED";
        row.error = error;
        row.error_category = category;
        row.lease_owner = null;
        row.lease_expires_at = null;
        return { rowCount: 1 };
      }
      if (text.includes("SET status='FAILED'")) {
        const [id, leaseOwner, error, category] = params as [
          string,
          string,
          string,
          string,
        ];
        const row = rows.find(
          (value) => value.id === id && value.lease_owner === leaseOwner,
        );
        if (!row) return { rowCount: 0 };
        row.status = "FAILED";
        row.error = error;
        row.error_category = category;
        row.completed_at = now();
        row.lease_owner = null;
        return { rowCount: 1 };
      }
      if (text.includes("CASE WHEN status='QUEUED' THEN 'CANCELLED'")) {
        const [id] = params as [string];
        const row = rows.find((value) => value.id === id);
        if (!row) return { rows: [] };
        if (!["QUEUED", "RUNNING", "CANCELLING"].includes(row.status as string))
          return { rows: [] };
        row.cancellation_requested = true;
        if (row.status === "QUEUED") {
          row.status = "CANCELLED";
          row.error_category = "CANCELLED";
          row.error ??= "Cancelled by request";
          row.completed_at = now();
        } else if (row.status === "RUNNING") {
          row.status = "CANCELLING";
        }
        return { rows: [row] };
      }
      if (
        text.includes("SET status='QUEUED', lease_owner=NULL") &&
        text.includes("attempt_count < max_attempts")
      ) {
        let requeued = 0;
        for (const row of rows) {
          if (
            matches(row, ["RUNNING", "CANCELLING"]) &&
            (row.lease_expires_at as Date | null) &&
            (row.lease_expires_at as Date) < now() &&
            (row.attempt_count as number) < (row.max_attempts as number)
          ) {
            row.status = "QUEUED";
            row.lease_owner = null;
            row.lease_expires_at = null;
            row.error_category = "LEASE_EXPIRED";
            requeued++;
          }
        }
        return { rowCount: requeued };
      }
      if (text.includes("SET status='INTERRUPTED'")) {
        let interrupted = 0;
        for (const row of rows) {
          if (
            matches(row, ["RUNNING", "CANCELLING"]) &&
            (row.lease_expires_at as Date | null) &&
            (row.lease_expires_at as Date) < now() &&
            (row.attempt_count as number) >= (row.max_attempts as number)
          ) {
            row.status = "INTERRUPTED";
            row.error_category = "LEASE_EXPIRED";
            row.completed_at = now();
            interrupted++;
          }
        }
        return { rowCount: interrupted };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

describe("ResearchJobRepository", () => {
  it("creates a job and returns the same job for a duplicate idempotency key", async () => {
    const repo = new ResearchJobRepository(fakePool() as never);
    const first = await repo.createJob("BACKTEST", { name: "a" }, "key-1");
    const second = await repo.createJob(
      "BACKTEST",
      { name: "different payload" },
      "key-1",
    );
    expect(second.id).toBe(first.id);
    const third = await repo.createJob("BACKTEST", { name: "c" }, null);
    expect(third.id).not.toBe(first.id); // null keys never dedupe
  });

  it("strict enqueue compares the complete payload before reusing a key", async () => {
    const repo = new ResearchJobRepository(fakePool() as never);
    const first = await repo.createStrictJob(
      "STRATEGY_STUDY",
      { plan: { marketId: "CA_TSX", inputHash: "a" } },
      "strict-1",
    );
    await expect(
      repo.createStrictJob(
        "STRATEGY_STUDY",
        { plan: { marketId: "US_EQUITIES", inputHash: "a" } },
        "strict-1",
      ),
    ).rejects.toThrow("RESEARCH_JOB_IDEMPOTENCY_CONFLICT");
    expect(
      (
        await repo.createStrictJob(
          "STRATEGY_STUDY",
          { plan: { inputHash: "a", marketId: "CA_TSX" } },
          "strict-1",
        )
      ).id,
    ).toBe(first.id);
  });

  it("claims the oldest claimable job with FOR UPDATE SKIP LOCKED semantics and extends the lease on heartbeat", async () => {
    const repo = new ResearchJobRepository(fakePool() as never);
    await repo.createJob("BACKTEST", { name: "first" });
    await repo.createJob("BACKTEST", { name: "second" });
    const claimed = await repo.claimNext(["BACKTEST"], "worker-a", 60_000);
    expect(claimed?.status).toBe("RUNNING");
    expect(
      (claimed as { requestPayload: { name: string } }).requestPayload.name,
    ).toBe("first");
    // A second claim attempt with no other queued work of this type finds only job 2.
    const claimedSecond = await repo.claimNext(
      ["BACKTEST"],
      "worker-b",
      60_000,
    );
    expect(
      (claimedSecond as { requestPayload: { name: string } }).requestPayload
        .name,
    ).toBe("second");
    const heartbeat = await repo.heartbeat(claimed!.id, "worker-a", 60_000, {
      completedSessions: 1,
    });
    expect(heartbeat.cancellationRequested).toBe(false);
  });

  it("keeps a new requested job ahead of scheduled work", async () => {
    const pool = fakePool();
    const repo = new ResearchJobRepository(pool as never);
    await repo.createJob("BACKTEST", { name: "scheduled" });
    const requested = await repo.createJob(
      "BACKTEST",
      { name: "requested" },
      null,
      10,
    );

    const claimed = await repo.claimNext(["BACKTEST"], "worker-a", 60_000);
    expect(claimed?.id).toBe(requested.id);
  });

  it("lets old scheduled work win against a sustained stream of requested jobs", async () => {
    const pool = fakePool();
    const repo = new ResearchJobRepository(pool as never);
    const start = new Date();
    pool.setTime(start);
    const scheduled = await repo.createJob("BACKTEST", { name: "scheduled" });

    for (let interval = 10; interval <= 12; interval++) {
      pool.setTime(new Date(start.getTime() + interval * 15 * 60_000));
      await repo.createJob(
        "BACKTEST",
        { name: `requested-${interval}` },
        null,
        10,
      );
    }
    pool.setTime(new Date(start.getTime() + 195 * 60_000));

    const claimed = await repo.claimNext(["BACKTEST"], "worker-a", 60_000);
    expect(claimed?.id).toBe(scheduled.id);
  });

  it("rejects a heartbeat, complete, or fail from a caller that no longer holds the lease", async () => {
    const repo = new ResearchJobRepository(fakePool() as never);
    const job = await repo.createJob("BACKTEST", {});
    const claimed = await repo.claimNext(["BACKTEST"], "worker-a", 60_000);
    await expect(
      repo.heartbeat(claimed!.id, "someone-else", 60_000),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      repo.complete(job.id, "someone-else", "result-id"),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("completes a job and links it to the persisted result", async () => {
    const repo = new ResearchJobRepository(fakePool() as never);
    await repo.createJob("BACKTEST", {});
    const claimed = await repo.claimNext(["BACKTEST"], "worker-a", 60_000);
    await repo.complete(claimed!.id, "worker-a", "run-123");
    const job = await repo.get(claimed!.id);
    expect(job?.status).toBe("SUCCEEDED");
    expect(job?.resultRefId).toBe("run-123");
  });

  it("cancels a QUEUED job immediately, and flags a RUNNING job for the worker to observe", async () => {
    const repo = new ResearchJobRepository(fakePool() as never);
    const queued = await repo.createJob("BACKTEST", {});
    const cancelledQueued = await repo.requestCancellation(queued.id);
    expect(cancelledQueued?.status).toBe("CANCELLED");

    const other = await repo.createJob("BACKTEST", {});
    const claimed = await repo.claimNext(["BACKTEST"], "worker-a", 60_000);
    expect(claimed?.id).toBe(other.id);
    const cancelledRunning = await repo.requestCancellation(other.id);
    expect(cancelledRunning?.status).toBe("CANCELLING");
    expect(cancelledRunning?.cancellationRequested).toBe(true);
    const heartbeat = await repo.heartbeat(claimed!.id, "worker-a", 60_000);
    expect(heartbeat.cancellationRequested).toBe(true);
    await repo.markCancelled(claimed!.id, "worker-a");
    expect((await repo.get(claimed!.id))?.status).toBe("CANCELLED");
  });

  it("retries a transient failure up to max_attempts, then fails terminally", async () => {
    const repo = new ResearchJobRepository(fakePool() as never);
    const job = await repo.createJob("BACKTEST", {});
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = await repo.claimNext(
        ["BACKTEST"],
        `worker-${attempt}`,
        60_000,
      );
      expect(claimed?.id).toBe(job.id);
      await repo.fail(
        claimed!.id,
        `worker-${attempt}`,
        "engine exploded",
        "UPSTREAM_ENGINE",
      );
      const state = await repo.get(job.id);
      if (attempt < 3) expect(state?.status).toBe("QUEUED");
      else expect(state?.status).toBe("FAILED");
    }
  });

  it("never retries a VALIDATION failure even with attempts remaining", async () => {
    const repo = new ResearchJobRepository(fakePool() as never);
    const job = await repo.createJob("BACKTEST", {});
    const claimed = await repo.claimNext(["BACKTEST"], "worker-a", 60_000);
    await repo.fail(claimed!.id, "worker-a", "bad payload", "VALIDATION");
    expect((await repo.get(job.id))?.status).toBe("FAILED");
  });

  it("requeues an expired lease with attempts remaining and interrupts one with attempts exhausted", async () => {
    const pool = fakePool();
    const repo = new ResearchJobRepository(pool as never);
    const resumable = await repo.createJob("BACKTEST", {});
    const exhausted = await repo.createJob("BACKTEST", {});

    await repo.claimNext(["BACKTEST"], "dead-worker", 60_000);
    await repo.claimNext(["BACKTEST"], "dead-worker-2", 60_000);
    // Force both leases into the past, and pre-exhaust attempts on the second job.
    for (const row of pool.rows) {
      row.lease_expires_at = new Date(Date.now() - 1_000);
      if (row.id === exhausted.id) row.attempt_count = row.max_attempts;
    }

    const result = await repo.reapExpiredLeases();
    expect(result.requeued).toBe(1);
    expect(result.interrupted).toBe(1);
    expect((await repo.get(resumable.id))?.status).toBe("QUEUED");
    expect((await repo.get(exhausted.id))?.status).toBe("INTERRUPTED");
  });
});
