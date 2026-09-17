import { execFileSync } from "node:child_process";

function systemPathLookup(command, platform) {
  const executable = platform === "win32" ? "where.exe" : "which";
  try {
    return execFileSync(executable, [command], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function resolvePnpmCommand({
  env = process.env,
  platform = process.platform,
  findOnPath = (command) => systemPathLookup(command, platform),
} = {}) {
  if (env.PNPM_CMD?.trim()) return env.PNPM_CMD.trim();
  const command = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const [resolved] = findOnPath(command);
  if (resolved) return resolved;
  throw new Error("pnpm was not found on PATH; install pnpm or set PNPM_CMD");
}
