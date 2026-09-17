import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = process.env.E2E_COMPOSE_PROJECT ?? "tsx-scanner-e2e";
const databaseUser = "tsx_scanner";
const databaseName = "tsx_scanner_test_e2e";
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "tsx-scanner-e2e-"));
const environmentFile = resolve(temporaryDirectory, "empty.env");
writeFileSync(
  environmentFile,
  "# Isolated mock acceptance; do not load workstation .env\n",
);
const commandEnvironment = {
  ...process.env,
  WEB_PORT: process.env.E2E_WEB_PORT ?? "5174",
  API_HOST_PORT: process.env.E2E_API_PORT ?? "3100",
  SCANNER_HOST_PORT: process.env.E2E_SCANNER_PORT ?? "8100",
  POSTGRES_HOST_PORT: process.env.E2E_POSTGRES_PORT ?? "54432",
  E2E_BASE_URL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5174",
  E2E_SCANNER_URL: process.env.E2E_SCANNER_URL ?? "http://127.0.0.1:8100",
  // The repo-root .env is picked up by `docker compose` automatically and may set
  // these for live dev use. The e2e suite must always run against the mock
  // transport, so force them here regardless of what the shell or .env carries.
  MARKET_DATA_MODE: "mock",
  QUESTRADE_REFRESH_TOKEN: "",
  POSTGRES_USER: databaseUser,
  POSTGRES_DB: databaseName,
  POSTGRES_PASSWORD: "e2e_test_only",
  SCANNER_SERVICE_TOKEN: "e2e-test-only-scanner-token",
  ENABLED_MARKETS: "CA_TSX,US_EQUITIES",
  US_MARKET_DATA_ENABLED: "true",
  US_PAPER_TRADING_ENABLED: "true",
};
// W5: the default docker-compose.yml no longer publishes Postgres/scanner ports on the host (the
// default profile is localhost-only, see docker-compose.yml's top-of-file comment). The E2E suite
// still seeds Postgres via `docker compose exec` (no host port needed for that) but
// commissioning.spec.ts talks to the scanner's /health/ready directly over a host port, so layer
// the debug-ports override -- never used outside this harness or manual local development -- to
// republish just what this suite needs.
const dockerArguments = [
  "compose",
  "--env-file",
  environmentFile,
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.debug-ports.yml",
  "-p",
  project,
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: commandEnvironment,
    stdio:
      options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    input: options.input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status}`,
    );
}

let stackStarted = false;
try {
  stackStarted = true;
  run("docker", [
    ...dockerArguments,
    "up",
    "--build",
    "--detach",
    "--wait",
    "--wait-timeout",
    "240",
  ]);

  const seed = (fixture) =>
    run(
      "docker",
      [
        ...dockerArguments,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        databaseUser,
        "-d",
        databaseName,
      ],
      {
        input: readFileSync(
          resolve(root, "tests/e2e/fixtures", fixture),
          "utf8",
        ),
      },
    );

  const restartApi = () => {
    run("docker", [...dockerArguments, "restart", "api"]);
    run("docker", [
      ...dockerArguments,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "120",
    ]);
  };

  seed("ready-signal.sql");
  seed("paper-bot-evidence.sql");

  // Alerts are loaded from durable storage when the API starts. Restart it after
  // seeding so the browser sees exactly the same recovery path as production.
  //
  // This restart is also what drives the paper bot: the mock session is long
  // past its noon boundary, so the market is CLOSED and no live quote batch
  // arrives. Startup reconciliation and the overdue-run sweep are therefore
  // the only things that turn the seeded READY events into paper evidence --
  // which is precisely the durable recovery path that must hold.
  restartApi();

  // Second phase: reopen the crash window (an observation whose CANDLE child
  // was never written) and restart again, so the suite can assert that the
  // next startup repairs it rather than leaving the evidence half-recorded.
  seed("paper-bot-damage.sql");
  restartApi();

  run(process.execPath, [
    resolve(root, "node_modules/@playwright/test/cli.js"),
    "test",
    ...process.argv.slice(2),
  ]);
} catch (error) {
  if (stackStarted) {
    spawnSync("docker", [...dockerArguments, "ps", "--all"], {
      cwd: root,
      env: commandEnvironment,
      stdio: "inherit",
    });
    spawnSync(
      "docker",
      [...dockerArguments, "logs", "--no-color", "--tail", "200", "api"],
      { cwd: root, env: commandEnvironment, stdio: "inherit" },
    );
  }
  throw error;
} finally {
  if (stackStarted) {
    const cleanup = spawnSync(
      "docker",
      [...dockerArguments, "down", "--volumes", "--remove-orphans"],
      {
        cwd: root,
        env: commandEnvironment,
        stdio: "inherit",
      },
    );
    if (cleanup.error) console.error(cleanup.error);
    if (cleanup.status !== 0) process.exitCode = 1;
  }
  rmSync(environmentFile);
  rmdirSync(temporaryDirectory);
}
