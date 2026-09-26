import {
  type CandidateCoverage,
  type CandidateIntakeStatus,
  type CandidatePasteReport,
  type UniverseAutomation,
  type UniverseMember,
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
import {
  CARD,
  DOT_TONES,
  LABEL,
  LINK_BUTTON,
  MoreMenu,
  SECONDARY_BUTTON,
  SectionHead,
  Stat,
  badge,
} from "../components/PageSections.js";
import { getJson, sendJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { ago, countdown } from "../lib/format.js";
import { useNow } from "../lib/use-now.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";
import { Drawer } from "../ui.js";

const RUN_POLL_MS = 5_000;

const PRIMARY_BUTTON =
  "tw:cursor-pointer tw:rounded-[9px] tw:border tw:border-accent tw:bg-accent tw:px-[14px] tw:py-[9px] tw:font-sans tw:text-[0.8rem] tw:font-semibold tw:text-on-accent tw:disabled:cursor-not-allowed tw:disabled:opacity-45";
const FIELD_LABEL =
  "tw:flex tw:flex-1 tw:flex-col tw:gap-[7px] tw:font-sans tw:text-[0.72rem] tw:font-medium tw:text-ink-400";
const FIELD_CONTROL =
  "tw:w-full tw:rounded-[9px] tw:border tw:border-line-input tw:bg-bg tw:px-3 tw:py-[10px] tw:font-sans tw:text-[0.84rem] tw:text-ink-100 tw:outline-none tw:focus:border-accent";

const TH =
  "tw:whitespace-nowrap tw:border-b tw:border-line tw:px-4 tw:py-[13px] tw:first:pl-[22px] tw:last:pr-[22px] tw:font-sans tw:text-[0.68rem] tw:font-semibold tw:tracking-[0.08em] tw:uppercase tw:text-ink-500";
const TD =
  "tw:border-b tw:border-line-subtle tw:px-4 tw:py-[13px] tw:first:pl-[22px] tw:last:pr-[22px] tw:align-middle tw:text-[0.84rem] tw:text-ink-200";
const NUM =
  "tw:whitespace-nowrap tw:font-mono tw:text-[0.8rem] tw:tabular-nums";
/* Secondary columns hidden on phones; the expanded row carries them. */
const NARROW_HIDDEN = "tw:below-md:hidden";

const PASTE_GROUP_TONE: Record<string, string> = {
  accepted: "ok",
  normalized: "ok",
  duplicate: "warn",
  unsupported: "bad",
  failed: "bad",
};

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

function lifecycleLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

function money(value: number | null): string {
  return value === null
    ? "—"
    : value >= 1_000_000_000
      ? `$${(value / 1_000_000_000).toFixed(1)}B`
      : `$${(value / 1_000_000).toFixed(1)}M`;
}

type RowGroup = "analyzing" | "warming" | "blocked";

/** One status per symbol: the lifecycle decides failures and exclusions, and
 * live coverage decides how far analysis has got. */
export function symbolState(
  pipeline: CandidateIntakeStatus | undefined,
  coverage: CandidateCoverage | undefined,
  member: UniverseMember | undefined,
): { label: string; tone: string; group: RowGroup } {
  if (pipeline?.status === "FAILED")
    return {
      label: `Failed · ${pipeline.attemptCount} attempts`,
      tone: "bad",
      group: "blocked",
    };
  if (pipeline?.status === "EXCLUDED")
    return { label: "Excluded", tone: "warn", group: "blocked" };
  switch (coverage?.status) {
    case "READY":
      return { label: "Setup ready", tone: "ok", group: "analyzing" };
    case "FORMING":
      return { label: "Setup forming", tone: "pending", group: "analyzing" };
    case "ANALYZABLE":
      return { label: "Analyzable", tone: "ok", group: "analyzing" };
    case "WARMING":
      return { label: "Warming up", tone: "pending", group: "warming" };
    case "INVALIDATED":
      return { label: "Invalidated", tone: "warn", group: "blocked" };
    case "UNAVAILABLE":
      return { label: "Unavailable", tone: "bad", group: "blocked" };
  }
  if (member && !member.eligible)
    return { label: "Unavailable", tone: "bad", group: "blocked" };
  if (pipeline?.status === "READY")
    return { label: "Analyzable", tone: "ok", group: "analyzing" };
  return { label: "Warming up", tone: "pending", group: "warming" };
}

function WarmupTimeline({ pipeline }: { pipeline?: CandidateIntakeStatus }) {
  const stages = [
    { label: "Discovered", at: pipeline?.discoveredAt ?? null },
    { label: "Intake", at: pipeline?.intakeAt ?? null },
    { label: "Strategy ready", at: pipeline?.strategyReadyAt ?? null },
  ];
  return (
    <div className="candidate-warmup">
      <div className={LABEL}>
        Warm-up
        {pipeline ? ` · ${pipeline.source.toLowerCase()}` : ""}
        {pipeline?.status === "FAILED" ? (
          <b className="tw:ml-2 tw:font-semibold tw:text-danger-soft tw:normal-case tw:tracking-normal">
            {pipeline.attemptCount} attempts
          </b>
        ) : null}
      </div>
      <ol className="tw:m-0 tw:mt-2 tw:grid tw:list-none tw:gap-[5px] tw:p-0">
        {stages.map((stage) => (
          <li
            className="tw:grid tw:grid-cols-[120px_1fr] tw:gap-3 tw:text-[0.78rem]"
            key={stage.label}
          >
            <span className="tw:text-ink-400">{stage.label}</span>
            <b className="tw:font-mono tw:font-medium tw:text-ink-200">
              {stageLabel(stage.at)}
            </b>
          </li>
        ))}
      </ol>
      {pipeline ? null : (
        <p className="tw:m-0 tw:mt-2 tw:text-[0.76rem] tw:text-ink-400">
          No lifecycle record.
        </p>
      )}
    </div>
  );
}

export function UniverseView({
  automation,
  updated,
  marketId = "CA_TSX",
}: {
  automation: UniverseAutomation;
  updated: (value: UniverseAutomation) => void;
  marketId?: "CA_TSX" | "US_EQUITIES";
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
    [lastHistoryLoadAt, setLastHistoryLoadAt] = useState<number | null>(null),
    [drawer, setDrawer] = useState<"history" | "policy" | null>(null);
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

  const p = automation.policy;
  const entries = new Map(
      automation.candidates?.map((value) => [value.normalizedSymbol, value]) ??
        [],
    ),
    coverage = new Map(
      automation.coverage?.map((value) => [value.symbol, value]) ?? [],
    ),
    members = new Map(automation.members.map((value) => [value.symbol, value]));
  const pipelineStatuses = automation.candidateStatuses ?? [];
  const pipelineBySymbol = new Map(
    pipelineStatuses.map((value) => [value.symbol, value]),
  );
  // Configured symbols first, then policy members and excluded candidates
  // that are no longer on the list, so nothing the engine saw is hidden.
  const symbols = [
    ...new Set([
      ...configured,
      ...automation.members.map((value) => value.symbol),
      ...pipelineStatuses
        .filter((value) => value.status === "EXCLUDED")
        .map((value) => value.symbol),
    ]),
  ];
  const rows = symbols.map((symbol) => {
    const pipeline = pipelineBySymbol.get(symbol);
    const item = coverage.get(symbol);
    const member = members.get(symbol);
    return {
      symbol,
      pipeline,
      item,
      member,
      entry: entries.get(symbol),
      onList: configured.includes(symbol),
      state: symbolState(pipeline, item, member),
    };
  });
  const counts = {
    analyzing: rows.filter((row) => row.state.group === "analyzing").length,
    warming: rows.filter((row) => row.state.group === "warming").length,
    blocked: rows.filter((row) => row.state.group === "blocked").length,
  };
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
  const marketLabel = p.marketId === "US_EQUITIES" ? "US · USD" : "TSX · CAD";
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
        tone: "pending",
        headline: "Refreshing now",
        detail: `started ${ago(now, latestRun?.startedAt)}`,
      }
    : latestRun?.status === "FAILED"
      ? {
          tone: "bad",
          headline: "Refresh failed",
          detail: `failed ${ago(now, latestRun?.startedAt)}`,
        }
      : latestRun?.status === "COMPLETED"
        ? {
            tone: "ok",
            headline: "Refresh completed",
            detail: ago(now, latestRun?.completedAt),
          }
        : {
            tone: "waiting",
            headline: "No refresh recorded yet",
            detail: "",
          };

  const policyFacts: [string, string][] = [
    ["Reference price", `${currency} ${p.minimumPrice}–${p.maximumPrice}`],
    ["Market cap", `≥ ${money(p.minimumMarketCap)}`],
    ["Average volume", `≥ ${(p.minimumAverageVolume90d / 1_000).toFixed(0)}K`],
    ["Dollar volume", `≥ ${money(p.minimumDollarVolume)}`],
    ["ATR(14)", `≥ ${p.minimumAtrPct}%`],
    ["History", `≥ ${p.minimumHistoryDays} days`],
  ];

  return (
    <>
      <div className="tw:-mt-3 tw:mb-7 tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
        <section
          className="universe-activity tw:grid tw:gap-1"
          aria-label="Refresh activity"
        >
          <p className="tw:m-0 tw:flex tw:items-center tw:gap-[10px] tw:text-[0.86rem] tw:text-ink-300">
            <span
              className={classes(
                "tw:h-2 tw:w-2 tw:shrink-0 tw:rounded-full",
                DOT_TONES[activity.tone],
              )}
              aria-hidden="true"
            />
            <span role="status">
              <strong className="tw:font-semibold tw:text-ink-100">
                {activity.headline}
              </strong>
              {activity.detail ? ` · ${activity.detail}` : ""}
            </span>
            <span>
              · {configured.length}{" "}
              {configured.length === 1 ? "symbol" : "symbols"} on the{" "}
              {automation.watchlistDate ?? "daily"} list
            </span>
          </p>
          <p className="universe-activity-meta tw:m-0 tw:pl-[18px] tw:text-[0.76rem] tw:text-ink-500">
            {lastSuccess ? (
              <>
                Last successful refresh {ago(now, lastSuccess.completedAt)} ·
                took{" "}
                {elapsedText(lastSuccess.startedAt, lastSuccess.completedAt)}
              </>
            ) : (
              "No successful refresh recorded yet."
            )}
            {nextCheckAt ? (
              <> · next check {countdown(now, nextCheckAt)}</>
            ) : null}
          </p>
        </section>
        <div className="tw:flex tw:items-center tw:gap-[10px]">
          <button
            type="button"
            className={classes(SECONDARY_BUTTON, "universe-refresh")}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
          <MoreMenu
            label="More daily list tools"
            items={[
              {
                label: "Refresh history",
                onSelect: () => setDrawer("history"),
              },
              {
                label: "Eligibility policy",
                onSelect: () => setDrawer("policy"),
              },
              ...(automation.editable && configured.length
                ? [
                    {
                      label: "Clear today's list",
                      onSelect: () => void clear(),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>

      {latestRun?.status === "FAILED" ? (
        <p className="universe-activity-failure tw:mt-0 tw:mb-4 tw:rounded-[10px] tw:border tw:border-line-danger tw:bg-surface-danger tw:px-[14px] tw:py-[10px] tw:text-[0.8rem] tw:text-danger-soft">
          <b className="tw:text-danger">{failureReason}</b> — previous analysis
          set remains active.
        </p>
      ) : null}
      {refreshNote ? (
        <p className="universe-activity-stale tw:mt-0 tw:mb-4 tw:text-[0.78rem] tw:text-warn">
          {refreshNote}
        </p>
      ) : null}
      {error && <p className="error-banner">{error}</p>}

      {automation.editable && (
        <section className="tw:mb-6" aria-label="Add candidates">
          <SectionHead title="Add candidates">
            Paste from TradingView · bare symbols use {marketLabel}
          </SectionHead>
          <div
            className={classes(CARD, "watchlist-panel tw:px-[22px] tw:py-5")}
          >
            <form
              className="watchlist-form tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-4 tw:below-md:grid-cols-[minmax(0,1fr)]"
              onSubmit={(event) => void add(event)}
            >
              <label className={FIELD_LABEL}>
                Symbols
                <textarea
                  className={classes(FIELD_CONTROL, "tw:uppercase tw:resize-y")}
                  aria-label="TradingView symbols"
                  rows={2}
                  value={symbolInput}
                  onChange={(event) => setSymbolInput(event.target.value)}
                  placeholder="TSX:SHOP, TSX:RY, BTO.TO"
                />
              </label>
              <div className="tw:flex tw:gap-[10px] tw:below-md:[&_button]:flex-1">
                <button
                  className={PRIMARY_BUTTON}
                  disabled={refreshing || !symbolInput.trim()}
                >
                  {refreshing ? "Updating…" : "Add candidates"}
                </button>
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  disabled={refreshing || !symbolInput.trim()}
                  onClick={() => void replace()}
                >
                  Replace list
                </button>
              </div>
              <details className="tw:col-span-full tw:text-[0.78rem] tw:text-ink-400">
                <summary className="tw:w-max tw:cursor-pointer">
                  Note and tags (optional)
                </summary>
                <div className="tw:mt-3 tw:flex tw:gap-3 tw:below-md:flex-col">
                  <label className={FIELD_LABEL}>
                    Note
                    <input
                      className={FIELD_CONTROL}
                      maxLength={500}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Morning momentum scan"
                    />
                  </label>
                  <label className={FIELD_LABEL}>
                    Tags, comma-separated
                    <input
                      className={FIELD_CONTROL}
                      value={tags}
                      onChange={(event) => setTags(event.target.value)}
                      placeholder="gap-up, materials"
                    />
                  </label>
                </div>
              </details>
            </form>
            {report && (
              <section
                className="paste-report tw:mt-4 tw:rounded-[10px] tw:border tw:border-line-subtle tw:bg-surface-sunken tw:px-4 tw:py-3"
                aria-label="Candidate paste report"
              >
                <div className="tw:mb-2 tw:flex tw:items-center tw:justify-between">
                  <span className={LABEL}>Paste report</span>
                  <button
                    type="button"
                    className={LINK_BUTTON}
                    onClick={() => setReport(undefined)}
                  >
                    Dismiss
                  </button>
                </div>
                {reportGroups.length ? (
                  reportGroups.map((key) => (
                    <article
                      className="tw:grid tw:grid-cols-[130px_1fr] tw:items-start tw:gap-3 tw:border-t tw:border-line-subtle tw:py-2 tw:below-md:grid-cols-1"
                      key={key}
                    >
                      <span
                        className={badge(PASTE_GROUP_TONE[key] ?? "waiting")}
                      >
                        {lifecycleLabel(key)} · {report[key].length}
                      </span>
                      <span className="tw:grid tw:gap-1">
                        {report[key].map((item, index) => (
                          <span
                            className="tw:flex tw:flex-wrap tw:items-baseline tw:gap-2 tw:text-[0.8rem] tw:text-ink-150"
                            key={`${item.originalInput}:${index}`}
                          >
                            <strong>{item.originalInput || "(empty)"}</strong>
                            {item.normalizedSymbol &&
                              item.normalizedSymbol !== item.originalInput && (
                                <em className="tw:not-italic tw:text-accent">
                                  → {item.normalizedSymbol}
                                </em>
                              )}
                            <small className="tw:text-ink-400">
                              {item.reason}
                            </small>
                          </span>
                        ))}
                      </span>
                    </article>
                  ))
                ) : (
                  <p className="tw:m-0">No symbols were submitted.</p>
                )}
              </section>
            )}
          </div>
        </section>
      )}

      <section className="tw:mb-4" aria-label="Today's list">
        <SectionHead title="Today's list">
          {automation.editable
            ? "Every valid symbol is passed to all enabled strategies"
            : `Automated Level-1 eligibility · ${p.version}`}
        </SectionHead>
        <div className={classes(CARD, "universe-health")}>
          <dl
            className="tw:m-0 tw:grid tw:grid-cols-[repeat(4,minmax(0,1fr))] tw:border-b tw:border-line tw:below-900:grid-cols-[repeat(2,minmax(0,1fr))]"
            aria-label="Candidate lifecycle summary"
          >
            <Stat
              label="Symbols"
              value={String(rows.length)}
              hint={`${latestRun?.status.toLowerCase() ?? "not run"} · ${
                automation.watchlistDate ?? automation.provider
              }`}
            />
            <Stat
              label="Being analyzed"
              value={String(counts.analyzing)}
              hint="analyzable, forming or ready"
            />
            <Stat
              label="Warming up"
              value={String(counts.warming)}
              hint="collecting data before analysis"
            />
            <Stat
              label="Unavailable"
              value={String(counts.blocked)}
              hint="excluded, failed or unavailable"
            />
          </dl>
          {rows.length ? (
            <div className="universe-table tw:overflow-x-auto">
              <table className="tw:w-full tw:border-collapse">
                <thead>
                  <tr>
                    <th className={classes(TH, "tw:text-left")}>Symbol</th>
                    <th className={classes(TH, "tw:text-left")}>Status</th>
                    <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                      Price
                    </th>
                    <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                      Dollar vol
                    </th>
                    <th className={classes(TH, "tw:text-right", NARROW_HIDDEN)}>
                      ATR
                    </th>
                    <th className={classes(TH, "tw:text-left", NARROW_HIDDEN)}>
                      Setups / notes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const open = expanded.has(row.symbol);
                    const { member, item, entry, pipeline } = row;
                    const reason =
                      pipeline?.reason ??
                      item?.reasons[0] ??
                      (member && !member.eligible
                        ? member.reasons
                            .map((value) => value.replaceAll("_", " "))
                            .join(" · ")
                        : null);
                    const addedAt = entry
                      ? new Date(entry.addedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : null;
                    return (
                      <Fragment key={row.symbol}>
                        <tr
                          className={classes(
                            "candidate-row",
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
                              aria-label={`Warm-up stages for ${row.symbol}`}
                              aria-expanded={open}
                              onClick={() => toggleExpanded(row.symbol)}
                            >
                              <strong className="tw:font-mono tw:text-[0.86rem] tw:font-semibold tw:text-ink-50">
                                {row.symbol}
                              </strong>
                              <small className="tw:text-[0.74rem] tw:text-ink-500">
                                {member?.description ??
                                  lifecycleLabel(
                                    pipeline?.source ??
                                      entry?.source ??
                                      "MANUAL",
                                  )}
                                {addedAt ? ` · added ${addedAt}` : ""}
                              </small>
                            </button>
                          </td>
                          <td className={TD}>
                            <span className="tw:grid tw:justify-items-start tw:gap-1">
                              <span className={badge(row.state.tone)}>
                                {row.state.label}
                              </span>
                              {pipeline && (
                                <small className="tw:text-[0.72rem] tw:text-ink-500">
                                  {lifecycleLabel(pipeline.status)} ·{" "}
                                  {lifecycleLabel(pipeline.source)}
                                </small>
                              )}
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
                            {member?.price == null
                              ? "—"
                              : `$${member.price.toFixed(2)}`}
                          </td>
                          <td
                            className={classes(
                              TD,
                              NUM,
                              "tw:text-right",
                              NARROW_HIDDEN,
                            )}
                          >
                            {money(member?.dollarVolume ?? null)}
                          </td>
                          <td
                            className={classes(
                              TD,
                              NUM,
                              "tw:text-right",
                              NARROW_HIDDEN,
                            )}
                          >
                            {member?.atrPct == null
                              ? "—"
                              : `${member.atrPct.toFixed(2)}%`}
                          </td>
                          <td
                            className={classes(
                              TD,
                              "tw:max-w-[340px] tw:text-[0.8rem]",
                              NARROW_HIDDEN,
                            )}
                          >
                            <span className="tw:grid tw:gap-1">
                              {reason ? (
                                <span className="tw:text-warn-soft">
                                  {reason}
                                </span>
                              ) : item ? (
                                <span>
                                  {item.setupCount}{" "}
                                  {item.setupCount === 1 ? "setup" : "setups"} ·{" "}
                                  {item.contextCount} context
                                </span>
                              ) : (
                                <span className="tw:text-ink-500">
                                  {member?.sector ?? "—"}
                                </span>
                              )}
                              {Boolean(entry?.note || entry?.tags.length) && (
                                <span className="tw:flex tw:flex-wrap tw:items-center tw:gap-[6px] tw:text-[0.74rem] tw:text-ink-400">
                                  {entry?.note}
                                  {entry?.tags.map((tag) => (
                                    <small
                                      className="candidate-tag tw:rounded-full tw:border tw:border-line tw:px-[7px] tw:py-[1px] tw:text-[0.68rem] tw:text-ink-300"
                                      key={tag}
                                    >
                                      {tag}
                                    </small>
                                  ))}
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                        {open && (
                          <tr className="tw:bg-surface-raised">
                            <td
                              colSpan={6}
                              className="tw:border-b tw:border-line tw:px-[22px] tw:pt-1 tw:pb-5 tw:shadow-[inset_3px_0_0_var(--accent)]"
                            >
                              <div className="tw:grid tw:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] tw:gap-6 tw:below-md:grid-cols-[minmax(0,1fr)]">
                                <WarmupTimeline pipeline={pipeline} />
                                <div>
                                  <div className={LABEL}>Market data</div>
                                  <dl className="tw:m-0 tw:mt-2 tw:grid tw:grid-cols-[120px_1fr] tw:gap-x-3 tw:gap-y-[5px] tw:text-[0.78rem]">
                                    <dt className="tw:text-ink-400">Price</dt>
                                    <dd className="tw:m-0 tw:font-mono tw:text-ink-200">
                                      {member?.price == null
                                        ? "—"
                                        : `$${member.price.toFixed(2)}`}
                                    </dd>
                                    <dt className="tw:text-ink-400">
                                      Market cap
                                    </dt>
                                    <dd className="tw:m-0 tw:font-mono tw:text-ink-200">
                                      {money(member?.marketCap ?? null)}
                                    </dd>
                                    <dt className="tw:text-ink-400">
                                      Avg volume 90d
                                    </dt>
                                    <dd className="tw:m-0 tw:font-mono tw:text-ink-200">
                                      {member?.averageVolume90d == null
                                        ? "—"
                                        : Math.round(
                                            member.averageVolume90d,
                                          ).toLocaleString()}
                                    </dd>
                                    <dt className="tw:text-ink-400">Sector</dt>
                                    <dd className="tw:m-0 tw:text-ink-200">
                                      {member?.sector ?? "—"}
                                    </dd>
                                    {item && (
                                      <>
                                        <dt className="tw:text-ink-400">
                                          Coverage
                                        </dt>
                                        <dd className="tw:m-0 tw:text-ink-200">
                                          {item.setupCount} setups ·{" "}
                                          {item.contextCount} context
                                          {item.warmupPending.length
                                            ? ` · waiting on ${item.warmupPending.join(", ")}`
                                            : ""}
                                        </dd>
                                      </>
                                    )}
                                  </dl>
                                </div>
                              </div>
                              {reason && (
                                <p className="tw:m-0 tw:mt-3 tw:text-[0.8rem] tw:text-warn-soft">
                                  {reason}
                                </p>
                              )}
                              {automation.editable && row.onList && (
                                <button
                                  type="button"
                                  className={classes(
                                    LINK_BUTTON,
                                    "tw:mt-3 tw:text-danger-soft tw:hover:text-danger tw:disabled:cursor-not-allowed tw:disabled:opacity-40",
                                  )}
                                  aria-label={`Remove ${row.symbol}`}
                                  disabled={refreshing}
                                  onClick={() => void remove(row.symbol)}
                                >
                                  Remove from today's list
                                </button>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="tw:m-0 tw:px-[22px] tw:py-6 tw:text-center tw:text-[0.84rem] tw:text-ink-400">
              {automation.editable
                ? "No candidates yet. Paste today's TradingView results above to begin analysis."
                : "The daily analysis list is empty."}
            </p>
          )}
        </div>
      </section>

      <Drawer
        open={drawer === "history"}
        onClose={() => setDrawer(null)}
        title="Refresh history"
        size="wide"
      >
        <p className="tw:mx-0 tw:mt-0 tw:mb-3 tw:text-[0.78rem] tw:text-ink-400">
          Newest first; an active run updates automatically.
        </p>
        <div
          aria-label="Refresh history runs"
          className="universe-history tw:grid"
        >
          {runs.map((run) => (
            <div
              className="universe-run tw:grid tw:grid-cols-[110px_1.4fr_1.4fr_1.2fr] tw:items-start tw:gap-4 tw:border-b tw:border-line-subtle tw:py-3 tw:text-[0.78rem] tw:text-ink-300 tw:below-md:grid-cols-[1fr]"
              key={run.id}
            >
              <span
                className={badge(
                  run.status === "FAILED"
                    ? "bad"
                    : run.status === "RUNNING"
                      ? "pending"
                      : "ok",
                )}
              >
                {run.status}
              </span>
              <strong className="tw:font-medium tw:text-ink-150">
                {new Date(run.startedAt).toLocaleString()}
                <small className="tw:mt-1 tw:block tw:text-[0.72rem] tw:text-ink-500">
                  {run.refreshKind === "LIST_EDIT"
                    ? "List edit"
                    : "Full refresh"}{" "}
                  · {run.provider} · {run.policyVersion}
                </small>
              </strong>
              <span className="universe-run-funnel tw:font-mono tw:text-[0.74rem]">
                {run.status === "RUNNING"
                  ? `${run.discoveredCount} submitted so far`
                  : run.refreshKind === "LIST_EDIT"
                    ? `${run.discoveredCount} listed · ${run.evaluatedCount} newly evaluated · ${run.activatedCount} activated`
                    : `${run.discoveredCount} submitted · ${run.eligibleCount} analyzable · ${run.activatedCount} activated`}
              </span>
              <span className="universe-run-timing">
                {run.completedAt
                  ? `completed ${new Date(run.completedAt).toLocaleTimeString()} · ${
                      elapsedText(run.startedAt, run.completedAt) ?? "—"
                    }`
                  : run.status === "RUNNING"
                    ? `running · started ${ago(now, run.startedAt)}`
                    : "not completed"}
                {run.error || run.warnings.length ? (
                  <b className="tw:mt-1 tw:block tw:font-medium tw:text-warn">
                    {run.error ?? run.warnings.join(" · ")}
                  </b>
                ) : null}
              </span>
            </div>
          ))}
          {!runs.length && (
            <p className="tw:m-0 tw:py-6 tw:text-center tw:text-ink-400">
              No refreshes recorded.
            </p>
          )}
        </div>
      </Drawer>
      <Drawer
        open={drawer === "policy"}
        onClose={() => setDrawer(null)}
        title="Eligibility policy"
      >
        <p className="tw:mx-0 tw:mt-0 tw:mb-4 tw:text-[0.78rem] tw:leading-[1.5] tw:text-ink-400">
          {automation.editable
            ? "TradingView supplies the daily candidates; these Level-1 thresholds decide which ones are analyzable."
            : `Automated Level-1 eligibility policy · ${p.version}`}
        </p>
        <dl className="universe-policy tw:m-0 tw:grid tw:grid-cols-[repeat(2,minmax(0,1fr))] tw:gap-x-4 tw:gap-y-4">
          {policyFacts.map(([label, value]) => (
            <div key={label}>
              <dt className={LABEL}>{label}</dt>
              <dd className="tw:m-0 tw:mt-1 tw:font-mono tw:text-[0.9rem] tw:text-ink-100">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="tw:mx-0 tw:mt-4 tw:mb-0 tw:font-mono tw:text-[0.72rem] tw:text-ink-500">
          {p.version}
        </p>
      </Drawer>
    </>
  );
}
