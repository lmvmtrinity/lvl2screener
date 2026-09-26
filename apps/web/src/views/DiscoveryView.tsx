import {
  dailySeedHistorySchema,
  dailySeedLegacySchema,
  dailySeedStatusSchema,
  universeResponseSchema,
  type CandidateCoverage,
  type DailySeedHistoryEntry,
  type DailySeedLegacy,
  type DailySeedPick,
  type DailySeedRescanStatus,
  type DailySeedSelection,
  type DailySeedStatus,
} from "@tsx-scanner/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/Button.js";
import { StatusBadge, type StatusTone } from "../components/ui/StatusBadge.js";
import { getJson, sendJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { countdown } from "../lib/format.js";
import { isAbortError } from "../lib/research-job.js";
import { useNow } from "../lib/use-now.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";
import { symbolState } from "./UniverseView.js";

type MarketId = "CA_TSX" | "US_EQUITIES";
type Tab = "today" | "history" | "legacy";

const TABS: { key: Tab; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "history", label: "History" },
  { key: "legacy", label: "Legacy engine" },
];
const POLL_MS = 15_000;
const RUNNING_POLL_MS = 2_000;
const ADD_TOP_COUNT = 5;

const CARD =
  "tw:rounded-panel tw:border tw:border-line tw:bg-surface tw:overflow-hidden";
const CARD_TITLE = "tw:m-0 tw:text-[0.95rem] tw:font-semibold tw:text-ink-100";
const LABEL =
  "tw:font-mono tw:text-[0.63rem] tw:tracking-[0.12em] tw:text-ink-450";
const MUTED = "tw:text-[0.8rem] tw:text-ink-400";

/* Score parts, in table and legend order, with the scorer's weights. */
const PARTS = [
  { key: "volume", label: "Relative volume", weight: 40, bar: "tw:bg-accent" },
  { key: "atr", label: "ATR%", weight: 20, bar: "tw:bg-warn-dim" },
  {
    key: "close",
    label: "Close near high",
    weight: 25,
    bar: "tw:bg-accent-tint",
  },
  {
    key: "trend",
    label: "Above 20-day mean",
    weight: 15,
    bar: "tw:bg-ink-500",
  },
] as const;
type PartKey = (typeof PARTS)[number]["key"];

/** Splits a pick's score into the scorer's four parts. ATR% is the remainder,
 *  because its floor depends on the market policy. */
export function scoreParts(pick: DailySeedPick): Record<PartKey, number> {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const volume = 40 * clamp((pick.relativeVolume - 0.5) / 2.5);
  const close = 25 * clamp(pick.closeLocation);
  const trend = pick.aboveSma20 ? 15 : 0;
  const atr = Math.min(20, Math.max(0, pick.score - volume - close - trend));
  return { volume, atr, close, trend };
}

function timezoneFor(marketId: MarketId): string {
  return marketId === "CA_TSX" ? "America/Toronto" : "America/New_York";
}

function marketTime(value: string | null | undefined, marketId: MarketId) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezoneFor(marketId),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function marketDay(value: string | null | undefined, marketId: MarketId) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezoneFor(marketId),
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function longDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shortDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const count = (value: number) => value.toLocaleString("en-US");

function badgeTone(tone: string): StatusTone {
  if (tone === "ok") return "ok";
  if (tone === "warn") return "warn";
  if (tone === "bad") return "danger";
  return "neutral";
}

type HeroState =
  | { kind: "off" }
  | { kind: "closed" }
  | { kind: "scheduled" }
  | { kind: "running" }
  | { kind: "applied" }
  | { kind: "kept" }
  | { kind: "failed" }
  | { kind: "missed" };

function heroState(status: DailySeedStatus, now: Date): HeroState {
  if (status.running?.apply) return { kind: "running" };
  const result = status.lastResult;
  if (result?.status === "APPLIED") return { kind: "applied" };
  if (result?.status === "SKIPPED_LIST_PRESENT") return { kind: "kept" };
  if (result?.status === "FAILED" || result?.status === "NO_PICKS")
    return { kind: "failed" };
  if (!status.enabled) return { kind: "off" };
  if (!status.session) return { kind: "closed" };
  if (
    status.latestRunAt &&
    now.getTime() > Date.parse(status.latestRunAt) &&
    !status.running
  )
    return { kind: "missed" };
  if (status.running) return { kind: "running" };
  return { kind: "scheduled" };
}

