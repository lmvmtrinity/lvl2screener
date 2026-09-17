import {
  evidenceAutomationResponseSchema,
  type EvidenceAutomationStage,
} from "@tsx-scanner/contracts";
import { EvidenceInsightCard } from "./EvidenceInsightCard.js";
import { Tip } from "../ui.js";

const SECTION_CLASSES =
  "tw:flex tw:flex-col tw:gap-[16px] tw:rounded-[8px] tw:border tw:border-line tw:bg-surface tw:px-[24px] tw:py-[20px]";
const HEADER_CLASSES =
  "tw:flex tw:items-center tw:justify-between tw:border-b tw:border-b-line-subtle tw:pb-[12px]";
const HEADING_CLASSES =
  "tw:m-0 tw:text-[1.05rem] tw:font-semibold tw:text-ink-100";
const TAG_CLASSES =
  "tw:font-mono tw:text-[0.65rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-accent";
const DESCRIPTION_CLASSES =
  "tw:mx-0 tw:mt-[4px] tw:mb-0 tw:text-[0.8rem] tw:text-ink-400";
const SUMMARY_CLASSES =
  "tw:m-0 tw:grid tw:grid-cols-[repeat(auto-fit,minmax(110px,1fr))] tw:gap-[8px]";
const SUMMARY_ITEM_CLASSES =
  "tw:rounded-[6px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:px-[10px] tw:py-[8px]";
const SUMMARY_LABEL_CLASSES =
  "tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[normal] tw:uppercase tw:text-ink-500";
const SUMMARY_VALUE_CLASSES =
  "tw:mx-0 tw:mt-[3px] tw:mb-0 tw:font-bold tw:text-ink-100";
const GRID_CLASSES =
  "tw:grid tw:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] tw:gap-[12px]";

export function EvidenceAutomationPanel({
  stages,
  marketId,
  error,
}: {
  stages: EvidenceAutomationStage[];
  marketId: string;
  error?: string | null;
}) {
  const parsed = evidenceAutomationResponseSchema.safeParse({ stages });
  const counts = parsed.success
    ? parsed.data.stages.reduce(
        (summary, stage) => {
          if (["WAITING", "QUEUED", "RUNNING"].includes(stage.state))
            summary.pending += 1;
          if (stage.reasonCodes.some((reason) => /MISSED/i.test(reason)))
            summary.missed += 1;
          if (["FAILED", "INTERRUPTED", "CANCELLED"].includes(stage.state))
            summary.failed += 1;
          if (stage.state === "PAUSED") summary.paused += 1;
          if (stage.state === "UNKNOWN") summary.unknown += 1;
          if (!summary.freshest || stage.asOf > summary.freshest)
            summary.freshest = stage.asOf;
          return summary;
        },
        {
          pending: 0,
          missed: 0,
          failed: 0,
          paused: 0,
          unknown: 0,
          freshest: null as string | null,
        },
      )
    : null;
  return (
    <section className={SECTION_CLASSES}>
      <div className={HEADER_CLASSES}>
        <div>
          <h2 className={HEADING_CLASSES}>Evidence and automation</h2>
          <p className={DESCRIPTION_CLASSES}>
            {marketId} · operational evidence states, not a profitability score
          </p>
        </div>
        <span className={TAG_CLASSES}>REVIEWABLE</span>
      </div>
      {error && <p className="error-banner">{error}</p>}
      {counts && (
        <dl className={SUMMARY_CLASSES} aria-label="Evidence feedback counts">
          <Tip label="Stages currently waiting for a prerequisite or durable worker completion.">
            <div className={SUMMARY_ITEM_CLASSES}>
              <dt className={SUMMARY_LABEL_CLASSES}>Pending stages</dt>
              <dd className={SUMMARY_VALUE_CLASSES}>{counts.pending}</dd>
            </div>
          </Tip>
          <Tip label="Explicit missed-deadline evidence only. Unknown timing is not classified as missed.">
            <div className={SUMMARY_ITEM_CLASSES}>
              <dt className={SUMMARY_LABEL_CLASSES}>Missed</dt>
              <dd className={SUMMARY_VALUE_CLASSES}>{counts.missed}</dd>
            </div>
          </Tip>
          <Tip label="Durable failed, interrupted or cancelled work that needs review.">
            <div className={SUMMARY_ITEM_CLASSES}>
              <dt className={SUMMARY_LABEL_CLASSES}>Failed</dt>
              <dd className={SUMMARY_VALUE_CLASSES}>{counts.failed}</dd>
            </div>
          </Tip>
          <Tip label="Paused processes. Paused is an explicit operator state, not a failure.">
            <div className={SUMMARY_ITEM_CLASSES}>
              <dt className={SUMMARY_LABEL_CLASSES}>Paused</dt>
              <dd className={SUMMARY_VALUE_CLASSES}>{counts.paused}</dd>
            </div>
          </Tip>
          <Tip label="No durable evidence or an unproved provenance boundary; unknown is never treated as success.">
            <div className={SUMMARY_ITEM_CLASSES}>
              <dt className={SUMMARY_LABEL_CLASSES}>Unknown</dt>
              <dd className={SUMMARY_VALUE_CLASSES}>{counts.unknown}</dd>
            </div>
          </Tip>
          <Tip label="When this status report was generated. This is read-model generation time, not the age of the underlying evidence; use each process card's last-success time for evidence freshness.">
            <div className={SUMMARY_ITEM_CLASSES}>
              <dt className={SUMMARY_LABEL_CLASSES}>Status generated</dt>
              <dd className={SUMMARY_VALUE_CLASSES}>
                {counts.freshest
                  ? new Date(counts.freshest).toLocaleString()
                  : "Unavailable"}
              </dd>
            </div>
          </Tip>
        </dl>
      )}
      {!parsed.success ? (
        <p className="empty">Evidence status could not be validated.</p>
      ) : (
        <div className={GRID_CLASSES}>
          {parsed.data.stages.map((stage) => (
            <EvidenceInsightCard key={stage.key} stage={stage} />
          ))}
        </div>
      )}
    </section>
  );
}
