import assert from "node:assert/strict";
import test from "node:test";
import { resolvePnpmCommand } from "../lib/command-resolution.mjs";

test("uses PNPM_CMD without embedding a workstation path", () => {
  assert.equal(
    resolvePnpmCommand({
      env: { PNPM_CMD: "D:/tools/pnpm.cmd" },
      platform: "win32",
      findOnPath: () => {
        throw new Error("PATH lookup should not run");
      },
    }),
    "D:/tools/pnpm.cmd",
  );
});

test("uses the first PATH result on Windows", () => {
  assert.equal(
    resolvePnpmCommand({
      env: {},
      platform: "win32",
      findOnPath: (command) =>
        command === "pnpm.cmd" ? ["C:/portable/pnpm.cmd"] : [],
    }),
    "C:/portable/pnpm.cmd",
  );
});

test("resolves pnpm on non-Windows platforms", () => {
  assert.equal(
    resolvePnpmCommand({
      env: {},
      platform: "linux",
      findOnPath: () => ["/usr/local/bin/pnpm"],
    }),
    "/usr/local/bin/pnpm",
  );
});

test("fails with an actionable message when pnpm is unavailable", () => {
  assert.throws(
    () =>
      resolvePnpmCommand({
        env: {},
        platform: "win32",
        findOnPath: () => [],
      }),
    /pnpm was not found on PATH; install pnpm or set PNPM_CMD/,
  );
});
