import {
  fundedLiveAccountResponseSchema,
  paperBotActivityListSchema,
  paperBotRunListSchema,
  paperCohortAggregateListSchema,
  paperCohortCurveListSchema,
  paperCoordinationDecisionListSchema,
  paperCoordinationSummarySchema,
  paperEvidenceComparisonListSchema,
  paperModelDivergenceListSchema,
  paperProfileQualificationListSchema,
  type FundedLiveAccount,
  type PaperBotActivity,
  type PaperBotRun,
  type PaperCohortAggregate,
  type PaperCoordinationDecision,
  type PaperCoordinationSummary,
  type PaperEvidenceFilters,
  type PaperProfileQualification,
} from "@tsx-scanner/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { countdown } from "../lib/format.js";
import { useNow } from "../lib/use-now.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";
import type { PaperBotStatus } from "../types.js";
import { Tip } from "../ui.js";
import {
  BotLivenessDiagnostics,
  BotLivenessPanel,
} from "./BotLivenessPanel.js";

type DashboardFilters = Pick<
  PaperEvidenceFilters,
  "profileConfigId" | "executionModelVersion" | "startDate" | "endDate"
>;

type BotSection = "overview" | "results" | "diagnostics";

type GlanceProjection = "FUNDED" | "COORDINATED";

const botSections: ReadonlyArray<{ value: BotSection; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "results", label: "Results" },
  { value: "diagnostics", label: "Diagnostics" },
];

/**
 * The funded paper account is the default bot-activity reading: it is the
 * only projection with real cash and reservations. The coordinated shadow
 * stays one click away and the two are never summed.
 */
const glanceProjections: ReadonlyArray<{
  value: GlanceProjection;
  label: string;
}> = [
  { value: "FUNDED", label: "Funded account" },
  { value: "COORDINATED", label: "Coordinated shadow" },
];

const emptyFilters: DashboardFilters = {
  profileConfigId: undefined,
  executionModelVersion: undefined,
  startDate: undefined,
  endDate: undefined,
};

/* Complete utility strings per variant. Tailwind detects classes statically,
 * and a variant must never leave one declaration to stylesheet order. */
const PAPER_BUTTON =
  "paper-button tw:cursor-pointer tw:rounded-[6px] tw:border tw:border-line-accent-mid tw:bg-surface-raised tw:px-[10px] tw:py-2 tw:font-mono tw:text-[0.6rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.06em] tw:text-accent tw:not-disabled:hover:bg-accent tw:not-disabled:hover:text-on-accent tw:disabled:cursor-default tw:disabled:opacity-45";

const BOT_DISCLOSURE =
  "bot-disclosure tw:inline-flex tw:cursor-pointer tw:items-center tw:gap-[9px] tw:border-0 tw:bg-none tw:bg-transparent tw:p-0 tw:text-left tw:text-inherit tw:[font:inherit] tw:[letter-spacing:inherit] tw:after:absolute tw:after:inset-0 tw:after:content-[''] tw:focus-visible:outline-1 tw:focus-visible:outline-line-accent tw:focus-visible:outline-offset-4 tw:before:h-0 tw:before:w-0 tw:before:content-[''] tw:before:[border-top:5px_solid_transparent] tw:before:[border-bottom:5px_solid_transparent] tw:before:[border-left:6px_solid_var(--ink-600)] tw:before:[transition:transform_120ms_ease]";
const BOT_DISCLOSURE_ARROW = "tw:before:[transform:rotate(90deg)]";
const BOT_DISCLOSURE_ARROW_COLLAPSED = "tw:before:[transform:none]";

const BOT_SECTION_BUTTON =
  "tw:cursor-pointer tw:rounded-[6px] tw:border tw:border-transparent tw:bg-none tw:bg-transparent tw:px-[14px] tw:py-[9px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.09em] tw:uppercase tw:text-ink-600 tw:hover:bg-surface-raised tw:hover:text-ink-150 tw:focus-visible:outline-1 tw:focus-visible:outline-line-accent tw:focus-visible:outline-offset-2";
const BOT_SECTION_BUTTON_PRESSED =
  "tw:aria-pressed:border-accent tw:aria-pressed:bg-accent tw:aria-pressed:text-on-accent";

const BOT_JOURNAL = "bot-journal tw:mx-0 tw:mt-[18px] tw:mb-4";
const BOT_JOURNAL_HEAD =
  "bot-journal-head tw:grid tw:gap-4 tw:px-5 tw:py-[18px]";
const BOT_TODAY_METRICS =
  "bot-today-metrics tw:grid tw:grid-cols-[repeat(7,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-[10px] tw:border tw:border-line tw:bg-surface-sunken tw:below-lg:grid-cols-[repeat(4,1fr)] tw:below-700:grid-cols-[repeat(2,1fr)]";
const BOT_METRICS =
  "bot-metrics tw:grid tw:grid-cols-[repeat(6,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-[10px] tw:border tw:border-line tw:bg-surface-sunken tw:below-700:grid-cols-[repeat(2,1fr)]";
const BOT_COHORT_METRICS =
  "bot-cohort-metrics tw:grid tw:grid-cols-[repeat(6,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-[10px] tw:border tw:border-line tw:bg-surface-sunken tw:below-700:grid-cols-[repeat(2,1fr)]";
const BOT_METRIC_CELL = "tw:grid tw:gap-[5px] tw:bg-surface tw:p-[15px]";
const BOT_METRIC_LABEL =
  "tw:font-mono tw:text-[0.56rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700";
const BOT_METRIC_VALUE = "tw:text-[1rem]";
const BOT_METRIC_NOTE = "tw:text-[0.62rem] tw:text-ink-600";

const BOT_SCROLL_AREA =
  "tw:max-h-[min(430px,52vh)] tw:overflow-y-auto tw:overscroll-contain tw:[scrollbar-gutter:stable]";
const BOT_CARD =
  "tw:rounded-[8px] tw:border tw:border-line-subtle tw:bg-surface-raised";

const BOT_ASSUMPTIONS =
  "bot-assumptions tw:m-0 tw:px-[15px] tw:py-[11px] tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:text-ink-650 tw:[overflow-wrap:anywhere]";
const BOT_ASSUMPTIONS_DETAIL =
  "bot-assumptions tw:m-0 tw:px-0 tw:pt-[9px] tw:pb-0 tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:text-ink-650 tw:[overflow-wrap:anywhere]";

const GLANCE_TONES: Record<string, string> = {
  positive: "tw:border-line-accent tw:bg-surface",
  flat: "tw:border-line tw:bg-surface",
  negative: "tw:border-line-danger-strong tw:bg-surface-danger",
};
const GLANCE_VALUE_TONES: Record<string, string> = {
  positive: "tw:text-accent",
  flat: "tw:text-ink-350",
  negative: "tw:text-danger",
};

const SESSION_BANNER_TONES: Record<string, string> = {
  idle: "tw:border-l-line-accent",
  running: "tw:border-l-line-accent",
  "close-pending": "tw:border-l-line-warn-strong",
  completed: "tw:border-l-accent",
  failed: "tw:border-l-line-danger-strong tw:bg-surface-danger",
};

const ACTIVITY_TONES: Record<string, string> = {
  info: "tw:bg-surface-raised tw:text-ink-500",
  success: "tw:bg-surface-raised tw:text-accent",
  warning: "tw:bg-surface-warn tw:text-warn",
  error: "tw:bg-surface-danger tw:text-danger-soft",
};
const BOT_ACTIVITY_LIST =
  "bot-activity-list tw:max-h-[min(420px,50vh)] tw:overflow-y-auto tw:overscroll-contain tw:[scrollbar-gutter:stable] tw:focus-visible:outline-1 tw:focus-visible:outline-line-accent tw:focus-visible:outline-offset-[-1px]";
const BOT_TODAY_ACTIVITY_LIST = classes(
  BOT_ACTIVITY_LIST,
  "tw:max-h-[min(560px,58vh)]",
);
const BOT_ACTIVITY_ROW =
  "bot-activity-row tw:grid tw:grid-cols-[132px_72px_minmax(0,1fr)] tw:items-start tw:gap-[14px] tw:border-b tw:border-b-line-subtle tw:px-5 tw:py-[13px] tw:below-700:grid-cols-[1fr_auto]";
const BOT_ACTIVITY_META =
  "tw:font-mono tw:text-[0.61rem] tw:font-normal tw:leading-[normal] tw:text-ink-650";

const BOT_FILTER_LABEL =
  "tw:grid tw:gap-[6px] tw:font-mono tw:text-[0.61rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-600";
const BOT_FILTER_CONTROL =
  "tw:w-full tw:min-h-[38px] tw:rounded-[6px] tw:border tw:border-line-input tw:bg-bg tw:px-[10px] tw:py-2 tw:text-ink-100";

function sessionDate(marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:
      marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function query(filters: PaperEvidenceFilters): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") parameters.set(key, value);
  }
  const value = parameters.toString();
  return value ? `?${value}` : "";
}

function rate(value: {
  numerator: number;
  denominator: number;
  value: number | null;
}): string {
  return value.value === null
    ? `— (${value.numerator}/${value.denominator})`
    : `${(value.value * 100).toFixed(1)}% (${value.numerator}/${value.denominator})`;
}

