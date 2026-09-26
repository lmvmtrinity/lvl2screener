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
import { Tip } from "../ui.js";
import {
  CARD,
  DOT_TONES,
  LABEL,
  LINK_BUTTON,
  PipelineStrip,
  type PipelineStep,
  SECONDARY_BUTTON,
  SectionHead,
  Stat,
  badge,
} from "../components/PageSections.js";
import { FundedReplayPolicyPanel } from "./FundedReplayPolicyPanel.js";

const PRIMARY_BUTTON =
  "tw:cursor-pointer tw:rounded-[9px] tw:border tw:border-accent tw:bg-accent tw:px-[14px] tw:py-[9px] tw:font-sans tw:text-[0.8rem] tw:font-semibold tw:text-on-accent tw:disabled:cursor-wait tw:disabled:opacity-50";

const BLOCKER_LABELS: Record<string, string> = {
  NO_CAPTURED_HISTORY: "not enough captured history yet",
  HISTORY_RANGE_UNAVAILABLE: "requested range is not fully captured",
  POLICY_VIOLATION: "policy input rejected",
  CAPACITY_LIMIT: "queued behind outstanding replays",
  NO_REPLAY_CANDIDATES: "waiting for replay candidates",
};

/**
 * Human explanation per blocker reason. Actions are only rendered when this
 * page (or an optional callback prop) owns them; nothing here bypasses
 * capacity, policy or authorization gates.
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
      "The saved profile no longer satisfies execution policy (for example slippage or fee limits). Correct the configuration, then queue a forced rerun.",
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
  STRATEGY_STUDY: "Study",
  FUNDED_REPLAY: "Funded replay",
};

const STAGE_STATE_LABELS: Record<string, string> = {
  WAITING_FOR_EVIDENCE: "Waiting",
  NOT_ELIGIBLE: "Not eligible",
  RETRY_SCHEDULED: "Retry scheduled",
  QUEUED: "Queued",
  RUNNING: "Running",
  FAILED: "Failed",
  COMPLETED: "Completed",
  SKIPPED: "Skipped",
};

/** Plain-language reason per stage reason code, shown in the pipeline strip.
 * Unknown codes fall back to a readable form of the code itself. */
const STAGE_REASON_COPY: Record<string, string> = {
  RESEARCH_EVIDENCE_PENDING: "Waiting for research evidence",
  RESEARCH_EVIDENCE_VERIFIED: "Research evidence verified",
  EXPLICIT_AUTHORIZATION_REQUIRED: "Needs your authorization",
  EXPLICIT_STUDY_AUTHORIZATION_REQUIRED: "Needs study authorization",
  PAPER_QUALIFICATION_REQUIRED: "Waits for paper qualification",
  FUNDED_AUTOMATION_POLICY_NOT_APPROVED: "No approved policy",
  RETRY_BACKOFF: "Retrying after a failure",
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
  RUNNING: "running",
  QUEUED: "queued",
  WAITING_CAPACITY: "waiting for capacity",
  WAITING_DATA: "waiting for data",
  RETRY_SCHEDULED: "retry scheduled",
  NEEDS_ACTION: "needs your action",
  FAILED: "failed",
  CANCELLED: "cancelled",
  UP_TO_DATE: "up to date",
  IDLE: "no action recorded",
};

interface WorkEntry {
  work: BacktestAutomationWork;
  state: WorkUiState;
}

