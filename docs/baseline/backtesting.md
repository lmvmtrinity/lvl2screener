# Backtesting and replay

Reviewed against source on September 8, 2026. See [learning](learning.md) for
the separate forward-paper training pipeline and [paper execution](paper-execution.md)
for authoritative fill ownership and close recovery.

## 1. Objective

Backtesting exists to answer whether the strategy logic actually has positive expectancy and which settings are robust.

The goal is not to maximize historical P&L through overfitting.

## 2. Core Principle

Live and backtest modes should reuse the same:

- feature functions
- strategy state machines
- scoring logic
- configuration format
- reason codes

Do not maintain separate implementations.

## 3. Replay Model

Historical data is processed sequentially as if it were arriving live.

For each timestamp:

1. expose only data known at that moment
2. update features
3. evaluate strategy states
4. persist state transitions
5. advance time

## 4. No Look-Ahead

Examples:

- a swing low needing two future bars becomes valid only after those bars close
- a breakout is not confirmed before the required candle closes
- VWAP uses only volume available up to that timestamp
- RVOL uses only historical completed sessions plus current elapsed session volume
- later highs/lows cannot change previously emitted signals

## 5. Spread Limitation

Historical OHLC candles do not contain bid/ask spread.

Therefore:

- candle-only historical backtests cannot perfectly reproduce spread gates
- the system should collect quote snapshots from day one
- replay quality improves as proprietary quote history accumulates

Missing captured spreads/coverage must remain explicit and fail the applicable
qualification gates. Do not bypass live safety rules or fabricate spread values
to make older history eligible.

## 6. Backtest Inputs

A run should define:

- market identity and native reporting currency
- scanner profile and strategy name/version
- config version
- date range
- universe
- data source
- execution assumptions
- slippage assumptions
- fee assumptions

## 7. Metrics

Research reporting guidance (not a promise that every API response exposes every metric below):

```text
signals generated
READY signals
trades simulated
win rate
average win
average loss
average R
median R
profit factor
expectancy
maximum drawdown
false breakout rate
signal-to-trade conversion
time-of-day expectancy
strategy expectancy
score-bucket expectancy
```

Primary metric:

```text
Expectancy =
(Pwin × AvgWin)
-
(Ploss × AvgLoss)
```

Do not optimize primarily for win rate.

Profile comparisons must also report setup count, average winner, average loser, average hold time, false-positive rate, maximum drawdown, and slices by time of day, sector, ATR regime, and RVOL regime. A higher average R alone is not sufficient evidence that one profile is superior.

### Fair Profile Comparison

Comparisons should evaluate profiles over the same dates, shared universe, source data, execution assumptions, and feature snapshots. This supports both comparisons between different strategies and A/B tests between configurations of the same strategy.

Desired comparison controls (consult each route/schema for implemented filters):

- today, 5 days, 30 days, and all time
- paper, backtest, and live-observation sources
- configurable time-of-day buckets
- strategy, profile, sector, ATR regime, and RVOL regime

Do not compare profiles fed by different universes without clearly labeling the universe difference and controlling for its effect.

## 8. Parameter Analysis

Supported research controls include (consult the request schema for exact bounds):

- RVOL threshold
- spread threshold
- ATR threshold
- OR duration
- breakout buffer
- retest tolerance
- volume confirmation
- VWAP distance
- extension threshold
- score cutoff
- time window
- R:R threshold
- sector behavior

## 9. Avoiding Overfitting

Use:

- train/validation/test date segments
- walk-forward analysis
- out-of-sample periods
- parameter plateaus rather than one sharp optimum
- enough samples per strategy

Do not tune aggressively after 10–20 trades.

## 10. Replay Regression Tests

Maintain fixed historical sessions with expected state transitions.

Example:

```text
09:45 WATCH
09:55 FORMING
10:05 READY
10:20 INVALIDATED
```

A strategy code change that shifts these timestamps should be reviewed deliberately.

## 11. Paper Trading

Before live discretionary use:

1. run replay tests
2. run real-time paper mode
3. collect at least a meaningful sample of signals
4. compare expected vs observed execution
5. keep confirmatory forward evidence separate from parameter search; follow ADR-011

## 12. Research Output

### Retained-input coverage and lineage

