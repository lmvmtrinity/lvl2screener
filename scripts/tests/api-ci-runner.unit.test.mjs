import assert from "node:assert/strict";
import test from "node:test";

import {
  databaseTargets,
  selectPostgresTestFiles,
  unitVitestArguments,
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
    DATABASE_URL: "postgresql://production/application",
    PERSISTENCE_TEST_DATABASE_URL: "postgresql://example/persistence",
    AUDIT_TEST_DATABASE_URL: "postgresql://example/audit",
    REQUIRE_POSTGRES_INTEGRATION: "true",
  });

  assert.deepEqual(environment, { PATH: "example" });
});

test("excludes PostgreSQL suites from the grouped unit run without a long file list", () => {
  assert.deepEqual(
    unitVitestArguments(
      ["vitest", "run", "--no-file-parallelism"],
      ["tests/unit.test.ts"],
      ["tests/db-one.test.ts", "tests/db-two.test.ts"],
    ),
    ["vitest", "run", "--no-file-parallelism", "tests/unit.test.ts"],
  );
  assert.deepEqual(
    unitVitestArguments(
      ["vitest", "run", "--no-file-parallelism"],
      [],
      ["tests/db-one.test.ts", "tests/db-two.test.ts"],
    ),
    [
      "vitest",
      "run",
      "--no-file-parallelism",
      "--exclude",
      "tests/db-one.test.ts",
      "--exclude",
      "tests/db-two.test.ts",
    ],
  );
});

test("creates a unique disposable database without targeting the supplied test database", () => {
  assert.deepEqual(
    databaseTargets(
      {
        PERSISTENCE_TEST_DATABASE_URL:
          "postgresql://tsx_test:test_only@localhost:5432/tsx_scanner_test",
        AUDIT_TEST_DATABASE_URL:
          "postgresql://tsx_test:test_only@localhost:5432/tsx_scanner_test_fixture",
      },
      "0123456789abcdef",
    ).map(({ databaseName }) => ({ databaseName })),
    [{ databaseName: "tsx_scanner_test_run_0123456789abcdef" }],
  );

  assert.throws(
    () =>
      databaseTargets({
        PERSISTENCE_TEST_DATABASE_URL:
          "postgresql://tsx_test:test_only@localhost:5432/production",
      }),
    /must start with tsx_scanner_test/u,
  );

  assert.throws(
    () =>
      databaseTargets({
        PERSISTENCE_TEST_DATABASE_URL:
          "postgresql://tsx_test:test_only@example.invalid:5432/tsx_scanner_test",
      }),
    /local disposable PostgreSQL server/u,
  );

  assert.throws(
    () =>
      databaseTargets({
        PERSISTENCE_TEST_DATABASE_URL:
          "postgresql://production_admin:secret@localhost:5432/tsx_scanner_test",
      }),
    /disposable test role/u,
  );
});
