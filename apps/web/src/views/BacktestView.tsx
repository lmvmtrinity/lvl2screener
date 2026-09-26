import { HistoricalImportProgress } from "./HistoricalImportProgress.js";
import {
  type BacktestAutomationWork,
  type BacktestComparison,
  type BacktestDataSource,
  type BacktestRun,
  type ResearchJob,
  backtestComparisonSchema,
  backtestRunListSchema,
  backtestRunSchema,
  researchJobSchema,
} from "@tsx-scanner/contracts";
import { type FormEvent, Fragment, useMemo, useRef, useState } from "react";
import { getJson, sendJson } from "../lib/api.js";
import {
  useCapturedHistoryFormGuard,
  useCapturedHistoryRunSummary,
} from "../lib/captured-history.js";
import {
  type BacktestResultGroup,
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
import {
  CARD,
  LABEL,
  LINK_BUTTON,
  MoreMenu,
  SectionHead,
  badge,
} from "../components/PageSections.js";
import {
  AutomationDiagnostics,
  AutomationEvidence,
  AutomationSettings,
  AutomationStatusLine,
  CheckForWorkButton,
  NowRunning,
  useBacktestAutomation,
} from "./BacktestAutomationPanel.js";
import { FundedReplayPanel } from "./FundedReplayPanel.js";
import { StrategyStudyPanel } from "./StrategyStudyPanel.js";
import { StrategyLearningReadinessPanel } from "./StrategyLearningReadinessPanel.js";
import { SignalModelResearchStatusPanel } from "./SignalModelResearchStatusPanel.js";

type DetailTab = "summary" | "evidence" | "trades" | "provenance" | "readiness";

const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "evidence", label: "Evidence" },
  { key: "trades", label: "Trades" },
  { key: "provenance", label: "Provenance" },
  { key: "readiness", label: "Learning readiness" },
];

const VIEW_TAB_BASE =
  "tw:cursor-pointer tw:rounded-[7px] tw:border tw:px-3 tw:py-2 tw:font-sans tw:text-[0.74rem] tw:font-[650] tw:hover:text-ink-50";
const VIEW_TAB_TONES: Record<string, string> = {
  idle: "tw:border-transparent tw:bg-transparent tw:text-ink-300",
  active: "tw:border-line-accent tw:bg-surface-raised tw:text-ink-50",
};

