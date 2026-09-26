import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

import { resolvePnpmCommand } from "../../scripts/lib/command-resolution.mjs";

const API_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(API_ROOT, "../..");
const TEST_ROOT = resolve(API_ROOT, "tests");
const DATABASE_ENVIRONMENT_KEYS = [
  "PERSISTENCE_TEST_DATABASE_URL",
  "AUDIT_TEST_DATABASE_URL",
];
const APP_DATABASE_ENVIRONMENT_KEYS = [
  ...DATABASE_ENVIRONMENT_KEYS,
  "REQUIRE_POSTGRES_INTEGRATION",
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGTARGETSESSIONATTRS",
];
const TEST_DATABASE_USERNAMES = new Set(["tsx_scanner", "tsx_test"]);

export function selectPostgresTestFiles(entries) {
  return entries
    .filter(
      ({ name, source }) =>
        !name.endsWith("/isolated-database.test.ts") &&
        source.includes("isolatedDatabaseUrl("),
    )
    .map(({ name }) => name)
    .sort();
}

export function withoutPostgresEnvironment(environment) {
  const unitEnvironment = { ...environment };
  for (const key of APP_DATABASE_ENVIRONMENT_KEYS) {
    delete unitEnvironment[key];
  }
  return unitEnvironment;
}

export function unitVitestArguments(
  vitestArguments,
  requestedUnitFiles,
  postgresFiles,
) {
  if (requestedUnitFiles.length > 0)
    return [...vitestArguments, ...requestedUnitFiles];
  return [
    ...vitestArguments,
    ...postgresFiles.flatMap((testFile) => ["--exclude", testFile]),
  ];
}

function isLoopback(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function isolatedTestUrl(value, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid explicit PostgreSQL test URL`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${key} must use the PostgreSQL protocol`);
  }
  if (!isLoopback(parsed.hostname)) {
    throw new Error(
      `${key} must connect to a local disposable PostgreSQL server`,
    );
  }
  if (!TEST_DATABASE_USERNAMES.has(decodeURIComponent(parsed.username))) {
    throw new Error(
      `${key} must use the tsx_scanner or tsx_test disposable test role`,
    );
  }
  if (!/^tsx_scanner_test(?:_[a-z0-9_]+)?$/u.test(databaseName)) {
    throw new Error(`${key} database name must start with tsx_scanner_test`);
  }
  return parsed;
}

export function databaseTargets(
  environment,
  runId = randomUUID().replaceAll("-", ""),
) {
  if (!/^[a-f0-9]{16,32}$/u.test(runId)) {
    throw new Error("runId must be a lower-case hexadecimal value");
  }
  let target;
  let sourceIdentity;
  for (const key of DATABASE_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (!value) continue;
    const parsed = isolatedTestUrl(value, key);
    const identity = [
      parsed.protocol,
      parsed.hostname,
      parsed.port || "5432",
      parsed.username,
      parsed.password,
    ].join("|");
    if (target) {
      if (sourceIdentity !== identity) {
        throw new Error(
          "PostgreSQL test URLs must use the same local server and disposable test role",
        );
      }
      continue;
    }
    sourceIdentity = identity;
    const isolatedUrl = new URL(value);
    const databaseName = `tsx_scanner_test_run_${runId}`;
    isolatedUrl.pathname = `/${databaseName}`;
    target = {
      adminConnectionString: value,
      connectionString: isolatedUrl.toString(),
      databaseName,
    };
  }
  if (!target) {
    throw new Error(
      "PERSISTENCE_TEST_DATABASE_URL or AUDIT_TEST_DATABASE_URL is required",
    );
  }
  return [target];
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function resetDatabase(target) {
  const client = new Client({ connectionString: target.adminConnectionString });
  await client.connect();
  try {
    const database = quoteIdentifier(target.databaseName);
    await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${database}`);
  } finally {
    await client.end();
  }
}

async function cleanupDatabase(target) {
  const client = new Client({ connectionString: target.adminConnectionString });
  await client.connect();
  try {
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(target.databaseName)} WITH (FORCE)`,
    );
  } finally {
    await client.end();
  }
}

