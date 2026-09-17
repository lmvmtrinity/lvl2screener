import {
  researchCoverageReportSchema,
  researchEvidenceBindingSchema,
  type MarketId,
  type ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import { useEffect, useState } from "react";
import { getJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { Tip } from "../ui.js";

const SUMMARY_CLASSES =
  "tw:flex tw:flex-col tw:gap-2 tw:rounded-[7px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[18px] tw:py-[14px]";
const SUMMARY_HEAD_CLASSES =
  "tw:flex tw:items-center tw:justify-between tw:gap-3";
const SUMMARY_TEXT_CLASSES = "tw:m-0 tw:text-[0.78rem] tw:text-ink-400";
const BADGE_BASE =
  "tw:inline-block tw:rounded-[4px] tw:px-2 tw:py-[2px] tw:text-[0.7rem] tw:font-semibold tw:tracking-[0.04em]";
const BADGE_TONE: Record<string, string> = {
  neutral:
    "tw:border tw:border-line-subtle tw:bg-surface-raised tw:text-ink-400",
  success:
    "tw:border tw:border-[rgba(34,197,94,0.3)] tw:bg-[rgba(34,197,94,0.15)] tw:text-[#4ade80]",
  warn: "tw:border tw:border-[rgba(245,158,11,0.3)] tw:bg-[rgba(245,158,11,0.15)] tw:text-accent",
  danger:
    "tw:border tw:border-[rgba(248,113,113,0.3)] tw:bg-[rgba(248,113,113,0.15)] tw:text-danger",
};

export function EvidenceSummary({
  marketId,
  binding,
  opportunities,
}: {
  marketId: MarketId;
  binding: ResearchEvidenceBinding | null | undefined;
  opportunities?: number;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | {
        kind: "ready";
        report: ReturnType<typeof researchCoverageReportSchema.parse>;
      }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    if (!binding) {
      setState({ kind: "idle" });
      return;
    }
    const parsed = researchEvidenceBindingSchema.safeParse(binding);
    if (!parsed.success) {
      setState({ kind: "error", message: "Evidence binding is invalid." });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    void getJson(
      `/api/research-evidence/${parsed.data.coverageReportHash}?marketId=${marketId}`,
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "ready",
          report: researchCoverageReportSchema.parse(value),
        });
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message:
            reason instanceof Error
              ? reason.message
              : "Unable to load coverage",
        });
      });
    return () => controller.abort();
  }, [binding, marketId]);

  if (!binding)
    return (
      <section className={SUMMARY_CLASSES} aria-label="Research evidence">
        <div className={SUMMARY_HEAD_CLASSES}>
          <Tip label="Legacy results do not have a content-verified retained-input binding.">
            <strong>Unverified coverage</strong>
          </Tip>
          <span className={classes(BADGE_BASE, BADGE_TONE.neutral)}>
            NO BINDING
          </span>
        </div>
        <p className={SUMMARY_TEXT_CLASSES}>
          Historical provenance is unavailable; no coverage report was
          requested.
        </p>
      </section>
    );

  if (state.kind === "loading")
    return (
      <section className={SUMMARY_CLASSES}>
        <strong>Loading retained coverage…</strong>
      </section>
    );
  if (state.kind === "error")
    return (
      <section className={SUMMARY_CLASSES} aria-label="Research evidence">
        <div className={SUMMARY_HEAD_CLASSES}>
          <strong>Coverage unavailable</strong>
          <span className={classes(BADGE_BASE, BADGE_TONE.danger)}>ERROR</span>
        </div>
        <p className={SUMMARY_TEXT_CLASSES}>{state.message}</p>
      </section>
    );
  if (state.kind === "idle") return null;

  const report = state.report;
  const required = report.cells.filter(
    (cell) => cell.status !== "NOT_REQUIRED",
  );
  const covered = required.filter((cell) => cell.status === "VERIFIED").length;
  const reasons = [...new Set(report.cells.flatMap((cell) => cell.reasons))];
  const verified = report.status === "VERIFIED";
  const statusLabel = verified
    ? "Coverage verified"
    : report.status === "UNKNOWN"
      ? "Coverage unknown"
      : "Coverage incomplete";
  return (
    <section className={SUMMARY_CLASSES} aria-label="Research evidence">
      <div className={SUMMARY_HEAD_CLASSES}>
        <Tip label="Required members, sessions and benchmarks passed the declared input checks. This does not prove the strategy is profitable.">
          <strong>{statusLabel}</strong>
        </Tip>
        <span
          className={classes(
            BADGE_BASE,
            verified ? BADGE_TONE.success : BADGE_TONE.warn,
          )}
        >
          {report.status}
        </span>
      </div>
      <p className={SUMMARY_TEXT_CLASSES}>
        As of {new Date(report.verifiedAt).toLocaleString()} · {covered} of{" "}
        {required.length} required cells covered
      </p>
      {verified && opportunities === 0 && (
        <p className="tw:m-0 tw:text-[0.78rem] tw:font-semibold tw:text-ink-200">
          0 eligible opportunities
        </p>
      )}
      {reasons.length > 0 && (
        <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-[6px] tw:text-[0.78rem] tw:text-ink-400">
          <span>Recorded reasons:</span>
          {reasons.map((reason) => (
            <code
              className="tw:font-mono tw:text-[0.68rem] tw:text-accent"
              key={reason}
            >
              {reason}
            </code>
          ))}
        </div>
      )}
      <small className={SUMMARY_TEXT_CLASSES}>
        Coverage verifies retained inputs, not strategy quality or broker fills.
      </small>
    </section>
  );
}
