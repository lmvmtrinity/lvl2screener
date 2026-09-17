import { describe, expect, it } from "vitest";
import { CoverageInputLimitError } from "../src/backtests/research-coverage.js";
import {
  CategorizedError,
  type ClaimedResearchJob,
} from "../src/worker/research-worker.js";
import { CoverageVerificationJobHandler } from "../src/worker/handlers/coverage-verification-job-handler.js";

const payload = {
  request: {
    marketId: "CA_TSX",
    manifestHash: "d".repeat(64),
    inputCutoff: "2026-09-10T00:00:00.000Z",
    sessionDates: ["2026-09-09"],
  },
  manifest: { hash: "d".repeat(64), marketId: "CA_TSX", manifest: {} },
  engineRevision: "a".repeat(40),
  runtimeFingerprint: "b".repeat(64),
};

describe("coverage verification job handler", () => {
  it("fails an over-scoped coverage request as non-retryable VALIDATION", async () => {
    const handler = new CoverageVerificationJobHandler(
      {
        verifyInputs: async () => {
          throw new CoverageInputLimitError(6_000_000, 5_000_000);
        },
      } as never,
      { saveManifest: async () => undefined } as never,
      {} as never,
    );
    const job = {
      id: "10000000-0000-4000-8000-000000000001",
      leaseOwner: "worker-1",
      attemptCount: 1,
      requestPayload: payload,
    } as unknown as ClaimedResearchJob;
    const context = {
      jobId: job.id,
      heartbeat: async () => ({ cancellationRequested: false }),
    };

    const failure = await handler
      .execute(job, context)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CategorizedError);
    expect((failure as CategorizedError).category).toBe("VALIDATION");
    expect((failure as Error).message).toBe(
      "COVERAGE_INPUT_TOO_LARGE:6000000>5000000",
    );
  });
});
