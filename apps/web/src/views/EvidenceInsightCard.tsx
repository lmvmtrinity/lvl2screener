import type { EvidenceAutomationStage } from "@tsx-scanner/contracts";
import { useEffect, useState } from "react";
import { getJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { Tip } from "../ui.js";
import { evidenceExplanation } from "../lib/evidence-explanations.js";

const labels: Record<EvidenceAutomationStage["state"], string> = {
  UNKNOWN: "UNKNOWN",
  WAITING: "WAITING FOR EVIDENCE",
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  NO_NEW_EVIDENCE: "NO NEW EVIDENCE",
  PAUSED: "PAUSED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  INTERRUPTED: "INTERRUPTED",
};

const CARD_CLASSES =
  "tw:flex tw:min-h-[155px] tw:flex-col tw:gap-[10px] tw:rounded-[7px] tw:border tw:bg-surface-raised tw:p-[14px]";
const CARD_BORDER_DEFAULT_CLASSES = "tw:border-line-subtle";
const CARD_STATE_CLASSES: Record<string, string> = {
  succeeded: "tw:border-[rgba(34,197,94,0.45)]",
  failed: "tw:border-[rgba(248,113,113,0.55)]",
  interrupted: "tw:border-[rgba(248,113,113,0.55)]",
};
const HEADING_CLASSES =
  "tw:flex tw:items-start tw:justify-between tw:gap-[8px]";
const LABEL_CLASSES =
  "tw:font-mono tw:text-[0.65rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-ink-500";
const HEADING_TITLE_CLASSES =
  "tw:mx-0 tw:mt-[5px] tw:mb-0 tw:text-[0.88rem] tw:font-bold tw:text-ink-100";
const HELP_BUTTON_CLASSES =
  "tw:h-[22px] tw:w-[22px] tw:cursor-help tw:rounded-full tw:border tw:border-line tw:bg-transparent tw:text-ink-300";
const REASON_CLASSES =
  "tw:m-0 tw:font-mono tw:text-[0.72rem] tw:font-normal tw:leading-[normal] tw:text-ink-300 tw:wrap-anywhere";
const PROGRESS_CLASSES =
  "tw:relative tw:h-[7px] tw:overflow-hidden tw:rounded-[3px] tw:bg-surface-sunken";
const PROGRESS_FILL_CLASSES = "tw:block tw:h-full tw:bg-accent";
const PROGRESS_LABEL_CLASSES = "tw:block tw:mt-[5px] tw:text-ink-400";
const META_CLASSES =
  "tw:mx-0 tw:mt-auto tw:mb-0 tw:grid tw:grid-cols-[1fr_1fr] tw:gap-[10px]";
const META_LABEL_CLASSES =
  "tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:uppercase tw:text-ink-500";
const META_VALUE_CLASSES =
  "tw:mx-0 tw:mt-[3px] tw:mb-0 tw:text-[0.72rem] tw:text-ink-300 tw:wrap-anywhere";
const CARD_BUTTON_CLASSES =
  "tw:mt-[4px] tw:cursor-pointer tw:rounded-[6px] tw:border tw:border-line-accent-mid tw:bg-surface-raised tw:px-[10px] tw:py-[8px] tw:font-mono tw:text-[0.6rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.05em] tw:text-accent tw:hover:bg-accent tw:hover:text-on-accent";
const ARTIFACT_CLASSES =
  "tw:col-span-full tw:max-h-[36rem] tw:overflow-auto tw:border tw:border-line tw:p-[1rem]";
const ARTIFACT_VALUE_CLASSES = "tw:ms-[1rem] tw:wrap-anywhere";

export function EvidenceInsightCard({
  stage,
}: {
  stage: EvidenceAutomationStage;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ url: string; value: unknown } | null>(
    null,
  );
  const [error, setError] = useState("");
  useEffect(() => {
    setOpened(null);
    setDetail(null);
    setError("");
  }, [stage.marketId, stage.scopeId]);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    setDetail(null);
    setError("");
    void getJson(opened, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDetail({ url: opened, value });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Retained details unavailable",
          );
      });
    return () => controller.abort();
  }, [opened]);
  const reportUrl = (id: string) =>
    `/api/learning/evidence-artifacts/${stage.key}/${encodeURIComponent(id)}?marketId=${stage.marketId}`;
  const openReport = (id: string) => setOpened(reportUrl(id));
  const time = (value: string | null) =>
    value ? new Date(value).toLocaleString() : "Unavailable";
  const meaning = stage.reasonCodes.includes("DATASET_DERIVATION_UNPROVEN")
    ? "The saved dataset does not retain proof of which raw inputs and feature version produced each row. Coverage of the same instrument and date cannot establish that connection. Qualification is unchanged."
    : stage.key === "COVERAGE"
      ? stage.state === "SUCCEEDED"
        ? evidenceExplanation("Verified coverage")
        : evidenceExplanation("Unknown coverage")
      : stage.state === "WAITING"
        ? evidenceExplanation("Waiting for evidence")
        : stage.state === "NO_NEW_EVIDENCE"
          ? evidenceExplanation("No new evidence")
          : "This operational state describes processing, not strategy quality or promotion eligibility.";
  return (
    <article
      className={classes(
        CARD_CLASSES,
        CARD_STATE_CLASSES[stage.state.toLowerCase()] ??
          CARD_BORDER_DEFAULT_CLASSES,
      )}
    >
      <div className={HEADING_CLASSES}>
        <div>
          <span className={LABEL_CLASSES}>
            {stage.key.replaceAll("_", " ")}
          </span>
          <h3 className={HEADING_TITLE_CLASSES}>{labels[stage.state]}</h3>
        </div>
        <Tip label={meaning} placement="top-end">
          <button
            type="button"
            className={HELP_BUTTON_CLASSES}
            aria-label={`Explain ${stage.key}`}
          >
            ?
          </button>
        </Tip>
      </div>
      <p className={REASON_CLASSES}>
        {stage.reasonCodes.join(" · ") || "No reason recorded"}
      </p>
      {stage.progress && (
        <div
          className={PROGRESS_CLASSES}
          aria-label={`${stage.progress.completed} of ${stage.progress.total} ${stage.progress.unit}`}
        >
          <span
            className={PROGRESS_FILL_CLASSES}
            style={{
              width: `${(stage.progress.completed / stage.progress.total) * 100}%`,
            }}
          />
          <small className={PROGRESS_LABEL_CLASSES}>
            {stage.progress.completed}/{stage.progress.total}{" "}
            {stage.progress.unit}
          </small>
        </div>
      )}
      <dl className={META_CLASSES}>
        <div>
          <dt className={META_LABEL_CLASSES}>Checked</dt>
          <dd className={META_VALUE_CLASSES}>
            {new Date(stage.asOf).toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className={META_LABEL_CLASSES}>Next</dt>
          <dd className={META_VALUE_CLASSES}>{stage.nextAction.label}</dd>
        </div>
        <div>
          <dt className={META_LABEL_CLASSES}>Scope</dt>
          <dd className={META_VALUE_CLASSES}>{stage.scopeId}</dd>
        </div>
        <div>
          <dt className={META_LABEL_CLASSES}>Last attempt</dt>
          <dd className={META_VALUE_CLASSES}>
            {stage.lastAttemptAt ? (
              <time dateTime={stage.lastAttemptAt}>
                {time(stage.lastAttemptAt)}
              </time>
            ) : (
              "Unavailable"
            )}
          </dd>
        </div>
        <div>
          <dt className={META_LABEL_CLASSES}>Last success</dt>
          <dd className={META_VALUE_CLASSES}>{time(stage.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt className={META_LABEL_CLASSES}>Next scheduled check</dt>
          <dd className={META_VALUE_CLASSES}>{time(stage.nextCheckAt)}</dd>
        </div>
      </dl>
      {stage.reportId && (
        <button
          type="button"
          className={CARD_BUTTON_CLASSES}
          onClick={() => openReport(stage.reportId!)}
        >
          Inspect saved {stage.key.toLowerCase().replaceAll("_", " ")} report
        </button>
      )}
      {stage.jobId && (
        <button
          type="button"
          className={CARD_BUTTON_CLASSES}
          onClick={() =>
            setOpened(
              `/api/research-jobs/${stage.jobId}?marketId=${stage.marketId}`,
            )
          }
        >
          Inspect worker job
        </button>
      )}
      {!!stage.relatedScopes?.length && (
        <details>
          <summary>
            Other retained scopes ({stage.relatedScopes.length})
          </summary>
          {stage.relatedScopes.map((scope, index) => (
            <section key={`${scope.scopeId}:${index}`}>
              <p>
                {scope.scopeId}: {scope.state} � {scope.reasonCodes.join(" � ")}
              </p>
              {scope.lastAttemptAt && (
                <small>
                  Attempted{" "}
                  <time dateTime={scope.lastAttemptAt}>
                    {time(scope.lastAttemptAt)}
                  </time>
                </small>
              )}
              {scope.progress && (
                <div
                  className={PROGRESS_CLASSES}
                  aria-label={`${scope.progress.completed} of ${scope.progress.total} ${scope.progress.unit}`}
                >
                  <span
                    className={PROGRESS_FILL_CLASSES}
                    style={{
                      width: `${(scope.progress.completed / scope.progress.total) * 100}%`,
                    }}
                  />
                  <small className={PROGRESS_LABEL_CLASSES}>
                    {scope.progress.completed}/{scope.progress.total}{" "}
                    {scope.progress.unit}
                  </small>
                </div>
              )}
              {scope.reportId && (
                <button
                  type="button"
                  className={CARD_BUTTON_CLASSES}
                  onClick={() => openReport(scope.reportId!)}
                >
                  Inspect saved report for {scope.scopeId}
                </button>
              )}
              {scope.jobId && (
                <button
                  type="button"
                  className={CARD_BUTTON_CLASSES}
                  onClick={() =>
                    setOpened(
                      `/api/research-jobs/${scope.jobId}?marketId=${stage.marketId}`,
                    )
                  }
                >
                  Inspect job for {scope.scopeId}
                </button>
              )}
            </section>
          ))}
        </details>
      )}
      {opened && (
        <section
          aria-label="Retained evidence details"
          className={ARTIFACT_CLASSES}
        >
          <button
            type="button"
            className={CARD_BUTTON_CLASSES}
            onClick={() => setOpened(null)}
          >
            Close details
          </button>
          <p>
            Retained evidence for {stage.marketId}. Unknown fields do not
            establish qualification or promotion.
          </p>
          {error ? (
            <p role="alert">{error}</p>
          ) : detail?.url === opened ? (
            <ArtifactValue value={detail.value} />
          ) : (
            <p role="status">Loading retained details�</p>
          )}
        </section>
      )}
    </article>
  );
}

function ArtifactValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Unavailable</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ol>
        {value.map((item, index) => (
          <li key={index}>
            <ArtifactValue value={item} />
          </li>
        ))}
      </ol>
    ) : (
      <span>No retained entries</span>
    );
  if (typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>
              {key.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2")}
            </dt>
            <dd className={ARTIFACT_VALUE_CLASSES}>
              {typeof item === "object" && item !== null ? (
                <details>
                  <summary>Inspect {key.replaceAll("_", " ")}</summary>
                  <ArtifactValue value={item} />
                </details>
              ) : (
                <ArtifactValue value={item} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <span>
      {typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}
    </span>
  );
}
