import {
  strategyLearningReadinessSchema,
  strategyLearningScopeSchema,
  type StrategyLearningScope,
} from "@tsx-scanner/contracts";
import { useEffect, useState } from "react";
import { ApiRequestError, getJson } from "../lib/api.js";

function readinessUrl(scope: StrategyLearningScope): string {
  const query = new URLSearchParams({
    marketId: scope.marketId,
    strategyKey: scope.strategyKey,
    profileConfigId: scope.profileConfigId,
    strategyVersion: scope.strategyVersion,
    configVersion: scope.configVersion,
    executionModelVersion: scope.executionModelVersion,
    executionAssumptions: JSON.stringify(scope.executionAssumptions),
  });
  return `/api/learning/strategy-readiness?${query.toString()}`;
}

function backtestReadinessUrl(run: {
  runId: string;
  strategyKey: string;
  marketId: string;
}): string {
  const query = new URLSearchParams({
    strategyKey: run.strategyKey,
    marketId: run.marketId,
  });
  return `/api/learning/backtest-runs/${encodeURIComponent(run.runId)}/strategy-readiness?${query.toString()}`;
}

function recordEntries(value: Record<string, number>) {
  return Object.entries(value).filter(([, count]) => count > 0);
}

export function StrategyLearningReadinessPanel({
  scope: rawScope,
  runContext,
}: {
  scope: StrategyLearningScope | null;
  runContext?: {
    runId: string;
    marketId: string;
    status: string;
    strategies: string[];
  };
}) {
  const [result, setResult] = useState<ReturnType<
    typeof strategyLearningReadinessSchema.parse
  > | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [strategyKey, setStrategyKey] = useState(
    runContext?.strategies[0] ?? "",
  );
  const parsedScope = rawScope
    ? strategyLearningScopeSchema.safeParse(rawScope)
    : null;
  const scope = parsedScope?.success ? parsedScope.data : null;
  const selectedStrategyKey = runContext?.strategies.includes(strategyKey)
    ? strategyKey
    : (runContext?.strategies[0] ?? "");
  const selectedRun =
    runContext?.status === "COMPLETED" && selectedStrategyKey
      ? {
          runId: runContext.runId,
          marketId: runContext.marketId,
          strategyKey: selectedStrategyKey,
        }
      : null;
  const scopeKey = scope
    ? JSON.stringify(scope)
    : selectedRun
      ? JSON.stringify(selectedRun)
      : "unavailable";

  useEffect(() => {
    setResult(null);
    setError(null);
    if (!scope && !selectedRun) return;
    const controller = new AbortController();
    void getJson(
      scope ? readinessUrl(scope) : backtestReadinessUrl(selectedRun!),
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setResult(strategyLearningReadinessSchema.parse(value));
          setResultKey(scopeKey);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof ApiRequestError && reason.code
              ? `${reason.code}: ${reason.message}`
              : reason instanceof Error
                ? reason.message
                : "Unable to load strategy readiness.",
          );
          setErrorKey(scopeKey);
        }
      });
    return () => controller.abort();
  }, [scopeKey]);

  const unavailable = !scope && !selectedRun;
  const visibleResult = resultKey === scopeKey ? result : null;
  const visibleError = errorKey === scopeKey ? error : null;
  const scopeUnavailable =
    visibleError?.includes("BACKTEST_SCOPE_") ||
    visibleError?.includes("BACKTEST_MARKET_MISMATCH");

  return (
    <section
      className="tw:grid tw:gap-3 tw:px-[18px] tw:py-4 tw:text-[0.8rem] tw:text-ink-250"
      aria-label="Strategy learning readiness"
      aria-live="polite"
    >
      {runContext && runContext.strategies.length > 1 ? (
        <label className="tw:grid tw:max-w-[360px] tw:gap-1">
          Strategy for this readiness report
          <select
            value={selectedStrategyKey}
            onChange={(event) => setStrategyKey(event.target.value)}
            className="tw:rounded tw:border tw:border-line-input tw:bg-surface tw:px-2 tw:py-1 tw:text-ink-100"
          >
            {runContext.strategies.map((strategy) => (
              <option key={strategy} value={strategy}>
                {strategy}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {unavailable ? (
        <>
          <h3 className="tw:m-0 tw:text-[0.92rem] tw:font-semibold tw:text-ink-100">
            Readiness unavailable for this run
          </h3>
          <p className="tw:m-0">
            {runContext && runContext.status !== "COMPLETED"
              ? "Readiness requires a completed backtest run."
              : runContext?.strategies.length === 0
                ? "This run has no retained strategy identity."
                : "No complete exact profile configuration and execution scope is available. No estimate or sample count is inferred."}
          </p>
        </>
      ) : scopeUnavailable ? (
        <>
          <h3 className="tw:m-0 tw:text-[0.92rem] tw:font-semibold tw:text-ink-100">
            Readiness unavailable for this run
          </h3>
          <p className="tw:m-0">{visibleError}</p>
        </>
      ) : visibleError ? (
        <p role="alert" className="tw:m-0">
          {visibleError}
        </p>
      ) : !visibleResult ? (
        <p role="status" className="tw:m-0">
          Loading scoped readiness…
        </p>
      ) : (
        <>
          <h3 className="tw:m-0 tw:text-[0.92rem] tw:font-semibold tw:text-ink-100">
            Accumulated backtest sample readiness ·{" "}
            {visibleResult.state.replaceAll("_", " ")}
          </h3>
          <p className="tw:m-0">
            The selected run anchors the exact market, strategy, profile,
            version, and execution scope. Counts accumulate across compatible
            retained runs in that scope.
          </p>
          <p
            className="tw:m-0"
            title="Raw distinct retained closed outcomes across compatible runs toward the sample threshold; replaying an outcome does not add a trade."
          >
            {visibleResult.distinctClosedTrades} /{" "}
            {visibleResult.targetDistinctTrades} raw distinct closed outcomes
            across compatible runs
          </p>
          <dl className="tw:grid tw:grid-cols-[max-content_1fr] tw:gap-x-3 tw:gap-y-1">
            <dt>Verified sessions</dt>
            <dd className="tw:m-0">{visibleResult.verifiedSessions}</dd>
            <dt>Usable model rows</dt>
            <dd className="tw:m-0">{visibleResult.usableModelRows}</dd>
            <dt>Evidence-qualified distinct outcomes</dt>
            <dd className="tw:m-0">
              {visibleResult.qualificationCounts.EVIDENCE_QUALIFIED}
            </dd>
            <dt>Exploratory distinct outcomes</dt>
            <dd className="tw:m-0">
              {visibleResult.qualificationCounts.EXPLORATORY}
            </dd>
            <dt>Raw sample shortfall</dt>
            <dd className="tw:m-0">{visibleResult.shortfall}</dd>
          </dl>
          <p className="tw:m-0">
            Exploratory outcomes count toward raw sample availability for
            assessment; they remain exploratory and are not evidence-qualified.
            Reaching this threshold does not qualify the evidence or establish
            strategy quality.
          </p>
          <ReadinessBreakdown
            title="Exclusions"
            values={visibleResult.exclusions}
          />
          <ReadinessBreakdown
            title="Time slices"
            values={visibleResult.strata.time}
          />
          <ReadinessBreakdown
            title="ATR slices"
            values={visibleResult.strata.atr}
          />
          <ReadinessBreakdown
            title="RVOL slices"
            values={visibleResult.strata.rvol}
          />
          <div>
            <strong>Blockers</strong>
            {visibleResult.blockers.length ? (
              <ul>
                {visibleResult.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : (
              <p className="tw:m-0">None reported.</p>
            )}
          </div>
          <p className="tw:m-0">
            {visibleResult.feasibility.state === "UNAVAILABLE"
              ? "Feasibility unavailable: the report lacks predeclared minimum effect, outcome variance, significance level, target power, and comparison design."
              : "Feasibility estimate available."}
          </p>
          <p className="tw:m-0">
            {visibleResult.collectionEstimate.state === "UNAVAILABLE"
              ? `Collection estimate unavailable: ${visibleResult.collectionEstimate.reason === "ZERO_OUTCOME_SESSION" ? "at least one verified session had zero new closed outcomes." : "no verified sessions are available."}`
              : `Observed rate: ${visibleResult.collectionEstimate.observedRateMin}–${visibleResult.collectionEstimate.observedRateMax} new outcomes per session across ${visibleResult.collectionEstimate.observedSessions} recent verified sessions. Remaining-sample estimate: ${visibleResult.collectionEstimate.minSessions}–${visibleResult.collectionEstimate.maxSessions} sessions.`}
          </p>
          <p className="tw:m-0 tw:text-[0.72rem] tw:text-ink-400">
            Raw distinct outcomes accumulate across compatible runs and count
            each retained outcome once across replays. Usable model rows require
            valid evidence labels. Feasibility needs a predeclared minimum
            useful effect; collection ranges use observed collection rates and
            are not dates or promises.
          </p>
        </>
      )}
    </section>
  );
}

function ReadinessBreakdown({
  title,
  values,
}: {
  title: string;
  values: Record<string, number>;
}) {
  const entries = recordEntries(values);
  return (
    <div>
      <strong>{title}</strong>
      {entries.length ? (
        <ul>
          {entries.map(([name, count]) => (
            <li key={name}>
              {name}: {count}
            </li>
          ))}
        </ul>
      ) : (
        <p className="tw:m-0">None reported.</p>
      )}
    </div>
  );
}
