import {
  executionDiagnosticResponseSchema,
  paperBotRunListSchema,
  type ExecutionDiagnosticResponse,
  type ExecutionDiagnosticsMode,
  type PaperBotRun,
} from "@tsx-scanner/contracts";
import { useEffect, useMemo, useState } from "react";
import { getJson } from "../lib/api.js";
import { Tip } from "../ui.js";

type MarketId = "CA_TSX" | "US_EQUITIES";

const DIAGNOSTICS_CONTROL_LABEL =
  "tw:grid tw:gap-[5px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.06em] tw:uppercase tw:text-ink-700";
const DIAGNOSTICS_CONTROL =
  "tw:min-w-[190px] tw:rounded-[6px] tw:border tw:border-line tw:bg-surface tw:px-[10px] tw:py-2 tw:font-mono tw:text-[0.75rem] tw:font-normal tw:leading-[normal] tw:text-ink-200";
const DIAGNOSTICS_ROW =
  "execution-diagnostics-row tw:grid tw:grid-cols-[1.6fr_1fr_1fr_1.3fr] tw:items-center tw:gap-3 tw:border-t tw:border-t-line-subtle tw:px-[13px] tw:py-[10px] tw:text-[0.75rem] tw:text-ink-400 tw:below-md:grid-cols-[1fr_1fr]";
const DIAGNOSTICS_ROW_DETAIL =
  "tw:mt-[3px] tw:block tw:font-mono tw:text-[0.66rem] tw:font-normal tw:leading-[normal] tw:text-ink-700";

function query(
  marketId: MarketId,
  mode: ExecutionDiagnosticsMode,
  asOf: string,
): string {
  const values: Record<string, string> = { marketId, mode };
  if (mode === "AS_OF" && asOf) values.asOf = new Date(asOf).toISOString();
  return new URLSearchParams(values).toString();
}

function completedRuns(runs: PaperBotRun[]): PaperBotRun[] {
  return runs
    .filter((run) => run.source === "LIVE" && run.status === "COMPLETED")
    .sort((left, right) =>
      (right.completedAt ?? right.startedAt).localeCompare(
        left.completedAt ?? left.startedAt,
      ),
    );
}

function responseCounts(response: ExecutionDiagnosticResponse | null) {
  const report = response?.report;
  const unknown = report
    ? new Set([
        ...report.replenishment.unavailable,
        ...report.contention.rows.flatMap((row) => row.unavailable),
      ]).size
    : response?.status === "UNAVAILABLE"
      ? 1
      : 0;
  const missed =
    report?.replenishment.excluded.filter((entry) =>
      entry.reason.includes("MISSED_DEADLINE"),
    ).length ?? 0;
  const failed =
    report?.replenishment.excluded.filter((entry) =>
      entry.reason.includes("FAILED"),
    ).length ?? 0;
  const pending = response?.status === "PENDING" ? 1 : 0;
  return { pending, missed, failed, unknown };
}

