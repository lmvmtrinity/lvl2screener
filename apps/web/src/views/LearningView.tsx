import {
  calibrationRunListSchema,
  learningAutomationRunListSchema,
  learningDashboardOverviewSchema,
  evidenceAutomationResponseSchema,
  paperCoordinationDecisionListSchema,
  statisticalModelListSchema,
  statisticalModelSchema,
  type CalibrationRun,
  type LearningAutomationRun,
  type LearningDashboardOverview,
  type PaperCoordinationDecision,
  type StatisticalModel,
  type EvidenceAutomationStage,
  type MarketId,
  challengerExperimentDetailSchema,
  challengerExperimentListSchema,
  type ChallengerExperiment,
  type ChallengerObservationReport,
} from "@tsx-scanner/contracts";
import { useEffect, useRef, useState } from "react";
import { getJson, sendJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { ago, displayStrategy, countdown } from "../lib/format.js";
import { useNow } from "../lib/use-now.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";
import { Tip } from "../ui.js";
import { EvidenceAutomationPanel } from "./EvidenceAutomationPanel.js";
import { ChallengerObservationSummary } from "./ChallengerObservationSummary.js";

type LearningSection = "overview" | "processes" | "results" | "diagnostics";

const SECTIONS: [LearningSection, string][] = [
  ["overview", "OVERVIEW"],
  ["processes", "PROCESSES"],
  ["results", "RESULTS"],
  ["diagnostics", "DIAGNOSTICS"],
];

const VIEW_CLASSES =
  "tw:flex tw:flex-col tw:gap-[24px] tw:pb-[40px] tw:pt-[16px]";
const NAV_CLASSES =
  "tw:mb-[16px] tw:flex tw:flex-wrap tw:items-center tw:gap-[6px] tw:rounded-panel tw:border tw:border-line tw:bg-surface tw:px-[10px] tw:py-[8px]";
const NAV_BUTTON_CLASSES =
  "tw:cursor-pointer tw:rounded-[6px] tw:border tw:px-[12px] tw:py-[7px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em]";
const NAV_BUTTON_IDLE_CLASSES =
  "tw:border-transparent tw:bg-transparent tw:text-ink-550 tw:hover:bg-surface-raised tw:hover:text-ink-100";
const NAV_BUTTON_ACTIVE_CLASSES =
  "tw:border-accent tw:bg-accent tw:text-on-accent";
const NAV_FRESH_CLASSES =
  "tw:ml-auto tw:font-mono tw:text-[0.61rem] tw:font-[650] tw:leading-[normal] tw:tracking-[0.05em] tw:text-ink-650 tw:below-md:ml-0 tw:below-md:basis-full";
const SITUATION_CLASSES =
  "tw:mb-[16px] tw:rounded-panel tw:border tw:border-line-accent-dim tw:bg-surface tw:px-[20px] tw:py-[16px]";
const SITUATION_TITLE_CLASSES =
  "tw:block tw:text-[0.95rem] tw:leading-[1.5] tw:text-ink-100";
const SITUATION_NEXT_CLASSES =
  "tw:mx-0 tw:mt-[8px] tw:mb-0 tw:text-[0.78rem] tw:text-ink-550";
const REVIEW_CLASSES =
  "tw:mb-[16px] tw:rounded-panel tw:border tw:border-line-warn-strong tw:bg-surface-warn tw:px-[18px] tw:py-[14px]";
const REVIEW_TITLE_CLASSES =
  "tw:font-mono tw:text-[0.68rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-warn-soft";
const REVIEW_LIST_CLASSES =
  "tw:mx-0 tw:mt-[8px] tw:mb-[10px] tw:pl-[18px] tw:text-[0.78rem] tw:leading-[1.6] tw:text-ink-250";
const REVIEW_BUTTON_CLASSES =
  "tw:cursor-pointer tw:rounded-[6px] tw:border tw:border-line-warn-strong tw:bg-surface tw:px-[11px] tw:py-[7px] tw:font-mono tw:text-[0.6rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.06em] tw:text-warn-soft";
const HELP_CLASSES =
  "tw:cursor-help tw:text-ink-500 tw:underline tw:decoration-dotted";
const METRIC_CARDS_CLASSES =
  "tw:grid tw:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] tw:gap-[16px]";
const METRIC_CARD_CLASSES =
  "tw:flex tw:flex-col tw:gap-[6px] tw:rounded-[8px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[20px] tw:py-[16px]";
const CARD_LABEL_CLASSES =
  "tw:font-mono tw:text-[0.65rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-ink-500";
const CARD_VALUE_CLASSES =
  "tw:flex tw:items-center tw:gap-[8px] tw:text-[1.4rem] tw:font-bold tw:text-ink-50";
const CARD_DETAIL_CLASSES = "tw:text-[0.75rem] tw:text-ink-400";
const SECTION_CLASSES =
  "tw:flex tw:flex-col tw:gap-[16px] tw:rounded-[8px] tw:border tw:border-line tw:bg-surface tw:px-[24px] tw:py-[20px]";
const SECTION_HEADER_CLASSES =
  "tw:flex tw:items-center tw:justify-between tw:border-b tw:border-b-line-subtle tw:pb-[12px]";
const SECTION_TITLE_CLASSES =
  "tw:m-0 tw:text-[1.05rem] tw:font-semibold tw:text-ink-100";
const SECTION_TAG_CLASSES =
  "tw:font-mono tw:text-[0.65rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-accent";
const SECTION_DESCRIPTION_CLASSES =
  "tw:mx-0 tw:mt-[4px] tw:mb-0 tw:text-[0.8rem] tw:text-ink-400";
const PIPELINE_BANNER_CLASSES =
  "tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-[12px] tw:rounded-[6px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[18px] tw:py-[14px]";
const PIPELINE_METRICS_CLASSES =
  "tw:flex tw:gap-[20px] tw:text-[0.85rem] tw:text-ink-300 tw:below-md:flex-col tw:below-md:gap-[6px]";
const INLINE_WARNING_CLASSES =
  "tw:mx-0 tw:mt-[8px] tw:mb-0 tw:rounded-[6px] tw:border tw:border-line-warn tw:bg-surface-warn tw:px-[10px] tw:py-[8px] tw:text-[0.74rem] tw:leading-[1.5] tw:text-warn-soft";
const INLINE_ERROR_CLASSES =
  "tw:mx-0 tw:mt-[8px] tw:mb-0 tw:rounded-[6px] tw:border tw:border-line-danger tw:bg-surface-danger tw:px-[10px] tw:py-[8px] tw:text-[0.74rem] tw:leading-[1.5] tw:text-danger-tint-soft";
const RUN_DETAIL_CLASSES = "tw:mt-[6px] tw:text-[0.68rem] tw:text-ink-550";
const RUN_SUMMARY_CLASSES = "tw:cursor-pointer";
const HISTORY_LIST_CLASSES =
  "tw:mx-0 tw:mt-[8px] tw:mb-0 tw:max-h-[220px] tw:overflow-y-auto tw:pl-[18px] tw:text-[0.72rem] tw:leading-[1.7] tw:text-ink-400";
const COHORT_SELECT_CLASSES =
  "tw:grid tw:mb-[14px] tw:max-w-[520px] tw:gap-[6px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700 tw:below-md:max-w-full";
const COHORT_SELECT_CONTROL_CLASSES =
  "tw:rounded-[7px] tw:border tw:border-line-input tw:bg-bg tw:px-[10px] tw:py-[9px] tw:font-sans tw:text-[0.78rem] tw:font-semibold tw:leading-[normal] tw:text-ink-100";
const COHORT_CARD_CLASSES =
  "tw:flex tw:flex-col tw:gap-[10px] tw:rounded-[6px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[18px] tw:py-[14px]";
const COHORT_DETAIL_CLASSES = "tw:max-w-[760px]";
const COHORT_HEADER_CLASSES = "tw:flex tw:items-center tw:justify-between";
const COHORT_IDENTITY_CLASSES =
  "tw:text-[0.76rem] tw:leading-[1.6] tw:text-ink-550";
const COHORT_IDENTITY_CODE_CLASSES = "tw:font-mono";
const PROGRESS_CONTAINER_CLASSES =
  "tw:h-[6px] tw:overflow-hidden tw:rounded-[3px] tw:bg-surface-sunken";
const PROGRESS_FILL_CLASSES =
  "tw:h-full tw:bg-accent tw:transition-[width] tw:duration-[0.3s] tw:ease-[ease]";
const COHORT_STATS_CLASSES =
  "tw:flex tw:justify-between tw:text-[0.75rem] tw:text-ink-400";
const GATES_CLASSES = "tw:mx-0 tw:mt-[12px] tw:mb-0 tw:list-none tw:p-0";
const GATE_ITEM_CLASSES =
  "tw:relative tw:mx-0 tw:my-[5px] tw:pl-[20px] tw:text-[0.78rem] tw:leading-[1.5] tw:text-ink-300 tw:before:absolute tw:before:top-[0.42em] tw:before:left-0 tw:before:h-[8px] tw:before:w-[8px] tw:before:rounded-full tw:before:border tw:before:content-['']";
const GATE_ITEM_MET_CLASSES = "tw:before:border-accent tw:before:bg-accent";
const GATE_ITEM_UNMET_CLASSES =
  "tw:before:border-ink-600 tw:before:bg-transparent";
const GATES_NOTE_CLASSES =
  "tw:mx-0 tw:mt-[12px] tw:mb-0 tw:text-[0.72rem] tw:leading-[1.6] tw:text-ink-650";
const PROCESS_CARD_CLASSES =
  "tw:max-w-[760px] tw:rounded-panel tw:border tw:border-line tw:bg-surface tw:px-[18px] tw:py-[16px]";
const CHALLENGER_LIST_CLASSES = "tw:mb-[1rem] tw:grid tw:gap-[0.75rem]";
const CHALLENGER_CARD_CLASSES =
  "tw:grid tw:w-full tw:cursor-pointer tw:gap-[0.25rem] tw:rounded-input tw:border tw:bg-surface tw:px-[14px] tw:py-[12px] tw:text-left tw:text-ink-300";
const CHALLENGER_CARD_IDLE_CLASSES =
  "tw:border-line tw:hover:border-line-accent-dim tw:hover:bg-surface-raised";
const CHALLENGER_CARD_SELECTED_CLASSES =
  "tw:border-line-accent-mid tw:shadow-[inset_0_0_0_1px_var(--line-accent-dim)] tw:hover:bg-surface-raised";
const CHALLENGER_CARD_TEXT_CLASSES = "tw:text-ink-550";
const MODELS_LIST_CLASSES = "tw:flex tw:flex-col tw:gap-[10px]";
const MODEL_ITEM_CLASSES =
  "tw:flex tw:cursor-pointer tw:items-center tw:justify-between tw:rounded-[6px] tw:border tw:bg-surface-raised tw:px-[16px] tw:py-[12px]";
const MODEL_ITEM_IDLE_CLASSES = "tw:border-line-subtle";
const MODEL_ITEM_SELECTED_CLASSES = "tw:border-accent";
const MODEL_SUMMARY_CLASSES = "tw:flex tw:flex-col tw:gap-[2px]";
const MODEL_METRICS_CLASSES =
  "tw:flex tw:items-center tw:gap-[12px] tw:text-[0.8rem] tw:text-ink-400";
const TOGGLE_BUTTON_CLASSES =
  "tw:cursor-pointer tw:rounded-[4px] tw:border tw:border-line tw:bg-surface tw:px-[10px] tw:py-[4px] tw:text-[0.75rem] tw:text-ink-200 tw:hover:border-accent tw:hover:bg-surface-raised";
const MONITORING_CARD_CLASSES =
  "tw:flex tw:flex-col tw:gap-[8px] tw:rounded-[6px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[16px] tw:py-[12px]";
const MONITORING_HEADER_CLASSES = "tw:flex tw:items-center tw:justify-between";
const MONITORING_STATS_CLASSES =
  "tw:grid tw:grid-cols-[repeat(3,1fr)] tw:gap-[8px]";
const STAT_BOX_CLASSES =
  "tw:flex tw:flex-col tw:gap-[2px] tw:rounded-[4px] tw:bg-surface-sunken tw:p-[8px]";
const STAT_BOX_LABEL_CLASSES = "tw:text-[0.65rem] tw:text-ink-500";
const STAT_BOX_VALUE_CLASSES =
  "tw:text-[0.85rem] tw:font-semibold tw:text-ink-100";
const MONITORING_FRESHNESS_CLASSES =
  "tw:mx-0 tw:mt-[10px] tw:mb-0 tw:text-[0.68rem] tw:text-ink-650";
const GATES_PROGRESS_CLASSES =
  "tw:mb-[16px] tw:grid tw:grid-cols-[repeat(auto-fit,minmax(240px,1fr))] tw:gap-[16px] tw:below-md:grid-cols-[1fr]";
const GATES_PROGRESS_LABEL_CLASSES =
  "tw:mb-[7px] tw:block tw:text-[0.74rem] tw:text-ink-400";
const GATES_PROGRESS_STRONG_CLASSES = "tw:font-mono tw:text-ink-150";
const RAW_ID_CLASSES =
  "tw:mt-[4px] tw:block tw:font-mono tw:text-[0.6rem] tw:text-ink-650 tw:break-all";
const SHADOW_STATS_CLASSES =
  "tw:grid tw:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] tw:gap-[14px]";
const STAT_CARD_CLASSES =
  "tw:flex tw:flex-col tw:gap-[4px] tw:rounded-[6px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:p-[14px]";
const STAT_CARD_LABEL_CLASSES =
  "tw:font-mono tw:text-[0.65rem] tw:font-bold tw:leading-[normal] tw:text-ink-500";
const STAT_CARD_VALUE_CLASSES = "tw:m-0 tw:text-[1.3rem] tw:font-bold";
const STAT_CARD_VALUE_TONES: Record<string, string> = {
  default: "tw:text-ink-50",
  primary: "tw:text-ink-100",
  shadow: "tw:text-accent-tint",
};
const DRILLDOWN_CLASSES =
  "tw:grid tw:grid-cols-[280px_1fr] tw:gap-[20px] tw:below-900:grid-cols-[1fr]";
const DECISIONS_LIST_CLASSES =
  "tw:flex tw:max-h-[500px] tw:flex-col tw:gap-[8px] tw:overflow-y-auto";
const DECISION_ITEM_CLASSES =
  "tw:flex tw:cursor-pointer tw:flex-col tw:gap-[4px] tw:rounded-[6px] tw:border tw:bg-surface-raised tw:px-[12px] tw:py-[10px]";
const DECISION_ITEM_IDLE_CLASSES = "tw:border-line-subtle";
const DECISION_ITEM_SELECTED_CLASSES = "tw:border-accent";
const ITEM_ROW_CLASSES = "tw:flex tw:items-center tw:justify-between";
const DETAIL_VIEW_CLASSES =
  "tw:flex tw:flex-col tw:gap-[16px] tw:rounded-[6px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[20px] tw:py-[16px]";
const DECISION_HEADLINE_CLASSES =
  "tw:flex tw:items-start tw:justify-between tw:border-b tw:border-b-line-subtle tw:pb-[12px]";
const DECISION_TITLE_CLASSES = "tw:mx-0 tw:mt-0 tw:mb-[4px] tw:text-[1.1rem]";
const SHADOW_HEADLINE_CLASSES = "tw:mt-[4px] tw:text-accent-tint";
const TRADE_PILL_CLASSES =
  "tw:flex tw:flex-col tw:items-end tw:gap-[2px] tw:rounded-[6px] tw:border tw:border-line tw:bg-surface-sunken tw:px-[14px] tw:py-[8px]";
const TABLE_CLASSES =
  "tw:w-full tw:border-collapse tw:text-left tw:text-[0.8rem]";
const TABLE_HEADER_CLASSES =
  "tw:border-b tw:border-b-line tw:px-[14px] tw:py-[10px] tw:font-mono tw:text-[0.65rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.06em] tw:text-ink-500";
const TABLE_CELL_CLASSES =
  "tw:border-b tw:border-b-line-subtle tw:px-[14px] tw:py-[10px] tw:text-ink-200";
const TABLE_ROW_HOVER_CLASSES = "tw:hover:bg-surface-raised";
const TABLE_ROW_V3_CLASSES = "tw:bg-[rgba(34,197,94,0.08)]";
const TABLE_ROW_V4_CLASSES = "tw:bg-[rgba(245,158,11,0.08)]";
const BADGE_BASE_CLASSES =
  "tw:inline-block tw:w-max tw:rounded-[4px] tw:border tw:px-[8px] tw:py-[2px] tw:font-mono tw:text-[0.7rem] tw:font-semibold tw:leading-none tw:tracking-[0.04em]";
const BADGE_TONE_CLASSES: Record<string, string> = {
  success:
    "tw:border-[rgba(34,197,94,0.3)] tw:bg-[rgba(34,197,94,0.15)] tw:text-[#4ade80]",
  neutral: "tw:border-line-subtle tw:bg-surface-raised tw:text-ink-400",
  warn: "tw:border-[rgba(245,158,11,0.3)] tw:bg-[rgba(245,158,11,0.15)] tw:text-accent",
  danger:
    "tw:border-[rgba(248,113,113,0.3)] tw:bg-[rgba(248,113,113,0.15)] tw:text-danger",
  info: "tw:border-[rgba(56,189,248,0.3)] tw:bg-[rgba(56,189,248,0.15)] tw:text-[#38bdf8]",
};

function badgeClasses(tone: string): string {
  return classes(BADGE_BASE_CLASSES, BADGE_TONE_CLASSES[tone]);
}

const SUMMARY_LIST_CLASSES =
  "tw:m-0 tw:grid tw:grid-cols-[repeat(auto-fit,minmax(110px,1fr))] tw:gap-[8px]";
const SUMMARY_ITEM_CLASSES =
  "tw:rounded-[6px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[10px] tw:py-[8px]";
const SUMMARY_LABEL_CLASSES =
  "tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:uppercase tw:text-ink-500";
const SUMMARY_VALUE_CLASSES =
  "tw:mx-0 tw:mt-[3px] tw:mb-0 tw:font-bold tw:text-ink-100";

function humanNoopReason(reason: string): string {
  if (reason.includes("INSUFFICIENT_CLOSED_QUOTES"))
    return "Waiting for enough closed outcomes";
  if (reason.includes("INSUFFICIENT_NEW_OUTCOMES"))
    return "Waiting for enough new outcomes since the last dataset";
  if (reason.includes("CLASS_IMBALANCE"))
    return "Waiting for both win and loss examples";
  if (reason.includes("NO_QUALIFYING"))
    return "No compatible cohort currently meets the gates";
  return reason.replaceAll("_", " ").toLowerCase();
}

function humanGateReason(reason: string | null): string {
  if (!reason) return "Still collecting";
  if (reason.startsWith("INSUFFICIENT_CLOSED_QUOTES"))
    return "Fewer closed quote outcomes than the gate requires";
  if (reason.startsWith("INSUFFICIENT_NEW_OUTCOMES"))
    return "Not enough new outcomes since the last frozen dataset";
  if (reason.startsWith("CLASS_IMBALANCE"))
    return "Needs both positive and negative examples";
  return reason.replaceAll("_", " ").toLowerCase();
}

/** Human summary of the scheduler itself; the API's raw explanation (which
 * contains reason codes) stays in the details block below it. */
function schedulerHeadline(
  health: LearningDashboardOverview["pipelineHealth"],
): string {
  if (health.checkOverdue)
    return "The scheduled evidence check is overdue; the worker may not be running.";
  switch (health.lastState) {
    case "SUCCESS":
      return "The last scheduled check completed and queued work.";
    case "NOOP":
      return health.lastNoopReason
        ? `Scheduler idle · ${humanNoopReason(health.lastNoopReason)}`
        : "Scheduler idle · No qualifying new outcomes.";
    case "FAILED":
      return "The last scheduled check failed. Review the error below.";
    default:
      return "No scheduled check has run yet.";
  }
}

function runBadge(state: LearningAutomationRun["state"]): string {
  return state === "SUCCESS"
    ? "success"
    : state === "NOOP"
      ? "neutral"
      : "danger";
}

function reviewItems(
  overview: LearningDashboardOverview,
  runs: LearningAutomationRun[],
  stages: EvidenceAutomationStage[],
  models: StatisticalModel[],
  report: ChallengerObservationReport | null,
): string[] {
  const items: string[] = [];
  const failedRuns = runs.filter((run) => run.state === "FAILED").length;
  if (failedRuns > 0)
    items.push(
      `${failedRuns} scheduled learning check${failedRuns === 1 ? "" : "s"} failed`,
    );
  const failedStages = stages.filter((stage) =>
    ["FAILED", "INTERRUPTED", "CANCELLED"].includes(stage.state),
  ).length;
  if (failedStages > 0)
    items.push(
      `${failedStages} evidence process${failedStages === 1 ? "" : "es"} need review`,
    );
  const brokenModels = models.filter(
    (model) =>
      model.error !== null ||
      ["FAILED", "INTERRUPTED"].includes(model.status) ||
      model.warnings.length > 0,
  ).length;
  if (brokenModels > 0)
    items.push(
      `${brokenModels} model record${brokenModels === 1 ? "" : "s"} with warnings or errors`,
    );
  if (report && report.population.missedDeadline > 0)
    items.push(
      `${report.population.missedDeadline} prospective observation${report.population.missedDeadline === 1 ? "" : "s"} missed the capture deadline`,
    );
  if (overview.pipelineHealth.durableErrors > 0)
    items.push(
      `${overview.pipelineHealth.durableErrors} durable error${overview.pipelineHealth.durableErrors === 1 ? "" : "s"} recorded`,
    );
  if (overview.pipelineHealth.checkOverdue)
    items.unshift(
      "The scheduled evidence check is overdue for its cadence; the worker may not be running",
    );
  return items;
}

export function LearningView({ marketId }: { marketId: MarketId }) {
  const requestGeneration = useRef(0);
  const activeLoadRef = useRef<AbortController | null>(null);
  const [section, setSection] = useState<LearningSection>("overview");
  const [overview, setOverview] = useState<LearningDashboardOverview | null>(
    null,
  );
  const [runs, setRuns] = useState<LearningAutomationRun[]>([]);
  const [decisions, setDecisions] = useState<PaperCoordinationDecision[]>([]);
  const [models, setModels] = useState<StatisticalModel[]>([]);
  const [calibrations, setCalibrations] = useState<CalibrationRun[]>([]);
  const [selectedCohortKey, setSelectedCohortKey] = useState<string | null>(
    null,
  );
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(
    null,
  );
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedExperimentId, setSelectedExperimentId] = useState<
    string | null
  >(null);
  const [automationStages, setAutomationStages] = useState<
    EvidenceAutomationStage[]
  >([]);
  const [challengerExperiments, setChallengerExperiments] = useState<
    ChallengerExperiment[]
  >([]);
  const [retainedChallengerReport, setChallengerReport] =
    useState<ChallengerObservationReport | null>(null);
  const [reportLoad, setReportLoad] = useState<{
    experimentId: string;
    loading: boolean;
    error: boolean;
    checkedAt: string | null;
  } | null>(null);
  const challengerReport =
    retainedChallengerReport?.experimentId === selectedExperimentId
      ? retainedChallengerReport
      : null;
  const selectedReportLoad =
    reportLoad?.experimentId === selectedExperimentId ? reportLoad : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  // Bumped by every successful overview load so the selected challenger report
  // participates in the same poll/focus/market refresh lifecycle instead of
  // staying stale while the header claims a fresh check.
  const [refreshVersion, setRefreshVersion] = useState(0);

  const loadData = async () => {
    // One request cycle at a time: a new invocation (focus, poll, activation)
    // aborts the previous one instead of overlapping it, and the generation
    // guard discards anything that still resolves late.
    activeLoadRef.current?.abort();
    const signal = new AbortController();
    activeLoadRef.current = signal;
    const generation = ++requestGeneration.current;
    const current = () =>
      !signal.signal.aborted && generation === requestGeneration.current;
    try {
      setLoading(true);
      setError(null);
      const [
        overviewData,
        runsData,
        decisionsData,
        modelsData,
        automationData,
        challengerData,
        calibrationData,
      ] = await Promise.all([
        getJson("/api/learning/overview", signal.signal),
        getJson("/api/learning/automation-runs?limit=25", signal.signal),
        getJson("/api/learning/coordination-decisions?limit=50", signal.signal),
        getJson("/api/statistical-models?limit=50", signal.signal),
        getJson(
          `/api/learning/evidence-automation?marketId=${marketId}`,
          signal.signal,
        ),
        getJson(
          `/api/challenger-experiments?marketId=${marketId}`,
          signal.signal,
        ),
        getJson(
          `/api/calibrations?marketId=${marketId}&limit=25`,
          signal.signal,
        ),
      ]);

      if (!current()) return;
      setOverview(learningDashboardOverviewSchema.parse(overviewData));

      const parsedRuns = learningAutomationRunListSchema.parse(runsData);
      setRuns(parsedRuns.runs);

      const parsedDecisions =
        paperCoordinationDecisionListSchema.parse(decisionsData);
      setDecisions(parsedDecisions.decisions);
      if (parsedDecisions.decisions.length > 0 && !selectedDecisionId) {
        setSelectedDecisionId(parsedDecisions.decisions[0]!.id);
      }

      const parsedModels = statisticalModelListSchema.parse(modelsData);
      setModels(parsedModels.models);
      if (parsedModels.models.length > 0 && !selectedModelId) {
        setSelectedModelId(parsedModels.models[0]!.id);
      }
      setCalibrations(
        calibrationRunListSchema.parse(calibrationData).calibrations,
      );
      setAutomationStages(
        evidenceAutomationResponseSchema.parse(automationData).stages,
      );
      const challengerList =
        challengerExperimentListSchema.parse(challengerData).experiments;
      setChallengerExperiments(challengerList);
      if (!selectedExperimentId && challengerList[0])
        setSelectedExperimentId(challengerList[0].id);
      setLastLoadedAt(new Date().toISOString());
      setRefreshVersion((value) => value + 1);
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load learning dashboard",
      );
    } finally {
      if (current()) setLoading(false);
    }
  };

  const loadRef = useRef(loadData);
  loadRef.current = loadData;

  useEffect(() => {
    setAutomationStages([]);
    setChallengerExperiments([]);
    setChallengerReport(null);
    setSelectedModelId(null);
    setSelectedExperimentId(null);
    setSelectedCohortKey(null);
    void loadData();
    return () => {
      activeLoadRef.current?.abort();
      requestGeneration.current++;
    };
  }, [marketId]);

  useRefreshOnFocus(() => void loadRef.current(), 10_000);

  // Reloaded once per overview refresh (poll, focus, activation, market switch)
  // and whenever the user selects another experiment. Aborting the previous
  // request keeps slow responses from overwriting a newer selection.
  useEffect(() => {
    if (!selectedExperimentId) {
      setChallengerReport(null);
      return;
    }
    const controller = new AbortController();
    const generation = requestGeneration.current;
    const current = () =>
      !controller.signal.aborted && generation === requestGeneration.current;
    setReportLoad((previous) => ({
      experimentId: selectedExperimentId,
      loading: true,
      error:
        previous?.experimentId === selectedExperimentId
          ? previous.error
          : false,
      checkedAt:
        previous?.experimentId === selectedExperimentId
          ? previous.checkedAt
          : null,
    }));
    void getJson(
      `/api/challenger-experiments/${selectedExperimentId}/report?marketId=${marketId}`,
      controller.signal,
    )
      .then((value) => {
        if (!current()) return;
        setChallengerReport(
          challengerExperimentDetailSchema.parse(value).report,
        );
        setReportLoad({
          experimentId: selectedExperimentId,
          loading: false,
          error: false,
          checkedAt: new Date().toISOString(),
        });
      })
      .catch(() => {
        if (!current()) return;
        // A background refresh failure must not blank a report that still
        // belongs to the selected experiment; a stale report for a previous
        // selection is cleared.
        setChallengerReport((current) =>
          current?.experimentId === selectedExperimentId ? current : null,
        );
        setReportLoad((previous) => ({
          experimentId: selectedExperimentId,
          loading: false,
          error: true,
          checkedAt:
            previous?.experimentId === selectedExperimentId
              ? previous.checkedAt
              : null,
        }));
      });
    return () => controller.abort();
  }, [selectedExperimentId, marketId, refreshVersion]);

  // Always refresh on a bounded cadence while the tab is visible, faster while
  // durable work is active. A baseline poll is required: without it the page
  // cannot discover the transition from "waiting" to "a job just started".
  const activeWork =
    (overview?.pipelineHealth.activeJobs ?? 0) > 0 ||
    automationStages.some((stage) =>
      ["RUNNING", "QUEUED"].includes(stage.state),
    );
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") void loadRef.current();
      },
      activeWork ? 30_000 : 60_000,
    );
    return () => window.clearInterval(timer);
  }, [activeWork]);

  const handleActivation = async (model: StatisticalModel, active: boolean) => {
    try {
      const endpoint = `/api/statistical-models/${model.id}/${active ? "activate" : "deactivate"}`;
      const result = statisticalModelSchema.parse(
        await sendJson(endpoint, "POST", {}),
      );
      setModels((prev) => prev.map((m) => (m.id === result.id ? result : m)));
      // Activation affects the overview counts; refresh rather than leaving
      // the metric cards reporting stale lifecycle totals.
      void loadRef.current();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to update model activation",
      );
    }
  };

  const selectedDecision = decisions.find((d) => d.id === selectedDecisionId);
  const selectedModel = models.find((m) => m.id === selectedModelId) ?? null;
  const now = useNow();
  const selectedCohort =
    overview?.evidenceReadiness.find(
      (readiness) =>
        `${readiness.cohort.profileConfigId}:${readiness.cohort.configVersion}:${readiness.cohort.executionModelVersion}` ===
        selectedCohortKey,
    ) ?? overview?.evidenceReadiness[0];
  const review = overview
    ? reviewItems(overview, runs, automationStages, models, challengerReport)
    : [];
  const failedStages = automationStages.filter((stage) =>
    ["FAILED", "INTERRUPTED", "CANCELLED"].includes(stage.state),
  ).length;
  const pendingStages = automationStages.filter((stage) =>
    ["WAITING", "QUEUED", "RUNNING"].includes(stage.state),
  ).length;
  const unknownStages = automationStages.filter(
    (stage) => stage.state === "UNKNOWN",
  ).length;
  const eligibleCohorts =
    overview?.evidenceReadiness.filter((readiness) => readiness.qualifies)
      .length ?? 0;
  const acceptedModels = overview?.lifecycle.activeModelsCount ?? 0;
  const totalModels = overview?.lifecycle.modelsCount ?? 0;
  const nextCheck = overview?.pipelineHealth.nextCheckAt ?? null;
  const situation = (() => {
    if (!overview) return "Loading learning state…";
    if (review.length > 0)
      return `${review.length} item${review.length === 1 ? "" : "s"} ${review.length === 1 ? "needs" : "need"} review before this pipeline is fully healthy.`;
    const total = overview.evidenceReadiness.length;
    if (total === 0)
      return "No compatible evidence cohorts yet. Collection starts as completed live sessions accumulate.";
    if (overview.pipelineHealth.activeJobs > 0)
      return `Evidence is accumulating. ${overview.pipelineHealth.activeJobs} qualification or training job${overview.pipelineHealth.activeJobs === 1 ? "" : "s"} active now.`;
    return `Collecting forward evidence for ${total} compatible cohort${total === 1 ? "" : "s"}; ${eligibleCohorts} currently meet the sample-count gates.`;
  })();

  if (loading && !overview) {
    return (
      <div className={VIEW_CLASSES}>
        <p className="loading-indicator">Loading learning dashboard...</p>
      </div>
    );
  }

  return (
    <div className={VIEW_CLASSES}>
      {error && <p className="error-banner">{error}</p>}

      <nav className={NAV_CLASSES} aria-label="Learning sections">
        {SECTIONS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={section === key}
            className={classes(
              NAV_BUTTON_CLASSES,
              section === key
                ? NAV_BUTTON_ACTIVE_CLASSES
                : NAV_BUTTON_IDLE_CLASSES,
            )}
            onClick={() => setSection(key)}
          >
            {label}
          </button>
        ))}
        <span className={NAV_FRESH_CLASSES}>
          {lastLoadedAt
            ? `Checked ${ago(now, lastLoadedAt)}`
            : "Not checked yet"}
        </span>
      </nav>

      {section === "overview" && overview && (
        <>
          <section className={SITUATION_CLASSES} aria-label="Current situation">
            <div role="status">
              <strong className={SITUATION_TITLE_CLASSES}>{situation}</strong>
            </div>
            {overview.pipelineHealth.activeJobs > 0 ? (
              <p className={SITUATION_NEXT_CLASSES}>
                {overview.pipelineHealth.activeJobs} active job
                {overview.pipelineHealth.activeJobs === 1 ? "" : "s"} · progress
                appears automatically
              </p>
            ) : null}
          </section>

          {review.length > 0 && (
            <section className={REVIEW_CLASSES} aria-label="Needs review">
              <strong className={REVIEW_TITLE_CLASSES}>Needs review</strong>
              <ul className={REVIEW_LIST_CLASSES}>
                {review.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <button
                type="button"
                className={REVIEW_BUTTON_CLASSES}
                onClick={() => setSection("processes")}
              >
                Open processes
              </button>
            </section>
          )}

          <div className={METRIC_CARDS_CLASSES}>
            <div className={METRIC_CARD_CLASSES}>
              <span className={CARD_LABEL_CLASSES}>EVIDENCE COHORTS</span>
              <div className={CARD_VALUE_CLASSES}>
                {eligibleCohorts} / {overview.evidenceReadiness.length}
              </div>
              <small className={CARD_DETAIL_CLASSES}>
                Meeting the sample-count gates; research validation is separate
              </small>
            </div>
            <div className={METRIC_CARD_CLASSES}>
              <span className={CARD_LABEL_CLASSES}>FROZEN DATASETS</span>
              <div className={CARD_VALUE_CLASSES}>
                {overview.lifecycle.datasetsCount}
              </div>
              <small className={CARD_DETAIL_CLASSES}>
                Immutable qualification snapshots retained
              </small>
            </div>
            <div className={METRIC_CARD_CLASSES}>
              <span className={CARD_LABEL_CLASSES}>ACTIVE MODELS</span>
              <div className={CARD_VALUE_CLASSES}>
                {acceptedModels} / {totalModels}
              </div>
              <small className={CARD_DETAIL_CLASSES}>
                Active challengers, not proven improvement
              </small>
            </div>
            <div className={METRIC_CARD_CLASSES}>
              <span className={CARD_LABEL_CLASSES}>NEXT SCHEDULED CHECK</span>
              <div className={CARD_VALUE_CLASSES}>
                {overview.pipelineHealth.checkOverdue
                  ? "OVERDUE"
                  : nextCheck
                    ? new Date(nextCheck).toLocaleString([], {
                        month: "short",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : overview.pipelineHealth.schedulerEnabled
                      ? "NOT YET KNOWN"
                      : "OFF"}
              </div>
              <small className={CARD_DETAIL_CLASSES}>
                {overview.pipelineHealth.schedulerEnabled
                  ? overview.pipelineHealth.scheduleDescription
                  : "Automatic checks are disabled"}
              </small>
            </div>
          </div>

          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>
                Scheduled evidence checks
              </h2>
              <span className={SECTION_TAG_CLASSES}>AUTOMATIC</span>
            </div>
            <div className={PIPELINE_BANNER_CLASSES}>
              <div>
                <strong>{schedulerHeadline(overview.pipelineHealth)}</strong>
                <p>
                  Last check:{" "}
                  {overview.pipelineHealth.lastCheckAt
                    ? `${ago(now, overview.pipelineHealth.lastCheckAt)} · ${new Date(overview.pipelineHealth.lastCheckAt).toLocaleString()}`
                    : "Never recorded"}
                  {overview.pipelineHealth.lastState
                    ? ` · ${overview.pipelineHealth.lastState}`
                    : ""}
                  {overview.pipelineHealth.lastNoopReason
                    ? ` · ${humanNoopReason(overview.pipelineHealth.lastNoopReason)}`
                    : ""}
                </p>
                <p>
                  Next:{" "}
                  {nextCheck
                    ? `${countdown(now, nextCheck)} · ${new Date(nextCheck).toLocaleString()}${overview.pipelineHealth.nextCheckIsEstimate ? " (estimated)" : ""}`
                    : overview.pipelineHealth.schedulerEnabled
                      ? "No prior check to anchor an interval schedule yet"
                      : "Not scheduled"}
                  {" · "}
                  <Tip label="Derived from the configured schedule because the worker does not persist its timer. It is not a worker-recorded next action. Overdue is detected from the previous check time and the cadence.">
                    <span className={HELP_CLASSES}>schedule basis</span>
                  </Tip>
                </p>
                {overview.pipelineHealth.checkOverdue ? (
                  <p className={INLINE_WARNING_CLASSES}>
                    The previous check is overdue for this schedule. The worker
                    may not be running; verify it without changing any
                    collection policy.
                  </p>
                ) : null}
                <details className={RUN_DETAIL_CLASSES}>
                  <summary className={RUN_SUMMARY_CLASSES}>
                    Raw scheduler state
                  </summary>
                  <p>{overview.pipelineHealth.explanation}</p>
                  <p>
                    State {overview.pipelineHealth.lastState ?? "NONE"} · policy{" "}
                    {overview.pipelineHealth.schedulerPolicyVersion} · reason{" "}
                    {overview.pipelineHealth.lastNoopReason ?? "none"} ·
                    estimate{" "}
                    {overview.pipelineHealth.nextCheckIsEstimate ? "yes" : "no"}{" "}
                    · overdue{" "}
                    {overview.pipelineHealth.checkOverdue ? "yes" : "no"}
                  </p>
                </details>
              </div>
              <div className={PIPELINE_METRICS_CLASSES}>
                <span>
                  Schedule: {overview.pipelineHealth.scheduleDescription}
                </span>
                <span>
                  Policy:{" "}
                  <code>{overview.pipelineHealth.schedulerPolicyVersion}</code>
                </span>
                <span>
                  Active research jobs:{" "}
                  <strong>{overview.pipelineHealth.activeJobs}</strong>
                </span>
                <span>
                  Durable errors:{" "}
                  <strong>{overview.pipelineHealth.durableErrors}</strong>
                </span>
              </div>
            </div>
          </section>

          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>Qualification progress</h2>
              <span className={SECTION_TAG_CLASSES}>SAMPLE COUNTS ONLY</span>
            </div>
            <p className={SECTION_DESCRIPTION_CLASSES}>
              Sample-count eligibility is not complete qualification, and
              neither proves a model improves decisions. Strategy rules and
              execution assumptions are unchanged by this page.
            </p>
            {overview.evidenceReadiness.length === 0 ? (
              <p className="empty-message">
                No compatible closed-quote cohorts yet. Live sessions accumulate
                first; nothing is wrong while this is empty.
              </p>
            ) : (
              <>
                <label className={COHORT_SELECT_CLASSES}>
                  Cohort
                  <select
                    className={COHORT_SELECT_CONTROL_CLASSES}
                    value={
                      selectedCohort
                        ? `${selectedCohort.cohort.profileConfigId}:${selectedCohort.cohort.configVersion}:${selectedCohort.cohort.executionModelVersion}`
                        : ""
                    }
                    onChange={(event) =>
                      setSelectedCohortKey(event.target.value)
                    }
                  >
                    {overview.evidenceReadiness.map((readiness) => (
                      <option
                        key={`${readiness.cohort.profileConfigId}:${readiness.cohort.configVersion}:${readiness.cohort.executionModelVersion}`}
                        value={`${readiness.cohort.profileConfigId}:${readiness.cohort.configVersion}:${readiness.cohort.executionModelVersion}`}
                      >
                        {displayStrategy(readiness.cohort.strategy)} ·{" "}
                        {readiness.cohort.configVersion} ·{" "}
                        {readiness.cohort.executionModelVersion}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedCohort && (
                  <div
                    className={classes(
                      COHORT_CARD_CLASSES,
                      COHORT_DETAIL_CLASSES,
                    )}
                  >
                    <div className={COHORT_HEADER_CLASSES}>
                      <strong>
                        {displayStrategy(selectedCohort.cohort.strategy)}
                      </strong>
                      <span
                        className={badgeClasses(
                          selectedCohort.qualifies ? "success" : "neutral",
                        )}
                      >
                        {selectedCohort.qualifies
                          ? "SAMPLE COUNTS MET"
                          : humanGateReason(
                              selectedCohort.disqualificationReason,
                            )}
                      </span>
                    </div>
                    <p className={COHORT_IDENTITY_CLASSES}>
                      {selectedCohort.cohort.marketId} ·{" "}
                      <code className={COHORT_IDENTITY_CODE_CLASSES}>
                        {selectedCohort.cohort.configVersion}
                      </code>{" "}
                      · {selectedCohort.cohort.executionModelVersion} ·{" "}
                      {selectedCohort.cohort.replayScope ?? "UNKNOWN"}
                    </p>
                    <div className={PROGRESS_CONTAINER_CLASSES}>
                      <div
                        className={PROGRESS_FILL_CLASSES}
                        style={{ width: `${selectedCohort.progressPct}%` }}
                      />
                    </div>
                    <div className={COHORT_STATS_CLASSES}>
                      <span>
                        Closed quote outcomes:{" "}
                        <strong>
                          {selectedCohort.closedQuoteCount} /{" "}
                          {selectedCohort.threshold}
                        </strong>{" "}
                        ({selectedCohort.progressPct}%)
                      </span>
                      <span>
                        New since last dataset:{" "}
                        <strong>
                          {selectedCohort.newOutcomesSinceLastDataset} /{" "}
                          {selectedCohort.newOutcomeThreshold}
                        </strong>
                      </span>
                    </div>
                    <ul className={GATES_CLASSES}>
                      <li
                        className={classes(
                          GATE_ITEM_CLASSES,
                          selectedCohort.closedQuoteCount >=
                            selectedCohort.threshold
                            ? GATE_ITEM_MET_CLASSES
                            : GATE_ITEM_UNMET_CLASSES,
                        )}
                      >
                        Enough closed quote outcomes
                        {selectedCohort.disqualificationReason?.startsWith(
                          "INSUFFICIENT_CLOSED_QUOTES",
                        )
                          ? ` (${selectedCohort.closedQuoteCount} of ${selectedCohort.threshold})`
                          : ""}
                      </li>
                      <li
                        className={classes(
                          GATE_ITEM_CLASSES,
                          selectedCohort.cohort.positives > 0 &&
                            selectedCohort.cohort.negatives > 0
                            ? GATE_ITEM_MET_CLASSES
                            : GATE_ITEM_UNMET_CLASSES,
                        )}
                      >
                        Both win and loss examples present
                      </li>
                      <li
                        className={classes(
                          GATE_ITEM_CLASSES,
                          selectedCohort.newOutcomesSinceLastDataset >=
                            selectedCohort.newOutcomeThreshold
                            ? GATE_ITEM_MET_CLASSES
                            : GATE_ITEM_UNMET_CLASSES,
                        )}
                      >
                        Enough new outcomes since the last frozen dataset
                      </li>
                    </ul>
                    <p className={GATES_NOTE_CLASSES}>
                      Next steps are automatic: when the sample-count gates and
                      research qualification both pass, an inactive challenger
                      may be trained. Activation stays manual, and prospective
                      comparison against the deterministic baseline is required
                      before any promotion.
                    </p>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}

      {section === "processes" && (
        <>
          <EvidenceAutomationPanel
            marketId={marketId}
            stages={automationStages}
            error={null}
          />
          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>Calibration</h2>
              <span className={SECTION_TAG_CLASSES}>
                SEPARATE FROM TRAINING
              </span>
            </div>
            <p className={SECTION_DESCRIPTION_CLASSES}>
              Parameter calibration explores captured history. A completed run
              is research evidence; it does not activate a model or change live
              strategy rules.
            </p>
            {calibrations.length === 0 ? (
              <p className="empty-message">No calibration runs retained.</p>
            ) : (
              (() => {
                const latest = calibrations[0]!;
                const total = latest.totalCombinations;
                const progress =
                  total > 0
                    ? Math.min(
                        100,
                        Math.round((latest.combinationsTested / total) * 100),
                      )
                    : null;
                return (
                  <div className={PROCESS_CARD_CLASSES}>
                    <div className={COHORT_HEADER_CLASSES}>
                      <strong>
                        {latest.name} · {displayStrategy(latest.strategy)}
                      </strong>
                      <span
                        className={badgeClasses(
                          latest.status === "COMPLETED"
                            ? "success"
                            : latest.status === "RUNNING"
                              ? "info"
                              : "danger",
                        )}
                      >
                        {latest.status}
                      </span>
                    </div>
                    <p className={COHORT_IDENTITY_CLASSES}>
                      {latest.startDate} → {latest.endDate}
                      {latest.executionModelVersion
                        ? ` · ${latest.executionModelVersion}`
                        : ""}
                      {latest.truncated ? " · truncated search space" : ""}
                    </p>
                    {progress !== null && latest.status === "RUNNING" ? (
                      <div className={PROGRESS_CONTAINER_CLASSES}>
                        <div
                          className={PROGRESS_FILL_CLASSES}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    ) : null}
                    <div className={COHORT_STATS_CLASSES}>
                      <span>
                        Combinations:{" "}
                        <strong>
                          {latest.combinationsTested} /{" "}
                          {latest.totalCombinations}
                        </strong>
                      </span>
                      {latest.recommendation ? (
                        <span>Recommendation: {latest.recommendation}</span>
                      ) : null}
                    </div>
                    {latest.error ? (
                      <p className={INLINE_ERROR_CLASSES}>{latest.error}</p>
                    ) : null}
                    <details>
                      <summary>
                        Calibration history ({calibrations.length})
                      </summary>
                      <ul className={HISTORY_LIST_CLASSES}>
                        {calibrations.map((run) => (
                          <li key={run.id}>
                            {run.name} · {run.status} ·{" "}
                            {run.completedAt
                              ? new Date(run.completedAt).toLocaleString()
                              : run.createdAt}
                            {run.error ? ` · ${run.error}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                );
              })()
            )}
          </section>
          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>Prospective observation</h2>
              <span className={SECTION_TAG_CLASSES}>SHADOW / READ-ONLY</span>
            </div>
            <p className={SECTION_DESCRIPTION_CLASSES}>
              Frozen challengers observe unseen opportunities. Promotion is
              never authorized by this workflow.
            </p>
            {challengerExperiments.length === 0 ? (
              <p className="empty-message">No inactive experiments enrolled.</p>
            ) : (
              <div className={CHALLENGER_LIST_CLASSES}>
                {challengerExperiments.map((experiment) => (
                  <button
                    type="button"
                    className={classes(
                      CHALLENGER_CARD_CLASSES,
                      selectedExperimentId === experiment.id
                        ? CHALLENGER_CARD_SELECTED_CLASSES
                        : CHALLENGER_CARD_IDLE_CLASSES,
                    )}
                    key={experiment.id}
                    aria-pressed={selectedExperimentId === experiment.id}
                    onClick={() => setSelectedExperimentId(experiment.id)}
                  >
                    <strong>
                      {displayStrategy(experiment.scope.strategy)} ·{" "}
                      {experiment.modelVersion}
                    </strong>
                    <span className={CHALLENGER_CARD_TEXT_CLASSES}>
                      {experiment.state} · {experiment.scope.marketId}/
                      {experiment.scope.currency}
                    </span>
                    <small className={CHALLENGER_CARD_TEXT_CLASSES}>
                      {new Date(experiment.startsAt).toLocaleString()} –{" "}
                      {new Date(experiment.endsAt).toLocaleString()}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {section === "results" && overview && (
        <>
          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>Model lifecycle</h2>
              <span className={SECTION_TAG_CLASSES}>CHALLENGERS</span>
            </div>
            <div className={MODELS_LIST_CLASSES}>
              {models.length === 0 ? (
                <p className="empty-message">
                  No statistical models trained yet. Training is queued
                  automatically only when qualification passes.
                </p>
              ) : (
                models.map((model) => (
                  <div
                    key={model.id}
                    className={classes(
                      MODEL_ITEM_CLASSES,
                      selectedModel?.id === model.id
                        ? MODEL_ITEM_SELECTED_CLASSES
                        : MODEL_ITEM_IDLE_CLASSES,
                    )}
                    onClick={() => setSelectedModelId(model.id)}
                  >
                    <div className={MODEL_SUMMARY_CLASSES}>
                      <strong>
                        {displayStrategy(model.strategy)} · {model.modelVersion}
                      </strong>
                      <small>
                        {model.status} · {model.active ? "ACTIVE" : "INACTIVE"}{" "}
                        · {model.sourceKind}
                      </small>
                    </div>
                    <div className={MODEL_METRICS_CLASSES}>
                      {model.testMetrics ? (
                        <span>
                          ROC: {model.testMetrics.rocAuc?.toFixed(2) ?? "—"} ·
                          Brier:{" "}
                          {model.testMetrics.brierScore?.toFixed(2) ?? "—"}
                        </span>
                      ) : (
                        <span>No test metrics</span>
                      )}
                      {!model.active && !model.eligibleForActivation ? (
                        <Tip label="Activation is disabled until the model meets every eligibility gate. Warnings below explain what is missing.">
                          <button
                            className={TOGGLE_BUTTON_CLASSES}
                            disabled
                            type="button"
                          >
                            Not eligible
                          </button>
                        </Tip>
                      ) : (
                        <button
                          className={TOGGLE_BUTTON_CLASSES}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleActivation(model, !model.active);
                          }}
                        >
                          {model.active ? "Deactivate" : "Activate"}
                        </button>
                      )}
                    </div>
                    {model.error ? (
                      <p className={INLINE_ERROR_CLASSES}>{model.error}</p>
                    ) : null}
                    {model.warnings.length > 0 ? (
                      <p className={INLINE_WARNING_CLASSES}>
                        {model.warnings.join(" · ")}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>
                Forward calibration &amp; monitoring
              </h2>
              <span className={SECTION_TAG_CLASSES}>OUT-OF-SAMPLE</span>
            </div>
            {overview.forwardMonitoring.length === 0 ? (
              <p className="empty-message">
                No forward predictions monitored yet.
              </p>
            ) : (
              <div className={MODELS_LIST_CLASSES}>
                {overview.forwardMonitoring.map((mon, idx) => (
                  <div key={idx} className={MONITORING_CARD_CLASSES}>
                    <div className={MONITORING_HEADER_CLASSES}>
                      <strong>
                        {displayStrategy(mon.strategy)} ({mon.modelVersion})
                      </strong>
                      <span className={badgeClasses("info")}>
                        {mon.predictions} predictions / {mon.closedOutcomes}{" "}
                        resolved
                      </span>
                    </div>
                    <div className={MONITORING_STATS_CLASSES}>
                      <div className={STAT_BOX_CLASSES}>
                        <label className={STAT_BOX_LABEL_CLASSES}>
                          Brier score
                        </label>
                        <span className={STAT_BOX_VALUE_CLASSES}>
                          {mon.brierScore?.toFixed(3) ?? "—"}
                        </span>
                      </div>
                      <div className={STAT_BOX_CLASSES}>
                        <label className={STAT_BOX_LABEL_CLASSES}>
                          Avg predicted P
                        </label>
                        <span className={STAT_BOX_VALUE_CLASSES}>
                          {mon.averagePredictedProbability !== null
                            ? `${(mon.averagePredictedProbability * 100).toFixed(1)}%`
                            : "—"}
                        </span>
                      </div>
                      <div className={STAT_BOX_CLASSES}>
                        <label className={STAT_BOX_LABEL_CLASSES}>
                          Realized win rate
                        </label>
                        <span className={STAT_BOX_VALUE_CLASSES}>
                          {mon.observedWinRate !== null
                            ? `${(mon.observedWinRate * 100).toFixed(1)}%`
                            : "—"}
                        </span>
                      </div>
                    </div>
                    <p className={MONITORING_FRESHNESS_CLASSES}>
                      {mon.firstPredictionAt
                        ? `First prediction ${ago(now, mon.firstPredictionAt)} · last ${ago(now, mon.lastPredictionAt)}`
                        : "No predictions recorded"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {selectedExperimentId && (
            <section className={SECTION_CLASSES}>
              <div className={SECTION_HEADER_CLASSES}>
                <h2 className={SECTION_TITLE_CLASSES}>
                  Prospective acceptance progress
                </h2>
                <span className={SECTION_TAG_CLASSES}>NOT PROMOTION</span>
              </div>
              {selectedReportLoad?.error && (
                <p className={INLINE_ERROR_CLASSES} role="status">
                  {challengerReport
                    ? "Report refresh failed. Showing the last successfully loaded report; its evidence may be stale."
                    : "Selected report unavailable. The next refresh will retry automatically."}
                </p>
              )}
              <p className={MONITORING_FRESHNESS_CLASSES} role="status">
                {selectedReportLoad?.loading
                  ? challengerReport
                    ? "Refreshing selected report…"
                    : "Loading selected report…"
                  : null}
                {selectedReportLoad?.checkedAt
                  ? ` Report checked ${ago(now, selectedReportLoad.checkedAt)}`
                  : null}
              </p>
              {(() => {
                if (!challengerReport) return null;
                const plan = challengerReport.frozenAcceptance?.acceptancePlan;
                if (!plan) {
                  return (
                    <p className="empty-message">
                      No frozen acceptance plan is attached to this report.
                    </p>
                  );
                }
                const outcomeProgress = Math.min(
                  100,
                  Math.round(
                    (challengerReport.closedQuoteOutcomes /
                      plan.minimumClosedOutcomes) *
                      100,
                  ),
                );
                const expected = plan.comparison.expectedSessions.length;
                const observed = challengerReport.verifiedSessions;
                const sessionProgress =
                  observed === null || expected === 0
                    ? null
                    : Math.min(100, Math.round((observed / expected) * 100));
                return (
                  <div className={GATES_PROGRESS_CLASSES}>
                    <div>
                      <span className={GATES_PROGRESS_LABEL_CLASSES}>
                        Closed outcomes{" "}
                        <strong className={GATES_PROGRESS_STRONG_CLASSES}>
                          {challengerReport.closedQuoteOutcomes} /{" "}
                          {plan.minimumClosedOutcomes}
                        </strong>
                      </span>
                      <div className={PROGRESS_CONTAINER_CLASSES}>
                        <div
                          className={PROGRESS_FILL_CLASSES}
                          style={{ width: `${outcomeProgress}%` }}
                        />
                      </div>
                    </div>
                    <div>
                      <span className={GATES_PROGRESS_LABEL_CLASSES}>
                        Sessions{" "}
                        <strong className={GATES_PROGRESS_STRONG_CLASSES}>
                          {observed ?? "—"} / {expected}
                        </strong>
                      </span>
                      {sessionProgress !== null ? (
                        <div className={PROGRESS_CONTAINER_CLASSES}>
                          <div
                            className={PROGRESS_FILL_CLASSES}
                            style={{ width: `${sessionProgress}%` }}
                          />
                        </div>
                      ) : (
                        <small>
                          Session counts unavailable in this report; not
                          inferred.
                        </small>
                      )}
                    </div>
                  </div>
                );
              })()}
              {challengerReport && (
                <ChallengerObservationSummary report={challengerReport} />
              )}
            </section>
          )}

          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>Automation run history</h2>
              <span className={SECTION_TAG_CLASSES}>DURABLE</span>
            </div>
            {runs.length === 0 ? (
              <p className="empty-message">No scheduled checks have run yet.</p>
            ) : (
              <div className="automation-runs-table-container">
                <table className={TABLE_CLASSES}>
                  <thead>
                    <tr>
                      <th className={TABLE_HEADER_CLASSES}>Time</th>
                      <th className={TABLE_HEADER_CLASSES}>State</th>
                      <th className={TABLE_HEADER_CLASSES}>Summary</th>
                      <th className={TABLE_HEADER_CLASSES}>Cohorts</th>
                      <th className={TABLE_HEADER_CLASSES}>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 15).map((run) => (
                      <tr key={run.id} className={TABLE_ROW_HOVER_CLASSES}>
                        <td className={TABLE_CELL_CLASSES}>
                          {new Date(run.startedAt).toLocaleString()}
                          {run.completedAt
                            ? ` · ${Math.max(0, Math.round((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000))}s`
                            : ""}
                        </td>
                        <td className={TABLE_CELL_CLASSES}>
                          <span className={badgeClasses(runBadge(run.state))}>
                            {run.state}
                          </span>
                        </td>
                        <td className={TABLE_CELL_CLASSES}>
                          {run.noopReason
                            ? humanNoopReason(run.noopReason)
                            : (run.error ?? "Created a training job")}
                        </td>
                        <td className={TABLE_CELL_CLASSES}>
                          {run.cohortsExamined.length} examined
                        </td>
                        <td className={TABLE_CELL_CLASSES}>
                          {run.createdDatasetId && run.createdJobId
                            ? "Dataset frozen · training queued"
                            : run.noopReason
                              ? "No dataset created"
                              : "—"}
                          <details className={RUN_DETAIL_CLASSES}>
                            <summary className={RUN_SUMMARY_CLASSES}>
                              Per-cohort detail
                            </summary>
                            <ul className={HISTORY_LIST_CLASSES}>
                              {run.cohortsExamined.map((entry, index) => {
                                const fields = entry as Record<string, unknown>;
                                return (
                                  <li key={index}>
                                    {String(
                                      fields.strategy ?? "cohort",
                                    ).replaceAll("_", " ")}
                                    {fields.closedQuoteCount !== undefined
                                      ? ` · ${String(fields.closedQuoteCount)} outcomes`
                                      : ""}
                                    {fields.reason !== undefined
                                      ? ` · ${humanNoopReason(String(fields.reason))}`
                                      : fields.qualifies === true
                                        ? " · qualified"
                                        : ""}
                                  </li>
                                );
                              })}
                            </ul>
                          </details>
                          {run.createdDatasetId ? (
                            <small className={RAW_ID_CLASSES}>
                              dataset {run.createdDatasetId}
                              {run.createdJobId
                                ? ` · job ${run.createdJobId}`
                                : ""}
                            </small>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>
                Coordinated shadow experiments
              </h2>
              <span className={SECTION_TAG_CLASSES}>PRIMARY vs V4-SHADOW</span>
            </div>
            <div className="shadow-experiment-panel">
              <div className={SHADOW_STATS_CLASSES}>
                <div className={STAT_CARD_CLASSES}>
                  <label className={STAT_CARD_LABEL_CLASSES}>
                    Decisions evaluated
                  </label>
                  <h3
                    className={classes(
                      STAT_CARD_VALUE_CLASSES,
                      STAT_CARD_VALUE_TONES.default,
                    )}
                  >
                    {overview.shadowExperiments.decisionsEvaluated}
                  </h3>
                </div>
                <div className={STAT_CARD_CLASSES}>
                  <label className={STAT_CARD_LABEL_CLASSES}>
                    Selection divergences
                  </label>
                  <h3
                    className={classes(
                      STAT_CARD_VALUE_CLASSES,
                      STAT_CARD_VALUE_TONES.default,
                    )}
                  >
                    {overview.shadowExperiments.selectionChangesCount}
                  </h3>
                </div>
                <div className={STAT_CARD_CLASSES}>
                  <label className={STAT_CARD_LABEL_CLASSES}>
                    Selection change rate
                  </label>
                  <h3
                    className={classes(
                      STAT_CARD_VALUE_CLASSES,
                      STAT_CARD_VALUE_TONES.default,
                    )}
                  >
                    {(
                      overview.shadowExperiments.selectionChangeRate * 100
                    ).toFixed(1)}
                    %
                  </h3>
                </div>
                <div className={STAT_CARD_CLASSES}>
                  <label className={STAT_CARD_LABEL_CLASSES}>
                    Primary net P&amp;L
                  </label>
                  <h3
                    className={classes(
                      STAT_CARD_VALUE_CLASSES,
                      STAT_CARD_VALUE_TONES.primary,
                    )}
                  >
                    ${overview.shadowExperiments.primaryNetPnl.toFixed(2)}
                  </h3>
                </div>
                <div className={STAT_CARD_CLASSES}>
                  <label className={STAT_CARD_LABEL_CLASSES}>
                    Hypothetical V4 net P&amp;L
                  </label>
                  <h3
                    className={classes(
                      STAT_CARD_VALUE_CLASSES,
                      STAT_CARD_VALUE_TONES.shadow,
                    )}
                  >
                    ${overview.shadowExperiments.hypotheticalNetPnl.toFixed(2)}
                  </h3>
                </div>
              </div>
              <p className={SECTION_DESCRIPTION_CLASSES}>
                Hypothetical results are model-informed shadow evidence, not one
                account balance and not a reason to activate a model.
              </p>
            </div>
          </section>
        </>
      )}

      {section === "diagnostics" && (
        <>
          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>Decision drill-down</h2>
              <span className={SECTION_TAG_CLASSES}>RAW FACTS</span>
            </div>
            <div className={DRILLDOWN_CLASSES}>
              <div className="decisions-selector">
                <h4>Recent decisions ({decisions.length})</h4>
                <div className={DECISIONS_LIST_CLASSES}>
                  {decisions.slice(0, 20).map((d) => {
                    const differs = (
                      d.shadowDecision as { differsFromPrimary?: boolean }
                    )?.differsFromPrimary;
                    return (
                      <div
                        key={d.id}
                        className={classes(
                          DECISION_ITEM_CLASSES,
                          selectedDecisionId === d.id
                            ? DECISION_ITEM_SELECTED_CLASSES
                            : DECISION_ITEM_IDLE_CLASSES,
                        )}
                        onClick={() => setSelectedDecisionId(d.id)}
                      >
                        <div className={ITEM_ROW_CLASSES}>
                          <strong>{d.symbol}</strong>
                          <span
                            className={badgeClasses(
                              d.outcome === "APPROVED" ? "success" : "neutral",
                            )}
                          >
                            {d.outcome}
                          </span>
                        </div>
                        <div className={ITEM_ROW_CLASSES}>
                          <small>
                            {new Date(d.decisionTimestamp).toLocaleTimeString()}
                          </small>
                          {differs && (
                            <span className={badgeClasses("warn")}>
                              V4 DIFF
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className={DETAIL_VIEW_CLASSES}>
                {selectedDecision ? (
                  <>
                    <div className={DECISION_HEADLINE_CLASSES}>
                      <div>
                        <h3 className={DECISION_TITLE_CLASSES}>
                          {selectedDecision.symbol} ·{" "}
                          {new Date(
                            selectedDecision.decisionTimestamp,
                          ).toLocaleString()}
                        </h3>
                        <p>
                          Primary V3:{" "}
                          <strong>{selectedDecision.outcome}</strong> (
                          {selectedDecision.reason}) · Strategy:{" "}
                          {selectedDecision.selectedStrategyKey ?? "None"}
                        </p>
                        {selectedDecision.shadowDecision && (
                          <p className={SHADOW_HEADLINE_CLASSES}>
                            Shadow V4:{" "}
                            <strong>
                              {
                                (
                                  selectedDecision.shadowDecision as {
                                    outcome?: string;
                                  }
                                ).outcome
                              }
                            </strong>{" "}
                            (
                            {
                              (
                                selectedDecision.shadowDecision as {
                                  reason?: string;
                                }
                              ).reason
                            }
                            ) · Strategy:{" "}
                            {(
                              selectedDecision.shadowDecision as {
                                selectedStrategyKey?: string | null;
                              }
                            ).selectedStrategyKey ?? "None"}
                          </p>
                        )}
                        <small className={RAW_ID_CLASSES}>
                          decision {selectedDecision.id} · run{" "}
                          {selectedDecision.runId}
                        </small>
                      </div>
                      {selectedDecision.netPnl !== null && (
                        <div className={TRADE_PILL_CLASSES}>
                          <span>Trade outcome</span>
                          <strong>
                            ${selectedDecision.netPnl.toFixed(2)} (
                            {selectedDecision.rMultiple?.toFixed(2)}R)
                          </strong>
                          <small>{selectedDecision.exitReason}</small>
                        </div>
                      )}
                    </div>

                    <h4>Candidate batch evaluation</h4>
                    {Array.isArray(selectedDecision.candidates) &&
                    selectedDecision.candidates.length > 0 ? (
                      <table
                        className={classes(TABLE_CLASSES, "candidate-table")}
                      >
                        <thead>
                          <tr>
                            <th className={TABLE_HEADER_CLASSES}>Strategy</th>
                            <th className={TABLE_HEADER_CLASSES}>
                              Deterministic score
                            </th>
                            <th className={TABLE_HEADER_CLASSES}>
                              Reward/Risk
                            </th>
                            <th className={TABLE_HEADER_CLASSES}>
                              P(R &gt; 0)
                            </th>
                            <th className={TABLE_HEADER_CLASSES}>Expected R</th>
                            <th className={TABLE_HEADER_CLASSES}>
                              V3 selection
                            </th>
                            <th className={TABLE_HEADER_CLASSES}>V4 shadow</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedDecision.candidates.map(
                            (cand: Record<string, any>, i: number) => {
                              const isV3Selected =
                                cand.observationId ===
                                selectedDecision.selectedObservationId;
                              const isV4Selected =
                                cand.observationId ===
                                (
                                  selectedDecision.shadowDecision as {
                                    selectedObservationId?: string | null;
                                  }
                                )?.selectedObservationId;
                              return (
                                <tr
                                  key={i}
                                  className={
                                    isV3Selected
                                      ? TABLE_ROW_V3_CLASSES
                                      : isV4Selected
                                        ? TABLE_ROW_V4_CLASSES
                                        : TABLE_ROW_HOVER_CLASSES
                                  }
                                >
                                  <td className={TABLE_CELL_CLASSES}>
                                    <strong>
                                      {displayStrategy(cand.strategyKey)}
                                    </strong>
                                  </td>
                                  <td className={TABLE_CELL_CLASSES}>
                                    {cand.score ?? "—"}
                                  </td>
                                  <td className={TABLE_CELL_CLASSES}>
                                    {cand.rewardRisk
                                      ? cand.rewardRisk.toFixed(2)
                                      : "—"}
                                  </td>
                                  <td className={TABLE_CELL_CLASSES}>
                                    {cand.prediction?.predictedProbability !==
                                    undefined
                                      ? `${(cand.prediction.predictedProbability * 100).toFixed(1)}%`
                                      : (cand.prediction?.fallbackReason ??
                                        "No model")}
                                  </td>
                                  <td className={TABLE_CELL_CLASSES}>
                                    {cand.prediction?.expectedR !== undefined &&
                                    cand.prediction.expectedR !== null
                                      ? `${cand.prediction.expectedR > 0 ? "+" : ""}${cand.prediction.expectedR.toFixed(2)}R`
                                      : "—"}
                                  </td>
                                  <td className={TABLE_CELL_CLASSES}>
                                    {isV3Selected ? (
                                      <span className={badgeClasses("success")}>
                                        PRIMARY
                                      </span>
                                    ) : cand.eligibleAsPrimary ? (
                                      "Eligible"
                                    ) : (
                                      <span className="tw:text-ink-700">
                                        Ineligible
                                      </span>
                                    )}
                                  </td>
                                  <td className={TABLE_CELL_CLASSES}>
                                    {isV4Selected ? (
                                      <span className={badgeClasses("info")}>
                                        V4 PICK
                                      </span>
                                    ) : cand.statisticallyVetoed ? (
                                      <span className={badgeClasses("danger")}>
                                        VETOED
                                      </span>
                                    ) : (
                                      "—"
                                    )}
                                  </td>
                                </tr>
                              );
                            },
                          )}
                        </tbody>
                      </table>
                    ) : (
                      <p className="tw:text-ink-700">
                        No candidate snapshots recorded.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="tw:text-ink-700">
                    Select a decision to view details.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className={SECTION_CLASSES}>
            <div className={SECTION_HEADER_CLASSES}>
              <h2 className={SECTION_TITLE_CLASSES}>Process summary</h2>
              <span className={SECTION_TAG_CLASSES}>COUNTS</span>
            </div>
            <dl className={SUMMARY_LIST_CLASSES}>
              <div className={SUMMARY_ITEM_CLASSES}>
                <dt className={SUMMARY_LABEL_CLASSES}>Pending stages</dt>
                <dd className={SUMMARY_VALUE_CLASSES}>{pendingStages}</dd>
              </div>
              <div className={SUMMARY_ITEM_CLASSES}>
                <dt className={SUMMARY_LABEL_CLASSES}>Failed stages</dt>
                <dd className={SUMMARY_VALUE_CLASSES}>{failedStages}</dd>
              </div>
              <div className={SUMMARY_ITEM_CLASSES}>
                <dt className={SUMMARY_LABEL_CLASSES}>Unknown stages</dt>
                <dd className={SUMMARY_VALUE_CLASSES}>{unknownStages}</dd>
              </div>
              <div className={SUMMARY_ITEM_CLASSES}>
                <dt className={SUMMARY_LABEL_CLASSES}>
                  Failed checks in retained history
                </dt>
                <dd className={SUMMARY_VALUE_CLASSES}>
                  {runs.filter((run) => run.state === "FAILED").length}
                </dd>
              </div>
            </dl>
            <p className={SECTION_DESCRIPTION_CLASSES}>
              Unknown is not success. Raw reason codes and retained artifacts
              stay inspectable inside each process card.
            </p>
          </section>
        </>
      )}

      {loading && overview ? (
        <p className="loading-indicator" role="status">
          Refreshing…
        </p>
      ) : null}
    </div>
  );
}
