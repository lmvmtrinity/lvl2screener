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

const AUTO_PREFIX = "Auto qualification · ";

/** Automation runs are named `Auto qualification · <profile> · <profile
 * config version>`. The run's own `configVersion` is the scanner
 * configuration, which many profiles share, so the profile identity has to
 * come from the name. */
function autoRunParts(
  run: BacktestRun,
): { profile: string; profileVersion: string | null } | null {
  if (!run.name.startsWith(AUTO_PREFIX)) return null;
  const rest = run.name.slice(AUTO_PREFIX.length);
  const split = rest.lastIndexOf(" · ");
  return split < 0
    ? { profile: rest, profileVersion: null }
    : { profile: rest.slice(0, split), profileVersion: rest.slice(split + 3) };
}

/** Automation runs show only their profile name; the trailing profile config
 * version stays in technical details. Manual runs keep their full name. */
export function runDisplayName(run: BacktestRun): string {
  return autoRunParts(run)?.profile ?? run.name;
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
    const auto = autoRunParts(run);
    const key = auto
      ? `profile:${auto.profileVersion ?? auto.profile}`
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
