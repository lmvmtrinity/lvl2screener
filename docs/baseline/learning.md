# Learning and evidence lifecycle

Reviewed against source on September 8, 2026. [ADR-011](../adr/011-learning-evidence-and-promotion-discipline.md)
is the accepted collection and promotion policy; agents must preserve it.

## Collection is not training

```text
Candidates → setup observations → executable fills → closed outcomes
           → completed LIVE runs → compatible evidence groups
           → chronological qualification and purging → frozen dataset
           → training job → inactive challenger → prospective evaluation
           → explicit authorized promotion, if justified
```

The pipeline does not train on every quote or candidate. Only CLOSED canonical
QUOTE executions with usable outcomes from completed LIVE paper runs enter the
paper source. CANDLE outcomes, open/close-pending positions, no-fills and economic
rejections are excluded. Today's running session may contain closed trades while
still contributing no eligible completed-run evidence.

Groups preserve market, strategy/version, profile/configuration/version,
execution-model version, assumptions, signal-semantics version and replay/evidence
scope. Duplicated or overlapping samples cannot be pooled to reach a quota.

## Qualification gates

`paper-evidence-qualification.ts` currently requires:

- at least 200 rows in the final purged chronological partition;
- at least four distinct market-local sessions;
- at least 100 training rows and 40 holdout rows, with both positive and
  non-positive outcomes in each;
- three walk-forward test windows, each with at least 30 test rows and positive
  test expectancy;
- known instrument and signal/scope provenance, valid signal/label ordering,
  labels available by the cutoff, and overlap/boundary purging.

The final split uses whole session dates (80% training by default), purging train
labels unavailable before the first holdout signal. A later overlapping signal on
one instrument is excluded while the earlier label remains unresolved.

The scheduler first checks 200 closed quotes and both classes, then performs full
qualification. After a previous frozen dataset, it checks a 50-new-outcome delta
using the cohort count and previous source-row count. Dashboard count readiness
is only the first gate; “COUNTS MET” is not full research qualification.

## Schedule and audit

`worker.ts` checks at startup and daily at 17:00 America/New_York, adjusting for
DST. `PAPER_MODEL_TRAINING_ENABLED` defaults true. Empty/unset
`PAPER_MODEL_TRAINING_CHECK_MS` selects the daily schedule; an explicit integer
interval of at least one hour uses legacy interval scheduling. Do not set that
override or disable checks merely to change the accepted pace.

Checks do not overlap within one worker. A successful no-work check records NOOP;
a queued job and a trained model are separate states. Scheduler audit is stored in
`learning_automation_run`; an audit write failure is caught in the scheduler, so
missing audit rows alone cannot establish that no check ran. Correlate worker logs,
job state and dataset creation when diagnosing ingestion.

The dashboard reports materialized PAPER_EVIDENCE datasets, not the number of
cohorts. It exposes configuration identity and distinguishes models, active models,
research jobs, automation outcomes and shadow coordination decisions.

## Training and promotion

Training runs in Python through durable worker jobs, persisting a regularized
logistic artifact with training-only normalization/imputation, chronological metrics
and calibration. Sources are frozen paper datasets or supported completed
captured-history backtests with authoritative execution provenance. Insufficient
or failed research remains a recorded result.

Manual activation has executable source/sample/holdout gates, including Brier
improvement over the training-base-rate predictor. The schema currently also has
a global one-active-model-per-strategy constraint; see [data model](data-model.md).
Automation cannot activate a challenger or change deterministic strategy rules.

ADR-011 additionally requires a predeclared prospective comparison against the
unchanged baseline using observation-time predictions and realistic execution/cost
constraints. That full policy is an agent/operator rule, not a claim that every
prospective promotion criterion is already enforced in code. Existing forward
monitoring of active-model snapshots does not by itself implement a full inactive
challenger experiment.

The planned inactive-challenger observation package
addresses explicit enrollment, immutable timely prediction attempts and failure
denominators. It is not implemented by this documentation update and does not
activate a model or change the accepted promotion rule.

Review collection quality weekly and re-estimate sample timing after 5–10 completed
sessions. No recurring notification is created by this documentation. Neither 200
observations nor a fixed number of weeks guarantees a trainable or useful model.
