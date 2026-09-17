import { describe, expect, it } from "vitest";
import { StrategyStudyJobHandler } from "../src/worker/handlers/strategy-study-job-handler.js";

describe("StrategyStudyJobHandler", () => {
  it("rejects an unvalidated payload before constructing replay work", async () => {
    const handler = new StrategyStudyJobHandler(
      null as never,
      null as never,
      null as never,
      {} as never,
      null as never,
    );
    await expect(
      handler.execute(
        {
          id: "10000000-0000-4000-8000-000000000150",
          jobType: "STRATEGY_STUDY",
          status: "RUNNING",
          resultRefId: null,
          progress: {},
          error: null,
          errorCategory: null,
          attemptCount: 1,
          maxAttempts: 3,
          cancellationRequested: false,
          createdAt: "2026-09-10T00:00:00.000Z",
          startedAt: "2026-09-10T00:00:00.000Z",
          completedAt: null,
          requestPayload: {},
          leaseOwner: "worker",
        },
        {
          jobId: "job",
          heartbeat: async () => ({ cancellationRequested: false }),
        },
      ),
    ).rejects.toMatchObject({ category: "VALIDATION" });
  });
});
