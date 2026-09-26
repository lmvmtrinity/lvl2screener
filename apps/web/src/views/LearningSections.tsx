import type {
  CalibrationRun,
  ChallengerExperiment,
  EvidenceAutomationStage,
  LearningDashboardOverview,
  StatisticalModel,
} from "@tsx-scanner/contracts";
import { Fragment, useState } from "react";
import {
  CARD,
  DOT_TONES,
  LABEL,
  LINK_BUTTON,
  PipelineStrip,
  type PipelineStep,
  SectionHead,
  Stat,
  badge,
} from "../components/PageSections.js";
import { classes } from "../lib/classes.js";
import {
  type EvidenceReadiness,
  QUIET_AFTER_DAYS,
  cohortKey,
  daysSinceSignal,
} from "../lib/learning-evidence.js";

type PipelineHealth = LearningDashboardOverview["pipelineHealth"];

const STAGE_NAMES: Record<string, string> = {
  COVERAGE: "Coverage check",
  QUALIFICATION: "Qualification check",
  STUDY: "Strategy study",
  TRAINING: "Challenger training",
  FORWARD_OBSERVATION: "Forward observation",
  DIAGNOSTICS: "Diagnostics",
};

const STAGE_PURPOSE: Record<string, string> = {
  COVERAGE: "verifies captured sessions for research datasets",
  QUALIFICATION: "checks cohorts against the sample gates",
  STUDY: "frozen comparative study",
  TRAINING: "trains an inactive challenger",
  FORWARD_OBSERVATION: "observes unseen opportunities",
  DIAGNOSTICS: "retained diagnostics report",
};

