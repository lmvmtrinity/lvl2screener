import assert from "node:assert/strict";
import test from "node:test";

import {
  databaseTargets,
  selectPostgresTestFiles,
  withoutPostgresEnvironment,
} from "../../apps/api/run-ci-tests.mjs";

test("selects stateful PostgreSQL suites without selecting the helper unit test", () => {
  assert.deepEqual(
    selectPostgresTestFiles([
      {
        name: "tests/ordinary.test.ts",
        source: 'describe("ordinary", () => {});',
      },
      {
        name: "tests/retention.test.ts",
        source: 'isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL")',
      },
      {
        name: "tests/isolated-database.test.ts",
        source: 'isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL")',
      },
    ]),
    ["tests/retention.test.ts"],
  );
});

test("removes PostgreSQL controls from the unit-test environment", () => {
  const environment = withoutPostgresEnvironment({
    PATH: "example",
    PERSISTENCE_TEST_DATABASE_URL: "postgresql://example/persistence",
    AUDIT_TEST_DATABASE_URL: "postgresql://example/audit",
    REQUIRE_POSTGRES_INTEGRATION: "true",
  });

  assert.deepEqual(environment, { PATH: "example" });
});

test("deduplicates and validates explicitly isolated database targets", () => {
  assert.deepEqual(
    databaseTargets({
      PERSISTENCE_TEST_DATABASE_URL:
        "postgresql://user:pass@localhost:5432/tsx_scanner_test",
      AUDIT_TEST_DATABASE_URL:
        "postgresql://user:pass@localhost:5432/tsx_scanner_test",
    }).map((target) => target.databaseName),
    ["tsx_scanner_test"],
  );

  assert.throws(
    () =>
      databaseTargets({
        PERSISTENCE_TEST_DATABASE_URL:
          "postgresql://user:pass@localhost:5432/production",
      }),
    /must start with tsx_scanner_test/u,
  );
});
