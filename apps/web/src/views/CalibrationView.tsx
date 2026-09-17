import {
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  type CalibrationRun,
  type ResearchJob,
  calibrationRunSchema,
  researchJobSchema,
} from "@tsx-scanner/contracts";
import { type FormEvent, useRef, useState } from "react";
import { getJson, sendJson } from "../lib/api.js";
import {
  useCapturedHistoryFormGuard,
  useCapturedHistoryRunSummary,
} from "../lib/captured-history.js";
import { dateInput, displayStrategy } from "../lib/format.js";
import {
  cancelResearchJob,
  isAbortError,
  pollResearchJob,
  researchJobFailureMessage,
} from "../lib/research-job.js";
import { EvidenceSummary } from "./EvidenceSummary.js";
import "./CalibrationView.css";

export function CalibrationView({
  runs,
  updated,
}: {
  runs: CalibrationRun[];
  updated: (values: CalibrationRun[]) => void;
}) {
  const today = dateInput(),
    startDefault = dateInput(new Date(Date.now() - 180 * 86_400_000));
  const [name, setName] = useState("Morning robustness study"),
    [startDate, setStartDate] = useState(startDefault),
    [endDate, setEndDate] = useState(today),
    [strategy, setStrategy] = useState<"ORB_RETEST" | "VWAP_HOLD">(
      "ORB_RETEST",
    ),
    [symbols, setSymbols] = useState("");
  const [rvol, setRvol] = useState("1.5,2,2.5"),
    [spread, setSpread] = useState("0.15,0.25"),
    [atr, setAtr] = useState("1.5,2"),
    [opening, setOpening] = useState("15"),
    [volume, setVolume] = useState("1.5,2"),
    [tolerance, setTolerance] = useState("0.1,0.15"),
    [scores, setScores] = useState("0,70"),
    [windowEnd, setWindowEnd] = useState("11:30"),
    [rr, setRr] = useState("2"),
    [minimum, setMinimum] = useState("30"),
    [selected, setSelected] = useState<CalibrationRun>(),
    [running, setRunning] = useState(false),
    [error, setError] = useState(""),
    [job, setJob] = useState<ResearchJob>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  useCapturedHistoryFormGuard(startDate, endDate);
  const numbers = (value: string) =>
    value
      .split(",")
      .map((v) => Number(v.trim()))
      .filter(Number.isFinite);
  const strings = (value: string) =>
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setRunning(true);
    setError("");
    setJob(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const queued = researchJobSchema.parse(
        await sendJson("/api/calibrations", "POST", {
          name,
          startDate,
          endDate,
          strategy,
          symbols: strings(symbols),
          minimumTradesPerSegment: Number(minimum),
          grid: {
            rvolAtTimeMin: numbers(rvol),
            spreadHardMaxPct: numbers(spread),
            atrPctMin: numbers(atr),
            openingRangeMinutes: numbers(opening),
            breakoutVolumeRatioMin: numbers(volume),
            retestTolerancePct: numbers(tolerance),
            scoreCutoff: numbers(scores),
            entryWindowEnd: strings(windowEnd),
            stopMethod: ["STRUCTURAL", "ATR"],
            rewardRiskRatio: numbers(rr),
          },
        }),
      );
      setJob(queued);
      const finished = await pollResearchJob(queued.id, {
        signal: controller.signal,
        onUpdate: setJob,
      });
      if (finished.status === "SUCCEEDED" && finished.resultRefId) {
        const run = calibrationRunSchema.parse(
          await getJson(`/api/calibrations/${finished.resultRefId}`),
        );
        updated([run, ...runs.filter((v) => v.id !== run.id)]);
        setSelected(run);
      } else {
        setError(researchJobFailureMessage(finished));
      }
      setJob(finished);
    } catch (reason) {
      if (!isAbortError(reason))
        setError(
          reason instanceof Error ? reason.message : "Unable to calibrate",
        );
    } finally {
      setRunning(false);
      abortRef.current = undefined;
    }
  };
  const cancel = async () => {
    if (!job) return;
    try {
      setJob(await cancelResearchJob(job.id));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to cancel calibration",
      );
    } finally {
      abortRef.current?.abort();
    }
  };
  const open = async (run: CalibrationRun) => {
    setError("");
    try {
      setSelected(
        calibrationRunSchema.parse(
          await getJson(`/api/calibrations/${run.id}`),
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to load calibration",
      );
    }
  };
  const best = selected?.trials[0];
  const runLabel = running
    ? job?.status === "CANCELLING"
      ? "CANCELLING…"
      : "CALIBRATING…"
    : "RUN CALIBRATION";
  useCapturedHistoryRunSummary(
    selected?.capturedHistoryAvailability ?? null,
    ".calibration-recommendation",
  );
  return (
    <>
      <section className="calibration-layout">
        <form
          className="panel backtest-form"
          onSubmit={(event) => void create(event)}
        >
          <div className="panel-title">
            <div>
              <h3>New calibration</h3>
              <p>Chronological 60/20/20 split · capped grid · captured data</p>
            </div>
            <span>ROBUSTNESS FIRST</span>
          </div>
          <div className="backtest-fields">
            <label>
              Name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="field-pair">
              <label>
                Start
                <input
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </label>
              <label>
                End
                <input
                  type="date"
                  required
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </label>
            </div>
            <div className="field-pair">
              <label>
                Strategy
                <select
                  value={strategy}
                  onChange={(e) =>
                    setStrategy(e.target.value as typeof strategy)
                  }
                >
                  <option value="ORB_RETEST">ORB RETEST</option>
                  <option value="VWAP_HOLD">VWAP HOLD</option>
                </select>
              </label>
              <label>
                Symbols (optional)
                <input
                  value={symbols}
                  onChange={(e) => setSymbols(e.target.value)}
                  placeholder="BTO.TO,BAM.TO"
                />
              </label>
            </div>
            <div className="field-pair">
              <label>
                RVOL values
                <input value={rvol} onChange={(e) => setRvol(e.target.value)} />
              </label>
              <label>
                Spread hard reject %
                <input
                  value={spread}
                  onChange={(e) => setSpread(e.target.value)}
                />
              </label>
            </div>
            <div className="field-pair">
              <label>
                ATR min %
                <input value={atr} onChange={(e) => setAtr(e.target.value)} />
              </label>
              <label>
                OR minutes
                <input
                  value={opening}
                  onChange={(e) => setOpening(e.target.value)}
                />
              </label>
            </div>
            <div className="field-pair">
              <label>
                Breakout candle volume ratio
                <input
                  value={volume}
                  onChange={(e) => setVolume(e.target.value)}
                />
              </label>
              <label>
                Retest tolerance %
                <input
                  value={tolerance}
                  onChange={(e) => setTolerance(e.target.value)}
                />
              </label>
            </div>
            <div className="field-pair">
              <label>
                Score cutoffs
                <input
                  value={scores}
                  onChange={(e) => setScores(e.target.value)}
                />
              </label>
              <label>
                Entry window ends
                <input
                  value={windowEnd}
                  onChange={(e) => setWindowEnd(e.target.value)}
                />
              </label>
            </div>
            <div className="field-pair">
              <label>
                R:R targets
                <input value={rr} onChange={(e) => setRr(e.target.value)} />
              </label>
              <label>
                Min trades / segment
                <input
                  type="number"
                  min="1"
                  value={minimum}
                  onChange={(e) => setMinimum(e.target.value)}
                />
              </label>
            </div>
            <div className="field-pair">
              <button className="run-backtest" disabled={running}>
                {runLabel}
              </button>
              {running && (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  disabled={job?.status === "CANCELLING"}
                >
                  CANCEL
                </button>
              )}
            </div>
          </div>
        </form>
        <section className="panel run-list">
          <div className="panel-title">
            <div>
              <h3>Calibration history</h3>
              <p>Immutable grids, splits, evidence, and recommendations.</p>
            </div>
            <span>{runs.length} RUNS</span>
          </div>
          {runs.map((run) => (
            <button
              className={`calibration-run ${selected?.id === run.id ? "selected" : ""}`}
              onClick={() => void open(run)}
              key={run.id}
            >
              <span>
                <strong>{run.name}</strong>
                <small>
                  {run.startDate} → {run.endDate} ·{" "}
                  {displayStrategy(run.strategy)} ·{" "}
                  {run.executionModelVersion ?? "NO MODEL VERSION"}
                  {run.executionModelVersion ===
                  AUTHORITATIVE_EXECUTION_MODEL_VERSION
                    ? " · CURRENT MODEL"
                    : " · OTHER MODEL VERSION"}
                </small>
              </span>
              <b>
                {run.combinationsTested}/{run.totalCombinations}
              </b>
              <i className={`run-status ${run.status.toLowerCase()}`}>
                {run.status}
              </i>
            </button>
          ))}
          {!runs.length && (
            <div className="empty">No calibration runs yet.</div>
          )}
        </section>
      </section>
      {error && <p className="error-banner">{error}</p>}
      {selected && (
        <>
          <EvidenceSummary
            marketId={selected.marketId}
            binding={selected.researchEvidence ?? null}
          />
          <section
            className={`calibration-recommendation ${selected.recommendedConfig ? "supported" : "warning"}`}
          >
            <strong>
              {selected.recommendedConfig
                ? "ROBUST RANGE SUPPORTED"
                : "INSUFFICIENT EVIDENCE"}
            </strong>
            <p>{selected.recommendation}</p>
            {selected.truncated && (
              <small>
                The grid was deterministically capped at{" "}
                {selected.combinationsTested} of {selected.totalCombinations}{" "}
                combinations.
              </small>
            )}
          </section>
          <section className="panel calibration-results">
            <div className="panel-title">
              <div>
                <h3>Ranked robustness</h3>
                <p>
                  Ranking uses train and validation results. New runs evaluate
                  the test segment only for the frozen selection.
                </p>
              </div>
              <span>TOP {Math.min(20, selected.trials.length)}</span>
            </div>
            <div className="calibration-table">
              <div className="calibration-row calibration-header">
                <span>RANK / PARAMETERS</span>
                <span>TRADES</span>
                <span>TRAIN R</span>
                <span>VALID R</span>
                <span>TEST R</span>
                <span>ROBUST</span>
                <span>PLATEAU</span>
              </div>
              {selected.trials.slice(0, 20).map((trial) => (
                <div className="calibration-row" key={trial.configVersion}>
                  <span>
                    <strong>
                      #{trial.rank} · RVOL {trial.parameters.rvolAtTimeMin} ·
                      SPR {trial.parameters.spreadHardMaxPct}%
                    </strong>
                    <small>
                      ATR {trial.parameters.atrPctMin}% · OR{" "}
                      {trial.parameters.openingRangeMinutes}m · VOL{" "}
                      {trial.parameters.breakoutVolumeRatioMin} · RET{" "}
                      {trial.parameters.retestTolerancePct}% · SCORE{" "}
                      {trial.parameters.scoreCutoff} ·{" "}
                      {trial.parameters.stopMethod} ·{" "}
                      {trial.parameters.rewardRiskRatio}R
                    </small>
                  </span>
                  <b>
                    {trial.segments.ALL?.tradesSimulated ??
                      trial.segments.TRAIN.tradesSimulated +
                        trial.segments.VALIDATION.tradesSimulated +
                        (trial.segments.TEST?.tradesSimulated ?? 0)}
                  </b>
                  <b>{trial.segments.TRAIN.averageR.toFixed(2)}R</b>
                  <b>{trial.segments.VALIDATION.averageR.toFixed(2)}R</b>
                  <b>
                    {trial.segments.TEST
                      ? `${trial.segments.TEST.averageR.toFixed(2)}R`
                      : "Not evaluated"}
                  </b>
                  <b
                    className={trial.robustScore >= 0 ? "positive" : "negative"}
                  >
                    {trial.robustScore.toFixed(3)}
                  </b>
                  <b>{trial.plateauSize}</b>
                </div>
              ))}
            </div>
          </section>
          {best && (
            <section className="analysis-grid calibration-slices">
              <p>
                Slice coverage:{" "}
                {best.analysesScope === "VALIDATION"
                  ? "validation segment"
                  : "all dates"}
                .
              </p>
              {(["SECTOR", "ATR_REGIME", "RVOL_REGIME"] as const).map(
                (dimension) => (
                  <article className="panel slice-panel" key={dimension}>
                    <div className="panel-title">
                      <h3>{dimension.replaceAll("_", " ")}</h3>
                    </div>
                    {best.analyses
                      .filter((v) => v.dimension === dimension)
                      .map((value) => (
                        <div className="slice-row" key={value.bucket}>
                          <strong>{value.bucket}</strong>
                          <span>{value.trades} trades</span>
                          <span>{value.winRate.toFixed(1)}%</span>
                          <span>{value.averageR.toFixed(2)}R</span>
                          <b
                            className={
                              value.expectancy >= 0 ? "positive" : "negative"
                            }
                          >
                            ${value.expectancy.toFixed(2)} exp.
                          </b>
                        </div>
                      ))}
                    {!best.analyses.some((v) => v.dimension === dimension) && (
                      <div className="empty compact">No qualifying trades</div>
                    )}
                  </article>
                ),
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