function clock(value: string): string {
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

function shortDay(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const ACRONYMS = new Set(["ORB", "VWAP", "RSI"]);

/** `PRIOR_DAY_HIGH_BREAKOUT` → `Prior Day High Breakout`, keeping acronyms. */
function strategyName(key: string): string {
  return key
    .split("_")
    .map((word, index) =>
      ACRONYMS.has(word)
        ? word
        : index > 0 && word === "OF"
          ? "of"
          : word.charAt(0) + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

/** `paper-coordination-v4-shadow` → `V4`; unknown formats pass through. */
function policyLabel(version: string): string {
  const match = /-v(\d+)/.exec(version);
  return match ? `V${match[1]}` : version;
}

function money(value: number): string {
  return `${value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}`;
}

/** Plain summary of the scheduler's last result for the status line. */
export function schedulerSummary(
  health: PipelineHealth,
  humanNoopReason: (reason: string) => string,
): string {
  if (health.checkOverdue) return "scheduled check overdue";
  if (health.lastState === "FAILED") return "last check failed";
  if (health.lastState === "SUCCESS") return "last check queued work";
  if (health.lastState === "NOOP" && health.lastNoopReason) {
    const text = humanNoopReason(health.lastNoopReason);
    return text.charAt(0).toLowerCase() + text.slice(1);
  }
  return health.lastState ? "idle" : "no check has run yet";
}

export interface RunningProcess {
  key: string;
  name: string;
  purpose: string;
  completed: number | null;
  total: number | null;
  unit: string | null;
  startedAt: string | null;
}

/** Evidence stages and the latest calibration that are queued or running. */
export function runningProcesses(
  stages: readonly EvidenceAutomationStage[],
  calibrations: readonly CalibrationRun[],
): RunningProcess[] {
  const running: RunningProcess[] = stages
    .filter((stage) => stage.state === "RUNNING" || stage.state === "QUEUED")
    .map((stage) => ({
      key: `${stage.key}:${stage.scopeId}`,
      name: STAGE_NAMES[stage.key] ?? stage.key,
      purpose:
        stage.state === "QUEUED" ? "queued" : (STAGE_PURPOSE[stage.key] ?? ""),
      completed: stage.progress?.completed ?? null,
      total: stage.progress?.total ?? null,
      unit: stage.progress?.unit ?? null,
      startedAt: stage.lastAttemptAt,
    }));
  const calibration = calibrations[0];
  if (calibration?.status === "RUNNING")
    running.push({
      key: `calibration:${calibration.id}`,
      name: `Calibration · ${calibration.name}`,
      purpose: "explores parameters on captured history",
      completed: calibration.combinationsTested,
      total: calibration.totalCombinations || null,
      unit: "combinations",
      startedAt: calibration.startedAt ?? calibration.createdAt,
    });
  return running;
}

export function LearningStatusLine({
  health,
  running,
  attention,
  humanNoopReason,
}: {
  health: PipelineHealth;
  running: number;
  attention: number;
  humanNoopReason: (reason: string) => string;
}) {
  const tone =
    attention || health.checkOverdue
      ? "bad"
      : running
        ? "pending"
        : health.schedulerEnabled
          ? "ok"
          : "waiting";
  const parts = [
    health.schedulerEnabled ? "Learning checks on" : "Learning checks off",
    running
      ? `${running} ${running === 1 ? "process" : "processes"} running`
      : "",
    attention
      ? `${attention} ${attention === 1 ? "needs" : "need"} review`
      : "",
    schedulerSummary(health, humanNoopReason),
    health.schedulerEnabled && health.nextCheckAt
      ? `next check ${weekdayTime(health.nextCheckAt)}`
      : "",
  ].filter(Boolean);
  return (
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
  );
}

export function LearningNowRunning({
  processes,
  health,
}: {
  processes: RunningProcess[];
  health: PipelineHealth;
}) {
  const active = processes[0];
  const scheduled = (
    <ol className="tw:m-0 tw:mt-[10px] tw:grid tw:list-none tw:gap-2 tw:p-0">
      {processes.slice(1).map((process) => (
        <li
          className="tw:flex tw:justify-between tw:gap-3 tw:text-[0.82rem] tw:text-ink-200"
          key={process.key}
        >
          {process.name}
          <span className="tw:text-[0.74rem] tw:text-ink-500">running</span>
        </li>
      ))}
      <li className="tw:flex tw:justify-between tw:gap-3 tw:text-[0.82rem] tw:text-ink-200">
        Evidence check
        <span className="tw:text-[0.74rem] tw:text-ink-500">
          {health.nextCheckAt
            ? weekdayTime(health.nextCheckAt)
            : health.schedulerEnabled
              ? "not yet known"
              : "off"}
        </span>
      </li>
      {health.lastCheckAt && (
        <li className="tw:flex tw:justify-between tw:gap-3 tw:text-[0.82rem] tw:text-ink-200">
          Last check
          <span className="tw:text-[0.74rem] tw:text-ink-500">
            {health.lastState?.toLowerCase() ?? "done"}{" "}
            {clock(health.lastCheckAt)}
          </span>
        </li>
      )}
    </ol>
  );
  if (!active)
    return (
      <section className="tw:mb-6" aria-label="Now running">
        <SectionHead title="Now running" />
        <div
          className={classes(
            CARD,
            "tw:grid tw:grid-cols-[minmax(0,1fr)_260px] tw:items-start tw:gap-7 tw:px-[22px] tw:py-4 tw:below-900:grid-cols-[minmax(0,1fr)]",
          )}
        >
          <p className="tw:m-0 tw:text-[0.84rem] tw:text-ink-300">
            Nothing is running. Learning checks run on schedule and when the
            worker starts.
          </p>
          <div>
            <div className={LABEL}>Scheduled</div>
            {scheduled}
          </div>
        </div>
      </section>
    );
  const measurable =
    active.completed !== null && active.total !== null && active.total > 0;
  const percent = measurable
    ? Math.round((active.completed! / active.total!) * 100)
    : 0;
  return (
    <section className="tw:mb-6" aria-label="Now running">
      <SectionHead title="Now running">
        Research processes · no live orders
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
                DOT_TONES.pending,
              )}
              aria-hidden="true"
            />
            <strong className="tw:text-[1.05rem] tw:font-semibold tw:text-ink-50">
              {active.name}
            </strong>
            <span className="tw:text-[0.78rem] tw:text-ink-400">
              {active.purpose}
            </span>
          </div>
          {measurable && (
            <div
              className="tw:mt-[14px] tw:mb-[9px] tw:h-2 tw:overflow-hidden tw:rounded-full tw:bg-surface-sunken"
              role="progressbar"
              aria-label={`${active.name} progress`}
              aria-valuemin={0}
              aria-valuemax={active.total!}
              aria-valuenow={active.completed!}
            >
              <div
                className="tw:h-full tw:rounded-full tw:bg-accent"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          <p className="tw:m-0 tw:mt-2 tw:flex tw:flex-wrap tw:gap-x-[18px] tw:gap-y-1 tw:text-[0.78rem] tw:text-ink-300">
            {measurable && (
              <span>
                <b className="tw:font-semibold tw:text-ink-100">
                  {active.completed} of {active.total}
                </b>{" "}
                {active.unit}
              </span>
            )}
            {active.startedAt && (
              <span>
                Started{" "}
                <b className="tw:font-semibold tw:text-ink-100">
                  {clock(active.startedAt)}
                </b>
              </span>
            )}
          </p>
        </div>
        <div className="tw:border-l tw:border-line tw:pl-6 tw:below-900:border-l-0 tw:below-900:border-t tw:below-900:pl-0 tw:below-900:pt-4">
          <div className={LABEL}>Scheduled</div>
          {scheduled}
        </div>
      </div>
    </section>
  );
}

export function TrainingProgress({
  current,
  datasetsCount,
  marketModels,
  experiments,
  review,
  onOpenProcesses,
}: {
  current: EvidenceReadiness[];
  datasetsCount: number;
  marketModels: StatisticalModel[];
  experiments: ChallengerExperiment[];
  review: string[];
  onOpenProcesses: () => void;
}) {
  const leader = current[0];
  const qualified = current.filter((row) => row.qualifies).length;
  const collecting = current.filter((row) => row.closedQuoteCount > 0).length;
  const activeModels = marketModels.filter((model) => model.active).length;
  const steps: PipelineStep[] = [
    {
      key: "collect",
      label: "Collect",
      tone: collecting ? "active" : "wait",
      detail: collecting
        ? `${collecting} ${collecting === 1 ? "strategy" : "strategies"} collecting outcomes`
        : "Waiting for closed outcomes",
    },
    {
      key: "qualify",
      label: "Qualify",
      tone: qualified ? "done" : "wait",
      detail: qualified
        ? `${qualified} qualified`
        : leader
          ? `Needs ${leader.threshold} outcomes, ${leader.newOutcomeThreshold} new, wins and losses`
          : "No cohorts yet",
    },
    {
      key: "dataset",
      label: "Dataset",
      tone: datasetsCount ? "done" : "wait",
      detail: datasetsCount
        ? `${datasetsCount} frozen (all markets)`
        : "Frozen once a strategy qualifies",
    },
    {
      key: "train",
      label: "Train",
      tone: marketModels.length ? "done" : "wait",
      detail: marketModels.length
        ? `${marketModels.length} ${marketModels.length === 1 ? "challenger" : "challengers"} trained`
        : "Inactive challenger, automatic",
    },
    {
      key: "observe",
      label: "Observe",
      tone: experiments.length ? "active" : "lock",
      detail: experiments.length
        ? `${experiments.length} enrolled`
        : "Needs market enrollment approval",
    },
    {
      key: "promote",
      label: "Promote",
      tone: activeModels ? "done" : "lock",
      detail: activeModels
        ? `${activeModels} active ${activeModels === 1 ? "model" : "models"}`
        : "Manual only, after comparison",
    },
  ];
  return (
    <section className="tw:mb-6" aria-label="Progress to training">
      <SectionHead title="Progress to training">
        <button type="button" className={LINK_BUTTON} onClick={onOpenProcesses}>
          Processes
        </button>
      </SectionHead>
      <div className={CARD}>
        <dl className="tw:m-0 tw:grid tw:grid-cols-[repeat(4,minmax(0,1fr))] tw:below-900:grid-cols-[repeat(2,minmax(0,1fr))]">
          <Stat
            label="Closest strategy"
            value={
              leader ? `${leader.closedQuoteCount} / ${leader.threshold}` : "—"
            }
            hint={
              leader
                ? `${strategyName(leader.cohort.strategy)} · ${leader.progressPct}%`
                : "no closed outcomes yet"
            }
          />
          <Stat
            label="Meeting the gates"
            value={`${qualified} / ${current.length}`}
            hint="current strategy cohorts"
          />
          <Stat
            label="Frozen datasets"
            value={String(datasetsCount)}
            hint="all markets · created when a cohort qualifies"
          />
          <Stat
            label="Needs attention"
            value={String(review.length)}
            hint={
              review.length
                ? "see the list below"
                : "no failed checks or errors"
            }
          />
        </dl>
        <PipelineStrip steps={steps} label="Learning pipeline" />
        {review.length > 0 && (
          <div className="tw:border-t tw:border-line tw:px-[22px] tw:py-4">
            <ul
              className="tw:m-0 tw:grid tw:list-none tw:gap-2 tw:p-0"
              aria-label="Needs review"
            >
              {review.map((item) => (
                <li
                  className="tw:rounded-[10px] tw:border tw:border-line-danger tw:bg-surface-danger tw:px-[14px] tw:py-[10px] tw:text-[0.8rem] tw:text-ink-150"
                  key={item}
                >
                  {item}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={classes(LINK_BUTTON, "tw:mt-3")}
              onClick={onOpenProcesses}
            >
              Open processes
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

const TH =
  "tw:whitespace-nowrap tw:border-b tw:border-line tw:px-4 tw:py-[13px] tw:first:pl-[22px] tw:last:pr-[22px] tw:font-sans tw:text-[0.68rem] tw:font-semibold tw:tracking-[0.08em] tw:uppercase tw:text-ink-500";
const TD =
  "tw:border-b tw:border-line-subtle tw:px-4 tw:py-[14px] tw:first:pl-[22px] tw:last:pr-[22px] tw:align-middle tw:text-[0.84rem] tw:text-ink-200";
const NUM =
  "tw:whitespace-nowrap tw:font-mono tw:text-[0.8rem] tw:tabular-nums";
const NARROW_HIDDEN = "tw:below-md:hidden";

function Gate({ met, children }: { met: boolean; children: string }) {
  return (
    <li className="tw:flex tw:items-center tw:gap-[6px]">
      <span
        className={classes(
          "tw:grid tw:h-[15px] tw:w-[15px] tw:place-items-center tw:rounded-full tw:text-[0.55rem] tw:font-bold",
          met ? "tw:bg-gain tw:text-bg" : "tw:border-[1.5px] tw:border-ink-500",
        )}
        aria-hidden="true"
      >
        {met ? "✓" : ""}
      </span>
      <span>
        {children}
        <span className="tw:sr-only">{met ? " (met)" : " (not met)"}</span>
      </span>
    </li>
  );
}

function rowStatus(
  row: EvidenceReadiness,
  now: number,
): { label: string; tone: string } {
  if (row.qualifies) return { label: "Qualified", tone: "ok" };
  const days = daysSinceSignal(row, now);
  if (days !== null && days >= QUIET_AFTER_DAYS)
    return { label: `Quiet ${days} days`, tone: "warn" };
  return { label: "Collecting", tone: "waiting" };
}

/** Current cohorts for the selected market, closest to the gates first. A row
 * expands to its gate checklist; older execution models collapse to a link. */
export function StrategyEvidenceTable({
  current,
  older,
  currentModel,
  now,
  onOpenCohort,
}: {
  current: EvidenceReadiness[];
  older: EvidenceReadiness[];
  currentModel: string | null;
  now: number;
  onOpenCohort: (key: string | null) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const strategyCounts = new Map<string, number>();
  for (const row of current)
    strategyCounts.set(
      row.cohort.strategy,
      (strategyCounts.get(row.cohort.strategy) ?? 0) + 1,
    );
  return (
    <section className="tw:mb-6" aria-label="Evidence by strategy">
      <SectionHead title="Evidence by strategy">
        Closed forward paper outcomes
        {currentModel ? ` · current execution model ${currentModel}` : ""}
      </SectionHead>
      <div className={CARD}>
        {current.length === 0 ? (
          <p className="tw:m-0 tw:px-[22px] tw:py-6 tw:text-center tw:text-[0.84rem] tw:text-ink-400">
            No closed outcomes for this market yet. Live sessions accumulate
            first; nothing is wrong while this is empty.
          </p>
        ) : (
          <div className="tw:overflow-x-auto">
            <table className="tw:w-full tw:border-collapse">
              <thead>
                <tr>
                  <th className={classes(TH, "tw:text-left")}>Strategy</th>
                  <th className={classes(TH, "tw:text-left")}>
                    Closed outcomes
                  </th>
                  <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                    New since dataset
                  </th>
                  <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                    Wins / losses
                  </th>
                  <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                    Last signal
                  </th>
                  <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {current.map((row) => {
                  const key = cohortKey(row);
                  const open = expanded === key;
                  const status = rowStatus(row, now);
                  const { cohort } = row;
                  const duplicate =
                    (strategyCounts.get(cohort.strategy) ?? 0) > 1;
                  return (
                    <Fragment key={key}>
                      <tr
                        className={classes(
                          "evidence-row",
                          open && "tw:bg-surface-raised",
                        )}
                      >
                        <td
                          className={classes(
                            TD,
                            open && "tw:shadow-[inset_3px_0_0_var(--accent)]",
                          )}
                        >
                          <button
                            type="button"
                            className="tw:grid tw:cursor-pointer tw:gap-[2px] tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:hover:[&_strong]:text-accent"
                            aria-expanded={open}
                            onClick={() => setExpanded(open ? null : key)}
                          >
                            <strong className="tw:text-[0.88rem] tw:font-semibold tw:text-ink-50">
                              {strategyName(cohort.strategy)}
                            </strong>
                            <small className="tw:text-[0.74rem] tw:text-ink-500">
                              {duplicate ? `${cohort.configVersion} · ` : ""}
                              {cohort.firstSignalAt
                                ? `first signal ${shortDay(cohort.firstSignalAt)}`
                                : "no signal yet"}
                              <span className="tw:hidden tw:below-md:inline">
                                {` · ${status.label}`}
                              </span>
                            </small>
                          </button>
                        </td>
                        <td className={TD}>
                          <span className="tw:flex tw:items-center tw:gap-[10px]">
                            <span
                              className="tw:h-[6px] tw:w-[90px] tw:shrink-0 tw:overflow-hidden tw:rounded-full tw:bg-surface-sunken"
                              aria-hidden="true"
                            >
                              <span
                                className={classes(
                                  "tw:block tw:h-full tw:rounded-full",
                                  row.closedQuoteCount >= row.threshold
                                    ? "tw:bg-gain"
                                    : "tw:bg-accent",
                                )}
                                style={{
                                  width: `${Math.min(100, row.progressPct)}%`,
                                }}
                              />
                            </span>
                            <span className={classes(NUM, "tw:text-ink-300")}>
                              {row.closedQuoteCount} / {row.threshold}
                            </span>
                          </span>
                        </td>
                        <td
                          className={classes(
                            TD,
                            NUM,
                            "tw:text-right",
                            NARROW_HIDDEN,
                          )}
                        >
                          {row.newOutcomesSinceLastDataset} /{" "}
                          {row.newOutcomeThreshold}
                        </td>
                        <td
                          className={classes(
                            TD,
                            NUM,
                            "tw:text-right",
                            NARROW_HIDDEN,
                          )}
                        >
                          <span className="tw:text-gain">
                            {cohort.positives}
                          </span>{" "}
                          /{" "}
                          <span className="tw:text-danger">
                            {cohort.negatives}
                          </span>
                        </td>
                        <td
                          className={classes(
                            TD,
                            NUM,
                            "tw:text-right",
                            NARROW_HIDDEN,
                          )}
                        >
                          {cohort.lastSignalAt
                            ? shortDay(cohort.lastSignalAt)
                            : "—"}
                        </td>
                        <td
                          className={classes(
                            TD,
                            "tw:text-right",
                            NARROW_HIDDEN,
                          )}
                        >
                          <span className={badge(status.tone)}>
                            {status.label}
                          </span>
                        </td>
                      </tr>
                      {open && (
                        <tr className="tw:bg-surface-raised">
                          <td
                            colSpan={6}
                            className="tw:border-b tw:border-line tw:px-[22px] tw:pt-1 tw:pb-5 tw:shadow-[inset_3px_0_0_var(--accent)]"
                          >
                            <ul
                              className="tw:m-0 tw:flex tw:list-none tw:flex-wrap tw:gap-x-5 tw:gap-y-2 tw:p-0 tw:text-[0.8rem] tw:text-ink-300"
                              aria-label="Training gates"
                            >
                              <Gate met={row.closedQuoteCount >= row.threshold}>
                                {`${row.threshold} closed outcomes (${row.closedQuoteCount})`}
                              </Gate>
                              <Gate
                                met={
                                  row.newOutcomesSinceLastDataset >=
                                  row.newOutcomeThreshold
                                }
                              >
                                {`${row.newOutcomeThreshold} new since last dataset (${row.newOutcomesSinceLastDataset})`}
                              </Gate>
                              <Gate
                                met={
                                  cohort.positives > 0 && cohort.negatives > 0
                                }
                              >
                                Both wins and losses present
                              </Gate>
                            </ul>
                            <div className="tw:mt-[14px] tw:flex tw:flex-wrap tw:items-baseline tw:justify-between tw:gap-3 tw:text-[0.8rem] tw:text-ink-300">
                              <span>
                                Training starts automatically once every gate
                                and research qualification pass. Activation
                                stays manual.
                              </span>
                              <button
                                type="button"
                                className={LINK_BUTTON}
                                onClick={() => onOpenCohort(key)}
                              >
                                Cohort details →
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {older.length > 0 && (
          <div className="tw:flex tw:flex-wrap tw:justify-between tw:gap-3 tw:border-t tw:border-line-subtle tw:px-[22px] tw:py-3 tw:text-[0.8rem] tw:text-ink-400">
            <span>
              {older.length} older {older.length === 1 ? "cohort" : "cohorts"}{" "}
              from retired execution models {older.length === 1 ? "is" : "are"}{" "}
              kept for audit.
            </span>
            <button
              type="button"
              className={LINK_BUTTON}
              onClick={() => onOpenCohort(cohortKey(older[0]!))}
            >
              Show older cohorts
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function ModelsAndShadow({
  marketModels,
  shadow,
  onOpenModels,
}: {
  marketModels: StatisticalModel[];
  shadow: LearningDashboardOverview["shadowExperiments"];
  onOpenModels: () => void;
}) {
  const same = shadow.primaryNetPnl === shadow.hypotheticalNetPnl;
  return (
    <section className="tw:mb-4" aria-label="Models and shadow comparison">
      <SectionHead title="Models & shadow comparison">
        Evidence only · nothing here activates a model
      </SectionHead>
      <div className="tw:grid tw:grid-cols-[1fr_1.25fr] tw:gap-4 tw:below-900:grid-cols-[1fr]">
        <div className={classes(CARD, "tw:px-[22px] tw:py-5")}>
          <div className={LABEL}>Challenger models</div>
          {marketModels.length === 0 ? (
            <>
              <p className="tw:mx-0 tw:mt-2 tw:mb-[6px] tw:text-[0.95rem] tw:font-semibold tw:text-ink-50">
                None trained yet
              </p>
              <p className="tw:m-0 tw:text-[0.8rem] tw:leading-[1.5] tw:text-ink-400">
                A challenger is trained automatically, and kept inactive, after
                a strategy cohort qualifies. The deterministic strategy keeps
                deciding until you promote one.
              </p>
            </>
          ) : (
            <ul className="tw:m-0 tw:mt-3 tw:grid tw:list-none tw:gap-2 tw:p-0">
              {marketModels.slice(0, 3).map((model) => (
                <li
                  className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:text-[0.82rem]"
                  key={model.id}
                >
                  <span className="tw:text-ink-100">
                    {strategyName(model.strategy)} · {model.modelVersion}
                  </span>
                  <span className={badge(model.active ? "ok" : "waiting")}>
                    {model.active ? "Active" : model.status.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className={classes(LINK_BUTTON, "tw:mt-3")}
            onClick={onOpenModels}
          >
            {marketModels.length ? "Manage models →" : "Models & monitoring →"}
          </button>
        </div>
        <div className={classes(CARD, "tw:px-[22px] tw:py-5")}>
          <div className={LABEL}>
            {policyLabel(shadow.policyVersion)} shadow vs{" "}
            {policyLabel(shadow.comparatorPolicyVersion)} primary · all markets
          </div>
          <dl className="tw:m-0 tw:mt-[14px] tw:grid tw:grid-cols-[repeat(3,minmax(0,1fr))] tw:gap-3">
            <div>
              <dt className={LABEL}>Decisions</dt>
              <dd className="tw:m-0 tw:mt-[6px] tw:text-[1.25rem] tw:font-semibold tw:text-ink-50">
                {shadow.decisionsEvaluated}
              </dd>
              <dd className="tw:m-0 tw:mt-[3px] tw:text-[0.72rem] tw:text-ink-400">
                evaluated side by side
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Different picks</dt>
              <dd className="tw:m-0 tw:mt-[6px] tw:text-[1.25rem] tw:font-semibold tw:text-ink-50">
                {shadow.selectionChangesCount}
              </dd>
              <dd className="tw:m-0 tw:mt-[3px] tw:text-[0.72rem] tw:text-ink-400">
                {(shadow.selectionChangeRate * 100).toFixed(1)}% change rate
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Net P&amp;L</dt>
              <dd
                className={classes(
                  "tw:m-0 tw:mt-[6px] tw:text-[1.25rem] tw:font-semibold",
                  shadow.primaryNetPnl < 0
                    ? "tw:text-danger"
                    : shadow.primaryNetPnl > 0
                      ? "tw:text-gain"
                      : "tw:text-ink-50",
                )}
              >
                {money(shadow.primaryNetPnl)}
              </dd>
              <dd className="tw:m-0 tw:mt-[3px] tw:text-[0.72rem] tw:text-ink-400">
                {same
                  ? `same for both · ${shadow.primaryCumulativeR.toFixed(2)}R`
                  : `shadow ${money(shadow.hypotheticalNetPnl)} · ${shadow.hypotheticalCumulativeR.toFixed(2)}R`}
              </dd>
            </div>
          </dl>
          <p className="tw:m-0 tw:mt-3 tw:text-[0.72rem] tw:leading-[1.45] tw:text-ink-500">
            Hypothetical shadow results are model-informed evidence, not an
            account balance and not a reason to activate a model.
          </p>
        </div>
      </div>
    </section>
  );
}
