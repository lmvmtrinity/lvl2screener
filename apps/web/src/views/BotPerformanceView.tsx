import {
  paperTradeJournalSchema,
  type PaperJournalEntry,
  type PaperJournalProjection,
  type PaperTradeJournal,
} from "@tsx-scanner/contracts";
import { useEffect, useMemo, useState } from "react";
import { getJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { ago } from "../lib/format.js";
import { useNow } from "../lib/use-now.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";
import { Tip } from "../ui.js";
import { BotPerformanceGraph } from "./BotPerformanceGraph.js";

const PAPER_BUTTON =
  "paper-button tw:cursor-pointer tw:rounded-[6px] tw:border tw:border-line-accent-mid tw:bg-surface-raised tw:px-[10px] tw:py-2 tw:font-mono tw:text-[0.6rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.06em] tw:text-accent tw:not-disabled:hover:bg-accent tw:not-disabled:hover:text-on-accent tw:disabled:cursor-default tw:disabled:opacity-45";

const JOURNAL_METRICS =
  "journal-metrics tw:grid tw:gap-px tw:overflow-hidden tw:rounded-xl tw:border tw:border-line tw:bg-surface-sunken";
const HISTORY_METRICS = classes(
  JOURNAL_METRICS,
  "tw:mt-[18px] tw:mb-4 tw:grid-cols-[repeat(6,1fr)]",
);
const JOURNAL_METRIC_CELL = "tw:bg-surface tw:px-[19px] tw:py-[17px]";
const JOURNAL_METRIC_LABEL =
  "tw:mb-2 tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.09em] tw:text-ink-700";
const JOURNAL_METRIC_VALUE = "tw:text-[1.2rem]";

const JOURNAL_ROW_LAYOUT =
  "journal-row tw:grid tw:items-center tw:gap-[14px] tw:border-b tw:border-b-line-subtle tw:px-5 tw:py-[15px]";
const JOURNAL_ROW_TEXT = "tw:text-[0.8rem] tw:text-ink-300";
const JOURNAL_HEADER_TEXT =
  "journal-header tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-ink-750";
const JOURNAL_CELL_STRONG = "tw:block";
const JOURNAL_CELL_SMALL = "tw:mt-1 tw:block tw:text-[0.66rem] tw:text-ink-700";
const UNRESOLVED_ROW =
  "bot-unresolved-row tw:min-w-[720px] tw:grid-cols-[1.2fr_0.9fr_0.9fr_1fr_1fr]";
const HISTORY_ROW =
  "bot-history-row tw:min-w-[1020px] tw:grid-cols-[1.35fr_0.9fr_0.9fr_0.55fr_0.75fr_0.5fr_0.8fr_0.75fr]";
const HISTORY_SCROLL =
  "bot-history-scroll tw:max-h-[min(640px,62vh)] tw:overflow-y-auto tw:overscroll-contain tw:[scrollbar-gutter:stable] tw:focus-visible:outline-1 tw:focus-visible:outline-line-accent tw:focus-visible:outline-offset-[-1px]";

const PROJECTION_BUTTON =
  "tw:cursor-pointer tw:border-0 tw:bg-surface tw:px-[11px] tw:py-2 tw:font-mono tw:text-[0.58rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-600 tw:below-700:px-2 tw:below-700:py-[7px]";
const PROJECTION_BUTTON_PRESSED =
  "tw:aria-pressed:bg-accent tw:aria-pressed:text-on-accent";

const PROJECTION_TIPS: Record<PaperJournalProjection, string> = {
  FUNDED:
    "The funded paper account bound to live runs. Its filled orders, cash effects and exits are the account-style ledger, and they are never added to the shadow projections.",
  COORDINATED:
    "One capital-constrained shadow portfolio. This is the account-style performance view, including its running balance.",
  INDEPENDENT:
    "One execution per strategy lifecycle. These positions can overlap, so this is strategy evidence rather than one account result.",
};

function query(
  marketId: "CA_TSX" | "US_EQUITIES",
  projection: PaperJournalProjection,
): string {
  return new URLSearchParams({
    marketId,
    source: "LIVE",
    projection,
    limit: "500",
  }).toString();
}

function money(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
}

function rate(value: PaperTradeJournal["totals"]["winRate"]): string {
  return value.value === null ? "—" : `${(value.value * 100).toFixed(1)}%`;
}

function time(
  value: string | null,
  marketId: "CA_TSX" | "US_EQUITIES",
): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:
      marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function stamp(
  value: string | null,
  marketId: "CA_TSX" | "US_EQUITIES",
): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:
      marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function tone(value: number | null): string {
  return value === null ? "" : value >= 0 ? "positive" : "negative";
}

function daily(entries: PaperJournalEntry[]): Map<string, PaperJournalEntry[]> {
  return entries.reduce((groups, entry) => {
    const group = groups.get(entry.sessionDate) ?? [];
    group.push(entry);
    groups.set(entry.sessionDate, group);
    return groups;
  }, new Map<string, PaperJournalEntry[]>());
}

/**
 * A durable, day-organized reading of the paper bot's existing P&L ledger.
 * It deliberately has no TODAY filter: the database ledger is retained across
 * market closes, and this surface makes that retained history the default.
 * The funded paper account is the default projection, because it is the one
 * account-style result with real cash and reservation effects.
 */
export function BotPerformanceView({
  marketId = "CA_TSX",
}: {
  marketId?: "CA_TSX" | "US_EQUITIES";
} = {}) {
  const [projection, setProjection] =
    useState<PaperJournalProjection>("FUNDED");
  const [journal, setJournal] = useState<PaperTradeJournal | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getJson(
      `/api/paper-bot/journal?${query(marketId, projection)}`,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setJournal(paperTradeJournalSchema.parse(value));
        setLastLoadedAt(new Date().toISOString());
        setError("");
      })
      .catch((reason: unknown) => {
        // The previous journal stays visible; the banner marks it as what it
        // is — the last known good read, not current.
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
  }, [marketId, projection, reload]);

  useRefreshOnFocus(() => setReload((value) => value + 1), 10_000);

  // Bounded background refresh while the tab is visible, so unresolved
  // positions and new closes appear without a manual action.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setReload((value) => value + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const entriesByDay = useMemo(() => daily(journal?.entries ?? []), [journal]);
  const totals = journal?.totals;
  const coordinated = projection === "COORDINATED";
  const funded = projection === "FUNDED";

  return (
    <>
      <section className="bot-history-controls panel tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-[18px] tw:px-5 tw:py-[15px]">
        <Tip label="This is the durable record of paper-bot positions. It is not reset by the market-close workflow; the page shows the 500 most recent positions.">
          <div>
            <strong className="tw:text-ink-150">Preserved daily ledger</strong>
            <p className="tw:mt-[5px] tw:mb-0 tw:text-[0.75rem] tw:text-ink-700">
              Every completed bot trade remains here after market close. Showing
              up to the latest 500 preserved positions.
            </p>
          </div>
        </Tip>
        <div
          aria-label="Performance projection"
          className="bot-projection tw:flex tw:h-max tw:gap-px tw:overflow-hidden tw:rounded-[6px] tw:border tw:border-line tw:bg-line"
          role="group"
        >
          {(["FUNDED", "COORDINATED", "INDEPENDENT"] as const).map((value) => (
            <Tip key={value} label={PROJECTION_TIPS[value]}>
              <button
                aria-pressed={projection === value}
                className={classes(
                  PROJECTION_BUTTON,
                  projection === value && PROJECTION_BUTTON_PRESSED,
                )}
                onClick={() => setProjection(value)}
                type="button"
              >
                {value}
              </button>
            </Tip>
          ))}
        </div>
        <div
          className="bot-history-fresh tw:flex tw:shrink-0 tw:grow-0 tw:basis-auto tw:items-center tw:gap-[10px]"
          aria-label="Refresh state"
        >
          <span
            className="tw:whitespace-nowrap tw:font-mono tw:text-[0.62rem] tw:font-[650] tw:leading-[normal] tw:tracking-[0.05em] tw:text-ink-650"
            role="status"
          >
            {loading
              ? "Refreshing…"
              : lastLoadedAt
                ? `Checked ${ago(now, lastLoadedAt)}`
                : "Not checked yet"}
          </span>
          <button
            className={PAPER_BUTTON}
            type="button"
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            REFRESH
          </button>
        </div>
      </section>

      {error ? (
        <p className="error-banner">
          {error} · showing the last successful read
        </p>
      ) : null}
      <section className={HISTORY_METRICS}>
        <Tip label="The number of bot positions that have reached a final exit. Open or close-pending positions are excluded.">
          <div className={JOURNAL_METRIC_CELL}>
            <span className={JOURNAL_METRIC_LABEL}>CLOSED</span>
            <strong className={JOURNAL_METRIC_VALUE}>
              {totals?.closedTrades ?? 0}
            </strong>
          </div>
        </Tip>
        <Tip label="Open or close-pending positions in the selected projection. They stay visible below and are excluded from realized P&L until they exit.">
          <div className={JOURNAL_METRIC_CELL}>
            <span className={JOURNAL_METRIC_LABEL}>OPEN</span>
            <strong className={JOURNAL_METRIC_VALUE}>
              {totals?.openPositions ?? 0}
            </strong>
          </div>
        </Tip>
        <Tip label="Realized profit or loss after trading costs, summed across the selected performance projection.">
          <div className={JOURNAL_METRIC_CELL}>
            <span className={JOURNAL_METRIC_LABEL}>NET P&amp;L</span>
            <strong
              className={classes(
                JOURNAL_METRIC_VALUE,
                tone(totals?.netPnl ?? null),
              )}
            >
              {money(totals?.netPnl ?? null)}
            </strong>
          </div>
        </Tip>
        <Tip label="Average result per closed position in R, where 1R equals that position's initial risk. Positive is favorable; negative is unfavorable.">
          <div className={JOURNAL_METRIC_CELL}>
            <span className={JOURNAL_METRIC_LABEL}>AVG R</span>
            <strong className={JOURNAL_METRIC_VALUE}>
              {totals?.averageR == null
                ? "—"
                : `${totals.averageR.toFixed(2)}R`}
            </strong>
          </div>
        </Tip>
        <Tip label="The percentage of closed positions with a positive net P&L. Scratch trades are excluded from both wins and losses.">
          <div className={JOURNAL_METRIC_CELL}>
            <span className={JOURNAL_METRIC_LABEL}>WIN RATE</span>
            <strong className={JOURNAL_METRIC_VALUE}>
              {totals ? rate(totals.winRate) : "—"}
            </strong>
          </div>
        </Tip>
        <Tip label="Total realized gains divided by total realized losses. A value above 1.00 means gains outweigh losses; it is unavailable until there is a losing trade.">
          <div className={JOURNAL_METRIC_CELL}>
            <span className={JOURNAL_METRIC_LABEL}>PROFIT FACTOR</span>
            <strong className={JOURNAL_METRIC_VALUE}>
              {totals?.profitFactor?.toFixed(2) ?? "—"}
            </strong>
          </div>
        </Tip>
      </section>

      {journal && (journal.unresolvedPositions?.length ?? 0) > 0 ? (
        <section className="panel bot-history-panel bot-unresolved-panel tw:mt-[18px]">
          <div className="panel-title">
            <div>
              <h3>Unfinished positions</h3>
              <p className="tw:mt-1 tw:mb-0 tw:text-[0.75rem] tw:text-ink-700">
                {funded
                  ? "Funded paper account · excluded from the CLOSED results above until every exit settles."
                  : "Coordinated shadow portfolio · excluded from the CLOSED results above; funded-account results are reported on the BOT tab."}
              </p>
            </div>
            <span>{journal.unresolvedPositions!.length} UNRESOLVED</span>
          </div>
          <div className="journal-table tw:overflow-x-auto">
            <div
              className={classes(
                JOURNAL_ROW_LAYOUT,
                JOURNAL_HEADER_TEXT,
                UNRESOLVED_ROW,
              )}
            >
              <span className="tw:m-0">SYMBOL</span>
              <span className="tw:m-0">STATUS</span>
              <span className="tw:m-0">RUN</span>
              <span className="tw:m-0">OPENED</span>
              <Tip label="When the latest fact was applied to this position. This is not holding duration — Opened shows when the position was entered.">
                <span className="tw:m-0">LAST ACTIVITY</span>
              </Tip>
            </div>
            {journal.unresolvedPositions!.map((position) => (
              <article
                className={classes(
                  JOURNAL_ROW_LAYOUT,
                  JOURNAL_ROW_TEXT,
                  UNRESOLVED_ROW,
                )}
                key={position.id}
              >
                <span>
                  <strong className={JOURNAL_CELL_STRONG}>
                    {position.symbol}
                  </strong>
                  <small className={JOURNAL_CELL_SMALL}>
                    session {position.sessionDate}
                  </small>
                </span>
                <span>
                  <i
                    className={classes(
                      `badge badge-${position.status
                        .toLowerCase()
                        .replace("_", "-")}`,
                      "tw:px-2 tw:py-[6px]",
                    )}
                  >
                    {position.status.replaceAll("_", " ")}
                  </i>
                </span>
                <span>{position.runStatus.replaceAll("_", " ")}</span>
                <span>
                  <b>{stamp(position.entryTime, marketId)}</b>
                  <small className={JOURNAL_CELL_SMALL}>
                    {position.entryTime ? "entry time" : "not recorded"}
                  </small>
                </span>
                <span>
                  <b>{stamp(position.lastFactTimestamp, marketId)}</b>
                  <small className={JOURNAL_CELL_SMALL}>
                    {position.lastFactTimestamp
                      ? "latest processed fact"
                      : "no fact processed yet"}
                  </small>
                </span>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel bot-history-panel">
        <div className="panel-title">
          <div>
            <h3>Bot performance history</h3>
            <p className="tw:mt-1 tw:mb-0 tw:text-[0.75rem] tw:text-ink-700">
              {funded
                ? "The funded paper account's filled orders, grouped by session date with its running realized P&L."
                : coordinated
                  ? "One coordinated paper account, grouped by session date."
                  : "Independent strategy evidence; positions may overlap and are not one account balance."}
            </p>
          </div>
          <span>{journal?.entries.length ?? 0} POSITIONS</span>
        </div>
        {loading ? (
          <div className="empty">Loading preserved bot performance…</div>
        ) : entriesByDay.size === 0 ? (
          <div className="empty">
            {funded
              ? "No funded paper positions yet."
              : "No preserved bot positions yet."}
          </div>
        ) : (
          <div className={HISTORY_SCROLL} tabIndex={0}>
            {[...entriesByDay].map(([date, entries]) => (
              <section
                className="bot-history-day tw:[&:not(:first-of-type)]:border-t tw:[&:not(:first-of-type)]:border-t-line"
                key={date}
              >
                <h4 className="tw:sticky tw:top-0 tw:z-[1] tw:m-0 tw:bg-surface-sunken tw:px-5 tw:py-[13px] tw:font-mono tw:text-[0.68rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-accent">
                  {date}
                </h4>
                <div className="journal-table tw:overflow-x-auto">
                  <div
                    className={classes(
                      JOURNAL_ROW_LAYOUT,
                      JOURNAL_HEADER_TEXT,
                      HISTORY_ROW,
                    )}
                  >
                    <span className="tw:m-0">SYMBOL / SETUP</span>
                    <span className="tw:m-0">ENTRY</span>
                    <span className="tw:m-0">EXIT</span>
                    <span className="tw:m-0">SHARES</span>
                    <span className="tw:m-0">NET P&amp;L</span>
                    <span className="tw:m-0">R</span>
                    <span className="tw:m-0">BALANCE</span>
                    <span className="tw:m-0">STATUS</span>
                  </div>
                  {entries.map((entry) => {
                    const netPnlTone = tone(entry.netPnl);
                    const runningTone = tone(entry.runningNetPnl);
                    return (
                      <article
                        className={classes(
                          JOURNAL_ROW_LAYOUT,
                          JOURNAL_ROW_TEXT,
                          HISTORY_ROW,
                        )}
                        key={entry.id}
                      >
                        <span>
                          <strong className={JOURNAL_CELL_STRONG}>
                            {entry.symbol}
                          </strong>
                          <small className={JOURNAL_CELL_SMALL}>
                            {entry.strategyKey.replaceAll("_", " ")} ·{" "}
                            {entry.profileName}
                          </small>
                        </span>
                        <span>
                          <b>
                            {entry.entryPrice === null
                              ? "—"
                              : `$${entry.entryPrice.toFixed(2)}`}
                          </b>
                          <small className={JOURNAL_CELL_SMALL}>
                            {time(entry.entryTime, marketId)}
                          </small>
                        </span>
                        <span>
                          <b>
                            {entry.exitPrice === null
                              ? "—"
                              : `$${entry.exitPrice.toFixed(2)}`}
                          </b>
                          <small className={JOURNAL_CELL_SMALL}>
                            {entry.exitReason?.replaceAll("_", " ") ?? "OPEN"}
                          </small>
                        </span>
                        <span>{entry.shares ?? "—"}</span>
                        <span
                          className={classes(
                            netPnlTone,
                            netPnlTone && "tw:font-[750]",
                          )}
                        >
                          {money(entry.netPnl)}
                        </span>
                        <span>
                          {entry.rMultiple === null
                            ? "—"
                            : `${entry.rMultiple.toFixed(2)}R`}
                        </span>
                        <span
                          className={classes(
                            runningTone,
                            runningTone && "tw:font-[750]",
                          )}
                        >
                          {money(entry.runningNetPnl)}
                        </span>
                        <span>
                          <i className="badge tw:px-2 tw:py-[6px] tw:whitespace-nowrap">
                            {entry.status.replaceAll("_", " ")}
                          </i>
                          {entry.recoverySource ? (
                            <Tip
                              label={`Recovered during settlement (${entry.recoverySource.replaceAll("_", " ")})${
                                entry.recoveryDelayMs === null ||
                                entry.recoveryDelayMs === undefined
                                  ? ""
                                  : ` · ${(entry.recoveryDelayMs / 1000).toFixed(1)}s after the scheduled boundary`
                              }. The original fact timestamps are preserved.`}
                            >
                              <i className="badge badge-recovered tw:mt-[5px] tw:border-line-warn tw:bg-surface-warn tw:px-2 tw:py-[6px] tw:text-warn-soft tw:whitespace-nowrap">
                                RECOVERED
                              </i>
                            </Tip>
                          ) : null}
                        </span>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>
      {journal ? (
        <BotPerformanceGraph
          latestSessionDate={journal.entries[0]?.sessionDate ?? null}
          marketId={marketId}
        />
      ) : null}
    </>
  );
}
