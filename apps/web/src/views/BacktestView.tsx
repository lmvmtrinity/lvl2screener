import {
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  type BacktestAutomationStatus,
  type BacktestAutomationWork,
  type BacktestComparison,
  type BacktestRun,
  type ResearchJob,
  backtestComparisonSchema,
  backtestRunListSchema,
  backtestRunSchema,
  researchJobSchema,
} from "@tsx-scanner/contracts";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { getJson, sendJson } from "../lib/api.js";
import {
  useCapturedHistoryFormGuard,
  useCapturedHistoryRunSummary,
} from "../lib/captured-history.js";
import {
  TRIGGER_ORIGIN_LABELS,
  coverageLabel,
  evidenceLabel,
  evidenceTone,
  executionLabel,
  executionTone,
  groupBacktestResults,
  runDisplayName,
} from "../lib/backtest-results.js";
import {
  STRATEGY_OPTIONS,
  dateInput,
  displayStrategy,
  fmt,
} from "../lib/format.js";
import { classes } from "../lib/classes.js";
import {
  cancelResearchJob,
  isAbortError,
  pollResearchJob,
  researchJobFailureMessage,
} from "../lib/research-job.js";
import { Button } from "../components/ui/Button.js";
import { Panel, PanelHeader, PanelMeta } from "../components/ui/Panel.js";
import { CopyButton, Drawer } from "../ui.js";
import { EvidenceSummary } from "./EvidenceSummary.js";
import { BacktestAutomationPanel } from "./BacktestAutomationPanel.js";
import { FundedReplayPanel } from "./FundedReplayPanel.js";
import { StrategyStudyPanel } from "./StrategyStudyPanel.js";

type PageTab = "overview" | "results" | "history";
type DetailTab = "summary" | "evidence" | "trades" | "provenance";

const PAGE_TABS: { key: PageTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "results", label: "Results" },
  { key: "history", label: "History" },
];

const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "evidence", label: "Evidence" },
  { key: "trades", label: "Trades" },
  { key: "provenance", label: "Provenance" },
];

const VIEW_TAB_BASE =
  "tw:cursor-pointer tw:rounded-[7px] tw:border tw:px-3 tw:py-2 tw:font-sans tw:text-[0.74rem] tw:font-[650] tw:hover:text-ink-50";
const VIEW_TAB_TONES: Record<string, string> = {
  idle: "tw:border-transparent tw:bg-transparent tw:text-ink-300",
  active: "tw:border-line-accent tw:bg-surface-raised tw:text-ink-50",
};

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

const EMPTY_COMPACT =
  "empty compact tw:p-[25px] tw:text-center tw:text-ink-700";

const RESULTS_GRID =
  "tw:grid tw:grid-cols-[20px_minmax(220px,1.6fr)_110px_140px_minmax(120px,1fr)_minmax(140px,1fr)] tw:items-center tw:gap-3 tw:below-1100:grid-cols-[20px_minmax(0,1fr)] tw:below-1100:items-start";
const RESULT_ROW_TONES: Record<string, string> = {
  standard: "tw:border-b tw:border-line-subtle tw:px-[18px] tw:py-[13px]",
  grouped: "tw:px-[18px] tw:py-[13px]",
  nested: "tw:border-t tw:border-line-subtle tw:px-0 tw:py-[11px]",
};

const HISTORY_SUMMARY =
  "tw:grid tw:grid-cols-[minmax(220px,1.6fr)_110px_140px_minmax(120px,1fr)_minmax(140px,1fr)] tw:items-center tw:gap-3 tw:below-1100:grid-cols-[minmax(0,1fr)] tw:below-1100:gap-2";

const HISTORY_SUMMARY_ROW = "tw:grid tw:gap-[3px]";

/* The captured-history notice is injected as `::before` copy by
 * `lib/captured-history.ts`, so the functional contract has to keep rendering
 * it from the same data attributes. Complete literals are required here for
 * Tailwind's source scan. */
const METRICS_HISTORY_CLASSES =
  "tw:[&[data-captured-history]]:before:block tw:[&[data-captured-history]]:before:col-span-full tw:[&[data-captured-history]]:before:content-[attr(data-captured-history)] tw:[&[data-captured-history]]:before:text-[0.8rem] tw:[&[data-captured-history]]:before:leading-[1.4] tw:[&[data-captured-history]]:before:text-danger-tint-soft";
const FIELDS_HISTORY_CLASSES =
  "tw:[.backtest-form[data-captured-history]_&]:before:block tw:[.backtest-form[data-captured-history]_&]:before:col-span-full tw:[.backtest-form[data-captured-history]_&]:before:content-[attr(data-captured-history)] tw:[.backtest-form[data-captured-history]_&]:before:text-[0.8rem] tw:[.backtest-form[data-captured-history]_&]:before:leading-[1.4] tw:[.backtest-form[data-captured-history]_&]:before:text-danger-tint-soft";

const BODY_GRID = "tw:grid tw:gap-[14px] tw:px-[18px] tw:py-4";
const PANEL_TITLE_INLINE =
  "tw:flex tw:items-center tw:justify-between tw:gap-3";
const PANEL_TITLE_INLINE_HEADING = "tw:m-0 tw:text-[0.92rem]";
const PANEL_TITLE_INLINE_META =
  "tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-350";
const DETAIL_NOTE =
  "tw:mx-0 tw:mt-[6px] tw:mb-[10px] tw:text-[0.74rem] tw:leading-[1.45] tw:text-ink-250";
const FIELD_LABEL =
  "tw:grid tw:gap-[7px] tw:font-mono tw:text-[0.64rem] tw:font-bold tw:tracking-[0.07em] tw:text-ink-350";
const FIELD_CONTROL =
  "tw:w-full tw:rounded-[7px] tw:border tw:border-line-input tw:bg-bg tw:px-[11px] tw:py-[10px] tw:text-ink-100 tw:outline-none tw:focus:border-accent";
const FIELD_PAIR =
  "tw:grid tw:grid-cols-[1fr_1fr] tw:gap-3 tw:below-620:grid-cols-[1fr]";

function jobProgressLabel(job: ResearchJob | undefined): string {
  if (job?.status === "CANCELLING") return "CANCELLING…";
  if (job?.progress.totalSessions)
    return `REPLAYING ${job.progress.completedSessions ?? 0}/${job.progress.totalSessions} SESSIONS…`;
  return "REPLAYING HISTORY…";
}

