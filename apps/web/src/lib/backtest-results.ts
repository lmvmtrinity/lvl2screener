import type { BacktestRun } from "@tsx-scanner/contracts";

export interface BacktestResultGroup {
  key: string;
  title: string;
  latest: BacktestRun;
  older: BacktestRun[];
}

function resultTimestamp(run: BacktestRun): number {
  return Date.parse(run.completedAt ?? run.startedAt ?? run.createdAt);
}

/** Automation runs record their profile name in the run name. The trailing
 * config version is redundant beside the configuration column, so it is kept
 * only for non-automation runs where the name carries no other identity. */
export function runDisplayName(run: BacktestRun): string {
  if (!run.name.startsWith("Auto qualification · ")) return run.name;
  const suffix = ` · ${run.configVersion}`;
  const base = run.name.endsWith(suffix)
    ? run.name.slice(0, -suffix.length)
    : run.name;
  return base.replace(/^Auto qualification · /, "");
}

/** How a run came to exist, joined from the automation work registry. */
export const TRIGGER_ORIGIN_LABELS: Record<string, string> = {
  PROFILE_SAVE: "profile save",
  SCHEDULED_CATCH_UP: "scheduled check",
  REFRESH_NOW: "manual action",
  EXPLICIT_EXPERIMENT: "explicit experiment",
  JOB_COMPLETION: "completed replay",
};

/**
 * Groups runs so the default surface shows one latest result per
 * configuration; every earlier attempt remains available beneath it. Automatic
 * qualification replays of the same profile configuration share a group, while
 * manual runs stay individually addressable by run id.
 */
export function groupBacktestResults(
  runs: readonly BacktestRun[],
): BacktestResultGroup[] {
  const groups = new Map<string, BacktestRun[]>();
  for (const run of runs) {
    const key = run.name.startsWith("Auto qualification · ")
      ? `config:${run.configVersion}`
      : `run:${run.id}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.entries()]
    .map(([key, members]) => {
      const sorted = [...members].sort(
        (left, right) => resultTimestamp(right) - resultTimestamp(left),
      );
      return {
        key,
        title: runDisplayName(sorted[0]!),
        latest: sorted[0]!,
        older: sorted.slice(1),
      };
    })
    .sort(
      (left, right) =>
        resultTimestamp(right.latest) - resultTimestamp(left.latest),
    );
}

export function executionLabel(run: BacktestRun): string {
  if (run.status === "COMPLETED") return "Completed";
  if (run.status === "FAILED") return "Failed";
  if (run.status === "INTERRUPTED") return "Interrupted";
  if (run.status === "RUNNING") return "Running";
  return "Pending";
}

export function executionTone(run: BacktestRun): string {
  if (run.status === "COMPLETED") return "ok";
  if (run.status === "FAILED" || run.status === "INTERRUPTED") return "bad";
  if (run.status === "RUNNING") return "pending";
  return "waiting";
}

export function evidenceLabel(run: BacktestRun): string {
  if (!run.evidence) return "Not assessed";
  if (run.evidence.qualification === "EVIDENCE_QUALIFIED") return "Qualified";
  return run.evidence.adequateSamples ? "Exploratory" : "Insufficient sample";
}

export function evidenceTone(run: BacktestRun): string {
  if (!run.evidence) return "waiting";
  if (run.evidence.qualification === "EVIDENCE_QUALIFIED") return "ok";
  return run.evidence.adequateSamples ? "warn" : "waiting";
}

/** Evaluated-through coverage plus a count of recorded exclusions/warnings,
 * which remain visible in the selected result's evidence details. */
export function coverageLabel(run: BacktestRun): string {
  const limitations =
    (run.dataQuality?.warnings.length ?? 0) +
    (run.evidence?.warnings.length ?? 0);
  return `through ${run.endDate}${
    limitations
      ? ` · ${limitations} limitation${limitations === 1 ? "" : "s"}`
      : ""
  }`;
}