function number(value: number | null, digits = 2): string {
  return value === null ? "—" : value.toFixed(digits);
}

/** Signed so a glance separates a losing session from a winning one. */
function signed(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}

function money(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.005)
    return `${value >= 0 ? "+" : "−"}<$0.01`;
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
}

function duration(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function cohorts(values: PaperCohortAggregate[]): PaperCohortAggregate[] {
  return values.filter((value) => value.model === "QUOTE");
}

function aggregateCount(
  values: PaperCohortAggregate[],
  key: keyof Pick<
    PaperCohortAggregate,
    | "signalCount"
    | "fills"
    | "noFills"
    | "rejectedEconomics"
    | "openExecutions"
    | "closePendingExecutions"
  >,
): number {
  return values.reduce((total, value) => total + value[key], 0);
}

function distribution(
  values: Record<string, number>,
  denominator: number,
): string {
  const entries = Object.entries(values);
  return entries.length === 0
    ? "None"
    : entries
        .map(
          ([key, count]) =>
            `${key.replaceAll("_", " ")} ${count}/${denominator}`,
        )
        .join(" · ");
}

function activityTimestamp(
  value: string,
  marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:
      marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

/** Plain-language reading of the authoritative today-run status. */
const sessionStatusHeadline: Record<PaperBotRun["status"], string> = {
  RUNNING: "Collecting now",
  CLOSE_PENDING: "Waiting for valid exit quotes",
  COMPLETED: "Session finished",
  FAILED: "Needs attention",
};

function sessionStatusDetail(run: PaperBotRun): string {
  switch (run.status) {
    case "RUNNING":
      return "Live scanner signals are being processed into independent paper evidence.";
    case "CLOSE_PENDING":
      return "Exits are queued and settle when an actionable close quote arrives.";
    case "COMPLETED":
      return "Today’s collection and modeling are complete; retained results remain available.";
    case "FAILED":
      return "The live run reported a failure; the recorded reason is shown below.";
  }
}

const collapseStorageKey = "tsx-scanner-bot-collapsed";

function collapseState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(collapseStorageKey);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

/** Remembers each panel's fold so a trimmed-down layout survives a reload. */
function useCollapsed(id: string, initial: boolean) {
  const [collapsed, setCollapsed] = useState(
    () => collapseState()[id] ?? initial,
  );
  const toggle = () =>
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(
          collapseStorageKey,
          JSON.stringify({ ...collapseState(), [id]: next }),
        );
      } catch {
        // Unavailable storage must not stop the panel from folding.
      }
      return next;
    });
  return [collapsed, toggle] as const;
}

/**
 * Panel chrome for this view. The title row doubles as a disclosure control
 * because these evidence panels stack into far more vertical space than one
 * screen holds; bodies are height-capped with utilities so an unbounded cohort
 * or decision list scrolls inside its own panel instead of pushing the page
 * down.
 */
function BotPanel({
  id,
  title,
  lede,
  badge,
  action,
  className,
  collapsedByDefault = false,
  children,
}: {
  id: string;
  title: string;
  lede: string;
  badge?: string;
  action?: ReactNode;
  className: string;
  collapsedByDefault?: boolean;
  children: ReactNode;
}) {
  const [collapsed, toggle] = useCollapsed(id, collapsedByDefault);
  const bodyId = `bot-panel-${id}`;
  return (
    <section
      className={classes(className, "bot-panel", collapsed && "collapsed")}
    >
      <div
        className={classes(
          "panel-title tw:relative",
          collapsed && "tw:border-b-0",
        )}
      >
        <div>
          <h3>
            <button
              aria-controls={bodyId}
              aria-expanded={!collapsed}
              className={classes(
                BOT_DISCLOSURE,
                collapsed
                  ? BOT_DISCLOSURE_ARROW_COLLAPSED
                  : BOT_DISCLOSURE_ARROW,
              )}
              onClick={toggle}
              type="button"
            >
              {title}
            </button>
          </h3>
          <p>{lede}</p>
        </div>
        {action ??
          (badge === undefined ? null : (
            <span className="tw:relative tw:z-[1]">{badge}</span>
          ))}
      </div>
      <div className="bot-panel-body" hidden={collapsed} id={bodyId}>
        {children}
      </div>
    </section>
  );
}

/**
 * The authoritative today-run record in plain language, rendered inside the
 * today activity panel under its journal header. Only the stable headline sits
 * inside the live region: the scheduled-close countdown ticks every second and
 * would otherwise re-announce the strip constantly.
 */
