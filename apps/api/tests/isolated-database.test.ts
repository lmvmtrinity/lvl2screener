import { describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";

describe("isolated integration database configuration", () => {
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