async function testEntries() {
  async function collect(directory, relativeDirectory = "") {
    const children = await readdir(directory, { withFileTypes: true });
    const entries = await Promise.all(
      children.map(async (child) => {
        const relativePath = [relativeDirectory, child.name]
          .filter(Boolean)
          .join("/");
        const absolutePath = resolve(directory, child.name);
        if (child.isDirectory()) return collect(absolutePath, relativePath);
        if (!child.isFile() || !child.name.endsWith(".test.ts")) return [];
        return [
          {
            name: `tests/${relativePath}`,
            source: await readFile(absolutePath, "utf8"),
          },
        ];
      }),
    );
    return entries.flat();
  }
  return (await collect(TEST_ROOT)).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function parseArguments(argumentsList) {
  const options = {
    continueOnFailure: false,
    list: false,
    unitFiles: [],
    postgresFiles: [],
  };
  for (const argument of argumentsList) {
    if (argument === "--continue-on-failure") {
      options.continueOnFailure = true;
      continue;
    }
    if (argument === "--list") {
      options.list = true;
      continue;
    }
    const [key, value] = argument.split("=", 2);
    if (!value || !["--unit-file", "--postgres-file"].includes(key)) {
      throw new Error(
        "Usage: node apps/api/run-ci-tests.mjs [--list] [--continue-on-failure] [--unit-file=tests/name.test.ts] [--postgres-file=tests/name.test.ts]",
      );
    }
    options[key === "--unit-file" ? "unitFiles" : "postgresFiles"].push(value);
  }
  return options;
}

function selectFiles(entries, requested, predicate, label) {
  const available = new Set(entries.filter(predicate).map(({ name }) => name));
  const selected = requested.length === 0 ? [...available].sort() : requested;
  for (const name of selected) {
    if (!available.has(name)) {
      throw new Error(`${name} is not an available ${label} test file`);
    }
  }
  return selected;
}

async function run(command, args, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: environment,
      shell: process.platform === "win32",
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) =>
      resolveRun({ code: code ?? 1, signal }),
    );
  });
}

function postgresEnvironment(environment, target) {
  const testEnvironment = withoutPostgresEnvironment(environment);
  // Many suites accept either URL. Supplying one freshly created database for
  // both prevents a fallback path from escaping the current suite's isolation.
  for (const key of DATABASE_ENVIRONMENT_KEYS) {
    testEnvironment[key] = target.connectionString;
  }
  testEnvironment.REQUIRE_POSTGRES_INTEGRATION = "true";
  return testEnvironment;
}

async function main(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  const entries = await testEntries();
  const allPostgresFiles = selectPostgresTestFiles(entries);
  const postgresFileSet = new Set(allPostgresFiles);
  const unitFiles = selectFiles(
    entries,
    options.unitFiles,
    ({ name }) => !postgresFileSet.has(name),
    "non-PostgreSQL",
  );
  const postgresFiles = selectFiles(
    entries,
    options.postgresFiles,
    ({ name }) => postgresFileSet.has(name),
    "PostgreSQL",
  );
  if (options.list) {
    console.log(
      `API test enumeration: ${unitFiles.length} non-PostgreSQL files, ${postgresFiles.length} isolated PostgreSQL files.`,
    );
    for (const testFile of postgresFiles) console.log(testFile);
    return;
  }
  const targets = databaseTargets(process.env);
  const pnpm = resolvePnpmCommand();
  const vitest = [
    "--filter",
    "@tsx-scanner/api",
    "exec",
    "vitest",
    "run",
    "--no-file-parallelism",
  ];
  const failures = [];
  let unitPassed = false;
  let passedPostgresFiles = 0;

  try {
    console.log(`API non-PostgreSQL test files: ${unitFiles.length}`);
    if (unitFiles.length > 0) {
      console.log(
        "::group::API unit tests (PostgreSQL integration environment removed)",
      );
      const result = await run(
        pnpm,
        unitVitestArguments(vitest, options.unitFiles, allPostgresFiles),
        withoutPostgresEnvironment(process.env),
      );
      unitPassed = result.code === 0;
      console.log("::endgroup::");
      if (!unitPassed)
        failures.push(`non-PostgreSQL batch (exit ${result.code})`);
    } else {
      unitPassed = true;
    }

    if (unitPassed || options.continueOnFailure) {
      console.log(`API isolated PostgreSQL files: ${postgresFiles.length}`);
      for (const [index, testFile] of postgresFiles.entries()) {
        console.log(`::group::PostgreSQL acceptance: ${testFile}`);
        try {
          await resetDatabase(targets[0]);
          const result = await run(
            pnpm,
            [...vitest, testFile],
            postgresEnvironment(process.env, targets[0]),
          );
          if (result.code === 0) passedPostgresFiles += 1;
          else failures.push(`${testFile} (exit ${result.code})`);
        } catch (error) {
          failures.push(
            `${testFile} (${error instanceof Error ? error.message : String(error)})`,
          );
        } finally {
          console.log("::endgroup::");
        }
        if (failures.length > 0 && !options.continueOnFailure) break;
        if ((index + 1) % 10 === 0) {
          console.log(
            `API acceptance progress: ${index + 1}/${postgresFiles.length} PostgreSQL files processed.`,
          );
        }
      }
    }
  } finally {
    for (const target of targets) {
      try {
        await cleanupDatabase(target);
      } catch (error) {
        failures.push(
          `could not clean disposable database ${target.databaseName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const failedPostgresFiles = failures.filter((failure) =>
    failure.startsWith("tests/"),
  ).length;
  console.log(
    `API acceptance summary: unit batch ${unitPassed ? "passed" : "failed"} (${unitFiles.length} files); PostgreSQL ${passedPostgresFiles} passed, ${failedPostgresFiles} failed, ${Math.max(0, postgresFiles.length - passedPostgresFiles - failedPostgresFiles)} not run; total issues ${failures.length}.`,
  );
  for (const failure of failures) console.error(`- ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
