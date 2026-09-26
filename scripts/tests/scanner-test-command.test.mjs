import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

test("root test:scanner command collects scanner tests", () => {
  const childEnv = { ...process.env };
  delete childEnv.PYTHONPATH;

  const result = spawnSync(pnpm, ["test:scanner", "--collect-only"], {
    cwd: root,
    encoding: "utf8",
    env: childEnv,
    shell: true,
  });

  assert.equal(
    result.status,
    0,
    `${result.error?.message ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
});
