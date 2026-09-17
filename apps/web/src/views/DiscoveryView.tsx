import {
  discoveryModeStateSchema,
  discoveryPolicyForMarket,
  discoveryEvidenceListSchema,
  discoveryRunListSchema,
  discoveryRunSchema,
  discoveryStatusSchema,
  type DiscoveryEvidence,
  type DiscoveryMode,
  type DiscoveryRun,
  type DiscoveryStatus,
} from "@tsx-scanner/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/Button.js";
import { Fact, FactList } from "../components/ui/FactList.js";
import {
  Panel,
  PanelHeader,
  PanelMeta,
  type PanelHeaderDivider,
  type PanelHeaderEmphasis,
  type PanelTone,
} from "../components/ui/Panel.js";
import { StatusBadge, type StatusTone } from "../components/ui/StatusBadge.js";
import { Text } from "../components/ui/Text.js";
import { getJson, sendJson } from "../lib/api.js";
import { agoFromMs, countdown } from "../lib/format.js";
import { isAbortError } from "../lib/research-job.js";
import { useNow } from "../lib/use-now.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";

const MODES: DiscoveryMode[] = ["OFF", "SHADOW", "AUTO_ADD"];
const POLL_INTERVAL_MS = 15_000;

type DiscoverySection = "overview" | "results" | "diagnostics";

const SECTIONS: { key: DiscoverySection; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "results", label: "Results" },
  { key: "diagnostics", label: "Diagnostics" },
];

/* The legacy layout stacked the two-column card grids below 900px inclusive. */
const STACK_GRID_CLASSES = "tw:below-900:grid-cols-1";
const ROW_MEDIA_CLASSES = "tw:below-900:grid-cols-1 tw:below-900:gap-1";

function badgeTone(state: string | null | undefined): StatusTone {
  if (!state) return "muted";
  switch (state.toLowerCase()) {
    case "fresh":
    case "enabled":
    case "completed":
      return "ok";
    case "last_good":
    case "partial":
    case "running":
    case "degraded":
      return "warn";
    case "failed":
    case "unavailable":
      return "danger";
    case "cancelled":
    case "disabled":
    case "unknown":
      return "muted";
    default:
      return "neutral";
  }
}

function schedulerStateClasses(state: string | null | undefined): string {
  const tone = ["degraded", "missing_provider", "off", "unknown"].includes(
    (state ?? "unknown").toLowerCase(),
  )
    ? "tw:text-warn"
    : "tw:text-accent";
  return `tw:shrink-0 tw:font-mono tw:text-[0.63rem] tw:font-bold tw:tracking-[0.1em] ${tone}`;
}

function Card({
  title,
  description,
  action,
  tone = "plain",
  emphasis = "default",
  divider = "default",
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  tone?: PanelTone;
  emphasis?: PanelHeaderEmphasis;
  divider?: PanelHeaderDivider;
  children: ReactNode;
}) {
  return (
    <Panel as="article" tone={tone}>
      <PanelHeader
        align="start"
        title={title}
        description={description}
        actions={action}
        emphasis={emphasis}
        divider={divider}
      />
      <div className="tw:grid tw:gap-3 tw:px-[22px] tw:pt-4 tw:pb-5">
        {children}
      </div>
    </Panel>
  );
}

function formatTime(value: string | null): string {
  return value
    ? new Date(value).toLocaleTimeString([], { timeStyle: "short" })
    : "—";
}

function formatDateTime(value: string | null | undefined): string {
  return value
    ? new Date(value).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1_000) return String(value) + "ms";
  return (value / 1_000).toFixed(1) + "s";
}

