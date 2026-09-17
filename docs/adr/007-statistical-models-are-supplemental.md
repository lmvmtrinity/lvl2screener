# ADR-007: Statistical Models Are Versioned Supplements

**Status:** Accepted

## Context

Accumulated replay and forward paper evidence can support setup ranking and
probability calibration, but opaque or weakly validated outputs could undermine
the scanner's explainable deterministic safety boundary.

## Decision

Statistical models are optional, immutable projections over deterministic
strategy evaluations. Python owns training and inference. An artifact has
exactly one immutable evidence source: either a completed captured-history
backtest or a frozen `PAPER_EVIDENCE` dataset. Paper evidence uses only
completed LIVE canonical `QUOTE` executions, isolated by strategy/version,
profile configuration/version, execution-model version, and assumptions
snapshot. `CANDLE`, no-fill, and unresolved outcomes do not enter this source.

Every artifact records chronological validation, feature order, coefficients,
normalization, imputation, metrics, and its immutable source provenance.

Activation is manual and requires adequate samples, both outcome classes in train and holdout, and holdout Brier improvement over a training-segment base-rate forecast. Only one artifact may be active per strategy.

Policy-driven automation may materialize a new paper-evidence dataset and
enqueue an inactive challenger after the configured evidence and new-outcome
thresholds are met. It cannot activate, replace, disable, recalibrate, or
otherwise alter a model or profile. Idempotency is keyed to the frozen dataset
digest.

## Constraint

A statistical model cannot create or suppress `READY`, modify deterministic score or reason codes, trigger alerts, or change entry/stop/target references. Missing or insufficient evidence must yield no deployable model.

When an active model scores an observed paper setup, its model/version, inputs,
and prediction may be persisted as an immutable observational snapshot. This is
for later calibration monitoring only; recording failure cannot block paper
observation capture or execution, and a snapshot has no execution path.

## Consequences

- probability ranking and false-breakout estimates remain auditable
- no-look-ahead and reproducibility extend to model research
- deterministic behavior remains stable when models are absent, inactive, or unavailable
- model expressiveness is intentionally limited until evidence supports greater complexity
- forward calibration can be evaluated from the prediction made at observation
  time rather than recalculating a later model against past outcomes

## September 8, 2026 clarification

[ADR-011](011-learning-evidence-and-promotion-discipline.md) extends the promotion
policy with stable collection, daily checks and prospective comparison before
explicit authorization. These policy requirements exceed the current executable
activation gates. The schema's one-active-model-per-strategy index remains global;
market/cohort-scoped replacement logic does not establish independent simultaneous
activation for each market. See [learning](../baseline/learning.md).
