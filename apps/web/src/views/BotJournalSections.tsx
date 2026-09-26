import type {
  PaperJournalEntry,
  PaperJournalTotals,
  PaperUnresolvedPosition,
} from "@tsx-scanner/contracts";
import { useState } from "react";
import { CARD, LABEL, badge } from "../components/PageSections.js";
import { classes } from "../lib/classes.js";
import {
  type JournalBucket,
  type JournalMarket,
  addDays,
  marketTimeZone,
  monthRange,
  tradePct,
} from "../lib/journal-stats.js";
import { Tip } from "../ui.js";

export type JournalUnit = "$" | "%";

const HEAD =
  "tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-line tw:px-5 tw:py-[14px]";
const HEAD_TITLE =
  "tw:m-0 tw:font-sans tw:text-[0.92rem] tw:font-semibold tw:tracking-normal tw:text-ink-50";
const NUM = "tw:font-mono tw:tabular-nums";

export function signedMoney(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function signedR(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}R`;
}

export function signedPct(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function valueFor(bucket: JournalBucket, unit: JournalUnit): string {
  return unit === "$" ? signedMoney(bucket.netPnl) : signedPct(bucket.pct);
}

function toneClass(value: number): string {
  return value > 0 ? "tw:text-gain" : value < 0 ? "tw:text-danger" : "";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function dayLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    ...options,
    timeZone: "UTC",
  });
}

function clock(value: string | null, marketId: JournalMarket): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketTimeZone(marketId),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function stamp(value: string | null, marketId: JournalMarket): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketTimeZone(marketId),
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function held(entry: PaperJournalEntry): string {
  if (!entry.entryTime || !entry.exitTime) return "—";
  const minutes = Math.max(
    0,
    Math.round(
      (Date.parse(entry.exitTime) - Date.parse(entry.entryTime)) / 60_000,
    ),
  );
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function StatCard({
  label,
  tip,
  value,
  tone,
  hint,
}: {
  label: string;
  tip: string;
  value: string;
  tone?: number;
  hint: string;
}) {
  return (
    <Tip label={tip}>
      <div className={classes(CARD, "tw:px-5 tw:py-4")}>
        <div className={LABEL}>{label}</div>
        <div
          className={classes(
            NUM,
            "tw:mt-2 tw:text-[1.5rem] tw:font-semibold tw:tracking-[-0.02em] tw:text-ink-50",
            tone !== undefined && toneClass(tone),
          )}
        >
          {value}
        </div>
        <div className="tw:mt-[6px] tw:text-[0.75rem] tw:text-ink-400">
          {hint}
        </div>
      </div>
    </Tip>
  );
}

function bucketHint(bucket: JournalBucket, unit: JournalUnit): string {
  const other =
    unit === "$"
      ? `${signedPct(bucket.pct)} of positions`
      : signedMoney(bucket.netPnl);
  return `${plural(bucket.trades, "trade")} · ${plural(bucket.wins, "win")} · ${other}`;
}

/** Last session, 7 and 30 days, and trade quality over the 30 days. */
export function JournalStats({
  lastSession,
  lastSessionDate,
  week,
  month,
  totals,
  unit,
}: {
  lastSession: JournalBucket | null;
  lastSessionDate: string | null;
  week: JournalBucket;
  month: JournalBucket;
  totals: PaperJournalTotals | null;
  unit: JournalUnit;
}) {
  const winRate = totals?.winRate.value;
  return (
    <section
      className="tw:mb-4 tw:grid tw:grid-cols-[repeat(4,minmax(0,1fr))] tw:gap-[14px] tw:below-1000:grid-cols-[repeat(2,minmax(0,1fr))] tw:below-md:grid-cols-[minmax(0,1fr)]"
      aria-label="Performance summary"
    >
      <StatCard
        label={
          lastSessionDate
            ? `Last session · ${dayLabel(lastSessionDate, { month: "short", day: "numeric" })}`
            : "Last session"
        }
        tip="Realized profit or loss after trading costs for the most recent session with a closed trade."
        value={lastSession ? valueFor(lastSession, unit) : "—"}
        tone={
          lastSession
            ? unit === "$"
              ? lastSession.netPnl
              : lastSession.pct
            : undefined
        }
        hint={
          lastSession
            ? bucketHint(lastSession, unit)
            : "no closed trades in 30 days"
        }
      />
      <StatCard
        label="Last 7 days"
        tip="Realized profit or loss after trading costs for sessions in the last 7 calendar days."
        value={valueFor(week, unit)}
        tone={unit === "$" ? week.netPnl : week.pct}
        hint={bucketHint(week, unit)}
      />
      <StatCard
        label="Last 30 days"
        tip="Realized profit or loss after trading costs for sessions in the last 30 calendar days. % is each trade's net P&L over its entry value, summed."
        value={valueFor(month, unit)}
        tone={unit === "$" ? month.netPnl : month.pct}
        hint={bucketHint(month, unit)}
      />
      <StatCard
        label="Quality · 30 days"
        tip="Win rate counts closed trades with a positive net P&L; scratches count as neither. Profit factor is realized gains over realized losses, unavailable until there is a losing trade. R is each result in units of its initial risk."
        value={
          winRate === null || winRate === undefined
            ? "—"
            : `${(winRate * 100).toFixed(0)}% win`
        }
        hint={[
          `profit factor ${totals?.profitFactor?.toFixed(2) ?? "—"}`,
          `avg ${totals?.averageR == null ? "—" : signedR(totals.averageR)}`,
          `best ${totals?.largestWin == null ? "—" : signedMoney(totals.largestWin)}`,
        ].join(" · ")}
      />
    </section>
  );
}

const DAY_TONES = {
  win: "tw:border-[rgba(111,207,143,0.35)] tw:bg-[rgba(111,207,143,0.12)]",
  loss: "tw:border-line-danger tw:bg-surface-danger",
  flat: "tw:border-line-subtle tw:bg-surface-sunken",
};

/** A month of session tiles. Weekends are dimmed as closed; a day is
 * selectable when it has closed trades. */
export function JournalCalendar({
  month,
  days,
  today,
  selected,
  unit,
  onSelect,
}: {
  month: string;
  days: ReadonlyMap<string, JournalBucket>;
  today: string;
  selected: string | null;
  unit: JournalUnit;
  onSelect: (date: string) => void;
}) {
  const { start, end } = monthRange(month);
  const leading = new Date(`${start}T12:00:00Z`).getUTCDay();
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return (
    <div>
      <div
        className="tw:grid tw:grid-cols-[repeat(7,minmax(0,1fr))] tw:gap-2 tw:px-4 tw:pt-3 tw:pb-2"
        role="grid"
        aria-label={`${dayLabel(start, { month: "long", year: "numeric" })} sessions`}
      >
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => (
          <div
            className="tw:text-center tw:text-[0.68rem] tw:font-semibold tw:tracking-[0.06em] tw:uppercase tw:text-ink-500"
            key={name}
            role="columnheader"
          >
            {name}
          </div>
        ))}
        {Array.from({ length: leading }, (_, index) => (
          <div key={`lead-${index}`} aria-hidden="true" />
        ))}
        {dates.map((date) => {
          const bucket = days.get(date);
          const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
          const weekend = weekday === 0 || weekday === 6;
          const future = date > today;
          const traded = Boolean(bucket?.trades);
          const value = bucket
            ? unit === "$"
              ? bucket.netPnl
              : bucket.pct
            : 0;
          const tone = !traded
            ? "flat"
            : value > 0
              ? "win"
              : value < 0
                ? "loss"
                : "flat";
          const status = traded
            ? `${valueFor(bucket!, unit)}, ${plural(bucket!.trades, "trade")}, ${plural(bucket!.wins, "win")}`
            : future
              ? "upcoming"
              : weekend
                ? "market closed"
                : "no closed trades";
          return (
            <button
              type="button"
              key={date}
              role="gridcell"
              aria-label={`${dayLabel(date, { month: "short", day: "numeric" })}: ${status}`}
              aria-selected={selected === date}
              disabled={!traded}
              onClick={() => onSelect(date)}
              className={classes(
                "tw:flex tw:min-h-[82px] tw:flex-col tw:rounded-[10px] tw:border tw:px-[10px] tw:py-2 tw:text-left tw:font-sans tw:enabled:cursor-pointer tw:enabled:hover:border-line-accent",
                DAY_TONES[tone],
                (weekend || future) && !traded && "tw:opacity-45",
                date === today &&
                  "tw:shadow-[inset_0_0_0_1.5px_var(--ink-300)]",
                selected === date &&
                  "tw:shadow-[inset_0_0_0_2px_var(--accent)]",
              )}
            >
              <span className="tw:text-[0.72rem] tw:text-ink-400">
                {Number(date.slice(8))}
              </span>
              {traded ? (
                <>
                  <span
                    className={classes(
                      NUM,
                      "tw:mt-auto tw:text-[0.95rem] tw:font-semibold",
                      toneClass(value),
                    )}
                  >
                    {valueFor(bucket!, unit)}
                  </span>
                  <span className="tw:text-[0.68rem] tw:text-ink-400">
                    {plural(bucket!.trades, "trade")} ·{" "}
                    {plural(bucket!.wins, "win")}
                  </span>
                </>
              ) : (
                <span className="tw:text-[0.68rem] tw:text-ink-500">
                  {date === today
                    ? "today"
                    : future
                      ? ""
                      : weekend
                        ? "closed"
                        : "0 trades"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface CurvePoint {
  date: string;
  netPnl: number;
  pct: number;
  trades: number;
}

const CURVE = {
  width: 900,
  height: 280,
  left: 56,
  right: 16,
  top: 16,
  bottom: 30,
};

/** Cumulative realized P&L, one point per session, with a hover crosshair. */
export function JournalCurve({
  points,
  unit,
}: {
  points: CurvePoint[];
  unit: JournalUnit;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((point) =>
    unit === "$" ? point.netPnl : point.pct,
  );
  const geometry = (() => {
    const low = Math.min(0, ...values);
    const high = Math.max(0, ...values);
    const span = high - low || 1;
    const innerWidth = CURVE.width - CURVE.left - CURVE.right;
    const innerHeight = CURVE.height - CURVE.top - CURVE.bottom;
    const x = (index: number) =>
      CURVE.left +
      (points.length <= 1
        ? innerWidth / 2
        : (index / (points.length - 1)) * innerWidth);
    const y = (value: number) =>
      CURVE.top + ((high - value) / span) * innerHeight;
    return { low, high, x, y };
  })();
  if (!points.length)
    return (
      <p className="tw:m-0 tw:px-5 tw:py-10 tw:text-center tw:text-[0.84rem] tw:text-ink-400">
        No closed trades in the last 30 days.
      </p>
    );
  const { low, high, x, y } = geometry;
  const format = unit === "$" ? signedMoney : signedPct;
  const path = points
    .map((_, index) => `${index ? "L" : "M"} ${x(index)} ${y(values[index]!)}`)
    .join(" ");
  const area = `${path} L ${x(points.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
  const active = hover === null ? null : points[hover]!;
  const ticks = [...new Set([high, 0, low])];
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  return (
    <div className="tw:relative tw:px-4 tw:pt-3">
      <svg
        viewBox={`0 0 ${CURVE.width} ${CURVE.height}`}
        className="tw:block tw:h-[280px] tw:w-full"
        role="img"
        aria-label={`Cumulative realized P&L over ${plural(points.length, "session")}, ending at ${format(values.at(-1)!)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          const position = ratio * CURVE.width;
          let nearest = 0;
          for (let index = 1; index < points.length; index += 1)
            if (Math.abs(x(index) - position) < Math.abs(x(nearest) - position))
              nearest = index;
          setHover(nearest);
        }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={CURVE.left}
              x2={CURVE.width - CURVE.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--line)"
              strokeDasharray={tick === 0 ? "4 4" : undefined}
            />
            <text
              x={CURVE.left - 8}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--ink-500)"
              fontFamily="var(--mono)"
            >
              {tick === 0 ? (unit === "$" ? "$0" : "0%") : format(tick)}
            </text>
          </g>
        ))}
        <path d={area} fill="var(--accent)" opacity="0.08" />
        <path
          d={path}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {points.map((point, index) => (
          <circle
            key={point.date}
            cx={x(index)}
            cy={y(values[index]!)}
            r={hover === index ? 5 : 3.5}
            fill="var(--accent)"
            stroke="var(--surface)"
            strokeWidth="2"
          />
        ))}
        {points.map((point, index) =>
          index % labelEvery === 0 || index === points.length - 1 ? (
            <text
              key={`label-${point.date}`}
              x={x(index)}
              y={CURVE.height - 8}
              textAnchor="middle"
              fontSize="11"
              fill="var(--ink-500)"
            >
              {dayLabel(point.date, { month: "short", day: "numeric" })}
            </text>
          ) : null,
        )}
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={CURVE.top}
            y2={CURVE.height - CURVE.bottom}
            stroke="var(--ink-400)"
            strokeDasharray="3 3"
          />
        )}
      </svg>
      {active && hover !== null && (
        <div
          className="tw:pointer-events-none tw:absolute tw:top-2 tw:rounded-[8px] tw:border tw:border-line-input tw:bg-surface tw:px-3 tw:py-2 tw:text-[0.76rem] tw:text-ink-200 tw:shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
          style={{
            left: `${(x(hover) / CURVE.width) * 100}%`,
            transform:
              hover > points.length / 2
                ? "translateX(-105%)"
                : "translateX(8px)",
          }}
          role="status"
        >
          <strong className="tw:block tw:text-ink-50">
            {dayLabel(active.date, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
          </strong>
          <span className={NUM}>{format(values[hover]!)}</span> cumulative ·{" "}
          {plural(active.trades, "trade")}
        </div>
      )}
    </div>
  );
}

/** Closed results per strategy profile over the 30 days. */
export function StrategyBreakdown({
  strategies,
  unit,
}: {
  strategies: { name: string; bucket: JournalBucket }[];
  unit: JournalUnit;
}) {
  const scale = Math.max(
    ...strategies.map(({ bucket }) =>
      Math.abs(unit === "$" ? bucket.netPnl : bucket.pct),
    ),
    1e-9,
  );
  return (
    <section className={CARD} aria-label="By strategy">
      <div className={HEAD}>
        <h2 className={HEAD_TITLE}>By strategy</h2>
        <span className={LABEL}>30 days</span>
      </div>
      {strategies.length ? (
        <ul className="tw:m-0 tw:list-none tw:p-0">
          {strategies.map(({ name, bucket }) => {
            const value = unit === "$" ? bucket.netPnl : bucket.pct;
            return (
              <li
                className="tw:border-t tw:border-line-subtle tw:px-5 tw:py-3 tw:first:border-t-0"
                key={name}
              >
                <div className="tw:flex tw:items-baseline tw:justify-between tw:gap-2">
                  <strong className="tw:text-[0.84rem] tw:font-semibold tw:text-ink-50">
                    {name}
                  </strong>
                  <span
                    className={classes(
                      NUM,
                      "tw:text-[0.84rem]",
                      toneClass(value),
                    )}
                  >
                    {valueFor(bucket, unit)}
                  </span>
                </div>
                <div className="tw:mt-[3px] tw:text-[0.74rem] tw:text-ink-400">
                  {plural(bucket.trades, "trade")} ·{" "}
                  {plural(bucket.wins, "win")}
                </div>
                <div className="tw:mt-2 tw:h-[5px] tw:overflow-hidden tw:rounded-full tw:bg-surface-sunken">
                  <div
                    className={classes(
                      "tw:h-full tw:rounded-full",
                      value >= 0 ? "tw:bg-gain" : "tw:bg-danger",
                    )}
                    style={{ width: `${(Math.abs(value) / scale) * 100}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="tw:m-0 tw:px-5 tw:py-4 tw:text-[0.8rem] tw:text-ink-400">
          No closed trades in the last 30 days.
        </p>
      )}
    </section>
  );
}

/** Open and close-pending positions, excluded from realized results. */
export function OpenPositions({
  positions,
  marketId,
  funded,
}: {
  positions: PaperUnresolvedPosition[];
  marketId: JournalMarket;
  funded: boolean;
}) {
  return (
    <section className={CARD} aria-label="Open positions">
      <div className={HEAD}>
        <h2 className={HEAD_TITLE}>Open positions</h2>
        <span className={LABEL}>{positions.length}</span>
      </div>
      {positions.length ? (
        <>
          <p className="tw:m-0 tw:px-5 tw:pt-3 tw:text-[0.74rem] tw:text-ink-400">
            {funded
              ? "Funded paper account · excluded from realized results until every exit settles."
              : "Coordinated shadow portfolio · excluded from realized results; funded-account results are on the Bot page."}
          </p>
          <ul className="tw:m-0 tw:list-none tw:p-0">
            {positions.map((position) => (
              <li
                className="tw:grid tw:gap-1 tw:border-t tw:border-line-subtle tw:px-5 tw:py-3 tw:first:border-t-0 tw:text-[0.76rem] tw:text-ink-300"
                key={position.id}
              >
                <div className="tw:flex tw:items-center tw:justify-between tw:gap-2">
                  <strong className="tw:font-mono tw:text-[0.84rem] tw:text-ink-50">
                    {position.symbol}
                  </strong>
                  <span
                    className={badge(
                      position.status === "OPEN" ? "pending" : "warn",
                    )}
                  >
                    {position.status.replaceAll("_", " ")}
                  </span>
                </div>
                <span>
                  Opened{" "}
                  <b className="tw:font-medium tw:text-ink-100">
                    {stamp(position.entryTime, marketId)}
                  </b>
                </span>
                <Tip label="When the latest fact was applied to this position. This is not holding duration; Opened shows when the position was entered.">
                  <span tabIndex={0}>
                    Last activity{" "}
                    <b className="tw:font-medium tw:text-ink-100">
                      {stamp(position.lastFactTimestamp, marketId)}
                    </b>
                  </span>
                </Tip>
                <span className="tw:text-ink-500">
                  session {position.sessionDate} · run{" "}
                  {position.runStatus.replaceAll("_", " ").toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="tw:m-0 tw:px-5 tw:py-4 tw:text-[0.8rem] tw:text-ink-400">
          No open or close-pending positions. New entries appear here until they
          exit.
        </p>
      )}
    </section>
  );
}

const TH =
  "tw:whitespace-nowrap tw:border-b tw:border-line tw:px-4 tw:py-[11px] tw:first:pl-5 tw:last:pr-5 tw:font-sans tw:text-[0.68rem] tw:font-semibold tw:tracking-[0.08em] tw:uppercase tw:text-ink-500";
const TD =
  "tw:whitespace-nowrap tw:border-b tw:border-line-subtle tw:px-4 tw:py-[11px] tw:first:pl-5 tw:last:pr-5 tw:text-[0.82rem] tw:text-ink-200";
const NARROW_HIDDEN = "tw:below-md:hidden";

function exitTone(reason: string | null): string {
  if (reason === "TARGET") return "ok";
  if (reason === "STOP") return "bad";
  return "waiting";
}

/** Every position of one session, in entry order. */
export function DayTrades({
  date,
  entries,
  bucket,
  unit,
  marketId,
  total,
}: {
  date: string | null;
  entries: PaperJournalEntry[];
  bucket: JournalBucket | null;
  unit: JournalUnit;
  marketId: JournalMarket;
  total: number;
}) {
  const rows = [...entries].sort((left, right) =>
    (left.entryTime ?? "").localeCompare(right.entryTime ?? ""),
  );
  return (
    <section className={classes(CARD, "tw:mb-4")} aria-label="Session trades">
      <div className={HEAD}>
        <h2 className={HEAD_TITLE}>
          {date
            ? dayLabel(date, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })
            : "No session selected"}
          {bucket ? (
            <>
              {" "}
              · {plural(rows.length, "trade")} ·{" "}
              <span
                className={toneClass(unit === "$" ? bucket.netPnl : bucket.pct)}
              >
                {valueFor(bucket, unit)}
              </span>
            </>
          ) : null}
        </h2>
        <span className={LABEL}>
          Selected session · {plural(total, "trade")} this month
        </span>
      </div>
      {rows.length ? (
        <div className="tw:overflow-x-auto">
          <table className="tw:w-full tw:border-collapse">
            <thead>
              <tr>
                <th className={classes(TH, "tw:text-left")}>Time</th>
                <th className={classes(TH, "tw:text-left")}>Symbol</th>
                <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                  Entry
                </th>
                <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                  Exit
                </th>
                <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                  Shares
                </th>
                <th className={classes(TH, "tw:text-right")}>Net P&amp;L</th>
                <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                  %
                </th>
                <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                  R
                </th>
                <th className={classes(TH, "tw:text-left", NARROW_HIDDEN)}>
                  Exit reason
                </th>
                <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                  Held
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const pct = tradePct(entry);
                return (
                  <tr key={entry.id}>
                    <td className={classes(TD, NUM)}>
                      {clock(entry.entryTime, marketId)}
                    </td>
                    <td className={TD}>
                      <strong className="tw:block tw:font-mono tw:text-[0.84rem] tw:text-ink-50">
                        {entry.symbol}
                      </strong>
                      <small className="tw:text-[0.74rem] tw:text-ink-500">
                        {entry.profileName}
                      </small>
                    </td>
                    <td
                      className={classes(
                        TD,
                        NUM,
                        "tw:text-right",
                        NARROW_HIDDEN,
                      )}
                    >
                      {entry.entryPrice === null
                        ? "—"
                        : entry.entryPrice.toFixed(2)}
                    </td>
                    <td
                      className={classes(
                        TD,
                        NUM,
                        "tw:text-right",
                        NARROW_HIDDEN,
                      )}
                    >
                      {entry.exitPrice === null
                        ? "—"
                        : entry.exitPrice.toFixed(2)}
                    </td>
                    <td
                      className={classes(
                        TD,
                        NUM,
                        "tw:text-right",
                        NARROW_HIDDEN,
                      )}
                    >
                      {entry.shares ?? "—"}
                    </td>
                    <td
                      className={classes(
                        TD,
                        NUM,
                        "tw:text-right",
                        entry.netPnl !== null && toneClass(entry.netPnl),
                      )}
                    >
                      {entry.netPnl === null ? "—" : signedMoney(entry.netPnl)}
                    </td>
                    <td
                      className={classes(
                        TD,
                        NUM,
                        "tw:text-right",
                        NARROW_HIDDEN,
                        pct !== null && toneClass(pct),
                      )}
                    >
                      {pct === null ? "—" : signedPct(pct)}
                    </td>
                    <td
                      className={classes(
                        TD,
                        NUM,
                        "tw:text-right",
                        NARROW_HIDDEN,
                      )}
                    >
                      {entry.rMultiple === null
                        ? "—"
                        : signedR(entry.rMultiple)}
                    </td>
                    <td className={classes(TD, NARROW_HIDDEN)}>
                      <span className="tw:inline-flex tw:flex-wrap tw:gap-1">
                        {entry.status === "CLOSED" ? (
                          <span className={badge(exitTone(entry.exitReason))}>
                            {entry.exitReason
                              ? entry.exitReason.charAt(0) +
                                entry.exitReason
                                  .slice(1)
                                  .toLowerCase()
                                  .replaceAll("_", " ")
                              : "Closed"}
                          </span>
                        ) : (
                          <span className={badge("pending")}>
                            {entry.status.replaceAll("_", " ")}
                          </span>
                        )}
                        {entry.recoverySource ? (
                          <Tip
                            label={`Recovered during settlement (${entry.recoverySource.replaceAll("_", " ")})${
                              entry.recoveryDelayMs == null
                                ? ""
                                : ` · ${(entry.recoveryDelayMs / 1000).toFixed(1)}s after the scheduled boundary`
                            }. The original fact timestamps are preserved.`}
                          >
                            <span className={badge("warn")} tabIndex={0}>
                              Recovered
                            </span>
                          </Tip>
                        ) : null}
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
                      {held(entry)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="tw:m-0 tw:px-5 tw:py-6 tw:text-center tw:text-[0.84rem] tw:text-ink-400">
          {date
            ? "No trades in this session."
            : "Pick a session with trades in the calendar."}
        </p>
      )}
    </section>
  );
}
