import {
  backtestAutomationStatusSchema,
  fundedHistoricalAutomationPolicyListSchema,
  type BacktestAutomationBlockerReason,
  type BacktestAutomationStage,
  type BacktestAutomationStageKey,
  type BacktestAutomationStatus,
  type BacktestAutomationWork,
} from "@tsx-scanner/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getJson, sendJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { Drawer, Tip } from "../ui.js";
import { FundedReplayPolicyPanel } from "./FundedReplayPolicyPanel.js";

const AUTOMATION_SECONDARY =
  "tw:cursor-pointer tw:rounded-[7px] tw:border tw:border-line-input tw:bg-surface tw:px-[11px] tw:py-2 tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-250 tw:hover:border-line-accent tw:hover:text-accent";

const AUTOMATION_STATE_BASE =
  "tw:inline-block tw:rounded-full tw:border tw:px-[7px] tw:py-[3px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.05em]";
const AUTOMATION_STATE_TONES: Record<string, string> = {
  ok: "tw:border-[rgba(34,197,94,0.3)] tw:bg-[rgba(34,197,94,0.15)] tw:text-[#4ade80]",
  warn: "tw:border-line-warn tw:bg-surface-warn tw:text-warn-soft",
  bad: "tw:border-line-danger tw:bg-surface-danger tw:text-danger-tint-soft",
  pending: "tw:border-line",
  waiting: "tw:border-line tw:bg-surface-sunken tw:text-ink-250",
};

function automationState(tone: string): string {
  return classes(
    AUTOMATION_STATE_BASE,
    AUTOMATION_STATE_TONES[tone] ?? AUTOMATION_STATE_TONES.pending,
  );
}

const AUTOMATION_DOT_BASE = "tw:h-2 tw:w-2 tw:rounded-full";
const AUTOMATION_DOT_TONES: Record<string, string> = {
  ok: "tw:bg-accent",
  pending: "tw:bg-warn",
  bad: "tw:bg-danger",
};

const AUTOMATION_HEADLINE_TONES: Record<string, string> = {
  pending: "tw:text-accent-tint",
  ok: "tw:text-warn-soft",
  bad: "tw:text-danger-tint-soft",
  waiting: "",
};

const AUTOMATION_WORKS =
  "automation-works tw:mb-3 tw:w-full tw:border-collapse tw:text-[0.74rem] tw:below-900:block tw:below-900:overflow-x-auto";
const AUTOMATION_WORKS_TH =
  "tw:border-b tw:border-line tw:px-[10px] tw:py-2 tw:text-left tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:uppercase tw:text-ink-350";
const AUTOMATION_WORKS_TD =
  "tw:border-b tw:border-line tw:px-[10px] tw:py-[9px] tw:align-top";
const AUTOMATION_SUMMARY_DT =
  "tw:mb-[6px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:uppercase tw:text-ink-350";
const AUTOMATION_SUMMARY_DD = "tw:m-0 tw:text-[0.78rem]";
const REFRESH_AUTOMATION =
  "tw:cursor-pointer tw:rounded-[7px] tw:border tw:border-accent tw:bg-accent tw:px-[13px] tw:py-[10px] tw:font-mono tw:text-[0.63rem] tw:font-[750] tw:tracking-[0.07em] tw:text-on-accent tw:disabled:cursor-wait tw:disabled:opacity-50";
const AUTOMATION_SETTINGS_BLOCK =
  "automation-settings-block tw:mb-5 tw:border-b tw:border-line tw:pb-4 tw:last:mb-0 tw:last:border-b-0 tw:last:pb-0";

const MARKET_LABELS: Record<string, string> = {
  CA_TSX: "CA market",
  US_EQUITIES: "US market",
};

const BLOCKER_LABELS: Record<string, string> = {
  NO_CAPTURED_HISTORY: "not enough captured history yet",
  HISTORY_RANGE_UNAVAILABLE: "requested range is not fully captured",
  POLICY_VIOLATION: "policy input rejected",
  CAPACITY_LIMIT: "queued behind outstanding replays",
  NO_REPLAY_CANDIDATES: "waiting for replay candidates",
};

/**
 * Human explanation and available action per blocker reason. Actions are only
 * rendered when this component (or an optional callback prop) genuinely owns
 * them; nothing here bypasses capacity, policy or authorization gates.
 */
const BLOCKER_COPY: Record<
  BacktestAutomationBlockerReason,
  { title: string; detail: string }
> = {
  NO_CAPTURED_HISTORY: {
    title: "No captured history",
    detail:
      "Captured quote history does not cover this configuration's replay range yet. The replay starts automatically once enough sessions are captured.",
  },
  HISTORY_RANGE_UNAVAILABLE: {
    title: "Replay range not fully captured",
    detail:
      "Part of the configured range has no captured sessions, so a replay would not be comparable. It waits until the full range is captured.",
  },
  POLICY_VIOLATION: {
    title: "Profile configuration rejected",
    detail:
      "The saved profile no longer satisfies execution policy (for example slippage or fee limits). Correct the configuration, then queue a forced rerun; the work stays visible as requeued until the input is accepted again.",
  },
  CAPACITY_LIMIT: {
    title: "Waiting for capacity",
    detail:
      "This market's outstanding replay limit is full. Queued work starts automatically as running replays finish.",
  },
  NO_REPLAY_CANDIDATES: {
    title: "No replay candidates yet",
    detail:
      "The captured range resolves no candidate-bearing sessions yet. Replays evaluate the candidate daily list captured with each session, so work starts when a captured session contains candidates.",
  },
};

const BLOCKER_ORDER: BacktestAutomationBlockerReason[] = [
  "POLICY_VIOLATION",
  "CAPACITY_LIMIT",
  "NO_REPLAY_CANDIDATES",
  "NO_CAPTURED_HISTORY",
  "HISTORY_RANGE_UNAVAILABLE",
];

const ORIGIN_LABELS: Record<string, string> = {
  PROFILE_SAVE: "a profile save",
  SCHEDULED_CATCH_UP: "the scheduled check",
  REFRESH_NOW: "a forced rerun",
  EXPLICIT_EXPERIMENT: "an experiment",
  JOB_COMPLETION: "a completed replay",
};

const STAGE_ORDER: BacktestAutomationStageKey[] = [
  "COVERAGE",
  "CALIBRATION",
  "TRAINING",
  "STRATEGY_STUDY",
  "FUNDED_REPLAY",
];

const STAGE_LABELS: Record<string, string> = {
  COVERAGE: "Coverage",
  CALIBRATION: "Calibration",
  TRAINING: "Training",
  STRATEGY_STUDY: "Strategy study",
  FUNDED_REPLAY: "Funded replay",
};

const STAGE_STATE_LABELS: Record<string, string> = {
  WAITING_FOR_EVIDENCE: "WAITING",
  NOT_ELIGIBLE: "NOT ELIGIBLE",
  RETRY_SCHEDULED: "RETRY SCHEDULED",
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  FAILED: "FAILED",
  COMPLETED: "COMPLETED",
  SKIPPED: "SKIPPED",
};

