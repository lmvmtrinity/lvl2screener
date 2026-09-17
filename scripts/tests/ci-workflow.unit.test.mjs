import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("the PostgreSQL Node job installs the scanner Python runtime", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const nodeJob = workflow.slice(
    workflow.indexOf("  node:\n"),
    workflow.indexOf("  e2e:\n"),
  );

  assert.match(nodeJob, /uses: actions\/setup-python@v5/u);
  assert.match(nodeJob, /python -m pip install -e "services\/scanner\[dev\]"/u);
  assert.ok(
    nodeJob.indexOf("actions/setup-python@v5") <
      nodeJob.indexOf("node apps/api/run-ci-tests.mjs"),
  );
});

test("the PostgreSQL Node job isolates stateful API test files", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const nodeJob = workflow.slice(
    workflow.indexOf("  node:\n"),
    workflow.indexOf("  e2e:\n"),
  );

  assert.match(nodeJob, /node apps\/api\/run-ci-tests\.mjs/u);
  assert.doesNotMatch(
    nodeJob,
    /pnpm --filter @tsx-scanner\/api exec vitest run --no-file-parallelism/u,
  );
});
