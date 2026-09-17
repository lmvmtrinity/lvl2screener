import {
  paperPerformanceCurveSchema,
  type PaperPerformanceAccount,
  type PaperPerformanceCurve,
  type PaperPerformanceGranularity,
  type PaperPerformancePoint,
} from "@tsx-scanner/contracts";
import { useEffect, useId, useMemo, useState } from "react";
import { getJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { Tip } from "../ui.js";

type MarketId = "CA_TSX" | "US_EQUITIES";
type PerformanceRange = "1D" | "5D" | "3M" | "6M" | "1Y" | "YTD";

const ACCOUNTS: readonly PaperPerformanceAccount[] = ["COORDINATED", "FUNDED"];

const ACCOUNT_TIPS: Record<PaperPerformanceAccount, string> = {
  COORDINATED:
    "The capacity-constrained shadow portfolio: one paper account's realized P&L. This is account-style evidence, not a strategy average.",
  FUNDED:
    "The separately funded paper account bound to live runs: its equity at each completed run-end boundary, including positions marked at that boundary.",
};

const RANGES: readonly PerformanceRange[] = [
  "1D",
  "5D",
  "3M",
  "6M",
  "1Y",
  "YTD",
];

const RANGE_TIPS: Record<PerformanceRange, string> = {
  "1D": "Closed bot trades from the most recent preserved session, one point each, in exit order.",
  "5D": "Closed bot trades from the last five calendar days, one point each, in exit order.",
  "3M": "Closed bot trades from the last three calendar months, one point per session with a running total.",
  "6M": "Closed bot trades from the last six calendar months, one point per session with a running total.",
  "1Y": "Closed bot trades from the last twelve calendar months, one point per session with a running total.",
  YTD: "Closed bot trades since January 1, one point per session with a running total.",
};

const RANGE_BUTTON =
  "tw:cursor-pointer tw:border-0 tw:bg-surface tw:px-[11px] tw:py-2 tw:font-mono tw:text-[0.58rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-600 tw:below-700:px-2 tw:below-700:py-[7px]";
const RANGE_BUTTON_PRESSED =
  "tw:aria-pressed:bg-accent tw:aria-pressed:text-on-accent";
const METRIC_CELL = "tw:bg-surface tw:px-[19px] tw:py-[17px]";
const METRIC_LABEL =
  "tw:mb-2 tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.09em] tw:text-ink-700";
const METRIC_VALUE = "tw:text-[1.2rem]";
const METRIC_DETAIL = "tw:mt-1 tw:block tw:text-[0.66rem] tw:text-ink-700";

/** Geometry of the fixed-viewBox chart. Labels sit in the right gutter. */
const CHART = {
  width: 960,
  height: 340,
  padTop: 22,
  padRight: 78,
  padBottom: 38,
  padLeft: 16,
};

function marketZone(marketId: MarketId): string {
  return marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto";
}

function todayInMarket(marketId: MarketId): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketZone(marketId),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shiftDays(start: string, days: number): string {
  const value = new Date(`${start}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

function shiftMonths(start: string, months: number): string {
  const value = new Date(`${start}T00:00:00.000Z`);
  const day = value.getUTCDate();
  const target = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return isoDate(target);
}

function rangeStart(endDate: string, range: PerformanceRange): string {
  switch (range) {
    case "1D":
      return endDate;
    case "5D":
      return shiftDays(endDate, -4);
    case "3M":
      return shiftMonths(endDate, -3);
    case "6M":
      return shiftMonths(endDate, -6);
    case "1Y":
      return shiftMonths(endDate, -12);
    case "YTD":
      return `${endDate.slice(0, 4)}-01-01`;
  }
}

/** Intraday detail for the two short ranges; one session point beyond that. */
function granularityFor(range: PerformanceRange): PaperPerformanceGranularity {
  return range === "1D" || range === "5D" ? "TRADE" : "DAY";
}

function money(value: number): string {
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
}

function plainMoney(value: number): string {
  const rounded = Number(value.toFixed(2));
  return `${rounded < 0 ? "−" : ""}$${Math.abs(rounded).toFixed(2)}`;
}

function tone(value: number): string {
  return value >= 0 ? "positive" : "negative";
}

/** Warning codes are contract-stable; the graph explains them in place. */
function explainWarning(code: string): string {
  switch (code) {
    case "FUNDED_ACCOUNT_NOT_CONFIGURED":
      return "No funded account is configured for this market, so there is no funded curve to draw.";
    case "FUNDED_RUN_BOUNDARY_UNAVAILABLE":
      return "Completed funded runs without a retained run-end boundary are omitted rather than priced at a later mark.";
    default:
      return code.replaceAll("_", " ").toLowerCase();
  }
}

function formatPointTime(value: string, marketId: MarketId): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketZone(marketId),
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function formatAxisTime(
  value: string,
  marketId: MarketId,
  withTime: boolean,
  withYear: boolean,
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketZone(marketId),
    ...(withYear ? { year: "2-digit" as const } : {}),
    month: "short",
    day: "2-digit",
    ...(withTime
      ? { hour: "2-digit" as const, minute: "2-digit" as const }
      : {}),
  }).format(new Date(value));
}

/** Nice 1/2/5 ticks so the money gutter never repeats a stepped label. */
function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const rough = span / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) *
    magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step / 2; value += step)
    ticks.push(Number(value.toFixed(6)));
  return ticks;
}

interface CurveGeometry {
  coordinates: Array<{ x: number; y: number; point: PaperPerformancePoint }>;
  line: string;
  area: string;
  yTicks: number[];
  xTicks: Array<{ x: number; label: string }>;
  yZero: number;
}

function layoutCurve(
  points: PaperPerformancePoint[],
  marketId: MarketId,
): CurveGeometry | null {
  if (points.length === 0) return null;
  const { width, height, padTop, padRight, padBottom, padLeft } = CHART;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;
  const times = points.map((point) => new Date(point.closedAt).getTime());
  const firstTime = times[0]!;
  const lastTime = times[times.length - 1]!;
  const values = [0, ...points.map((point) => point.cumulativeNetPnl)];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = (rawMax - rawMin) * 0.08 || Math.abs(rawMax) * 0.05 || 1;
  const yTicks = niceTicks(rawMin - padding, rawMax + padding);
  const min = Math.min(yTicks[0]!, rawMin - padding);
  const max = Math.max(yTicks[yTicks.length - 1]!, rawMax + padding);
  const yOf = (value: number) =>
    padTop + ((max - value) / (max - min || 1)) * innerHeight;
  const xOf = (time: number) =>
    lastTime === firstTime
      ? padLeft + innerWidth / 2
      : padLeft + ((time - firstTime) / (lastTime - firstTime)) * innerWidth;
  const coordinates = points.map((point, index) => ({
    x: xOf(times[index]!),
    y: yOf(point.cumulativeNetPnl),
    point,
  }));
  const line = coordinates
    .map(
      ({ x, y }, index) =>
        `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
    )
    .join(" ");
  const baseline = yOf(0).toFixed(1);
  const area = `${line} L${coordinates[coordinates.length - 1]!.x.toFixed(1)},${baseline} L${coordinates[0]!.x.toFixed(1)},${baseline} Z`;
  const intraday = new Set(points.map((point) => point.sessionDate)).size === 1;
  const withYear =
    new Set(points.map((point) => point.sessionDate.slice(0, 4))).size > 1;
  const tickIndexes = [
    0,
    Math.round((points.length - 1) / 3),
    Math.round(((points.length - 1) * 2) / 3),
    points.length - 1,
  ];
  const xTicks = [...new Set(tickIndexes)].map((index) => ({
    x: coordinates[index]!.x,
    label: formatAxisTime(
      points[index]!.closedAt,
      marketId,
      intraday,
      withYear,
    ),
  }));
  return { coordinates, line, area, yTicks, xTicks, yZero: yOf(0) };
}

/**
 * $ performance over time for one paper account at a time: the coordinated
 * shadow portfolio's realized P&L, or the funded account's boundary equity.
 * The API aggregates and windows the currency amount server-side, so a long
 * range is not limited by the journal page size, and ADR-010 keeps the two
 * accounts out of a single response.
 */
export function BotPerformanceGraph({
  marketId = "CA_TSX",
  latestSessionDate = null,
}: {
  marketId?: MarketId;
  /** The newest preserved bot session; ranges end there instead of "now". */
  latestSessionDate?: string | null;
} = {}) {
  const [account, setAccount] = useState<PaperPerformanceAccount>("FUNDED");
  const [range, setRange] = useState<PerformanceRange>("1D");
  const [curve, setCurve] = useState<PaperPerformanceCurve | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const aboveId = useId();
  const belowId = useId();

  const endDate = latestSessionDate ?? todayInMarket(marketId);
  const startDate = rangeStart(endDate, range);
  // Funded boundaries are one point per completed run, so they are already
  // session granularity even for the short ranges.
  const granularity = account === "FUNDED" ? "DAY" : granularityFor(range);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCurve(null);
    const params = new URLSearchParams({
      marketId,
      source: "LIVE",
      account,
      startDate,
      endDate,
      granularity,
    });
    getJson(`/api/paper-bot/performance?${params}`, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setCurve(paperPerformanceCurveSchema.parse(value));
        setError("");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load bot performance",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [account, endDate, granularity, marketId, startDate]);

  const geometry = useMemo(
    () => layoutCurve(curve?.points ?? [], marketId),
    [curve, marketId],
  );

  const summary = useMemo(() => {
    if (!curve || curve.points.length === 0) return null;
    const points = curve.points;
    let peak = 0;
    let maxDrawdown = 0;
    const byDay = new Map<string, number>();
    for (const point of points) {
      peak = Math.max(peak, point.cumulativeNetPnl);
      maxDrawdown = Math.min(maxDrawdown, point.cumulativeNetPnl - peak);
      byDay.set(
        point.sessionDate,
        (byDay.get(point.sessionDate) ?? 0) + point.netPnl,
      );
    }
    const days = [...byDay].map(([date, netPnl]) => ({ date, netPnl }));
    return {
      netPnl: points[points.length - 1]!.cumulativeNetPnl,
      trades: points.reduce((total, point) => total + point.trades, 0),
      sessions: byDay.size,
      maxDrawdown,
      bestDay: days.reduce((best, day) =>
        day.netPnl > best.netPnl ? day : best,
      ),
      worstDay: days.reduce((worst, day) =>
        day.netPnl < worst.netPnl ? day : worst,
      ),
    };
  }, [curve]);

  const hovered =
    geometry && hover !== null ? geometry.coordinates[hover] : undefined;

  const moveHover = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!geometry) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * CHART.width;
    let nearest = 0;
    let distance = Number.POSITIVE_INFINITY;
    geometry.coordinates.forEach((coordinate, index) => {
      const next = Math.abs(coordinate.x - x);
      if (next < distance) {
        distance = next;
        nearest = index;
      }
    });
    setHover(nearest);
  };

  return (
    <section className="panel bot-performance-graph tw:mt-[18px]">
      <div className="panel-title">
        <div>
          <h3>Performance over time</h3>
          <p className="tw:mt-1 tw:mb-0 tw:text-[0.75rem] tw:text-ink-700">
            {account === "FUNDED"
              ? "Funded paper account · equity change at each completed run boundary"
              : "Coordinated paper account · realized net P&L after trading costs"}
            {curve ? ` (${curve.currency})` : ""}, from preserved LIVE sessions.
          </p>
        </div>
        <div className="bot-performance-controls tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2">
          <div
            aria-label="Performance account"
            className="tw:flex tw:h-max tw:gap-px tw:overflow-hidden tw:rounded-[6px] tw:border tw:border-line tw:bg-line"
            role="group"
          >
            {ACCOUNTS.map((value) => (
              <Tip key={value} label={ACCOUNT_TIPS[value]}>
                <button
                  aria-pressed={account === value}
                  className={classes(
                    RANGE_BUTTON,
                    account === value && RANGE_BUTTON_PRESSED,
                  )}
                  onClick={() => setAccount(value)}
                  type="button"
                >
                  {value}
                </button>
              </Tip>
            ))}
          </div>
          <div
            aria-label="Performance range"
            className="bot-performance-ranges tw:flex tw:h-max tw:gap-px tw:overflow-hidden tw:rounded-[6px] tw:border tw:border-line tw:bg-line"
            role="group"
          >
            {RANGES.map((value) => (
              <Tip key={value} label={RANGE_TIPS[value]}>
                <button
                  aria-pressed={range === value}
                  className={classes(
                    RANGE_BUTTON,
                    range === value && RANGE_BUTTON_PRESSED,
                  )}
                  onClick={() => setRange(value)}
                  type="button"
                >
                  {value}
                </button>
              </Tip>
            ))}
          </div>
        </div>
      </div>

      {loading ? <div className="empty">Loading bot performance…</div> : null}
      {!loading && error ? (
        <p className="error-banner tw:mx-5 tw:my-4">{error}</p>
      ) : null}
      {!loading && !error && curve && curve.points.length === 0 ? (
        <div className="empty">
          {account === "FUNDED"
            ? "No completed funded run has a retained run-end boundary in this range."
            : "No closed bot trades in this range."}
        </div>
      ) : null}
      {!loading && !error && curve && curve.warnings.length > 0 ? (
        <p className="bot-performance-warning tw:mx-5 tw:mt-3 tw:mb-0 tw:text-[0.72rem] tw:text-warn">
          {curve.warnings.map(explainWarning).join(" ")}
        </p>
      ) : null}

      {!loading && !error && geometry && summary ? (
        <>
          <div className="journal-metrics bot-performance-metrics tw:mx-5 tw:mt-4 tw:mb-4 tw:grid tw:grid-cols-[repeat(5,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-xl tw:border tw:border-line tw:bg-surface-sunken tw:below-900:grid-cols-[repeat(2,1fr)]">
            <Tip
              label={
                account === "FUNDED"
                  ? "Equity change from the last completed boundary before this range to the latest completed boundary in it. Positions open at a boundary are marked at that boundary, never at a later price."
                  : "Net realized P&L in this range. The curve ends at this value; open positions are excluded until they exit."
              }
            >
              <div className={METRIC_CELL}>
                <span className={METRIC_LABEL}>RANGE P&amp;L</span>
                <strong className={classes(METRIC_VALUE, tone(summary.netPnl))}>
                  {money(summary.netPnl)}
                </strong>
                <small className={METRIC_DETAIL}>
                  {summary.sessions} session{summary.sessions === 1 ? "" : "s"}
                </small>
              </div>
            </Tip>
            <Tip
              label={
                account === "FUNDED"
                  ? "Largest peak-to-trough decline of the funded account's boundary equity within this range, measured from the range baseline."
                  : "Largest peak-to-trough decline of the running range P&L, measured from zero at the start of the range. It is realized P&L drawdown, not funded-account equity."
              }
            >
              <div className={METRIC_CELL}>
                <span className={METRIC_LABEL}>MAX DRAWDOWN</span>
                <strong
                  className={classes(
                    METRIC_VALUE,
                    summary.maxDrawdown < 0 ? "negative" : "",
                  )}
                >
                  {money(summary.maxDrawdown)}
                </strong>
              </div>
            </Tip>
            <Tip label="Best single session by the net P&L realized on it.">
              <div className={METRIC_CELL}>
                <span className={METRIC_LABEL}>BEST DAY</span>
                <strong
                  className={classes(
                    METRIC_VALUE,
                    tone(summary.bestDay.netPnl),
                  )}
                >
                  {money(summary.bestDay.netPnl)}
                </strong>
                <small className={METRIC_DETAIL}>
                  {formatDay(summary.bestDay.date)}
                </small>
              </div>
            </Tip>
            <Tip label="Worst single session by the net P&L realized on it.">
              <div className={METRIC_CELL}>
                <span className={METRIC_LABEL}>WORST DAY</span>
                <strong
                  className={classes(
                    METRIC_VALUE,
                    tone(summary.worstDay.netPnl),
                  )}
                >
                  {money(summary.worstDay.netPnl)}
                </strong>
                <small className={METRIC_DETAIL}>
                  {formatDay(summary.worstDay.date)}
                </small>
              </div>
            </Tip>
            <Tip
              label={
                account === "FUNDED"
                  ? "Closed exits recorded in the retained run-end snapshots. A funded run can complete with no exit, so this can be zero."
                  : "Closed coordinated positions realized in this range. A trade is one exit, so a session can contain several."
              }
            >
              <div className={METRIC_CELL}>
                <span className={METRIC_LABEL}>CLOSED TRADES</span>
                <strong className={METRIC_VALUE}>{summary.trades}</strong>
              </div>
            </Tip>
          </div>

          <div className="bot-performance-chart tw:px-5 tw:pb-4">
            <div className="tw:overflow-x-auto">
              <div className="tw:relative tw:min-w-[680px]">
                <svg
                  aria-label={`${
                    account === "FUNDED"
                      ? "Funded account equity"
                      : "Coordinated account net P&L"
                  } performance curve for ${range}: range ${
                    account === "FUNDED" ? "equity change" : "net P&L"
                  } ${money(summary.netPnl)}, maximum drawdown ${money(
                    summary.maxDrawdown,
                  )}, ${summary.trades} closed trade${
                    summary.trades === 1 ? "" : "s"
                  } across ${summary.sessions} sessions.`}
                  className="tw:block tw:h-auto tw:w-full tw:font-mono tw:text-[11px]"
                  onPointerLeave={() => setHover(null)}
                  onPointerMove={moveHover}
                  role="img"
                  viewBox={`0 0 ${CHART.width} ${CHART.height}`}
                >
                  <defs>
                    <clipPath id={aboveId}>
                      <rect
                        height={Math.max(0, geometry.yZero)}
                        width={CHART.width}
                        x="0"
                        y="0"
                      />
                    </clipPath>
                    <clipPath id={belowId}>
                      <rect
                        height={Math.max(0, CHART.height - geometry.yZero)}
                        width={CHART.width}
                        x="0"
                        y={geometry.yZero}
                      />
                    </clipPath>
                  </defs>
                  {geometry.yTicks.map((tick) => {
                    const y =
                      CHART.padTop +
                      ((geometry.yTicks[geometry.yTicks.length - 1]! - tick) /
                        (geometry.yTicks[geometry.yTicks.length - 1]! -
                          geometry.yTicks[0]! || 1)) *
                        (CHART.height - CHART.padTop - CHART.padBottom);
                    return (
                      <g key={tick}>
                        <line
                          stroke="var(--line-subtle)"
                          x1={CHART.padLeft}
                          x2={CHART.width - CHART.padRight}
                          y1={y}
                          y2={y}
                        />
                        <text
                          fill="var(--ink-650)"
                          textAnchor="start"
                          x={CHART.width - CHART.padRight + 6}
                          y={y + 3}
                        >
                          {plainMoney(tick)}
                        </text>
                      </g>
                    );
                  })}
                  <path
                    d={geometry.area}
                    fill="var(--accent)"
                    fillOpacity="0.16"
                    clipPath={`url(#${aboveId})`}
                  />
                  <path
                    d={geometry.area}
                    fill="var(--danger)"
                    fillOpacity="0.16"
                    clipPath={`url(#${belowId})`}
                  />
                  <line
                    stroke="var(--line-input)"
                    strokeDasharray="4 4"
                    x1={CHART.padLeft}
                    x2={CHART.width - CHART.padRight}
                    y1={geometry.yZero}
                    y2={geometry.yZero}
                  />
                  <path
                    d={geometry.line}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="2"
                    clipPath={`url(#${aboveId})`}
                  />
                  <path
                    d={geometry.line}
                    fill="none"
                    stroke="var(--danger)"
                    strokeWidth="2"
                    clipPath={`url(#${belowId})`}
                  />
                  {geometry.coordinates.length <= 90
                    ? geometry.coordinates.map((coordinate) => (
                        <circle
                          cx={coordinate.x}
                          cy={coordinate.y}
                          fill="var(--surface)"
                          key={`${coordinate.point.sessionDate}:${coordinate.point.closedAt}`}
                          r="2.6"
                          stroke={
                            coordinate.point.cumulativeNetPnl >= 0
                              ? "var(--accent)"
                              : "var(--danger)"
                          }
                          strokeWidth="1.6"
                        />
                      ))
                    : null}
                  {geometry.xTicks.map((tick) => (
                    <text
                      fill="var(--ink-650)"
                      key={`${tick.x}:${tick.label}`}
                      textAnchor="middle"
                      x={tick.x}
                      y={CHART.height - 12}
                    >
                      {tick.label}
                    </text>
                  ))}
                  {hovered ? (
                    <g>
                      <line
                        stroke="var(--ink-650)"
                        strokeDasharray="3 3"
                        x1={hovered.x}
                        x2={hovered.x}
                        y1={CHART.padTop}
                        y2={CHART.height - CHART.padBottom}
                      />
                      <circle
                        cx={hovered.x}
                        cy={hovered.y}
                        fill="var(--surface)"
                        r="4.5"
                        stroke={
                          hovered.point.cumulativeNetPnl >= 0
                            ? "var(--accent)"
                            : "var(--danger)"
                        }
                        strokeWidth="2"
                      />
                    </g>
                  ) : null}
                </svg>
                {hovered && curve ? (
                  <div
                    className="tw:pointer-events-none tw:absolute tw:top-1 tw:z-10 tw:w-max tw:max-w-[240px] tw:rounded-input tw:border tw:border-line tw:bg-surface tw:px-[11px] tw:py-2 tw:font-mono tw:text-[0.64rem] tw:leading-[1.55] tw:text-ink-150 tw:shadow-[0_12px_28px_rgba(0,0,0,0.45)]"
                    style={{
                      left: `${Math.min(
                        90,
                        Math.max(10, (hovered.x / CHART.width) * 100),
                      )}%`,
                      transform: "translateX(-50%)",
                    }}
                  >
                    <strong className="tw:block tw:font-bold tw:text-ink-100">
                      {formatPointTime(hovered.point.closedAt, marketId)}
                    </strong>
                    <span className={tone(hovered.point.netPnl)}>
                      {curve.granularity === "DAY" ? "Session" : "Trade"}{" "}
                      P&amp;L {money(hovered.point.netPnl)}
                    </span>
                    <span className="tw:block">
                      Cumulative {money(hovered.point.cumulativeNetPnl)}
                    </span>
                    <span className="tw:block tw:text-ink-700">
                      {hovered.point.trades} closed trade
                      {hovered.point.trades === 1 ? "" : "s"} ·{" "}
                      {formatDay(hovered.point.sessionDate)}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
