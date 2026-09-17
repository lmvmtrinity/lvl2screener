import { classes } from "../lib/classes.js";
import { ago, agoFromMs, countdown } from "../lib/format.js";
import { useNow } from "../lib/use-now.js";
import type { PaperBotStatus } from "../types.js";
import { Tip } from "../ui.js";

const LIVENESS_METRIC =
  "bot-liveness-metric tw:grid tw:cursor-help tw:gap-[5px] tw:bg-surface tw:px-4 tw:py-[13px]";
const LIVENESS_ITEM =
  "bot-liveness-item tw:grid tw:gap-[5px] tw:bg-surface tw:px-4 tw:py-3";
const LIVENESS_LABEL =
  "tw:font-mono tw:text-[0.57rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.07em] tw:text-ink-700";
const LIVENESS_DETAIL = "tw:text-[0.64rem] tw:text-ink-650";
const LIVENESS_VALUE = "tw:text-[1.02rem] tw:tabular-nums";
const LIVENESS_VALUE_TONES = {
  neutral: "tw:text-ink-150",
  ok: "tw:text-accent",
  attention: "tw:text-warn",
  error: "tw:text-danger",
} as const;

function Metric({
  label,
  value,
  detail,
  tip,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tip: string;
  tone?: "ok" | "attention" | "error";
}) {
  return (
    <Tip label={tip}>
      <span className={LIVENESS_METRIC}>
        <b className={LIVENESS_LABEL}>{label}</b>
        <strong
          className={classes(
            LIVENESS_VALUE,
            LIVENESS_VALUE_TONES[tone ?? "neutral"],
          )}
        >
          {value}
        </strong>
        {detail ? <small className={LIVENESS_DETAIL}>{detail}</small> : null}
      </span>
    </Tip>
  );
}

/**
 * Compact default summary: current state, last successful processing and
 * unresolved work. Cycle timings, queue ages, account-wide counters and run
 * identifiers live in BotLivenessDiagnostics so the Overview reaches "what is
 * happening now" before raw telemetry. Failures stay visible here.
 */
