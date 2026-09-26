import {
  type PaperJournalProjection,
  type PaperTradeJournal,
  paperTradeJournalSchema,
} from "@tsx-scanner/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  CARD,
  DOT_TONES,
  LABEL,
  SECONDARY_BUTTON,
} from "../components/PageSections.js";
import { getJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { ago } from "../lib/format.js";
import {
  addDays,
  between,
  byDay,
  byStrategy,
  cumulative,
  latestSession,
  marketDate,
  monthRange,
  shiftMonth,
  summarize,
} from "../lib/journal-stats.js";
import { useNow } from "../lib/use-now.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";
import { Tip } from "../ui.js";
import {
  DayTrades,
  JournalCalendar,
  JournalCurve,
  JournalStats,
  type JournalUnit,
  OpenPositions,
  StrategyBreakdown,
} from "./BotJournalSections.js";

type Market = "CA_TSX" | "US_EQUITIES";

const PROJECTIONS: [PaperJournalProjection, string, string][] = [
  [
    "FUNDED",
    "Funded",
    "The funded paper account bound to live runs. Its filled orders, cash effects and exits are the account-style ledger, and they are never added to the shadow projections.",
  ],
  [
    "COORDINATED",
    "Coordinated",
    "One capital-constrained shadow portfolio. This is the account-style performance view, including its running balance.",
  ],
  [
    "INDEPENDENT",
    "Independent",
    "One execution per strategy lifecycle. These positions can overlap, so this is strategy evidence rather than one account result.",
  ],
];

const PROJECTION_NAMES: Record<PaperJournalProjection, string> = {
  FUNDED: "Funded paper account",
  COORDINATED: "Coordinated shadow portfolio",
  INDEPENDENT: "Independent strategy evidence",
};

const SEGMENT =
  "tw:inline-flex tw:gap-[2px] tw:rounded-[9px] tw:border tw:border-line tw:bg-surface tw:p-[3px]";
const SEGMENT_BUTTON =
  "tw:cursor-pointer tw:rounded-[7px] tw:border-0 tw:bg-transparent tw:px-3 tw:py-[6px] tw:font-sans tw:text-[0.78rem] tw:font-semibold tw:text-ink-400 tw:hover:text-ink-100 tw:aria-pressed:bg-surface-raised tw:aria-pressed:text-ink-50 tw:aria-pressed:shadow-[inset_0_0_0_1px_var(--line-accent)]";
const LIMIT = 500;

function journalUrl(
  marketId: Market,
  projection: PaperJournalProjection,
  startDate: string,
  endDate: string,
): string {
  const query = new URLSearchParams({
    marketId,
    source: "LIVE",
    projection,
    limit: String(LIMIT),
    startDate,
    endDate,
  });
  return `/api/paper-bot/journal?${query.toString()}`;
}

/**
 * Journal view of the paper bot's retained P&L ledger: period summaries, a
 * month calendar or 30-day curve, results by strategy, open positions and the
 * trades of one session. The funded paper account is the default projection,
 * because it is the one account-style result with real cash effects.
 */
export function BotPerformanceView({
  marketId = "CA_TSX",
}: {
  marketId?: Market;
} = {}) {
  const now = useNow();
  const today = marketDate(marketId, now);
  const [projection, setProjection] =
    useState<PaperJournalProjection>("FUNDED");
  const [unit, setUnit] = useState<JournalUnit>("$");
  const [view, setView] = useState<"calendar" | "curve">("calendar");
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const [recent, setRecent] = useState<PaperTradeJournal | null>(null);
  const [monthly, setMonthly] = useState<PaperTradeJournal | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);

  const recentStart = addDays(today, -29);
  const { start: monthStart, end: monthEnd } = monthRange(month);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      getJson(
        journalUrl(marketId, projection, recentStart, today),
        controller.signal,
      ),
      getJson(
        journalUrl(marketId, projection, monthStart, monthEnd),
        controller.signal,
      ),
    ])
      .then(([recentValue, monthValue]) => {
        if (controller.signal.aborted) return;
        setRecent(paperTradeJournalSchema.parse(recentValue));
        setMonthly(paperTradeJournalSchema.parse(monthValue));
        setLastLoadedAt(new Date().toISOString());
        setError("");
      })
      .catch((reason: unknown) => {
        // The previous read stays visible; the banner marks it as the last
        // known good read, not current.
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to load bot performance history",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [marketId, projection, recentStart, today, monthStart, monthEnd, reload]);

  useRefreshOnFocus(() => setReload((value) => value + 1), 10_000);

  // Bounded background refresh while the tab is visible, so open positions and
  // new closes appear without a manual action.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setReload((value) => value + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const recentEntries = useMemo(() => recent?.entries ?? [], [recent]);
  const recentDays = useMemo(() => byDay(recentEntries), [recentEntries]);
  const lastSessionDate = latestSession(recentDays);
  const week = useMemo(
    () => summarize(between(recentEntries, addDays(today, -6), today)),
    [recentEntries, today],
  );
  const thirty = useMemo(() => summarize(recentEntries), [recentEntries]);
  const strategies = useMemo(() => byStrategy(recentEntries), [recentEntries]);
  const curve = useMemo(() => cumulative(recentDays), [recentDays]);
  const monthEntries = useMemo(() => monthly?.entries ?? [], [monthly]);
  const monthDays = useMemo(() => byDay(monthEntries), [monthEntries]);
  const monthSummary = useMemo(() => summarize(monthEntries), [monthEntries]);
  const shownDay =
    selected && monthDays.has(selected) ? selected : latestSession(monthDays);
  const dayEntries = shownDay
    ? monthEntries.filter((entry) => entry.sessionDate === shownDay)
    : [];
  const unresolved = recent?.unresolvedPositions ?? [];
  const truncated =
    recentEntries.length >= LIMIT || monthEntries.length >= LIMIT;
  const greenDays = [...monthDays.values()].filter(
    (bucket) => bucket.netPnl > 0,
  ).length;
  const redDays = [...monthDays.values()].filter(
    (bucket) => bucket.netPnl < 0,
  ).length;
  const currency = marketId === "US_EQUITIES" ? "USD" : "CAD";
  const tone = error ? "bad" : unresolved.length ? "pending" : "ok";
  const monthLabel = new Date(`${monthStart}T12:00:00Z`).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric", timeZone: "UTC" },
  );

  return (
    <>
      <div className="tw:-mt-3 tw:mb-6 tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
        <p
          className="tw:m-0 tw:flex tw:items-center tw:gap-[10px] tw:text-[0.86rem] tw:text-ink-300"
          aria-label="Refresh state"
        >
          <span
            className={classes(
              "tw:h-2 tw:w-2 tw:shrink-0 tw:rounded-full",
              DOT_TONES[tone],
            )}
            aria-hidden="true"
          />
          <span>
            {PROJECTION_NAMES[projection]} · {currency} · {thirty.trades} closed{" "}
            {thirty.trades === 1 ? "trade" : "trades"} in 30 days ·{" "}
            {unresolved.length
              ? `${unresolved.length} open`
              : "no open positions"}{" "}
            ·{" "}
            <span role="status">
              {loading
                ? "refreshing…"
                : lastLoadedAt
                  ? `checked ${ago(now, lastLoadedAt)}`
                  : "not checked yet"}
            </span>
          </span>
        </p>
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-[10px]">
          <div
            className={SEGMENT}
            role="group"
            aria-label="Performance projection"
          >
            {PROJECTIONS.map(([value, label, tip]) => (
              <Tip key={value} label={tip}>
                <button
                  type="button"
                  className={SEGMENT_BUTTON}
                  aria-pressed={projection === value}
                  onClick={() => setProjection(value)}
                >
                  {label}
                </button>
              </Tip>
            ))}
          </div>
          <div className={SEGMENT} role="group" aria-label="Value unit">
            {(["$", "%"] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={SEGMENT_BUTTON}
                aria-pressed={unit === value}
                onClick={() => setUnit(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <p className="error-banner">
          {error} · showing the last successful read
        </p>
      ) : null}
      {truncated ? (
        <p className="tw:mt-0 tw:mb-4 tw:text-[0.78rem] tw:text-warn">
          More than {LIMIT} positions in this range; figures and lists cover the
          latest {LIMIT}.
        </p>
      ) : null}

      <JournalStats
        lastSession={lastSessionDate ? recentDays.get(lastSessionDate)! : null}
        lastSessionDate={lastSessionDate}
        week={week}
        month={thirty}
        totals={recent?.totals ?? null}
        unit={unit}
      />

      <div className="tw:mb-4 tw:grid tw:grid-cols-[minmax(0,1fr)_320px] tw:gap-4 tw:below-1100:grid-cols-[minmax(0,1fr)]">
        <section className={CARD} aria-label="Realized P&L">
          <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-line tw:px-5 tw:py-[12px]">
            <h2 className="tw:m-0 tw:font-sans tw:text-[0.92rem] tw:font-semibold tw:tracking-normal tw:text-ink-50">
              Realized P&amp;L
            </h2>
            {view === "calendar" ? (
              <div className="tw:flex tw:items-center tw:gap-2 tw:text-[0.84rem] tw:font-semibold tw:text-ink-200">
                <button
                  type="button"
                  className={classes(
                    SECONDARY_BUTTON,
                    "tw:px-[9px] tw:py-[3px]",
                  )}
                  aria-label="Previous month"
                  onClick={() => {
                    setMonth((value) => shiftMonth(value, -1));
                    setSelected(null);
                  }}
                >
                  ‹
                </button>
                <span aria-live="polite">{monthLabel}</span>
                <button
                  type="button"
                  className={classes(
                    SECONDARY_BUTTON,
                    "tw:px-[9px] tw:py-[3px]",
                  )}
                  aria-label="Next month"
                  disabled={month >= today.slice(0, 7)}
                  onClick={() => {
                    setMonth((value) => shiftMonth(value, 1));
                    setSelected(null);
                  }}
                >
                  ›
                </button>
                <button
                  type="button"
                  className={classes(
                    SECONDARY_BUTTON,
                    "tw:px-[9px] tw:py-[3px] tw:text-[0.74rem]",
                  )}
                  onClick={() => {
                    setMonth(today.slice(0, 7));
                    setSelected(null);
                  }}
                >
                  Today
                </button>
              </div>
            ) : (
              <span className={LABEL}>Last 30 days</span>
            )}
            <div className={SEGMENT} role="group" aria-label="Chart view">
              {(
                [
                  ["curve", "Curve"],
                  ["calendar", "Calendar"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={SEGMENT_BUTTON}
                  aria-pressed={view === value}
                  onClick={() => setView(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {view === "calendar" ? (
            <>
              <JournalCalendar
                month={month}
                days={monthDays}
                today={today}
                selected={shownDay}
                unit={unit}
                onSelect={setSelected}
              />
              <p className="tw:m-0 tw:px-5 tw:pt-1 tw:pb-4 tw:text-[0.76rem] tw:text-ink-400">
                {monthSummary.trades ? (
                  <>
                    <span
                      className={
                        monthSummary.netPnl < 0
                          ? "tw:text-danger"
                          : "tw:text-gain"
                      }
                    >
                      {unit === "$"
                        ? `${monthSummary.netPnl < 0 ? "−" : "+"}$${Math.abs(monthSummary.netPnl).toFixed(2)}`
                        : `${monthSummary.pct < 0 ? "−" : "+"}${Math.abs(monthSummary.pct).toFixed(2)}%`}
                    </span>{" "}
                    this month · {monthSummary.trades} closes · {greenDays}{" "}
                    green / {redDays} red days
                  </>
                ) : (
                  "No closed trades this month"
                )}{" "}
                · realized after costs
                {projection === "INDEPENDENT"
                  ? " · positions can overlap, so this is strategy evidence rather than one account result"
                  : ""}
              </p>
            </>
          ) : (
            <>
              <JournalCurve points={curve} unit={unit} />
              <p className="tw:m-0 tw:px-5 tw:pt-2 tw:pb-4 tw:text-[0.76rem] tw:text-ink-400">
                One step per session · cumulative realized P&amp;L after costs
                {projection === "INDEPENDENT"
                  ? " · positions can overlap, so this is strategy evidence rather than one account result"
                  : ""}
              </p>
            </>
          )}
        </section>
        <div className="tw:grid tw:content-start tw:gap-4">
          <StrategyBreakdown strategies={strategies} unit={unit} />
          <OpenPositions
            positions={unresolved}
            marketId={marketId}
            funded={projection === "FUNDED"}
          />
        </div>
      </div>

      <DayTrades
        date={shownDay}
        entries={dayEntries}
        bucket={shownDay ? (monthDays.get(shownDay) ?? null) : null}
        unit={unit}
        marketId={marketId}
        total={monthSummary.trades}
      />
      <p className="tw:m-0 tw:mb-6 tw:text-[0.75rem] tw:text-ink-500">
        Paper evidence only · times in{" "}
        {marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto"} ·
        % is each trade&apos;s net P&amp;L over its entry value
      </p>
    </>
  );
}
