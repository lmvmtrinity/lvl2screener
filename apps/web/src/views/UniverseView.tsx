import {
  type CandidateIntakeStatus,
  type CandidatePasteReport,
  type UniverseAutomation,
  type UniverseRefreshRun,
  universeRefreshRunListSchema,
  universeResponseSchema,
} from "@tsx-scanner/contracts";
import {
  Fragment,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Panel, PanelHeader, PanelMeta } from "../components/ui/Panel.js";
import { getJson, sendJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { ago, countdown } from "../lib/format.js";
import { useNow } from "../lib/use-now.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";

const RUN_POLL_MS = 5_000;

/* Complete utility strings per state: only one class may set a given
 * declaration, because stylesheet order (not JSX order) decides conflicts. */
const LIFECYCLE_CHIP_BASE =
  "tw:rounded-[4px] tw:px-[6px] tw:py-1 tw:font-mono tw:text-[0.54rem] tw:font-bold tw:not-italic";
const LIFECYCLE_CHIP_TONE: Record<string, string> = {
  default: "tw:bg-surface-raised tw:text-accent",
  warming: "tw:bg-surface-warn tw:text-warn",
  qualified: "tw:bg-surface-warn tw:text-warn",
  unavailable: "tw:bg-surface-danger tw:text-danger-soft",
  invalidated: "tw:bg-surface-danger tw:text-danger-soft",
  excluded: "tw:bg-surface-danger tw:text-danger-soft",
  failed: "tw:bg-surface-danger tw:text-danger-soft",
};

const ROW_STATUS_BASE =
  "tw:w-max tw:rounded-[5px] tw:border tw:px-2 tw:py-[6px] tw:font-mono tw:text-[0.58rem] tw:font-bold tw:tracking-[0.07em] tw:not-italic";
const ROW_STATUS_TONE: Record<string, string> = {
  default: "tw:border-line-accent tw:bg-surface-raised tw:text-accent",
  excluded: "tw:border-line-warn tw:bg-surface-warn tw:text-warn",
  warming: "tw:border-line-warn tw:bg-surface-warn tw:text-warn",
  unavailable: "tw:border-line-danger tw:bg-surface-danger tw:text-danger-soft",
  invalidated: "tw:border-line-danger tw:bg-surface-danger tw:text-danger-soft",
};

const PIPELINE_BASE =
  "tw:rounded-[4px] tw:border tw:border-line-input tw:bg-surface tw:px-[7px] tw:py-[5px] tw:font-mono tw:text-[0.56rem] tw:font-bold tw:tracking-[0.06em]";
const PIPELINE_TONE: Record<string, string> = {
  default: "tw:text-ink-550",
  warming: "tw:text-warn",
  qualified: "tw:text-warn",
  excluded: "tw:text-danger-soft",
  failed: "tw:text-danger-soft",
};

const PASTE_GROUP_TONE: Record<string, string> = {
  default: "tw:text-ink-550",
  unsupported: "tw:text-danger-soft",
  failed: "tw:text-danger-soft",
  duplicate: "tw:text-warn",
};

const WATCHLIST_ACTIONS_CLASSES =
  "tw:flex tw:flex-col tw:gap-[7px] tw:below-md:w-full";
const WATCHLIST_ACTION_CLASSES =
  "tw:cursor-pointer tw:rounded-input tw:border tw:border-line-input tw:bg-surface tw:px-3 tw:py-[9px] tw:font-mono tw:text-[0.61rem] tw:font-bold tw:tracking-[0.05em] tw:text-ink-450 tw:disabled:cursor-not-allowed tw:disabled:opacity-45";
const WATCHLIST_ACTION_DANGER_CLASSES =
  "tw:cursor-pointer tw:rounded-input tw:border tw:border-line-danger tw:bg-surface-danger tw:px-3 tw:py-[9px] tw:font-mono tw:text-[0.61rem] tw:font-bold tw:tracking-[0.05em] tw:text-danger-soft tw:disabled:cursor-not-allowed tw:disabled:opacity-45";

const FIELD_LABEL_CLASSES =
  "tw:flex tw:flex-1 tw:flex-col tw:gap-[7px] tw:font-mono tw:text-[0.63rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-700";
const FIELD_CONTROL_CLASSES =
  "tw:w-full tw:rounded-input tw:border tw:border-line-input tw:bg-bg tw:px-3 tw:py-[11px] tw:text-ink-100 tw:outline-none tw:focus:border-accent";

const UNIVERSE_ROW_BASE =
  "tw:grid tw:min-w-[1120px] tw:grid-cols-[1.05fr_0.7fr_0.6fr_0.8fr_0.9fr_0.8fr_0.55fr_1.7fr] tw:items-center tw:gap-[14px] tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-[15px]";
const UNIVERSE_HEADER_CLASSES = classes(
  UNIVERSE_ROW_BASE,
  "tw:font-mono tw:text-[0.6rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-750",
);
const UNIVERSE_BODY_CLASSES = classes(
  UNIVERSE_ROW_BASE,
  "tw:text-[0.78rem] tw:text-ink-350",
);

const HISTORY_RUN_BASE =
  "universe-run tw:grid tw:grid-cols-[88px_1.5fr_1.5fr_1.3fr_1.4fr] tw:items-center tw:gap-[18px] tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-[15px] tw:text-[0.74rem] tw:text-ink-550 tw:below-900:grid-cols-[80px_1.3fr_1fr]";

function elapsedText(
  startedAt: string,
  completedAt: string | null,
): string | null {
  if (!completedAt) return null;
  const milliseconds = Math.max(
    0,
    Date.parse(completedAt) - Date.parse(startedAt),
  );
  if (milliseconds < 1_000) return "<1s";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stageLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "not recorded";
}

function WarmupTimeline({
  symbol,
  pipeline,
}: {
  symbol: string;
  pipeline?: CandidateIntakeStatus;
}) {
  const stages = [
    { label: "Discovered", at: pipeline?.discoveredAt ?? null },
    { label: "Intake", at: pipeline?.intakeAt ?? null },
    { label: "Strategy ready", at: pipeline?.strategyReadyAt ?? null },
  ];
  return (
    <div className="candidate-warmup tw:basis-full tw:rounded-input tw:border tw:border-line-input tw:bg-surface-sunken tw:px-[14px] tw:py-3">
      <div className="candidate-warmup-head tw:flex tw:items-baseline tw:gap-[10px]">
        <strong className="tw:text-[0.8rem] tw:text-ink-150">
          {symbol} warm-up
        </strong>
        <small className="tw:text-[0.66rem] tw:text-ink-700">
          {pipeline
            ? `${pipeline.source} · ${pipeline.status}`
            : "No lifecycle record"}
        </small>
        {pipeline?.status === "FAILED" ? (
          <b className="tw:ml-auto tw:font-mono tw:text-[0.62rem] tw:font-bold tw:text-danger-soft">
            {pipeline.attemptCount} attempts
          </b>
        ) : null}
      </div>
      <ol className="candidate-warmup-stages tw:m-0 tw:mt-[10px] tw:grid tw:list-none tw:gap-[5px] tw:p-0">
        {stages.map((stage) => (
          <li
            className="tw:grid tw:grid-cols-[120px_1fr] tw:gap-3 tw:text-[0.72rem]"
            key={stage.label}
          >
            <div className="tw:text-ink-700">{stage.label}</div>
            <b className="tw:font-mono tw:font-semibold tw:text-ink-250">
              {stageLabel(stage.at)}
            </b>
          </li>
        ))}
      </ol>
      {pipeline?.reason ? (
        <p className="candidate-warmup-reason tw:mt-[9px] tw:mb-0 tw:text-[0.7rem] tw:text-warn">
          {pipeline.reason}
        </p>
      ) : null}
    </div>
  );
}

export function UniverseView({
  automation,
  updated,
  marketId = "CA_TSX",
  marketChanged,
}: {
  automation: UniverseAutomation;
  updated: (value: UniverseAutomation) => void;
  marketId?: "CA_TSX" | "US_EQUITIES";
  marketChanged?: (value: "CA_TSX" | "US_EQUITIES") => void;
}) {
  const [runs, setRuns] = useState<UniverseRefreshRun[]>(
      automation.latestRun ? [automation.latestRun] : [],
    ),
    [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set()),
    [refreshing, setRefreshing] = useState(false),
    [symbolInput, setSymbolInput] = useState(""),
    [note, setNote] = useState(""),
    [tags, setTags] = useState(""),
    [report, setReport] = useState<CandidatePasteReport>(),
    [error, setError] = useState(""),
    [refreshNote, setRefreshNote] = useState(""),
    [lastHistoryLoadAt, setLastHistoryLoadAt] = useState<number | null>(null);
  const now = useNow();
  const historyGeneration = useRef(0);
  const historyRequest = useRef<{
    controller: AbortController;
    generation: number;
  } | null>(null);

  const loadHistory = useCallback(async () => {
    if (historyRequest.current) return;
    const generation = historyGeneration.current;
    const controller = new AbortController();
    historyRequest.current = { controller, generation };
    try {
      const value = universeRefreshRunListSchema.parse(
        await getJson(
          `/api/universe/runs?limit=20&marketId=${marketId}`,
          controller.signal,
        ),
      );
      if (generation !== historyGeneration.current) return;
      setRuns(value.runs);
      setRefreshNote("");
      setLastHistoryLoadAt(Date.now());
    } catch (reason) {
      if (generation !== historyGeneration.current) return;
      if (reason instanceof DOMException && reason.name === "AbortError")
        return;
      setRefreshNote("could not refresh · showing last known");
    } finally {
      if (historyRequest.current?.controller === controller)
        historyRequest.current = null;
    }
  }, [marketId]);

  useEffect(() => {
    historyGeneration.current += 1;
    historyRequest.current?.controller.abort();
    historyRequest.current = null;
    setRuns(automation.latestRun ? [automation.latestRun] : []);
    setRefreshNote("");
    setLastHistoryLoadAt(null);
    void loadHistory();
    return () => {
      historyRequest.current?.controller.abort();
      historyRequest.current = null;
    };
  }, [loadHistory]);

  const latestRun = runs[0] ?? automation.latestRun;
  const running = latestRun?.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void loadHistory(), RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, loadHistory]);

  const accept = (value: ReturnType<typeof universeResponseSchema.parse>) => {
    updated(value.automation);
    if (value.automation.latestRun)
      setRuns((current) => [
        value.automation.latestRun!,
        ...current.filter((run) => run.id !== value.automation.latestRun!.id),
      ]);
  };

  const loadAutomation = async () => {
    const generation = historyGeneration.current;
    try {
      const value = universeResponseSchema.parse(
        await getJson(`/api/universe?marketId=${marketId}`),
      );
      if (generation !== historyGeneration.current) return;
      accept(value);
      setRefreshNote("");
    } catch (reason) {
      if (generation !== historyGeneration.current) return;
      if (reason instanceof DOMException && reason.name === "AbortError")
        return;
      setRefreshNote("could not refresh · showing last known");
    }
  };

  useRefreshOnFocus(() => {
    void loadHistory();
    void loadAutomation();
  });

  const refresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      accept(
        universeResponseSchema.parse(
          await sendJson(
            `/api/universe/refresh?marketId=${marketId}`,
            "POST",
            {},
          ),
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Universe refresh failed",
      );
    } finally {
      setRefreshing(false);
    }
  };
  const configured =
    automation.configuredSymbols ??
    automation.members.map((value) => value.symbol);
  const save = async (symbols: string[]) => {
    setRefreshing(true);
    setError("");
    try {
      accept(
        universeResponseSchema.parse(
          await sendJson(
            `/api/universe/watchlist?marketId=${marketId}`,
            "PUT",
            { symbols },
          ),
        ),
      );
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Watchlist update failed",
      );
      return false;
    } finally {
      setRefreshing(false);
    }
  };
  const pasted = () =>
    symbolInput
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  const submit = async (operation: "ADD" | "REPLACE") => {
    const inputs = pasted();
    if (!inputs.length) {
      setError("Paste at least one TradingView symbol first");
      return;
    }
    setRefreshing(true);
    setError("");
    try {
      const value = universeResponseSchema.parse(
        await sendJson(
          `/api/universe/candidates?marketId=${marketId}`,
          "POST",
          {
            operation,
            source: "TRADINGVIEW",
            inputs,
            note: note.trim() || null,
            tags: tags
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          },
        ),
      );
      accept(value);
      setReport(value.pasteReport);
      if (value.refreshError)
        setError(
          `Candidates were saved, but market-data refresh failed: ${value.refreshError}`,
        );
      setSymbolInput("");
      setNote("");
      setTags("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Candidate intake failed",
      );
    } finally {
      setRefreshing(false);
    }
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    await submit("ADD");
  };
  const replace = async () => {
    await submit("REPLACE");
  };
  const remove = async (value: string) => {
    await save(configured.filter((candidate) => candidate !== value));
  };
  const clear = async () => {
    if (window.confirm("Clear today's entire analysis watchlist?"))
      await save([]);
  };
  const toggleExpanded = (symbol: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  const eligible = automation.members.filter((value) => value.eligible).length,
    excluded = automation.members.length - eligible,
    p = automation.policy;
  const money = (value: number | null) =>
    value === null
      ? "—"
      : value >= 1_000_000_000
        ? `$${(value / 1_000_000_000).toFixed(1)}B`
        : `$${(value / 1_000_000).toFixed(1)}M`;
  const entries = new Map(
      automation.candidates?.map((value) => [value.normalizedSymbol, value]) ??
        [],
    ),
    coverage = new Map(
      automation.coverage?.map((value) => [value.symbol, value]) ?? [],
    );
  const pipelineStatuses = automation.candidateStatuses ?? [];
  const pipelineBySymbol = new Map(
    pipelineStatuses.map((value) => [value.symbol, value]),
  );
  const pipelineSummary = [
    "QUALIFIED",
    "ADDED",
    "WARMING",
    "READY",
    "EXCLUDED",
    "FAILED",
  ] as const;
  const reportGroups = report
    ? (
        [
          "accepted",
          "normalized",
          "duplicate",
          "unsupported",
          "failed",
        ] as const
      ).filter((key) => report[key].length)
    : [];
  const marketLabel = p.marketId === "US_EQUITIES" ? "US Equities" : "TSX";
  const currency = p.marketId === "US_EQUITIES" ? "USD" : "CAD";
  const history =
    latestRun && !runs.some((run) => run.id === latestRun.id)
      ? [latestRun, ...runs]
      : runs;
  const lastSuccess = history.find(
    (run) => run.status === "COMPLETED" && run.completedAt,
  );
  const nextCheckAt =
    running && lastHistoryLoadAt !== null
      ? new Date(lastHistoryLoadAt + RUN_POLL_MS).toISOString()
      : null;
  const failureReason =
    latestRun?.error ??
    (latestRun?.warnings.length ? latestRun.warnings.join(" · ") : null) ??
    "No reason reported";
  const activity = running
    ? {
        tone: "running",
        headline: "Refreshing now",
        detail: `started ${ago(now, latestRun?.startedAt)}`,
      }
    : latestRun?.status === "FAILED"
      ? {
          tone: "failed",
          headline: "Refresh failed",
          detail: `failed ${ago(now, latestRun?.startedAt)}`,
        }
      : latestRun?.status === "COMPLETED"
        ? {
            tone: "completed",
            headline: "Refresh completed",
            detail: ago(now, latestRun?.completedAt),
          }
        : {
            tone: "idle",
            headline: "No refresh recorded yet",
            detail: "",
          };
  const healthFailed = latestRun?.status === "FAILED";
  const policyPanel = (
    <Panel
      as="article"
      className={classes("universe-policy", automation.editable && "tw:mb-4")}
    >
      <PanelHeader
        className="tw:below-560:flex-col tw:below-560:items-start tw:below-560:gap-[15px]"
        title={
          automation.editable
            ? "Level-2 analysis context"
            : `${marketLabel} Liquid Momentum`
        }
        description={
          automation.editable
            ? "TradingView supplies the daily candidates; every valid symbol is passed to all enabled strategies."
            : `Automated Level-1 eligibility policy · ${p.version}`
        }
        descriptionClassName="tw:mt-[5px] tw:mb-0 tw:text-[0.75rem] tw:text-ink-700"
        actions={
          <button
            type="button"
            className="run-backtest universe-refresh tw:m-0 tw:w-auto tw:cursor-pointer tw:rounded-[7px] tw:border tw:border-accent tw:bg-accent tw:px-[15px] tw:py-[10px] tw:font-mono tw:text-[0.65rem] tw:font-[750] tw:tracking-[0.08em] tw:text-on-accent tw:disabled:cursor-wait tw:disabled:opacity-45"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? "REFRESHING…" : "REFRESH NOW"}
          </button>
        }
      />
      <div className="policy-grid tw:grid tw:grid-cols-3 tw:gap-px tw:bg-surface-sunken tw:below-900:grid-cols-2 tw:below-560:grid-cols-1">
        <span className="tw:flex tw:flex-col tw:gap-2 tw:bg-surface tw:px-[22px] tw:py-[19px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-700">
          REFERENCE PRICE{" "}
          <b className="tw:text-[0.82rem] tw:tracking-normal tw:text-ink-150">
            {currency} {p.minimumPrice}–{p.maximumPrice}
          </b>
        </span>
        <span className="tw:flex tw:flex-col tw:gap-2 tw:bg-surface tw:px-[22px] tw:py-[19px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-700">
          MARKET CAP{" "}
          <b className="tw:text-[0.82rem] tw:tracking-normal tw:text-ink-150">
            ≥ {money(p.minimumMarketCap)}
          </b>
        </span>
        <span className="tw:flex tw:flex-col tw:gap-2 tw:bg-surface tw:px-[22px] tw:py-[19px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-700">
          AVG VOL{" "}
          <b className="tw:text-[0.82rem] tw:tracking-normal tw:text-ink-150">
            ≥ {(p.minimumAverageVolume90d / 1_000).toFixed(0)}K
          </b>
        </span>
        <span className="tw:flex tw:flex-col tw:gap-2 tw:bg-surface tw:px-[22px] tw:py-[19px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-700">
          DOLLAR VOL{" "}
          <b className="tw:text-[0.82rem] tw:tracking-normal tw:text-ink-150">
            ≥ {money(p.minimumDollarVolume)}
          </b>
        </span>
        <span className="tw:flex tw:flex-col tw:gap-2 tw:bg-surface tw:px-[22px] tw:py-[19px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-700">
          ATR(14){" "}
          <b className="tw:text-[0.82rem] tw:tracking-normal tw:text-ink-150">
            ≥ {p.minimumAtrPct}%
          </b>
        </span>
        <span className="tw:flex tw:flex-col tw:gap-2 tw:bg-surface tw:px-[22px] tw:py-[19px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-700">
          HISTORY{" "}
          <b className="tw:text-[0.82rem] tw:tracking-normal tw:text-ink-150">
            ≥ {p.minimumHistoryDays} days
          </b>
        </span>
      </div>
    </Panel>
  );
  const healthCard = (
    <article
      className={classes(
        "universe-health tw:flex tw:flex-col tw:justify-center tw:rounded-panel tw:border tw:p-[26px]",
        healthFailed
          ? "tw:border-line-danger-strong tw:bg-surface-danger"
          : "tw:border-line-accent tw:bg-surface",
      )}
    >
      <span className="tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.1em] tw:text-ink-700">
        DAILY WATCHLIST
      </span>
      <strong
        className={classes(
          "tw:my-[10px] tw:text-[1.6rem]",
          healthFailed ? "tw:text-danger" : "tw:text-accent",
        )}
      >
        {configured.length} SYMBOLS
      </strong>
      <b className="tw:font-mono tw:text-[0.72rem] tw:font-bold">
        {eligible} ANALYZED · {excluded} UNAVAILABLE
      </b>
      <small className="tw:mt-[17px] tw:text-ink-700">
        {latestRun?.status ?? "NOT RUN"} ·{" "}
        {automation.watchlistDate ??
          (latestRun?.completedAt
            ? new Date(latestRun.completedAt).toLocaleDateString()
            : automation.provider)}
      </small>
    </article>
  );
  const activityPanel = (
    <Panel
      as="section"
      className="universe-activity tw:px-[22px] tw:py-4"
      aria-label="Refresh activity"
    >
      <div className="universe-activity-headline tw:flex tw:items-baseline tw:gap-[2px] tw:text-[0.98rem]">
        <strong
          className={classes(
            activity.tone === "running"
              ? "tw:text-accent"
              : activity.tone === "failed"
                ? "tw:text-danger"
                : "tw:text-ink-150",
          )}
          role="status"
        >
          {activity.headline}
        </strong>
        {activity.detail ? (
          <span className="tw:text-[0.8rem] tw:text-ink-550">
            {" "}
            · {activity.detail}
          </span>
        ) : null}
      </div>
      <p className="universe-activity-meta tw:mt-[7px] tw:mb-0 tw:text-[0.78rem] tw:text-ink-700">
        {lastSuccess ? (
          <>
            Last successful refresh {ago(now, lastSuccess.completedAt)} · took{" "}
            {elapsedText(lastSuccess.startedAt, lastSuccess.completedAt)}
          </>
        ) : (
          "No successful refresh recorded yet."
        )}
        {nextCheckAt ? <> · next check {countdown(now, nextCheckAt)}</> : null}
      </p>
      {latestRun?.status === "FAILED" ? (
        <p className="universe-activity-failure tw:mt-[9px] tw:mb-0 tw:rounded-[7px] tw:border tw:border-line-danger tw:bg-surface-danger tw:px-[11px] tw:py-[9px] tw:text-[0.78rem] tw:text-danger-soft">
          <b className="tw:text-danger">{failureReason}</b> — previous analysis
          set remains active.
        </p>
      ) : null}
      {refreshNote ? (
        <p className="universe-activity-stale tw:mt-2 tw:mb-0 tw:text-[0.76rem] tw:text-warn">
          {refreshNote}
        </p>
      ) : null}
    </Panel>
  );
  const watchlistPanel = (
    <Panel as="section" className="watchlist-panel tw:border-line-accent">
      <PanelHeader
        className="tw:below-md:flex-col tw:below-md:items-start tw:below-md:gap-[15px]"
        emphasis="headline"
        title="TradingView candidates"
        description="Paste comma-, space-, or line-separated symbols. Bare symbols use the selected input market; exchange prefixes such as `TSX:SHOP`, `NASDAQ:AAPL`, and `NYSE:BAM` are also recognized."
        actions={
          <>
            <label className="tw:flex tw:items-center tw:gap-[0.55rem] tw:text-[0.68rem] tw:tracking-[0.12em] tw:text-ink-550">
              INPUT MARKET
              <select
                className="tw:min-w-[8.5rem]"
                aria-label="Candidate input market"
                value={marketId}
                onChange={(event) =>
                  marketChanged?.(
                    event.target.value as "CA_TSX" | "US_EQUITIES",
                  )
                }
              >
                <option value="CA_TSX">TSX · CAD</option>
                <option value="US_EQUITIES">US · USD</option>
              </select>
            </label>
            <PanelMeta>{automation.watchlistDate ?? "DAILY"}</PanelMeta>
          </>
        }
      />
      <form
        className="watchlist-form tw:flex tw:items-end tw:gap-3 tw:px-6 tw:pt-[18px] tw:pb-3 tw:below-1100:flex-col tw:below-1100:items-stretch tw:below-1100:[&_button]:w-full"
        onSubmit={(event) => void add(event)}
      >
        <label className={FIELD_LABEL_CLASSES}>
          PASTE SYMBOLS
          <textarea
            className={classes(
              FIELD_CONTROL_CLASSES,
              "tw:uppercase tw:resize-y",
            )}
            aria-label="TradingView symbols"
            rows={3}
            value={symbolInput}
            onChange={(event) => setSymbolInput(event.target.value)}
            placeholder={"TSX:SHOP, TSX:RY\nBTO.TO"}
          />
        </label>
        <div className="watchlist-meta tw:grid tw:min-w-[260px] tw:gap-[9px] tw:below-md:w-full tw:below-md:min-w-0">
          <label className={FIELD_LABEL_CLASSES}>
            NOTE (OPTIONAL)
            <input
              className={FIELD_CONTROL_CLASSES}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Morning momentum scan"
            />
          </label>
          <label className={FIELD_LABEL_CLASSES}>
            TAGS (COMMA-SEPARATED)
            <input
              className={FIELD_CONTROL_CLASSES}
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="gap-up, materials"
            />
          </label>
        </div>
        <div className={WATCHLIST_ACTIONS_CLASSES}>
          <button
            className={WATCHLIST_ACTION_CLASSES}
            disabled={refreshing || !symbolInput.trim()}
          >
            {refreshing ? "UPDATING…" : "ADD CANDIDATES"}
          </button>
          <button
            type="button"
            className={WATCHLIST_ACTION_CLASSES}
            disabled={refreshing || !symbolInput.trim()}
            onClick={() => void replace()}
          >
            REPLACE DAILY LIST
          </button>
          <button
            type="button"
            className={WATCHLIST_ACTION_DANGER_CLASSES}
            disabled={refreshing || !configured.length}
            onClick={() => void clear()}
          >
            CLEAR TODAY
          </button>
        </div>
      </form>
      {report && (
        <section
          className="paste-report tw:mx-6 tw:mt-1 tw:mb-[18px] tw:rounded-[9px] tw:border tw:border-line-input tw:bg-bg tw:p-[15px]"
          aria-label="Candidate paste report"
        >
          <div className="tw:mb-[11px] tw:flex tw:items-center tw:justify-between tw:font-mono tw:text-[0.65rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-150">
            <strong>PASTE REPORT</strong>
            <button
              type="button"
              className="tw:cursor-pointer tw:border-0 tw:bg-transparent tw:font-mono tw:text-[0.58rem] tw:font-bold tw:text-ink-700"
              onClick={() => setReport(undefined)}
            >
              DISMISS
            </button>
          </div>
          {reportGroups.length ? (
            reportGroups.map((key) => (
              <article
                className="tw:grid tw:grid-cols-[120px_1fr] tw:gap-2 tw:border-t tw:border-line-subtle tw:py-2 tw:below-md:grid-cols-1"
                key={key}
              >
                <b
                  className={classes(
                    "tw:font-mono tw:text-[0.6rem] tw:font-bold",
                    PASTE_GROUP_TONE[key] ?? PASTE_GROUP_TONE.default,
                  )}
                >
                  {key.toUpperCase()} · {report[key].length}
                </b>
                {report[key].map((item, index) => (
                  <span
                    className="tw:flex tw:items-baseline tw:gap-2 tw:text-[0.72rem] tw:text-ink-150 tw:below-md:flex-col tw:below-md:items-start tw:below-md:gap-[3px]"
                    key={`${item.originalInput}:${index}`}
                  >
                    <strong>{item.originalInput || "(empty)"}</strong>
                    {item.normalizedSymbol &&
                      item.normalizedSymbol !== item.originalInput && (
                        <em className="tw:not-italic tw:text-accent">
                          → {item.normalizedSymbol}
                        </em>
                      )}
                    <small className="tw:text-ink-700">{item.reason}</small>
                  </span>
                ))}
              </article>
            ))
          ) : (
            <p>No symbols were submitted.</p>
          )}
        </section>
      )}
      {pipelineStatuses.length > 0 && (
        <div
          className="candidate-pipeline-summary tw:flex tw:flex-wrap tw:gap-[7px] tw:px-6 tw:pb-4"
          aria-label="Candidate lifecycle summary"
        >
          {pipelineSummary.map((status) => {
            const count = pipelineStatuses.filter(
              (value) => value.status === status,
            ).length;
            const tone = PIPELINE_TONE[status.toLowerCase()];
            return count > 0 ? (
              <span
                className={classes(
                  PIPELINE_BASE,
                  tone ?? PIPELINE_TONE.default,
                )}
                key={status}
              >
                {status} <b className="tw:text-ink-150">{count}</b>
              </span>
            ) : null;
          })}
        </div>
      )}
      <div className="watchlist-symbols tw:flex tw:flex-wrap tw:gap-2 tw:px-6 tw:pb-5">
        {configured.map((value) => {
          const entry = entries.get(value),
            item = coverage.get(value),
            pipeline = pipelineBySymbol.get(value),
            lifecycleStatus = pipeline?.status ?? item?.status ?? "WARMING",
            coverageText =
              item?.reasons[0] ??
              `${item?.setupCount ?? 0} setups · ${item?.contextCount ?? 0} context`;
          return (
            <Fragment key={value}>
              <span className="tw:flex tw:max-w-full tw:flex-wrap tw:items-center tw:gap-[9px] tw:rounded-input tw:border tw:border-line-input tw:bg-surface tw:py-2 tw:pr-[9px] tw:pl-[11px]">
                <b className="tw:font-mono tw:text-[0.72rem] tw:font-[750]">
                  {value}
                  <small className="tw:mt-[3px] tw:block tw:text-[0.55rem] tw:font-medium tw:text-ink-750">
                    {pipeline?.source ?? entry?.source ?? "MANUAL"} ·{" "}
                    {entry
                      ? new Date(entry.addedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : automation.watchlistDate}
                  </small>
                </b>
                <i
                  className={classes(
                    LIFECYCLE_CHIP_BASE,
                    LIFECYCLE_CHIP_TONE[lifecycleStatus.toLowerCase()] ??
                      LIFECYCLE_CHIP_TONE.default,
                  )}
                >
                  {lifecycleStatus}
                  {pipeline?.status === "FAILED"
                    ? ` · ${pipeline.attemptCount} ATTEMPTS`
                    : ""}
                </i>
                {pipeline?.reason && (
                  <small className="tw:text-[0.58rem] tw:text-ink-700">
                    {pipeline.reason}
                  </small>
                )}
                <em className="tw:max-w-[360px] tw:text-[0.62rem] tw:not-italic tw:text-ink-700">
                  {entry?.note
                    ? `${entry.note} · ${coverageText}`
                    : coverageText}
                </em>
                {entry?.tags.map((tag) => (
                  <small
                    className="candidate-tag tw:rounded-[4px] tw:bg-surface-raised tw:px-[5px] tw:py-[3px] tw:font-mono tw:text-[0.54rem] tw:font-semibold tw:text-ink-450"
                    key={tag}
                  >
                    {tag}
                  </small>
                ))}
                <button
                  type="button"
                  className="candidate-warmup-toggle tw:cursor-pointer tw:rounded-[4px] tw:border-0 tw:bg-surface-raised tw:px-[6px] tw:py-1 tw:font-mono tw:text-[0.55rem] tw:font-bold tw:text-ink-450"
                  aria-label={`Warm-up stages for ${value}`}
                  aria-expanded={expanded.has(value)}
                  onClick={() => toggleExpanded(value)}
                >
                  {expanded.has(value) ? "HIDE WARM-UP" : "WARM-UP"}
                </button>
                <button
                  type="button"
                  className="tw:cursor-pointer tw:rounded-[4px] tw:border-0 tw:bg-surface-danger tw:px-[6px] tw:py-1 tw:font-mono tw:text-[0.55rem] tw:font-bold tw:text-danger-soft tw:disabled:cursor-not-allowed tw:disabled:opacity-40"
                  aria-label={`Remove ${value}`}
                  disabled={refreshing}
                  onClick={() => void remove(value)}
                >
                  REMOVE
                </button>
              </span>
              {expanded.has(value) ? (
                <WarmupTimeline symbol={value} pipeline={pipeline} />
              ) : null}
            </Fragment>
          );
        })}
        {pipelineStatuses
          .filter((value) => value.status === "EXCLUDED")
          .filter((value) => !configured.includes(value.symbol))
          .map((value) => (
            <Fragment key={value.symbol}>
              <span className="tw:flex tw:max-w-full tw:flex-wrap tw:items-center tw:gap-[9px] tw:rounded-input tw:border tw:border-line-input tw:bg-surface tw:py-2 tw:pr-[9px] tw:pl-[11px]">
                <b className="tw:font-mono tw:text-[0.72rem] tw:font-[750]">
                  {value.symbol}
                  <small className="tw:mt-[3px] tw:block tw:text-[0.55rem] tw:font-medium tw:text-ink-750">
                    {value.source} · EXCLUDED
                  </small>
                </b>
                <i className="tw:rounded-[4px] tw:bg-surface-danger tw:px-[6px] tw:py-1 tw:font-mono tw:text-[0.54rem] tw:font-bold tw:not-italic tw:text-danger-soft">
                  EXCLUDED
                </i>
                <em className="tw:max-w-[360px] tw:text-[0.62rem] tw:not-italic tw:text-ink-700">
                  {value.reason ?? "Manual exclusion"}
                </em>
                <button
                  type="button"
                  className="candidate-warmup-toggle tw:cursor-pointer tw:rounded-[4px] tw:border-0 tw:bg-surface-raised tw:px-[6px] tw:py-1 tw:font-mono tw:text-[0.55rem] tw:font-bold tw:text-ink-450"
                  aria-label={`Warm-up stages for ${value.symbol}`}
                  aria-expanded={expanded.has(value.symbol)}
                  onClick={() => toggleExpanded(value.symbol)}
                >
                  {expanded.has(value.symbol) ? "HIDE WARM-UP" : "WARM-UP"}
                </button>
              </span>
              {expanded.has(value.symbol) ? (
                <WarmupTimeline symbol={value.symbol} pipeline={value} />
              ) : null}
            </Fragment>
          ))}
        {!configured.length && (
          <p className="tw:my-1 tw:text-[0.78rem] tw:text-ink-700">
            No candidates yet. Paste today’s TradingView results above to begin
            analysis.
          </p>
        )}
      </div>
    </Panel>
  );
  return (
    <>
      <section className="tw:mb-4 tw:grid tw:grid-cols-[minmax(0,1fr)_300px] tw:gap-4 tw:below-900:grid-cols-1">
        {automation.editable ? watchlistPanel : policyPanel}
        <div className="tw:flex tw:flex-col tw:gap-4">
          {healthCard}
          {activityPanel}
        </div>
      </section>
      {automation.editable ? policyPanel : null}
      {error && <p className="error-banner">{error}</p>}
      <section className="universe-table tw:mb-4 tw:overflow-x-auto tw:overflow-y-hidden tw:rounded-panel tw:border tw:border-line tw:bg-surface">
        <PanelHeader
          title="Analysis inputs"
          description="Resolved market data and live coverage for every symbol sent to the strategy engine."
          descriptionClassName="tw:mt-[5px] tw:mb-0 tw:text-[0.75rem] tw:text-ink-700"
          className="tw:min-w-[1120px]"
          actions={<PanelMeta>{automation.members.length} EVALUATED</PanelMeta>}
        />
        <div className={UNIVERSE_HEADER_CLASSES}>
          <span>SYMBOL</span>
          <span>COVERAGE</span>
          <span>PRICE</span>
          <span>MARKET CAP</span>
          <span>AVG VOL 90D</span>
          <span>DOLLAR VOL</span>
          <span>ATR</span>
          <span>SECTOR / REASON</span>
        </div>
        {automation.members.map((member) => {
          const item = coverage.get(member.symbol);
          const status =
            item?.status.toLowerCase() ??
            (member.eligible ? "included" : "excluded");
          return (
            <div className={UNIVERSE_BODY_CLASSES} key={member.symbol}>
              <strong>
                {member.symbol}
                <small className="tw:mt-1 tw:block tw:text-[0.64rem] tw:font-medium tw:text-ink-750">
                  {member.description}
                </small>
              </strong>
              <i
                className={classes(
                  ROW_STATUS_BASE,
                  ROW_STATUS_TONE[status] ?? ROW_STATUS_TONE.default,
                )}
              >
                {item?.status ??
                  (member.eligible ? "ANALYZABLE" : "UNAVAILABLE")}
              </i>
              <b>
                {member.price === null ? "—" : `$${member.price.toFixed(2)}`}
              </b>
              <span>{money(member.marketCap)}</span>
              <span>
                {member.averageVolume90d === null
                  ? "—"
                  : Math.round(member.averageVolume90d).toLocaleString()}
              </span>
              <span>{money(member.dollarVolume)}</span>
              <span>
                {member.atrPct === null ? "—" : `${member.atrPct.toFixed(2)}%`}
              </span>
              <span>
                {item?.reasons.length
                  ? item.reasons.join(" · ")
                  : member.eligible
                    ? (member.sector ?? "—")
                    : member.reasons
                        .map((value) => value.replaceAll("_", " "))
                        .join(" · ")}
              </span>
            </div>
          );
        })}
        {!automation.members.length && (
          <div className="empty compact tw:p-[25px] tw:text-center tw:text-ink-700">
            The daily analysis list is empty.
          </div>
        )}
      </section>
      <Panel as="section" className="universe-history tw:mb-[18px]">
        <PanelHeader
          title="Refresh history"
          description="Newest first; an active run updates automatically."
          descriptionClassName="tw:mt-[5px] tw:mb-0 tw:text-[0.75rem] tw:text-ink-700"
          actions={<PanelMeta>{runs.length} RUNS</PanelMeta>}
        />
        <div
          aria-label="Refresh history runs"
          className="universe-history-list tw:max-h-[min(520px,65vh)] tw:overflow-y-auto tw:overscroll-contain tw:[scrollbar-gutter:stable] tw:focus-visible:outline-1 tw:focus-visible:-outline-offset-1 tw:focus-visible:outline-line-accent"
          tabIndex={0}
        >
          {runs.map((run) => (
            <div className={classes(HISTORY_RUN_BASE)} key={run.id}>
              <i
                className={classes(
                  "tw:font-mono tw:text-[0.62rem] tw:font-bold tw:not-italic",
                  run.status === "FAILED" ? "tw:text-danger" : "tw:text-accent",
                )}
              >
                {run.status}
              </i>
              <strong className="tw:text-ink-150">
                {new Date(run.startedAt).toLocaleString()}
                <small className="tw:mt-1 tw:block tw:font-medium tw:text-ink-750">
                  {run.provider} · {run.policyVersion}
                </small>
              </strong>
              <span className="universe-run-funnel tw:font-mono tw:text-[0.68rem] tw:font-semibold tw:text-ink-450 tw:below-900:hidden">
                {run.status === "RUNNING"
                  ? `${run.discoveredCount} submitted so far`
                  : `${run.discoveredCount} submitted · ${run.eligibleCount} analyzable · ${run.activatedCount} activated`}
              </span>
              <span className="universe-run-timing tw:text-ink-450">
                {run.completedAt
                  ? `completed ${new Date(run.completedAt).toLocaleTimeString()} · ${
                      elapsedText(run.startedAt, run.completedAt) ?? "—"
                    }`
                  : run.status === "RUNNING"
                    ? `running · started ${ago(now, run.startedAt)}`
                    : "not completed"}
              </span>
              <b className="tw:text-[0.68rem] tw:font-medium tw:text-warn tw:below-900:hidden">
                {run.error ?? run.warnings.join(" · ")}
              </b>
            </div>
          ))}
          {!runs.length && (
            <div className="empty compact tw:p-[25px] tw:text-center tw:text-ink-700">
              No refreshes recorded.
            </div>
          )}
        </div>
      </Panel>
    </>
  );
}
