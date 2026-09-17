import {
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  paperEvidenceCohortListSchema,
  paperModelForwardMonitoringListSchema,
  type BacktestRun,
  type PaperEvidenceCohort,
  type PaperModelForwardMonitoring,
  type StatisticalModel,
  type StatisticalPrediction,
  statisticalModelListSchema,
  statisticalModelSchema,
  statisticalPredictionBatchSchema,
} from "@tsx-scanner/contracts";
import { useEffect, useState } from "react";
import { getJson, sendJson } from "../lib/api.js";
import { displayStrategy, fmt } from "../lib/format.js";
import { EvidenceSummary } from "./EvidenceSummary.js";
import "./ModelsView.css";

/** Policy-driven research dashboard. It intentionally has no training inputs. */
export function StatisticalModelsView({
  models,
  backtests,
  updated,
}: {
  models: StatisticalModel[];
  backtests: BacktestRun[];
  updated: (models: StatisticalModel[]) => void;
}) {
  const [cohorts, setCohorts] = useState<PaperEvidenceCohort[]>([]);
  const [monitoring, setMonitoring] = useState<PaperModelForwardMonitoring[]>(
    [],
  );
  const [selected, setSelected] = useState<StatisticalModel>();
  const [predictions, setPredictions] = useState<StatisticalPrediction[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void getJson("/api/statistical-models/paper-evidence/cohorts")
      .then((value) =>
        setCohorts(paperEvidenceCohortListSchema.parse(value).cohorts),
      )
      .catch((reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load paper-evidence readiness",
        ),
      );
  }, []);
  useEffect(() => {
    void getJson("/api/statistical-models/forward-monitoring")
      .then((value) =>
        setMonitoring(
          paperModelForwardMonitoringListSchema.parse(value).monitoring,
        ),
      )
      .catch(() => undefined);
  }, []);

  const refresh = async () =>
    updated(
      statisticalModelListSchema.parse(await getJson("/api/statistical-models"))
        .models,
    );
  const open = async (model: StatisticalModel) => {
    setSelected(model);
    setPredictions([]);
    if (model.status !== "COMPLETED") return;
    try {
      const result = statisticalPredictionBatchSchema.parse(
        await getJson(`/api/statistical-models/${model.id}/predictions`),
      );
      setPredictions(
        result.predictions.sort(
          (left, right) => right.rankingScore - left.rankingScore,
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to score current candidates",
      );
    }
  };
  const activation = async (model: StatisticalModel, active: boolean) => {
    setError("");
    try {
      const value = statisticalModelSchema.parse(
        await sendJson(
          `/api/statistical-models/${model.id}/${active ? "activate" : "deactivate"}`,
          "POST",
          {},
        ),
      );
      await refresh();
      setSelected(value);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to change model activation",
      );
    }
  };
  const test = selected?.testMetrics;
  const historicalSource = selected?.backtestRunId
    ? backtests.find((run) => run.id === selected.backtestRunId)
    : undefined;
  const authoritative =
    selected?.sourceKind === "PAPER_EVIDENCE" ||
    historicalSource?.executionModelVersion ===
      AUTHORITATIVE_EXECUTION_MODEL_VERSION;

  return (
    <>
      <section className="statistical-layout">
        <section className="panel backtest-form">
          <div className="panel-title">
            <div>
              <h3>Automated training status</h3>
              <p>
                Policy-driven challengers from immutable closed-quote evidence.
              </p>
            </div>
            <span>SUPPLEMENTAL ONLY</span>
          </div>
          <div className="backtest-fields">
            <strong>
              Evidence collection is active. Scheduled training is pending
              commissioning.
            </strong>
            <p className="model-disclaimer">
              When enabled, policy automation can create an inactive challenger
              only. It cannot change READY, deterministic scores, alerts, trade
              references, sizing, or paper execution.
            </p>
            <small className="model-disclaimer">
              Cohort boundaries, sample floor, and chronological holdout rules
              are versioned server policy—not user inputs.
            </small>
          </div>
        </section>
        <section className="panel model-list">
          <div className="panel-title">
            <div>
              <h3>Model registry</h3>
              <p>Immutable artifacts with explicit activation eligibility.</p>
            </div>
            <span>{models.filter((model) => model.active).length} ACTIVE</span>
          </div>
          {models.map((model) => (
            <button
              className={`model-row ${selected?.id === model.id ? "selected" : ""}`}
              onClick={() => void open(model)}
              key={model.id}
            >
              <span>
                <strong>{model.name}</strong>
                <small>
                  {displayStrategy(model.strategy)} ·{" "}
                  {model.sourceKind === "PAPER_EVIDENCE"
                    ? "FORWARD PAPER"
                    : "BACKTEST"}{" "}
                  · {model.modelVersion}
                </small>
              </span>
              <i className={`run-status ${model.status.toLowerCase()}`}>
                {model.status.replaceAll("_", " ")}
              </i>
              <b
                className={
                  model.active
                    ? "active-model"
                    : model.eligibleForActivation
                      ? "positive"
                      : "muted"
                }
              >
                {model.active
                  ? "ACTIVE"
                  : model.eligibleForActivation
                    ? "ELIGIBLE"
                    : "GATED"}
              </b>
            </button>
          ))}
          {!models.length && (
            <div className="empty">No statistical research models yet.</div>
          )}
        </section>
      </section>
      <section className="panel prediction-panel">
        <div className="panel-title">
          <div>
            <h3>Paper evidence readiness</h3>
            <p>
              Compatible completed LIVE / closed QUOTE cohorts only. Cohorts are
              never mixed.
            </p>
          </div>
          <span>{cohorts.length} COHORTS</span>
        </div>
        {cohorts.map((cohort) => (
          <div
            className="prediction-row"
            key={`${cohort.profileConfigId}:${cohort.strategy}:${cohort.executionModelVersion}`}
          >
            <strong>
              {displayStrategy(cohort.strategy)}
              <small>
                {cohort.configVersion} · {cohort.strategyVersion}
              </small>
            </strong>
            <span>{cohort.closedQuoteCount} CLOSED QUOTES</span>
            <span>
              {cohort.positives} WIN / {cohort.negatives} NON-POSITIVE
            </span>
            <span>
              {cohort.firstSignalAt?.slice(0, 10) ?? "—"} –{" "}
              {cohort.lastSignalAt?.slice(0, 10) ?? "—"}
            </span>
            <span>{cohort.missingFeatureCount} MISSING FEATURES</span>
          </div>
        ))}
        {!cohorts.length && (
          <div className="empty compact">
            No completed canonical paper-execution cohort is ready to inspect.
          </div>
        )}
      </section>
      <section className="panel prediction-panel">
        <div className="panel-title">
          <div>
            <h3>Forward monitoring</h3>
            <p>
              Predictions are evaluated only against later closed QUOTE
              outcomes.
            </p>
          </div>
          <span>{monitoring.length} MODEL VERSIONS</span>
        </div>
        {monitoring.map((value) => (
          <div
            className="prediction-row"
            key={`${value.modelId}:${value.modelVersion}`}
          >
            <strong>
              {displayStrategy(value.strategy)}
              <small>{value.modelVersion}</small>
            </strong>
            <span>{value.predictions} SNAPSHOTS</span>
            <span>{value.closedOutcomes} CLOSED</span>
            <span>
              OBSERVED{" "}
              {value.observedWinRate === null
                ? "—"
                : `${(value.observedWinRate * 100).toFixed(1)}%`}
            </span>
            <span>
              PREDICTED{" "}
              {value.averagePredictedProbability === null
                ? "—"
                : `${(value.averagePredictedProbability * 100).toFixed(1)}%`}
            </span>
            <span>BRIER {fmt(value.brierScore)}</span>
          </div>
        ))}
        {!monitoring.length && (
          <div className="empty compact">
            No forward prediction snapshots have closed yet.
          </div>
        )}
      </section>
      {error && <p className="error-banner">{error}</p>}
      {selected && (
        <>
          <EvidenceSummary
            marketId={selected.marketId}
            binding={selected.researchEvidence ?? null}
          />
          <section
            className={`calibration-recommendation ${selected.eligibleForActivation ? "supported" : "warning"}`}
          >
            <strong>
              {!authoritative
                ? "LEGACY MODEL · NON-ACTIONABLE"
                : selected.active
                  ? "ACTIVE SUPPLEMENT"
                  : selected.eligibleForActivation
                    ? "HOLDOUT GATE PASSED"
                    : "NOT ELIGIBLE FOR ACTIVATION"}
            </strong>
            <p>
              {!authoritative
                ? "This artifact was fitted to retired execution semantics and cannot be activated."
                : selected.warnings.join(" ") ||
                  "Chronological holdout Brier score improves on the training-segment base-rate forecast. Manual activation remains required."}
            </p>
            <div className="model-actions">
              {selected.active ? (
                <button onClick={() => void activation(selected, false)}>
                  DEACTIVATE
                </button>
              ) : (
                <button
                  disabled={!selected.eligibleForActivation || !authoritative}
                  onClick={() => void activation(selected, true)}
                >
                  ACTIVATE FOR {displayStrategy(selected.strategy)}
                </button>
              )}
            </div>
          </section>
          <section className="backtest-metrics">
            <div>
              <span>TEST SAMPLES</span>
              <strong>{test?.samples ?? 0}</strong>
            </div>
            <div>
              <span>BASE RATE</span>
              <strong>
                {test ? `${(test.baseRate * 100).toFixed(1)}%` : "—"}
              </strong>
            </div>
            <div>
              <span>BRIER</span>
              <strong>{fmt(test?.brierScore ?? null)}</strong>
            </div>
            <div>
              <span>BASELINE BRIER</span>
              <strong>{fmt(test?.baselineBrierScore ?? null)}</strong>
            </div>
            <div>
              <span>ROC AUC</span>
              <strong>{fmt(test?.rocAuc ?? null)}</strong>
            </div>
            <div>
              <span>TRAIN / TEST</span>
              <strong>
                {selected.trainMetrics?.samples ?? 0} / {test?.samples ?? 0}
              </strong>
            </div>
          </section>
          <section className="panel prediction-panel">
            <div className="panel-title">
              <div>
                <h3>Current supplemental ranking</h3>
                <p>
                  Probability and regime annotations only; deterministic
                  strategy state remains authoritative.
                </p>
              </div>
              <span>{predictions.length} SCORED</span>
            </div>
            {predictions.map((value) => (
              <div
                className="prediction-row"
                key={`${value.profileId}:${value.symbol}`}
              >
                <strong>
                  {value.symbol}
                  <small>{value.profileName}</small>
                </strong>
                <b>RULE {value.deterministicScore}</b>
                <b>MODEL {value.rankingScore}</b>
                <span>{(value.setupProbability * 100).toFixed(1)}% SETUP</span>
                <span>
                  {value.regime.combined
                    .replaceAll("__", " · ")
                    .replaceAll("_", " ")}
                </span>
              </div>
            ))}
            {selected.status === "COMPLETED" && !predictions.length && (
              <div className="empty compact">
                No current READY evaluations match this model strategy.
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
