import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SynchronousJobHandler } from "../src/worker/handlers/synchronous-job-handler.js";
import {
  LeaseLostError,
  type ClaimedResearchJob,
  type ResearchJobRepository,
} from "../src/research-jobs/research-job-repository.js";
import {
  CancelledError,
  CategorizedError,
  ResearchWorker,
  type ResearchJobHandler,
} from "../src/worker/research-worker.js";

function claimed(
  overrides: Partial<ClaimedResearchJob> = {},
): ClaimedResearchJob {
  return {
    id: "job-1",
    jobType: "BACKTEST",
    status: "RUNNING",
    resultRefId: null,
    progress: {},
    error: null,
    errorCategory: null,
    attemptCount: 1,
    maxAttempts: 3,
    cancellationRequested: false,
    createdAt: "2026-08-28T00:00:00.000Z",
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: null,
    requestPayload: {},
    leaseOwner: "worker-a",
    ...overrides,
  };
}

function fakeRepository(job: ClaimedResearchJob | undefined) {
  const calls: string[] = [];
  const repo: Pick<
    ResearchJobRepository,
    | "claimNext"
    | "heartbeat"
    | "complete"
    | "fail"
    | "markCancelled"
    | "reapExpiredLeases"
  > = {
    claimNext: vi.fn(async () => job),
    heartbeat: vi.fn(async () => {
      calls.push("heartbeat");
      return { cancellationRequested: false };
    }),
    complete: vi.fn(async () => {
      calls.push("complete");
    }),
    fail: vi.fn(async () => {
      calls.push("fail");
    }),
    markCancelled: vi.fn(async () => {
      calls.push("markCancelled");
    }),
    reapExpiredLeases: vi.fn(async () => ({ requeued: 0, interrupted: 0 })),
  };
  return { repo, calls };
}

