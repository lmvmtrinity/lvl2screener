import {
  signalModelResearchAuthorizationRecordSchema,
  signalModelResearchReadinessSchema,
  signalModelResearchReportSchema,
  type MarketId,
} from "@tsx-scanner/contracts";
import { useEffect, useRef, useState } from "react";
import { getJson } from "../lib/api.js";

type ResearchItem = {
  authorization: ReturnType<
    typeof signalModelResearchAuthorizationRecordSchema.parse
  >;
  readiness: ReturnType<typeof signalModelResearchReadinessSchema.parse>;
  report: ReturnType<typeof signalModelResearchReportSchema.parse> | null;
};

type PanelState = {
  marketId: MarketId;
  items: ResearchItem[];
  checkedAt: string;
};

const statusTone: Record<string, string> = {
  FAILED: "tw:border-line-danger tw:bg-surface-danger tw:text-danger-tint-soft",
  INSUFFICIENT: "tw:border-line-warn tw:bg-surface-warn tw:text-warn-soft",
  WAITING: "tw:border-line-warn tw:bg-surface-warn tw:text-warn-soft",
  DISPATCHED: "tw:border-line-accent tw:bg-surface-raised tw:text-accent",
  READY: "tw:border-line-accent tw:bg-surface-raised tw:text-accent",
  COMPLETED: "tw:border-line-accent tw:bg-surface-raised tw:text-accent",
  PREPARE_ONLY: "tw:border-line tw:bg-surface-sunken tw:text-ink-300",
  REVOKED: "tw:border-line tw:bg-surface-sunken tw:text-ink-400",
  EXPIRED: "tw:border-line tw:bg-surface-sunken tw:text-ink-400",
};

async function loadResearchItems(
  marketId: MarketId,
  signal: AbortSignal,
): Promise<ResearchItem[]> {
  const rawList = (await getJson(
    `/api/signal-model-research/authorizations?marketId=${marketId}&limit=25`,
    signal,
  )) as { authorizations?: unknown };
  if (!Array.isArray(rawList.authorizations))
    throw new Error("Model research list response is invalid");
  const authorizations = rawList.authorizations
    .map((row) => signalModelResearchAuthorizationRecordSchema.parse(row))
    .filter((row) => row.marketId === marketId);
  return Promise.all(
    authorizations.map(async (authorization) => {
      const raw = (await getJson(
        `/api/signal-model-research/authorizations/${encodeURIComponent(authorization.id)}`,
        signal,
      )) as Record<string, unknown>;
      if (!raw.authorization || !raw.readiness || !("report" in raw))
        throw new Error("Model research detail response is invalid");
      const detailAuthorization =
        signalModelResearchAuthorizationRecordSchema.parse(raw.authorization);
      if (
        detailAuthorization.id !== authorization.id ||
        detailAuthorization.marketId !== marketId
      )
        throw new Error("Model research detail scope does not match");
      return {
        authorization: detailAuthorization,
        readiness: signalModelResearchReadinessSchema.parse(raw.readiness),
        report:
          raw.report === null
            ? null
            : signalModelResearchReportSchema.parse(raw.report),
      };
    }),
  );
}