export function BotLivenessPanel({ paperBot }: { paperBot?: PaperBotStatus }) {
  const now = useNow();
  const funded = paperBot?.funded;
  const closeLabel = countdown(now, paperBot?.scheduledCloseAt);
  const pendingFacts = funded?.pendingFacts ?? 0;
  const closePending = funded?.closePendingOrders ?? 0;
  const stuckEvents = paperBot?.unreconcilableEvents ?? 0;
  const overdueRuns = paperBot?.overdueRuns ?? 0;
  const coordinatedPositions = paperBot?.unresolvedCoordinatedPositions ?? 0;
  const recoveryFailures = funded?.recoveryFailuresTotal ?? 0;
  // Events, facts, orders and runs can overlap. The reconciliation candidate
  // count describes the last batch before processing, not remaining work.
  const hasUnresolved = [
    pendingFacts,
    closePending,
    stuckEvents,
    overdueRuns,
    coordinatedPositions,
  ].some((count) => count > 0);

  return (
    <section
      className="panel bot-liveness tw:mt-[18px] tw:mb-4"
      aria-label="Bot liveness"
    >
      <div className="panel-title">
        <div>
          <h3>Automation liveness</h3>
          <p>Timings, counters and identifiers are in Diagnostics.</p>
        </div>
        <span>
          {closeLabel
            ? `SESSION CLOSES ${closeLabel.toUpperCase()}`
            : "NO OPEN RUN"}
        </span>
      </div>
      {paperBot?.lastError ? (
        <p className="bot-liveness-error tw:m-0 tw:border-b tw:border-b-line-subtle tw:bg-surface-danger tw:px-5 tw:py-[11px] tw:text-[0.74rem] tw:text-danger-tint-pale">
          Last processing error (independent or funded) · {paperBot.lastError}
        </p>
      ) : null}
      <div className="bot-liveness-summary tw:grid tw:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] tw:gap-px tw:border-t tw:border-t-line tw:bg-line-subtle">
        <div className={classes(LIVENESS_ITEM, "ok")}>
          <b className={LIVENESS_LABEL}>LAST SUCCESSFUL PROCESSING</b>
          <strong className={classes(LIVENESS_VALUE, LIVENESS_VALUE_TONES.ok)}>
            {ago(now, paperBot?.lastSuccessfulProcessingAt)}
          </strong>
          <small className={LIVENESS_DETAIL}>
            Funded cycle {ago(now, paperBot?.fundedLastSuccessfulProcessingAt)}
          </small>
        </div>
        <div
          className={classes(LIVENESS_ITEM, hasUnresolved ? "attention" : "ok")}
        >
          <b className={LIVENESS_LABEL}>UNRESOLVED WORK</b>
          <strong
            className={classes(
              LIVENESS_VALUE,
              hasUnresolved
                ? LIVENESS_VALUE_TONES.attention
                : LIVENESS_VALUE_TONES.ok,
            )}
          >
            {!paperBot
              ? "Status unavailable"
              : hasUnresolved
                ? "Work pending"
                : "No reported backlog"}
          </strong>
          <small className={LIVENESS_DETAIL}>
            {pendingFacts} pending fact{pendingFacts === 1 ? "" : "s"} ·{" "}
            {closePending} close-pending order{closePending === 1 ? "" : "s"}
          </small>
          <small className={LIVENESS_DETAIL}>
            {stuckEvents} stuck event{stuckEvents === 1 ? "" : "s"} ·{" "}
            {overdueRuns} overdue run{overdueRuns === 1 ? "" : "s"}
          </small>
          {coordinatedPositions > 0 && (
            <small className={LIVENESS_DETAIL}>
              {coordinatedPositions} unresolved coordinated position
              {coordinatedPositions === 1 ? "" : "s"}
            </small>
          )}
        </div>
        {recoveryFailures > 0 ? (
          <div className={classes(LIVENESS_ITEM, "error")}>
            <b className={LIVENESS_LABEL}>FUNDED FAILURES</b>
            <strong
              className={classes(LIVENESS_VALUE, LIVENESS_VALUE_TONES.error)}
            >
              {recoveryFailures}
            </strong>
            <small className={LIVENESS_DETAIL}>
              Account-wide; retried automatically
            </small>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Diagnostics detail for the same polled snapshot. Legacy-run counters and
 * account-wide funded counters stay labelled separately so "the current run is
 * fine" can never hide an older backlog.
 */
export function BotLivenessDiagnostics({
  paperBot,
}: {
  paperBot?: PaperBotStatus;
}) {
  const now = useNow();
  const funded = paperBot?.funded;
  const pendingFacts = funded?.pendingFacts ?? 0;
  const closePending = funded?.closePendingOrders ?? 0;
  const recoveryFailures = funded?.recoveryFailuresTotal ?? 0;

  return (
    <section
      className="panel bot-liveness-diagnostics tw:mt-[18px] tw:mb-4"
      aria-label="Bot liveness diagnostics"
    >
      <div className="panel-title">
        <div>
          <h3>Automation liveness detail</h3>
          <p>
            Cycle timings, queue ages and the current run identity from the same
            polled snapshot. Funded counters are account-wide across every run,
            not only the current one.
          </p>
        </div>
      </div>
      {paperBot?.lastError ? (
        <p className="bot-liveness-error tw:m-0 tw:border-b tw:border-b-line-subtle tw:bg-surface-danger tw:px-5 tw:py-[11px] tw:text-[0.74rem] tw:text-danger-tint-pale">
          Last processing error (independent or funded) · {paperBot.lastError}
        </p>
      ) : null}
      <div className="bot-liveness-metrics tw:grid tw:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] tw:gap-px tw:border-t tw:border-t-line tw:bg-line-subtle">
        <Metric
          label="LAST PAPER CYCLE"
          value={ago(now, paperBot?.lastSuccessfulProcessingAt)}
          detail={
            paperBot?.lastProcessingDurationMs === null ||
            paperBot?.lastProcessingDurationMs === undefined
              ? undefined
              : `took ${Math.round(paperBot.lastProcessingDurationMs)} ms`
          }
          tone={
            paperBot?.lastSuccessfulProcessingAt === null ? "attention" : "ok"
          }
          tip="When the last live paper-processing cycle completed successfully. This updates every market cycle, not only when the screen refreshes."
        />
        <Metric
          label="LAST FUNDED CYCLE"
          value={ago(now, paperBot?.fundedLastSuccessfulProcessingAt)}
          detail={
            funded?.lastCycleLatencyMs === null ||
            funded?.lastCycleLatencyMs === undefined
              ? undefined
              : `took ${Math.round(funded.lastCycleLatencyMs)} ms`
          }
          tip="When the funded fact-processing cycle last completed successfully. The funded queue is account-wide across runs."
        />
        <Metric
          label="PENDING FACTS"
          value={String(pendingFacts)}
          detail={
            funded?.oldestPendingFactAgeMs === null ||
            funded?.oldestPendingFactAgeMs === undefined
              ? undefined
              : `oldest ${agoFromMs(funded.oldestPendingFactAgeMs)}`
          }
          tone={pendingFacts > 0 ? "attention" : "ok"}
          tip="Funded facts accepted but waiting to be applied. They drain automatically through the funded session driver."
        />
        <Metric
          label="CLOSE-PENDING ORDERS"
          value={String(closePending)}
          detail={
            funded?.oldestClosePendingAgeMs === null ||
            funded?.oldestClosePendingAgeMs === undefined
              ? undefined
              : `oldest ${agoFromMs(funded.oldestClosePendingAgeMs)}`
          }
          tone={closePending > 0 ? "attention" : "ok"}
          tip="Close requested. Waiting for eligible quotes and sufficient liquidity; recovery continues automatically."
        />
        <Metric
          label="LAST RECONCILIATION BATCH"
          value={String(paperBot?.reconciliationBacklog ?? "—")}
          detail={`${paperBot?.unreconcilableEvents ?? 0} stuck event(s) · ${paperBot?.overdueRuns ?? 0} run(s) past close`}
          tone={
            (paperBot?.overdueRuns ?? 0) > 0 ||
            (paperBot?.unreconcilableEvents ?? 0) > 0
              ? "attention"
              : "ok"
          }
          tip="Candidate events in the last reconciliation batch before processing. This includes repaired events; stuck events and overdue runs are reported separately and are not added together."
        />
        <Metric
          label="FUNDED FAILURES"
          value={String(recoveryFailures)}
          detail={
            funded
              ? `${funded.coverageGapsTotal ?? 0} coverage gap(s) · ${funded.riskVetoesTotal ?? 0} risk veto(s)`
              : undefined
          }
          tone={recoveryFailures > 0 ? "error" : "ok"}
          tip="Failed funded recovery attempts plus cumulative coverage gaps and risk vetoes. Failures retry; vetoes are recorded decisions, not errors."
        />
      </div>
      {paperBot?.runId ? (
        <p className="bot-liveness-run tw:m-0 tw:border-t tw:border-t-line-subtle tw:px-5 tw:py-[10px] tw:font-mono tw:text-[0.6rem] tw:font-[650] tw:leading-[normal] tw:tracking-[0.05em] tw:text-ink-650">
          RUN {paperBot.runId} · SESSION {paperBot.sessionDate ?? "—"} · MODEL{" "}
          {paperBot.executionModelVersion ?? "—"}
        </p>
      ) : null}
    </section>
  );
}