function formatMetric(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

function modeExplanation(mode: DiscoveryMode): string {
  if (mode === "OFF")
    return "Discovery is off. No bars are evaluated and no candidate evidence is recorded.";
  if (mode === "SHADOW")
    return "SHADOW evaluates the market on every completed bar and records the candidates it finds without changing today's daily list.";
  return "AUTO_ADD is selected. Automatic intake is not commissioned, so no candidate is added to the daily list.";
}

function catalogSentence(catalog: DiscoveryStatus["catalog"]): string {
  if (catalog.status === "FRESH")
    return "Catalog is fresh and matches the current trading date.";
  if (catalog.status === "LAST_GOOD")
    return "Catalog is using the last good snapshot as a fallback. It is not fresh.";
  if (catalog.status === "UNAVAILABLE")
    return "Catalog is unavailable. Discovery cannot evaluate new bars until a snapshot is restored.";
  return "Catalog status is unknown. No snapshot has been loaded yet.";
}

function workState(
  status: DiscoveryStatus | null,
  activeRun: DiscoveryRun | null,
  now: Date,
): { tone: string; label: string; detail: string } {
  if (!status)
    return {
      tone: "unknown",
      label: "Checking discovery status",
      detail: "Confirming the scheduler, catalog and latest run state.",
    };
  if (status.scheduler === "OFF")
    return {
      tone: "off",
      label: "Discovery is off",
      detail:
        status.mode === "OFF"
          ? "No bars are evaluated while the mode is OFF. Switch to SHADOW to record candidate evidence."
          : "The scheduler is off for this market.",
    };
  if (status.scheduler === "MISSING_PROVIDER")
    return {
      tone: "attention",
      label: "Discovery is missing a market data provider",
      detail:
        "No catalog provider is configured for this market, so no bar can be evaluated.",
    };
  if (status.scheduler === "DEGRADED")
    return {
      tone: "degraded",
      label: "Discovery is degraded",
      detail:
        status.lastError ??
        "The scheduler reported a problem. The last known status is shown.",
    };
  if (status.scheduler === "RUNNING" || activeRun) {
    const elapsed =
      activeRun?.status === "RUNNING"
        ? ` Started ${agoFromMs(now.getTime() - Date.parse(activeRun.startedAt))}.`
        : "";
    return {
      tone: "running",
      label: "Discovery is running",
      detail: `Evaluating the latest completed bar now.${elapsed}`,
    };
  }
  if (status.nextEvaluationAt)
    return {
      tone: "waiting",
      label: "Discovery is waiting for the next completed bar",
      detail: `Next evaluation ${formatTime(status.nextEvaluationAt)} (${countdown(now, status.nextEvaluationAt) ?? "scheduled"}). Screening runs after each completed 5-minute bar in the regular session.`,
    };
  return {
    tone: "waiting",
    label: "Discovery is waiting",
    detail:
      "No evaluation is scheduled right now. It resumes automatically when a new completed bar is available.",
  };
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: DiscoveryRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const duration = run.completedAt
    ? formatDuration(Date.parse(run.completedAt) - Date.parse(run.startedAt))
    : "still running";
  return (
    <div className="tw:border-b tw:border-line-subtle">
      <button
        type="button"
        className={`tw:grid tw:grid-cols-[1.1fr_1.4fr_2fr_0.7fr] tw:items-center tw:gap-4 tw:px-[22px] tw:py-[14px] tw:w-full tw:cursor-pointer tw:border-0 tw:bg-transparent tw:text-left tw:text-[0.78rem] tw:text-ink-300 tw:hover:bg-surface-raised tw:aria-expanded:bg-surface-raised ${ROW_MEDIA_CLASSES}`}
        aria-expanded={expanded}
        aria-controls={expanded ? `discovery-run-${run.id}` : undefined}
        onClick={onToggle}
      >
        <span className="tw:grid tw:gap-1">
          <strong className="tw:font-mono tw:tracking-[0.04em] tw:text-ink-100">
            {run.status}
          </strong>
          <small className="tw:text-ink-650">
            started {formatTime(run.startedAt)}
          </small>
        </span>
        <span>
          {run.tradingDate}
          <small className="tw:text-ink-650">
            {run.completedBarEnd.slice(11, 16)} UTC bar
          </small>
        </span>
        <span>
          {run.coverage.pass} pass · {run.coverage.fail} fail ·{" "}
          {run.coverage.unevaluable} unevaluable · {run.coverage.deferred}{" "}
          deferred
        </span>
        <span>{run.mode}</span>
      </button>
      {expanded && (
        <div
          className="tw:grid tw:gap-3 tw:border-t tw:border-dashed tw:border-line tw:bg-surface-sunken tw:px-[22px] tw:pt-[14px] tw:pb-[18px]"
          id={`discovery-run-${run.id}`}
        >
          <FactList>
            <Fact label="Policy">{run.policyVersion}</Fact>
            <Fact label="Screened">{run.coverage.total}</Fact>
            <Fact label="Started">{formatDateTime(run.startedAt)}</Fact>
            <Fact label="Completed">{formatDateTime(run.completedAt)}</Fact>
            <Fact label="Duration">{duration}</Fact>
            <Fact label="Evaluation">{formatDateTime(run.evaluationAt)}</Fact>
            <Fact label="Run id">{run.id}</Fact>
          </FactList>
          {run.failure && <Text variant="danger">Failure: {run.failure}</Text>}
        </div>
      )}
    </div>
  );
}

function EvaluationRow({ evaluation }: { evaluation: DiscoveryEvidence }) {
  const result = evaluation.result;
  return (
    <div
      className={`tw:grid tw:grid-cols-[1.2fr_0.8fr_3fr_0.8fr] tw:items-center tw:gap-4 tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-[14px] tw:text-[0.78rem] tw:text-ink-300 ${ROW_MEDIA_CLASSES}`}
    >
      <span className="tw:grid tw:gap-1">
        <strong>{result.providerCode}</strong>
        <small className="tw:text-ink-650">
          {result.providerExchange}
          {result.symbolId === null ? "" : ` · id ${result.symbolId}`}
        </small>
      </span>
      <span>{result.state}</span>
      <span>
        {result.reasons.length
          ? result.reasons.join(" · ")
          : "All filters passed"}
      </span>
      <span>{formatTime(result.evaluationAt)}</span>
    </div>
  );
}

export function DiscoveryView({
  marketId,
}: {
  marketId: "CA_TSX" | "US_EQUITIES";
}) {
  const [section, setSection] = useState<DiscoverySection>("overview");
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [evaluations, setEvaluations] = useState<DiscoveryEvidence[]>([]);
  const [evaluationNext, setEvaluationNext] = useState<{
    exchange: string;
    code: string;
  } | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [evaluationsBusy, setEvaluationsBusy] = useState(false);
  const requestSeq = useRef(0);
  const inFlightSeq = useRef<number | null>(null);
  const now = useNow();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (inFlightSeq.current !== null) return;
      const seq = ++requestSeq.current;
      inFlightSeq.current = seq;
      try {
        const [statusRaw, runsRaw] = await Promise.all([
          getJson("/api/discovery/status?marketId=" + marketId, signal),
          getJson(
            "/api/discovery/runs?marketId=" + marketId + "&limit=20",
            signal,
          ),
        ]);
        const nextStatus = discoveryStatusSchema.parse(statusRaw);
        const nextRuns = discoveryRunListSchema.parse(runsRaw).runs;
        const evaluationsRaw = nextStatus.lastRun
          ? await getJson(
              "/api/discovery/evaluations?marketId=" +
                marketId +
                "&runId=" +
                nextStatus.lastRun.id +
                "&limit=50",
              signal,
            )
          : { evaluations: [], nextAfter: null };
        const nextEvaluations =
          discoveryEvidenceListSchema.parse(evaluationsRaw);
        if (seq !== requestSeq.current || signal?.aborted) return;
        setStatus(nextStatus);
        setRuns(nextRuns);
        setEvaluations(nextEvaluations.evaluations);
        setEvaluationNext(nextEvaluations.nextAfter);
        setCheckedAt(new Date().toISOString());
        setError("");
        setRefreshError("");
      } catch (reason) {
        if (isAbortError(reason) || seq !== requestSeq.current) return;
        setRefreshError(
          reason instanceof Error
            ? reason.message
            : "Discovery status unavailable",
        );
      } finally {
        if (inFlightSeq.current === seq) inFlightSeq.current = null;
      }
    },
    [marketId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(
      () => void load(controller.signal),
      POLL_INTERVAL_MS,
    );
    return () => {
      requestSeq.current += 1;
      inFlightSeq.current = null;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  useRefreshOnFocus(() => void load());

  const loadMoreEvaluations = async () => {
    if (!evaluationNext || !status?.lastRun) return;
    setEvaluationsBusy(true);
    try {
      const query = new URLSearchParams({
        marketId,
        runId: status.lastRun.id,
        limit: "50",
        afterExchange: evaluationNext.exchange,
        afterCode: evaluationNext.code,
      });
      const next = discoveryEvidenceListSchema.parse(
        await getJson("/api/discovery/evaluations?" + query.toString()),
      );
      setEvaluations((current) => [...current, ...next.evaluations]);
      setEvaluationNext(next.nextAfter);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to load more discovery reasons",
      );
    } finally {
      setEvaluationsBusy(false);
    }
  };

  const changeMode = async (next: DiscoveryMode) => {
    if (!status || next === "AUTO_ADD") return;
    setBusy(true);
    setError("");
    try {
      const result = discoveryModeStateSchema.parse(
        await sendJson("/api/discovery/mode", "PUT", {
          marketId,
          mode: next,
          expectedRevision: status.revision,
          reason: "Operator dashboard mode change",
        }),
      );
      setStatus((current) =>
        current
          ? {
              ...current,
              mode: result.mode,
              revision: result.revision,
              modeUpdatedAt: result.updatedAt,
              modeActor: result.actor,
            }
          : current,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Mode change failed");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    setBusy(true);
    setError("");
    try {
      const result = discoveryRunSchema.parse(
        await sendJson("/api/discovery/preview", "POST", { marketId }),
      );
      setRuns((current) => [
        result,
        ...current.filter((run) => run.id !== result.id),
      ]);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const policy = status?.policy ?? discoveryPolicyForMarket(marketId);
  const activeRun =
    status?.lastRun &&
    (status.activeRunId === status.lastRun.id ||
      status.lastRun.status === "RUNNING" ||
      status.scheduler === "RUNNING")
      ? status.lastRun
      : null;
  const work = workState(status, activeRun, now);
  const catalog = status?.catalog;
  const fastFunnel = status?.fastFunnel;
  const parity = status?.parity;
  const usage = status?.performance?.requestUsage;
  const lastRunFailure =
    status?.lastRun &&
    (status.lastRun.status === "FAILED" || status.lastRun.status === "PARTIAL")
      ? (status.lastRun.failure ??
        "The run finished with partial coverage; some catalog members were deferred.")
      : null;

  return (
    <div className="tw:grid tw:gap-[18px]">
      <header className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3">
        <nav
          className="tw:flex tw:flex-wrap tw:items-center tw:gap-1"
          aria-label="Discovery sections"
        >
          {SECTIONS.map((entry) => (
            <Button
              key={entry.key}
              variant="tab"
              aria-pressed={section === entry.key}
              onClick={() => setSection(entry.key)}
            >
              {entry.label}
            </Button>
          ))}
        </nav>
        <span className="tw:font-mono tw:text-[0.64rem] tw:font-[650] tw:tracking-[0.08em] tw:uppercase tw:text-ink-550">
          {checkedAt
            ? `Last checked ${formatTime(checkedAt)}${refreshError ? " · refresh failed" : ""}`
            : "Loading status…"}
        </span>
      </header>
      {error && <p className="error-banner">{error}</p>}
      {refreshError && (
        <p className="tw:m-0 tw:rounded-input tw:border tw:border-line-warn tw:bg-surface-warn tw:px-[14px] tw:py-[10px] tw:text-[0.78rem] tw:text-warn-soft">
          Live refresh failed: {refreshError}
          {status
            ? ` · Showing the last known status from ${formatTime(checkedAt)}.`
            : ""}
        </p>
      )}

      {section === "overview" && (
        <div className="tw:grid tw:gap-[18px]">
          <Panel
            tone={refreshError ? "warn" : "plain"}
            aria-label="Discovery status"
          >
            <PanelHeader
              align="start"
              emphasis="headline"
              title={work.label}
              titleRole="status"
              description={work.detail}
              actions={
                <span className={schedulerStateClasses(status?.scheduler)}>
                  {status?.scheduler ?? "LOADING"}
                </span>
              }
            />
            <div className="tw:grid tw:gap-3 tw:px-[22px] tw:pt-4 tw:pb-5">
              <Text variant="note">
                Policy {policy.version} · market {marketId}
                {activeRun
                  ? ` · active run started ${formatDateTime(activeRun.startedAt)}`
                  : ""}
              </Text>
            </div>
          </Panel>

          {(status?.lastError || lastRunFailure) && (
            <Panel tone="attention" aria-label="Discovery problems">
              <PanelHeader
                title="Needs attention"
                description="Current failures, shown without hovering."
                divider="danger"
              />
              <div className="tw:grid tw:gap-3 tw:px-[22px] tw:pt-4 tw:pb-5">
                {status?.lastError && (
                  <Text variant="danger">
                    Scheduler error: {status.lastError}
                  </Text>
                )}
                {status?.lastRun && lastRunFailure && (
                  <Text variant="danger">
                    Last run {status.lastRun.status.toLowerCase()}:{" "}
                    {lastRunFailure}
                  </Text>
                )}
              </div>
            </Panel>
          )}

          <div
            className={`tw:grid tw:grid-cols-2 tw:items-start tw:gap-[18px] ${STACK_GRID_CLASSES}`}
          >
            <Card
              title="Discovery mode"
              description={`Mode changes apply to ${marketId} only.`}
              action={
                <Button
                  variant="primary"
                  disabled={busy || !status}
                  onClick={() => void preview()}
                >
                  {busy ? "WORKING…" : "RUN PREVIEW"}
                </Button>
              }
            >
              <p className="tw:m-0 tw:font-mono tw:text-[1.15rem] tw:font-bold tw:tracking-[0.04em] tw:text-ink-50">
                {status?.mode ?? "—"}
              </p>
              <Text>
                {status
                  ? modeExplanation(status.mode)
                  : "Loading discovery mode…"}
              </Text>
              <Text>
                Automatic intake (AUTO_ADD) is not available or commissioned for
                this market. While intake is disabled, no candidate is added to
                the daily list automatically — every list change remains a
                manual decision.
              </Text>
              <div
                className="tw:flex tw:flex-wrap tw:gap-2"
                role="group"
                aria-label="Discovery mode"
              >
                {MODES.map((mode) => (
                  <Button
                    key={mode}
                    variant="segmented"
                    disabled={busy || mode === "AUTO_ADD" || !status}
                    aria-pressed={status?.mode === mode}
                    onClick={() => void changeMode(mode)}
                  >
                    {mode}
                  </Button>
                ))}
              </div>
              <Text variant="note">
                AUTO_ADD stays disabled pending parity, capacity and operator
                commissioning.
              </Text>
              <Text variant="note">
                Revision {status?.revision ?? "—"} · changed by{" "}
                {status?.modeActor ?? "—"} ·{" "}
                {formatDateTime(status?.modeUpdatedAt)}
              </Text>
            </Card>

            <Card
              title="Candidate outcomes"
              description="Coverage from the latest run for this market."
              action={
                <StatusBadge
                  size="header"
                  tone={badgeTone(status?.lastRun?.status)}
                >
                  {status?.lastRun?.status ?? "NO RUN"}
                </StatusBadge>
              }
            >
              {status?.lastRun ? (
                <>
                  <Text>
                    {status.lastRun.status === "RUNNING"
                      ? "A run is in progress. Counts update as catalog members complete."
                      : `Screened ${status.lastRun.coverage.total} catalog members on the ${formatTime(status.lastRun.completedBarEnd)} bar.`}
                  </Text>
                  <FactList>
                    <Fact label="Passed">{status.lastRun.coverage.pass}</Fact>
                    <Fact label="Failed">{status.lastRun.coverage.fail}</Fact>
                    <Fact label="Unevaluable">
                      {status.lastRun.coverage.unevaluable}
                    </Fact>
                    <Fact label="Deferred">
                      {status.lastRun.coverage.deferred}
                    </Fact>
                  </FactList>
                  <Text variant="note">
                    {status.lastRun.coverage.pass === 0
                      ? "Zero candidates passed. That is a valid screening result, not a failure."
                      : `${status.lastRun.coverage.pass} candidate${status.lastRun.coverage.pass === 1 ? "" : "s"} passed the deterministic filters.`}
                  </Text>
                </>
              ) : (
                <Text>
                  No discovery runs are recorded for this market yet. Discovery
                  records its first run after the next completed bar.
                </Text>
              )}
            </Card>

            <Card
              title="Symbol catalog"
              description="Source list screened on each completed bar."
              action={
                <StatusBadge size="header" tone={badgeTone(catalog?.status)}>
                  {catalog?.status ?? "LOADING"}
                </StatusBadge>
              }
            >
              <Text>
                {catalog ? catalogSentence(catalog) : "Loading catalog state…"}
              </Text>
              {catalog && (
                <FactList>
                  <Fact label="Age">{agoFromMs(catalog.ageMs)}</Fact>
                  <Fact label="Trading date">{catalog.tradingDate ?? "—"}</Fact>
                  <Fact label="Fetched">
                    {formatDateTime(catalog.fetchedAt)}
                  </Fact>
                  <Fact label="Rows">{formatMetric(catalog.rowCount)}</Fact>
                  <Fact label="Admitted">
                    {formatMetric(catalog.admittedCount)}
                  </Fact>
                  <Fact label="Source">{catalog.source ?? "—"}</Fact>
                </FactList>
              )}
              {catalog?.failure && (
                <Text variant="danger">Catalog failure: {catalog.failure}</Text>
              )}
            </Card>

            <Card
              title="Fast Funnel"
              description="Optional accelerator that prioritizes early movers."
              action={
                <StatusBadge
                  size="header"
                  tone={fastFunnel?.enabled ? "ok" : "muted"}
                >
                  {fastFunnel?.enabled ? "ENABLED" : "DISABLED"}
                </StatusBadge>
              }
            >
              {fastFunnel?.enabled ? (
                <>
                  <Text>
                    Fast Funnel prioritizes top movers so their bars are
                    evaluated first.
                  </Text>
                  <FactList>
                    <Fact label="Last accelerated">
                      {formatDateTime(fastFunnel.lastAcceleratedAt)}
                    </Fact>
                    <Fact label="Top movers">{fastFunnel.topMoversCount}</Fact>
                    <Fact label="Prioritized">
                      {fastFunnel.acceleratedCandidatesCount}
                    </Fact>
                    <Fact label="Passed">
                      {fastFunnel.acceleratedPassedCount}
                    </Fact>
                  </FactList>
                  {fastFunnel.topMoverSymbols.length > 0 && (
                    <Text variant="note">
                      Top movers: {fastFunnel.topMoverSymbols.join(", ")}
                    </Text>
                  )}
                </>
              ) : (
                <Text>
                  Fast Funnel is disabled for this market. No candidates are
                  prioritized and every catalog member is evaluated on the
                  normal cycle.
                </Text>
              )}
            </Card>

            <Card
              title="Next automatic step"
              description="Screening runs after each completed 5-minute bar."
            >
              {status?.nextEvaluationAt ? (
                <>
                  <Text>
                    Next screening at {formatTime(status.nextEvaluationAt)} on
                    the next completed 5-minute bar.
                  </Text>
                  <p className="tw:m-0 tw:font-mono tw:text-[0.68rem] tw:font-bold tw:tracking-[0.06em] tw:text-accent">
                    {countdown(now, status.nextEvaluationAt)}
                  </p>
                </>
              ) : (
                <Text>
                  No screening time is scheduled right now. Discovery resumes
                  automatically when the next completed bar is available.
                </Text>
              )}
            </Card>
          </div>
        </div>
      )}

      {section === "results" && (
        <>
          <Panel aria-label="Discovery run history">
            <PanelHeader
              title="Shadow run history"
              description="Select a run to inspect its coverage, timing and failure detail."
              actions={<PanelMeta>{runs.length} RUNS</PanelMeta>}
            />
            <div
              aria-hidden="true"
              className="tw:grid tw:grid-cols-[1.1fr_1.4fr_2fr_0.7fr] tw:items-center tw:gap-4 tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-[14px] tw:font-mono tw:text-[0.61rem] tw:font-bold tw:tracking-[0.1em] tw:text-ink-750 tw:below-900:hidden"
            >
              <span>STATUS / STARTED</span>
              <span>DATE / BAR</span>
              <span>COVERAGE</span>
              <span>MODE</span>
            </div>
            {runs.length ? (
              runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  expanded={expandedRunId === run.id}
                  onToggle={() =>
                    setExpandedRunId((current) =>
                      current === run.id ? null : run.id,
                    )
                  }
                />
              ))
            ) : (
              <p className="tw:m-0 tw:px-[22px] tw:py-6 tw:text-ink-650">
                No discovery runs recorded for this market.
              </p>
            )}
          </Panel>
          <Panel aria-label="Latest symbol decisions">
            <PanelHeader
              title="Latest symbol decisions"
              description="Provider identity, outcome and retained reasons for the latest run."
              actions={<PanelMeta>{evaluations.length} SHOWN</PanelMeta>}
            />
            {evaluations.length ? (
              <>
                <div
                  aria-hidden="true"
                  className={`tw:grid tw:grid-cols-[1.2fr_0.8fr_3fr_0.8fr] tw:items-center tw:gap-4 tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-[14px] tw:font-mono tw:text-[0.61rem] tw:font-bold tw:tracking-[0.1em] tw:text-ink-750 ${ROW_MEDIA_CLASSES}`}
                >
                  <span>SYMBOL / PROVIDER</span>
                  <span>STATE</span>
                  <span>REASONS</span>
                  <span>EVALUATED</span>
                </div>
                {evaluations.map((evaluation) => (
                  <EvaluationRow key={evaluation.id} evaluation={evaluation} />
                ))}
                {evaluationNext && (
                  <Button
                    variant="secondary"
                    className="tw:mx-[22px] tw:my-4"
                    disabled={evaluationsBusy}
                    onClick={() => void loadMoreEvaluations()}
                  >
                    {evaluationsBusy ? "LOADING…" : "LOAD MORE REASONS"}
                  </Button>
                )}
              </>
            ) : (
              <p className="tw:m-0 tw:px-[22px] tw:py-6 tw:text-ink-650">
                No per-symbol evaluations are available for the latest run.
              </p>
            )}
          </Panel>
        </>
      )}

      {section === "diagnostics" && (
        <div className="tw:grid tw:gap-[18px]">
          <p className="tw:m-0 tw:text-[0.8rem] tw:leading-[1.5] tw:text-ink-450">
            Operator diagnostics. Raw provider budgets, scheduler performance,
            Fast Funnel internals and TradingView parity evidence.
          </p>
          <div
            className={`tw:grid tw:grid-cols-2 tw:items-start tw:gap-[18px] ${STACK_GRID_CLASSES}`}
          >
            <Card
              title="Provider budget"
              description="Remaining broker requests for the current windows."
            >
              <FactList>
                <Fact label="Remaining hour">
                  {formatMetric(status?.budget.remainingHour)}
                </Fact>
                <Fact label="Remaining discovery hour">
                  {formatMetric(status?.budget.remainingDiscoveryHour)}
                </Fact>
                <Fact label="Queued">
                  {formatMetric(status?.budget.queued)}
                </Fact>
                <Fact label="Active">
                  {formatMetric(status?.budget.active)}
                </Fact>
              </FactList>
            </Card>

            <Card
              title="Performance"
              description="Recent scheduler cycle and queue latency samples."
            >
              <FactList>
                <Fact label="Samples">
                  {formatMetric(status?.performance?.sampleCount)}
                </Fact>
                <Fact label="Last cycle">
                  {formatDuration(status?.performance?.lastCycleDurationMs)}
                </Fact>
                <Fact label="Last queue latency">
                  {formatDuration(status?.performance?.lastQueueLatencyMs)}
                </Fact>
                <Fact label="Cycle p95">
                  {formatDuration(status?.performance?.cycleP95Ms)}
                </Fact>
                <Fact label="Queue p95">
                  {formatDuration(status?.performance?.queueP95Ms)}
                </Fact>
                <Fact label="Input collection elapsed">
                  {formatDuration(
                    status?.performance?.phases?.inputCollectionElapsedMs,
                  )}
                </Fact>
                <Fact label="Evaluation work (cumulative)">
                  {formatDuration(
                    status?.performance?.phases?.evaluationWorkMs,
                  )}
                </Fact>
                <Fact label="Serialization work (cumulative)">
                  {formatDuration(
                    status?.performance?.phases?.serializationWorkMs,
                  )}
                </Fact>
                <Fact label="Evidence persistence work (cumulative)">
                  {formatDuration(
                    status?.performance?.phases?.persistenceWorkMs,
                  )}
                </Fact>
                <Fact label="Queue depth">
                  {formatMetric(status?.queueDepth)}
                </Fact>
                <Fact label="Oldest queued">
                  {formatDuration(status?.oldestQueueAgeMs)}
                </Fact>
              </FactList>
              <Text variant="note">
                Shared-process request outcomes during this cycle window:{" "}
                {usage
                  ? `${usage.completed} completed · ${usage.failed} failed · ${usage.cancelled} cancelled · ${usage.expired} expired`
                  : "not reported"}
              </Text>
              <Text variant="note">
                Collection is elapsed time; evaluator and evidence write figures
                are cumulative work across catalog members and can exceed the
                cycle duration. Cycle p95 is the wall-clock gate.
              </Text>
            </Card>

            <Card
              title="Fast Funnel detail"
              description="Accelerator internals for this market."
              action={
                <StatusBadge
                  size="header"
                  tone={fastFunnel?.enabled ? "ok" : "muted"}
                >
                  {fastFunnel?.enabled ? "ENABLED" : "DISABLED"}
                </StatusBadge>
              }
            >
              {fastFunnel?.enabled ? (
                <FactList>
                  <Fact label="Last accelerated">
                    {formatDateTime(fastFunnel.lastAcceleratedAt)}
                  </Fact>
                  <Fact label="Top movers">{fastFunnel.topMoversCount}</Fact>
                  <Fact label="Prioritized">
                    {fastFunnel.acceleratedCandidatesCount}
                  </Fact>
                  <Fact label="Evaluated">
                    {fastFunnel.acceleratedEvaluatedCount}
                  </Fact>
                  <Fact label="Passed">
                    {fastFunnel.acceleratedPassedCount}
                  </Fact>
                </FactList>
              ) : (
                <Text>
                  Fast Funnel is disabled, so it has no recent accelerator
                  activity.
                </Text>
              )}
              {fastFunnel?.enabled && fastFunnel.topMoverSymbols.length > 0 && (
                <Text variant="note">
                  Top movers: {fastFunnel.topMoverSymbols.join(", ")}
                </Text>
              )}
            </Card>

            <Card
              title="TradingView parity"
              description="Shadow comparison against TradingView candidates."
              action={<PanelMeta>{parity?.auditCount ?? 0} AUDITS</PanelMeta>}
            >
              {parity ? (
                <>
                  <FactList>
                    <Fact label="Average overlap">
                      {parity.averageOverlapRatio === null
                        ? "—"
                        : `${(parity.averageOverlapRatio * 100).toFixed(1)}%`}
                    </Fact>
                    <Fact label="Last audited">
                      {formatDateTime(parity.lastAuditedAt)}
                    </Fact>
                    <Fact label="Audits">{parity.auditCount}</Fact>
                    <Fact label="Missed movers">
                      {parity.latestAudit?.missedMovers.length ?? "—"}
                    </Fact>
                  </FactList>
                  {parity.latestAudit ? (
                    <>
                      <Text variant="note">
                        Latest audit: {parity.latestAudit.overlapCount}/
                        {parity.latestAudit.tradingViewCount} TradingView
                        candidates overlapped
                        {Object.entries(parity.latestAudit.discrepancySummary)
                          .filter(([, count]) => count > 0)
                          .map(
                            ([category, count]) =>
                              ` · ${category.replaceAll("_", " ").toLowerCase()}: ${count}`,
                          )
                          .join("")}
                      </Text>
                      {parity.latestAudit.missedMovers.length > 0 && (
                        <ul className="tw:m-0 tw:grid tw:gap-[6px] tw:pl-[18px] tw:text-[0.78rem] tw:leading-[1.45] tw:text-ink-250">
                          {parity.latestAudit.missedMovers.map((mover) => (
                            <li key={`${mover.exchange}:${mover.symbol}`}>
                              <b>{mover.symbol}</b> · {mover.exchange} ·{" "}
                              {mover.discrepancyCategory
                                .replaceAll("_", " ")
                                .toLowerCase()}
                              {mover.questradeReasons.length
                                ? ` · ${mover.questradeReasons.join(", ")}`
                                : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <Text variant="note">No parity audits recorded yet.</Text>
                  )}
                </>
              ) : (
                <Text>Parity evidence is not reported for this market.</Text>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
