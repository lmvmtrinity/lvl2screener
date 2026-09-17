# ADR-009: The Paper Bot's Execution Model Is Authoritative and Separately Stored

**Status:** Accepted

## Context

ADR-008 established that an automated paper filler may open and close
simulated trades without human action, sharing its fill logic with the
existing backtest and journal code paths, and writing rows marked
`origin = 'AUTO'` into `journal_trade`.

The paper-trading-bot plan (private development record) goes further than
ADR-008 anticipated in three ways that ADR-008 did not resolve:

1. Automated evidence needs a richer, immutable record — per-model (quote and
   candle) executions, decision-time market snapshots, size coverage, and a
   versioned assumptions snapshot — that does not fit `journal_trade`'s manual
   journal contract without either overloading it or eroding the human record
   it protects.
2. Historical replay (the backtester) and live paper execution currently
   implement fill logic independently. Divergence between them is not
   discoverable, and forward results cannot be trusted against a historical
   baseline that was never proven to compute fills the same way.
3. `journal_trade`'s manual semantics (a user's own record of trades they
   placed) and the bot's automated semantics (a versioned measurement
   instrument) have different retention, correction, and consistency
   requirements. Storing both in one table forces the weaker discipline onto
   both.

Left unresolved, either the paper bot's evidence continues writing into
`journal_trade` under increasingly strained semantics, or the backtester and
live paper execution continue to drift apart, silently.

## Decision

This ADR supersedes ADR-008's storage location and fill-ownership
clauses. ADR-010 further clarifies economic rejection and separate coordination. ADR-008's execution boundary — that the paper filler is measurement,
not automation, and has no broker write path — is unchanged and remains
accepted.

1. **Separate, immutable storage.** Automated evidence lives in dedicated
   paper-bot tables (`paper_bot_run`, `paper_signal_observation`,
   `paper_execution`), not in `journal_trade`. Rows are immutable snapshots:
   corrections create a new versioned run rather than rewriting observed
   history. `journal_trade` and its manual-journal contract are unchanged.
2. **The live bot's execution model is authoritative.** The versioned
   execution specification implemented for live paper trading — quote
   matching, slippage, the versioned session-close boundary, `NO_FILL` conditions, and
   financial calculation — is the single definition of what a fill is. It is
   not derived from, or reconciled after the fact with, the backtester.
3. **Historical replay invokes the same execution model.** The backtester
   stops implementing fill simulation independently
   (`services/scanner/app/backtest.py`'s `_simulate_trades`) and instead
   replays captured state events and quote/candle history through the same
   shared execution core the live bot uses. Forward and historical results are
   comparable only because they are computed by the same code, not because
   they were designed to resemble each other.
4. **The manual journal remains a separate, user-created record.** Nothing in
   this decision changes what a user records by hand in `journal_trade`, how
   it is displayed, or how it is retained.

Every live run, observation, historical run, and aggregate carries an
`execution_model_version` and an immutable assumptions snapshot. A rule change
creates a new version; it never silently reinterprets accumulated evidence.
Legacy backtest runs that predate this decision keep a `NULL`
`execution_model_version`, remain readable, and are never treated as
comparable to versioned runs.

## Constraint

This decision does not relax ADR-004, ADR-005, ADR-006, or ADR-007. The paper
bot still consumes deterministic `strategy_state_event` output, cannot create
or modify signals, scores, or reference levels, and has no path to place or
stage a broker order. Statistical artifacts trained on pre-migration fill
outcomes are not retroactively treated as authoritative; they are deactivated
and, where the underlying data is reproducible, retrained against a
re-executed run under the new model.

## Consequences

### Positive

- Forward and historical evidence are computed by one execution definition,
  which reduces implementation drift; differences still require checking coverage,
  market regime, execution assumptions and statistical uncertainty before inferring
  edge decay.
- The manual journal's simpler, human-authored semantics are protected from
  the volume and correction rules automated evidence requires.
- Every historical artifact's execution provenance (`execution_model_version`,
  or `NULL` for legacy) is explicit and queryable, rather than assumed.

### Negative

- Existing statistical models, evidence qualifications, and ranking studies
  built on the retired fill logic must be re-derived or explicitly retired
  before forward evidence can be compared against them (tracked as Phase 4a of
  the archived paper-trading-bot plan).
- The backtester loses its independent fill implementation; a defect in the
  shared execution core now affects both live and historical results, so the
  core's test coverage carries more weight than either implementation carried
  alone.
- Some historical runs cannot be re-executed under the new model because their
  replay inputs or raw quotes were never retained or have since expired; their
  dependents must be explicitly marked non-reproducible rather than silently
  carried forward.

## September 8, 2026 implementation clarification

Current authoritative identity is `paper-execution-v7`. API and authoritative replay
wiring use a 16:00 local close assumption; legacy noon-named fields and earlier
run snapshots remain. A close request can stay unresolved without admissible facts
or liquidity. See [paper execution](../baseline/paper-execution.md). Python still
contains legacy replay endpoints; the authoritative path uses Python signal replay
and the shared TypeScript executor. This clarification does not rewrite old runs
or authorize a new exit policy.

## September 14, 2026 scope note

The manual paper journal was removed as a feature: its page, `/api/journal`
routes, contracts, service and repository are gone, and migration
`119-drop-manual-journal.sql` drops `journal_trade`. Its references in the
original Decision and Consequences text above are historical. The decision this
ADR records is unchanged: automated paper evidence is stored and corrected
separately from any user-entered data, and the paper filler has no broker write
path.