function SessionStatus({
  run,
  loading,
  marketId = "CA_TSX",
}: {
  run: PaperBotRun | null;
  loading: boolean;
  marketId?: "CA_TSX" | "US_EQUITIES";
}) {
  const now = useNow();
  const active = run?.status === "RUNNING" || run?.status === "CLOSE_PENDING";
  const closeCountdown = active ? countdown(now, run.scheduledCloseAt) : null;
  const headline =
    run === null
      ? loading
        ? "Checking today’s session…"
        : "No run today"
      : sessionStatusHeadline[run.status];
  const detail =
    run === null
      ? loading
        ? "Loading the authoritative run record for today."
        : "No live paper-bot run has started today. The next session opens automatically."
      : sessionStatusDetail(run);
  const tone =
    run === null ? "idle" : run.status.toLowerCase().replace("_", "-");
  return (
    <section
      aria-label="Session status"
      className={classes(
        "bot-session tw:border-t tw:border-t-line-subtle tw:border-l-[3px]",
        SESSION_BANNER_TONES[tone],
      )}
    >
      <div
        className="bot-session-headline tw:grid tw:gap-[6px] tw:px-5 tw:pt-4 tw:pb-[13px]"
        role="status"
      >
        <span className="tw:font-mono tw:text-[0.6rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.1em] tw:text-ink-700">
          TODAY’S SESSION · {sessionDate(marketId)}
        </span>
        <strong
          className={classes(
            "tw:text-[1.05rem]",
            tone === "failed" ? "tw:text-danger-soft" : "tw:text-ink-100",
          )}
        >
          {headline}
        </strong>
        <p className="tw:m-0 tw:max-w-[68ch] tw:text-[0.78rem] tw:leading-[1.5] tw:text-ink-550">
          {detail}
        </p>
      </div>
      <dl className="bot-session-facts tw:m-0 tw:grid tw:grid-cols-[repeat(auto-fit,minmax(170px,1fr))] tw:gap-px tw:border-t tw:border-t-line-subtle tw:bg-line-subtle tw:below-700:grid-cols-[repeat(2,1fr)]">
        <div className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-5 tw:py-3">
          <dt className="tw:font-mono tw:text-[0.56rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:uppercase tw:text-ink-700">
            Started
          </dt>
          <dd className="tw:m-0 tw:font-mono tw:text-[0.72rem] tw:font-[650] tw:leading-[normal] tw:tabular-nums tw:text-ink-150">
            {run === null ? "—" : activityTimestamp(run.startedAt, marketId)}
          </dd>
        </div>
        <div className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-5 tw:py-3">
          <dt className="tw:font-mono tw:text-[0.56rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:uppercase tw:text-ink-700">
            Next automatic action
          </dt>
          <dd className="tw:m-0 tw:font-mono tw:text-[0.72rem] tw:font-[650] tw:leading-[normal] tw:tabular-nums tw:text-ink-150">
            {active
              ? `Session closes ${closeCountdown ?? "at the scheduled close"}`
              : "Next session opens automatically"}
          </dd>
        </div>
        <div className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-5 tw:py-3">
          <dt className="tw:font-mono tw:text-[0.56rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:uppercase tw:text-ink-700">
            Scheduled close
          </dt>
          <dd className="tw:m-0 tw:font-mono tw:text-[0.72rem] tw:font-[650] tw:leading-[normal] tw:tabular-nums tw:text-ink-150">
            {run === null
              ? "—"
              : `${activityTimestamp(run.scheduledCloseAt, marketId)}${
                  active && closeCountdown ? ` · ${closeCountdown}` : ""
                }`}
          </dd>
        </div>
        <div className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-5 tw:py-3">
          <dt className="tw:font-mono tw:text-[0.56rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:uppercase tw:text-ink-700">
            Execution model
          </dt>
          <dd className="tw:m-0 tw:font-mono tw:text-[0.72rem] tw:font-[650] tw:leading-[normal] tw:tabular-nums tw:text-ink-150">
            {run?.executionModelVersion ?? "—"}
          </dd>
        </div>
        {run?.completedAt === null || run?.completedAt === undefined ? null : (
          <div className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-5 tw:py-3">
            <dt className="tw:font-mono tw:text-[0.56rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:uppercase tw:text-ink-700">
              Completed
            </dt>
            <dd className="tw:m-0 tw:font-mono tw:text-[0.72rem] tw:font-[650] tw:leading-[normal] tw:tabular-nums tw:text-ink-150">
              {activityTimestamp(run.completedAt, marketId)}
            </dd>
          </div>
        )}
        {run?.failedAt === null || run?.failedAt === undefined ? null : (
          <div className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-5 tw:py-3">
            <dt className="tw:font-mono tw:text-[0.56rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:uppercase tw:text-ink-700">
              Failed
            </dt>
            <dd className="tw:m-0 tw:font-mono tw:text-[0.72rem] tw:font-[650] tw:leading-[normal] tw:tabular-nums tw:text-ink-150">
              {activityTimestamp(run.failedAt, marketId)}
            </dd>
          </div>
        )}
      </dl>
      {run?.failureReason ? (
        <p className="bot-session-failure tw:m-0 tw:border-t tw:border-t-line-danger-strong tw:bg-surface-danger tw:px-5 tw:py-[11px] tw:text-[0.74rem] tw:text-danger-tint-pale">
          Failure · {run.failureReason}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The first surface of the page: today's journal with the coordinated session
 * result in its header. The feed is deliberately scoped to the current session
 * so the page opens on "what is the bot doing right now" without the reader
 * having to parse retained history; Diagnostics keeps the complete journal
 * with raw identifiers for audit.
 */
function TodayActivityPanel({
  run,
  summary,
  funded,
  fundedUnavailable,
  glanceProjection,
  onGlanceProjection,
  independentOpen,
  activities,
  activityLoading,
  activityError,
  loading,
  marketId = "CA_TSX",
}: {
  run: PaperBotRun | null;
  summary: PaperCoordinationSummary | null;
  funded: FundedLiveAccount | null;
  fundedUnavailable: boolean;
  glanceProjection: GlanceProjection;
  onGlanceProjection: (projection: GlanceProjection) => void;
  independentOpen: number;
  activities: PaperBotActivity[];
  activityLoading: boolean;
  activityError: string;
  loading: boolean;
  marketId?: "CA_TSX" | "US_EQUITIES";
}) {
  const [collapsed, toggle] = useCollapsed("today-activity", false);
  const bodyId = "bot-panel-today-activity";
  const eventCount =
    activityLoading && activities.length === 0
      ? "Loading events…"
      : `${activities.length} event${activities.length === 1 ? "" : "s"} today`;
  return (
    <section
      aria-label="Today’s bot activity"
      className={classes(BOT_JOURNAL, "panel", collapsed && "collapsed")}
    >
      <div className={BOT_JOURNAL_HEAD}>
        <div className="tw:relative tw:flex tw:flex-wrap tw:items-baseline tw:gap-x-5 tw:gap-y-[6px]">
          <h3 className="tw:m-0 tw:text-[1rem] tw:tracking-[-0.01em] tw:text-ink-100">
            <button
              aria-controls={bodyId}
              aria-expanded={!collapsed}
              className={classes(
                BOT_DISCLOSURE,
                collapsed
                  ? BOT_DISCLOSURE_ARROW_COLLAPSED
                  : BOT_DISCLOSURE_ARROW,
              )}
              onClick={toggle}
              type="button"
            >
              Today’s bot activity journal
            </button>
          </h3>
          <p className="tw:m-0 tw:min-w-[260px] tw:flex-1 tw:text-[0.76rem] tw:leading-[1.5] tw:text-ink-550">
            Live run, signal, fill and exit events · {eventCount} · refreshes
            every ten seconds. The full retained journal with raw identifiers is
            in Diagnostics.
          </p>
          <div
            aria-label="Bot activity projection"
            className="tw:relative tw:z-[1] tw:ml-auto tw:inline-flex tw:shrink-0 tw:gap-[4px] tw:rounded-[6px] tw:border tw:border-line tw:bg-surface-sunken tw:p-[4px]"
            role="group"
          >
            {glanceProjections.map((entry) => (
              <button
                aria-pressed={glanceProjection === entry.value}
                className={classes(
                  BOT_SECTION_BUTTON,
                  glanceProjection === entry.value &&
                    BOT_SECTION_BUTTON_PRESSED,
                )}
                key={entry.value}
                onClick={() => onGlanceProjection(entry.value)}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        {glanceProjection === "FUNDED" ? (
          <FundedGlance
            funded={funded}
            loading={loading}
            marketId={marketId}
            unavailable={fundedUnavailable}
          />
        ) : (
          <SessionGlance
            independentOpen={independentOpen}
            loading={loading}
            marketId={marketId}
            run={run}
            summary={summary}
          />
        )}
      </div>
      <div className="bot-panel-body" hidden={collapsed} id={bodyId}>
        <SessionStatus loading={loading} marketId={marketId} run={run} />
        {activityError ? <p className="error-banner">{activityError}</p> : null}
        {activities.length === 0 ? (
          <Empty
            loading={activityLoading}
            message="No activity recorded for today’s session yet."
          />
        ) : (
          <ActivityList
            activities={activities}
            label="Today’s paper bot activity"
            listClassName={BOT_TODAY_ACTIVITY_LIST}
            marketId={marketId}
          />
        )}
      </div>
    </section>
  );
}

/** Shared activity rows for the today journal and the full Diagnostics journal. */
function ActivityList({
  activities,
  label,
  marketId = "CA_TSX",
  showRawIds = false,
  listClassName = BOT_ACTIVITY_LIST,
}: {
  activities: PaperBotActivity[];
  label: string;
  marketId?: "CA_TSX" | "US_EQUITIES";
  showRawIds?: boolean;
  listClassName?: string;
}) {
  return (
    <div aria-label={label} className={listClassName} tabIndex={0}>
      {activities.map((activity) => (
        <article className={BOT_ACTIVITY_ROW} key={activity.id}>
          <time className={BOT_ACTIVITY_META} dateTime={activity.occurredAt}>
            {activityTimestamp(activity.occurredAt, marketId)}
          </time>
          <i
            className={classes(
              "tw:w-max tw:rounded-[4px] tw:px-[6px] tw:py-[4px] tw:font-mono tw:text-[0.55rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.06em] tw:not-italic",
              ACTIVITY_TONES[activity.severity.toLowerCase()],
            )}
          >
            {activity.severity}
          </i>
          <div className="tw:grid tw:min-w-0 tw:gap-[5px] tw:below-700:col-span-full">
            <strong className="tw:text-[0.74rem] tw:leading-[1.45] tw:text-ink-200">
              {activity.message}
            </strong>
            <small
              className={classes(
                BOT_ACTIVITY_META,
                "tw:[overflow-wrap:anywhere] tw:uppercase",
              )}
            >
              {[
                activity.symbol,
                activity.strategyKey?.replaceAll("_", " "),
                activity.model,
                activity.eventType.replaceAll("_", " "),
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
            {showRawIds ? (
              <small
                className={classes(
                  "bot-raw-id",
                  BOT_ACTIVITY_META,
                  "tw:[overflow-wrap:anywhere] tw:uppercase",
                )}
              >
                {activity.id} · run {activity.runId}
              </small>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

export function BotView({
  marketId = "CA_TSX",
  paperBot,
  onOpenPerformance,
}: {
  marketId?: "CA_TSX" | "US_EQUITIES";
  paperBot?: PaperBotStatus;
  onOpenPerformance?: () => void;
} = {}) {
  const [section, setSection] = useState<BotSection>("overview");
  const [filters, setFilters] = useState<DashboardFilters>(emptyFilters);
  const [aggregates, setAggregates] = useState<PaperCohortAggregate[]>([]);
  const [today, setToday] = useState<PaperCohortAggregate[]>([]);
  const [curves, setCurves] = useState<
    Awaited<ReturnType<typeof paperCohortCurveListSchema.parse>>["points"]
  >([]);
  const [divergences, setDivergences] = useState<
    Awaited<
      ReturnType<typeof paperModelDivergenceListSchema.parse>
    >["divergences"]
  >([]);
  const [comparisons, setComparisons] = useState<
    Awaited<
      ReturnType<typeof paperEvidenceComparisonListSchema.parse>
    >["comparisons"]
  >([]);
  const [qualifications, setQualifications] = useState<
    PaperProfileQualification[]
  >([]);
  const [knownCohorts, setKnownCohorts] = useState<PaperCohortAggregate[]>([]);
  const [coordination, setCoordination] =
    useState<PaperCoordinationSummary | null>(null);
  const [coordinationDecisions, setCoordinationDecisions] = useState<
    PaperCoordinationDecision[]
  >([]);
  const [todayCoordination, setTodayCoordination] =
    useState<PaperCoordinationSummary | null>(null);
  const [todayRun, setTodayRun] = useState<PaperBotRun | null>(null);
  const [runCount, setRunCount] = useState(0);
  const [glanceProjection, setGlanceProjection] =
    useState<GlanceProjection>("FUNDED");
  const [fundedAccount, setFundedAccount] = useState<FundedLiveAccount | null>(
    null,
  );
  const [fundedUnavailable, setFundedUnavailable] = useState(false);
  const [activities, setActivities] = useState<PaperBotActivity[]>([]);
  const [todayActivities, setTodayActivities] = useState<PaperBotActivity[]>(
    [],
  );
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useRefreshOnFocus(() => setReload((value) => value + 1));

  // The activity feed has its own 10s cadence, but the aggregates, runs and
  // session glance only reload on mount/focus/filter changes. Refresh them on
  // a bounded background interval while visible so a session starting, a run
  // completing, or a backlog changing appears without user action.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setReload((value) => value + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    const controller = new AbortController();
    const base: PaperEvidenceFilters = {
      marketId,
      source: "LIVE",
      profileConfigId: filters.profileConfigId,
      executionModelVersion: filters.executionModelVersion,
      startDate: filters.startDate,
      endDate: filters.endDate,
    };
    const canonicalFilters: PaperEvidenceFilters = { ...base, model: "QUOTE" };
    const date = sessionDate(marketId);
    setLoading(true);
    setError("");
    void Promise.all([
      getJson(
        `/api/paper-bot/aggregates${query(canonicalFilters)}`,
        controller.signal,
      ).then((value) => paperCohortAggregateListSchema.parse(value).aggregates),
      getJson(
        `/api/paper-bot/aggregates${query({ marketId, source: "LIVE", model: "QUOTE", startDate: date, endDate: date })}`,
        controller.signal,
      ).then((value) => paperCohortAggregateListSchema.parse(value).aggregates),
      getJson(
        `/api/paper-bot/curves${query(canonicalFilters)}`,
        controller.signal,
      ).then((value) => paperCohortCurveListSchema.parse(value).points),
      getJson(
        `/api/paper-bot/divergences${query(base)}`,
        controller.signal,
      ).then(
        (value) => paperModelDivergenceListSchema.parse(value).divergences,
      ),
      getJson(
        `/api/paper-bot/comparisons${query(canonicalFilters)}`,
        controller.signal,
      ).then(
        (value) => paperEvidenceComparisonListSchema.parse(value).comparisons,
      ),
      getJson(`/api/paper-bot/runs${query(base)}`, controller.signal).then(
        (value) => paperBotRunListSchema.parse(value).runs,
      ),
      getJson(
        `/api/paper-bot/qualifications${query(base)}`,
        controller.signal,
      ).then(
        (value) =>
          paperProfileQualificationListSchema.parse(value).qualifications,
      ),
      getJson(
        `/api/paper-bot/coordination/summary${query(base)}`,
        controller.signal,
      ).then((value) =>
        paperCoordinationSummarySchema.parse(
          (value as { summary: unknown }).summary,
        ),
      ),
      getJson(
        `/api/paper-bot/coordination/decisions${query(base)}`,
        controller.signal,
      ).then(
        (value) => paperCoordinationDecisionListSchema.parse(value).decisions,
      ),
      // The session glance answers "how did today go?", so it is scoped to
      // today rather than to whatever range the filters above are showing.
      getJson(
        `/api/paper-bot/coordination/summary${query({ marketId, source: "LIVE", startDate: date, endDate: date })}`,
        controller.signal,
      ).then((value) =>
        paperCoordinationSummarySchema.parse(
          (value as { summary: unknown }).summary,
        ),
      ),
      getJson(
        `/api/paper-bot/runs${query({ marketId, source: "LIVE", startDate: date, endDate: date })}`,
        controller.signal,
      ).then((value) => paperBotRunListSchema.parse(value).runs),
    ])
      .then(
        ([
          nextAggregates,
          nextToday,
          nextCurves,
          nextDivergences,
          nextComparisons,
          runs,
          nextQualifications,
          nextCoordination,
          nextCoordinationDecisions,
          nextTodayCoordination,
          todayRuns,
        ]) => {
          if (controller.signal.aborted) return;
          setAggregates(nextAggregates);
          setToday(nextToday);
          setCurves(nextCurves);
          setDivergences(nextDivergences);
          setComparisons(nextComparisons);
          setQualifications(nextQualifications);
          setCoordination(nextCoordination);
          setCoordinationDecisions(nextCoordinationDecisions);
          setTodayCoordination(nextTodayCoordination);
          setTodayRun(todayRuns[0] ?? null);
          setRunCount(runs.length);
          setKnownCohorts((current) => {
            const byId = new Map(
              current.map((value) => [value.cohort.profileConfigId, value]),
            );
            for (const aggregate of cohorts(nextAggregates))
              byId.set(aggregate.cohort.profileConfigId, aggregate);
            return [...byId.values()].sort((left, right) =>
              left.cohort.profileName.localeCompare(right.cohort.profileName),
            );
          });
        },
      )
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load BOT evidence",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filterKey, marketId, reload]);

  // The funded glance is its own read: a missing binding or failed request
  // must degrade to an explicit unavailable state, never blank the overview.
  useEffect(() => {
    const controller = new AbortController();
    getJson(
      `/api/paper-bot/funded-account?marketId=${encodeURIComponent(marketId)}`,
      controller.signal,
    )
      .then((value) => fundedLiveAccountResponseSchema.parse(value))
      .then((value) => {
        if (controller.signal.aborted) return;
        setFundedAccount(value.status === "READY" ? value.account : null);
        setFundedUnavailable(value.status === "UNAVAILABLE");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFundedAccount(null);
        setFundedUnavailable(true);
      });
    return () => controller.abort();
  }, [marketId, reload]);

  useEffect(() => {
    const controller = new AbortController();
    const loadActivities = async () => {
      try {
        const base: PaperEvidenceFilters = {
          marketId,
          source: "LIVE",
          profileConfigId: filters.profileConfigId,
          executionModelVersion: filters.executionModelVersion,
          startDate: filters.startDate,
          endDate: filters.endDate,
        };
        const parameters = query(base);
        const date = sessionDate(marketId);
        const todayParameters = query({
          marketId,
          source: "LIVE",
          profileConfigId: filters.profileConfigId,
          executionModelVersion: filters.executionModelVersion,
          startDate: date,
          endDate: date,
        });
        const [value, todayValue] = await Promise.all([
          getJson(
            `/api/paper-bot/activities${parameters}${parameters ? "&" : "?"}limit=100`,
            controller.signal,
          ),
          getJson(
            `/api/paper-bot/activities${todayParameters}${todayParameters ? "&" : "?"}limit=100`,
            controller.signal,
          ),
        ]);
        if (!controller.signal.aborted) {
          setActivities(paperBotActivityListSchema.parse(value).activities);
          setTodayActivities(
            paperBotActivityListSchema.parse(todayValue).activities,
          );
          setActivityError("");
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setActivityError(
            reason instanceof Error
              ? reason.message
              : "Unable to load bot activity",
          );
      } finally {
        if (!controller.signal.aborted) setActivityLoading(false);
      }
    };
    setActivityLoading(true);
    void loadActivities();
    const timer = window.setInterval(() => void loadActivities(), 10_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [filterKey, marketId, reload]);

  const canonical = useMemo(() => cohorts(aggregates), [aggregates]);
  const todayMetrics = useMemo(
    () => ({
      observations: aggregateCount(today, "signalCount"),
      fills: aggregateCount(today, "fills"),
      noFills: aggregateCount(today, "noFills"),
      rejectedEconomics: aggregateCount(today, "rejectedEconomics"),
      open: aggregateCount(today, "openExecutions"),
      closePending: aggregateCount(today, "closePendingExecutions"),
      delayed: today.reduce(
        (total, value) => total + value.delayedClose.count,
        0,
      ),
    }),
    [today],
  );
  const unresolvedToday = todayMetrics.open + todayMetrics.closePending;
  const hasRecoveryWork =
    (paperBot?.overdueRuns ?? 0) > 0 ||
    (paperBot?.unreconcilableEvents ?? 0) > 0;

  return (
    <>
      <nav
        aria-label="BOT sections"
        className="bot-sections tw:mt-[18px] tw:mb-4 tw:flex tw:flex-wrap tw:gap-[6px] tw:rounded-panel tw:border tw:border-line tw:bg-surface tw:p-[6px]"
      >
        {botSections.map((entry) => (
          <button
            aria-pressed={section === entry.value}
            className={classes(
              BOT_SECTION_BUTTON,
              section === entry.value && BOT_SECTION_BUTTON_PRESSED,
            )}
            key={entry.value}
            onClick={() => setSection(entry.value)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {error ? <p className="error-banner">{error}</p> : null}

      {section === "overview" ? (
        <>
          <TodayActivityPanel
            activities={todayActivities}
            activityError={activityError}
            activityLoading={activityLoading}
            funded={fundedAccount}
            fundedUnavailable={fundedUnavailable}
            glanceProjection={glanceProjection}
            independentOpen={unresolvedToday}
            loading={loading}
            marketId={marketId}
            onGlanceProjection={setGlanceProjection}
            run={todayRun}
            summary={todayCoordination}
          />

          {unresolvedToday > 0 || hasRecoveryWork ? (
            <p
              className="bot-backlog-line tw:mx-0 tw:mt-0 tw:mb-4 tw:rounded-panel tw:border tw:border-line-warn-strong tw:bg-surface-warn tw:px-4 tw:py-3 tw:text-[0.76rem] tw:leading-[1.5] tw:text-ink-500"
              role="note"
            >
              <strong className="tw:text-warn">Unresolved work · </strong>
              {unresolvedToday > 0
                ? `${unresolvedToday} independent quote execution(s) still open or close-pending today. `
                : null}
              {hasRecoveryWork
                ? "Stuck events and overdue runs are shown separately in Automation liveness below. "
                : null}
            </p>
          ) : null}

          <BotPanel
            action={
              <Tip label="The number of recent paper-bot runs matching the current evidence filters. A run is a market-session process, not a trade.">
                <span className="tw:relative tw:z-[1]">
                  {runCount} RECENT RUNS
                </span>
              </Tip>
            }
            className="bot-today panel tw:mb-4"
            id="today"
            lede="Today’s quote-execution funnel for the canonical QUOTE model. Independent of the coordinated shadow simulation and of funded results, and never added to them."
            title="Today’s independent QUOTE funnel"
          >
            <div className={BOT_TODAY_METRICS}>
              <Metric
                label="Observations"
                value={todayMetrics.observations}
                note="QUOTE model"
                tip="All live strategy observations processed today by the canonical quote-execution model. One symbol can contribute more than one observation."
              />
              <Metric
                label="Quote fills"
                value={todayMetrics.fills}
                note="eligible entries"
                tip="Eligible observations that received a simulated entry fill from the live quote model. This is a fill count, not a count of profitable trades."
              />
              <Metric
                label="No fills"
                value={todayMetrics.noFills}
                note="unavailable market"
                tip="Eligible observations that could not receive a valid simulated fill because the required market quote or liquidity was unavailable."
              />
              <Metric
                label="Economics rejected"
                value={todayMetrics.rejectedEconomics}
                note="declined, not missed"
                tip="Candidates intentionally declined because their expected trading economics did not meet the bot’s risk, liquidity, or cost rules. They are not missed fills."
              />
              <Metric
                label="Open positions"
                value={todayMetrics.open}
                note="not in P&L"
                tip="Independent quote-model executions that are still open. They are excluded from realized performance until an exit is finalized."
              />
              <Metric
                label="Close pending"
                value={todayMetrics.closePending}
                note="not in P&L"
                tip="Positions for which an exit has been requested but a valid closing quote has not yet been confirmed. They remain outside realized P&L."
              />
              <Metric
                label="Session-close delays"
                value={todayMetrics.delayed}
                note="closed delayed"
                tip="Positions that closed after the scheduled session exit because an actionable bid was not available at the intended close time."
              />
            </div>
          </BotPanel>

          <div className="bot-overview-actions tw:mx-0 tw:mt-0 tw:mb-4 tw:flex tw:flex-wrap tw:gap-2">
            <button
              className={classes(PAPER_BUTTON, "tw:uppercase")}
              onClick={() => setSection("diagnostics")}
              type="button"
            >
              View full activity in Diagnostics
            </button>
            {onOpenPerformance ? (
              <button
                className={classes(PAPER_BUTTON, "tw:uppercase")}
                onClick={onOpenPerformance}
                type="button"
              >
                View retained results
              </button>
            ) : null}
          </div>

          <BotLivenessPanel paperBot={paperBot} />

          <BotPanel
            action={
              <button
                className={classes(PAPER_BUTTON, "tw:relative tw:z-[1]")}
                disabled={loading}
                onClick={() => setReload((value) => value + 1)}
              >
                {loading ? "LOADING…" : "REFRESH"}
              </button>
            }
            className="bot-toolbar panel tw:mt-[18px] tw:mb-4"
            collapsedByDefault
            id="filters"
            lede="LIVE source · quote execution is canonical; one-minute candles are supplementary."
            title="Forward paper evidence"
          >
            <div className="bot-filters tw:grid tw:grid-cols-[minmax(180px,1.4fr)_minmax(180px,1fr)_repeat(2,minmax(135px,0.7fr))] tw:gap-3 tw:px-5 tw:pt-4 tw:pb-5 tw:below-lg:grid-cols-[repeat(3,1fr)] tw:below-700:grid-cols-[repeat(2,1fr)]">
              <label className={BOT_FILTER_LABEL}>
                Profile configuration
                <select
                  className={BOT_FILTER_CONTROL}
                  value={filters.profileConfigId ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      profileConfigId: event.target.value || undefined,
                    }))
                  }
                >
                  <option value="">All configurations</option>
                  {knownCohorts.map((value) => (
                    <option
                      key={value.cohort.profileConfigId}
                      value={value.cohort.profileConfigId}
                    >
                      {value.cohort.profileName} · {value.cohort.configVersion}
                    </option>
                  ))}
                </select>
              </label>
              <label className={BOT_FILTER_LABEL}>
                Execution model version
                <input
                  className={BOT_FILTER_CONTROL}
                  value={filters.executionModelVersion ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      executionModelVersion: event.target.value || undefined,
                    }))
                  }
                  placeholder="All versions"
                />
              </label>
              <label className={BOT_FILTER_LABEL}>
                From
                <input
                  className={BOT_FILTER_CONTROL}
                  type="date"
                  value={filters.startDate ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      startDate: event.target.value || undefined,
                    }))
                  }
                />
              </label>
              <label className={BOT_FILTER_LABEL}>
                To
                <input
                  className={BOT_FILTER_CONTROL}
                  type="date"
                  value={filters.endDate ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      endDate: event.target.value || undefined,
                    }))
                  }
                />
              </label>
            </div>
          </BotPanel>
        </>
      ) : null}

      {section === "results" ? (
        <section className="bot-section" aria-labelledby="bot-results-heading">
          <header className="bot-section-heading tw:mx-0 tw:mt-1 tw:mb-0">
            <h3
              className="tw:m-0 tw:text-[1.25rem] tw:tracking-[-0.01em] tw:text-ink-100"
              id="bot-results-heading"
            >
              Independent evidence results
            </h3>
            <p className="tw:mx-0 tw:mt-[6px] tw:mb-0 tw:max-w-[78ch] tw:text-[0.8rem] tw:leading-[1.55] tw:text-ink-550">
              Canonical quote-model cohorts with their curves, fillability,
              qualification history and backtest comparison. These are
              independent strategy results, separate from the coordinated shadow
              simulation and funded-account results, and they are never added
              together.
            </p>
          </header>

          <BotPanel
            badge="QUOTE · LIVE"
            className="panel tw:mt-[18px] tw:mb-4"
            id="canonical"
            lede="Each profile configuration is separate. No aggregate is treated as a capital-constrained portfolio."
            title="Canonical performance by exact cohort"
          >
            {canonical.length === 0 ? (
              <Empty
                loading={loading}
                message="No canonical forward evidence matches these filters."
              />
            ) : (
              <div
                className={classes(
                  "bot-cohorts tw:grid tw:gap-3 tw:p-[14px]",
                  BOT_SCROLL_AREA,
                )}
              >
                {canonical.map((aggregate) => (
                  <CohortCard
                    aggregate={aggregate}
                    key={`${aggregate.cohort.profileConfigId}:${aggregate.cohort.executionModelVersion}`}
                  />
                ))}
              </div>
            )}
          </BotPanel>

          <section className="bot-grid tw:grid tw:grid-cols-[1fr_1fr] tw:items-start tw:gap-4 tw:below-lg:grid-cols-[1fr]">
            <CurvePanel points={curves} loading={loading} />
            <QualityPanel aggregates={canonical} loading={loading} />
          </section>

          <QualificationHistoryPanel
            loading={loading}
            marketId={marketId}
            values={qualifications}
          />

          <section className="bot-grid tw:grid tw:grid-cols-[1fr_1fr] tw:items-start tw:gap-4 tw:below-lg:grid-cols-[1fr]">
            <ComparisonPanel values={comparisons} loading={loading} />
            <DivergencePanel values={divergences} loading={loading} />
          </section>
        </section>
      ) : null}

      {section === "diagnostics" ? (
        <section
          className="bot-section"
          aria-labelledby="bot-diagnostics-heading"
        >
          <header className="bot-section-heading tw:mx-0 tw:mt-1 tw:mb-0">
            <h3
              className="tw:m-0 tw:text-[1.25rem] tw:tracking-[-0.01em] tw:text-ink-100"
              id="bot-diagnostics-heading"
            >
              Diagnostics and raw identifiers
            </h3>
            <p className="tw:mx-0 tw:mt-[6px] tw:mb-0 tw:max-w-[78ch] tw:text-[0.8rem] tw:leading-[1.55] tw:text-ink-550">
              The full activity journal and coordinated shadow decisions with
              their unformatted identifiers for audit and support. Raw rows
              refresh automatically every ten seconds.
            </p>
          </header>

          <BotLivenessDiagnostics paperBot={paperBot} />

          <BotPanel
            badge={`${activities.length} · AUTO 10S`}
            className="bot-activity panel tw:mt-[18px] tw:mb-4"
            id="activity"
            lede="Durable, human-readable run, signal, fill, and exit events. New activity appears automatically."
            title="Bot activity journal"
          >
            {activityError ? (
              <p className="error-banner">{activityError}</p>
            ) : null}
            {activities.length === 0 ? (
              <Empty
                loading={activityLoading}
                message="No bot activity matches these filters."
              />
            ) : (
              <ActivityList
                activities={activities}
                label="Paper bot activity journal"
                marketId={marketId}
                showRawIds
              />
            )}
          </BotPanel>

          <CoordinationPanel
            decisions={coordinationDecisions}
            loading={loading}
            marketId={marketId}
            summary={coordination}
          />
        </section>
      ) : null}
    </>
  );
}

/**
 * The coordinated shadow portfolio. Deliberately its own panel with its own
 * totals: adding these numbers to the independent per-strategy evidence above
 * would mix a portfolio simulation with unbiased strategy evidence.
 */
function CoordinationPanel({
  summary,
  decisions,
  loading,
  marketId = "CA_TSX",
}: {
  summary: PaperCoordinationSummary | null;
  decisions: PaperCoordinationDecision[];
  loading: boolean;
  marketId?: "CA_TSX" | "US_EQUITIES";
}) {
  return (
    <BotPanel
      badge={`${summary?.policyVersions.join(" · ") || "NO POLICY"} · SHADOW`}
      className="panel tw:mt-[18px] tw:mb-4"
      id="coordination"
      lede="One cooperating portfolio decision per symbol. Separate from the independent evidence above and never added to it."
      title="Coordinated portfolio · shadow"
    >
      {summary === null || summary.decisions === 0 ? (
        <Empty
          loading={loading}
          message="No coordinated decisions match these filters."
        />
      ) : (
        <>
          <div className={BOT_METRICS}>
            <Metric
              label="Decisions"
              value={summary.decisions}
              note={`${summary.approved} approved`}
            />
            <Metric
              label="Deferred"
              value={summary.deferred}
              note="can clear later"
            />
            <Metric
              label="Rejected"
              value={summary.rejected}
              note="not tradable"
            />
            <Metric
              label="Closed trades"
              value={summary.closedTrades}
              note={`${summary.openPositions} open`}
            />
            <Metric
              label="Net P&L"
              value={number(summary.netPnl)}
              note="coordinated only"
            />
            <Metric
              label="Cumulative R"
              value={number(summary.cumulativeR)}
              note={`avg ${number(summary.averageR)}`}
            />
            <Metric label="Win rate" value={rate(summary.winRate)} note="" />
            <Metric
              label="Symbols traded"
              value={summary.symbolsTraded}
              note={`${summary.repeatedSymbolEntries} repeat entries`}
            />
          </div>
          <p className="bot-note tw:m-0 tw:px-5 tw:pb-[11px] tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:text-ink-650 tw:[overflow-wrap:anywhere]">
            Reasons: {distribution(summary.reasons, summary.decisions)}
          </p>
          <p className="bot-note tw:m-0 tw:px-5 tw:pb-[11px] tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:text-ink-650 tw:[overflow-wrap:anywhere]">
            Exits: {distribution(summary.exitReasons, summary.closedTrades)}
          </p>
          <div className={BOT_ACTIVITY_LIST}>
            {decisions.slice(0, 25).map((decision) => (
              <article className={BOT_ACTIVITY_ROW} key={decision.id}>
                <time
                  className={BOT_ACTIVITY_META}
                  dateTime={decision.decisionTimestamp}
                >
                  {activityTimestamp(decision.decisionTimestamp, marketId)}
                </time>
                <i
                  className={classes(
                    "tw:w-max tw:rounded-[4px] tw:px-[6px] tw:py-[4px] tw:font-mono tw:text-[0.55rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.06em] tw:not-italic",
                    ACTIVITY_TONES[
                      decision.outcome === "APPROVED" ? "success" : "info"
                    ],
                  )}
                >
                  {decision.outcome}
                </i>
                <div className="tw:grid tw:min-w-0 tw:gap-[5px] tw:below-700:col-span-full">
                  <strong className="tw:text-[0.74rem] tw:leading-[1.45] tw:text-ink-200">
                    {decision.symbol} ·{" "}
                    {decision.reason.replaceAll("_", " ").toLowerCase()}
                  </strong>
                  <small
                    className={classes(
                      BOT_ACTIVITY_META,
                      "tw:[overflow-wrap:anywhere] tw:uppercase",
                    )}
                  >
                    {[
                      decision.selectedStrategyKey?.replaceAll("_", " "),
                      `${decision.candidateCount} candidate(s)`,
                      decision.positionStatus,
                      decision.exitReason?.replaceAll("_", " "),
                      decision.netPnl === null
                        ? null
                        : `net ${number(decision.netPnl)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  <small
                    className={classes(
                      "bot-raw-id",
                      BOT_ACTIVITY_META,
                      "tw:[overflow-wrap:anywhere] tw:uppercase",
                    )}
                  >
                    {decision.id} · run {decision.runId}
                  </small>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </BotPanel>
  );
}

function QualificationHistoryPanel({
  values,
  loading,
  marketId = "CA_TSX",
}: {
  values: PaperProfileQualification[];
  loading: boolean;
  marketId?: "CA_TSX" | "US_EQUITIES";
}) {
  return (
    <BotPanel
      badge="QUOTE · LIVE"
      className="panel tw:mt-[18px] tw:mb-4"
      collapsedByDefault
      id="qualifications"
      lede="Durable outcomes refreshed when each LIVE bot cohort completes."
      title="Qualification history"
    >
      {values.length === 0 ? (
        <Empty
          loading={loading}
          message="No completed qualification cohorts match these filters."
        />
      ) : (
        <div
          className={classes(
            "bot-cohorts tw:grid tw:gap-3 tw:p-[14px]",
            BOT_SCROLL_AREA,
          )}
        >
          {values.map((value) => (
            <article
              className="bot-cohort-card"
              key={`${value.profileConfigId}:${value.computedAt}`}
            >
              <strong>{value.profileName}</strong>
              <small>
                {value.strategyKey.replaceAll("_", " ")} · {value.policyVersion}{" "}
                · {activityTimestamp(value.computedAt, marketId)}
              </small>
              <div className={BOT_METRICS}>
                <Metric
                  label="Status"
                  value={value.qualification.replaceAll("_", " ")}
                  note={`${value.closedTrades} closed trade(s)`}
                />
                <Metric
                  label="Net P&L"
                  value={number(value.netPnl)}
                  note={`${value.wins} winner(s)`}
                />
                <Metric
                  label="Cumulative R"
                  value={number(value.cumulativeR)}
                  note={`Avg R ${number(value.averageR)}`}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </BotPanel>
  );
}

/**
 * The session at a glance. It reports the coordinated projection because
 * ADR-010 makes that the only one readable as a single account's result; the
 * independent open count sits beside it as context and is never added in.
 */
function SessionGlance({
  summary,
  run,
  independentOpen,
  loading,
  marketId = "CA_TSX",
}: {
  summary: PaperCoordinationSummary | null;
  run: PaperBotRun | null;
  independentOpen: number;
  loading: boolean;
  marketId?: "CA_TSX" | "US_EQUITIES";
}) {
  const closed = summary?.closedTrades ?? 0;
  const netPnl = summary?.netPnl ?? 0;
  const tone =
    closed === 0 || netPnl === 0
      ? "flat"
      : netPnl > 0
        ? "positive"
        : "negative";
  const wins = summary?.winRate.value;
  return (
    <article
      className={classes(
        "bot-glance tw:flex tw:w-full tw:flex-wrap tw:items-center tw:gap-x-7 tw:gap-y-3 tw:rounded-panel tw:border tw:px-5 tw:py-[14px]",
        tone,
        GLANCE_TONES[tone],
      )}
    >
      <div className="tw:grid tw:min-w-[185px] tw:gap-[3px]">
        <span className="tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.1em] tw:text-ink-700">
          TODAY · COORDINATED SHADOW SIMULATION
        </span>
        <strong
          className={classes(
            "tw:text-[1.55rem] tw:leading-[1.2] tw:tabular-nums",
            GLANCE_VALUE_TONES[tone],
          )}
        >
          {summary === null && loading ? "…" : money(netPnl)}
        </strong>
        <b className="tw:font-mono tw:text-[0.72rem] tw:font-bold tw:leading-[normal] tw:text-ink-250">
          {signed(summary?.cumulativeR ?? 0)}R ·{" "}
          {wins === null || wins === undefined
            ? "NO CLOSED TRADES"
            : `${(wins * 100).toFixed(0)}% WIN (${summary?.wins}/${closed})`}
        </b>
      </div>
      <div className="bot-glance-counts tw:grid tw:w-[250px] tw:grid-cols-[repeat(3,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-[8px] tw:border tw:border-line tw:bg-surface-sunken">
        <span className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-[11px] tw:py-[9px] tw:font-mono tw:text-[0.54rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700">
          CLOSED
          <b className="tw:text-[0.95rem] tw:tabular-nums tw:text-ink-150">
            {closed}
          </b>
        </span>
        <span className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-[11px] tw:py-[9px] tw:font-mono tw:text-[0.54rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700">
          OPEN
          <b className="tw:text-[0.95rem] tw:tabular-nums tw:text-ink-150">
            {summary?.openPositions ?? 0}
          </b>
        </span>
        <span className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-[11px] tw:py-[9px] tw:font-mono tw:text-[0.54rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700">
          DECIDED
          <b className="tw:text-[0.95rem] tw:tabular-nums tw:text-ink-150">
            {summary?.decisions ?? 0}
          </b>
        </span>
      </div>
      <em className="tw:max-w-[44ch] tw:text-[0.66rem] tw:not-italic tw:leading-[1.5] tw:text-ink-650">
        {independentOpen} open in the independent QUOTE projection, reported
        separately and never added here.
      </em>
      <small className="tw:ml-auto tw:font-mono tw:text-[0.6rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-ink-700">
        {run?.status ?? "NOT RUN"} · {sessionDate(marketId)}
      </small>
    </article>
  );
}

/**
 * The funded paper account's current session. The headline is the account's
 * realized P&L for the active ledger session; the counts belong to the latest
 * live funded run only. It is the only account-style projection with cash and
 * reservations, it is never summed with the shadow or independent numbers,
 * and it is not qualification evidence.
 */
function FundedGlance({
  funded,
  unavailable,
  loading,
  marketId = "CA_TSX",
}: {
  funded: FundedLiveAccount | null;
  unavailable: boolean;
  loading: boolean;
  marketId?: "CA_TSX" | "US_EQUITIES";
}) {
  const account = funded?.marketId === marketId ? funded : null;
  const closed = account?.activity.closed ?? 0;
  const realizedPnl = account?.summary.realizedPnl ?? 0;
  const tone =
    account === null || closed === 0 || realizedPnl === 0
      ? "flat"
      : realizedPnl > 0
        ? "positive"
        : "negative";
  const wins = account?.activity.wins ?? 0;
  const cumulativeR = account?.activity.cumulativeR;
  return (
    <article
      className={classes(
        "bot-glance tw:flex tw:w-full tw:flex-wrap tw:items-center tw:gap-x-7 tw:gap-y-3 tw:rounded-panel tw:border tw:px-5 tw:py-[14px]",
        tone,
        GLANCE_TONES[tone],
      )}
    >
      <div className="tw:grid tw:min-w-[185px] tw:gap-[3px]">
        <span className="tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.1em] tw:text-ink-700">
          TODAY · FUNDED PAPER ACCOUNT ·{" "}
          {account?.currency ?? (marketId === "US_EQUITIES" ? "USD" : "CAD")}
        </span>
        <strong
          className={classes(
            "tw:text-[1.55rem] tw:leading-[1.2] tw:tabular-nums",
            GLANCE_VALUE_TONES[tone],
          )}
        >
          {account === null ? (loading ? "…" : "—") : money(realizedPnl)}
        </strong>
        <b className="tw:font-mono tw:text-[0.72rem] tw:font-bold tw:leading-[normal] tw:text-ink-250">
          {account === null
            ? "NO LIVE FUNDED RUN"
            : closed === 0
              ? "NO CLOSED TRADES"
              : `${signed(cumulativeR ?? 0)}R · ${((wins / closed) * 100).toFixed(0)}% WIN (${wins}/${closed})`}
        </b>
      </div>
      <div className="bot-glance-counts tw:grid tw:w-[250px] tw:grid-cols-[repeat(3,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-[8px] tw:border tw:border-line tw:bg-surface-sunken">
        <span className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-[11px] tw:py-[9px] tw:font-mono tw:text-[0.54rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700">
          CLOSED
          <b className="tw:text-[0.95rem] tw:tabular-nums tw:text-ink-150">
            {closed}
          </b>
        </span>
        <span className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-[11px] tw:py-[9px] tw:font-mono tw:text-[0.54rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700">
          OPEN
          <b className="tw:text-[0.95rem] tw:tabular-nums tw:text-ink-150">
            {account?.activity.open ?? 0}
          </b>
        </span>
        <span className="tw:grid tw:gap-[5px] tw:bg-surface tw:px-[11px] tw:py-[9px] tw:font-mono tw:text-[0.54rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700">
          DECIDED
          <b className="tw:text-[0.95rem] tw:tabular-nums tw:text-ink-150">
            {account?.activity.decisions ?? 0}
          </b>
        </span>
      </div>
      <em className="tw:max-w-[44ch] tw:text-[0.66rem] tw:not-italic tw:leading-[1.5] tw:text-ink-650">
        {account === null
          ? unavailable
            ? "No live funded account run is bound for this market yet."
            : "Loading the funded paper account…"
          : `${account.currency} ${account.summary.cash.toFixed(2)} cash · ${account.summary.equity.toFixed(2)} equity · simulated, not qualified for capital allocation.`}
      </em>
      <small className="tw:ml-auto tw:font-mono tw:text-[0.6rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-ink-700">
        {account === null
          ? "NOT RUN"
          : `${account.runStatus} · ${account.sessionDate}`}
      </small>
    </article>
  );
}

function Metric({
  label,
  value,
  note,
  tip,
}: {
  label: string;
  value: number | string;
  note: string;
  tip?: string;
}) {
  const metric = (
    <div className={BOT_METRIC_CELL}>
      <span className={BOT_METRIC_LABEL}>{label}</span>
      <strong className={BOT_METRIC_VALUE}>{value}</strong>
      <small className={BOT_METRIC_NOTE}>{note}</small>
    </div>
  );
  return tip === undefined ? metric : <Tip label={tip}>{metric}</Tip>;
}

function Empty({ loading, message }: { loading: boolean; message: string }) {
  return (
    <p className="empty compact tw:p-[25px] tw:text-center tw:text-ink-700">
      {loading ? "Loading evidence…" : message}
    </p>
  );
}

function CohortCard({ aggregate }: { aggregate: PaperCohortAggregate }) {
  const { cohort } = aggregate;
  return (
    <article className={classes("bot-cohort", BOT_CARD)}>
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:px-[15px] tw:py-[14px] tw:below-700:grid">
        <div>
          <h4 className="tw:m-0 tw:text-[0.86rem]">{cohort.profileName}</h4>
          <p className="tw:m-0 tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:text-ink-650">
            {cohort.configVersion} · {cohort.strategyKey}{" "}
            {cohort.strategyVersion}
          </p>
        </div>
        <span className="tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:text-ink-650">
          {cohort.executionModelVersion}
        </span>
      </header>
      <div className={BOT_COHORT_METRICS}>
        <Metric
          label="Signals"
          value={aggregate.signalCount}
          note={`${aggregate.eligibleSignalCount} eligible`}
        />
        <Metric
          label="Fill rate"
          value={rate(aggregate.fillRate)}
          note={`${aggregate.noFills} no-fill`}
        />
        <Metric
          label="Closed"
          value={aggregate.closedTrades}
          note={`${aggregate.unresolvedExecutions} unresolved`}
        />
        <Metric
          label="Win rate"
          value={rate(aggregate.winRate)}
          note="closed trades"
        />
        <Metric
          label="Average R"
          value={number(aggregate.averageR)}
          note={`expectancy ${number(aggregate.expectancyR)}R`}
        />
        <Metric
          label="Cumulative R"
          value={`${number(aggregate.cumulativeR)}R`}
          note="closed trades"
        />
      </div>
      <p className={BOT_ASSUMPTIONS}>
        Market: {cohort.marketId ?? "UNKNOWN"}; currency:{" "}
        {cohort.currency ?? "UNKNOWN"}; semantics:{" "}
        {cohort.signalSemanticsVersion ?? "UNKNOWN"}; replay scope:{" "}
        {cohort.replayScope ?? "UNKNOWN"}.
      </p>
      <details className="bot-assumptions-details tw:px-[15px] tw:pt-0 tw:pb-[11px]">
        <summary className="tw:cursor-pointer tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:text-ink-600 tw:focus-visible:outline-1 tw:focus-visible:outline-line-accent tw:focus-visible:outline-offset-[3px]">
          Assumptions snapshot
        </summary>
        <p className={BOT_ASSUMPTIONS_DETAIL}>
          Assumptions snapshot: {JSON.stringify(cohort.assumptions)}
        </p>
      </details>
    </article>
  );
}

function CurvePanel({
  points,
  loading,
}: {
  points: Awaited<
    ReturnType<typeof paperCohortCurveListSchema.parse>
  >["points"];
  loading: boolean;
}) {
  const grouped = useMemo(() => {
    const values = new Map<string, typeof points>();
    for (const point of points) {
      const key = `${point.cohort.profileConfigId}:${point.cohort.executionModelVersion}`;
      values.set(key, [...(values.get(key) ?? []), point]);
    }
    return [...values.values()];
  }, [points]);
  return (
    <BotPanel
      badge="NOT A PORTFOLIO"
      className="panel tw:mt-[18px] tw:mb-4"
      id="curves"
      lede="Closed canonical quote executions, by configuration and session date."
      title="Cumulative R curve"
    >
      {grouped.length === 0 ? (
        <Empty
          loading={loading}
          message="No closed canonical executions for a curve."
        />
      ) : (
        <div
          className={classes(
            "bot-curves tw:grid tw:gap-3 tw:p-[14px]",
            BOT_SCROLL_AREA,
          )}
        >
          {grouped.map((series) => (
            <CurveSeries
              key={`${series[0]!.cohort.profileConfigId}:${series[0]!.cohort.executionModelVersion}`}
              points={series}
            />
          ))}
        </div>
      )}
    </BotPanel>
  );
}

function CurveSeries({
  points,
}: {
  points: Awaited<
    ReturnType<typeof paperCohortCurveListSchema.parse>
  >["points"];
}) {
  const maximum = Math.max(
    ...points.map((point) => Math.abs(point.cumulativeR)),
    1,
  );
  const first = points[0]!;
  return (
    <article className={classes("bot-curve", BOT_CARD)}>
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:px-[15px] tw:py-[14px]">
        <strong>
          {first.cohort.profileName} · {first.cohort.configVersion}
        </strong>
        <span className="tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:text-ink-650">
          {number(points.at(-1)!.cumulativeR)}R over{" "}
          {points.reduce((total, point) => total + point.closedTrades, 0)}{" "}
          closed
        </span>
      </header>
      <div
        className="bot-curve-bars tw:flex tw:h-[92px] tw:items-end tw:gap-[3px] tw:border-y tw:border-y-line-subtle tw:px-[15px] tw:py-2"
        aria-label={`Cumulative R curve for ${first.cohort.profileName}`}
      >
        {points.map((point) => (
          <span
            key={point.sessionDate}
            className={classes(
              "tw:min-w-[4px] tw:flex-[1_1_5px] tw:rounded-t-[2px] tw:bg-current",
              point.cumulativeR >= 0 ? "positive" : "negative",
            )}
            title={`${point.sessionDate}: ${number(point.cumulativeR)}R cumulative; ${point.closedTrades} closed`}
            style={{
              height: `${Math.max(5, (Math.abs(point.cumulativeR) / maximum) * 100)}%`,
            }}
          />
        ))}
      </div>
      <div className="bot-curve-dates tw:m-0 tw:flex tw:justify-between tw:px-[15px] tw:py-[7px] tw:font-mono tw:text-[0.58rem] tw:font-normal tw:leading-[normal] tw:text-ink-700">
        <small>{first.sessionDate}</small>
        <small>{points.at(-1)!.sessionDate}</small>
      </div>
    </article>
  );
}

function QualityPanel({
  aggregates,
  loading,
}: {
  aggregates: PaperCohortAggregate[];
  loading: boolean;
}) {
  return (
    <BotPanel
      badge="QUOTE"
      className="panel tw:mt-[18px] tw:mb-4"
      collapsedByDefault
      id="quality"
      lede="Displayed Level 1 size is normalized to shares at ingest and remains visible as fill-coverage evidence."
      title="Fillability and data quality"
    >
      {aggregates.length === 0 ? (
        <Empty
          loading={loading}
          message="No canonical data-quality evidence matches these filters."
        />
      ) : (
        <div
          className={classes(
            "bot-quality tw:grid tw:gap-3 tw:p-[14px]",
            BOT_SCROLL_AREA,
          )}
        >
          {aggregates.map((aggregate) => (
            <article
              className="tw:rounded-[8px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[15px] tw:py-[13px]"
              key={`${aggregate.cohort.profileConfigId}:${aggregate.cohort.executionModelVersion}`}
            >
              <strong>
                {aggregate.cohort.profileName} ·{" "}
                {aggregate.cohort.configVersion}
              </strong>
              <p className="tw:mt-[7px] tw:mb-0 tw:text-[0.72rem] tw:leading-[1.45] tw:text-ink-500">
                <b>No-fill:</b>{" "}
                {distribution(
                  aggregate.noFillReasons,
                  aggregate.eligibleSignalCount,
                )}
              </p>
              <p className="tw:mt-[7px] tw:mb-0 tw:text-[0.72rem] tw:leading-[1.45] tw:text-ink-500">
                <b>Entry coverage:</b>{" "}
                {distribution(
                  Object.fromEntries(
                    aggregate.sizeCoverage.map((value) => [
                      value.bucket,
                      value.count,
                    ]),
                  ),
                  aggregate.fills,
                )}
              </p>
              <p className="tw:mt-[7px] tw:mb-0 tw:text-[0.72rem] tw:leading-[1.45] tw:text-ink-500">
                <b>Exit coverage:</b>{" "}
                {distribution(
                  Object.fromEntries(
                    aggregate.exitSizeCoverage.map((value) => [
                      value.bucket,
                      value.count,
                    ]),
                  ),
                  aggregate.closedTrades,
                )}
              </p>
              <p className="tw:mt-[7px] tw:mb-0 tw:text-[0.72rem] tw:leading-[1.45] tw:text-ink-500">
                <b>Entry spread:</b> avg{" "}
                {number(aggregate.entrySpread.average, 4)} · range{" "}
                {number(aggregate.entrySpread.minimum, 4)}–
                {number(aggregate.entrySpread.maximum, 4)} · n=
                {aggregate.entrySpread.sampleCount}
              </p>
              <p className="tw:mt-[7px] tw:mb-0 tw:text-[0.72rem] tw:leading-[1.45] tw:text-ink-500">
                <b>Delayed closes:</b> {aggregate.delayedClose.count} /{" "}
                {aggregate.closedTrades} · avg{" "}
                {duration(aggregate.delayedClose.averageDurationMs)}
              </p>
            </article>
          ))}
        </div>
      )}
    </BotPanel>
  );
}

function DivergencePanel({
  values,
  loading,
}: {
  values: Awaited<
    ReturnType<typeof paperModelDivergenceListSchema.parse>
  >["divergences"];
  loading: boolean;
}) {
  return (
    <BotPanel
      badge="PAIRED"
      className="panel tw:mt-[18px] tw:mb-4"
      collapsedByDefault
      id="divergence"
      lede="QUOTE minus CANDLE across paired executions; candle output is supplementary only."
      title="Quote vs one-minute candle divergence"
    >
      {values.length === 0 ? (
        <Empty
          loading={loading}
          message="No paired quote/candle executions match these filters."
        />
      ) : (
        <div className={classes("bot-comparison-table", BOT_SCROLL_AREA)}>
          {values.map((value) => (
            <article
              className="tw:grid tw:min-w-[880px] tw:grid-cols-[1.25fr_repeat(6,minmax(95px,1fr))] tw:gap-[10px] tw:border-b tw:border-b-line-subtle tw:px-[15px] tw:py-[13px] tw:text-[0.68rem] tw:text-ink-500"
              key={`${value.cohort.profileConfigId}:${value.cohort.executionModelVersion}`}
            >
              <strong className="tw:text-ink-150">
                {value.cohort.profileName} · {value.cohort.configVersion}
              </strong>
              <span>
                Pairs {value.pairedExecutions}; closed pairs{" "}
                {value.pairedClosedExecutions}
              </span>
              <span>
                Δ entry {number(value.entryPriceDifference.average, 4)} (n=
                {value.entryPriceDifference.sampleCount})
              </span>
              <span>
                Δ exit {number(value.exitPriceDifference.average, 4)} (n=
                {value.exitPriceDifference.sampleCount})
              </span>
              <span>
                Δ P&L {number(value.netPnlDifference.average)} (n=
                {value.netPnlDifference.sampleCount})
              </span>
              <span>
                Δ R {number(value.rMultipleDifference.average)} (n=
                {value.rMultipleDifference.sampleCount})
              </span>
              <span>Exit mismatch {rate(value.exitReasonMismatch)}</span>
            </article>
          ))}
        </div>
      )}
    </BotPanel>
  );
}

function ComparisonPanel({
  values,
  loading,
}: {
  values: Awaited<
    ReturnType<typeof paperEvidenceComparisonListSchema.parse>
  >["comparisons"];
  loading: boolean;
}) {
  return (
    <BotPanel
      badge="QUOTE · LIVE"
      className="panel tw:mt-[18px] tw:mb-4"
      collapsedByDefault
      id="comparison"
      lede="Only exact profile-evidence provenance with identical model version and assumptions is eligible."
      title="Forward vs backtest expectancy"
    >
      {values.length === 0 ? (
        <Empty
          loading={loading}
          message="No canonical forward cohorts match these filters."
        />
      ) : (
        <div
          className={classes(
            "bot-comparisons tw:grid tw:gap-3 tw:p-[14px]",
            BOT_SCROLL_AREA,
          )}
        >
          {values.map((value) => (
            <article
              className={classes(
                "tw:rounded-[8px] tw:border tw:px-[15px] tw:py-[13px]",
                value.comparable
                  ? "tw:border-line-subtle tw:bg-surface-raised"
                  : "tw:border-line-warn-strong tw:bg-surface-warn",
              )}
              key={`${value.forward.cohort.profileConfigId}:${value.forward.cohort.executionModelVersion}`}
            >
              <strong>
                {value.forward.cohort.profileName} ·{" "}
                {value.forward.cohort.configVersion}
              </strong>
              {value.comparable && value.historical ? (
                <p className="tw:mt-[7px] tw:mb-0 tw:text-[0.72rem] tw:leading-[1.45] tw:text-ink-500">
                  Forward expectancy {number(value.forward.expectancyR)}R (n=
                  {value.forward.closedTrades}) · backtest expectancy{" "}
                  {number(value.historical.expectancyR)}R (n=
                  {value.historical.closedTrades}) · forward win{" "}
                  {rate(value.forward.winRate)} · backtest win{" "}
                  {rate(value.historical.winRate)}
                </p>
              ) : (
                <p className="tw:mt-[7px] tw:mb-0 tw:text-[0.72rem] tw:leading-[1.45] tw:text-ink-500">
                  {value.reason}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </BotPanel>
  );
}