const SCOPE_LABELS: Record<string, string> = {
  AUTOMATIC: "automatic",
  QUALIFICATION_OWNED: "qualification-owned",
  AUTHORIZATION_REQUIRED: "explicit authorization",
  POLICY_REQUIRED: "policy approval",
};

/**
 * One consistent user-facing state per configuration. Derived from both the
 * work row and its durable job so a cycle-level outcome can never contradict
 * live in-flight work.
 */
type WorkUiState =
  | "RUNNING"
  | "QUEUED"
  | "WAITING_CAPACITY"
  | "WAITING_DATA"
  | "RETRY_SCHEDULED"
  | "NEEDS_ACTION"
  | "FAILED"
  | "CANCELLED"
  | "UP_TO_DATE"
  | "IDLE";

const WORK_STATE_LABELS: Record<WorkUiState, string> = {
  RUNNING: "Running",
  QUEUED: "Queued",
  WAITING_CAPACITY: "Waiting for capacity",
  WAITING_DATA: "Waiting for data",
  RETRY_SCHEDULED: "Retry scheduled",
  NEEDS_ACTION: "Needs your action",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  UP_TO_DATE: "Up to date",
  IDLE: "No action recorded",
};

const WORK_STATE_TONES: Record<WorkUiState, string> = {
  RUNNING: "pending",
  QUEUED: "pending",
  WAITING_CAPACITY: "waiting",
  WAITING_DATA: "waiting",
  RETRY_SCHEDULED: "waiting",
  NEEDS_ACTION: "bad",
  FAILED: "bad",
  CANCELLED: "waiting",
  UP_TO_DATE: "ok",
  IDLE: "waiting",
};

interface WorkEntry {
  work: BacktestAutomationWork;
  state: WorkUiState;
}

interface ActivityEntry {
  key: string;
  at: string;
  text: string;
  tone: string;
}

interface WorkGroups {
  running: WorkEntry[];
  queued: WorkEntry[];
  waitingCapacity: WorkEntry[];
  waitingData: WorkEntry[];
  retrying: WorkEntry[];
  interventions: WorkEntry[];
  upToDate: WorkEntry[];
}

interface AutomationLead {
  text: string;
  tone: "ok" | "pending" | "waiting" | "bad";
  next: string;
}

/** Recent meaningful transitions derived from durable work and stage state.
 * Waiting/blocked rows stay in their own groups; this feed shows only start,
 * completion and failure events. */
function buildActivity(
  status: BacktestAutomationStatus | null,
): ActivityEntry[] {
  if (!status) return [];
  const entries: ActivityEntry[] = [];
  for (const work of status.works) {
    const name = configLabel(work);
    if (work.jobStatus === "RUNNING" || work.state === "RUNNING")
      entries.push({
        key: `${work.workKey}:started:${work.startedAt ?? work.updatedAt}`,
        at: work.startedAt ?? work.lastDispatchedAt ?? work.updatedAt,
        text: `${name} started`,
        tone: "pending",
      });
    else if (work.state === "SUCCEEDED" && work.lastSuccessAt)
      entries.push({
        key: `${work.workKey}:completed:${work.lastSuccessAt}`,
        at: work.lastSuccessAt,
        text: `${name} completed; results available`,
        tone: "ok",
      });
    else if (work.state === "FAILED" && work.lastFailureAt)
      entries.push({
        key: `${work.workKey}:failed:${work.lastFailureAt}`,
        at: work.lastFailureAt,
        text: `${name} failed`,
        tone: "bad",
      });
  }
  for (const stage of status.stages) {
    const name = `${stage.configName ?? "Unknown configuration"} · ${
      STAGE_LABELS[stage.stageKey] ?? stage.stageKey
    }`;
    if (stage.state === "RUNNING" || stage.state === "QUEUED")
      entries.push({
        key: `${stage.workKey}:${stage.stageKey}:started`,
        at: stage.updatedAt,
        text: `${name} stage started`,
        tone: "pending",
      });
    else if (stage.state === "COMPLETED" && stage.completedAt)
      entries.push({
        key: `${stage.workKey}:${stage.stageKey}:completed`,
        at: stage.completedAt,
        text: `${name} stage completed`,
        tone: "ok",
      });
    else if (stage.state === "FAILED")
      entries.push({
        key: `${stage.workKey}:${stage.stageKey}:failed`,
        at: stage.updatedAt,
        text: `${name} stage failed`,
        tone: "bad",
      });
  }
  return entries
    .filter((entry) => entry.at)
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 6);
}

function workUiState(work: BacktestAutomationWork): WorkUiState {
  if (work.jobStatus === "RUNNING") return "RUNNING";
  if (work.jobStatus === "QUEUED" || work.jobStatus === "CANCELLING")
    return "QUEUED";
  if (work.state === "RUNNING") return "RUNNING";
  if (work.state === "QUEUED") return "QUEUED";
  if (work.state === "FAILED") return "FAILED";
  if (work.state === "CANCELLED") return "CANCELLED";
  if (work.state === "RETRY_SCHEDULED") return "RETRY_SCHEDULED";
  if (work.blockerReason === "POLICY_VIOLATION") return "NEEDS_ACTION";
  if (work.blockerReason === "CAPACITY_LIMIT") return "WAITING_CAPACITY";
  if (
    work.blockerReason === "NO_CAPTURED_HISTORY" ||
    work.blockerReason === "HISTORY_RANGE_UNAVAILABLE" ||
    work.blockerReason === "NO_REPLAY_CANDIDATES"
  )
    return "WAITING_DATA";
  if (work.state === "SUCCEEDED") return "UP_TO_DATE";
  if (work.state === "WAITING") return "WAITING_CAPACITY";
  if (work.state === "BLOCKED") return "NEEDS_ACTION";
  return "IDLE";
}

function configLabel(work: BacktestAutomationWork): string {
  return work.configName ?? work.configVersion;
}

function timestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function relativeTime(value: string | null, now: number): string {
  if (!value) return "—";
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1_000));
  if (seconds < 45) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function elapsed(value: string | null, now: number): string {
  if (!value) return "—";
  const totalMinutes = Math.floor(
    Math.max(0, now - Date.parse(value)) / 60_000,
  );
  if (totalMinutes < 1) return "under a minute";
  if (totalMinutes < 60) return `${totalMinutes} min`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function waited(value: string | null, now: number): string {
  if (!value) return "unknown";
  const minutes = Math.floor(Math.max(0, now - Date.parse(value)) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function duration(value: number | null): string {
  if (value === null) return "—";
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function reasonText(codes: readonly string[]): string {
  if (!codes.length) return "—";
  return codes
    .map((code) => code.toLowerCase().replaceAll("_", " "))
    .join("; ");
}

function stageBadge(stage: BacktestAutomationStage): string {
  if (stage.state === "COMPLETED") return "ok";
  if (stage.state === "FAILED") return "bad";
  if (stage.state === "NOT_ELIGIBLE") return "warn";
  if (stage.state === "WAITING_FOR_EVIDENCE" || stage.state === "SKIPPED")
    return "waiting";
  return "pending";
}

/** Plain-language meaning of each stage state so the path is understandable
 * without opening the raw diagnostics table. */
function stageStateSentence(stage: BacktestAutomationStage): string {
  switch (stage.state) {
    case "WAITING_FOR_EVIDENCE":
      return "Waiting for the evidence this stage needs; it is not running.";
    case "NOT_ELIGIBLE":
      return stage.authorizationScope === "QUALIFICATION_OWNED"
        ? "Not eligible under the current evidence; the qualification process owns when it can run."
        : "Not eligible and not queued; it requires explicit authorization or an approved policy.";
    case "SKIPPED":
      return "Skipped for this configuration; no automatic action will run it.";
    case "RETRY_SCHEDULED":
      return "Retry scheduled after a failed attempt.";
    case "QUEUED":
      return "Queued; starts when prerequisites and capacity allow.";
    case "RUNNING":
      return "Running now.";
    case "FAILED":
      return stage.failureMessage ?? "Failed; see diagnostics for details.";
    case "COMPLETED":
      return stage.completedAt
        ? `Completed ${timestamp(stage.completedAt)}.`
        : "Completed.";
  }
}

/** The lead state answers "what is happening, why, and what happens next"
 * before any table or detail. It never claims progress the data cannot prove. */
function automationLead(
  status: BacktestAutomationStatus,
  groups: WorkGroups,
): AutomationLead {
  const check = status.nextCheckAt
    ? `Next automatic check ${timestamp(status.nextCheckAt)} (daily post-session catch-up).`
    : "No scheduled check is set.";
  const active = groups.running[0] ?? groups.queued[0];
  if (active) {
    const work = active.work;
    const completed = work.progress?.completedSessions ?? null;
    const total = work.progress?.totalSessions ?? null;
    const runningNow = groups.running.length > 0;
    return {
      text:
        runningNow && total !== null && completed !== null
          ? `Running: ${configLabel(work)} ${Math.min(completed + 1, total)}/${total} sessions`
          : `${runningNow ? "Running" : "Queued"}: ${configLabel(work)}`,
      tone: runningNow ? "pending" : "waiting",
      next: `Waiting work starts automatically as slots free. ${check}`,
    };
  }
  if (!status.enabled)
    return {
      text: "Automation paused",
      tone: "waiting",
      next: status.works.length
        ? "Scheduled checks are off. Waiting work starts from a profile save or a forced rerun in automation settings."
        : "Scheduled checks are off. Turn them on in automation settings to evaluate new work automatically.",
    };
  if (groups.interventions.length)
    return {
      text: "Action required",
      tone: "bad",
      next: `Correct the flagged configuration, then use Force rerun in automation settings. ${check}`,
    };
  if (groups.waitingCapacity.length)
    return {
      text: "Waiting for capacity",
      tone: "waiting",
      next: `Queued work starts as running replays finish. ${check}`,
    };
  if (groups.waitingData.length)
    return {
      text: "Waiting for captured sessions",
      tone: "waiting",
      next: status.lastSuccessEvaluatedThrough
        ? `Waiting for sessions captured after ${status.lastSuccessEvaluatedThrough} to cover the replay range. ${check}`
        : `Waiting for captured sessions to cover the replay range. ${check}`,
    };
  if (groups.retrying.length)
    return {
      text: "Retry scheduled",
      tone: "waiting",
      next: `Failed work retries automatically. ${check}`,
    };
  if (groups.upToDate.length)
    return { text: "Up to date", tone: "ok", next: `Nothing is due. ${check}` };
  if (status.lastCycle?.outcome === "NO_CHANGES")
    return {
      text: "Up to date",
      tone: "ok",
      next: `The last check found no changes. ${check}`,
    };
  return {
    text: "No qualification work recorded yet",
    tone: "waiting",
    next: `Save a profile or use Check for new work to evaluate this market. ${check}`,
  };
}

function waitingDetail(entry: WorkEntry): string {
  const { work, state } = entry;
  if (state === "RETRY_SCHEDULED")
    return `retry ${work.retryCount} scheduled for ${timestamp(work.nextAttemptAt)}`;
  if (state === "WAITING_DATA")
    return work.blockerReason
      ? (BLOCKER_LABELS[work.blockerReason] ?? "waiting for captured data")
      : "waiting for captured data";
  if (work.lastSuccessAt)
    return `last result ${timestamp(work.lastSuccessAt)} · waiting since ${timestamp(work.waitingSince ?? work.lastDispatchedAt)}`;
  return `waiting since ${timestamp(work.waitingSince ?? work.lastDispatchedAt)}`;
}

function ActiveJobCard({ entry, now }: { entry: WorkEntry; now: number }) {
  const { work, state } = entry;
  const running = state === "RUNNING";
  const startedAt = work.startedAt ?? work.lastDispatchedAt;
  const progress = work.progress;
  const total = progress?.totalSessions ?? null;
  const completed = progress?.completedSessions ?? null;
  const measurable = total !== null && completed !== null;
  const percent = measurable ? Math.round((completed / total) * 100) : 0;
  return (
    <article
      className={classes(
        "automation-active tw:mx-[22px] tw:my-[14px] tw:rounded-[10px] tw:border tw:border-line-accent-dim tw:border-l-[3px] tw:bg-surface-raised tw:px-4 tw:py-[14px]",
        running ? "tw:border-l-accent" : "tw:border-l-line-dim",
      )}
      aria-label="Active replay"
    >
      <div className="automation-active-head tw:flex tw:flex-wrap tw:items-center tw:gap-[10px]">
        <span
          className={classes(
            "automation-state",
            automationState(WORK_STATE_TONES[state]),
          )}
        >
          {WORK_STATE_LABELS[state]}
        </span>
        <strong className="tw:text-[0.95rem] tw:text-ink-50">
          {configLabel(work)}
        </strong>
        <span className="automation-active-stage tw:text-[0.75rem] tw:text-ink-300">
          {running
            ? "replaying captured sessions"
            : "starts when capacity frees"}
        </span>
      </div>
      {running && measurable ? (
        <div className="automation-progress tw:mt-3 tw:grid tw:gap-[6px]">
          <div
            className="automation-progress-track tw:h-2 tw:overflow-hidden tw:rounded-full tw:bg-surface-sunken"
            role="progressbar"
            aria-label="Session progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={completed}
          >
            <div
              className="tw:h-full tw:bg-accent"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="tw:text-[0.74rem] tw:text-ink-200">
            Session {Math.min(completed + 1, total)} of {total} · {completed}{" "}
            completed · elapsed {elapsed(startedAt, now)}
          </span>
        </div>
      ) : (
        <p className="automation-active-stage-line tw:mx-0 tw:mt-[10px] tw:mb-0 tw:text-[0.76rem] tw:text-ink-200">
          {running
            ? `Current stage: ${progress?.message ?? "starting the replay"}`
            : "Waiting work starts automatically as capacity becomes available."}
          {running && startedAt ? ` · elapsed ${elapsed(startedAt, now)}` : ""}
        </p>
      )}
      <p className="automation-active-meta tw:mx-0 tw:mt-2 tw:mb-0 tw:text-[0.7rem] tw:text-ink-350">
        {running
          ? work.heartbeatAt
            ? `Last progress ${relativeTime(work.heartbeatAt, now)}`
            : "No progress reported yet"
          : `Triggered by ${ORIGIN_LABELS[work.triggerOrigin] ?? work.triggerOrigin}`}
        {running && work.triggerOrigin
          ? ` · started by ${ORIGIN_LABELS[work.triggerOrigin] ?? work.triggerOrigin}`
          : ""}
      </p>
    </article>
  );
}

function WaitingGroup({
  label,
  entries,
  now,
}: {
  label: string;
  entries: WorkEntry[];
  now: number;
}) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const oldest = entries.reduce<string | null>((current, entry) => {
    const value = entry.work.waitingSince ?? entry.work.updatedAt;
    return !current || value < current ? value : current;
  }, null);
  return (
    <section
      className="automation-waiting-group tw:mx-[22px] tw:mt-0 tw:mb-[10px] tw:overflow-hidden tw:rounded-[8px] tw:border tw:border-line"
      aria-label={label}
    >
      <div className="automation-waiting-head tw:flex tw:flex-wrap tw:items-center tw:gap-[10px] tw:bg-surface-sunken tw:px-3 tw:py-[10px] tw:text-[0.74rem]">
        <span
          className={classes("automation-state", automationState("waiting"))}
        >
          {label}
        </span>
        <strong className="tw:text-ink-100">
          {entries.length}{" "}
          {entries.length === 1 ? "configuration" : "configurations"}
        </strong>
        <span className="automation-waiting-age tw:text-ink-350">
          oldest waiting {waited(oldest, now)}
        </span>
        <button
          type="button"
          className={classes(
            "automation-secondary",
            AUTOMATION_SECONDARY,
            "tw:ml-auto",
          )}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide configurations" : "View configurations"}
        </button>
      </div>
      {open && (
        <ul className="automation-waiting-list tw:m-0 tw:list-none tw:px-3 tw:pt-1 tw:pb-[10px]">
          {entries.map((entry) => (
            <li
              className="tw:flex tw:flex-wrap tw:justify-between tw:gap-x-3 tw:gap-y-1 tw:border-t tw:border-line-subtle tw:py-[7px] tw:text-[0.73rem]"
              key={entry.work.workKey}
            >
              <strong className="tw:text-ink-150">
                {configLabel(entry.work)}
              </strong>
              <span className="tw:text-ink-350">{waitingDetail(entry)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BlockerExplanations({
  blockers,
  onOpenSettings,
  onOpenUniverse,
}: {
  blockers: { reason: BacktestAutomationBlockerReason; count: number }[];
  onOpenSettings: () => void;
  onOpenUniverse?: () => void;
}) {
  if (!blockers.length) return null;
  return (
    <section
      className="automation-blockers tw:mx-[22px] tw:mt-0 tw:mb-[14px]"
      aria-label="Why work is waiting"
    >
      <strong className="automation-blockers-title tw:mb-2 tw:block tw:text-[0.8rem] tw:text-ink-200">
        Why work is waiting
      </strong>
      <ul className="tw:m-0 tw:grid tw:list-none tw:gap-2 tw:p-0">
        {blockers.map(({ reason, count }) => {
          const copy = BLOCKER_COPY[reason];
          return (
            <li
              className="automation-blocker tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-start tw:gap-[10px] tw:rounded-[8px] tw:border tw:border-line tw:border-l-[3px] tw:border-l-line-warn tw:bg-surface-sunken tw:px-3 tw:py-[10px] tw:text-[0.74rem] tw:below-720:grid-cols-[1fr]"
              key={reason}
            >
              <span
                className={classes(
                  "automation-state",
                  automationState("waiting"),
                )}
              >
                {count} {count === 1 ? "work item" : "work items"}
              </span>
              <div>
                <strong className="tw:block tw:text-ink-100">
                  {copy.title}
                </strong>
                <span className="tw:leading-[1.45] tw:text-ink-300">
                  {copy.detail}
                </span>
              </div>
              <div className="automation-blocker-actions tw:flex tw:items-center tw:gap-2">
                {(reason === "CAPACITY_LIMIT" ||
                  reason === "POLICY_VIOLATION") && (
                  <button
                    type="button"
                    className={AUTOMATION_SECONDARY}
                    onClick={onOpenSettings}
                  >
                    {reason === "POLICY_VIOLATION"
                      ? "Review & rerun"
                      : "Open automation settings"}
                  </button>
                )}
                {reason === "NO_REPLAY_CANDIDATES" && onOpenUniverse && (
                  <button
                    type="button"
                    className={AUTOMATION_SECONDARY}
                    onClick={onOpenUniverse}
                  >
                    Open universe & daily list
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StageProgression({ stages }: { stages: BacktestAutomationStage[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, BacktestAutomationStage[]>();
    for (const stage of stages)
      map.set(stage.workKey, [...(map.get(stage.workKey) ?? []), stage]);
    return [...map.entries()].map(([workKey, group]) => ({
      workKey,
      name: group[0]?.configName ?? "Unknown configuration",
      byKey: new Map(group.map((stage) => [stage.stageKey, stage])),
    }));
  }, [stages]);
  if (!groups.length) return null;
  return (
    <section
      className="automation-stages tw:mx-[22px] tw:mt-0 tw:mb-[14px]"
      aria-label="Stage progression"
    >
      <strong className="automation-stages-title tw:mb-1 tw:block tw:text-[0.8rem] tw:text-ink-200">
        Stage progression
      </strong>
      <p className="automation-stages-note tw:mx-0 tw:mt-1 tw:mb-[10px] tw:text-[0.72rem] tw:text-ink-350">
        Stages are evaluated in order after a completed baseline, but this is
        not a single path to activation: each stage has its own evidence and
        authorization gate. Calibration and strategy studies require explicit
        authorization, training is owned by the qualification process, and
        funded replay requires an approved policy.
      </p>
      {groups.map((group) => (
        <div className="automation-stage-path tw:mt-[10px]" key={group.workKey}>
          <strong className="automation-stage-path-name tw:mb-[6px] tw:block tw:text-[0.78rem] tw:text-ink-150">
            {group.name}
          </strong>
          <ol className="automation-stage-steps tw:m-0 tw:grid tw:list-none tw:gap-[6px] tw:p-0">
            {STAGE_ORDER.map((stageKey) => {
              const stage = group.byKey.get(stageKey);
              if (!stage)
                return (
                  <li
                    className="automation-stage-step unrecorded tw:grid tw:grid-cols-[110px_minmax(0,1fr)] tw:items-start tw:gap-[10px] tw:rounded-[8px] tw:border tw:border-dashed tw:border-line tw:bg-transparent tw:px-3 tw:py-[9px] tw:below-720:grid-cols-[1fr]"
                    key={stageKey}
                  >
                    <span
                      className={classes(
                        "automation-state tw:justify-self-start",
                        automationState("waiting"),
                      )}
                    >
                      NOT RECORDED
                    </span>
                    <div className="tw:grid tw:gap-[3px]">
                      <strong className="tw:text-[0.78rem] tw:text-ink-150">
                        {STAGE_LABELS[stageKey]}
                      </strong>
                      <span className="tw:text-[0.7rem] tw:leading-[1.45] tw:text-ink-350">
                        Not evaluated for this configuration yet.
                      </span>
                    </div>
                  </li>
                );
              return (
                <li
                  className="automation-stage-step tw:grid tw:grid-cols-[110px_minmax(0,1fr)] tw:items-start tw:gap-[10px] tw:rounded-[8px] tw:border tw:border-solid tw:border-line tw:bg-surface tw:px-3 tw:py-[9px] tw:below-720:grid-cols-[1fr]"
                  key={stageKey}
                >
                  <span
                    className={classes(
                      "automation-state tw:justify-self-start",
                      automationState(stageBadge(stage)),
                    )}
                  >
                    {STAGE_STATE_LABELS[stage.state] ?? stage.state}
                  </span>
                  <div className="tw:grid tw:gap-[3px]">
                    <strong className="tw:text-[0.78rem] tw:text-ink-150">
                      {STAGE_LABELS[stageKey]}
                    </strong>
                    <span className="automation-stage-scope tw:font-mono tw:text-[0.7rem] tw:font-bold tw:leading-[1.45] tw:tracking-[0.06em] tw:text-ink-400 tw:uppercase">
                      {SCOPE_LABELS[stage.authorizationScope] ??
                        stage.authorizationScope}
                    </span>
                    <span className="tw:text-[0.7rem] tw:leading-[1.45] tw:text-ink-350">
                      {stageStateSentence(stage)}
                    </span>
                    {stage.nextAttemptAt && (
                      <span className="automation-stage-next tw:font-mono tw:text-[0.7rem] tw:leading-[1.45] tw:text-ink-400">
                        Next attempt {timestamp(stage.nextAttemptAt)}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </section>
  );
}

function IssueRow({
  entry,
  tone,
  label,
}: {
  entry: WorkEntry;
  tone: string;
  label: string;
}) {
  const { work } = entry;
  return (
    <div className="automation-issue tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-[10px] tw:rounded-[8px] tw:border tw:border-line-danger tw:bg-surface-danger tw:px-3 tw:py-[10px] tw:text-[0.74rem]">
      <span className={classes("automation-state", automationState(tone))}>
        {label}
      </span>
      <div>
        <strong className="tw:block tw:text-ink-100">
          {configLabel(work)}
        </strong>
        <span className="tw:text-ink-250">
          {work.failureMessage ??
            (work.state === "BLOCKED"
              ? "The recorded policy no longer accepts the automation input."
              : "No failure detail was recorded.")}
        </span>
      </div>
    </div>
  );
}

export function BacktestAutomationPanel({
  marketId = "CA_TSX",
  onRefreshed,
  onStatusChange,
  onOpenUniverse,
}: {
  marketId?: "CA_TSX" | "US_EQUITIES";
  onRefreshed?: () => void;
  onStatusChange?: (status: BacktestAutomationStatus) => void;
  onOpenUniverse?: () => void;
}) {
  const [status, setStatus] = useState<BacktestAutomationStatus | null>(null);
  const [activePolicies, setActivePolicies] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const parsed = backtestAutomationStatusSchema.parse(
        await getJson(
          `/api/backtest-automation/status?marketId=${encodeURIComponent(marketId)}`,
        ),
      );
      setStatus(parsed);
      onStatusChange?.(parsed);
      setError("");
    } catch (reason) {
      // Keep the previous status visible so a transient failure does not blank
      // the automation surface.
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to load automation status",
      );
    } finally {
      setLoading(false);
    }
  }, [marketId, onStatusChange]);

  const loadPolicies = useCallback(async () => {
    try {
      const parsed = fundedHistoricalAutomationPolicyListSchema.parse(
        await getJson(
          `/api/funded-historical-policies?marketId=${encodeURIComponent(marketId)}`,
        ),
      );
      const current = Date.now();
      setActivePolicies(
        parsed.policies.filter(
          (policy) =>
            !policy.revokedAt && Date.parse(policy.expiresAt) > current,
        ).length,
      );
    } catch {
      setActivePolicies(0);
    }
  }, [marketId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // Keep the overview and activity feed current while work is in flight without
  // remounting the panel, so scroll position and focus are preserved.
  useEffect(() => {
    const live = (status?.works ?? []).some(
      (work) =>
        work.state === "RUNNING" ||
        work.state === "QUEUED" ||
        work.jobStatus === "RUNNING" ||
        work.jobStatus === "QUEUED",
    );
    if (!live) return;
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [status, load]);

  const entries = useMemo<WorkEntry[]>(
    () =>
      (status?.works ?? []).map((work) => ({
        work,
        state: workUiState(work),
      })),
    [status],
  );
  const byState = useMemo(() => {
    const groups = new Map<WorkUiState, WorkEntry[]>();
    for (const entry of entries)
      groups.set(entry.state, [...(groups.get(entry.state) ?? []), entry]);
    return groups;
  }, [entries]);
  const running = byState.get("RUNNING") ?? [];
  const queued = byState.get("QUEUED") ?? [];
  const waitingCapacity = byState.get("WAITING_CAPACITY") ?? [];
  const waitingData = byState.get("WAITING_DATA") ?? [];
  const retrying = byState.get("RETRY_SCHEDULED") ?? [];
  const needsAction = byState.get("NEEDS_ACTION") ?? [];
  const failed = byState.get("FAILED") ?? [];
  const upToDate = byState.get("UP_TO_DATE") ?? [];
  const active = running[0] ?? queued[0];
  const interventions = [...needsAction, ...failed];
  const groups = useMemo<WorkGroups>(
    () => ({
      running,
      queued,
      waitingCapacity,
      waitingData,
      retrying,
      interventions,
      upToDate,
    }),
    [
      running,
      queued,
      waitingCapacity,
      waitingData,
      retrying,
      interventions,
      upToDate,
    ],
  );
  const lead = useMemo(
    () => (status ? automationLead(status, groups) : null),
    [status, groups],
  );
  const blockers = useMemo(() => {
    if (!status) return [];
    const counts = new Map<BacktestAutomationBlockerReason, number>();
    for (const work of status.works)
      if (work.blockerReason)
        counts.set(
          work.blockerReason,
          (counts.get(work.blockerReason) ?? 0) + 1,
        );
    for (const entry of status.blockerCounts)
      if (!counts.has(entry.reason)) counts.set(entry.reason, entry.count);
    return BLOCKER_ORDER.filter((reason) => counts.has(reason)).map(
      (reason) => ({ reason, count: counts.get(reason)! }),
    );
  }, [status]);
  const failedStages = (status?.stages ?? []).filter(
    (stage) => stage.state === "FAILED",
  );
  const activity = useMemo(() => buildActivity(status), [status]);
  const summary = [
    running.length ? `${running.length} running` : "",
    queued.length ? `${queued.length} queued` : "",
    waitingCapacity.length
      ? `${waitingCapacity.length} waiting for capacity`
      : "",
    waitingData.length ? `${waitingData.length} waiting for data` : "",
    retrying.length ? `${retrying.length} retry scheduled` : "",
    interventions.length
      ? `${interventions.length} ${
          interventions.length === 1 ? "needs action" : "need your action"
        }`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const refresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      await sendJson(
        `/api/backtest-automation/refresh?marketId=${encodeURIComponent(marketId)}`,
        "POST",
        {},
      );
      await load();
      onRefreshed?.();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to force a rerun",
      );
    } finally {
      setRefreshing(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setError("");
    try {
      await sendJson(
        `/api/backtest-automation/check?marketId=${encodeURIComponent(marketId)}`,
        "POST",
        {},
      );
      await load();
      onRefreshed?.();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to check for new work",
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <section
      className="panel backtest-automation tw:mb-4"
      aria-label="Backtest automation"
    >
      <div className="panel-title automation-title">
        <div>
          <Tip label="Routine qualification replays are opt-in per market. Profile saves and explicit reruns are always evaluated, even when scheduled catch-up is off.">
            <h3
              className={classes(
                "automation-headline tw:inline-flex tw:flex-wrap tw:items-baseline tw:gap-[6px]",
                AUTOMATION_HEADLINE_TONES[lead?.tone ?? "waiting"] ?? "",
              )}
              role="status"
            >
              {lead?.text ?? "Loading automation state"}
              <span className="automation-market tw:text-[0.78rem] tw:font-semibold tw:text-ink-350">
                {" "}
                · {MARKET_LABELS[marketId] ?? marketId}
              </span>
            </h3>
          </Tip>
          {status && (
            <>
              <p className="automation-headline-next tw:mx-0 tw:mt-[6px] tw:mb-0 tw:flex tw:flex-wrap tw:items-baseline tw:gap-2 tw:text-[0.76rem] tw:leading-[1.5] tw:text-ink-300">
                <span className="automation-headline-next-label tw:font-mono tw:text-[0.6rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.12em] tw:text-ink-500">
                  NEXT
                </span>
                {lead?.next}
              </p>
              <p className="automation-summary-line tw:mx-0 tw:mt-1 tw:mb-0 tw:text-[0.82rem] tw:text-ink-200">
                {summary ||
                  (upToDate.length
                    ? `${upToDate.length} up to date`
                    : "No qualification work recorded for this market yet.")}
              </p>
            </>
          )}
        </div>
        <div className="automation-title-actions tw:flex tw:flex-wrap tw:items-center tw:gap-2">
          <Tip label="Evaluates only work that newly captured sessions, a pending retry or a reopened blocker make due. It never forces a replay; use Automation settings → Force rerun for corrected inputs.">
            <button
              type="button"
              className={AUTOMATION_SECONDARY}
              onClick={() => void check()}
              disabled={checking || loading}
            >
              {checking ? "CHECKING…" : "Check for new work"}
            </button>
          </Tip>
          <button
            type="button"
            className={AUTOMATION_SECONDARY}
            onClick={() => setSettingsOpen(true)}
          >
            Automation settings
          </button>
        </div>
      </div>
      {error && <p className="error-banner">{error}</p>}
      {!status && loading && <p className="empty">Loading automation state…</p>}
      {status && (
        <>
          <div className="automation-overview-meta tw:flex tw:flex-wrap tw:gap-x-6 tw:gap-y-1 tw:border-b tw:border-line tw:px-[22px] tw:py-[10px] tw:text-[0.72rem] tw:text-ink-300">
            {status.lastSuccessAt ? (
              <Tip label="Result time describes when the replay ran; evidence coverage can lag newly captured sessions. This is computed from captured history, never a live trading run.">
                <span className="automation-last-result tw:inline-flex tw:flex-wrap tw:items-baseline tw:gap-[6px]">
                  <b className="tw:text-ink-200">Last completed replay</b>{" "}
                  {timestamp(status.lastSuccessAt)}
                  {status.lastSuccessDurationMs !== null
                    ? ` · ran in ${duration(status.lastSuccessDurationMs)}`
                    : ""}
                  {status.lastSuccessEvaluatedThrough
                    ? ` · evidence through ${status.lastSuccessEvaluatedThrough}`
                    : ""}
                  <em className="automation-evidence-note tw:rounded-full tw:border tw:border-line tw:px-[6px] tw:py-[2px] tw:font-mono tw:text-[0.6rem] tw:font-semibold tw:not-italic tw:tracking-[0.04em] tw:text-ink-400">
                    captured history, not a live run
                  </em>
                </span>
              </Tip>
            ) : (
              <span className="automation-last-result tw:inline-flex tw:flex-wrap tw:items-baseline tw:gap-[6px]">
                No completed qualification replay recorded yet.
              </span>
            )}
            <Tip label="Work items that are queued or running, and the oldest waiting or dispatched item. Outstanding replays count against this market's capacity limit.">
              <span>
                Outstanding {status.outstandingWork}
                {status.oldestOutstandingAt
                  ? ` · oldest dispatched ${timestamp(status.oldestOutstandingAt)}`
                  : ""}
                {status.oldestWaitingAt
                  ? ` · oldest waiting ${timestamp(status.oldestWaitingAt)}`
                  : ""}
              </span>
            </Tip>
            {status.lastCycle && (
              <Tip label="The most recent durable automation cycle. A 'blocked' outcome names why dispatch stopped; waiting work is not lost.">
                <span>
                  Last cycle{" "}
                  {status.lastCycle.outcome.replaceAll("_", " ").toLowerCase()}
                  {` · ${timestamp(
                    status.lastCycle.finishedAt ?? status.lastCycle.startedAt,
                  )}`}
                </span>
              </Tip>
            )}
          </div>
          {active ? (
            <ActiveJobCard entry={active} now={now} />
          ) : (
            <p className="automation-idle tw:mx-[22px] tw:my-[14px] tw:rounded-[10px] tw:border tw:border-dashed tw:border-line tw:px-[14px] tw:py-3 tw:text-[0.76rem] tw:text-ink-300">
              {status.enabled
                ? "No replay is running right now. Waiting work starts automatically as capacity frees, and the next scheduled check evaluates newly due work."
                : "No replay is running right now. Use Check for new work to evaluate due work now."}
            </p>
          )}
          {(interventions.length > 0 || failedStages.length > 0) && (
            <section
              className="automation-issues tw:mx-[22px] tw:mt-0 tw:mb-[14px] tw:grid tw:gap-2"
              aria-label="Needs action"
            >
              {needsAction.map((entry) => (
                <IssueRow
                  key={entry.work.workKey}
                  entry={entry}
                  tone="bad"
                  label="Needs your action"
                />
              ))}
              {failed.map((entry) => (
                <IssueRow
                  key={entry.work.workKey}
                  entry={entry}
                  tone="bad"
                  label="Failed"
                />
              ))}
              {failedStages.map((stage) => (
                <div
                  className="automation-issue tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-[10px] tw:rounded-[8px] tw:border tw:border-line-danger tw:bg-surface-danger tw:px-3 tw:py-[10px] tw:text-[0.74rem]"
                  key={`${stage.workKey}:${stage.stageKey}`}
                >
                  <span
                    className={classes(
                      "automation-state",
                      automationState("bad"),
                    )}
                  >
                    Stage failed
                  </span>
                  <div>
                    <strong className="tw:block tw:text-ink-100">
                      {stage.configName ?? "Unknown configuration"} ·{" "}
                      {STAGE_LABELS[stage.stageKey] ?? stage.stageKey}
                    </strong>
                    <span className="tw:text-ink-250">
                      {stage.failureMessage ??
                        "No failure detail was recorded."}
                    </span>
                  </div>
                </div>
              ))}
            </section>
          )}
          <BlockerExplanations
            blockers={blockers}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenUniverse={onOpenUniverse}
          />
          <WaitingGroup
            label="Waiting for capacity"
            entries={waitingCapacity}
            now={now}
          />
          <WaitingGroup
            label="Waiting for data"
            entries={waitingData}
            now={now}
          />
          <WaitingGroup label="Retry scheduled" entries={retrying} now={now} />
          <StageProgression stages={status.stages} />
          {activity.length > 0 && (
            <section
              className="automation-feed tw:mx-[22px] tw:mt-0 tw:mb-[14px] tw:rounded-[8px] tw:border tw:border-line tw:bg-surface-sunken tw:px-[14px] tw:py-3 tw:text-[0.74rem]"
              aria-label="Recent activity"
            >
              <strong className="tw:mb-2 tw:block tw:text-[0.78rem] tw:text-ink-200">
                Recent activity
              </strong>
              <ul className="tw:m-0 tw:grid tw:list-none tw:gap-[6px] tw:p-0">
                {activity.map((entry) => (
                  <li
                    className="tw:grid tw:grid-cols-[10px_minmax(0,1fr)_auto] tw:items-center tw:gap-[10px] tw:text-ink-200"
                    key={entry.key}
                  >
                    <span
                      className={classes(
                        "automation-dot",
                        AUTOMATION_DOT_BASE,
                        AUTOMATION_DOT_TONES[entry.tone] ?? "",
                      )}
                      aria-hidden="true"
                    />
                    <span className="automation-feed-text">{entry.text}</span>
                    <small className="tw:text-ink-400">
                      {relativeTime(entry.at, now)}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="automation-setup-row tw:mx-[22px] tw:mt-0 tw:mb-[14px] tw:flex tw:items-center tw:justify-between tw:gap-3 tw:rounded-[8px] tw:border tw:border-line tw:bg-surface-sunken tw:px-3 tw:py-[10px] tw:text-[0.74rem] tw:text-ink-250">
            <span>
              Portfolio simulation:{" "}
              {activePolicies
                ? `${activePolicies} approved ${activePolicies === 1 ? "policy" : "policies"}`
                : "not enabled"}
            </span>
            <button
              type="button"
              className={AUTOMATION_SECONDARY}
              onClick={() => setSettingsOpen(true)}
            >
              {activePolicies ? "Manage" : "Configure"}
            </button>
          </p>
          {status.stages.length > 0 && (
            <details className="automation-diagnostics tw:mt-[14px] tw:border-t tw:border-line tw:pt-3 tw:text-[0.76rem]">
              <summary className="tw:cursor-pointer tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:uppercase">
                Follow-on stages ({status.stages.length})
              </summary>
              <p className="automation-stages-note tw:mx-0 tw:mt-1 tw:mb-[10px] tw:text-[0.72rem] tw:text-ink-350">
                Eligibility only. Calibration and studies require explicit
                authorization; training follows qualification, never baseline
                completion.
              </p>
              <table className={AUTOMATION_WORKS}>
                <thead>
                  <tr>
                    <th className={AUTOMATION_WORKS_TH}>Configuration</th>
                    <th className={AUTOMATION_WORKS_TH}>Stage</th>
                    <th className={AUTOMATION_WORKS_TH}>State</th>
                    <th className={AUTOMATION_WORKS_TH}>Why</th>
                    <th className={AUTOMATION_WORKS_TH}>Authorization</th>
                  </tr>
                </thead>
                <tbody>
                  {status.stages.map((stage) => (
                    <tr key={`${stage.workKey}:${stage.stageKey}`}>
                      <td className={AUTOMATION_WORKS_TD}>
                        {stage.configName ?? "—"}
                      </td>
                      <td className={AUTOMATION_WORKS_TD}>
                        {STAGE_LABELS[stage.stageKey] ?? stage.stageKey}
                      </td>
                      <td className={AUTOMATION_WORKS_TD}>
                        <span
                          className={classes(
                            "automation-state",
                            automationState(stageBadge(stage)),
                          )}
                        >
                          {STAGE_STATE_LABELS[stage.state] ?? stage.state}
                        </span>
                      </td>
                      <td className={AUTOMATION_WORKS_TD}>
                        {reasonText(stage.reasonCodes)}
                      </td>
                      <td className={AUTOMATION_WORKS_TD}>
                        {SCOPE_LABELS[stage.authorizationScope] ??
                          stage.authorizationScope}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          <details className="automation-diagnostics tw:mt-[14px] tw:border-t tw:border-line tw:pt-3 tw:text-[0.76rem]">
            <summary className="tw:cursor-pointer tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:uppercase">
              Diagnostics
            </summary>
            <dl className="automation-summary tw:mx-0 tw:mt-[10px] tw:mb-3 tw:grid tw:grid-cols-[repeat(4,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-xl tw:border tw:border-line tw:bg-surface-sunken tw:below-900:grid-cols-[repeat(2,1fr)]">
              <div className="tw:bg-surface tw:px-[14px] tw:py-3">
                <dt className={AUTOMATION_SUMMARY_DT}>Last cycle</dt>
                <dd className={AUTOMATION_SUMMARY_DD}>
                  {status.lastCycle
                    ? `${status.lastCycle.outcome} · ${timestamp(
                        status.lastCycle.finishedAt ??
                          status.lastCycle.startedAt,
                      )}`
                    : "No cycle recorded yet"}
                </dd>
              </div>
              <div className="tw:bg-surface tw:px-[14px] tw:py-3">
                <dt className={AUTOMATION_SUMMARY_DT}>Outstanding</dt>
                <dd className={AUTOMATION_SUMMARY_DD}>
                  {status.outstandingWork}
                </dd>
              </div>
              <div className="tw:bg-surface tw:px-[14px] tw:py-3">
                <dt className={AUTOMATION_SUMMARY_DT}>Oldest outstanding</dt>
                <dd className={AUTOMATION_SUMMARY_DD}>
                  {timestamp(status.oldestOutstandingAt)}
                </dd>
              </div>
              <div className="tw:bg-surface tw:px-[14px] tw:py-3">
                <dt className={AUTOMATION_SUMMARY_DT}>Oldest waiting</dt>
                <dd className={AUTOMATION_SUMMARY_DD}>
                  {timestamp(status.oldestWaitingAt)}
                </dd>
              </div>
              <div className="tw:bg-surface tw:px-[14px] tw:py-3">
                <dt className={AUTOMATION_SUMMARY_DT}>Retry scheduled</dt>
                <dd className={AUTOMATION_SUMMARY_DD}>
                  {status.retryScheduled}
                </dd>
              </div>
              <div className="tw:bg-surface tw:px-[14px] tw:py-3">
                <dt className={AUTOMATION_SUMMARY_DT}>Blockers</dt>
                <dd className={AUTOMATION_SUMMARY_DD}>
                  {status.blockerCounts.length
                    ? status.blockerCounts
                        .map(
                          (count) =>
                            `${BLOCKER_LABELS[count.reason] ?? count.reason}: ${count.count}`,
                        )
                        .join(" · ")
                    : "none"}
                </dd>
              </div>
              <div className="tw:bg-surface tw:px-[14px] tw:py-3">
                <dt className={AUTOMATION_SUMMARY_DT}>Last result runtime</dt>
                <dd className={AUTOMATION_SUMMARY_DD}>
                  {duration(status.lastSuccessDurationMs)}
                </dd>
              </div>
            </dl>
            <strong className="automation-diagnostics-subhead tw:mx-0 tw:mt-3 tw:mb-1 tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.07em] tw:uppercase tw:text-ink-400">
              Cycle events
            </strong>
            {status.lastCycle?.changes.length ? (
              <ul className="automation-cycle-changes tw:mx-0 tw:my-[6px] tw:pl-[18px] tw:text-[0.72rem] tw:text-ink-350">
                {status.lastCycle.changes.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            ) : (
              <p className="empty">Nothing changed in the last cycle.</p>
            )}
            {status.recentCycles.length ? (
              <table className={AUTOMATION_WORKS}>
                <thead>
                  <tr>
                    <th className={AUTOMATION_WORKS_TH}>Cycle finished</th>
                    <th className={AUTOMATION_WORKS_TH}>Outcome</th>
                    <th className={AUTOMATION_WORKS_TH}>Evaluated</th>
                    <th className={AUTOMATION_WORKS_TH}>Dispatched</th>
                    <th className={AUTOMATION_WORKS_TH}>Coalesced</th>
                    <th className={AUTOMATION_WORKS_TH}>Blocked</th>
                    <th className={AUTOMATION_WORKS_TH}>Retried</th>
                    <th className={AUTOMATION_WORKS_TH}>Completed</th>
                    <th className={AUTOMATION_WORKS_TH}>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {status.recentCycles.map((cycle) => (
                    <tr key={cycle.cycleId}>
                      <td className={AUTOMATION_WORKS_TD}>
                        {timestamp(cycle.finishedAt ?? cycle.startedAt)}
                      </td>
                      <td className={AUTOMATION_WORKS_TD}>{cycle.outcome}</td>
                      <td className={AUTOMATION_WORKS_TD}>{cycle.evaluated}</td>
                      <td className={AUTOMATION_WORKS_TD}>
                        {cycle.dispatched}
                      </td>
                      <td className={AUTOMATION_WORKS_TD}>{cycle.coalesced}</td>
                      <td className={AUTOMATION_WORKS_TD}>{cycle.blocked}</td>
                      <td className={AUTOMATION_WORKS_TD}>{cycle.retried}</td>
                      <td className={AUTOMATION_WORKS_TD}>{cycle.succeeded}</td>
                      <td className={AUTOMATION_WORKS_TD}>{cycle.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="empty">No cycle history recorded yet.</p>
            )}
          </details>
          <Drawer
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            title="Automation settings"
          >
            <section className={AUTOMATION_SETTINGS_BLOCK}>
              <h4 className="tw:mx-0 tw:mt-0 tw:mb-[6px] tw:text-[0.84rem] tw:text-ink-100">
                Schedule
              </h4>
              <p className="tw:mx-0 tw:mt-0 tw:mb-[10px] tw:text-[0.74rem] tw:leading-[1.5] tw:text-ink-300">
                {status.enabled
                  ? `Scheduled catch-up is on, with at most ${status.maxOutstanding} outstanding replays per market.`
                  : "Scheduled catch-up is off. Profile saves and forced reruns are still evaluated."}
              </p>
              <p className="tw:mx-0 tw:mt-0 tw:mb-[10px] tw:text-[0.74rem] tw:leading-[1.5] tw:text-ink-300">
                {status.enabled && status.nextCheckAt
                  ? `Next check ${timestamp(status.nextCheckAt)}. Waiting work also continues when a replay completes.`
                  : "No next check is scheduled."}
              </p>
            </section>
            <section className={AUTOMATION_SETTINGS_BLOCK}>
              <h4 className="tw:mx-0 tw:mt-0 tw:mb-[6px] tw:text-[0.84rem] tw:text-ink-100">
                Force rerun
              </h4>
              <p className="tw:mx-0 tw:mt-0 tw:mb-[10px] tw:text-[0.74rem] tw:leading-[1.5] tw:text-ink-300">
                Queue a new attempt for all {status.works.length} qualification{" "}
                {status.works.length === 1 ? "configuration" : "configurations"}
                , including corrected inputs the captured-input watermark cannot
                detect. Normal checks continue automatically.
              </p>
              <button
                type="button"
                className={REFRESH_AUTOMATION}
                onClick={() => void refresh()}
                disabled={refreshing || loading}
              >
                {refreshing ? "QUEUEING RERUN…" : "FORCE RERUN NOW"}
              </button>
            </section>
            <section className={AUTOMATION_SETTINGS_BLOCK}>
              <h4 className="tw:mx-0 tw:mt-0 tw:mb-[6px] tw:text-[0.84rem] tw:text-ink-100">
                Portfolio simulation
              </h4>
              <FundedReplayPolicyPanel
                marketId={marketId}
                works={status.works}
                onChanged={() => {
                  void load();
                  void loadPolicies();
                }}
              />
            </section>
          </Drawer>
        </>
      )}
    </section>
  );
}