describe("ResearchWorker", () => {
  it("passes the durable job identity through synchronous handlers on retries", async () => {
    const execute = vi.fn(async () => ({ id: "result" }));
    const handler = new SynchronousJobHandler(z.object({}), execute);
    const job = claimed({ jobType: "CALIBRATION" });
    const context = {
      jobId: job.id,
      heartbeat: async () => ({ cancellationRequested: false }),
    };
    await handler.execute(job, context);
    await handler.execute({ ...job, attemptCount: 2 }, context);
    expect(execute.mock.calls).toEqual([
      [{}, job.id, 1],
      [{}, job.id, 2],
    ]);
  });
  it("claims a job, runs the matching handler, and marks it succeeded", async () => {
    const job = claimed();
    const { repo } = fakeRepository(job);
    const handler: ResearchJobHandler = {
      execute: vi.fn(async () => ({ resultRefId: "run-1" })),
    };
    const worker = new ResearchWorker(
      repo as unknown as ResearchJobRepository,
      { BACKTEST: handler },
      { ownerId: "worker-a" },
    );
    const claimedSomething = await worker.runOnce();
    expect(claimedSomething).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
    expect(repo.complete).toHaveBeenCalledWith("job-1", "worker-a", "run-1");
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it("only polls job types with a registered handler", async () => {
    const { repo } = fakeRepository(undefined);
    const worker = new ResearchWorker(
      repo as unknown as ResearchJobRepository,
      { BACKTEST: { execute: vi.fn() } },
      { ownerId: "worker-a" },
    );
    await worker.runOnce();
    expect(repo.claimNext).toHaveBeenCalledWith(
      ["BACKTEST"],
      "worker-a",
      expect.any(Number),
    );
  });

  it("records a categorized failure and lets the repository decide retry vs terminal", async () => {
    const job = claimed();
    const { repo, calls } = fakeRepository(job);
    const handler: ResearchJobHandler = {
      execute: vi.fn(async () => {
        throw new CategorizedError("HISTORY_UNAVAILABLE", "no captured quotes");
      }),
    };
    const worker = new ResearchWorker(
      repo as unknown as ResearchJobRepository,
      { BACKTEST: handler },
      { ownerId: "worker-a" },
    );
    await worker.runOnce();
    expect(calls).toEqual(["fail"]);
    expect(repo.fail).toHaveBeenCalledWith(
      "job-1",
      "worker-a",
      "no captured quotes",
      "HISTORY_UNAVAILABLE",
    );
  });

  it("marks a job cancelled instead of failed when the handler throws CancelledError", async () => {
    const job = claimed();
    const { repo, calls } = fakeRepository(job);
    const handler: ResearchJobHandler = {
      execute: vi.fn(async () => {
        throw new CancelledError();
      }),
    };
    const worker = new ResearchWorker(
      repo as unknown as ResearchJobRepository,
      { BACKTEST: handler },
      { ownerId: "worker-a" },
    );
    await worker.runOnce();
    expect(calls).toEqual(["markCancelled"]);
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it("stops touching a job whose lease was lost to another worker instead of double-writing", async () => {
    const job = claimed();
    const { repo, calls } = fakeRepository(job);
    const handler: ResearchJobHandler = {
      execute: vi.fn(async () => {
        throw new LeaseLostError(job.id);
      }),
    };
    const worker = new ResearchWorker(
      repo as unknown as ResearchJobRepository,
      { BACKTEST: handler },
      { ownerId: "worker-a" },
    );
    await worker.runOnce();
    expect(calls).toEqual([]); // neither complete, fail, nor markCancelled -- the other worker owns it now
  });

  it("gives a handler a way to observe cancellation via heartbeat and stop cleanly", async () => {
    const job = claimed();
    const { repo } = fakeRepository(job);
    repo.heartbeat = vi.fn(async () => ({ cancellationRequested: true }));
    const handler: ResearchJobHandler = {
      execute: vi.fn(async (_job, context) => {
        const { cancellationRequested } = await context.heartbeat({
          completedSessions: 1,
        });
        if (cancellationRequested) throw new CancelledError();
        return { resultRefId: "unreachable" };
      }),
    };
    const worker = new ResearchWorker(
      repo as unknown as ResearchJobRepository,
      { BACKTEST: handler },
      { ownerId: "worker-a" },
    );
    await worker.runOnce();
    expect(repo.markCancelled).toHaveBeenCalledWith("job-1", "worker-a");
  });

  it("invokes the settle hook after success, failure and cancellation", async () => {
    const settled: string[] = [];
    const onJobSettled = (job: ClaimedResearchJob) => {
      settled.push(`${job.id}:${job.jobType}`);
    };
    const successRepo = fakeRepository(claimed()).repo;
    await new ResearchWorker(
      successRepo as unknown as ResearchJobRepository,
      { BACKTEST: { execute: async () => ({ resultRefId: "run-1" }) } },
      { ownerId: "worker-a", onJobSettled },
    ).runOnce();
    const failureRepo = fakeRepository(claimed({ id: "job-2" })).repo;
    await new ResearchWorker(
      failureRepo as unknown as ResearchJobRepository,
      {
        BACKTEST: {
          execute: async () => {
            throw new CategorizedError("HISTORY_UNAVAILABLE", "no quotes");
          },
        },
      },
      { ownerId: "worker-a", onJobSettled },
    ).runOnce();
    const cancelRepo = fakeRepository(claimed({ id: "job-3" })).repo;
    await new ResearchWorker(
      cancelRepo as unknown as ResearchJobRepository,
      {
        BACKTEST: {
          execute: async () => {
            throw new CancelledError();
          },
        },
      },
      { ownerId: "worker-a", onJobSettled },
    ).runOnce();
    expect(settled).toEqual([
      "job-1:BACKTEST",
      "job-2:BACKTEST",
      "job-3:BACKTEST",
    ]);
  });

  it("does not fail a settled job when the settle hook throws", async () => {
    const { repo } = fakeRepository(claimed());
    const worker = new ResearchWorker(
      repo as unknown as ResearchJobRepository,
      { BACKTEST: { execute: async () => ({ resultRefId: "run-1" }) } },
      {
        ownerId: "worker-a",
        onJobSettled: () => {
          throw new Error("drain failed");
        },
      },
    );
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(repo.complete).toHaveBeenCalledWith("job-1", "worker-a", "run-1");
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it("stops the poll loop cleanly when stop() is called, without an unhandled rejection", async () => {
    const { repo } = fakeRepository(undefined);
    const worker = new ResearchWorker(
      repo as unknown as ResearchJobRepository,
      {},
      { ownerId: "worker-a", pollIntervalMs: 5, reapIntervalMs: 1_000 },
    );
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Reaching this line without the test timing out means stop() resolved and the loop exited.
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