Research results may carry a nullable `researchEvidence` binding. A verified
binding is the sequence `declared manifest → verified retained coverage → bound
job → frozen dataset/model`; it is content-addressed by the manifest, expected
input grid, normalized retained records, session payloads, engine revision and
runtime fingerprint. Coverage is evaluated independently for each candidate and
market/sector benchmark, including the required warmup stream.

`VERIFIED` means the declared input checks passed; it does not mean the strategy
is profitable. `INCOMPLETE` means required retained inputs are missing or fail a
frozen gap/warmup rule. `UNKNOWN` means historical membership, calendar,
availability or adjustment provenance cannot establish what should have been
observed. A verified zero-opportunity window remains valid and is not converted
into a missing-data result. Legacy artifacts continue to load with an unverified
null binding. Verification cannot manufacture provider provenance that was not
retained.

Backtests should export:

- summary metrics
- trade list
- signal timeline
- score distribution
- reason-code frequency
- parameter version
- charts suitable for review

## 13. Ranking research

Captured replay attaches both market- and sector-relative context evaluations
to each simulated READY trade. Studies select the same `topPerSession` count
under the active tie-break baseline and each candidate, then split whole dates
chronologically. The report compares average R, false-breakout rate, and
drawdown; checks samples per setup and combined ATR/RVOL regime; evaluates
neighboring context weights; and reapplies extra round-trip slippage and fees.

The research service intentionally returns completed ineligible reports for
missing context, insufficient dates/samples, a formula that fails to generalize,
or unstable/cost-sensitive results. It does not activate formulas. Historical
backtests created before context capture remain readable with neutral context,
but cannot pass the context-evidence gate.

## 14. Authoritative captured replay

Captured replay processes captured quote snapshots and completed candles sequentially through the production `FeatureEngine` and `StrategyEngine`. A candle is exposed only after its `end` timestamp. Strategy thresholds are injected per run and hashed into an immutable config version; live mode continues to use its bound profile configuration.

Signal-replay HTTP endpoints cooperatively stop their request-scoped worker on
client disconnect or request-task cancellation. `replay_cancellation.py` signals
the thread; `backtest.py` checks at session/quote/snapshot boundaries and refuses
partial results. The connected replay chronology and strategy rules are unchanged.
This behavior applies to full signal replay and signal chunks, not the separate
fill-simulation or statistical-training endpoints. See the
September 9 acceptance record
for verification and deployment scope.

The current authoritative path uses Python for chronological signal replay and
TypeScript `AuthoritativeBacktestAccumulator` for paper execution. The QUOTE model
uses executable quotes, costs and displayed-size constraints; the supplementary
CANDLE model uses its own admissibility and conservative intrabar rules. Do not
summarize both as “close every position at the last bar.” Missing exit facts remain
unresolved under the applicable completion/coverage policy rather than becoming
invented fills. See [paper execution](paper-execution.md).

Execution identity is currently `paper-execution-v7`, declared in
`contracts/src/domains/backtests.ts` and re-exported by
`apps/api/src/backtests/execution-provenance.ts`. Every run stores its own costs,
risk and session assumptions. The present default close assumption is 16:00 local;
legacy noon assumptions stay attached to their original records. Sensitivity
studies may vary explicit controls, but their results are not the unchanged forward
baseline. Commission sensitivity re-prices a report without rewriting source rows.

Replay quote admission is deterministic and applies to both signal evaluation and
execution. A quote with a non-positive bid, crossed book, or invalid last, day
open, size, spread or non-finite value is excluded as an individual fact; valid
quotes from the same instrument and session remain. Exclusion is never silent:
the persisted data-quality disclosure records raw `quoteSnapshots`,
`admittedQuotes`, `excludedQuotes` and `exclusionReasons`, `spread: CAPTURED`
requires at least one admitted quote, and a trade on an instrument with excluded
quotes cannot claim sampled-excursion completeness
(`INPUT_EXCLUSIONS_PRESENT`). The frozen payload hashed for coverage remains the
raw captured input; admission is a view applied after that identity is fixed.
Session payloads carry an explicit `marketId`, so a US session cannot be
validated under the Canadian market. Replay admission runs on the TypeScript
dispatch boundary before a session reaches the scanner engine, which keeps its
own strict live-ingestion validation; every replay dispatch path applies the
same admission predicate.

Runs persist inputs, status, state timeline, trades, data-quality disclosures, headline metrics, and strategy/score/time slices. Fair-comparison checks require matching dates, universe, captured source, capital, size, slippage, and fees. Parameter and strategy differences remain allowed because they are the variables under test.