function collectWarnings(run: BacktestRun): string[] {
  const warnings = [
    ...(run.replayInput?.warnings ?? []),
    ...(run.dataQuality?.warnings ?? []),
    ...(run.evidence?.warnings ?? []),
  ];
  return [...new Set(warnings)];
}

/** One evidence summary with expandable reasons instead of a stack of
 * full-width banners in the default view. */
function WarningsSummary({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <details className="evidence-warnings tw:rounded-[8px] tw:border tw:border-line tw:bg-surface-sunken tw:text-[0.74rem]">
      <summary className="tw:cursor-pointer tw:px-3 tw:py-[10px] tw:text-ink-200">
        {warnings.length === 1
          ? "1 limitation or warning recorded"
          : `${warnings.length} limitations and warnings recorded`}
      </summary>
      <ul className="tw:m-0 tw:grid tw:gap-[6px] tw:pt-0 tw:pr-3 tw:pb-[10px] tw:pl-[30px] tw:text-ink-250">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </details>
  );
}

function ResultRow({
  title,
  run,
  selected,
  checked,
  selectable = true,
  onToggle,
  onOpen,
  tone = "standard",
}: {
  title: string;
  run: BacktestRun;
  selected: boolean;
  checked: boolean;
  selectable?: boolean;
  onToggle: () => void;
  onOpen: () => void;
  tone?: "standard" | "grouped" | "nested";
}) {
  const netPnl = run.metrics?.netPnl ?? null;
  const trades = run.metrics?.tradesSimulated ?? null;
  return (
    <article
      className={classes(
        "result-row",
        RESULTS_GRID,
        RESULT_ROW_TONES[tone],
        selected && "tw:bg-surface-raised",
      )}
    >
      {selectable ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Compare ${run.name}`}
        />
      ) : (
        <span aria-hidden="true" className="tw:below-1100:col-start-2" />
      )}
      <div className="result-main tw:grid tw:min-w-0 tw:gap-1 tw:below-1100:col-start-2">
        <button
          type="button"
          className="tw:grid tw:cursor-pointer tw:gap-[3px] tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:text-ink-150 tw:hover:[&_strong]:text-accent"
          onClick={onOpen}
        >
          <strong>{title}</strong>
          <small className="tw:text-[0.65rem] tw:text-ink-400">
            {run.startDate} → {run.endDate}
            {run.supersedesBacktestRunId ? " · replacement" : ""}
          </small>
        </button>
        <details className="result-technical">
          <summary className="tw:w-max tw:cursor-pointer tw:font-mono tw:text-[0.62rem] tw:text-ink-350">
            Technical details
          </summary>
          <span className="tw:mt-1 tw:block tw:font-mono tw:text-[0.63rem] tw:text-ink-350 tw:wrap-anywhere">
            config {run.configVersion} ·{" "}
            {run.executionModelVersion
              ? `${run.executionModelVersion} · ${
                  run.executionModelVersion ===
                  AUTHORITATIVE_EXECUTION_MODEL_VERSION
                    ? "current model"
                    : "other model version"
                }`
              : "no execution model"}{" "}
            · run {run.id} <CopyButton value={run.id} />
          </span>
        </details>
      </div>
      <span
        className={classes(
          automationState(executionTone(run)),
          "tw:below-1100:col-start-2",
        )}
      >
        {executionLabel(run)}
      </span>
      <span
        className={classes(
          automationState(evidenceTone(run)),
          "tw:below-1100:col-start-2",
        )}
      >
        {evidenceLabel(run)}
      </span>
      <span className="result-coverage tw:text-[0.72rem] tw:text-ink-250 tw:below-1100:col-start-2">
        {coverageLabel(run)}
      </span>
      <span
        className={classes(
          "result-outcome tw:grid tw:justify-items-end tw:gap-[2px] tw:text-right tw:below-1100:col-start-2",
          netPnl === null ? "" : netPnl >= 0 ? "positive" : "negative",
        )}
      >
        <b>{netPnl === null ? "—" : `$${netPnl.toFixed(2)}`}</b>
        <small className="tw:text-[0.63rem] tw:text-ink-400">
          {trades === null
            ? "net simulated"
            : `${trades} trades · net simulated`}
        </small>
      </span>
    </article>
  );
}

function HistoryRow({
  run,
  work,
  selected,
  onOpen,
}: {
  run: BacktestRun;
  work?: BacktestAutomationWork;
  selected: boolean;
  onOpen: () => void;
}) {
  const netPnl = run.metrics?.netPnl ?? null;
  const trades = run.metrics?.tradesSimulated ?? null;
  const provenance = work
    ? (TRIGGER_ORIGIN_LABELS[work.triggerOrigin] ?? work.triggerOrigin)
    : "manual run";
  return (
    <article
      className={classes(
        "history-row tw:border-b tw:border-line-subtle tw:px-[18px] tw:py-[13px]",
        selected && "tw:bg-surface-raised",
      )}
    >
      <div className={classes("history-summary", HISTORY_SUMMARY)}>
        <button
          type="button"
          className={classes(
            "history-main tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:text-ink-150 tw:hover:[&_strong]:text-accent",
            HISTORY_SUMMARY_ROW,
          )}
          onClick={onOpen}
        >
          <strong>{run.name}</strong>
          <small className="tw:text-[0.65rem] tw:text-ink-400">
            {run.startDate} → {run.endDate} · {provenance}
            {run.supersedesBacktestRunId ? " · replacement" : ""}
          </small>
        </button>
        <span className={automationState(executionTone(run))}>
          {executionLabel(run)}
        </span>
        <span className={automationState(evidenceTone(run))}>
          {evidenceLabel(run)}
        </span>
        <span className="result-coverage tw:text-[0.72rem] tw:text-ink-250">
          {coverageLabel(run)}
        </span>
        <span
          className={classes(
            "result-outcome tw:grid tw:justify-items-end tw:gap-[2px] tw:text-right",
            netPnl === null ? "" : netPnl >= 0 ? "positive" : "negative",
          )}
        >
          <b>{netPnl === null ? "—" : `$${netPnl.toFixed(2)}`}</b>
          <small className="tw:text-[0.63rem] tw:text-ink-400">
            {trades === null ? "net simulated" : `${trades} trades`}
          </small>
        </span>
      </div>
      <details className="result-technical history-technical tw:pt-[6px]">
        <summary className="tw:w-max tw:cursor-pointer tw:font-mono tw:text-[0.62rem] tw:text-ink-350">
          Technical details
        </summary>
        <dl>
          <div>
            <dt>Run ID</dt>
            <dd>
              {run.id} <CopyButton value={run.id} />
            </dd>
          </div>
          <div>
            <dt>Configuration</dt>
            <dd>
              {run.configVersion} <CopyButton value={run.configVersion} />
            </dd>
          </div>
          <div>
            <dt>Execution model</dt>
            <dd>{run.executionModelVersion ?? "none recorded"}</dd>
          </div>
          <div>
            <dt>Trigger origin</dt>
            <dd>
              {work?.triggerOrigin ?? "not linked to automation"}
              {work?.evaluatedThrough
                ? ` · evaluated through ${work.evaluatedThrough}`
                : ""}
            </dd>
          </div>
          {run.replayInput && (
            <div>
              <dt>Replay input</dt>
              <dd>
                {run.replayInput.inputHash}{" "}
                <CopyButton value={run.replayInput.inputHash} />
              </dd>
            </div>
          )}
          {run.supersedesBacktestRunId && (
            <div>
              <dt>Supersedes</dt>
              <dd>
                {run.supersedesBacktestRunId}{" "}
                <CopyButton value={run.supersedesBacktestRunId} />
              </dd>
            </div>
          )}
          {run.error && (
            <div>
              <dt>Failure</dt>
              <dd>{run.error}</dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  );
}

function ResultSummary({ run }: { run: BacktestRun }) {
  useCapturedHistoryRunSummary(
    run.capturedHistoryAvailability ?? null,
    ".backtest-metrics",
  );
  const metrics = run.metrics;
  return (
    <section
      className={classes(
        "backtest-metrics tw:mb-4 tw:grid tw:grid-cols-[repeat(6,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-xl tw:border tw:border-line tw:bg-surface-sunken tw:below-1000:grid-cols-[repeat(3,1fr)] tw:below-620:grid-cols-[repeat(2,1fr)]",
        METRICS_HISTORY_CLASSES,
      )}
    >
      <div className="tw:bg-surface tw:p-4">
        <span className="tw:mb-[7px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
          TRADES
        </span>
        <strong className="tw:text-[1.05rem]">
          {metrics?.tradesSimulated ?? 0}
        </strong>
      </div>
      <div className="tw:bg-surface tw:p-4">
        <span className="tw:mb-[7px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
          WIN RATE
        </span>
        <strong className="tw:text-[1.05rem]">
          {fmt(metrics?.winRate ?? null, "%")}
        </strong>
      </div>
      <div className="tw:bg-surface tw:p-4">
        <span className="tw:mb-[7px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
          EXPECTANCY
        </span>
        <strong className="tw:text-[1.05rem]">
          ${fmt(metrics?.expectancy ?? null)}
        </strong>
      </div>
      <div className="tw:bg-surface tw:p-4">
        <span className="tw:mb-[7px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
          AVG R
        </span>
        <strong className="tw:text-[1.05rem]">
          {fmt(metrics?.averageR ?? null, "R")}
        </strong>
      </div>
      <div className="tw:bg-surface tw:p-4">
        <span className="tw:mb-[7px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
          PROFIT FACTOR
        </span>
        <strong className="tw:text-[1.05rem]">
          {fmt(metrics?.profitFactor ?? null)}
        </strong>
      </div>
      <div className="tw:bg-surface tw:p-4">
        <span className="tw:mb-[7px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
          MAX DRAWDOWN
        </span>
        <strong className="negative tw:text-[1.05rem]">
          ${fmt(metrics?.maximumDrawdown ?? null)}
        </strong>
      </div>
    </section>
  );
}

const EVIDENCE_RANGES_GRID =
  "tw:grid tw:grid-cols-[repeat(4,1fr)] tw:gap-px tw:mb-4 tw:overflow-hidden tw:rounded-[10px] tw:border tw:border-line tw:bg-surface-sunken tw:below-900:grid-cols-[repeat(2,1fr)] tw:below-520:grid-cols-[1fr]";
const EVIDENCE_DETAIL_GRID =
  "tw:grid tw:grid-cols-[1fr_1fr] tw:gap-4 tw:mb-[14px] tw:below-900:grid-cols-[1fr]";
const EVIDENCE_GATE =
  "tw:flex tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-line-subtle tw:px-[15px] tw:py-[11px]";
const ANALYSIS_GRID =
  "tw:grid tw:grid-cols-[repeat(3,1fr)] tw:gap-4 tw:mb-4 tw:below-1000:grid-cols-[1fr]";
const SLICE_ROW =
  "tw:grid tw:grid-cols-[1.2fr_0.7fr_0.55fr_0.55fr_1fr] tw:gap-2 tw:border-b tw:border-line-subtle tw:px-[15px] tw:py-3 tw:text-[0.7rem] tw:below-620:min-w-[550px]";
const BACKTEST_TRADE =
  "tw:grid tw:grid-cols-[1.2fr_1.2fr_0.7fr_0.7fr] tw:items-center tw:gap-4 tw:border-b tw:border-line-subtle tw:px-5 tw:py-[14px] tw:text-[0.78rem] tw:below-620:grid-cols-[1fr_1fr]";
const SLICE_PANEL = "slice-panel tw:below-620:overflow-x-auto";
const TECHNICAL_ROW =
  "tw:grid tw:grid-cols-[minmax(120px,160px)_1fr] tw:gap-3 tw:border-t tw:border-line-subtle tw:py-[7px] tw:text-[0.72rem] tw:below-1100:grid-cols-[1fr] tw:below-1100:gap-1";
const TECHNICAL_VALUE =
  "tw:m-0 tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:font-mono tw:text-ink-150 tw:wrap-anywhere";

function ResultDetail({
  run,
  work,
  tab,
  onTabChange,
  onClose,
}: {
  run: BacktestRun;
  work?: BacktestAutomationWork;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onClose: () => void;
}) {
  const warnings = collectWarnings(run);
  return (
    <Panel
      as="section"
      className="result-detail tw:mb-4"
      aria-label="Selected result"
    >
      <PanelHeader
        title={runDisplayName(run)}
        description={
          <>
            {run.startDate} → {run.endDate} · {executionLabel(run)} ·{" "}
            {evidenceLabel(run)}
            {work
              ? ` · ${TRIGGER_ORIGIN_LABELS[work.triggerOrigin] ?? work.triggerOrigin}`
              : ""}
          </>
        }
        actions={
          <button
            type="button"
            className={AUTOMATION_SECONDARY}
            onClick={onClose}
          >
            Close
          </button>
        }
      />
      <nav
        className="detail-tabs tw:flex tw:gap-1 tw:border-b tw:border-line tw:px-[18px]"
        role="tablist"
        aria-label="Result detail"
      >
        {DETAIL_TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={classes(
              VIEW_TAB_BASE,
              tab === entry.key ? VIEW_TAB_TONES.active : VIEW_TAB_TONES.idle,
            )}
            onClick={() => onTabChange(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      {tab === "summary" && (
        <div className={BODY_GRID}>
          <ResultSummary run={run} />
          {run.evidence && (
            <>
              <section
                className={classes(
                  "evidence-verdict tw:flex tw:items-center tw:justify-between tw:gap-5 tw:mb-[14px] tw:rounded-[10px] tw:border tw:px-5 tw:py-[18px] tw:below-520:flex-col tw:below-520:items-start",
                  run.evidence.qualification === "EVIDENCE_QUALIFIED"
                    ? "tw:border-line-accent tw:bg-surface-raised"
                    : "tw:border-line-warn-strong tw:bg-surface-warn",
                )}
              >
                <div>
                  <p className="eyebrow tw:m-0 tw:font-mono tw:text-[0.68rem] tw:font-bold tw:leading-[1.4] tw:tracking-[0.18em] tw:text-accent">
                    EVIDENCE ASSESSMENT
                  </p>
                  <h3 className="tw:mx-0 tw:my-[3px]">
                    {run.evidence.qualification.replaceAll("_", " ")}
                  </h3>
                  <span className="tw:text-[0.72rem] tw:text-ink-550">
                    {run.evidence.uniqueSetupInstances} unique setup instances ·{" "}
                    {run.evidence.duplicateReadyEventsExcluded} duplicate READY
                    events excluded
                  </span>
                </div>
                <strong className="tw:font-mono tw:text-[0.62rem] tw:font-extrabold tw:tracking-[0.08em]">
                  {run.evidence.positiveExpectancyRange &&
                  run.evidence.adequateSamples
                    ? "RANGE + SAMPLE GATES PASS"
                    : "NOT VALIDATED"}
                </strong>
              </section>
              <section className={EVIDENCE_RANGES_GRID}>
                <article className="tw:grid tw:gap-[5px] tw:bg-surface tw:p-[15px]">
                  <span className="tw:font-mono tw:text-[0.57rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-350">
                    EXPECTANCY · 95% BOOTSTRAP
                  </span>
                  <strong>${fmt(run.evidence.expectancy.estimate)}</strong>
                  <small className="tw:text-ink-550">
                    ${fmt(run.evidence.expectancy.lower)} → $
                    {fmt(run.evidence.expectancy.upper)}
                  </small>
                </article>
                <article className="tw:grid tw:gap-[5px] tw:bg-surface tw:p-[15px]">
                  <span className="tw:font-mono tw:text-[0.57rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-350">
                    WIN RATE · 95% BOOTSTRAP
                  </span>
                  <strong>{fmt(run.evidence.winRate.estimate, "%")}</strong>
                  <small className="tw:text-ink-550">
                    {fmt(run.evidence.winRate.lower, "%")} →{" "}
                    {fmt(run.evidence.winRate.upper, "%")}
                  </small>
                </article>
                <article className="tw:grid tw:gap-[5px] tw:bg-surface tw:p-[15px]">
                  <span className="tw:font-mono tw:text-[0.57rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-350">
                    FALSE BREAKOUT · 95% BOOTSTRAP
                  </span>
                  <strong>
                    {fmt(run.evidence.falseBreakoutRate.estimate, "%")}
                  </strong>
                  <small className="tw:text-ink-550">
                    {fmt(run.evidence.falseBreakoutRate.lower, "%")} →{" "}
                    {fmt(run.evidence.falseBreakoutRate.upper, "%")}
                  </small>
                </article>
                <article className="tw:grid tw:gap-[5px] tw:bg-surface tw:p-[15px]">
                  <span className="tw:font-mono tw:text-[0.57rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-350">
                    SIGNAL OVERLAP PEAK
                  </span>
                  <strong>
                    {run.evidence.portfolioRisk.maximumConcurrentTrades}{" "}
                    positions
                  </strong>
                  <small className="tw:text-ink-550">
                    post-hoc overlap of $
                    {run.evidence.portfolioRisk.maximumConcurrentGrossExposure.toFixed(
                      2,
                    )}{" "}
                    gross exposure
                  </small>
                </article>
              </section>
            </>
          )}
          <WarningsSummary warnings={warnings} />
        </div>
      )}
      {tab === "evidence" && (
        <div className={BODY_GRID}>
          {run.evidence ? (
            <>
              <section className={EVIDENCE_DETAIL_GRID}>
                <Panel as="article" className={SLICE_PANEL}>
                  <PanelHeader
                    title="Sample gates"
                    description={`${run.evidence.minimumTradesPerSlice} trades required per observed slice.`}
                  />
                  {run.evidence.sliceGates.map((gate) => (
                    <div
                      className={EVIDENCE_GATE}
                      key={`${gate.dimension}:${gate.bucket}`}
                    >
                      <span className="tw:grid tw:gap-[3px]">
                        <strong>{gate.bucket}</strong>
                        <small className="tw:text-[0.6rem] tw:text-ink-350">
                          {gate.dimension.replaceAll("_", " ")}
                        </small>
                      </span>
                      <b className={gate.sufficient ? "positive" : "negative"}>
                        {gate.trades} / {gate.minimumTrades}
                      </b>
                    </div>
                  ))}
                </Panel>
                <Panel as="article" className={SLICE_PANEL}>
                  <PanelHeader
                    title="Walk-forward windows"
                    description="Fixed configuration · expanding train dates · next block test."
                  />
                  {run.evidence.walkForward.map((window) => (
                    <div className={EVIDENCE_GATE} key={window.index}>
                      <span className="tw:grid tw:gap-[3px]">
                        <strong>
                          {window.testStart} → {window.testEnd}
                        </strong>
                        <small className="tw:text-[0.6rem] tw:text-ink-350">
                          {window.trainTrades} train · {window.testTrades} test
                          trades
                        </small>
                      </span>
                      <b
                        className={
                          window.testExpectancy > 0 ? "positive" : "negative"
                        }
                      >
                        ${window.testExpectancy.toFixed(2)} exp.
                      </b>
                    </div>
                  ))}
                  {!run.evidence.walkForward.length && (
                    <div className={EMPTY_COMPACT}>
                      Not enough trading dates
                    </div>
                  )}
                </Panel>
              </section>
              <section className={ANALYSIS_GRID}>
                {(["STRATEGY", "SCORE_BUCKET", "TIME_OF_DAY"] as const).map(
                  (dimension) => (
                    <Panel as="article" className={SLICE_PANEL} key={dimension}>
                      <PanelHeader title={dimension.replaceAll("_", " ")} />
                      {run.analyses
                        .filter((value) => value.dimension === dimension)
                        .map((value) => (
                          <div className={SLICE_ROW} key={value.bucket}>
                            <strong>{value.bucket}</strong>
                            <span className="tw:text-ink-350">
                              {value.trades} trades
                            </span>
                            <span className="tw:text-ink-350">
                              {value.winRate.toFixed(1)}%
                            </span>
                            <span className="tw:text-ink-350">
                              {value.averageR.toFixed(2)}R
                            </span>
                            <b
                              className={classes(
                                "tw:text-right",
                                value.expectancy >= 0 ? "positive" : "negative",
                              )}
                            >
                              ${value.expectancy.toFixed(2)} exp.
                            </b>
                          </div>
                        ))}
                      {!run.analyses.some(
                        (value) => value.dimension === dimension,
                      ) && (
                        <div className={EMPTY_COMPACT}>
                          No qualifying trades
                        </div>
                      )}
                    </Panel>
                  ),
                )}
              </section>
            </>
          ) : (
            <p className={EMPTY_COMPACT}>
              No evidence assessment was recorded for this run.
            </p>
          )}
          <WarningsSummary warnings={warnings} />
        </div>
      )}
      {tab === "trades" && (
        <div className={BODY_GRID}>
          <section className="backtest-trades">
            <div className={PANEL_TITLE_INLINE}>
              <h3 className={PANEL_TITLE_INLINE_HEADING}>Simulated trades</h3>
              <span className={PANEL_TITLE_INLINE_META}>
                {run.trades.length} TRADES
              </span>
            </div>
            <p className={DETAIL_NOTE}>
              Slippage and fees included; entries and exits are evaluated
              against the captured quote path.
            </p>
            {run.trades.map((trade) => (
              <div className={BACKTEST_TRADE} key={trade.id}>
                <strong>
                  {trade.symbol}
                  <small className="tw:mt-1 tw:block tw:text-[0.62rem] tw:text-ink-350">
                    {displayStrategy(trade.strategy)} · score {trade.score}
                  </small>
                </strong>
                <span>
                  ${trade.entryPrice.toFixed(2)} → ${trade.exitPrice.toFixed(2)}
                  <small className="tw:mt-1 tw:block tw:text-[0.62rem] tw:text-ink-350">
                    {trade.exitReason} · {trade.holdMinutes.toFixed(0)}m
                  </small>
                  {trade.sampledExcursion && (
                    <small className="tw:mt-1 tw:block tw:text-[0.62rem] tw:text-ink-350">
                      sampled bid path:{" "}
                      {trade.sampledExcursion.status === "AVAILABLE"
                        ? `${trade.sampledExcursion.adversePct?.toFixed(2)}% adverse / ${trade.sampledExcursion.favorablePct?.toFixed(2)}% favorable`
                        : trade.sampledExcursion.reasonCodes.join(", ")}
                    </small>
                  )}
                </span>
                <span>{trade.shares} shares</span>
                <b
                  className={classes(
                    "tw:text-right",
                    trade.netPnl >= 0 ? "positive" : "negative",
                  )}
                >
                  ${trade.netPnl.toFixed(2)}
                  <small className="tw:mt-1 tw:block tw:text-[0.62rem] tw:text-ink-350">
                    {trade.rMultiple.toFixed(2)}R
                  </small>
                </b>
              </div>
            ))}
            {!run.trades.length && (
              <div className={EMPTY_COMPACT}>
                No simulated trades in this run.
              </div>
            )}
          </section>
        </div>
      )}
      {tab === "provenance" && (
        <div className={BODY_GRID}>
          <section className="replay-input-summary tw:mt-4">
            <div className={PANEL_TITLE_INLINE}>
              <h3 className={PANEL_TITLE_INLINE_HEADING}>Replay input</h3>
              <span className={PANEL_TITLE_INLINE_META}>
                {run.replayInput ? "RESOLVED" : "UNRESOLVED"}
              </span>
            </div>
            {run.replayInput ? (
              <>
                <p className={DETAIL_NOTE}>
                  Resolved {run.replayInput.resolvedAt} · input hash{" "}
                  {run.replayInput.inputHash.slice(0, 12)}{" "}
                  <CopyButton value={run.replayInput.inputHash} />
                </p>
                <div className="replay-input-row tw:grid tw:grid-cols-[minmax(9rem,auto)_1fr] tw:gap-3 tw:border-t tw:border-line-subtle tw:py-[0.55rem] tw:text-[0.82rem]">
                  <strong>
                    Candidates · {run.replayInput.candidateInstruments.length}
                  </strong>
                  <span className="tw:text-ink-650 tw:wrap-anywhere">
                    {run.replayInput.candidateInstruments
                      .map((value) => value.symbol)
                      .join(", ") || "None resolved"}
                  </span>
                </div>
                <div className="replay-input-row tw:grid tw:grid-cols-[minmax(9rem,auto)_1fr] tw:gap-3 tw:border-t tw:border-line-subtle tw:py-[0.55rem] tw:text-[0.82rem]">
                  <strong>
                    Benchmarks · {run.replayInput.benchmarks.length}
                  </strong>
                  <span className="tw:text-ink-650 tw:wrap-anywhere">
                    {run.replayInput.benchmarks
                      .map((value) => `${value.kind} ${value.symbol}`)
                      .join(", ") || "None resolved"}
                  </span>
                </div>
                {run.replayInput.universeRefreshRunId && (
                  <div className="replay-input-row tw:grid tw:grid-cols-[minmax(9rem,auto)_1fr] tw:gap-3 tw:border-t tw:border-line-subtle tw:py-[0.55rem] tw:text-[0.82rem]">
                    <strong>Universe refresh</strong>
                    <span className="tw:text-ink-650 tw:wrap-anywhere">
                      {run.replayInput.universeRefreshRunId}{" "}
                      <CopyButton
                        value={run.replayInput.universeRefreshRunId}
                      />
                    </span>
                  </div>
                )}
                <WarningsSummary warnings={run.replayInput.warnings} />
              </>
            ) : (
              <p className={DETAIL_NOTE}>
                LEGACY_UNRESOLVED_UNIVERSE · exact candidate and benchmark
                provenance was not stored.
              </p>
            )}
          </section>
          <section className="replay-input-summary tw:mt-4">
            <div className={PANEL_TITLE_INLINE}>
              <h3 className={PANEL_TITLE_INLINE_HEADING}>Technical details</h3>
            </div>
            <dl className="technical-details tw:mx-0 tw:mt-2 tw:mb-0 tw:grid tw:gap-[2px]">
              <div className={TECHNICAL_ROW}>
                <dt className="tw:text-ink-350">Run ID</dt>
                <dd className={TECHNICAL_VALUE}>
                  {run.id} <CopyButton value={run.id} />
                </dd>
              </div>
              <div className={TECHNICAL_ROW}>
                <dt className="tw:text-ink-350">Configuration</dt>
                <dd className={TECHNICAL_VALUE}>
                  {run.configVersion} <CopyButton value={run.configVersion} />
                </dd>
              </div>
              <div className={TECHNICAL_ROW}>
                <dt className="tw:text-ink-350">Execution model</dt>
                <dd className={TECHNICAL_VALUE}>
                  {run.executionModelVersion ?? "none recorded"}
                </dd>
              </div>
              <div className={TECHNICAL_ROW}>
                <dt className="tw:text-ink-350">Trigger origin</dt>
                <dd className={TECHNICAL_VALUE}>
                  {work?.triggerOrigin ?? "not linked to automation"}
                  {work?.evaluatedThrough
                    ? ` · evaluated through ${work.evaluatedThrough}`
                    : ""}
                </dd>
              </div>
              {run.supersedesBacktestRunId && (
                <div className={TECHNICAL_ROW}>
                  <dt className="tw:text-ink-350">Supersedes</dt>
                  <dd className={TECHNICAL_VALUE}>
                    {run.supersedesBacktestRunId}{" "}
                    <CopyButton value={run.supersedesBacktestRunId} />
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <EvidenceSummary
            marketId={run.marketId}
            binding={run.researchEvidence ?? null}
          />
        </div>
      )}
    </Panel>
  );
}

export function BacktestView({
  runs,
  updateRuns,
  marketId = "CA_TSX",
  onOpenUniverse,
}: {
  runs: BacktestRun[];
  updateRuns: (runs: BacktestRun[]) => void;
  marketId?: "CA_TSX" | "US_EQUITIES";
  onOpenUniverse?: () => void;
}) {
  const today = dateInput(),
    monthAgo = dateInput(new Date(Date.now() - 30 * 86_400_000));
  const [name, setName] = useState("Baseline replay"),
    [startDate, setStartDate] = useState(monthAgo),
    [endDate, setEndDate] = useState(today),
    [symbols, setSymbols] = useState("");
  const [rvol, setRvol] = useState("1.5"),
    [spread, setSpread] = useState("0.25"),
    [volumeRatio, setVolumeRatio] = useState("1.5"),
    [tolerance, setTolerance] = useState("0.15"),
    [scoreCutoff, setScoreCutoff] = useState("0");
  const [capital, setCapital] = useState("100000"),
    [positionSize, setPositionSize] = useState("10000"),
    [slippage, setSlippage] = useState("2"),
    [fees, setFees] = useState("0"),
    [selected, setSelected] = useState<BacktestRun>(),
    [comparisonIds, setComparisonIds] = useState<string[]>([]),
    [comparison, setComparison] = useState<BacktestComparison>(),
    [error, setError] = useState(""),
    [running, setRunning] = useState(false),
    [manualOpen, setManualOpen] = useState(false),
    [pageTab, setPageTab] = useState<PageTab>("overview"),
    [detailTab, setDetailTab] = useState<DetailTab>("summary"),
    [automationStatus, setAutomationStatus] =
      useState<BacktestAutomationStatus>(),
    [job, setJob] = useState<ResearchJob>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  useCapturedHistoryFormGuard(startDate, endDate, marketId, manualOpen);
  const resultGroups = useMemo(() => groupBacktestResults(runs), [runs]);
  const historyRuns = useMemo(
    () =>
      [...runs].sort(
        (left, right) =>
          Date.parse(right.completedAt ?? right.startedAt ?? right.createdAt) -
          Date.parse(left.completedAt ?? left.startedAt ?? left.createdAt),
      ),
    [runs],
  );
  const workByRunId = useMemo(
    () =>
      new Map(
        (automationStatus?.works ?? []).flatMap((work) =>
          work.runId ? [[work.runId, work] as const] : [],
        ),
      ),
    [automationStatus],
  );
  const selectedWork = selected ? workByRunId.get(selected.id) : undefined;
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setRunning(true);
    setError("");
    setJob(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const queued = researchJobSchema.parse(
        await sendJson("/api/backtests", "POST", {
          name,
          startDate,
          endDate,
          strategies: STRATEGY_OPTIONS,
          symbols: symbols
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          startingCapital: Number(capital),
          positionSize: Number(positionSize),
          slippageBps: Number(slippage),
          feePerTrade: Number(fees),
          marketId,
          parameters: {
            rvolAtTimeMin: Number(rvol),
            spreadHardMaxPct: Number(spread),
            breakoutVolumeRatioMin: Number(volumeRatio),
            retestTolerancePct: Number(tolerance),
            scoreCutoff: Number(scoreCutoff),
          },
        }),
      );
      setJob(queued);
      const finished = await pollResearchJob(queued.id, {
        signal: controller.signal,
        onUpdate: setJob,
      });
      if (finished.status === "SUCCEEDED" && finished.resultRefId) {
        const run = backtestRunSchema.parse(
          await getJson(`/api/backtests/${finished.resultRefId}`),
        );
        updateRuns([run, ...runs.filter((value) => value.id !== run.id)]);
        setSelected(run);
        setDetailTab("summary");
        setPageTab("results");
        setManualOpen(false);
      } else {
        setError(researchJobFailureMessage(finished));
      }
      setJob(finished);
    } catch (reason) {
      if (!isAbortError(reason))
        setError(
          reason instanceof Error ? reason.message : "Unable to run backtest",
        );
    } finally {
      setRunning(false);
      abortRef.current = undefined;
    }
  };
  const cancel = async () => {
    if (!job) return;
    try {
      const cancelled = await cancelResearchJob(job.id);
      setJob(cancelled);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to cancel backtest",
      );
    } finally {
      abortRef.current?.abort();
    }
  };
  const open = async (run: BacktestRun) => {
    setError("");
    setDetailTab("summary");
    try {
      setSelected(
        backtestRunSchema.parse(await getJson(`/api/backtests/${run.id}`)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load run");
    }
  };
  const compare = async () => {
    setError("");
    try {
      setComparison(
        backtestComparisonSchema.parse(
          await getJson(
            `/api/backtests/compare?ids=${comparisonIds.join(",")}`,
          ),
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to compare runs",
      );
    }
  };
  const toggle = (id: string) =>
    setComparisonIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length < 10
          ? [...current, id]
          : current,
    );
  const runLabel = running ? jobProgressLabel(job) : "RUN BACKTEST";
  const refreshRuns = async () => {
    try {
      const value = backtestRunListSchema.parse(
        await getJson("/api/backtests?limit=100"),
      );
      updateRuns(value.runs);
    } catch {
      // The automation panel keeps its own status; a failed run reload leaves
      // the existing list in place instead of clearing it.
    }
  };
  const manualForm = (
    <form className="backtest-form" onSubmit={(event) => void create(event)}>
      <PanelHeader
        title="New historical replay"
        description="Captured quotes only · same live feature and strategy logic"
        descriptionClassName="tw:mt-1 tw:mb-0 tw:text-[0.72rem] tw:text-ink-350"
        actions={<PanelMeta>NO LOOK-AHEAD</PanelMeta>}
      />
      <div
        className={classes(
          "backtest-fields tw:grid tw:gap-[14px] tw:p-5",
          FIELDS_HISTORY_CLASSES,
        )}
      >
        <label className={FIELD_LABEL}>
          Run name
          <input
            className={FIELD_CONTROL}
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className={FIELD_PAIR}>
          <label className={FIELD_LABEL}>
            Start
            <input
              className={FIELD_CONTROL}
              type="date"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className={FIELD_LABEL}>
            End
            <input
              className={FIELD_CONTROL}
              type="date"
              required
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
        </div>
        <label className={FIELD_LABEL}>
          Symbols{" "}
          <small className="tw:font-medium tw:tracking-normal">
            blank = active universe
          </small>
          <input
            className={FIELD_CONTROL}
            value={symbols}
            onChange={(e) => setSymbols(e.target.value)}
            placeholder="BTO.TO, BAM.TO"
          />
        </label>
        <div className={FIELD_PAIR}>
          <label className={FIELD_LABEL}>
            RVOL minimum
            <input
              className={FIELD_CONTROL}
              type="number"
              min="0"
              step="0.1"
              value={rvol}
              onChange={(e) => setRvol(e.target.value)}
            />
          </label>
          <label className={FIELD_LABEL}>
            Spread hard max %
            <input
              className={FIELD_CONTROL}
              type="number"
              min="0.01"
              step="0.01"
              value={spread}
              onChange={(e) => setSpread(e.target.value)}
            />
          </label>
        </div>
        <div className={FIELD_PAIR}>
          <label className={FIELD_LABEL}>
            Breakout candle volume ratio
            <input
              className={FIELD_CONTROL}
              type="number"
              min="0.1"
              step="0.1"
              value={volumeRatio}
              onChange={(e) => setVolumeRatio(e.target.value)}
            />
          </label>
          <label className={FIELD_LABEL}>
            Retest tolerance %
            <input
              className={FIELD_CONTROL}
              type="number"
              min="0"
              step="0.01"
              value={tolerance}
              onChange={(e) => setTolerance(e.target.value)}
            />
          </label>
        </div>
        <div className={FIELD_PAIR}>
          <label className={FIELD_LABEL}>
            Score cutoff
            <input
              className={FIELD_CONTROL}
              type="number"
              min="0"
              max="100"
              step="1"
              value={scoreCutoff}
              onChange={(e) => setScoreCutoff(e.target.value)}
            />
          </label>
          <label className={FIELD_LABEL}>
            Starting capital
            <input
              className={FIELD_CONTROL}
              type="number"
              min="1"
              step="1000"
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
            />
          </label>
        </div>
        <div className={FIELD_PAIR}>
          <label className={FIELD_LABEL}>
            Dollars per trade
            <input
              className={FIELD_CONTROL}
              type="number"
              min="1"
              step="100"
              value={positionSize}
              onChange={(e) => setPositionSize(e.target.value)}
            />
          </label>
          <label className={FIELD_LABEL}>
            Slippage bps
            <input
              className={FIELD_CONTROL}
              type="number"
              min="0"
              step="0.1"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </label>
        </div>
        <label className={FIELD_LABEL}>
          Fee per round trip
          <input
            className={FIELD_CONTROL}
            type="number"
            min="0"
            step="0.01"
            value={fees}
            onChange={(e) => setFees(e.target.value)}
          />
        </label>
        <div className={FIELD_PAIR}>
          <Button variant="primary" className="run-backtest" disabled={running}>
            {runLabel}
          </Button>
          {running && (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={job?.status === "CANCELLING"}
            >
              CANCEL
            </button>
          )}
        </div>
      </div>
    </form>
  );
  return (
    <>
      <div className="backtest-toolbar tw:mx-0 tw:mt-[14px] tw:mb-[10px] tw:flex tw:items-center tw:justify-between tw:gap-3 tw:text-[0.72rem] tw:text-ink-400">
        <nav
          className="view-tabs tw:flex tw:items-center tw:gap-1"
          role="tablist"
          aria-label="Backtest views"
        >
          {PAGE_TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={pageTab === entry.key}
              className={classes(
                VIEW_TAB_BASE,
                pageTab === entry.key
                  ? VIEW_TAB_TONES.active
                  : VIEW_TAB_TONES.idle,
              )}
              onClick={() => setPageTab(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className={AUTOMATION_SECONDARY}
          onClick={() => setManualOpen(true)}
        >
          Manual replay
        </button>
      </div>
      {pageTab === "overview" && (
        <>
          <BacktestAutomationPanel
            marketId={marketId}
            onRefreshed={() => void refreshRuns()}
            onStatusChange={setAutomationStatus}
            onOpenUniverse={onOpenUniverse}
          />
          <Panel as="section" className="results-list results-preview tw:mb-4">
            <PanelHeader
              title="Latest results"
              description="Most recent result per configuration."
              actions={
                <Button variant="primary" onClick={() => setPageTab("results")}>
                  View all results
                </Button>
              }
            />
            {resultGroups.slice(0, 4).map((group, index, shown) => (
              <ResultRow
                key={group.key}
                title={group.title}
                run={group.latest}
                selected={selected?.id === group.latest.id}
                checked={false}
                selectable={false}
                tone={index === shown.length - 1 ? "grouped" : "standard"}
                onToggle={() => undefined}
                onOpen={() => void open(group.latest)}
              />
            ))}
            {!resultGroups.length && (
              <div className="empty">No results yet.</div>
            )}
          </Panel>
        </>
      )}
      {pageTab === "results" && (
        <Panel as="section" className="results-list tw:mb-4">
          <PanelHeader
            title="Latest results"
            description="Latest run per configuration. Older attempts stay available for audit and controlled comparison."
            actions={
              <Button
                variant="primary"
                disabled={comparisonIds.length < 2}
                onClick={() => void compare()}
              >
                COMPARE · {comparisonIds.length}
              </Button>
            }
          />
          <div
            className={classes(
              "results-head",
              RESULTS_GRID,
              "tw:border-b tw:border-line tw:px-[18px] tw:py-2 tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:uppercase tw:text-ink-350 tw:below-1100:hidden",
            )}
            aria-hidden="true"
          >
            <span />
            <span>Configuration</span>
            <span>Execution</span>
            <span>Evidence</span>
            <span>Coverage</span>
            <span>Outcome</span>
          </div>
          {resultGroups.map((group) => (
            <div
              className="result-group tw:border-b tw:border-line-subtle"
              key={group.key}
            >
              <ResultRow
                title={group.title}
                run={group.latest}
                selected={selected?.id === group.latest.id}
                checked={comparisonIds.includes(group.latest.id)}
                tone="grouped"
                onToggle={() => toggle(group.latest.id)}
                onOpen={() => void open(group.latest)}
              />
              {group.older.length > 0 && (
                <details className="result-history tw:pt-0 tw:pr-[18px] tw:pb-[10px] tw:pl-[50px]">
                  <summary className="tw:w-max tw:cursor-pointer tw:px-0 tw:py-[6px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.05em] tw:text-ink-350">
                    {group.older.length} older{" "}
                    {group.older.length === 1 ? "attempt" : "attempts"}
                  </summary>
                  {group.older.map((run) => (
                    <ResultRow
                      key={run.id}
                      title={group.title}
                      run={run}
                      selected={selected?.id === run.id}
                      checked={comparisonIds.includes(run.id)}
                      tone="nested"
                      onToggle={() => toggle(run.id)}
                      onOpen={() => void open(run)}
                    />
                  ))}
                </details>
              )}
            </div>
          ))}
          {!runs.length && <div className="empty">No backtest runs yet.</div>}
        </Panel>
      )}
      {pageTab === "history" && (
        <Panel as="section" className="history-list tw:mb-4">
          <PanelHeader
            title="Run history"
            description="All attempts, superseded runs, failures and provenance. Raw diagnostics stay with each run."
            actions={<PanelMeta>{historyRuns.length} attempts</PanelMeta>}
          />
          {historyRuns.map((run) => (
            <HistoryRow
              key={run.id}
              run={run}
              work={workByRunId.get(run.id)}
              selected={selected?.id === run.id}
              onOpen={() => void open(run)}
            />
          ))}
          {!historyRuns.length && (
            <div className="empty">No backtest runs recorded yet.</div>
          )}
        </Panel>
      )}
      {selected && (
        <ResultDetail
          run={selected}
          work={selectedWork}
          tab={detailTab}
          onTabChange={setDetailTab}
          onClose={() => setSelected(undefined)}
        />
      )}
      <details className="backtest-collapsible tw:group tw:mx-0 tw:mt-[18px] tw:mb-4">
        <summary className="tw:cursor-pointer tw:rounded-panel tw:border tw:border-line tw:bg-surface tw:px-[18px] tw:py-[13px] tw:font-mono tw:text-[0.66rem] tw:font-bold tw:tracking-[0.07em] tw:text-ink-400 tw:group-open:rounded-b-none">
          Study authorization &amp; frozen plan (expert)
        </summary>
        <StrategyStudyPanel marketId={marketId} />
      </details>
      <FundedReplayPanel marketId={marketId} />
      {error && <p className="error-banner">{error}</p>}
      {comparison && (
        <section
          className={classes(
            "comparison-note tw:mb-4 tw:flex tw:gap-[14px] tw:rounded-[9px] tw:border tw:px-[17px] tw:py-[13px] tw:text-[0.76rem] tw:text-ink-450",
            comparison.comparable
              ? "tw:border-line-accent tw:bg-surface-raised"
              : "tw:border-line-warn-strong tw:bg-surface-warn",
          )}
        >
          <strong>
            {comparison.comparable
              ? "Controlled comparison"
              : "Comparison needs caution"}
          </strong>
          <span>
            {comparison.comparable
              ? "Dates, universe, source, sizing, slippage, and fees match."
              : `Different: ${comparison.differences.join(", ")}.`}
          </span>
        </section>
      )}
      <Drawer
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="Manual replay"
      >
        {manualForm}
      </Drawer>
    </>
  );
}
