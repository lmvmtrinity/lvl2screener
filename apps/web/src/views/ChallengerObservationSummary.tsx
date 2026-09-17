import type { ChallengerObservationReport } from "@tsx-scanner/contracts";
import { Tip } from "../ui.js";

const SUMMARY_CLASSES =
  "tw:mt-[1rem] tw:rounded-panel tw:border tw:border-line tw:p-[1rem]";
const HEADER_CLASSES =
  "tw:flex tw:items-center tw:justify-between tw:border-b tw:border-b-line-subtle tw:pb-[12px]";
const TAG_CLASSES =
  "tw:font-mono tw:text-[0.65rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.08em] tw:text-accent";
const GRID_CLASSES =
  "tw:mx-0 tw:my-[1rem] tw:grid tw:grid-cols-[minmax(12rem,1fr)_auto] tw:gap-[0.45rem_1rem]";
const GRID_LABEL_CLASSES = "tw:text-ink-550";
const GRID_VALUE_CLASSES = "tw:m-0 tw:text-right tw:tabular-nums";

export function ChallengerObservationSummary({
  report,
}: {
  report: ChallengerObservationReport;
}) {
  const p = report.population;
  return (
    <section
      aria-label="Inactive challenger observations"
      className={SUMMARY_CLASSES}
    >
      <div className={HEADER_CLASSES}>
        <h3>Prospective observation evidence</h3>
        <span className={TAG_CLASSES}>OBSERVATION ONLY</span>
      </div>
      <p>
        Fresh as of {new Date(report.asOf).toLocaleString()}. Model activation
        requires a separate manual decision.
      </p>
      <dl className={GRID_CLASSES}>
        <dt className={GRID_LABEL_CLASSES}>
          <Tip label="Eligible observations enrolled in this frozen experiment, including every terminal failure and pending attempt.">
            <span>Eligible observations</span>
          </Tip>
        </dt>
        <dd className={GRID_VALUE_CLASSES}>{p.expectedEligibleObservations}</dd>
        <dt className={GRID_LABEL_CLASSES}>
          <Tip label="The frozen model prediction was recorded before the original observation deadline.">
            <span>Timely predictions</span>
          </Tip>
        </dt>
        <dd className={GRID_VALUE_CLASSES}>{p.predicted}</dd>
        <dt className={GRID_LABEL_CLASSES}>
          <Tip label="An attempt captured within the frozen observation interval whose original deadline has not passed or whose terminal result is still being durably recorded.">
            <span>Pending</span>
          </Tip>
        </dt>
        <dd className={GRID_VALUE_CLASSES}>{p.pending}</dd>
        <dt className={GRID_LABEL_CLASSES}>
          <Tip label="No valid prediction was recorded before the original deadline. A later retry cannot repair this prospective result.">
            <span>Missed deadline</span>
          </Tip>
        </dt>
        <dd className={GRID_VALUE_CLASSES}>{p.missedDeadline}</dd>
        <dt className={GRID_LABEL_CLASSES}>
          <Tip label="The challenger engine failed before the immutable deadline; this failure remains in the denominator and is not retried as a new observation.">
            <span>Engine failures</span>
          </Tip>
        </dt>
        <dd className={GRID_VALUE_CLASSES}>{p.engineFailed}</dd>
        <dt className={GRID_LABEL_CLASSES}>Invalid input</dt>
        <dd className={GRID_VALUE_CLASSES}>{p.inputInvalid}</dd>
        <dt className={GRID_LABEL_CLASSES}>Revoked</dt>
        <dd className={GRID_VALUE_CLASSES}>{p.revoked}</dd>
        <dt className={GRID_LABEL_CLASSES}>
          <Tip label="A capture gap whose timing or interval provenance is insufficient. It is not reconstructed as a prediction.">
            <span>Capture unknown</span>
          </Tip>
        </dt>
        <dd className={GRID_VALUE_CLASSES}>{p.unknownCapture}</dd>
        <dt className={GRID_LABEL_CLASSES}>Closed quote outcomes</dt>
        <dd className={GRID_VALUE_CLASSES}>{report.closedQuoteOutcomes}</dd>
        <dt className={GRID_LABEL_CLASSES}>
          <Tip label="Average squared probability error on timely predictions with closed simulated QUOTE outcomes. Lower is better; this is not a return or account balance.">
            <span>Brier score</span>
          </Tip>
        </dt>
        <dd className={GRID_VALUE_CLASSES}>
          {report.prospectiveBrierScore?.toFixed(4) ?? "Unavailable"}
        </dd>
        <dt className={GRID_LABEL_CLASSES}>Verified sessions</dt>
        <dd className={GRID_VALUE_CLASSES}>
          {report.verifiedSessions ?? "Unavailable"}
        </dd>
        <dt className={GRID_LABEL_CLASSES}>Incomplete sessions</dt>
        <dd className={GRID_VALUE_CLASSES}>
          {report.incompleteSessions ?? "Unavailable"}
        </dd>
        <dt className={GRID_LABEL_CLASSES}>Unknown sessions</dt>
        <dd className={GRID_VALUE_CLASSES}>
          {report.unknownSessions ?? "Unavailable"}
        </dd>
        <dt className={GRID_LABEL_CLASSES}>Covered no-opportunity sessions</dt>
        <dd className={GRID_VALUE_CLASSES}>
          {report.coveredNoOpportunitySessions ?? "Unavailable"}
        </dd>
        <dt className={GRID_LABEL_CLASSES}>Paused-session exclusions</dt>
        <dd className={GRID_VALUE_CLASSES}>
          {report.excludedPausedSessions ?? "Unavailable"}
        </dd>
      </dl>
      {report.sessionCountsAvailable === false && (
        <p>
          Session counts are unavailable:{" "}
          {report.sessionCountsUnavailableReason}. A declared date list does not
          prove market-calendar or collection coverage.
        </p>
      )}
      {report.frozenAcceptance && (
        <section aria-label="Frozen acceptance criteria">
          <h4>Frozen acceptance criteria</h4>
          <p>
            Window: {report.frozenAcceptance.acceptancePlan.startsAt} to{" "}
            {report.frozenAcceptance.acceptancePlan.endsAt}. Minimum closed
            outcomes:{" "}
            {report.frozenAcceptance.acceptancePlan.minimumClosedOutcomes}.
          </p>
          <p>
            Baseline feature version:{" "}
            {report.frozenAcceptance.baseline.featureVersion}. Evaluation basis:{" "}
            {report.frozenAcceptance.acceptancePlan.evaluationBasis}.
          </p>
          <ul>
            {report.frozenAcceptance.acceptancePlan.criteria.map(
              (criterion) => (
                <li key={criterion.metric}>
                  {criterion.metric}: {criterion.operator} {criterion.threshold}{" "}
                  {criterion.unit}.{" "}
                  <Tip label="These are the immutable operator-declared review criteria. This report does not implement a full economic acceptance or promotion decision.">
                    <span>Acceptance assessment unavailable</span>
                  </Tip>
                </li>
              ),
            )}
          </ul>
        </section>
      )}
      {report.comparison && (
        <div className="challenger-comparison">
          <h4>Paired comparison</h4>
          <dl className="challenger-comparison-grid">
            <dt>Status</dt>
            <dd>{report.comparison.status}</dd>
            <dt>Native unit</dt>
            <dd>{report.comparison.unit}</dd>
            <dt>Expected / observed sessions</dt>
            <dd>
              {report.comparison.expectedSessions} /{" "}
              {report.comparison.observedSessions}
            </dd>
            <dt>Estimate</dt>
            <dd>{report.comparison.estimate?.toFixed(4) ?? "Unavailable"}</dd>
            <dt>95% interval</dt>
            <dd>
              {report.comparison.lower?.toFixed(4) ?? "Unavailable"} to{" "}
              {report.comparison.upper?.toFixed(4) ?? "Unavailable"}
            </dd>
            <dt>Method</dt>
            <dd>{report.comparison.method.kind}</dd>
            <dt>Block / bootstrap / seed</dt>
            <dd>
              {report.comparison.method.blockLength} /{" "}
              {report.comparison.method.bootstrapSamples} /{" "}
              {report.comparison.method.seed}
            </dd>
          </dl>
        </div>
      )}
      <p className="tw:text-ink-700">
        Paired comparison: {report.comparison?.status ?? "Unavailable"}
        {report.comparisonUnavailableReason
          ? ` (${report.comparisonUnavailableReason})`
          : ""}
        . Promotion authorized: No.
      </p>
    </section>
  );
}