## 15. Profile comparisons

Scanner profiles make the experimental unit explicit. Live comparisons count profile-scoped READY setups and invalidations from the same persisted feature stream. Paper comparisons select CLOSED QUOTE executions from LIVE paper-bot runs for the profile's current immutable configuration and strategy version. This comparison query does not require the run to be COMPLETED, so its counts are not equivalent to eligible training evidence. Backtest comparisons use non-revoked `profile_config_evidence` links to current profile configurations and matching strategy versions. The Strategy Lab applies common date, source, default-universe, and market-specific session-time controls before reporting setup count, win rate, average winner/loser, average R, profit factor, expectancy, drawdown, hold time, and false-positive rate. Missing outcomes remain zero-sample results rather than inferred wins or losses.

Comparison results now carry an evidence status: `CONTROLLED` requires matching
market, window, universe, feature, execution, input, and coverage scope; a known
scope mismatch is `UNCONTROLLED`; equal missing or incomplete provenance is
`UNVERIFIED`. Profiles with multiple incompatible execution cohorts must provide
one server-returned cohort selection before their results can be compared.
`maximumDrawdown` is the realized closed-outcome drawdown only: closed outcomes
are ordered by persisted realization time, outcomes realized at the same instant
are netted before the peak-to-trough calculation, and setup-only or unavailable
realization data returns null with an explicit status. It is not a funded-account
equity curve or a claim about funded balances. Until WP02 supplies content-verified
coverage, retained backtest comparisons may correctly remain `UNVERIFIED`.

## 16. Calibration

`POST /api/calibrations` enqueues a durable job (HTTP 202) that runs a bounded grid over one strategy and one controlled captured-data input. The service changes only versioned strategy, session, and execution controls; each trial still uses the production feature engine and state machines. Opening-range duration changes the replay session boundary, entry-window calibration changes the hard new-entry boundary, and stop/R:R trials alter only the deterministic execution simulation.

Dates are split chronologically into train, validation, and test periods. Robustness ranking combines mean and worst-segment average R from train and validation only, penalizes their dispersion and drawdown, and reports the result as a research score—not a predicted return. The untouched test segment is excluded from ranking and plateau construction, then applied as a post-selection qualification gate. A deployable recommendation is withheld unless all segments meet the requested sample floor, both out-of-sample segments have positive expectancy and average R, and a neighboring grid point has similar performance. This intentionally favors plateaus and makes an empty or underpowered result valid.

New studies execute TRAIN/VALIDATION for each trial, freeze the selected configuration
and replay-input hash in `calibration_run.holdout_selection`, then execute TEST only
for that selection. A failed TEST yields no recommendation and cannot cause fallback
selection. Reports use null for unselected TEST and for ALL (the whole period is not
replayed again). Slice analyses explicitly cover VALIDATION; legacy reports retain
their all-period metrics and default ALL slice scope.

Migration 083 binds each worker job to one calibration run. Completed retries return
the stored result without reading history again. Running, failed or interrupted
attempts, and pre-upgrade retries without a linked run, fail closed rather than
repeat potentially exposed holdout data. Review the run before declaring a new
experiment; this is deliberately not mid-run resume. Selection is immutable in the
database. The service persists the grid, split, search report, warnings and recommendation.
Calibration does not mutate a live scanner profile automatically.

## 17. Statistical validation

Backtest-source statistical training selects one completed captured-history backtest
as its immutable labeled dataset and one strategy within that run. The separate
PAPER_EVIDENCE source uses a frozen compatible dataset and stricter qualification
described in [learning](learning.md). Trades are ordered by entry time and split chronologically; no shuffle or future-derived input is allowed. A positive label means the simulated trade produced positive R. The initial features are deterministic score, ATR%, log RVOL-at-Time, and market-local minutes from the open. Missing ATR/RVOL values use medians calculated only from the training segment.

The regularized logistic artifact persists coefficients, intercept, feature order, scaling values, imputation medians, and regime medians. Holdout evaluation reports class balance, Brier score, a training-base-rate Brier baseline, log loss, ROC AUC, and calibration bins. The artifact cannot be activated when sample or class coverage is insufficient, or when holdout Brier score fails to improve on that training-only base-rate forecast.

This is probability calibration and attention ranking, not a replacement backtest strategy. Statistical predictions do not alter historical or live states, scores, signal times, entries, stops, targets, or alerts.

