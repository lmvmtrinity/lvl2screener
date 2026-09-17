# Data model

Reviewed against migrations through `096-execution-diagnostics.sql`
on September 10, 2026. This is a relationship and invariant guide, not an alternative
DDL definition. Exact columns, constraints and indexes live in
[database/init](../../database/init/); read subsequent ALTER statements as well as
CREATE statements. Applied migrations are checksum-protected and must not be edited.

## Domain map

| Domain                  | Principal tables                                                                                                                                                                                                           | Ownership and meaning                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Instruments and intake  | `instrument`, `universe_watchlist`, `universe_refresh_run`, `universe_membership`                                                                                                                                          | Market-resolved instruments, dated manual list, refresh decisions and coverage                      |
| Broker auth             | `market_data_auth`                                                                                                                                                                                                         | Mode-specific encrypted rotating refresh token and concurrency version                              |
| Market history          | `quote_snapshot`, `candle`, `feature_snapshot`                                                                                                                                                                             | Timestamped inputs and complete versioned feature payloads                                          |
| Profiles                | `strategy_definition`, `scanner_profile`, `scanner_profile_config`                                                                                                                                                         | Registry definition, mutable operational metadata, immutable parameter versions                     |
| Strategy evidence       | `strategy_evaluation`, `context_evaluation`, `strategy_signal`, `strategy_state_event`                                                                                                                                     | Shared feature identity, exact profile/config, setup lifecycle and context                          |
| Alerts                  | `scanner_alert`, `scanner_alert_policy`                                                                                                                                                                                    | Deduplicated transitions and alert delivery policy                                                  |
| Independent paper       | `paper_bot_run`, `paper_signal_observation`, `paper_execution`                                                                                                                                                             | Run assumptions, observed lifecycles, QUOTE/CANDLE execution states                                 |
| Coordinated paper       | `paper_portfolio`, `paper_coordination_decision`, `paper_coordination_position`                                                                                                                                            | Durable market portfolio, selection evidence and separate positions                                 |
| Funded paper            | `paper_entry_order`, `paper_funded_account`, `paper_funded_event`, `paper_funded_fact`                                                                                                                                     | Pending orders/reservations, simulated cash ledger, durable effect history and retry inbox          |
| Temporal funded reports | `paper_funded_run_snapshot`, `paper_entry_order_history`                                                                                                                                                                   | Proven run-end/as-of boundaries and order history                                                   |
| Backtests/calibration   | `backtest_run`, `backtest_trade`, `backtest_state_event`, `calibration_run`                                                                                                                                                | Captured replay lineage, outcomes and controlled research                                           |
| Ranking                 | `ranking_formula`, `ranking_research_run`                                                                                                                                                                                  | Deterministic baseline and dormant research projections                                             |
| Learning                | `statistical_training_dataset`, `statistical_model`, `paper_model_prediction_snapshot`, `learning_automation_run`, `challenger_experiment`, `challenger_experiment_transition`, `challenger_attempt`, `challenger_outcome` | Frozen source, artifact, active snapshots, prospective inactive observation and scheduler audit     |
| Qualification           | `paper_profile_qualification`                                                                                                                                                                                              | Versioned derived qualification; never an overwrite of source evidence                              |
| Operations              | `research_job`, `research_manifest`, `research_coverage_report`, `research_evidence_binding`, `research_evidence_work`, `research_evidence_work_receipt`, `retention_job_run`, `observability_retention_policy`            | Durable research jobs, immutable coverage/lineage, bounded automation receipts and retention policy |

## Identity and provenance

Market-sensitive rows retain `market_id`. Instruments have a market/symbol identity
and compatible native currency; CA and US financial/evidence records cannot be
pooled. Quote/candle ownership resolves through instrument identity. `ALL` is not
a stored market value.

Profiles advance `current_config_id` to a new immutable configuration when
parameters change. Many evaluations reference the same feature snapshot. Signal
and event payloads preserve exact inputs, strategy/config versions, reason codes
and setup instance identity; formation evidence retains the bars and levels bound
by the strategy. Unknown legacy provenance must remain unknown.

Feature snapshots generated with identity `1.2.0` may include nullable confirmed
swing-level provenance: a stable level identity, its origin bar end and the later
bar end at which the level became available. Legacy `1.1.0` snapshots remain
unchanged and parse with unknown provenance. This JSON enrichment does not require
a relational migration or historical backfill; price, strength, confluence, stop
selection and strategy-state semantics remain unchanged.

Automated paper evidence is its own record. Execution state advances
through its lifecycle, but historical economic inputs and source identity are not
rewritten to improve results. Corrections use explicitly versioned new evidence.
`REJECTED_ECONOMICS`, `NO_FILL`, unresolved positions and closed trades are different
outcomes. The QUOTE model is canonical for paper learning; CANDLE is diagnostic.

