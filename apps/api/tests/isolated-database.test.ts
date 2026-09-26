import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  isolatedDatabaseUrl,
  pauseHistoricalFixtureMaintenance,
} from "./isolated-database.js";

describe("isolated integration database configuration", () => {
  it("refuses maintenance changes outside a disposable database", async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ name: "tsx_scanner" }] });
    await expect(
      pauseHistoricalFixtureMaintenance({ query } as unknown as Pool),
    ).rejects.toThrow("disposable test database");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("waits for an already-started maintenance backend to exit", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ name: "tsx_scanner_test_fixture" }] })
      .mockResolvedValueOnce({ rows: [{ job_id: 1001 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ pid: 123 }] })
      .mockResolvedValueOnce({ rows: [] });
    await pauseHistoricalFixtureMaintenance({ query } as unknown as Pool);
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[3]?.[0]).toContain("pg_stat_activity");
    expect(query.mock.calls[4]?.[0]).toContain("pg_stat_activity");
  });

  const target = "postgresql://tester:secret@localhost:55439/tsx_scanner_test";
  it("does not fall back to application credentials", () => {
    expect(
      isolatedDatabaseUrl("TEST_URL", { DATABASE_URL: target }),
    ).toBeUndefined();
  });
  it("requires explicit configuration in CI", () => {
    expect(() =>
      isolatedDatabaseUrl("TEST_URL", { REQUIRE_POSTGRES_INTEGRATION: "true" }),
    ).toThrow("explicitly isolated");
  });
  it("rejects application database names", () => {
    expect(() =>
      isolatedDatabaseUrl("TEST_URL", {
        TEST_URL: target.replace("tsx_scanner_test", "tsx_scanner"),
      }),
    ).toThrow("database name");
  });
  it("rejects the same application target with different credentials", () => {
    expect(() =>
      isolatedDatabaseUrl("TEST_URL", {
        TEST_URL: target,
        DATABASE_URL: target.replace("tester:secret", "admin:other"),
      }),
    ).toThrow("application database");
  });
  it("accepts explicitly named disposable databases", () => {
    expect(isolatedDatabaseUrl("TEST_URL", { TEST_URL: target })).toBe(target);
  });
});