## 18. Market-scoped replay and evidence

Backtests, paper-evidence datasets, calibrations, qualifications, and
statistical models belong to exactly one `marketId`. Candidate instruments and
benchmarks are resolved only within that market, and replay uses the recorded
market timezone/session policy. A model trained from a frozen paper dataset
inherits the dataset's market; database enforcement rejects a model whose
source evidence belongs to another market.

Runs may be displayed together only as separately labeled CAD and USD rows.
They are never pooled for P&L, drawdown, risk, calibration, or model training.

## Source owners

- [Replay service](../../apps/api/src/backtests/backtest-service.ts) and
  [execution accumulator](../../apps/api/src/backtests/authoritative-backtest-executor.ts).
- [Profile comparison queries](../../apps/api/src/profiles/profile-repository.ts):
  source selection differs from training qualification.
- [Qualification automation](../../apps/api/src/backtests/backtest-automation.ts)
  and its [durable store](../../apps/api/src/backtests/backtest-automation-repository.ts):
  work identity, input watermark, completion-aware dispatch and cycle receipts.
- [Calibration](../../apps/api/src/calibration/calibration-service.ts): bounded
  trial execution and chronological selection.
- [Statistical features](../../services/scanner/app/statistical_models.py):
  market-local time, training-only transforms and holdout metrics.

Remaining strategy experiments are tracked in
research validation.

Offline study manifests can be generated with the
[research manifest CLI](../../apps/api/src/research-manifest.ts). It validates
declared identities and chronological splits, hashes retained files, and records
missing declared candidate sessions. This is an inventory tool, not input-content
or research qualification verification. See the
completed package and usage.

## 19. Comparative strategy studies

The Backtests workspace accepts a strict, frozen `FrozenStudyPlan` for the named
baseline/challenger ablation. Submission creates one `STRATEGY_STUDY` research
job; the worker replays TRAIN, VALIDATION and TEST through the same captured
session cursor and authoritative execution accumulator used by ordinary
backtests. The plan, evidence binding, stage claims, canonical run identities
and final report are immutable and market-scoped. A claimed TEST with no result
is retained as `INTERRUPTED` and is not silently replayed.

The TEST report aligns both profiles by the declared session date and reports a
paired challenger-minus-baseline estimate with the predeclared circular moving
block bootstrap settings. It is descriptive evidence, not a portfolio Sharpe
ratio, currency conversion, qualification decision or activation instruction.
Missing/unknown coverage is `UNVERIFIED`; a complete but underpowered window is
`INSUFFICIENT`. Trade diagnostics may include sampled executable-bid excursions
only for observed admissible interior marks and single-lot trades. They never
reconstruct continuous paths or alternate fills.

Execute-when-ready automation is separate from study submission. It requires an
explicit versioned authorization with a concrete market, frozen plan/policy
hashes, expiry and a fixed two-profile session budget. Authorization is
prepare-only by default, can be revoked, and reserves at most one durable study
job transactionally once verified prerequisites are available. It does not
activate a profile or authorize broker orders.

The engineering CLI is optional and submits the same durable job:
`pnpm --filter @tsx-scanner/api strategy-study --request <plan.json> --output <report.json>`.
`--dry-run` writes a validation summary without claiming TEST; an existing output
file is never overwritten.

## 20. Prospective inactive-challenger observation

An inactive statistical model can be enrolled only through the explicit
challenger-experiment API after its completed artifact and verified research
binding match the frozen request. Observation starts at a future boundary and
does not modify deterministic strategy decisions, paper execution, or active
model state. Each eligible paper observation gets one immutable attempt with its
original input snapshot and a maximum 30-second deadline. Inference runs outside
the paper-observation transaction; optional capture is isolated by a bounded
savepoint. A timeout, late result, invalid input, engine error or revoke is a
terminal outcome, and retries use the original deadline and identity.

Reports keep failures and unknown capture gaps in the denominator. Brier score is
limited to timely predictions with closed simulated QUOTE outcomes, while paired
comparison remains unavailable without verified WP02 coverage and compatible
WP03 inputs. A report never represents a portfolio return, funded balance or
promotion authorization. Legacy observations with unknown capture time are
excluded from prospective attempts rather than backfilled.

## 21. Qualification automation