export interface WorkGroups {
  running: WorkEntry[];
  queued: WorkEntry[];
  waitingCapacity: WorkEntry[];
  waitingData: WorkEntry[];
  retrying: WorkEntry[];
  needsAction: WorkEntry[];
  failed: WorkEntry[];
  upToDate: WorkEntry[];
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

function clockTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function weekdayTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Session dates are calendar dates; format them without a timezone shift. */
function sessionDay(value: string): string {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function relativeTime(value: string | null, now: number): string {
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

function duration(value: number | null): string {
  if (value === null) return "—";
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function waitingDetail(entry: WorkEntry): string {
  const { work, state } = entry;
  if (state === "RETRY_SCHEDULED")
    return `retry ${work.retryCount} scheduled for ${timestamp(work.nextAttemptAt)}`;
  if (state === "WAITING_DATA")
    return work.blockerReason
      ? (BLOCKER_LABELS[work.blockerReason] ?? "waiting for captured data")
      : "waiting for captured data";
  return `waiting since ${timestamp(work.waitingSince ?? work.lastDispatchedAt)}`;
}

export interface BacktestAutomation {
  marketId: "CA_TSX" | "US_EQUITIES";
  status: BacktestAutomationStatus | null;
  activePolicies: number | null;
  groups: WorkGroups;
  failedStages: BacktestAutomationStage[];
  error: string;
  loading: boolean;
  checking: boolean;
  refreshing: boolean;
  now: number;
  reload: () => void;
  check: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** Loads and polls the market's automation status and owns its two explicit
 * actions: a check (evaluates only newly due work) and a forced rerun. */
export function useBacktestAutomation(
  marketId: "CA_TSX" | "US_EQUITIES",
  onRefreshed?: () => void,
): BacktestAutomation {
  const [status, setStatus] = useState<BacktestAutomationStatus | null>(null);
  const [activePolicies, setActivePolicies] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(
        backtestAutomationStatusSchema.parse(
          await getJson(
            `/api/backtest-automation/status?marketId=${encodeURIComponent(marketId)}`,
          ),
        ),
      );
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
  }, [marketId]);

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

  // Keep the page current while work is in flight without remounting it, so
  // scroll position and focus are preserved.
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

  const groups = useMemo<WorkGroups>(() => {
    const result: WorkGroups = {
      running: [],
      queued: [],
      waitingCapacity: [],
      waitingData: [],
      retrying: [],
      needsAction: [],
      failed: [],
      upToDate: [],
    };
    const target: Partial<Record<WorkUiState, WorkEntry[]>> = {
      RUNNING: result.running,
      QUEUED: result.queued,
      WAITING_CAPACITY: result.waitingCapacity,
      WAITING_DATA: result.waitingData,
      RETRY_SCHEDULED: result.retrying,
      NEEDS_ACTION: result.needsAction,
      FAILED: result.failed,
      UP_TO_DATE: result.upToDate,
    };
    for (const work of status?.works ?? []) {
      const state = workUiState(work);
      target[state]?.push({ work, state });
    }
    return result;
  }, [status]);

  const failedStages = useMemo(
    () => (status?.stages ?? []).filter((stage) => stage.state === "FAILED"),
    [status],
  );

  const runAction = async (
    path: "check" | "refresh",
    setBusy: (value: boolean) => void,
    failure: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      await sendJson(
        `/api/backtest-automation/${path}?marketId=${encodeURIComponent(marketId)}`,
        "POST",
        {},
      );
      await load();
      onRefreshed?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return {
    marketId,
    status,
    activePolicies,
    groups,
    failedStages,
    error,
    loading,
    checking,
    refreshing,
    now,
    reload: () => {
      void load();
      void loadPolicies();
    },
    check: () =>
      runAction("check", setChecking, "Unable to check for new work"),
    refresh: () =>
      runAction("refresh", setRefreshing, "Unable to force a rerun"),
  };
}

/** One line under the page title: is automation on, what it is doing, and
 * when it next checks. It never claims progress the data cannot prove. */
export function AutomationStatusLine({
  automation,
}: {
  automation: BacktestAutomation;
}) {
  const { status, groups, failedStages } = automation;
  if (!status)
    return (
      <p className="tw:m-0 tw:text-[0.84rem] tw:text-ink-400" role="status">
        {automation.loading
          ? "Loading automation state…"
          : "Automation state unavailable"}
      </p>
    );
  const attention =
    groups.needsAction.length + groups.failed.length + failedStages.length;
  const activity = [
    groups.running.length ? `${groups.running.length} running` : "",
    groups.queued.length ? `${groups.queued.length} queued` : "",
    groups.waitingCapacity.length
      ? `${groups.waitingCapacity.length} waiting for capacity`
      : "",
    groups.waitingData.length
      ? `${groups.waitingData.length} waiting for data`
      : "",
    groups.retrying.length ? `${groups.retrying.length} retry scheduled` : "",
    attention
      ? `${attention} ${attention === 1 ? "needs" : "need"} attention`
      : "",
  ].filter(Boolean);
  const tone = attention
    ? "bad"
    : groups.running.length
      ? "pending"
      : status.enabled
        ? "ok"
        : "waiting";
  const parts = [
    status.enabled ? "Automation on" : "Automation paused",
    activity.length
      ? activity.join(", ")
      : groups.upToDate.length
        ? "up to date"
        : "no qualification work recorded yet",
    status.enabled && status.nextCheckAt
      ? `next check ${weekdayTime(status.nextCheckAt)}`
      : status.enabled
        ? "no check scheduled"
        : "scheduled checks are off",
  ];
  return (
    <Tip label="Routine qualification replays are opt-in per market. Profile saves and explicit reruns are always evaluated, even when scheduled checks are off.">
      <p
        className="tw:m-0 tw:flex tw:items-center tw:gap-[10px] tw:text-[0.86rem] tw:text-ink-300"
        role="status"
      >
        <span
          className={classes(
            "tw:h-2 tw:w-2 tw:shrink-0 tw:rounded-full",
            DOT_TONES[tone],
          )}
          aria-hidden="true"
        />
        {parts.join(" · ")}
      </p>
    </Tip>
  );
}

export function CheckForWorkButton({
  automation,
}: {
  automation: BacktestAutomation;
}) {
  return (
    <Tip label="Evaluates only work that newly captured sessions, a pending retry or a reopened blocker make due. It never forces a replay; use Automation settings → Force rerun for corrected inputs.">
      <button
        type="button"
        className={SECONDARY_BUTTON}
        onClick={() => void automation.check()}
        disabled={automation.checking || automation.loading}
      >
        {automation.checking ? "Checking…" : "Check for new work"}
      </button>
    </Tip>
  );
}

/** The replay in flight, its measurable progress and what starts next. When
 * nothing is running the section collapses to a single line. */
export function NowRunning({ automation }: { automation: BacktestAutomation }) {
  const { status, groups, now } = automation;
  if (!status) return null;
  const active = groups.running[0] ?? groups.queued[0];
  const upNext = [
    ...groups.running,
    ...groups.queued,
    ...groups.waitingCapacity,
    ...groups.retrying,
  ].filter((entry) => entry !== active);
  if (!active)
    return (
      <section className="tw:mb-6" aria-label="Now running">
        <SectionHead title="Now running" />
        <p
          className={classes(
            CARD,
            "tw:m-0 tw:px-[22px] tw:py-4 tw:text-[0.84rem] tw:text-ink-300",
          )}
        >
          Nothing is running.{" "}
          {status.enabled && status.nextCheckAt
            ? `The next scheduled check runs ${weekdayTime(status.nextCheckAt)}.`
            : "Scheduled checks are off; use Check for new work to evaluate due work now."}
        </p>
      </section>
    );
  const { work, state } = active;
  const running = state === "RUNNING";
  const startedAt = work.startedAt ?? work.lastDispatchedAt;
  const total = work.progress?.totalSessions ?? null;
  const completed = work.progress?.completedSessions ?? null;
  const measurable = running && total !== null && completed !== null;
  const percent = measurable ? Math.round((completed / total) * 100) : 0;
  return (
    <section className="tw:mb-6" aria-label="Now running">
      <SectionHead title="Now running">
        Replaying captured history · no live orders
      </SectionHead>
      <div
        className={classes(
          CARD,
          "tw:grid tw:grid-cols-[minmax(0,1fr)_260px] tw:items-center tw:gap-7 tw:px-[22px] tw:py-5 tw:below-900:grid-cols-[minmax(0,1fr)]",
        )}
      >
        <div>
          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-x-[10px] tw:gap-y-1">
            <span
              className={classes(
                "tw:h-[9px] tw:w-[9px] tw:rounded-full",
                running ? DOT_TONES.pending : DOT_TONES.waiting,
              )}
              aria-hidden="true"
            />
            <strong className="tw:text-[1.05rem] tw:font-semibold tw:text-ink-50">
              {configLabel(work)}
            </strong>
            <span className="tw:text-[0.78rem] tw:text-ink-400">
              {running
                ? "qualification replay"
                : "queued · starts when capacity frees"}
            </span>
          </div>
          {measurable && (
            <div
              className="tw:mt-[14px] tw:mb-[9px] tw:h-2 tw:overflow-hidden tw:rounded-full tw:bg-surface-sunken"
              role="progressbar"
              aria-label="Session progress"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={completed}
            >
              <div
                className="tw:h-full tw:rounded-full tw:bg-accent"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          <p className="tw:m-0 tw:mt-2 tw:flex tw:flex-wrap tw:gap-x-[18px] tw:gap-y-1 tw:text-[0.78rem] tw:text-ink-300">
            {measurable ? (
              <span>
                Session{" "}
                <b className="tw:font-semibold tw:text-ink-100">
                  {Math.min(completed + 1, total)} of {total}
                </b>
              </span>
            ) : running ? (
              <span>{work.progress?.message ?? "Starting the replay"}</span>
            ) : (
              <span>
                Triggered by{" "}
                {ORIGIN_LABELS[work.triggerOrigin] ?? work.triggerOrigin}
              </span>
            )}
            {running && startedAt && (
              <span>
                Elapsed{" "}
                <b className="tw:font-semibold tw:text-ink-100">
                  {elapsed(startedAt, now)}
                </b>
              </span>
            )}
            {running && (
              <span>
                Last progress{" "}
                <b className="tw:font-semibold tw:text-ink-100">
                  {work.heartbeatAt
                    ? relativeTime(work.heartbeatAt, now)
                    : "not reported yet"}
                </b>
              </span>
            )}
          </p>
        </div>
        <div className="tw:border-l tw:border-line tw:pl-6 tw:below-900:border-l-0 tw:below-900:border-t tw:below-900:pl-0 tw:below-900:pt-4">
          <div className={LABEL}>Up next</div>
          {upNext.length ? (
            <ol className="tw:m-0 tw:mt-[10px] tw:grid tw:list-none tw:gap-2 tw:p-0">
              {upNext.slice(0, 4).map((entry) => (
                <li
                  className="tw:flex tw:justify-between tw:gap-3 tw:text-[0.82rem] tw:text-ink-200"
                  key={entry.work.workKey}
                >
                  {configLabel(entry.work)}
                  <span className="tw:text-[0.74rem] tw:text-ink-500">
                    {WORK_STATE_LABELS[entry.state]}
                  </span>
                </li>
              ))}
              {upNext.length > 4 && (
                <li className="tw:text-[0.74rem] tw:text-ink-500">
                  +{upNext.length - 4} more
                </li>
              )}
            </ol>
          ) : (
            <p className="tw:m-0 tw:mt-[10px] tw:text-[0.8rem] tw:text-ink-400">
              Nothing else is queued.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Summarizes one stage across every configuration so the strip stays one row
 * however many strategies the market has. The per-configuration matrix stays
 * in diagnostics. */
function stageStep(
  stageKey: BacktestAutomationStageKey,
  stages: BacktestAutomationStage[],
): PipelineStep {
  const label = STAGE_LABELS[stageKey] ?? stageKey;
  const recorded = stages.filter((stage) => stage.stageKey === stageKey);
  if (!recorded.length)
    return { key: stageKey, label, tone: "none", detail: "Not evaluated yet" };
  const count = (predicate: (stage: BacktestAutomationStage) => boolean) =>
    recorded.filter(predicate).length;
  const total = recorded.length;
  const of = (value: number) =>
    value === total ? "" : ` (${value} of ${total})`;
  const failed = count((stage) => stage.state === "FAILED");
  if (failed)
    return { key: stageKey, label, tone: "bad", detail: `${failed} failed` };
  const active = count(
    (stage) => stage.state === "RUNNING" || stage.state === "QUEUED",
  );
  if (active)
    return {
      key: stageKey,
      label,
      tone: "active",
      detail: `${active} in progress`,
    };
  const completed = count((stage) => stage.state === "COMPLETED");
  if (completed === total)
    return {
      key: stageKey,
      label,
      tone: "done",
      detail: `${total} of ${total} complete`,
    };
  // The most common reason among the unfinished configurations explains the stage.
  const reasons = new Map<string, number>();
  for (const stage of recorded)
    if (stage.state !== "COMPLETED") {
      const code = stage.reasonCodes[0] ?? stage.state;
      reasons.set(code, (reasons.get(code) ?? 0) + 1);
    }
  const [code, reasonCount] = [...reasons.entries()].sort(
    (left, right) => right[1] - left[1],
  )[0]!;
  const locked = recorded.every(
    (stage) =>
      stage.state === "COMPLETED" ||
      ((stage.authorizationScope === "AUTHORIZATION_REQUIRED" ||
        stage.authorizationScope === "POLICY_REQUIRED") &&
        stage.state === "NOT_ELIGIBLE"),
  );
  const text =
    STAGE_REASON_COPY[code] ??
    STAGE_STATE_LABELS[code] ??
    code.toLowerCase().replaceAll("_", " ");
  return {
    key: stageKey,
    label,
    tone: locked ? "lock" : "wait",
    detail: `${text}${of(reasonCount)}`,
  };
}

function IssueList({
  automation,
  onOpenSettings,
  onOpenUniverse,
}: {
  automation: BacktestAutomation;
  onOpenSettings: () => void;
  onOpenUniverse?: () => void;
}) {
  const { status, groups, failedStages } = automation;
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
  const issues = [
    ...groups.needsAction.map((entry) => ({
      key: entry.work.workKey,
      label: "Needs your action",
      name: configLabel(entry.work),
      detail:
        entry.work.failureMessage ??
        "The recorded policy no longer accepts the automation input.",
    })),
    ...groups.failed.map((entry) => ({
      key: entry.work.workKey,
      label: "Replay failed",
      name: configLabel(entry.work),
      detail: entry.work.failureMessage ?? "No failure detail was recorded.",
    })),
    ...failedStages.map((stage) => ({
      key: `${stage.workKey}:${stage.stageKey}`,
      label: "Stage failed",
      name: `${stage.configName ?? "Unknown configuration"} · ${STAGE_LABELS[stage.stageKey] ?? stage.stageKey}`,
      detail: stage.failureMessage ?? "No failure detail was recorded.",
    })),
  ];
  if (!issues.length && !blockers.length) return null;
  return (
    <ul
      className="tw:m-0 tw:grid tw:list-none tw:gap-2 tw:border-t tw:border-line tw:px-[22px] tw:py-4"
      aria-label="Needs attention"
    >
      {issues.map((issue) => (
        <li
          className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-3 tw:rounded-[10px] tw:border tw:border-line-danger tw:bg-surface-danger tw:px-[14px] tw:py-[10px] tw:text-[0.8rem]"
          key={issue.key}
        >
          <span className={badge("bad")}>{issue.label}</span>
          <span>
            <strong className="tw:block tw:text-ink-100">{issue.name}</strong>
            <span className="tw:text-ink-250">{issue.detail}</span>
          </span>
        </li>
      ))}
      {blockers.map(({ reason, count }) => {
        const copy = BLOCKER_COPY[reason];
        return (
          <li
            className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-start tw:gap-3 tw:rounded-[10px] tw:border tw:border-line tw:bg-surface-sunken tw:px-[14px] tw:py-[10px] tw:text-[0.8rem] tw:below-720:grid-cols-[minmax(0,1fr)]"
            key={reason}
          >
            <span className={badge("warn")}>
              {count} {count === 1 ? "strategy" : "strategies"}
            </span>
            <span>
              <strong className="tw:block tw:text-ink-100">{copy.title}</strong>
              <span className="tw:leading-[1.45] tw:text-ink-300">
                {copy.detail}
              </span>
            </span>
            {(reason === "CAPACITY_LIMIT" || reason === "POLICY_VIOLATION") && (
              <button
                type="button"
                className={LINK_BUTTON}
                onClick={onOpenSettings}
              >
                {reason === "POLICY_VIOLATION"
                  ? "Review & rerun"
                  : "Automation settings"}
              </button>
            )}
            {reason === "NO_REPLAY_CANDIDATES" && onOpenUniverse && (
              <button
                type="button"
                className={LINK_BUTTON}
                onClick={onOpenUniverse}
              >
                Open universe & daily list
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Whether the automation's evidence is current, how far each strategy got
 * through the gated pipeline, and anything that needs a human. */
export function AutomationEvidence({
  automation,
  qualified,
  results,
  onOpenDiagnostics,
  onOpenSettings,
  onOpenUniverse,
}: {
  automation: BacktestAutomation;
  qualified: number;
  results: number;
  onOpenDiagnostics: () => void;
  onOpenSettings: () => void;
  onOpenUniverse?: () => void;
}) {
  const { status, groups, failedStages } = automation;
  const steps = useMemo<PipelineStep[]>(() => {
    if (!status) return [];
    const total = status.works.length;
    const current = groups.upToDate.length;
    const inFlight = groups.running.length + groups.queued.length;
    const replay: PipelineStep = {
      key: "REPLAY",
      label: "Replay",
      tone: !total
        ? "none"
        : groups.failed.length || groups.needsAction.length
          ? "bad"
          : inFlight
            ? "active"
            : current === total
              ? "done"
              : "wait",
      detail: total
        ? inFlight
          ? `${inFlight} in progress · ${current} of ${total} current`
          : `${current} of ${total} up to date`
        : "No strategies recorded",
    };
    return [replay, ...STAGE_ORDER.map((key) => stageStep(key, status.stages))];
  }, [status, groups]);
  if (!status) return null;
  const total = status.works.length;
  const attention =
    groups.needsAction.length + groups.failed.length + failedStages.length;
  const pending =
    groups.running.length +
    groups.queued.length +
    groups.waitingCapacity.length +
    groups.waitingData.length +
    groups.retrying.length;
  return (
    <section className="tw:mb-6" aria-label="Automation evidence">
      <SectionHead title="Automation evidence">
        <button
          type="button"
          className={LINK_BUTTON}
          onClick={onOpenDiagnostics}
        >
          Diagnostics
        </button>
      </SectionHead>
      <div className={CARD}>
        <dl className="tw:m-0 tw:grid tw:grid-cols-[repeat(4,minmax(0,1fr))] tw:below-900:grid-cols-[repeat(2,minmax(0,1fr))]">
          <Stat
            label="Evidence through"
            value={
              status.lastSuccessEvaluatedThrough
                ? sessionDay(status.lastSuccessEvaluatedThrough)
                : "—"
            }
            hint={
              status.lastSuccessAt
                ? `last replay ${clockTime(status.lastSuccessAt)} · ran in ${duration(status.lastSuccessDurationMs)}`
                : "no completed replay yet"
            }
          />
          <Stat
            label="Strategies replayed"
            value={total ? `${groups.upToDate.length} / ${total}` : "0"}
            hint={
              !total
                ? "no qualification work yet"
                : pending
                  ? `${pending} waiting or in progress`
                  : "all current"
            }
          />
          <Stat
            label="Qualified"
            value={String(qualified)}
            hint={
              results
                ? `of ${results} latest ${results === 1 ? "result" : "results"}`
                : "no results yet"
            }
          />
          <Stat
            label="Needs attention"
            value={String(attention)}
            hint={
              attention
                ? "see the issues below"
                : "no failures or rejected inputs"
            }
          />
        </dl>
        <PipelineStrip steps={steps} />
        <IssueList
          automation={automation}
          onOpenSettings={onOpenSettings}
          onOpenUniverse={onOpenUniverse}
        />
      </div>
    </section>
  );
}

const SETTINGS_BLOCK =
  "tw:mb-5 tw:border-b tw:border-line tw:pb-4 tw:last:mb-0 tw:last:border-b-0 tw:last:pb-0";
const SETTINGS_HEADING =
  "tw:mx-0 tw:mt-0 tw:mb-[6px] tw:text-[0.84rem] tw:text-ink-100";
const SETTINGS_COPY =
  "tw:mx-0 tw:mt-0 tw:mb-[10px] tw:text-[0.78rem] tw:leading-[1.5] tw:text-ink-300";

/** Drawer body: schedule, forced rerun and the funded replay policy. */
export function AutomationSettings({
  automation,
}: {
  automation: BacktestAutomation;
}) {
  const { status } = automation;
  if (!status) return <p className="empty">Loading automation state…</p>;
  return (
    <>
      <section className={SETTINGS_BLOCK}>
        <h4 className={SETTINGS_HEADING}>Schedule</h4>
        <p className={SETTINGS_COPY}>
          {status.enabled
            ? `Scheduled catch-up is on, with at most ${status.maxOutstanding} outstanding replays per market.`
            : "Scheduled catch-up is off. Profile saves and forced reruns are still evaluated."}
        </p>
        <p className={SETTINGS_COPY}>
          {status.enabled && status.nextCheckAt
            ? `Next check ${timestamp(status.nextCheckAt)}. Waiting work also continues when a replay completes.`
            : "No next check is scheduled."}
        </p>
      </section>
      <section className={SETTINGS_BLOCK}>
        <h4 className={SETTINGS_HEADING}>Force rerun</h4>
        <p className={SETTINGS_COPY}>
          Queue a new attempt for all {status.works.length} qualification{" "}
          {status.works.length === 1 ? "configuration" : "configurations"},
          including corrected inputs the captured-input watermark cannot detect.
          Normal checks continue automatically.
        </p>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          onClick={() => void automation.refresh()}
          disabled={automation.refreshing || automation.loading}
        >
          {automation.refreshing ? "Queueing rerun…" : "Force rerun now"}
        </button>
      </section>
      <section className={SETTINGS_BLOCK}>
        <h4 className={SETTINGS_HEADING}>Portfolio simulation</h4>
        <p className={SETTINGS_COPY}>
          {automation.activePolicies
            ? `${automation.activePolicies} approved ${automation.activePolicies === 1 ? "policy" : "policies"}.`
            : "Not enabled."}
        </p>
        <FundedReplayPolicyPanel
          marketId={automation.marketId}
          works={status.works}
          onChanged={automation.reload}
        />
      </section>
      {automation.error && <p className="error-banner">{automation.error}</p>}
    </>
  );
}

const TABLE = "tw:mb-5 tw:w-full tw:border-collapse tw:text-[0.76rem]";
const TH =
  "tw:border-b tw:border-line tw:px-2 tw:py-2 tw:text-left tw:font-sans tw:text-[0.66rem] tw:font-semibold tw:tracking-[0.08em] tw:uppercase tw:text-ink-400";
const TD = "tw:border-b tw:border-line-subtle tw:px-2 tw:py-2 tw:align-top";

function stageTone(stage: BacktestAutomationStage): string {
  if (stage.state === "COMPLETED") return "ok";
  if (stage.state === "FAILED") return "bad";
  if (stage.state === "RUNNING" || stage.state === "QUEUED") return "pending";
  if (stage.state === "NOT_ELIGIBLE") return "warn";
  return "waiting";
}

/** Drawer body: the raw automation state behind the summary strip. */
export function AutomationDiagnostics({
  automation,
}: {
  automation: BacktestAutomation;
}) {
  const { status, groups } = automation;
  const matrix = useMemo(() => {
    const map = new Map<
      string,
      { name: string; byKey: Map<string, BacktestAutomationStage> }
    >();
    for (const stage of status?.stages ?? []) {
      const row = map.get(stage.workKey) ?? {
        name: stage.configName ?? "Unknown configuration",
        byKey: new Map(),
      };
      row.byKey.set(stage.stageKey, stage);
      map.set(stage.workKey, row);
    }
    return [...map.entries()];
  }, [status]);
  if (!status) return <p className="empty">Loading automation state…</p>;
  const waiting = [
    ...groups.waitingCapacity,
    ...groups.waitingData,
    ...groups.retrying,
  ];
  const facts: [string, string][] = [
    [
      "Last cycle",
      status.lastCycle
        ? `${status.lastCycle.outcome.replaceAll("_", " ").toLowerCase()} · ${timestamp(status.lastCycle.finishedAt ?? status.lastCycle.startedAt)}`
        : "No cycle recorded yet",
    ],
    ["Outstanding", String(status.outstandingWork)],
    ["Oldest outstanding", timestamp(status.oldestOutstandingAt)],
    ["Oldest waiting", timestamp(status.oldestWaitingAt)],
    ["Retry scheduled", String(status.retryScheduled)],
    ["Last result runtime", duration(status.lastSuccessDurationMs)],
    [
      "Blockers",
      status.blockerCounts.length
        ? status.blockerCounts
            .map(
              (count) =>
                `${BLOCKER_LABELS[count.reason] ?? count.reason}: ${count.count}`,
            )
            .join(" · ")
        : "none",
    ],
  ];
  return (
    <div className="tw:grid tw:gap-2 tw:text-[0.78rem] tw:text-ink-200">
      <dl className="tw:m-0 tw:mb-4 tw:grid tw:grid-cols-[repeat(2,minmax(0,1fr))] tw:gap-x-4 tw:gap-y-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className={LABEL}>{label}</dt>
            <dd className="tw:m-0 tw:mt-1">{value}</dd>
          </div>
        ))}
      </dl>
      <h4 className={SETTINGS_HEADING}>Stages per strategy</h4>
      {matrix.length ? (
        <div className="tw:overflow-x-auto">
          <table className={TABLE} aria-label="Stages per strategy">
            <thead>
              <tr>
                <th className={TH}>Strategy</th>
                {STAGE_ORDER.map((key) => (
                  <th className={TH} key={key}>
                    {STAGE_LABELS[key]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map(([workKey, row]) => (
                <tr key={workKey}>
                  <td
                    className={classes(TD, "tw:font-semibold tw:text-ink-100")}
                  >
                    {row.name}
                  </td>
                  {STAGE_ORDER.map((key) => {
                    const stage = row.byKey.get(key);
                    return (
                      <td className={TD} key={key}>
                        {stage ? (
                          <Tip
                            label={`${SCOPE_LABELS[stage.authorizationScope] ?? stage.authorizationScope} · ${stage.reasonCodes.join(", ") || "no reason recorded"}${stage.nextAttemptAt ? ` · next attempt ${timestamp(stage.nextAttemptAt)}` : ""}`}
                          >
                            <span
                              className={badge(stageTone(stage))}
                              tabIndex={0}
                            >
                              {STAGE_STATE_LABELS[stage.state] ?? stage.state}
                            </span>
                          </Tip>
                        ) : (
                          <span className="tw:text-ink-500">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="tw:m-0 tw:mb-4 tw:text-ink-400">
          No follow-on stages recorded yet.
        </p>
      )}
      <h4 className={SETTINGS_HEADING}>Waiting work</h4>
      {waiting.length ? (
        <ul className="tw:m-0 tw:mb-4 tw:list-none tw:p-0">
          {waiting.map((entry) => (
            <li
              className="tw:flex tw:flex-wrap tw:justify-between tw:gap-x-3 tw:border-t tw:border-line-subtle tw:py-[7px]"
              key={entry.work.workKey}
            >
              <strong className="tw:text-ink-150">
                {configLabel(entry.work)}
              </strong>
              <span className="tw:text-ink-350">{waitingDetail(entry)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tw:m-0 tw:mb-4 tw:text-ink-400">Nothing is waiting.</p>
      )}
      <h4 className={SETTINGS_HEADING}>Last cycle changes</h4>
      {status.lastCycle?.changes.length ? (
        <ul className="tw:m-0 tw:mb-4 tw:pl-[18px] tw:text-ink-300">
          {status.lastCycle.changes.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      ) : (
        <p className="tw:m-0 tw:mb-4 tw:text-ink-400">
          Nothing changed in the last cycle.
        </p>
      )}
      <h4 className={SETTINGS_HEADING}>Recent cycles</h4>
      {status.recentCycles.length ? (
        <div className="tw:overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr>
                {[
                  "Finished",
                  "Outcome",
                  "Evaluated",
                  "Dispatched",
                  "Blocked",
                  "Completed",
                  "Failed",
                ].map((label) => (
                  <th className={TH} key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {status.recentCycles.map((cycle) => (
                <tr key={cycle.cycleId}>
                  <td className={TD}>
                    {timestamp(cycle.finishedAt ?? cycle.startedAt)}
                  </td>
                  <td className={TD}>{cycle.outcome}</td>
                  <td className={TD}>{cycle.evaluated}</td>
                  <td className={TD}>{cycle.dispatched}</td>
                  <td className={TD}>{cycle.blocked}</td>
                  <td className={TD}>{cycle.succeeded}</td>
                  <td className={TD}>{cycle.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="tw:m-0 tw:text-ink-400">No cycle history recorded yet.</p>
      )}
    </div>
  );
}
