import * as childProcess from "node:child_process";
import { once } from "node:events";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { QuestradeRateLimiter } from "../src/questrade/rate-limiter.js";
import { runCapacityScenario } from "./fixtures/discovery-capacity/full-market-scenarios.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe("discovery capacity fixture acquisition cleanup", () => {
  // Keep the evaluator process real; reject only SQL so no database is needed.
  // Removing acquisition cleanup must leave a live child or fake timers here.
  it.each(["BEFORE_TIMERS", "AFTER_TIMERS", "CLEANUP_REJECTS"] as const)(
    "releases the evaluator and timers when setup fails: %s",
    async (boundary) => {
      const pool = new Pool({
        connectionString:
          "postgresql://unused:unused@127.0.0.1:1/tsx_scanner_test_capacity_cleanup",
      });
      const setupFailure = new Error("capacity fixture setup rejected");
      const query = vi.spyOn(pool, "query").mockRejectedValue(setupFailure);
      if (boundary !== "BEFORE_TIMERS")
        query.mockImplementationOnce(async () => ({
          rows: [{ day: "2026-11-03" }],
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
        }));
      const spawned = vi.mocked(childProcess.spawn);
      spawned.mockClear();
      const cleanupFailure = new Error("capacity limiter cleanup rejected");
      const cancel = QuestradeRateLimiter.prototype.cancelPendingDiscovery;
      const cancellation =
        boundary === "CLEANUP_REJECTS"
          ? vi
              .spyOn(QuestradeRateLimiter.prototype, "cancelPendingDiscovery")
              .mockImplementation(function (this: QuestradeRateLimiter) {
                cancel.call(this);
                throw cleanupFailure;
              })
          : undefined;
      try {
        const result = runCapacityScenario(pool, { providerLatencyMs: 100 });
        if (boundary === "CLEANUP_REJECTS")
          await expect(result).rejects.toMatchObject({
            errors: [setupFailure, { errors: [cleanupFailure] }],
          });
        else await expect(result).rejects.toBe(setupFailure);
        expect(vi.isFakeTimers()).toBe(false);
        const evaluator = spawned.mock.results[0]?.value as
          childProcess.ChildProcess | undefined;
        expect(evaluator?.pid).toBeGreaterThan(0);
        expect(evaluator?.exitCode).toBe(0);
        expect(evaluator?.signalCode).toBeNull();
      } finally {
        // Test-owned fallback also cleans up the intentional RED run.
        vi.useRealTimers();
        for (const result of spawned.mock.results) {
          if (result.type !== "return") continue;
          const evaluator = result.value as childProcess.ChildProcess;
          if (evaluator.exitCode === null && evaluator.signalCode === null) {
            const exited = once(evaluator, "exit");
            evaluator.kill();
            await exited;
          }
        }
        cancellation?.mockRestore();
        spawned.mockClear();
        query.mockRestore();
        await pool.end();
      }
    },
    30_000,
  );
});
