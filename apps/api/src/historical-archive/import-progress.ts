import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { readdir, readFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = join(tmpdir(), "historical-import-progress");
export interface ImportProgress {
  id: string;
  pid: number;
  kind: string;
  startDate: string;
  endDate: string;
  startedAt: string;
  updatedAt: string;
  status: "Planning" | "Running" | "Completed" | "Failed" | "Stopped";
  planned: number;
  completed: number;
  failed: number;
  skipped: number;
  rows: number;
  estimatedCostUsd: number;
  current: string;
  error?: string;
}
export function createImportProgress(
  kind: string,
  startDate: string,
  endDate: string,
) {
  const state: ImportProgress = {
    id: randomUUID(),
    pid: process.pid,
    kind,
    startDate,
    endDate,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "Planning",
    planned: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    rows: 0,
    estimatedCostUsd: 0,
    current: "Resolving instruments and estimating cost",
  };
  mkdirSync(directory, { recursive: true });
  const save = () => {
    state.updatedAt = new Date().toISOString();
    const path = join(directory, state.id + ".json");
    writeFileSync(path + ".tmp", JSON.stringify(state));
    renameSync(path + ".tmp", path);
  };
  save();
  return {
    state,
    save,
    event(line: Record<string, unknown>) {
      if (line.event === "plan") {
        state.status = "Running";
        state.planned = Number(line.plannedChunks);
        state.skipped = Number(line.skippedCoveredChunks);
        state.estimatedCostUsd = Number(line.estimatedCostUsd);
      }
      if (line.event === "imported") {
        state.completed++;
        state.rows += Number(line.inserted);
      }
      if (line.event === "failed") state.failed++;
      if (line.symbol)
        state.current = `${line.symbol} · ${line.schema ?? "cost estimate"} · ${line.from} through ${line.to}`;
      save();
    },
  };
}
export async function readImportProgress(): Promise<ImportProgress[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") files = [];
    else throw error;
  }
  const states: ImportProgress[] = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const state = JSON.parse(
        await readFile(join(directory, file), "utf8"),
      ) as ImportProgress;
      if (["Planning", "Running"].includes(state.status)) {
        try {
          process.kill(state.pid, 0);
          if (process.platform === "linux") {
            const command = await readFile(
              `/proc/${state.pid}/cmdline`,
              "utf8",
            );
            if (!command.includes("historical-import"))
              state.status = "Stopped";
          }
        } catch {
          state.status = "Stopped";
        }
      }
      states.push(state);
    } catch {
      /* An unreadable task record cannot establish task status. */
    }
  }
  states.push(...(await readLegacyProgress(states)));
  return states
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 30);
}

/** Compatibility for the operator's already-running step 2/3 commands. */
async function readLegacyProgress(
  tracked: ImportProgress[],
): Promise<ImportProgress[]> {
  if (process.platform !== "linux") return [];
  const processes: Array<{ pid: number; command: string }> = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const command = (
        await readFile(`/proc/${name}/cmdline`, "utf8")
      ).replaceAll("\0", " ");
      if (
        command.includes("node") &&
        command.includes("historical-import.js") &&
        !tracked.some((task) => task.pid === Number(name))
      )
        processes.push({ pid: Number(name), command });
    } catch {
      /* Processes can exit during enumeration. */
    }
  }
  const tasks: ImportProgress[] = [];
  for (const [flag, file, kind] of [
    ["--quotes-only", "/tmp/import-quotes.log", "Quotes (step 2)"],
    ["--bars-only", "/tmp/import-bars.log", "Bars (step 3)"],
  ]) {
    const running = processes.filter((item) => item.command.includes(flag!));
    let lines: Array<Record<string, unknown>> = [];
    let updatedAt = new Date().toISOString();
    let summary: Record<string, unknown> | undefined;
    try {
      const handle = await open(file!, "r");
      try {
        const stat = await handle.stat();
        updatedAt = stat.mtime.toISOString();
        const buffer = Buffer.alloc(Math.min(stat.size, 2_000_000));
        await handle.read(
          buffer,
          0,
          buffer.length,
          Math.max(0, stat.size - buffer.length),
        );
        const text = buffer.toString();
        const summaryStart = text.lastIndexOf('{\n  "event": "summary"');
        if (summaryStart >= 0) {
          try {
            summary = JSON.parse(text.slice(summaryStart));
          } catch {
            /* Incomplete summary remains unproven. */
          }
        }
        lines = buffer
          .toString()
          .split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as Record<string, unknown>];
            } catch {
              return [];
            }
          });
      } finally {
        await handle.close();
      }
    } catch {
      if (!running.length) continue;
    }
    const plan = lines.find((line) => line.event === "plan");
    const imported = lines.filter((line) => line.event === "imported");
    const failed = lines.filter((line) => line.event === "failed");
    const last = lines.at(-1);
    tasks.push({
      id: `legacy-${flag}`,
      pid: running[0]?.pid ?? 0,
      kind: kind!,
      startDate: running[0]?.command.match(/--start (\S+)/)?.[1] ?? "Unknown",
      endDate: running[0]?.command.match(/--end (\S+)/)?.[1] ?? "Unknown",
      startedAt: String(plan?.at ?? updatedAt),
      updatedAt,
      status: running.length
        ? plan
          ? "Running"
          : "Planning"
        : summary
          ? Array.isArray(summary.failed) && summary.failed.length
            ? "Failed"
            : "Completed"
          : "Stopped",
      planned: Number(plan?.plannedChunks ?? 0),
      completed: imported.length,
      failed: failed.length,
      skipped: Number(plan?.skippedCoveredChunks ?? 0),
      rows: imported.reduce((sum, line) => sum + Number(line.inserted ?? 0), 0),
      estimatedCostUsd: Number(plan?.estimatedCostUsd ?? 0),
      current: `${running.length > 1 ? `${running.length} processes running. ` : ""}Legacy log progress; counts cover available log entries. ${last?.symbol ?? ""}`,
    });
  }
  return tasks;
}