export function SignalModelResearchStatusPanel({
  marketId,
}: {
  marketId: MarketId;
}) {
  const generation = useRef(0);
  const [state, setState] = useState<PanelState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    let disposed = false;
    setLoading(true);
    setError(null);
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      const activeController = controller;
      const currentGeneration = ++generation.current;
      const current = () =>
        !disposed &&
        !activeController.signal.aborted &&
        currentGeneration === generation.current;
      setError(null);
      try {
        const items = await loadResearchItems(
          marketId,
          activeController.signal,
        );
        if (!current()) return;
        setState({
          marketId,
          items,
          checkedAt: new Date().toISOString(),
        });
        setError(null);
      } catch (reason) {
        if (!current()) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load model research status",
        );
      } finally {
        if (current()) setLoading(false);
      }
    };
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => {
      disposed = true;
      generation.current++;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [marketId]);

  const visibleState = state?.marketId === marketId ? state : null;
  return (
    <section
      aria-label="Signal-model research status"
      className="tw:flex tw:flex-col tw:gap-3 tw:rounded-panel tw:border tw:border-line tw:bg-surface tw:px-[18px] tw:py-[16px]"
    >
      <header className="tw:flex tw:flex-wrap tw:items-baseline tw:justify-between tw:gap-2">
        <div>
          <h2 className="tw:m-0 tw:text-[1rem] tw:font-semibold tw:text-ink-100">
            Strategy signal-model research
          </h2>
          <p className="tw:mx-0 tw:mt-1 tw:mb-0 tw:text-[0.76rem] tw:text-ink-400">
            Inactive research status for {marketId}. This view is read-only.
          </p>
        </div>
        <span className="tw:font-mono tw:text-[0.62rem] tw:text-ink-500">
          {visibleState
            ? `Checked ${new Date(visibleState.checkedAt).toLocaleTimeString()}`
            : loading
              ? "Checking status…"
              : "Not checked"}
        </span>
      </header>
      {error ? (
        <p
          role="alert"
          className="tw:m-0 tw:text-[0.78rem] tw:text-danger-tint-soft"
        >
          Model research status unavailable: {error}
        </p>
      ) : null}
      {!error && loading && !visibleState ? (
        <p role="status" className="tw:m-0 tw:text-[0.78rem] tw:text-ink-400">
          Loading market-scoped model research…
        </p>
      ) : null}
      {!loading && !error && visibleState?.items.length === 0 ? (
        <p className="tw:m-0 tw:text-[0.78rem] tw:text-ink-400">
          No model-research authorization records for {marketId}.
        </p>
      ) : null}
      {visibleState?.items.map(({ authorization, readiness, report }) => (
        <article
          key={authorization.id}
          className="tw:grid tw:gap-2 tw:border-t tw:border-line-subtle tw:pt-3"
        >
          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
            <span
              className={`tw:rounded-full tw:border tw:px-2 tw:py-1 tw:font-mono tw:text-[0.62rem] tw:font-bold ${statusTone[readiness.status] ?? statusTone.WAITING}`}
            >
              {readiness.status}
            </span>
            <span className="tw:text-[0.75rem] tw:text-ink-350">
              {readiness.mode.replaceAll("_", " ")} · trial budget{" "}
              {authorization.trialBudget}
            </span>
            {authorization.dispatchedJobId ? (
              <span className="tw:font-mono tw:text-[0.64rem] tw:text-ink-500">
                job {authorization.dispatchedJobId}
              </span>
            ) : null}
          </div>
          <p className="tw:m-0 tw:text-[0.78rem] tw:text-ink-250">
            {readiness.nextAction}
          </p>
          {readiness.blockers.length > 0 ? (
            <ul className="tw:m-0 tw:list-disc tw:pl-5 tw:text-[0.74rem] tw:text-ink-400">
              {readiness.blockers.map((blocker, index) => (
                <li key={`${index}:${blocker}`}>{blocker}</li>
              ))}
            </ul>
          ) : null}
          {readiness.lastCheckedAt ? (
            <p className="tw:m-0 tw:text-[0.68rem] tw:text-ink-550">
              Readiness last checked{" "}
              {new Date(readiness.lastCheckedAt).toLocaleString()}
            </p>
          ) : null}
          {report ? (
            <div className="tw:rounded-[6px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-3 tw:py-2">
              <strong className="tw:text-[0.74rem] tw:text-ink-150">
                Retained inactive report: {report.status}
              </strong>
              {report.candidateModelId ? (
                <p className="tw:mx-0 tw:mt-1 tw:mb-0 tw:text-[0.72rem] tw:text-ink-400">
                  Prospective candidate model: {report.candidateModelId}. It
                  remains inactive and requires separate manual enrollment.
                </p>
              ) : null}
              {report.selectedThreshold !== null ? (
                <p className="tw:mx-0 tw:mt-1 tw:mb-0 tw:text-[0.72rem] tw:text-ink-400">
                  Selected threshold: {report.selectedThreshold}
                </p>
              ) : null}
              {report.reasonCodes.length > 0 ? (
                <p className="tw:mx-0 tw:mt-1 tw:mb-0 tw:text-[0.72rem] tw:text-ink-400">
                  {report.reasonCodes.join(" · ")}
                </p>
              ) : null}
              {report.evaluation ? (
                <details className="tw:mt-2">
                  <summary className="tw:cursor-pointer tw:text-[0.7rem] tw:text-ink-350">
                    Evaluation details
                  </summary>
                  <pre className="tw:mt-2 tw:max-h-[240px] tw:overflow-auto tw:whitespace-pre-wrap tw:break-words tw:text-[0.66rem] tw:text-ink-400">
                    {JSON.stringify(report.evaluation, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}