function Pill({
  tone,
  children,
}: {
  tone: "ok" | "accent" | "muted" | "danger";
  children: ReactNode;
}) {
  const tones = {
    ok: "tw:border-[#2f5a3c] tw:bg-[#10200f] tw:text-gain",
    accent: "tw:border-line-accent-strong tw:bg-surface-warn tw:text-accent",
    muted: "tw:border-line-input tw:bg-transparent tw:text-ink-300",
    danger:
      "tw:border-line-danger-strong tw:bg-transparent tw:text-danger-soft",
  };
  return (
    <span
      className={classes(
        "tw:inline-flex tw:items-center tw:gap-1.5 tw:rounded-full tw:border tw:px-2.5 tw:py-1 tw:font-mono tw:text-[0.68rem] tw:font-bold tw:tracking-[0.1em]",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

function Funnel({
  selection,
  marketId,
}: {
  selection: DailySeedSelection;
  marketId: MarketId;
}) {
  const pool = Math.max(1, selection.poolSize);
  const steps = [
    {
      label: "POOL",
      value: selection.poolSize,
      note: marketId === "CA_TSX" ? "mapped TSX stocks" : "mapped US stocks",
    },
    {
      label: "LIQUIDITY FILTER",
      value: selection.prefiltered,
      note: "price, cap, volume",
    },
    {
      label: "SCORED",
      value: selection.scored,
      note: "passed ATR and history",
    },
    {
      label: "PICKED",
      value: selection.picks.length,
      note: `top scores · ${Math.round(selection.durationMs / 1000)} s · ~${count(selection.requests)} requests`,
    },
  ];
  return (
    <div className="tw:grid tw:grid-cols-4 tw:gap-px tw:overflow-hidden tw:rounded-[10px] tw:border tw:border-line tw:bg-line tw:below-720:grid-cols-2">
      {steps.map((step, index) => (
        <div
          key={step.label}
          className="tw:flex tw:flex-col tw:gap-1.5 tw:bg-surface-sunken tw:px-4 tw:py-3.5"
        >
          <span className={LABEL}>{step.label}</span>
          <span
            className={classes(
              "tw:text-[1.5rem] tw:font-semibold tw:tabular-nums",
              index === 3 ? "tw:text-accent-tint" : "tw:text-ink-100",
            )}
          >
            {count(step.value)}
          </span>
          <span className="tw:text-[0.75rem] tw:text-ink-400">{step.note}</span>
          <span
            className={classes(
              "tw:block tw:h-1 tw:rounded-sm",
              index === 3 ? "tw:bg-accent-tint" : "tw:bg-accent",
            )}
            style={{
              width: `${Math.max(2, (step.value / pool) * 100)}%`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

/** Timeline marks laid out over the seed-to-close window. Labels closer than
 *  LABEL_GAP percent to the previous one in a row drop to the next row. */
const LABEL_GAP = 12;
const WINDOW_PADDING_MS = 60 * 60_000;

export function timelineMarks(status: DailySeedStatus, now: Date) {
  if (!status.session) return null;
  const { marketId } = status;
  const anchors = [
    status.scheduledAt && {
      at: status.scheduledAt,
      label: "seed",
      tone: "gain",
    },
    { at: status.session.open, label: "open", tone: "accent" },
    status.rescan?.enabled &&
      status.rescan.scheduledAt && {
        at: status.rescan.scheduledAt,
        label: "rescan",
        tone: "rescan",
      },
    status.latestRunAt && {
      at: status.latestRunAt,
      label: "last retry",
      tone: "dim",
    },
    { at: status.session.close, label: "close", tone: "dim" },
  ].filter(Boolean) as { at: string; label: string; tone: string }[];
  const times = anchors.map((mark) => Date.parse(mark.at));
  const start = Math.min(...times) - WINDOW_PADDING_MS;
  const end = Math.max(...times) + WINDOW_PADDING_MS;
  const percent = (time: number) =>
    Math.min(100, Math.max(0, ((time - start) / (end - start)) * 100));
  const nowTime = now.getTime();
  const marks = [
    ...anchors.map((mark) => ({
      ...mark,
      percent: percent(Date.parse(mark.at)),
      time: marketTime(mark.at, marketId),
    })),
    {
      at: now.toISOString(),
      label: "now",
      tone: "now",
      percent: percent(nowTime),
      time: marketTime(now.toISOString(), marketId),
    },
  ].sort((left, right) => left.percent - right.percent);
  const lastInRow: number[] = [];
  const placed = marks.map((mark) => {
    let row = 0;
    while (
      lastInRow[row] !== undefined &&
      mark.percent - lastInRow[row]! < LABEL_GAP
    )
      row += 1;
    lastInRow[row] = mark.percent;
    return { ...mark, row };
  });
  return { marks: placed, nowPercent: percent(nowTime) };
}

function DayTimeline({ status, now }: { status: DailySeedStatus; now: Date }) {
  const layout = timelineMarks(status, now);
  if (!layout) return null;
  const rows = Math.max(...layout.marks.map((mark) => mark.row)) + 1;
  const dot: Record<string, string> = {
    gain: "tw:bg-gain",
    accent: "tw:bg-accent",
    dim: "tw:bg-line-dim",
    rescan: "tw:bg-warn-soft",
  };
  const text: Record<string, string> = {
    gain: "tw:text-gain",
    accent: "tw:text-accent-tint",
    dim: "tw:text-ink-300",
    now: "tw:text-accent-tint",
    rescan: "tw:text-warn-soft",
  };
  const align = (percent: number) =>
    percent < 6
      ? "tw:translate-x-0"
      : percent > 94
        ? "tw:-translate-x-full tw:text-right"
        : "tw:-translate-x-1/2";
  return (
    <div
      className="tw:flex tw:flex-col tw:gap-2"
      aria-label="Seed day timeline"
    >
      <div className="tw:relative tw:h-7">
        <span className="tw:absolute tw:inset-x-0 tw:top-[13px] tw:h-0.5 tw:bg-line" />
        <span
          className="tw:absolute tw:left-0 tw:top-[13px] tw:h-0.5 tw:bg-line-accent-strong"
          style={{ width: `${layout.nowPercent}%` }}
        />
        {layout.marks
          .filter((mark) => mark.tone !== "now")
          .map((mark) => (
            <span
              key={mark.label}
              className={classes(
                "tw:absolute tw:top-2 tw:h-3 tw:w-3 tw:-translate-x-1/2 tw:rounded-full",
                dot[mark.tone],
              )}
              style={{ left: `${mark.percent}%` }}
            />
          ))}
        <span
          className="tw:absolute tw:top-1 tw:h-5 tw:w-0.5 tw:bg-accent-tint"
          style={{ left: `${layout.nowPercent}%` }}
          aria-hidden="true"
        />
      </div>
      <div
        className="tw:relative tw:text-[0.75rem] tw:text-ink-400"
        style={{ height: `${rows * 2.4}rem` }}
      >
        {layout.marks.map((mark) => (
          <span
            key={mark.label}
            className={classes(
              "tw:absolute tw:whitespace-nowrap",
              align(mark.percent),
            )}
            style={{ left: `${mark.percent}%`, top: `${mark.row * 2.4}rem` }}
          >
            <span className={classes("tw:block tw:font-mono", text[mark.tone])}>
              {mark.time}
            </span>
            {mark.label}
          </span>
        ))}
      </div>
      <span className="tw:text-[0.72rem] tw:text-ink-450">
        The daily list resets at midnight; the seed fills it only while it is
        empty.
      </span>
    </div>
  );
}

function SeedHero({
  status,
  now,
  busy,
  onPreview,
  onRun,
  onAddTop,
}: {
  status: DailySeedStatus;
  now: Date;
  busy: boolean;
  onPreview: () => void;
  onRun: () => void;
  onAddTop: () => void;
}) {
  const { marketId } = status;
  const state = heroState(status, now);
  const result = status.lastResult;
  const selection = status.latestSelection ?? result?.selection ?? null;
  const running = status.running;
  const at = (value: string | null | undefined) =>
    `${marketTime(value, marketId)} ET`;
  const previewing = running && !running.apply;

  let pill: ReactNode;
  let title: string;
  let body: ReactNode;
  let actions: ReactNode = null;
  let frame = "tw:border-line tw:bg-surface";
  switch (state.kind) {
    case "applied":
      frame = "tw:border-line-accent tw:bg-surface-olive";
      pill = (
        <Pill tone="ok">
          APPLIED {marketTime(result?.finishedAt, marketId)}
        </Pill>
      );
      title = `${result?.symbols.length ?? 0} stocks added to an empty daily list`;
      body = `Ranked from the previous session. They warm up before the open and scan from ${marketTime(status.session?.open, marketId)}. A list pasted before ${status.runAt} is left alone.`;
      actions = (
        <Button variant="secondary" onClick={onPreview} disabled={busy}>
          Preview ranking
        </Button>
      );
      break;
    case "kept":
      pill = <Pill tone="muted">KEPT YOUR LIST</Pill>;
      title = `Your ${result?.symbols.length ?? 0} symbols were already in place`;
      body =
        "The seed skipped today. Preview its ranking to compare with your picks, or add the top names to your list.";
      actions = (
        <>
          <Button variant="secondary" onClick={onPreview} disabled={busy}>
            Preview ranking
          </Button>
          <Button
            variant="secondary"
            onClick={onAddTop}
            disabled={busy || !status.latestSelection?.picks.length}
          >
            Add top {ADD_TOP_COUNT} to my list
          </Button>
        </>
      );
      break;
    case "failed":
      frame = "tw:border-line-danger tw:bg-surface-danger";
      pill = (
        <Pill tone="danger">
          {result?.status === "NO_PICKS" ? "NO PICKS" : "FAILED"} · ATTEMPT{" "}
          {status.attempts} OF {status.maxAttempts}
        </Pill>
      );
      title =
        result?.status === "NO_PICKS"
          ? "No stock passed the filters"
          : "The seed could not finish";
      body = (
        <>
          {result?.error && (
            <span className="tw:block tw:font-mono tw:text-[0.75rem] tw:text-danger-tint-soft">
              {result.error}
            </span>
          )}
          {status.nextAttemptAt &&
          status.attempts < status.maxAttempts &&
          status.latestRunAt &&
          Date.parse(status.nextAttemptAt) <= Date.parse(status.latestRunAt)
            ? `Next attempt ${at(status.nextAttemptAt)}.`
            : "No more automatic attempts today. Retry now or paste a list."}
        </>
      );
      actions = (
        <Button variant="primary" onClick={onRun} disabled={busy}>
          Retry now
        </Button>
      );
      break;
    case "running":
      frame = "tw:border-line-accent tw:bg-surface-olive";
      pill = <Pill tone="accent">RANKING</Pill>;
      title =
        running?.phase === "CANDLES"
          ? `Checking daily history for ${count(running.total)} stocks`
          : running?.phase === "APPLYING"
            ? "Adding picks to the daily list"
            : "Screening the symbol pool";
      body = null;
      break;
    case "scheduled":
      pill = <Pill tone="muted">SCHEDULED</Pill>;
      title = `Seeding ${countdown(now, status.scheduledAt) ?? "soon"}`;
      body = `The daily list is empty. At ${at(status.scheduledAt)} the selector ranks the previous session's liquid movers and adds the top ${status.count}.`;
      actions = (
        <>
          <Button variant="primary" onClick={onPreview} disabled={busy}>
            Preview ranking
          </Button>
          <Button variant="secondary" onClick={onRun} disabled={busy}>
            Seed now
          </Button>
        </>
      );
      break;
    case "missed":
      pill = <Pill tone="muted">NOT SEEDED</Pill>;
      title = "Too late to seed today";
      body = `Seeding stops at ${at(status.latestRunAt)} so picks can warm up. Next run ${marketDay(status.nextRunAt, marketId)} ET.`;
      actions = (
        <Button variant="secondary" onClick={onPreview} disabled={busy}>
          Preview ranking
        </Button>
      );
      break;
    case "closed":
      pill = <Pill tone="muted">NO SESSION</Pill>;
      title = "Market closed today";
      body = `Next seed ${marketDay(status.nextRunAt, marketId)} ET.`;
      actions = (
        <Button variant="secondary" onClick={onPreview} disabled={busy}>
          Preview ranking
        </Button>
      );
      break;
    case "off":
      pill = <Pill tone="muted">SEED OFF</Pill>;
      title = "The pre-market seed is turned off";
      body =
        "Set DAILY_LIST_SEED_ENABLED=true to fill an empty list before the open. You can still preview the ranking.";
      actions = (
        <Button variant="secondary" onClick={onPreview} disabled={busy}>
          Preview ranking
        </Button>
      );
      break;
  }

  return (
    <section
      aria-label="Today's seed"
      className={classes(
        "tw:flex tw:flex-col tw:gap-5 tw:rounded-panel tw:border tw:px-6 tw:py-6 tw:below-md:px-4",
        frame,
      )}
    >
      <div className="tw:flex tw:flex-wrap tw:items-start tw:justify-between tw:gap-6">
        <div className="tw:flex tw:min-w-0 tw:max-w-[680px] tw:flex-col tw:gap-2">
          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2.5">
            {pill}
            <span className={LABEL}>{status.version.toUpperCase()}</span>
          </div>
          <h2 className="tw:m-0 tw:text-[1.35rem] tw:font-semibold tw:text-ink-50">
            {title}
          </h2>
          {body && (
            <p className="tw:m-0 tw:text-[0.88rem] tw:leading-normal tw:text-ink-300">
              {body}
            </p>
          )}
        </div>
        {actions && (
          <div className="tw:flex tw:flex-wrap tw:gap-2">{actions}</div>
        )}
      </div>

      {running && (
        <div className="tw:flex tw:flex-col tw:gap-2" aria-live="polite">
          <div className="tw:h-2 tw:overflow-hidden tw:rounded tw:bg-surface-sunken">
            <div
              className="tw:h-2 tw:bg-accent tw:transition-[width]"
              style={{
                width: `${running.total ? Math.round((running.checked / running.total) * 100) : 4}%`,
              }}
            />
          </div>
          <div className="tw:flex tw:justify-between tw:text-[0.75rem] tw:text-ink-400">
            <span>
              {previewing ? "Previewing · " : ""}Pool {count(running.poolSize)}{" "}
              → liquidity filter {count(running.prefiltered)} →{" "}
              {count(running.checked)} checked
            </span>
            <span className="tw:font-mono">
              {running.total
                ? Math.round((running.checked / running.total) * 100)
                : 0}
              %
            </span>
          </div>
        </div>
      )}

      {selection && !running && (
        <Funnel selection={selection} marketId={marketId} />
      )}
      <DayTimeline status={status} now={now} />
    </section>
  );
}

function ScoreBar({ pick }: { pick: DailySeedPick }) {
  const parts = scoreParts(pick);
  return (
    <span
      className="tw:flex tw:h-2 tw:flex-1 tw:overflow-hidden tw:rounded tw:bg-surface-sunken"
      aria-hidden="true"
    >
      {PARTS.map((part) => (
        <span
          key={part.key}
          className={classes("tw:block tw:h-2", part.bar)}
          style={{ width: `${parts[part.key]}%` }}
        />
      ))}
    </span>
  );
}

const PICK_GRID =
  "tw:grid tw:grid-cols-[32px_84px_minmax(0,1fr)_60px_60px_68px_110px] tw:items-center tw:gap-3 tw:below-900:grid-cols-[28px_72px_minmax(0,1fr)_56px_96px]";

function PicksTable({
  selection,
  coverage,
  onList,
  selected,
  onSelect,
  title,
}: {
  selection: DailySeedSelection;
  coverage: Map<string, CandidateCoverage>;
  onList: Set<string>;
  selected: string | null;
  onSelect: (symbol: string) => void;
  title: string;
}) {
  return (
    <section aria-label="Picks" className={CARD}>
      <div className="tw:flex tw:items-center tw:justify-between tw:border-b tw:border-line tw:px-5 tw:py-4">
        <h3 className={CARD_TITLE}>{title}</h3>
        <span className={LABEL}>SORTED BY SCORE</span>
      </div>
      <div
        className={classes(
          PICK_GRID,
          "tw:border-b tw:border-line-subtle tw:px-5 tw:py-2.5",
          LABEL,
        )}
      >
        <span>#</span>
        <span>SYMBOL</span>
        <span>SCORE</span>
        <span className="tw:text-right">RVOL</span>
        <span className="tw:text-right tw:below-900:hidden">ATR%</span>
        <span className="tw:text-right tw:below-900:hidden">CHG</span>
        <span>SCANNER</span>
      </div>
      {selection.picks.map((pick, index) => {
        const state = onList.has(pick.symbol)
          ? symbolState(undefined, coverage.get(pick.symbol), undefined)
          : null;
        return (
          <button
            key={pick.symbol}
            type="button"
            aria-pressed={selected === pick.symbol}
            onClick={() => onSelect(pick.symbol)}
            className={classes(
              PICK_GRID,
              "tw:w-full tw:cursor-pointer tw:border-0 tw:border-b tw:border-line-subtle tw:bg-transparent tw:px-5 tw:py-2.5 tw:text-left tw:text-[0.82rem] tw:tabular-nums tw:text-ink-200 tw:hover:bg-surface-raised tw:aria-pressed:bg-surface-raised",
            )}
          >
            <span className="tw:font-mono tw:text-[0.75rem] tw:text-ink-450">
              {index + 1}
            </span>
            <span className="tw:font-mono tw:font-bold tw:text-ink-50">
              {pick.symbol}
            </span>
            <span className="tw:flex tw:items-center tw:gap-2.5">
              <ScoreBar pick={pick} />
              <span className="tw:w-9 tw:text-right tw:font-semibold tw:text-ink-100">
                {pick.score.toFixed(1)}
              </span>
            </span>
            <span className="tw:text-right tw:text-ink-300">
              {pick.relativeVolume.toFixed(2)}×
            </span>
            <span className="tw:text-right tw:text-ink-300 tw:below-900:hidden">
              {pick.atrPct.toFixed(1)}%
            </span>
            <span
              className={classes(
                "tw:text-right tw:below-900:hidden",
                pick.changePct >= 0 ? "tw:text-gain" : "tw:text-danger",
              )}
            >
              {pick.changePct >= 0 ? "+" : ""}
              {pick.changePct.toFixed(1)}%
            </span>
            <span>
              {state ? (
                <StatusBadge tone={badgeTone(state.tone)}>
                  {state.label}
                </StatusBadge>
              ) : (
                <StatusBadge tone="muted">Not on list</StatusBadge>
              )}
            </span>
          </button>
        );
      })}
      <div className="tw:flex tw:flex-wrap tw:gap-x-5 tw:gap-y-2 tw:px-5 tw:py-3 tw:text-[0.75rem] tw:text-ink-400">
        {PARTS.map((part) => (
          <span key={part.key} className="tw:flex tw:items-center tw:gap-1.5">
            <span
              className={classes("tw:h-2.5 tw:w-2.5 tw:rounded-sm", part.bar)}
            />
            {part.label} · {part.weight}
          </span>
        ))}
      </div>
    </section>
  );
}

function pickSentence(pick: DailySeedPick): string {
  const where =
    pick.closeLocation >= 0.75
      ? "closed near the high"
      : pick.closeLocation <= 0.25
        ? "closed near the low"
        : "closed mid-range";
  const move = `${pick.changePct >= 0 ? "up" : "down"} ${Math.abs(pick.changePct).toFixed(1)}%`;
  const trend = pick.aboveSma20 ? "above" : "below";
  return `Traded ${pick.relativeVolume.toFixed(1)}× its usual volume and ${where}, ${move}, ${trend} its 20-day mean. ATR is ${pick.atrPct.toFixed(1)}% of price.`;
}

function PickDetail({
  pick,
  onOpenSymbol,
}: {
  pick: DailySeedPick;
  onOpenSymbol?: (symbol: string) => void;
}) {
  const parts = scoreParts(pick);
  return (
    <section
      aria-label="Selected stock"
      className={classes(CARD, "tw:flex tw:flex-col tw:gap-3 tw:px-5 tw:py-4")}
    >
      <div className="tw:flex tw:items-baseline tw:justify-between">
        <h3 className="tw:m-0 tw:font-mono tw:text-[0.95rem] tw:font-bold tw:text-ink-50">
          {pick.symbol}
        </h3>
        <span className="tw:text-[1.35rem] tw:font-semibold tw:text-accent-tint">
          {pick.score.toFixed(1)}
        </span>
      </div>
      <p className="tw:m-0 tw:text-[0.82rem] tw:leading-normal tw:text-ink-300">
        {pickSentence(pick)}
      </p>
      <div className="tw:flex tw:flex-col tw:gap-2 tw:text-[0.75rem]">
        {PARTS.map((part) => (
          <div
            key={part.key}
            className="tw:grid tw:grid-cols-[112px_minmax(0,1fr)_32px] tw:items-center tw:gap-2"
          >
            <span className="tw:text-ink-400">{part.label}</span>
            <span className="tw:h-1.5 tw:rounded-sm tw:bg-surface-sunken">
              <span
                className={classes("tw:block tw:h-1.5 tw:rounded-sm", part.bar)}
                style={{ width: `${(parts[part.key] / part.weight) * 100}%` }}
              />
            </span>
            <span className="tw:text-right tw:text-ink-100">
              {Math.round(parts[part.key])}
            </span>
          </div>
        ))}
      </div>
      {onOpenSymbol && (
        <Button
          variant="link"
          className="tw:self-start"
          onClick={() => onOpenSymbol(pick.symbol)}
        >
          Open in scanner →
        </Button>
      )}
    </section>
  );
}

function RescanCard({
  rescan,
  marketId,
  now,
  busy,
  onRun,
}: {
  rescan: DailySeedRescanStatus;
  marketId: MarketId;
  now: Date;
  busy: boolean;
  onRun: () => void;
}) {
  const result = rescan.result;
  const at = (value: string | null | undefined) =>
    `${marketTime(value, marketId)} ET`;
  let pill: ReactNode;
  let title: string;
  let body: string;
  if (rescan.running) {
    pill = <Pill tone="accent">RESCANNING</Pill>;
    title = `Reading opening bars for ${count(rescan.running.total)} stocks`;
    body = `${count(rescan.running.checked)} checked so far.`;
  } else if (result?.status === "APPLIED") {
    pill = (
      <Pill tone="ok">ADDED {marketTime(result.finishedAt, marketId)}</Pill>
    );
    title = `${result.added.length} opening ${result.added.length === 1 ? "mover" : "movers"} added: ${result.added.join(", ")}`;
    body = `From ${count(result.evaluated)} liquid stocks, using bars through ${at(result.barsThrough)}.`;
  } else if (result?.status === "NO_PICKS") {
    pill = <Pill tone="muted">NO MOVERS</Pill>;
    title = "No stock cleared both opening thresholds";
    body = `Checked ${count(result.evaluated)} liquid stocks with bars through ${at(result.barsThrough)}.`;
  } else if (result?.status === "SKIPPED_LIST_PRESENT") {
    pill = <Pill tone="muted">KEPT YOUR LIST</Pill>;
    title = "Your list was left unchanged";
    body = "The rescan only adds to a list the pre-market seed filled.";
  } else if (result?.status === "FAILED") {
    pill = <Pill tone="danger">FAILED</Pill>;
    title = "The rescan could not finish";
    body = result.error ?? "";
  } else if (!rescan.enabled) {
    pill = <Pill tone="muted">OFF</Pill>;
    title = "The early-session rescan is turned off";
    body =
      "Set DAILY_LIST_RESCAN_ENABLED=true to add opening movers after the open.";
  } else if (!rescan.scheduledAt) {
    pill = <Pill tone="muted">NO SESSION</Pill>;
    title = "No rescan today";
    body = "The market is closed today.";
  } else if (
    rescan.latestRunAt &&
    now.getTime() > Date.parse(rescan.latestRunAt)
  ) {
    pill = <Pill tone="muted">NOT RUN</Pill>;
    title = "No rescan ran today";
    body = `Its window closed at ${at(rescan.latestRunAt)}.`;
  } else {
    pill = <Pill tone="muted">SCHEDULED</Pill>;
    title = `Rescanning ${countdown(now, rescan.scheduledAt) ?? "soon"}`;
    body = `At ${at(rescan.scheduledAt)} it adds up to ${rescan.maxAdds} stocks that are trading heavily and rising since the open.`;
  }
  const thresholds = result?.thresholds;
  const grid =
    "tw:grid tw:grid-cols-[84px_repeat(3,minmax(0,1fr))_96px] tw:gap-3";
  return (
    <section
      aria-label="Early-session rescan"
      className={classes(CARD, "tw:flex tw:flex-col tw:gap-4 tw:px-5 tw:py-5")}
    >
      <div className="tw:flex tw:flex-wrap tw:items-start tw:justify-between tw:gap-4">
        <div className="tw:flex tw:min-w-0 tw:flex-col tw:gap-1.5">
          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2.5">
            {pill}
            <span className={LABEL}>
              EARLY-SESSION RESCAN · {rescan.version.toUpperCase()}
            </span>
          </div>
          <h3 className="tw:m-0 tw:text-[1.05rem] tw:font-semibold tw:text-ink-50">
            {title}
          </h3>
          {body && (
            <p className="tw:m-0 tw:text-[0.82rem] tw:leading-normal tw:text-ink-300">
              {body}
            </p>
          )}
        </div>
        {rescan.enabled && (
          <Button variant="secondary" onClick={onRun} disabled={busy}>
            Rescan now
          </Button>
        )}
      </div>
      {result && result.candidates.length > 0 && (
        <div className="tw:flex tw:flex-col">
          <div
            className={classes(
              grid,
              "tw:border-b tw:border-line-subtle tw:pb-2",
              LABEL,
            )}
          >
            <span>SYMBOL</span>
            <span className="tw:text-right">VOLUME VS USUAL</span>
            <span className="tw:text-right">SINCE OPEN</span>
            <span className="tw:text-right">GAP</span>
            <span>RESULT</span>
          </div>
          {result.candidates.map((candidate) => (
            <div
              key={candidate.symbol}
              className={classes(
                grid,
                "tw:items-center tw:border-b tw:border-line-subtle tw:py-2 tw:text-[0.82rem] tw:tabular-nums",
              )}
            >
              <span className="tw:font-mono tw:font-bold tw:text-ink-50">
                {candidate.symbol}
              </span>
              <span className="tw:text-right tw:text-ink-200">
                {candidate.relativeVolume.toFixed(2)}×
              </span>
              <span
                className={classes(
                  "tw:text-right",
                  candidate.changeFromOpenPct >= 0
                    ? "tw:text-gain"
                    : "tw:text-danger",
                )}
              >
                {candidate.changeFromOpenPct >= 0 ? "+" : ""}
                {candidate.changeFromOpenPct.toFixed(2)}%
              </span>
              <span className="tw:text-right tw:text-ink-300">
                {candidate.gapPct === null
                  ? "—"
                  : `${candidate.gapPct >= 0 ? "+" : ""}${candidate.gapPct.toFixed(2)}%`}
              </span>
              <span>
                {candidate.added ? (
                  <StatusBadge tone="ok">Added</StatusBadge>
                ) : candidate.passed ? (
                  <StatusBadge tone="neutral">Passed</StatusBadge>
                ) : (
                  <StatusBadge tone="muted">Below</StatusBadge>
                )}
              </span>
            </div>
          ))}
          {thresholds && (
            <p className={classes("tw:m-0 tw:pt-3", MUTED)}>
              Passing needs at least {thresholds.minimumRelativeVolume}× the
              usual volume for these minutes and +
              {thresholds.minimumChangeFromOpenPct}% since the open.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ScheduleCard({ status }: { status: DailySeedStatus }) {
  const { marketId } = status;
  const rows: [string, ReactNode][] = [
    ["Runs at", `${status.runAt} ET`],
    ["Picks", `${status.count}`],
    ["Only when", "the list is empty"],
    ["Retries", `every 15 min, ${status.maxAttempts}×`],
    [
      "Next run",
      status.nextRunAt ? `${marketDay(status.nextRunAt, marketId)} ET` : "—",
    ],
  ];
  return (
    <section
      aria-label="Schedule"
      className={classes(CARD, "tw:flex tw:flex-col tw:gap-3 tw:px-5 tw:py-4")}
    >
      <h3 className={CARD_TITLE}>Schedule</h3>
      <dl className="tw:m-0 tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:gap-x-4 tw:gap-y-2 tw:text-[0.82rem]">
        {rows.map(([label, value]) => (
          <div key={label} className="tw:contents">
            <dt className="tw:text-ink-400">{label}</dt>
            <dd className="tw:m-0 tw:text-right tw:text-ink-100">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function HistoryTab({
  entries,
  marketId,
}: {
  entries: DailySeedHistoryEntry[] | null;
  marketId: MarketId;
}) {
  const grid =
    "tw:grid tw:grid-cols-[120px_150px_60px_90px_110px_130px_minmax(0,1fr)] tw:items-center tw:gap-3.5 tw:below-900:grid-cols-[100px_120px_70px_minmax(0,1fr)]";
  const outcome = (entry: DailySeedHistoryEntry) => {
    if (entry.status === "APPLIED")
      return (
        <StatusBadge tone="ok">
          Applied {marketTime(entry.finishedAt, marketId)}
        </StatusBadge>
      );
    if (entry.status === "SKIPPED_LIST_PRESENT")
      return <StatusBadge tone="neutral">Kept your list</StatusBadge>;
    if (entry.status === "NO_PICKS")
      return <StatusBadge tone="warn">No picks</StatusBadge>;
    return <StatusBadge tone="danger">Failed</StatusBadge>;
  };
  return (
    <section aria-label="Seed history" className={CARD}>
      <div className="tw:flex tw:flex-col tw:gap-1 tw:border-b tw:border-line tw:px-5 tw:py-4">
        <h2 className={CARD_TITLE}>History</h2>
        <p className={classes("tw:m-0", MUTED)}>
          One row per trading day: what the list held, how many of those symbols
          reached READY, and the quote-model paper result. Outcomes fill in
          after the close.
        </p>
      </div>
      <div
        className={classes(
          grid,
          "tw:border-b tw:border-line-subtle tw:px-5 tw:py-2.5",
          LABEL,
        )}
      >
        <span>DATE</span>
        <span>OUTCOME</span>
        <span className="tw:text-right">LIST</span>
        <span className="tw:text-right">READY</span>
        <span className="tw:text-right tw:below-900:hidden">PAPER R</span>
        <span className="tw:text-right tw:below-900:hidden">RESCAN</span>
        <span className="tw:below-900:hidden">SYMBOLS</span>
      </div>
      {entries === null ? (
        <p className={classes("tw:m-0 tw:px-5 tw:py-6", MUTED)}>Loading…</p>
      ) : entries.length === 0 ? (
        <div className="tw:flex tw:flex-col tw:items-center tw:gap-2 tw:px-5 tw:py-12 tw:text-center">
          <p className="tw:m-0 tw:text-[0.88rem] tw:text-ink-300">
            No seed has run for this market yet.
          </p>
          <p className={classes("tw:m-0 tw:max-w-[460px]", MUTED)}>
            After a few sessions this table compares seeded days with your own
            lists.
          </p>
        </div>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.id}
            className={classes(
              grid,
              "tw:border-b tw:border-line-subtle tw:px-5 tw:py-3 tw:text-[0.82rem] tw:tabular-nums",
            )}
          >
            <span className="tw:font-mono tw:text-ink-100">
              {shortDate(entry.tradingDate)}
            </span>
            <span>{outcome(entry)}</span>
            <span className="tw:text-right tw:text-ink-100">
              {entry.symbols.length || "—"}
            </span>
            <span className="tw:text-right tw:text-ink-300">
              {entry.outcomes ? entry.outcomes.readySymbols : "after close"}
            </span>
            <span
              className={classes(
                "tw:text-right tw:below-900:hidden",
                !entry.outcomes || entry.outcomes.paperNetR === null
                  ? "tw:text-ink-400"
                  : entry.outcomes.paperNetR >= 0
                    ? "tw:text-gain"
                    : "tw:text-danger",
              )}
            >
              {!entry.outcomes
                ? "after close"
                : entry.outcomes.paperNetR === null
                  ? "no trades"
                  : `${entry.outcomes.paperNetR >= 0 ? "+" : ""}${entry.outcomes.paperNetR.toFixed(2)} R · ${entry.outcomes.paperTrades}`}
            </span>
            <span className="tw:text-right tw:text-ink-300 tw:below-900:hidden">
              {entry.rescanSymbols.length === 0
                ? "—"
                : !entry.rescanOutcomes
                  ? `+${entry.rescanSymbols.length}`
                  : entry.rescanOutcomes.paperNetR === null
                    ? `+${entry.rescanSymbols.length} · no trades`
                    : `+${entry.rescanSymbols.length} · ${entry.rescanOutcomes.paperNetR >= 0 ? "+" : ""}${entry.rescanOutcomes.paperNetR.toFixed(2)} R`}
            </span>
            <span className="tw:truncate tw:font-mono tw:text-[0.75rem] tw:text-ink-300 tw:below-900:hidden">
              {entry.error ?? entry.symbols.slice(0, 6).join(" · ")}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

function LegacyTab({ legacy }: { legacy: DailySeedLegacy | null }) {
  if (!legacy)
    return <p className={classes("tw:m-0", MUTED)}>Loading legacy facts…</p>;
  const first = legacy.markets
    .map((market) => market.firstRunAt)
    .filter(Boolean)
    .sort()[0];
  const last = legacy.markets
    .map((market) => market.lastRunAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const day = (value: string | null | undefined) =>
    value
      ? new Date(value).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })
      : "—";
  const off = legacy.markets.every((market) => market.mode === "OFF");
  const facts: [string, string][] = [
    ["Shadow runs", `${day(first)} – ${day(last)}`],
    [
      "Evaluations",
      legacy.evaluationsEstimate >= 1_000_000
        ? `~${(legacy.evaluationsEstimate / 1_000_000).toFixed(1)} M`
        : count(legacy.evaluationsEstimate),
    ],
    ["Pass or fail decisions", count(legacy.decisions)],
    ["Retained data", `${(legacy.retainedBytes / 1024 ** 3).toFixed(1)} GB`],
    ["Still used for", "the seed's symbol pool"],
  ];
  return (
    <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] tw:items-start tw:gap-5 tw:below-900:grid-cols-1">
      <section
        aria-label="Legacy engine"
        className={classes(
          CARD,
          "tw:flex tw:flex-col tw:gap-3.5 tw:px-5 tw:py-5",
        )}
      >
        <div className="tw:flex tw:items-center tw:justify-between">
          <h2 className={CARD_TITLE}>Full-catalog engine</h2>
          <Pill tone={off ? "muted" : "danger"}>
            {off ? "FROZEN · OFF" : "FROZEN · NOT OFF"}
          </Pill>
        </div>
        <p className="tw:m-0 tw:text-[0.88rem] tw:leading-normal tw:text-ink-300">
          Screened the whole exchange catalog every five minutes. It never
          reached a pass or fail decision within the broker budget, so ADR-018
          froze it on Sep 24, 2026. Its evidence stays in the database.
        </p>
        {!off && (
          <p className="tw:m-0 tw:text-[0.82rem] tw:text-danger-soft">
            A market's discovery mode is not OFF. ADR-018 expects both markets
            to stay OFF.
          </p>
        )}
        <dl className="tw:m-0 tw:grid tw:grid-cols-[auto_minmax(0,1fr)] tw:gap-x-4 tw:gap-y-2 tw:text-[0.82rem]">
          {facts.map(([label, value]) => (
            <div key={label} className="tw:contents">
              <dt className="tw:text-ink-400">{label}</dt>
              <dd className="tw:m-0 tw:text-right tw:font-mono tw:text-ink-100">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section
        aria-label="Symbol pool"
        className={classes(
          CARD,
          "tw:flex tw:flex-col tw:gap-3 tw:px-5 tw:py-5",
        )}
      >
        <h2 className={CARD_TITLE}>Symbol pool</h2>
        <div className="tw:grid tw:grid-cols-2 tw:gap-3">
          {legacy.markets.map((market) => (
            <div
              key={market.marketId}
              className="tw:flex tw:flex-col tw:gap-1 tw:rounded-input tw:border tw:border-line-subtle tw:bg-surface-sunken tw:px-3.5 tw:py-3"
            >
              <span className={LABEL}>{market.marketId}</span>
              <span className="tw:text-[1.35rem] tw:font-semibold tw:text-ink-100">
                {market.poolSize === null ? "—" : count(market.poolSize)}
              </span>
              <span className="tw:text-[0.75rem] tw:text-ink-400">
                {market.marketId === "CA_TSX"
                  ? "TSX stocks, CDRs excluded"
                  : "NYSE and Nasdaq stocks"}
              </span>
            </div>
          ))}
        </div>
        <p className={classes("tw:m-0 tw:leading-normal", MUTED)}>
          Mappings were last refreshed {day(legacy.mappingsRefreshedAt)}. The
          catalog ages until the seed takes over its own refresh.
        </p>
      </section>
    </div>
  );
}

export function DiscoveryView({
  marketId,
  onOpenSymbol,
}: {
  marketId: MarketId;
  onOpenSymbol?: (symbol: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("today");
  const [status, setStatus] = useState<DailySeedStatus | null>(null);
  const [coverage, setCoverage] = useState<Map<string, CandidateCoverage>>(
    new Map(),
  );
  const [onList, setOnList] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<DailySeedHistoryEntry[] | null>(null);
  const [legacy, setLegacy] = useState<DailySeedLegacy | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const now = useNow();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        // The daily list response is larger and slower; it only adds scanner
        // states, so it never delays the seed status.
        void getJson(`/api/universe?marketId=${marketId}`, signal)
          .then((raw) => {
            const universe = universeResponseSchema.safeParse(raw);
            if (!universe.success || signal?.aborted) return;
            setCoverage(
              new Map(
                (universe.data.automation.coverage ?? []).map((value) => [
                  value.symbol,
                  value,
                ]),
              ),
            );
            setOnList(
              new Set(universe.data.automation.configuredSymbols ?? []),
            );
          })
          .catch(() => undefined);
        const statusRaw = await getJson(
          `/api/universe/daily-seed?marketId=${marketId}`,
          signal,
        );
        const seeders = (statusRaw as { seeders?: unknown[] }).seeders ?? [];
        const next = seeders[0]
          ? dailySeedStatusSchema.parse(seeders[0])
          : null;
        if (signal?.aborted) return;
        setStatus(next);
        setError(
          next ? "" : "The daily-list seed is not available for this market.",
        );
      } catch (reason) {
        if (isAbortError(reason)) return;
        setError(
          reason instanceof Error ? reason.message : "Seed status unavailable",
        );
      } finally {
        inFlight.current = false;
      }
    },
    [marketId],
  );

  const running = Boolean(status?.running || status?.rescan?.running);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(
      () => void load(controller.signal),
      running ? RUNNING_POLL_MS : POLL_MS,
    );
    return () => {
      controller.abort();
      inFlight.current = false;
      window.clearInterval(timer);
    };
  }, [load, running]);

  useEffect(() => {
    setStatus(null);
    setHistory(null);
    setSelected(null);
    setNotice("");
  }, [marketId]);

  useEffect(() => {
    if (tab !== "history") return;
    const controller = new AbortController();
    getJson(
      `/api/universe/daily-seed/history?marketId=${marketId}`,
      controller.signal,
    )
      .then((raw) => setHistory(dailySeedHistorySchema.parse(raw).entries))
      .catch((reason) => {
        if (!isAbortError(reason)) {
          setHistory([]);
          setError(
            reason instanceof Error ? reason.message : "History unavailable",
          );
        }
      });
    return () => controller.abort();
  }, [tab, marketId]);

  useEffect(() => {
    if (tab !== "legacy" || legacy) return;
    const controller = new AbortController();
    getJson("/api/universe/daily-seed/legacy", controller.signal)
      .then((raw) => setLegacy(dailySeedLegacySchema.parse(raw)))
      .catch((reason) => {
        if (!isAbortError(reason))
          setError(
            reason instanceof Error
              ? reason.message
              : "Legacy facts unavailable",
          );
      });
    return () => controller.abort();
  }, [tab, legacy]);

  useRefreshOnFocus(() => void load());

  const act = async (
    path: "preview" | "run" | "add-top" | "rescan",
    success: (payload: unknown) => string,
  ) => {
    setBusy(true);
    setNotice("");
    try {
      const payload = await sendJson(
        `/api/universe/daily-seed/${path}?marketId=${marketId}${path === "add-top" ? `&count=${ADD_TOP_COUNT}` : ""}`,
        "POST",
        {},
      );
      setNotice(success(payload));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const selection =
    status?.latestSelection ?? status?.lastResult?.selection ?? null;
  const pick =
    selection?.picks.find((value) => value.symbol === selected) ??
    selection?.picks[0] ??
    null;

  return (
    <div className="tw:flex tw:flex-col tw:gap-5">
      <header className="tw:flex tw:flex-wrap tw:items-end tw:justify-between tw:gap-4">
        <div className="tw:flex tw:flex-col tw:gap-1.5">
          <span className={LABEL}>
            {marketId} ·{" "}
            {status ? longDate(status.tradingDate).toUpperCase() : ""}
          </span>
          <p className="tw:m-0 tw:text-[0.88rem] tw:text-ink-400">
            How today's daily list was chosen, and what the pre-market selector
            picked.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Discovery sections"
          className="tw:flex tw:gap-1 tw:rounded-[10px] tw:border tw:border-line tw:bg-surface-sunken tw:p-[3px]"
        >
          {TABS.map((entry) => (
            <Button
              key={entry.key}
              variant="tab"
              role="tab"
              aria-selected={tab === entry.key}
              aria-pressed={tab === entry.key}
              onClick={() => setTab(entry.key)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="tw:m-0 tw:rounded-input tw:border tw:border-line-danger tw:bg-surface-danger tw:px-4 tw:py-3 tw:text-[0.82rem] tw:text-danger-tint-soft"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="tw:m-0 tw:text-[0.82rem] tw:text-ink-300">
          {notice}
        </p>
      )}

      {tab === "today" &&
        (status ? (
          <>
            <SeedHero
              status={status}
              now={now}
              busy={busy || running}
              onPreview={() =>
                void act(
                  "preview",
                  () =>
                    "Ranking started. It takes a few seconds for CA and about a minute and a half for US.",
                )
              }
              onRun={() =>
                void act(
                  "run",
                  () =>
                    "Seed started. It adds picks only if the list is still empty.",
                )
              }
              onAddTop={() =>
                void act("add-top", (payload) => {
                  const added = (payload as { added?: string[] }).added ?? [];
                  return `Added ${added.join(", ")} to today's list.`;
                })
              }
            />
            {status.rescan && (
              <RescanCard
                rescan={status.rescan}
                marketId={marketId}
                now={now}
                busy={busy || running}
                onRun={() =>
                  void act(
                    "rescan",
                    () =>
                      "Rescan started. It adds movers only to a list the seed filled.",
                  )
                }
              />
            )}
            <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_320px] tw:items-start tw:gap-5 tw:below-1100:grid-cols-1">
              {selection && selection.picks.length > 0 ? (
                <PicksTable
                  selection={selection}
                  coverage={coverage}
                  onList={onList}
                  selected={pick?.symbol ?? null}
                  onSelect={setSelected}
                  title={
                    status.lastResult?.status === "APPLIED"
                      ? "Picks"
                      : "Latest ranking"
                  }
                />
              ) : (
                <section
                  className={classes(CARD, "tw:px-5 tw:py-10 tw:text-center")}
                >
                  <p className="tw:m-0 tw:text-[0.88rem] tw:text-ink-300">
                    No ranking yet today.
                  </p>
                  <p className={classes("tw:m-0 tw:mt-1", MUTED)}>
                    Picks appear here after the seed runs or after a preview.
                  </p>
                </section>
              )}
              <aside className="tw:flex tw:flex-col tw:gap-4">
                <ScheduleCard status={status} />
                {pick && <PickDetail pick={pick} onOpenSymbol={onOpenSymbol} />}
                <button
                  type="button"
                  onClick={() => setTab("legacy")}
                  className="tw:flex tw:cursor-pointer tw:flex-col tw:gap-2 tw:rounded-panel tw:border tw:border-dashed tw:border-line-input tw:bg-transparent tw:px-5 tw:py-4 tw:text-left tw:hover:bg-surface-raised"
                >
                  <span className="tw:flex tw:items-center tw:justify-between">
                    <span className="tw:text-[0.82rem] tw:font-semibold tw:text-ink-300">
                      Full-catalog engine
                    </span>
                    <span className="tw:rounded-full tw:border tw:border-line-input tw:px-2 tw:py-0.5 tw:font-mono tw:text-[0.63rem] tw:tracking-[0.1em] tw:text-ink-400">
                      FROZEN
                    </span>
                  </span>
                  <span className="tw:text-[0.75rem] tw:leading-normal tw:text-ink-400">
                    Off since Sep 18. Kept for its evidence under ADR-018.
                  </span>
                </button>
              </aside>
            </div>
          </>
        ) : (
          !error && (
            <p className={classes("tw:m-0", MUTED)}>Loading seed status…</p>
          )
        ))}

      {tab === "history" && (
        <HistoryTab entries={history} marketId={marketId} />
      )}
      {tab === "legacy" && <LegacyTab legacy={legacy} />}
    </div>
  );
}
