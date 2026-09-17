import { spawn } from "node:child_process";
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

export function selectPostgresTestFiles(entries) {
  return entries
    .filter(
      ({ name, source }) =>
        name !== "tests/isolated-database.test.ts" &&
        source.includes("isolatedDatabaseUrl("),
    )
    .map(({ name }) => name)
    .sort();
}

export function withoutPostgresEnvironment(environment) {
  const unitEnvironment = { ...environment };
  for (const key of [
    ...DATABASE_ENVIRONMENT_KEYS,
    "REQUIRE_POSTGRES_INTEGRATION",
  ]) {
    delete unitEnvironment[key];
  }
  return unitEnvironment;
}

export function databaseTargets(environment) {
  const targets = [];
  const seen = new Set();
  for (const key of DATABASE_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (!value) continue;
    const parsed = new URL(value);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    if (!/^tsx_scanner_test(?:_[a-z0-9_]+)?$/u.test(databaseName)) {
      throw new Error(`${key} database name must start with tsx_scanner_test`);
    }
    const identity = [
      parsed.protocol,
      parsed.hostname,
      parsed.port || "5432",
      parsed.username,
      databaseName,
    ].join("|");
    if (seen.has(identity)) continue;
    seen.add(identity);
    const admin = new URL(parsed);
    admin.pathname = "/postgres";
    targets.push({
      adminConnectionString: admin.toString(),
      databaseName,
    });
  }
  if (targets.length === 0) {
    throw new Error(
      "PERSISTENCE_TEST_DATABASE_URL or AUDIT_TEST_DATABASE_URL is required",
    );
  }
  return targets;
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

async function testEntries() {
  const names = (await readdir(TEST_ROOT))
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name: `tests/${name}`,
      source: await readFile(resolve(TEST_ROOT, name), "utf8"),
    })),
  );
}

async function run(command, args, environment) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: environment,
      shell: process.platform === "win32",
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `Test command failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
          ),
        );
    });
  });
}

async function main() {
  const pnpm = resolvePnpmCommand();
  const vitest = [
    "--filter",
    "@tsx-scanner/api",
    "exec",
    "vitest",
    "run",
    "--no-file-parallelism",
  ];

  console.log("::group::API unit tests (PostgreSQL disabled)");
  await run(pnpm, vitest, withoutPostgresEnvironment(process.env));
  console.log("::endgroup::");

  const targets = databaseTargets(process.env);
  const postgresTests = selectPostgresTestFiles(await testEntries());
  for (const testFile of postgresTests) {
    console.log(`::group::PostgreSQL acceptance: ${testFile}`);
    for (const target of targets) await resetDatabase(target);
    await run(pnpm, [...vitest, testFile], process.env);
    console.log("::endgroup::");
  }

  console.log(
    `API CI passed: unit suite plus ${postgresTests.length} isolated PostgreSQL files.`,
  );
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