const EMPTY_COMPACT =
  "empty compact tw:p-[25px] tw:text-center tw:text-ink-700";

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
            {run.dataSource === "HISTORICAL_ARCHIVE" ? " · archive" : ""}
            {run.supersedesBacktestRunId ? " · replacement" : ""}
          </small>
        </button>
        <span className={badge(executionTone(run))}>{executionLabel(run)}</span>
        <span className={badge(evidenceTone(run))}>{evidenceLabel(run)}</span>
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
}: {
  run: BacktestRun;
  work?: BacktestAutomationWork;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
}) {
  const warnings = collectWarnings(run);
  return (
    <Panel
      as="section"
      className="result-detail tw:mb-4"
      aria-label="Selected result"
    >
      <PanelHeader
        title={`${run.startDate} → ${run.endDate}`}
        description={
          <>
            {executionLabel(run)} · {evidenceLabel(run)}
            {work
              ? ` · ${TRIGGER_ORIGIN_LABELS[work.triggerOrigin] ?? work.triggerOrigin}`
              : ""}
          </>
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
                      {trade.sampledExcursion.status === "UNAVAILABLE"
                        ? trade.sampledExcursion.reasonCodes.join(", ")
                        : `${trade.sampledExcursion.adversePct?.toFixed(2)}% adverse / ${trade.sampledExcursion.favorablePct?.toFixed(2)}% favorable${trade.sampledExcursion.status === "INDICATIVE" ? " (unverified coverage)" : ""}`}
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
      {tab === "readiness" && (
        <StrategyLearningReadinessPanel
          scope={null}
          runContext={{
            runId: run.id,
            marketId: run.marketId,
            status: run.status,
            strategies: run.strategies,
          }}
        />
      )}
    </Panel>
  );
}

function money(value: number, signed = false): string {
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function clock(value: string | null): string {
  return value
    ? new Date(value).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}

/** Plain-language reason a result is or is not validated. */
function verdict(run: BacktestRun): string {
  if (run.status !== "COMPLETED")
    return run.error ?? `${executionLabel(run)}; no result was recorded.`;
  const evidence = run.evidence;
  if (!evidence) return "No evidence assessment was recorded for this run.";
  if (evidence.qualification === "EVIDENCE_QUALIFIED")
    return "Evidence qualified: the sample and expectancy range gates pass.";
  const reasons = [
    !evidence.adequateSamples &&
      `the sample or one of its slices is below ${evidence.minimumTradesPerSlice} trades`,
    !evidence.positiveExpectancyRange &&
      "the 95% expectancy range does not stay above zero",
  ].filter(Boolean);
  return reasons.length
    ? `Not validated: ${reasons.join(" and ")}.`
    : "Exploratory: not validated for promotion.";
}

const QUICK_BOX =
  "tw:rounded-[10px] tw:border tw:border-line-subtle tw:bg-surface-sunken tw:px-4 tw:py-[14px]";
const QUICK_VALUE =
  "tw:m-0 tw:mt-[7px] tw:text-[1.05rem] tw:font-semibold tw:text-ink-50";
const QUICK_HINT = "tw:m-0 tw:mt-[3px] tw:text-[0.75rem] tw:text-ink-400";

/** Expectancy with its bootstrap range on an axis that always includes zero,
 * so a range crossing zero is visible at a glance. */
function ExpectancyRange({ run }: { run: BacktestRun }) {
  const expectancy = run.evidence?.expectancy;
  if (
    !expectancy ||
    expectancy.lower === null ||
    expectancy.upper === null ||
    expectancy.estimate === null
  )
    return <p className={QUICK_HINT}>No confidence range recorded.</p>;
  const range = {
    lower: expectancy.lower,
    upper: expectancy.upper,
    estimate: expectancy.estimate,
  };
  const low = Math.min(range.lower, 0);
  const high = Math.max(range.upper, 0);
  const span = high - low || 1;
  const at = (value: number) => `${((value - low) / span) * 100}%`;
  return (
    <>
      <div
        className="tw:relative tw:mt-3 tw:h-[22px]"
        role="img"
        aria-label={`95% range ${money(range.lower)} to ${money(range.upper)}`}
      >
        <span className="tw:absolute tw:top-[10px] tw:right-0 tw:left-0 tw:h-[2px] tw:bg-line" />
        <span
          className="tw:absolute tw:top-[7px] tw:h-2 tw:rounded-[4px] tw:bg-accent/35"
          style={{
            left: at(range.lower),
            width: `${((range.upper - range.lower) / span) * 100}%`,
          }}
        />
        <span
          className="tw:absolute tw:top-[3px] tw:bottom-[3px] tw:w-px tw:bg-ink-400"
          style={{ left: at(0) }}
        />
        <span
          className="tw:absolute tw:top-1 tw:h-[14px] tw:w-[3px] tw:-translate-x-1/2 tw:rounded-[2px] tw:bg-accent"
          style={{ left: at(range.estimate) }}
        />
      </div>
      <div className="tw:flex tw:justify-between tw:font-mono tw:text-[0.7rem] tw:text-ink-400">
        <span>{money(range.lower)}</span>
        <span>{money(range.upper)}</span>
      </div>
    </>
  );
}

function ResultQuickLook({
  run,
  onOpenFull,
}: {
  run: BacktestRun;
  onOpenFull: () => void;
}) {
  const metrics = run.metrics;
  const warnings = collectWarnings(run);
  return (
    <div className="tw:grid tw:gap-[14px]">
      {metrics && (
        <div className="tw:grid tw:grid-cols-[1.4fr_1fr_1fr_1fr] tw:gap-[14px] tw:below-1000:grid-cols-[1fr_1fr] tw:below-620:grid-cols-[1fr]">
          <div className={QUICK_BOX}>
            <div className={LABEL}>Expectancy per trade · 95% range</div>
            <p className={QUICK_VALUE}>
              {money(run.evidence?.expectancy.estimate ?? metrics.expectancy)}
            </p>
            <ExpectancyRange run={run} />
          </div>
          <div className={QUICK_BOX}>
            <div className={LABEL}>Max drawdown</div>
            <p className={classes(QUICK_VALUE, "tw:text-danger")}>
              {money(-Math.abs(metrics.maximumDrawdown))}
            </p>
            <p className={QUICK_HINT}>
              {metrics.maximumDrawdownPct.toFixed(2)}% of capital
            </p>
          </div>
          <div className={QUICK_BOX}>
            <div className={LABEL}>Avg win / loss</div>
            <p className={QUICK_VALUE}>
              {money(metrics.averageWin)} /{" "}
              {money(Math.abs(metrics.averageLoss))}
            </p>
            <p className={QUICK_HINT}>
              {metrics.wins} wins · {metrics.losses} losses
            </p>
          </div>
          <div className={QUICK_BOX}>
            <div className={LABEL}>Signals → trades</div>
            <p className={QUICK_VALUE}>
              {metrics.readySignals} → {metrics.tradesSimulated}
            </p>
            <p className={QUICK_HINT}>
              {metrics.averageHoldMinutes.toFixed(0)} min average hold
            </p>
          </div>
        </div>
      )}
      <div className="tw:flex tw:flex-wrap tw:items-baseline tw:justify-between tw:gap-3 tw:text-[0.8rem] tw:text-ink-300">
        <span>
          {verdict(run)}
          {warnings.length
            ? ` ${warnings.length} ${warnings.length === 1 ? "limitation" : "limitations"} recorded.`
            : ""}
        </span>
        <button type="button" className={LINK_BUTTON} onClick={onOpenFull}>
          Open full result →
        </button>
      </div>
    </div>
  );
}

const TH =
  "tw:whitespace-nowrap tw:border-b tw:border-line tw:px-4 tw:py-[13px] tw:first:pl-[22px] tw:last:pr-[22px] tw:font-sans tw:text-[0.68rem] tw:font-semibold tw:tracking-[0.08em] tw:uppercase tw:text-ink-500";
const TD =
  "tw:border-b tw:border-line-subtle tw:px-4 tw:py-[14px] tw:first:pl-[22px] tw:last:pr-[22px] tw:align-middle tw:text-[0.84rem] tw:text-ink-200";
/* Secondary columns hidden on phones; the expanded quick look carries them. */
const NARROW_HIDDEN = "tw:below-md:hidden";
const NUM =
  "tw:whitespace-nowrap tw:font-mono tw:text-[0.8rem] tw:tabular-nums";

/** Net result of a run that simulated at least one trade; null otherwise. */
function tradedNetPnl(run: BacktestRun): number | null {
  return run.metrics?.tradesSimulated ? run.metrics.netPnl : null;
}

function compareNetPnl(left: BacktestRun, right: BacktestRun): number {
  const a = tradedNetPnl(left);
  const b = tradedNetPnl(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Latest result per strategy, best net result first. A row expands in place
 * to a quick look; the full tabs open in a drawer. */
function ResultsTable({
  groups,
  rerunning,
  expanded,
  onToggle,
  onOpenFull,
}: {
  groups: BacktestResultGroup[];
  rerunning: ReadonlySet<string>;
  expanded: string | null;
  onToggle: (key: string) => void;
  onOpenFull: (run: BacktestRun) => void;
}) {
  const rows = [...groups].sort((left, right) =>
    compareNetPnl(left.latest, right.latest),
  );
  const scale = Math.max(
    1,
    ...rows.map((group) => Math.abs(group.latest.metrics?.netPnl ?? 0)),
  );
  return (
    <div className="tw:overflow-x-auto">
      <table className="tw:w-full tw:min-w-[760px] tw:border-collapse tw:below-md:min-w-0">
        <thead>
          <tr>
            <th className={classes(TH, "tw:text-left")}>Strategy</th>
            <th className={classes(TH, "tw:text-left", NARROW_HIDDEN)}>
              Sample
            </th>
            <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
              Win rate
            </th>
            <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
              Profit factor
            </th>
            <th className={classes(TH, "tw:text-right")}>Net P&amp;L</th>
            <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
              Evidence
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((group) => {
            const run = group.latest;
            const metrics = run.metrics;
            const trades = metrics?.tradesSimulated ?? null;
            const minimum = run.evidence?.minimumTradesPerSlice ?? null;
            const netPnl = metrics?.netPnl ?? null;
            const open = expanded === group.key;
            const completed = run.status === "COMPLETED";
            return (
              <Fragment key={group.key}>
                <tr
                  className={classes(
                    "result-row",
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
                      onClick={() => onToggle(group.key)}
                    >
                      <strong className="tw:whitespace-nowrap tw:text-[0.88rem] tw:below-md:whitespace-normal tw:font-semibold tw:text-ink-50">
                        {group.title}
                      </strong>
                      <small className="tw:text-[0.74rem] tw:text-ink-500">
                        updated {clock(run.completedAt ?? run.createdAt)}
                        {rerunning.has(group.title) ? " · rerunning now" : ""}
                        <span className="tw:hidden tw:below-md:inline">
                          {" · "}
                          {completed ? evidenceLabel(run) : executionLabel(run)}
                        </span>
                      </small>
                    </button>
                  </td>
                  <td className={classes(TD, NARROW_HIDDEN)}>
                    {trades === null ? (
                      <span className="tw:text-ink-500">—</span>
                    ) : (
                      <span className="tw:flex tw:items-center tw:gap-[10px]">
                        {minimum !== null && (
                          <span
                            className="tw:h-[6px] tw:w-[72px] tw:shrink-0 tw:overflow-hidden tw:rounded-full tw:bg-surface-sunken"
                            aria-hidden="true"
                          >
                            <span
                              className={classes(
                                "tw:block tw:h-full tw:rounded-full",
                                trades >= minimum
                                  ? "tw:bg-gain"
                                  : "tw:bg-ink-400",
                              )}
                              style={{
                                width: `${Math.min(100, (trades / minimum) * 100)}%`,
                              }}
                            />
                          </span>
                        )}
                        <span className={classes(NUM, "tw:text-ink-300")}>
                          {minimum !== null
                            ? `${trades} / ${minimum}`
                            : `${trades} trades`}
                        </span>
                      </span>
                    )}
                  </td>
                  <td
                    className={classes(TD, NUM, "tw:text-right", NARROW_HIDDEN)}
                  >
                    {metrics && trades ? `${metrics.winRate.toFixed(0)}%` : "—"}
                  </td>
                  <td
                    className={classes(TD, NUM, "tw:text-right", NARROW_HIDDEN)}
                  >
                    {metrics?.profitFactor != null
                      ? metrics.profitFactor.toFixed(2)
                      : "—"}
                  </td>
                  <td className={classes(TD, "tw:text-right")}>
                    <span className="tw:flex tw:items-center tw:justify-end tw:gap-3">
                      <span
                        className="tw:relative tw:h-[6px] tw:w-[80px] tw:shrink-0 tw:below-1100:hidden"
                        aria-hidden="true"
                      >
                        <span className="tw:absolute tw:-top-[3px] tw:-bottom-[3px] tw:left-1/2 tw:w-px tw:bg-line" />
                        {netPnl !== null && netPnl !== 0 && (
                          <span
                            className={classes(
                              "tw:absolute tw:top-0 tw:h-full tw:rounded-[3px]",
                              netPnl > 0
                                ? "tw:left-1/2 tw:bg-gain"
                                : "tw:right-1/2 tw:bg-danger",
                            )}
                            style={{
                              width: `${(Math.abs(netPnl) / scale) * 50}%`,
                            }}
                          />
                        )}
                      </span>
                      <span
                        className={classes(
                          NUM,
                          "tw:min-w-[76px]",
                          netPnl === null || !trades
                            ? "tw:text-ink-500"
                            : netPnl > 0
                              ? "tw:text-gain"
                              : netPnl < 0
                                ? "tw:text-danger"
                                : "tw:text-ink-300",
                        )}
                      >
                        {netPnl === null
                          ? "—"
                          : trades
                            ? money(netPnl, true)
                            : "no trades"}
                      </span>
                    </span>
                  </td>
                  <td className={classes(TD, "tw:text-right", NARROW_HIDDEN)}>
                    <span
                      className={badge(
                        completed ? evidenceTone(run) : executionTone(run),
                      )}
                    >
                      {completed ? evidenceLabel(run) : executionLabel(run)}
                    </span>
                  </td>
                </tr>
                {open && (
                  <tr className="tw:bg-surface-raised">
                    <td
                      colSpan={6}
                      className="tw:border-b tw:border-line tw:px-[22px] tw:pt-1 tw:pb-5 tw:shadow-[inset_3px_0_0_var(--accent)]"
                    >
                      <ResultQuickLook
                        run={run}
                        onOpenFull={() => onOpenFull(run)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type DrawerKey =
  | "result"
  | "history"
  | "manual"
  | "settings"
  | "diagnostics"
  | "tools"
  | "imports";

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
    [symbols, setSymbols] = useState(""),
    [dataSourceChoice, setDataSource] =
      useState<BacktestDataSource>("CAPTURED_QUOTES");
  // The archive covers US equities only (ADR-019).
  const dataSource: BacktestDataSource =
    marketId === "US_EQUITIES" ? dataSourceChoice : "CAPTURED_QUOTES";
  const archive = dataSource === "HISTORICAL_ARCHIVE";
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
    [expanded, setExpanded] = useState<string | null>(null),
    [comparisonIds, setComparisonIds] = useState<string[]>([]),
    [comparison, setComparison] = useState<BacktestComparison>(),
    [error, setError] = useState(""),
    [running, setRunning] = useState(false),
    [drawer, setDrawer] = useState<DrawerKey | null>(null),
    [detailTab, setDetailTab] = useState<DetailTab>("summary"),
    [job, setJob] = useState<ResearchJob>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const manualOpen = drawer === "manual";
  useCapturedHistoryFormGuard(
    startDate,
    endDate,
    marketId,
    manualOpen,
    dataSource,
  );
  const refreshRuns = async () => {
    try {
      const value = backtestRunListSchema.parse(
        await getJson("/api/backtests?limit=100"),
      );
      updateRuns(value.runs.filter((run) => run.marketId === marketId));
    } catch {
      // The automation status stays visible; a failed run reload leaves the
      // existing list in place instead of clearing it.
    }
  };
  const automation = useBacktestAutomation(marketId, () => void refreshRuns());
  const resultGroups = useMemo(() => groupBacktestResults(runs), [runs]);
  const qualified = resultGroups.filter(
    (group) => group.latest.evidence?.qualification === "EVIDENCE_QUALIFIED",
  ).length;
  const rerunning = useMemo(
    () =>
      new Set(
        [...automation.groups.running, ...automation.groups.queued].flatMap(
          (entry) => (entry.work.configName ? [entry.work.configName] : []),
        ),
      ),
    [automation.groups],
  );
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
        (automation.status?.works ?? []).flatMap((work) =>
          work.runId ? [[work.runId, work] as const] : [],
        ),
      ),
    [automation.status],
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
          dataSource,
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
        setDrawer("result");
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
      setDrawer("result");
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
  const manualForm = (
    <form className="backtest-form" onSubmit={(event) => void create(event)}>
      <PanelHeader
        title="New historical replay"
        description={
          archive
            ? "Archived provider history · exploratory · same live feature and strategy logic"
            : "Captured quotes only · same live feature and strategy logic"
        }
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
        {marketId === "US_EQUITIES" && (
          <label className={FIELD_LABEL}>
            Data source
            <select
              className={FIELD_CONTROL}
              value={dataSource}
              onChange={(e) =>
                setDataSource(e.target.value as BacktestDataSource)
              }
            >
              <option value="CAPTURED_QUOTES">Captured Questrade quotes</option>
              <option value="HISTORICAL_ARCHIVE">
                Historical archive (exploratory)
              </option>
            </select>
          </label>
        )}
        <label className={FIELD_LABEL}>
          Symbols{" "}
          <small className="tw:font-medium tw:tracking-normal">
            {archive
              ? "required · archived symbols"
              : "blank = active universe"}
          </small>
          <input
            className={FIELD_CONTROL}
            value={symbols}
            required={archive}
            onChange={(e) => setSymbols(e.target.value)}
            placeholder={archive ? "COIN, OKTA" : "BTO.TO, BAM.TO"}
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
      <div className="tw:-mt-3 tw:mb-7 tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
        <AutomationStatusLine automation={automation} />
        <div className="tw:flex tw:items-center tw:gap-[10px]">
          <CheckForWorkButton automation={automation} />
          <MoreMenu
            label="More backtest tools"
            items={[
              { label: "Run history", onSelect: () => setDrawer("history") },
              { label: "Manual replay", onSelect: () => setDrawer("manual") },
              {
                label: "Import progress",
                onSelect: () => setDrawer("imports"),
              },
              {
                label: "Automation settings",
                onSelect: () => setDrawer("settings"),
              },
              {
                label: "Diagnostics",
                onSelect: () => setDrawer("diagnostics"),
              },
              {
                label: "Studies & funded replay",
                onSelect: () => setDrawer("tools"),
              },
            ]}
          />
        </div>
      </div>
      {automation.error && <p className="error-banner">{automation.error}</p>}
      {error && <p className="error-banner">{error}</p>}
      <NowRunning automation={automation} />
      <AutomationEvidence
        automation={automation}
        qualified={qualified}
        results={resultGroups.length}
        onOpenDiagnostics={() => setDrawer("diagnostics")}
        onOpenSettings={() => setDrawer("settings")}
        onOpenUniverse={onOpenUniverse}
      />
      <section className="tw:mb-4" aria-label="Results">
        <SectionHead title="Results">
          Latest replay per strategy · slippage and fees included
        </SectionHead>
        <div className={CARD}>
          {resultGroups.length ? (
            <ResultsTable
              groups={resultGroups}
              rerunning={rerunning}
              expanded={expanded}
              onToggle={(key) =>
                setExpanded((current) => (current === key ? null : key))
              }
              onOpenFull={(run) => void open(run)}
            />
          ) : (
            <p className="tw:m-0 tw:px-[22px] tw:py-6 tw:text-center tw:text-[0.84rem] tw:text-ink-400">
              No backtest results yet.
            </p>
          )}
        </div>
      </section>
      <p className="tw:m-0 tw:mb-6 tw:flex tw:flex-wrap tw:justify-between tw:gap-3 tw:text-[0.75rem] tw:text-ink-500">
        <span>
          Simulated on captured quotes · nothing here activates a strategy
        </span>
        <button
          type="button"
          className={LINK_BUTTON}
          onClick={() => setDrawer("history")}
        >
          All {historyRuns.length} attempts
        </button>
      </p>
      <Drawer
        open={drawer === "result" && Boolean(selected)}
        onClose={() => setDrawer(null)}
        title={selected ? runDisplayName(selected) : "Result"}
        size="wide"
      >
        {selected && (
          <ResultDetail
            run={selected}
            work={selectedWork}
            tab={detailTab}
            onTabChange={setDetailTab}
          />
        )}
      </Drawer>
      <Drawer
        open={drawer === "history"}
        onClose={() => setDrawer(null)}
        title="Run history"
        size="wide"
      >
        <div className="tw:mb-3 tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
          <p className="tw:m-0 tw:text-[0.78rem] tw:text-ink-350">
            {historyRuns.length} attempts, including superseded runs and
            failures. Select two or more to compare.
          </p>
          <Button
            variant="primary"
            disabled={comparisonIds.length < 2}
            onClick={() => void compare()}
          >
            COMPARE · {comparisonIds.length}
          </Button>
        </div>
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
        {historyRuns.length > 0 ? (
          <div
            className="history-scroll-container"
            role="region"
            aria-label="Run history list"
          >
            {historyRuns.map((run) => (
              <div
                className="tw:grid tw:grid-cols-[20px_minmax(0,1fr)] tw:items-start tw:gap-2"
                key={run.id}
              >
                <input
                  type="checkbox"
                  className="tw:mt-[17px]"
                  checked={comparisonIds.includes(run.id)}
                  onChange={() => toggle(run.id)}
                  aria-label={`Compare ${run.name}`}
                />
                <HistoryRow
                  run={run}
                  work={workByRunId.get(run.id)}
                  selected={selected?.id === run.id}
                  onOpen={() => void open(run)}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">No backtest runs recorded yet.</div>
        )}
      </Drawer>
      <Drawer
        open={drawer === "manual"}
        onClose={() => setDrawer(null)}
        title="Manual replay"
      >
        {manualForm}
      </Drawer>
      <Drawer
        open={drawer === "settings"}
        onClose={() => setDrawer(null)}
        title="Automation settings"
      >
        <AutomationSettings automation={automation} />
      </Drawer>
      <Drawer
        open={drawer === "imports"}
        onClose={() => setDrawer(null)}
        title="Historical import progress"
        size="wide"
      >
        {drawer === "imports" && <HistoricalImportProgress />}
      </Drawer>
      <Drawer
        open={drawer === "diagnostics"}
        onClose={() => setDrawer(null)}
        title="Automation diagnostics"
        size="wide"
      >
        <AutomationDiagnostics automation={automation} />
      </Drawer>
      <Drawer
        open={drawer === "tools"}
        onClose={() => setDrawer(null)}
        title="Studies & funded replay"
        size="wide"
      >
        <SignalModelResearchStatusPanel marketId={marketId} />
        <details className="backtest-collapsible tw:border-b tw:border-line-subtle">
          <summary className="tw:cursor-pointer tw:px-2 tw:py-3 tw:text-[0.82rem] tw:font-semibold tw:text-ink-150">
            Study authorization &amp; frozen plan (expert)
          </summary>
          <StrategyStudyPanel marketId={marketId} />
        </details>
        <details className="backtest-collapsible">
          <summary className="tw:cursor-pointer tw:px-2 tw:py-3 tw:text-[0.82rem] tw:font-semibold tw:text-ink-150">
            Funded portfolio replay
          </summary>
          <FundedReplayPanel marketId={marketId} />
        </details>
      </Drawer>
    </>
  );
}
