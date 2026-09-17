import { cpus, totalmem, platform, release } from "node:os";
import { spawnSync } from "node:child_process";

const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Set PERSISTENCE_TEST_DATABASE_URL to an isolated tsx_scanner_test database",
  );
const parsed = new URL(databaseUrl);
if (
  !/^tsx_scanner_test(?:_[a-z0-9_]+)?$/.test(
    decodeURIComponent(parsed.pathname.slice(1)),
  )
)
  throw new Error("Benchmark refuses a non-test database name");
const environment = {
  ...process.env,
  REQUIRE_POSTGRES_INTEGRATION: "true",
  BENCHMARK_SYMBOLS: process.env.BENCHMARK_SYMBOLS ?? "200",
  BENCHMARK_CYCLES: process.env.BENCHMARK_CYCLES ?? "20",
};
const inspect = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
};
console.log(
  JSON.stringify({
    benchmarkHost: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    revision: inspect("git", ["rev-parse", "HEAD"]),
    worktreeStatus: inspect("git", ["status", "--short"]),
    runningContainers: inspect("docker", [
      "ps",
      "--format",
      "{{.Names}} {{.Image}}",
    ]),
    startedAt: new Date().toISOString(),
    symbols: environment.BENCHMARK_SYMBOLS,
    cycles: environment.BENCHMARK_CYCLES,
    mode: "single-test-file",
    notes:
      process.env.BENCHMARK_NOTES ??
      "No operator workload description provided",
  }),
);
const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "--filter",
    "@tsx-scanner/api",
    "exec",
    "vitest",
    "run",
    "tests/persistence-performance.test.ts",
    "--no-file-parallelism",
  ],
  {
    env: environment,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
