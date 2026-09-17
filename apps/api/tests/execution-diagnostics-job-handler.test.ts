import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedResearchJob,
  JobContext,
} from "../src/worker/research-worker.js";
import { ExecutionDiagnosticsJobHandler } from "../src/worker/handlers/execution-diagnostics-job-handler.js";

const job = (requestPayload: unknown): ClaimedResearchJob =>
  ({
    id: "10000000-0000-4000-8000-000000000951",
    jobType: "EXECUTION_DIAGNOSTICS",
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
    requestPayload,
    leaseOwner: "test",
  }) as ClaimedResearchJob;

const context = (cancel = false): JobContext => ({
  jobId: "10000000-0000-4000-8000-000000000951",
  heartbeat: vi.fn(async () => ({ cancellationRequested: cancel })),
});

describe("execution diagnostics job handler", () => {
  it("retains the immutable result and returns its report id", async () => {
    const saveExecutionDiagnostics = vi.fn(async () => ({
      id: "10000000-0000-4000-8000-000000000952",
      identity: {
        accountId: "10000000-0000-4000-8000-000000000953",
        marketId: "CA_TSX",
      },
    }));
    const handler = new ExecutionDiagnosticsJobHandler({
      saveExecutionDiagnostics,
    } as never);
    const result = await handler.execute(
      job({
        runId: "10000000-0000-4000-8000-000000000954",
        accountId: "10000000-0000-4000-8000-000000000953",
        marketId: "CA_TSX",
        mode: "RUN_END",
        reportVersion: "execution-diagnostics-v1",
      }),
      context(),
    );
    expect(result.resultRefId).toBe("10000000-0000-4000-8000-000000000952");
    expect(saveExecutionDiagnostics).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000954",
      { mode: "RUN_END", marketId: "CA_TSX" },
      "execution-diagnostics-v1",
    );
  });

  it("does not build a report after cancellation is observed", async () => {
    const saveExecutionDiagnostics = vi.fn();
    const handler = new ExecutionDiagnosticsJobHandler({
      saveExecutionDiagnostics,
    } as never);
    await expect(
      handler.execute(
        job({
          runId: "10000000-0000-4000-8000-000000000954",
          accountId: "10000000-0000-4000-8000-000000000953",
          marketId: "CA_TSX",
          mode: "RUN_END",
          reportVersion: "execution-diagnostics-v1",
        }),
        context(true),
      ),
    ).rejects.toThrow("Cancelled by request");
    expect(saveExecutionDiagnostics).not.toHaveBeenCalled();
  });
});