export function ExecutionDiagnosticsPanel({
  marketId = "CA_TSX",
}: {
  marketId?: MarketId;
}) {
  const [runs, setRuns] = useState<PaperBotRun[]>([]);
  const [runId, setRunId] = useState("");
  const [mode, setMode] = useState<ExecutionDiagnosticsMode>("RUN_END");
  const [asOf, setAsOf] = useState("");
  const [response, setResponse] = useState<ExecutionDiagnosticResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setRunId("");
    setRuns([]);
    setResponse(null);
    getJson(
      `/api/paper-bot/runs?marketId=${marketId}&source=LIVE&limit=100`,
      controller.signal,
    )
      .then((value) => {
        const next = completedRuns(paperBotRunListSchema.parse(value).runs);
        if (controller.signal.aborted) return;
        setRuns(next);
        setRunId((current) => current || next[0]?.id || "");
        setError("");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to load diagnostic runs",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [marketId]);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === runId) ?? null,
    [runId, runs],
  );

  useEffect(() => {
    if (!runId || (mode === "AS_OF" && !asOf)) {
      setResponse(null);
      return;
    }
    const controller = new AbortController();
    setResponse(null);
    setError("");
    getJson(
      `/api/paper-bot/runs/${runId}/execution-diagnostics?${query(marketId, mode, asOf)}`,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted)
          setResponse(executionDiagnosticResponseSchema.parse(value));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to load execution diagnostics",
          );
      });
    return () => controller.abort();
  }, [asOf, marketId, mode, runId]);

  const counts = responseCounts(response);
  const report = response?.report;

  return (
    <section className="panel execution-diagnostics-panel tw:mt-[18px]">
      <div className="panel-title">
        <div>
          <h3>Execution diagnostics</h3>
          <p>
            Read-only evidence about displayed liquidity, fills and resource
            contention.
          </p>
        </div>
        <Tip label="RUN_END uses the immutable funded-run boundary. AS_OF and CURRENT_ACCOUNT are explicit read-only projections and never rewrite or relabel the run-end artifact.">
          <span className="badge">EVIDENCE ONLY</span>
        </Tip>
      </div>
      <div className="execution-diagnostics-controls tw:flex tw:flex-wrap tw:gap-3 tw:border-y tw:border-y-line-subtle tw:bg-surface-sunken tw:px-5 tw:py-[14px]">
        <label className={DIAGNOSTICS_CONTROL_LABEL}>
          Completed run
          <select
            aria-label="Completed diagnostic run"
            className={DIAGNOSTICS_CONTROL}
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
          >
            <option value="">Select a completed run</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.sessionDate} · {run.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label className={DIAGNOSTICS_CONTROL_LABEL}>
          Time basis
          <select
            aria-label="Diagnostics time basis"
            className={DIAGNOSTICS_CONTROL}
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as ExecutionDiagnosticsMode)
            }
          >
            <option value="RUN_END">RUN_END</option>
            <option value="AS_OF">AS_OF</option>
            <option value="CURRENT_ACCOUNT">CURRENT_ACCOUNT</option>
          </select>
        </label>
        {mode === "AS_OF" ? (
          <label className={DIAGNOSTICS_CONTROL_LABEL}>
            As of
            <input
              aria-label="Diagnostics as of time"
              className={DIAGNOSTICS_CONTROL}
              type="datetime-local"
              value={asOf}
              max={selectedRun?.completedAt?.slice(0, 16)}
              onChange={(event) => setAsOf(event.target.value)}
            />
          </label>
        ) : null}
      </div>

      {loading ? <div className="empty">Loading completed runs…</div> : null}
      {!loading && runs.length === 0 ? (
        <div className="empty">
          No completed funded run is available for diagnostics.
        </div>
      ) : null}
      {error ? <p className="error-banner">{error}</p> : null}
      {response ? (
        <div className="execution-diagnostics-body tw:max-h-[min(430px,52vh)] tw:overflow-y-auto tw:overscroll-contain tw:[scrollbar-gutter:stable]">
          <div
            className="execution-diagnostics-status tw:flex tw:items-baseline tw:justify-between tw:gap-3 tw:px-5 tw:pt-[13px] tw:pb-0 tw:text-[0.76rem] tw:text-ink-700"
            aria-live="polite"
          >
            <strong className="tw:font-mono tw:text-[0.7rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-accent">
              {response.status}
            </strong>
            <span>
              {response.reason ?? `Fresh at ${response.generatedAt ?? "—"}`}
            </span>
          </div>
          <div className="journal-metrics execution-diagnostics-metrics tw:mx-5 tw:mt-3 tw:mb-4 tw:grid tw:grid-cols-[repeat(4,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-xl tw:border tw:border-line tw:bg-surface-sunken tw:below-md:grid-cols-[repeat(2,1fr)]">
            <Tip label="A pending count means the durable worker has not yet retained the report. It is not a zero-liquidity result.">
              <div className="tw:bg-surface tw:px-[19px] tw:py-[17px]">
                <span className="tw:mb-2 tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.09em] tw:text-ink-700">
                  PENDING
                </span>
                <strong className="tw:text-[1.2rem]">{counts.pending}</strong>
              </div>
            </Tip>
            <Tip label="Missed deadlines are counted only when the retained diagnostic evidence explicitly identifies that reason; unknown timing is not treated as a miss.">
              <div className="tw:bg-surface tw:px-[19px] tw:py-[17px]">
                <span className="tw:mb-2 tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.09em] tw:text-ink-700">
                  MISSED
                </span>
                <strong className="tw:text-[1.2rem]">{counts.missed}</strong>
              </div>
            </Tip>
            <Tip label="Failed evidence is counted only for explicit failed exclusions. Unverifiable history remains in UNKNOWN.">
              <div className="tw:bg-surface tw:px-[19px] tw:py-[17px]">
                <span className="tw:mb-2 tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.09em] tw:text-ink-700">
                  FAILED
                </span>
                <strong className="tw:text-[1.2rem]">{counts.failed}</strong>
              </div>
            </Tip>
            <Tip label="Unknown includes missing quote/order history, ambiguous fill links, unverified event sequence and other evidence gaps. It is never silently treated as zero.">
              <div className="tw:bg-surface tw:px-[19px] tw:py-[17px]">
                <span className="tw:mb-2 tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.09em] tw:text-ink-700">
                  UNKNOWN
                </span>
                <strong className="tw:text-[1.2rem]">{counts.unknown}</strong>
              </div>
            </Tip>
          </div>
          {report ? (
            <>
              <p className="execution-diagnostics-freshness tw:mx-5 tw:mt-0 tw:mb-[15px] tw:text-[0.72rem] tw:text-ink-700">
                Freshness:{" "}
                {new Date(
                  response.generatedAt ?? report.generatedAt,
                ).toLocaleString()}{" "}
                · version {report.reportVersion}
              </p>
              {report.replenishment.stretches.length > 0 ? (
                <div className="execution-diagnostics-table tw:mx-5 tw:mt-0 tw:mb-[18px] tw:overflow-hidden tw:rounded-[8px] tw:border tw:border-line">
                  <h4 className="tw:m-0 tw:bg-surface-sunken tw:px-[13px] tw:py-[11px] tw:text-[0.75rem] tw:text-ink-300">
                    Snapshot replenishment candidates
                  </h4>
                  {report.replenishment.stretches.map((stretch) => (
                    <div
                      className={DIAGNOSTICS_ROW}
                      key={`${stretch.runId}-${stretch.instrumentId}-${stretch.side}-${stretch.startAt}`}
                    >
                      <span>
                        <strong className="tw:block">
                          {stretch.instrumentId}
                        </strong>
                        <small className={DIAGNOSTICS_ROW_DETAIL}>
                          {stretch.side} · {stretch.snapshotCount} snapshots
                        </small>
                      </span>
                      <span>{stretch.displayedShares} displayed</span>
                      <span>{stretch.totalFilledShares} filled</span>
                      <span>
                        {stretch.excessOverInitialBudgetShares ?? "—"} excess
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  No supported replenishment stretch was proven.
                </div>
              )}
              <div className="execution-diagnostics-table tw:mx-5 tw:mt-0 tw:mb-[18px] tw:overflow-hidden tw:rounded-[8px] tw:border tw:border-line">
                <h4 className="tw:m-0 tw:bg-surface-sunken tw:px-[13px] tw:py-[11px] tw:text-[0.75rem] tw:text-ink-300">
                  Resource contention
                </h4>
                {report.contention.rows.length === 0 ? (
                  <div className="empty">
                    No attributed competing allocation.
                  </div>
                ) : (
                  report.contention.rows.map((row) => (
                    <div
                      className={DIAGNOSTICS_ROW}
                      key={`${row.orderId}-${row.quoteEvidenceId}`}
                    >
                      <span>
                        <strong className="tw:block">{row.orderId}</strong>
                        <small className={DIAGNOSTICS_ROW_DETAIL}>
                          {row.side} · rank {row.canonicalRank ?? "—"}
                        </small>
                      </span>
                      <span>{row.requestedShares ?? "—"} requested</span>
                      <span>{row.filledShares} filled</span>
                      <span>{row.reason.replaceAll("_", " ")}</span>
                    </div>
                  ))
                )}
              </div>
              {report.replenishment.unavailable.length > 0 ? (
                <Tip label="These limitations explain why a stronger liquidity conclusion is unavailable. The panel preserves the gap instead of substituting a later quote or current budget.">
                  <p className="execution-diagnostics-warning tw:mx-5 tw:mt-0 tw:mb-[15px] tw:text-[0.72rem] tw:text-warn">
                    Attribution limits:{" "}
                    {report.replenishment.unavailable.join(", ")}
                  </p>
                </Tip>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
