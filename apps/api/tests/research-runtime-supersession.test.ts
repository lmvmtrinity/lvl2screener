import { describe, expect, it } from "vitest";
import {
  challengerCoverageKey,
  challengerCoverageRuntimeDigest,
  inventoryRuntimeMismatchedJobs,
  legacyChallengerCoverageKey,
} from "../src/backtests/research-runtime-supersession.js";

const runtimeA = {
  engineRevision: "a".repeat(40),
  runtimeFingerprint: "b".repeat(64),
  featureVersion: "1.0.0",
};
const runtimeB = {
  engineRevision: "c".repeat(40),
  runtimeFingerprint: "d".repeat(64),
  featureVersion: "1.0.0",
};

describe("challenger coverage runtime-bound identity", () => {
  it("binds the new key to the frozen runtime digest", () => {
    const keyA = challengerCoverageKey("exp-1", "2026-09-10", runtimeA);
    const keyA2 = challengerCoverageKey("exp-1", "2026-09-10", runtimeA);
    const keyB = challengerCoverageKey("exp-1", "2026-09-10", runtimeB);
    expect(keyA).toBe(keyA2);
    expect(keyA).not.toBe(keyB);
    expect(keyA.startsWith("challenger-coverage:exp-1:2026-09-10:")).toBe(true);
    expect(challengerCoverageRuntimeDigest(runtimeA)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves the legacy key without reusing it", () => {
    const legacy = legacyChallengerCoverageKey("exp-1", "2026-09-10");
    const current = challengerCoverageKey("exp-1", "2026-09-10", runtimeA);
    expect(legacy).toBe("challenger-coverage:exp-1:2026-09-10");
    expect(current).not.toBe(legacy);
  });

  it("is idempotent per runtime (same digest, different cutoff still same key)", () => {
    // inputCutoff is intentionally excluded from the key so repeated polling
    // under one runtime resolves to one immutable request.
    const first = challengerCoverageKey("exp-1", "2026-09-10", runtimeA);
    const second = challengerCoverageKey("exp-1", "2026-09-10", {
      ...runtimeA,
    });
    expect(first).toBe(second);
  });
});

describe("pre-deployment runtime mismatch inventory (read-only)", () => {
  it("reports queued jobs bound to a different runtime", async () => {
    const rows = [
      {
        id: "job-current",
        job_type: "COVERAGE_VERIFICATION",
        status: "QUEUED",
        request_payload: {
          version: "coverage-verification-v2",
          requestId: "req-1",
          request: {
            manifest: { hash: "h", marketId: "CA_TSX" },
            recipe: {
              marketId: "CA_TSX",
              engineRevision: runtimeA.engineRevision,
              runtimeFingerprint: runtimeA.runtimeFingerprint,
            },
          },
        },
      },
      {
        id: "job-stale",
        job_type: "COVERAGE_VERIFICATION",
        status: "RUNNING",
        request_payload: {
          version: "coverage-verification-v2",
          requestId: "req-2",
          request: {
            manifest: { hash: "h", marketId: "CA_TSX" },
            recipe: {
              marketId: "CA_TSX",
              engineRevision: runtimeB.engineRevision,
              runtimeFingerprint: runtimeB.runtimeFingerprint,
            },
          },
        },
      },
    ];
    const pool = {
      query: async () => ({ rows }),
    } as never;
    const mismatched = await inventoryRuntimeMismatchedJobs(pool, runtimeA);
    expect(mismatched.map((item) => item.jobId)).toEqual(["job-stale"]);
    expect(mismatched[0]).toMatchObject({
      marketId: "CA_TSX",
      requestEngineRevision: runtimeB.engineRevision,
    });
  });

  it("never mutates jobs or evidence (read-only query only)", async () => {
    let queries = 0;
    const pool = {
      query: async (sql: string) => {
        queries += 1;
        expect(sql.trimStart().startsWith("SELECT")).toBe(true);
        return { rows: [] };
      },
    } as never;
    await inventoryRuntimeMismatchedJobs(pool, runtimeA);
    expect(queries).toBe(1);
  });
});