Routine profile qualification replays run through a durable work registry with
one stable work key per immutable profile configuration (market, config id,
config version, strategy, execution-model version and full-range policy).
Trigger origin (`PROFILE_SAVE`, `SCHEDULED_CATCH_UP`, `REFRESH_NOW`,
`EXPLICIT_EXPERIMENT`) and the captured-input fingerprint are recorded next to
the work key, not inside it, so profile saves and scheduled catch-up converge on
the same durable job. The fingerprint combines the market-local captured-session
date list with per-date quote/candle counts and latest timestamps; newly
completed sessions and late-arriving rows reopen the same work item, while
in-place corrections that preserve counts and timestamps require the explicit
`REFRESH_NOW` attempt. Automation dispatches only existing `BACKTEST` jobs
through `backtest-automation:<attemptKey>` idempotency keys and never mutates
strategy or execution policy. Payload construction and validation share
`profileQualificationInput`, so the US slippage floor is enforced before a job
is enqueued.

Scheduling is completion-aware: a per-market outstanding cap bounds queued and
running automated replays, a settled durable job re-runs the market cycle
(`JOB_COMPLETION`) so waiting capacity work drains immediately and completed
parents materialize their follow-on stages, equivalent pending refreshes
coalesce, transient terminal failures get a bounded persisted backoff
(`nextRetryAt`), and permanent blockers (no captured history, unavailable
range, rejected policy) reopen only when the input fingerprint changes. When
scheduled automation is disabled, completion cycles reconcile state but never
dispatch routine work. Scheduled automation is opt-in through
`BACKTEST_AUTOMATION_ENABLED` (default false) with
`BACKTEST_AUTOMATION_MAX_OUTSTANDING`; profile saves and explicit refreshes are
evaluated regardless. Control state, the work registry and cycle receipts are
persisted (`114-backtest-automation.sql`), with waiting-since tracking and the
completion trigger in `117-backtest-automation-completion-trigger.sql`, and the
empty-candidate waiting reason in
`118-backtest-automation-candidate-blocker.sql`.
`GET /api/backtest-automation/status` and
`POST /api/backtest-automation/refresh` expose the market-scoped state to
the Backtest & Studies page, including oldest waiting age and the time and
runtime of the last successful result. This does not qualify a profile,
activate a model or authorize capital; evidence qualification and promotion
remain separate.

Automated replays resolve candidate instruments per captured session from
retained universe membership that completed before that session opened; a
zero-discovery refresh is unavailable membership, not an intentionally empty
list, and explicitly requested symbols form a labeled captured cohort that does
not claim point-in-time reconstruction. A range that resolves no
candidate-bearing session enters the `NO_REPLAY_CANDIDATES` waiting state
without dispatching scanner work, membership identity participates in the input
fingerprint so resolved evidence reopens affected work, and an empty persisted
replay never counts as baseline freshness. See
[ADR-015](../adr/015-point-in-time-replay-candidates.md).

Completed baselines additionally run a prerequisite-driven stage evaluation
(`115-backtest-automation-stages.sql`). COVERAGE is automatic and read-only: it
reports `COMPLETED` only when the completed run carries verified retained-input
evidence; the run-time lineage path owns coverage requests. CALIBRATION and
STRATEGY_STUDY are visible as `NOT_ELIGIBLE` until an explicit authorization
exists and are never launched by automation. TRAINING reports
`WAITING_FOR_EVIDENCE` until the configuration is qualified, after which the
existing learning scheduler remains the only launcher. Stage rows carry an
immutable input identity, reason codes, bounded retry/backoff and terminal
states; a stage failure never rewrites or fails the parent baseline.

Automatic simulated funded replay is policy-gated
(`116-funded-historical-automation-policy.sql`). An approval is an explicit,
revocable record for one immutable profile configuration; it fixes the session
bound, expiry and approver, and derives a dedicated replay account from the
frozen policy hash rather than the market or currency. Without an active policy
the FUNDED_REPLAY stage stays `NOT_ELIGIBLE` and no order or ledger write
occurs. The `FUNDED_HISTORICAL_REPLAY` job re-verifies policy hash, activation,
expiry and experiment scope before executing the same bounded range runner used
by the operator CLI; unresolved exposure stops the range, live funded accounts
are never referenced, and results remain non-promotional. The automation status
read model, `/metrics` `scanner_backtest_automation_*` gauges and the
`BacktestAutomationWorkFailed`/`BacktestAutomationQueueStalled` alerts expose
queue pressure and terminal failures; the Backtest & Studies panel adds
diagnostics and the approval/revocation surface.
