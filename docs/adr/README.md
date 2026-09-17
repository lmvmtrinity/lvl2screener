# Architecture and policy decisions

Reviewed September 8, 2026. Accepted decisions remain constraints even when a later
implementation has limitations. Source behavior is described in the
[baseline](../baseline/README.md); implementation gaps do not silently repeal policy.

## Decision register

| Record                                                                                            | Status and current scope                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [001 — Hybrid Node/Python](001-hybrid-node-python.md)                                             | Accepted: orchestration versus authoritative analytics ownership                                                                                                                              |
| [001 — Market-scoped runtimes](001-market-scoped-runtimes.md)                                     | Accepted: independent CA/US state and evidence                                                                                                                                                |
| [002 — PostgreSQL/TimescaleDB](002-postgres-timescale.md)                                         | Accepted; explicit retention now replaces the original indefinite-signal suggestion                                                                                                           |
| [002 — Versioned market policies](002-versioned-market-policies.md)                               | Accepted: tick/size/cost provenance and native currency isolation                                                                                                                             |
| [003 — REST polling first](003-rest-polling-first.md)                                             | Accepted: broker polling; separate from browser WebSocket                                                                                                                                     |
| [004 — Human-in-the-loop](004-human-in-the-loop.md)                                               | Accepted: no brokerage order submission; paper ledger actions clarified                                                                                                                       |
| [005 — Deterministic strategies](005-explainable-deterministic-strategies.md)                     | Accepted: explainable state/score authority                                                                                                                                                   |
| [006 — Signal reproducibility](006-signal-reproducibility.md)                                     | Accepted: exact input and version lineage                                                                                                                                                     |
| [007 — Supplemental models](007-statistical-models-are-supplemental.md)                           | Accepted; extended by 011; activation implementation limitation documented                                                                                                                    |
| [008 — Paper measurement](008-paper-fills-are-measurement.md)                                     | Partially superseded by 009/010 for storage, fill ownership and explicit rejection/coordination                                                                                               |
| [009 — Authoritative execution](009-paper-bot-authoritative-execution.md)                         | Accepted; current version/16:00 close clarified without rewriting old runs                                                                                                                    |
| [010 — Separate coordination](010-coordinated-portfolio-is-a-separate-projection.md)              | Accepted; funded simulation and shadow research remain separate                                                                                                                               |
| [011 — Learning discipline](011-learning-evidence-and-promotion-discipline.md)                    | Accepted user decision: stable collection, daily checks, full qualification and prospective promotion evidence                                                                                |
| [012 — Durable paper effects](012-durable-paper-effects-and-temporal-reporting.md)                | Accepted: immutable retries, transactional economics, invalidation ordering and explicit reporting time                                                                                       |
| [013 — Documentation and change control](013-evidence-backed-documentation-and-change-control.md) | Accepted: source-backed baseline, portable navigation, preserved evidence and explicit completion scope                                                                                       |
| [014 — Empirical provider conventions](014-empirical-provider-convention-verification.md)         | Accepted user decision: bounded retained verification may replace the provider-support answer for discovery provenance; keep-or-replace gate applies                                          |
| [015 — Point-in-time replay candidates](015-point-in-time-replay-candidates.md)                   | Accepted user decision: per-session historical membership, labeled captured-cohort fallback and explicit empty-candidate waiting; does not claim point-in-time reconstruction for legacy runs |
| [016 — Automatic paper-funded policy control](016-automatic-paper-funded-policy-control.md)       | Accepted at Stage A on 2026-09-15: authority-disabled, dependency-gated implementation only; Stage B policy approval and Stage C running-stack activation remain withheld                     |

[017 — Discovery feed feasibility and valid-decision acceptance](017-discovery-feed-feasibility-and-valid-decision-acceptance.md)
is accepted under the September 15 delegated decision: bounded provider-specific
proposal authorized; prospective 0.99 valid-decision gate adopted, enforcement
pending. Provider collection and activation remain separately gated.

## Legacy numbering

Two independent additions used numbers 001 and 002. Filenames and numbers are
preserved to avoid breaking historical references; use the full title and path for
those four records. They are distinct accepted decisions, not superseding versions
of each other. New ADRs must use an unused number and update this register.

## Updating a decision

Record the date, scope, rationale and consequences of an authorized change. State
which clauses are superseded and link both directions. Do not rewrite historical
assumptions as if they always matched current code. Routine documentation
clarifications do not authorize deployment, profile activation or policy changes.