Coordinated portfolios enforce unresolved-position ownership across runs. Funded
paper adds durable account/run bindings, order reservations, shared liquidity,
ordered ledger effects and an inbox. Effects commit before fact acknowledgement;
retries must reuse them exactly once. Snapshot compaction removes only duplicated
snapshot history, not durable ledger events. See the funded invariants in
[AGENTS.md](../../AGENTS.md).

## Research and model storage

`research_manifest` preserves the declared research input identity. The immutable
`research_coverage_report` records per-member, per-session and per-benchmark
coverage; `research_evidence_binding` binds a verified report to one job, run,
dataset or model and cannot be replaced. A missing binding is legacy/unverified,
not evidence that inputs were complete. `research_evidence_work` owns one
content-addressed automation identity and its append-only receipt table prevents
unchanged polling from creating duplicate work. CA_TSX and US_EQUITIES remain
separate at every relation.

A statistical artifact has one source: a completed captured-history backtest or
frozen PAPER_EVIDENCE dataset. A dataset stores compatible cohort identity, cutoff,
rows, digest and research qualification. Prediction snapshots record the model and
inputs available at observation time; they do not rewrite deterministic evaluations.

Migration 095 adds the separate inactive-challenger path. `challenger_experiment`
is an immutable registration containing the model/artifact hash, market/currency,
exact scope, evidence binding, baseline and acceptance-plan identities, future
window and hard inference lag. `challenger_experiment_transition` is append-only;
the active intervals are reconstructed from database-clock transition times.
`challenger_attempt` stores the original input snapshot, model version and fixed
deadline. `challenger_outcome` stores one immutable terminal result. New
`paper_signal_observation` rows receive `captured_at` from PostgreSQL
`clock_timestamp()`; legacy rows remain NULL and cannot be reconstructed into
challenger predictions. Optional challenger capture runs in a savepoint so an
observer failure cannot roll back the authoritative paper observation.

Model source and market guards are enforced by migrations 042 and 059. The schema
still contains the global one-active-model-per-strategy index introduced in 012;
activation replacement logic is narrower, using target market/cohort. Do not claim
independent simultaneous per-market/per-cohort activation is supported. This
limitation needs a separately scoped code review before promotion across those
boundaries; this documentation audit changes no activation behavior.

## Retention

The scheduled pruning function reads `observability_retention_policy`. Migrations
028/029 establish the corrected daily job; 054 shortens high-frequency strategy
retention. The migration-defined values are:

| Data                  | Days | Important exception                                                 |
| --------------------- | ---: | ------------------------------------------------------------------- |
| Quote snapshots       |  180 | Deleted history cannot be replayed without a retained backup/export |
| Candles               |  365 | Applies to candle history, not indefinite daily/5m retention        |
| Feature snapshots     |  180 | Referenced parents survive where guarded by the prune function      |
| Strategy evaluations  |   14 | Changed from 90 by migration 054                                    |
| Strategy signals      |   14 | Surviving event references protect required rows                    |
| Context evaluations   |   30 | Pruned before parent features                                       |
| Strategy state events |   90 | Surviving alert references protect required rows                    |

Retained paper evidence, configurations and research artifacts are
not targets of this scheduled prune. Indefinite outcome retention does not preserve
all raw data needed to reconstruct the outcome. Verify effective policy values and
job results in a deployment before making a coverage claim. See the
[runbook](operations-runbook.md) for backup/retention operations.

## Discovery provider foundation (084)

`questrade_request_budget` and `questrade_request_grant` belong to a broker identity,
not a market; database-time grants serialize its shared provider allowance.
`discovery_catalog_cache`, `discovery_catalog_attempt` and `discovery_symbol_mapping`
retain current per-market catalog/mapping inputs and safe provider failures. They
are not historical discovery membership or evaluation evidence.

Migration `085-discovery-evidence.sql` adds immutable policy definitions, captured
catalog snapshots/members, market-scoped runs and immutable per-symbol results.
Composite foreign keys bind results to their run, policy and captured catalog
identity. Full input payloads are separate from result/digest records so compaction
does not rewrite decisions. Explicit evidence holds protect retained inputs.
`PostgresDiscoveryEvidenceStore` atomically records inputs/results, serializes run
completion and materializes missing members as deferred with reconciled coverage.
Its bounded compaction defaults to 30 calendar days for inputs and 365 days for
terminal run summaries; unfinished runs and held evidence survive. Compaction is
not scheduled yet. No discovery membership, outbox or automatic intake exists;
see the discovery plan.

Migration `086-discovery-shadow-control.sql` adds PostgreSQL-owned
`discovery_mode` and audited compare-and-swap revisions, plus
`discovery_schedule_lease` with database-time expiry and owner/fencing
generation. Scheduled shadow result writes and completion require the current
lease; preview uses a separate shadow-only identity. The scheduler and read-only
discovery views are implemented, but automatic membership, outbox delivery and
exclusions remain WP5 work. Discovery is OFF by default.
