import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`ok - ${label}`);
  } catch (error) {
    failures.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`FAIL - ${label}`);
  }
}

function command(commandName, args, env = process.env) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  if (result.status !== 0)
    throw new Error(
      `${commandName} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
    );
  return result.stdout;
}

const composeConfig = JSON.parse(
  command("docker", ["compose", "config", "--format", "json"]),
);
const apiEnvironment = composeConfig.services?.api?.environment ?? {};
const workerEnvironment = composeConfig.services?.worker?.environment ?? {};
// Test repository defaults separately from the operator's actual deployment.
// Shell values override --env-file, so remove all Compose interpolation keys
// from this child only. Never clear or print the user's funded account IDs.
const composeSource = await readFile(
  resolve(root, "docker-compose.yml"),
  "utf8",
);
const interpolationKeys = new Set(
  [...composeSource.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(
    (match) => match[1],
  ),
);
const templateEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !interpolationKeys.has(key)),
);
const defaultApiEnvironment = JSON.parse(
  command(
    "docker",
    ["compose", "--env-file", ".env.example", "config", "--format", "json"],
    templateEnvironment,
  ),
).services.api.environment;

check("default Compose configuration resolves", () => {
  assert.ok(composeConfig.services?.api);
  assert.ok(composeConfig.services?.postgres);
  assert.ok(composeConfig.services?.scanner);
});

check("funded account controls are owned by the API runtime", () => {
  for (const name of [
    "PAPER_FUNDED_CAD_ACCOUNT_ID",
    "PAPER_FUNDED_USD_ACCOUNT_ID",
    "PAPER_FUNDED_INITIAL_CASH_CAD",
    "PAPER_FUNDED_INITIAL_CASH_USD",
    "PAPER_FUNDED_DAILY_LOSS_LIMIT_CAD",
    "PAPER_FUNDED_DAILY_LOSS_LIMIT_USD",
  ]) {
    assert.ok(name in apiEnvironment, `${name} missing from api`);
    assert.equal(
      name in workerEnvironment,
      false,
      `${name} must not enable worker market processing`,
    );
  }
});

check("funded identities are disabled by default", () => {
  assert.equal(defaultApiEnvironment.PAPER_FUNDED_CAD_ACCOUNT_ID, "");
  assert.equal(defaultApiEnvironment.PAPER_FUNDED_USD_ACCOUNT_ID, "");
});

const migrationFiles = (await readdir(resolve(root, "database/init")))
  .filter((name) => /^\d{3}-.+\.sql$/.test(name))
  .map((name) => ({ name, version: Number(name.slice(0, 3)) }))
  .sort(
    (left, right) =>
      left.version - right.version || left.name.localeCompare(right.name),
  );
const migrationVersions = new Set(migrationFiles.map((file) => file.version));
const latestMigration = Math.max(...migrationVersions);

check(
  "database migrations include funded lookup indexes and research lineage",
  () => {
    assert.equal(latestMigration, 132);
    for (let version = 1; version <= latestMigration; version += 1)
      // 105 was reserved and never created; later applied migrations retain their numbers.
      if (version !== 105)
        assert.ok(
          migrationVersions.has(version),
          `missing migration ${version}`,
        );
    for (const required of [
      "064-paper-entry-order.sql",
      "066-paper-funded-account.sql",
      "069-paper-funded-facts.sql",
      "073-paper-evidence-corrected-regeneration.sql",
      "074-paper-evidence-research-qualification.sql",
      "075-paper-qualification-research-gates.sql",
      "076-paper-funded-operational-observability.sql",
      "077-paper-funded-provenance-guards.sql",
      "078-paper-qualification-label-boundaries.sql",
      "079-paper-funded-temporal-reporting.sql",
      "080-strategy-research-experiments.sql",
      "081-strategy-formation-evidence.sql",
      "082-paper-coordination-model-facts-update.sql",
      "083-calibration-holdout-selection.sql",
      "084-discovery-provider-budget.sql",
      "085-discovery-evidence.sql",
      "086-discovery-shadow-control.sql",
      "087-discovery-intake.sql",
      "088-funded-fact-lookup-indexes.sql",
      "089-research-evidence-lineage.sql",
      "090-evidence-automation.sql",
      "091-evidence-source-watermark.sql",
      "092-strategy-study.sql",
      "093-study-execution-authorization.sql",
      "094-strategy-study-report-prerequisite.sql",
      "095-challenger-observation.sql",
      "096-execution-diagnostics.sql",
      "097-research-evidence-owner-consistency.sql",
      "098-research-coverage-requests.sql",
      "099-study-session-authority.sql",
      "100-challenger-acceptance-records.sql",
      "101-challenger-label-availability.sql",
      "102-study-session-acceptance.sql",
      "103-challenger-integrity.sql",
      "104-study-execution-grants.sql",
      "106-coverage-request-identity.sql",
      "107-study-authority-revocation.sql",
      "108-research-evidence-write-guards.sql",
      "109-research-owner-market-immutability.sql",
      "110-discovery-tradingview-parity.sql",
      "111-discovery-parity-market-binding.sql",
      "112-funded-diagnostics-catchup-indexes.sql",
      "113-funded-fact-outcome-status-index.sql",
      "114-backtest-automation.sql",
      "115-backtest-automation-stages.sql",
      "116-funded-historical-automation-policy.sql",
      "117-backtest-automation-completion-trigger.sql",
      "118-backtest-automation-candidate-blocker.sql",
      "119-drop-manual-journal.sql",
      "120-discovery-attempt-diagnostics.sql",
      "121-statistical-dataset-derivation.sql",
      "122-funded-learning-evidence.sql",
      "123-funded-replay-checkpoints.sql",
      "124-funded-event-order-indexes.sql",
      "125-funded-ledger-checkpoints.sql",
      "126-funded-checkpoint-rate-counters.sql",
      "127-funded-decision-intent-boundary.sql",
      "128-funded-decision-refusal-source.sql",
      "129-funded-refusal-inbox-sidecar.sql",
      "130-funded-execution-datasets.sql",
      "131-funded-causal-provenance.sql",
      "132-funded-comparison-records.sql",
    ])
      assert.ok(
        migrationFiles.some((file) => file.name === required),
        `missing ${required}`,
      );
  },
);

const alerts = await readFile(
  resolve(root, "monitoring/paper-bot-alerts.yml"),
  "utf8",
);
const apiEntry = await readFile(resolve(root, "apps/api/src/index.ts"), "utf8");
const discoveryRoutes = await readFile(
  resolve(root, "apps/api/src/routes/discovery.ts"),
  "utf8",
);
const prometheus = await readFile(
  resolve(root, "monitoring/prometheus.yml"),
  "utf8",
);
const alertmanagerTemplate = await readFile(
  resolve(root, "monitoring/alertmanager.yml.template"),
  "utf8",
);
const ignored = await readFile(resolve(root, ".gitignore"), "utf8");

check("funded monitoring rules and market scrapes are present", () => {
  const alertNames = [...alerts.matchAll(/^\s+- alert: (\S+)/gm)].map(
    (match) => match[1],
  );
  assert.equal(alertNames.length, 28);
  for (const name of [
    "ScannerMetricsUnavailable",
    "PaperProcessingStalled",
    "FundedBacklogStalled",
    "FundedBacklogCritical",
    "ScannerPersistenceSeverelyDelayed",
    "FundedClosePendingStalled",
    "FundedRiskVetoPersistent",
    "FundedRecoveryFailure",
    "FundedCoverageGap",
    "FundedReconstructionBudgetFailure",
    "FundedReconstructionSlow",
    "FundedInboxDrainDeficit",
    "ScannerDiscoveryProviderMissing",
    "ScannerDiscoverySchedulerDegraded",
    "ScannerDiscoveryCatalogUnavailable",
    "ScannerDiscoveryQueueOverdue",
    "ScannerDiscoveryCoverageDeferred",
    "ScannerDiscoveryLatencyOverBudget",
    "ScannerDiscoveryRunFailed",
    "BacktestAutomationWorkFailed",
    "BacktestAutomationQueueStalled",
  ])
    assert.ok(alertNames.includes(name), `missing ${name}`);
  assert.match(prometheus, /marketId: \[CA_TSX\]/);
  assert.match(prometheus, /marketId: \[US_EQUITIES\]/);
  assert.match(alertmanagerTemplate, /__ALERTMANAGER_WEBHOOK_URL__/);
  assert.match(ignored, /monitoring\/alertmanager\.generated\.yml/);
});

check("discovery intake remains closed pending commissioning", () => {
  assert.equal(
    (apiEntry.match(/intakeEnabled:\s*false/g) ?? []).length,
    2,
    "both market schedulers must keep intakeEnabled false",
  );
  assert.equal(
    (apiEntry.match(/enabled:\s*false/g) ?? []).length,
    2,
    "both market intake workers must keep enabled false",
  );
  assert.match(
    discoveryRoutes,
    /AUTO_ADD is unavailable until market-specific commissioning approval/,
    "discovery routes must reject AUTO_ADD pending commissioning",
  );
});

check("repository acceptance guards pass", () => {
  command(process.execPath, [
    resolve(root, "scripts/verify-market-boundaries.mjs"),
  ]);
  command(process.execPath, [
    resolve(root, "scripts/verify-compose-trust-boundary.mjs"),
  ]);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} paper-bot deployment check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(
    "\nPaper-bot deployment preflight passed. External feed, receiver, credential, and hardware acceptance remain operator-owned gates.",
  );
}
