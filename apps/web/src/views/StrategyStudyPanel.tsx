import {
  executableFrozenStudyPlanSchema,
  type StrategyStudyReport,
  researchJobSchema,
  studyAuthorizationRecordSchema,
  studyAuthorizationRequestSchema,
  strategyStudyRecordSchema,
  type ResearchJob,
  type StudyAuthorizationRecord,
  type StrategyStudyRecord,
} from "@tsx-scanner/contracts";
import { useEffect, useState } from "react";
import { getJson, sendJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import {
  isAbortError,
  pollResearchJob,
  researchJobFailureMessage,
} from "../lib/research-job.js";
import { Button } from "../components/ui/Button.js";
import { Tip } from "../ui.js";

const STUDY_PLAN_INPUT =
  "tw:grid tw:gap-[7px] tw:font-mono tw:text-[0.64rem] tw:font-bold tw:tracking-[0.07em] tw:text-ink-350";
const STUDY_PLAN_TEXTAREA =
  "tw:w-full tw:resize-y tw:rounded-[7px] tw:border tw:border-line-input tw:bg-bg tw:px-[11px] tw:py-[10px] tw:font-mono tw:text-[0.72rem] tw:text-ink-100";
const STUDY_RESULT_SMALL = "tw:mt-1 tw:block tw:text-[0.65rem] tw:text-ink-350";
const EMPTY_COMPACT =
  "empty compact tw:p-[25px] tw:text-center tw:text-ink-700";

export function StrategyStudyPanel({
  marketId,
}: {
  marketId: "CA_TSX" | "US_EQUITIES";
}) {
  const [planText, setPlanText] = useState("");
  const [studies, setStudies] = useState<StrategyStudyRecord[]>([]);
  const [authorizations, setAuthorizations] = useState<
    StudyAuthorizationRecord[]
  >([]);
  const [authorizationText, setAuthorizationText] = useState("");
  const [job, setJob] = useState<ResearchJob>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = async (signal?: AbortSignal) => {
    const [studyResponse, authorizationResponse] = await Promise.all([
      getJson(`/api/strategy-studies?marketId=${marketId}`, signal),
      getJson(
        `/api/strategy-studies/authorizations?marketId=${marketId}`,
        signal,
      ),
    ]);
    const raw = studyResponse as { studies?: unknown[] };
    const authorizationRaw = authorizationResponse as {
      authorizations?: unknown[];
    };
    setStudies(
      (raw.studies ?? []).map((value) =>
        strategyStudyRecordSchema.parse(value),
      ),
    );
    setAuthorizations(
      (authorizationRaw.authorizations ?? []).map((value) =>
        studyAuthorizationRecordSchema.parse(value),
      ),
    );
  };

  const authorize = async () => {
    setLoading(true);
    setError("");
    try {
      const request = studyAuthorizationRequestSchema.parse(
        JSON.parse(authorizationText) as unknown,
      );
      if (request.authorization.marketId !== marketId)
        throw new Error(
          "Authorization market does not match the selected market.",
        );
      await sendJson("/api/strategy-studies/authorizations", "POST", request, {
        "Idempotency-Key": `study-authorization:${request.authorization.id}`,
      });
      setAuthorizationText("");
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to save authorization",
      );
    } finally {
      setLoading(false);
    }
  };

  const revoke = async (authorization: StudyAuthorizationRecord) => {
    setError("");
    try {
      await sendJson(
        `/api/strategy-studies/authorizations/${authorization.id}/revoke`,
        "POST",
        {},
        { "Idempotency-Key": `study-revoke:${authorization.id}` },
      );
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to revoke authorization",
      );
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void refresh(controller.signal).catch((reason) => {
      if (!isAbortError(reason))
        setError(
          reason instanceof Error ? reason.message : "Unable to load studies",
        );
    });
    return () => controller.abort();
  }, [marketId]);

  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const plan = executableFrozenStudyPlanSchema.parse(
        JSON.parse(planText) as unknown,
      );
      if (plan.comparison.marketId !== marketId)
        throw new Error(
          "Frozen plan market does not match the selected market.",
        );
      const queued = researchJobSchema.parse(
        await sendJson("/api/strategy-studies", "POST", plan, {
          "Idempotency-Key": `strategy-study:${plan.experimentId}`,
        }),
      );
      setJob(queued);
      const finished = await pollResearchJob(queued.id, {
        onUpdate: setJob,
      });
      if (finished.status !== "SUCCEEDED") {
        setError(researchJobFailureMessage(finished));
      }
      await refresh();
    } catch (reason) {
      if (!isAbortError(reason))
        setError(
          reason instanceof Error ? reason.message : "Unable to submit study",
        );
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel strategy-study-panel tw:mx-0 tw:mt-[18px] tw:mb-4 tw:grid tw:gap-[14px] tw:p-[18px]">
      <div className="panel-title">
        <div>
          <h3>Frozen comparative studies</h3>
          <p>
            Review the complete baseline/challenger plan before canonical
            replay.
          </p>
        </div>
        <Tip label="A positive estimate never activates a profile. Missing coverage, exposed TEST stages and interruption stay visible for review.">
          <span aria-label="Study safety explanation">NO ACTIVATION</span>
        </Tip>
      </div>
      <label className={STUDY_PLAN_INPUT}>
        Frozen study plan JSON
        <textarea
          className={STUDY_PLAN_TEXTAREA}
          aria-label="Frozen study plan JSON"
          rows={5}
          value={planText}
          onChange={(event) => setPlanText(event.target.value)}
          placeholder="Paste the reviewed frozen plan, including bindings, dates, profiles and paired-session settings."
        />
      </label>
      <label className={STUDY_PLAN_INPUT}>
        Explicit execution authorization JSON
        <textarea
          className={STUDY_PLAN_TEXTAREA}
          aria-label="Explicit execution authorization JSON"
          rows={4}
          value={authorizationText}
          onChange={(event) => setAuthorizationText(event.target.value)}
          placeholder='Paste { "authorization": { ... }, "plan": { ... } } only after reviewing expiry, versions and the fixed session budget.'
        />
      </label>
      <Button
        variant="primary"
        className="run-backtest"
        disabled={loading || !authorizationText.trim()}
        onClick={() => void authorize()}
      >
        SAVE EXPLICIT AUTHORIZATION
      </Button>
      <Button
        variant="primary"
        className="run-backtest"
        disabled={loading || !planText.trim()}
        onClick={() => void submit()}
      >
        {loading ? "RUNNING STUDY…" : "SUBMIT FROZEN STUDY"}
      </Button>
      {job && (
        <p className="study-job-status tw:m-0 tw:font-mono tw:text-[0.64rem] tw:font-bold tw:text-ink-350">
          JOB {job.status} · {job.progress.completedSessions ?? 0}/
          {job.progress.totalSessions ?? "—"} sessions
        </p>
      )}
      {error && <p className="error-banner">{error}</p>}
      <div className="study-results tw:grid tw:gap-2">
        <div className="study-result tw:grid tw:grid-cols-[1fr_1fr] tw:gap-x-5 tw:gap-y-2 tw:rounded-[8px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:p-3">
          <strong>Execution authorizations</strong>
          <small className={classes(STUDY_RESULT_SMALL, "tw:col-span-full")}>
            Prepare-only is the default. Execute-when-ready reserves one study
            job only after verified prerequisites; revocation is durable.
          </small>
          {authorizations.map((authorization) => (
            <div key={authorization.id}>
              <b>{authorization.mode.replaceAll("_", " ")}</b>
              <small className={STUDY_RESULT_SMALL}>
                expires {authorization.expiresAt} · budget{" "}
                {authorization.maxSessionExecutions} sessions ·{" "}
                {authorization.dispatchedJobId
                  ? `job ${authorization.dispatchedJobId}`
                  : "not dispatched"}
              </small>
              {authorization.revokedAt ? (
                <small className={STUDY_RESULT_SMALL}>
                  REVOKED {authorization.revokedAt}
                </small>
              ) : (
                <button
                  type="button"
                  onClick={() => void revoke(authorization)}
                >
                  REVOKE
                </button>
              )}
            </div>
          ))}
          {!authorizations.length && (
            <small className={classes(STUDY_RESULT_SMALL, "tw:col-span-full")}>
              No explicit authorization for this market.
            </small>
          )}
        </div>
        {studies.map((study) => (
          <article
            key={study.id}
            className="study-result tw:grid tw:grid-cols-[1fr_1fr] tw:gap-x-5 tw:gap-y-2 tw:rounded-[8px] tw:border tw:border-line-subtle tw:bg-surface-raised tw:p-3"
          >
            <div>
              <strong>{study.plan.variant}</strong>
              <small className={STUDY_RESULT_SMALL}>
                {study.plan.comparison.expectedSessions.length} expected
                sessions · {study.createdAt}
              </small>
            </div>
            <div>
              <b>{study.report?.status ?? "IN PROGRESS"}</b>
              {study.report && <StudyComparisonSummary report={study.report} />}
              {study.report?.reasonCodes.map((reason) => (
                <small className={STUDY_RESULT_SMALL} key={reason}>
                  {reason}
                </small>
              ))}
            </div>
            <small className={classes(STUDY_RESULT_SMALL, "tw:col-span-full")}>
              Stages: {study.receiptKeys.join(", ") || "waiting"}. Sampled
              excursions are observed marks only; unobserved path extremes are
              not reconstructed.
            </small>
          </article>
        ))}
        {!studies.length && (
          <p className={EMPTY_COMPACT}>No retained studies for this market.</p>
        )}
      </div>
    </section>
  );
}

export function StudyComparisonSummary({
  report,
}: {
  report: StrategyStudyReport;
}) {
  const comparison = report.comparison;
  if (!comparison) return null;
  if (
    comparison.unit !== "R" &&
    report.calculationVersion !== "study-report-v2"
  )
    return (
      <small>
        LEGACY_CURRENCY_AGGREGATION_UNVERIFIED � Historical currency estimate
        unavailable
      </small>
    );
  return (
    <small>
      paired {comparison.estimate?.toFixed(3) ?? "�"} {comparison.unit} �
      interval {comparison.lower?.toFixed(3) ?? "�"}�
      {comparison.upper?.toFixed(3) ?? "�"}
    </small>
  );
}
