# Product specification

Reviewed against source on September 10, 2026. This describes implemented capability;
it does not certify the running deployment or a profitable strategy.

## Purpose and trading boundary

The scanner helps a human find and assess explainable intraday opportunities in
TSX equities (`CA_TSX`, CAD) and US equities (`US_EQUITIES`, USD). It may return
zero opportunities. Real brokerage trading remains manual. Questrade supplies
market data; the application does not read brokerage holdings or submit orders.

Automated paper entries and exits are simulations. Independent strategy evidence,
the coordinated shadow portfolio, and opt-in funded paper accounts are distinct
records. “Funded” means a simulated account with cash and reservation
constraints, not a funded brokerage account.

## Operator workflow

1. Select a market and paste or edit the day's candidate list. Mixed-symbol paste
   resolves each supported instrument to its market.
2. Inspect per-symbol resolution, warm-up, freshness, and unavailable reasons.
3. Review deterministic setup state, score components, references, and benchmark
   context. Every enabled profile uses the shared market inputs.
4. Review READY/invalidation alerts and make real trade decisions manually.
5. Use Bot Performance for simulated positions and outcomes.
6. Use Strategy Lab for versioned profiles and research; use Learning for evidence
   readiness, automation history, model lifecycle, and shadow experiments.

The daily list is persisted and scoped to the trading date. Reference universe
screening metrics do not silently remove valid manually supplied names. Automatic
external-catalog discovery is under implementation,
not an enabled substitute for manual intake.

## Markets and sessions

CA and US have separate universes, benchmarks, calendars, evidence, and native
currency books. `ALL` is a read-only display scope and cannot pool CAD/USD balances.
US data and paper execution have separate configuration gates; shipped defaults
are not evidence of a deployment's effective settings or operator approval.

The default opening range is 09:30–09:45, scanning 09:45–16:00, preferred entry
10:00–11:30, and hard entry cutoff 16:00 in the market timezone. Profiles may bind
an entry window. Outside the preferred window, READY can remain valid until the
hard cutoff. See [strategy rules](strategy-spec.md) and the
[paper lifecycle](paper-execution.md) for the separate exit boundary and limitations.

## Setups and context

The registry implements ORB Retest, VWAP Hold, VWAP Reclaim, High-of-Day Breakout,
Bull Flag, Prior-Day-High Breakout, and experimental RSI/VWAP Reclaim. Registry
availability is not profile activation or proof of an edge. RSI and optional
retest/daily-EMA experiments require explicit profile selection.

Setup states are `INACTIVE`, `WATCH`, `FORMING`, `READY`, `INVALIDATED`, `EXPIRED`,
`HALTED`, and `DATA_STALE`. Score cannot create READY. Market- and sector-relative
strength use a separate context contract (`UNAVAILABLE`, `STALE`, `WEAK`,
`NEUTRAL`, `STRONG`) without entry, stop, target, or trade alerts.

Formation markers use retained records and exact state-event timestamps. Origin
annotations do not backdate eligibility; unavailable provenance remains unknown.
Current VWAP is a snapshot reference, not a historical curve. The Detail chart
may explain retained RSI/retest evidence, but it does not turn a latest evaluation
into an earlier state transition.

## Evidence and learning

Independent observations measure eligible strategy lifecycles; the coordinated
projection measures a constrained simulated portfolio. Their totals are never
added together. Open and close-pending rows are unresolved, not realized P&L or
training labels. Missing fills and economic rejections remain visible.

Learning checks run at worker startup and daily at 17:00 America/New_York by
default. A check can validly produce NOOP. Training freezes qualified evidence
and creates an inactive challenger. [ADR-011](../adr/011-learning-evidence-and-promotion-discipline.md)
requires stable baseline collection, full qualification, prospective comparison,
and explicit authorization before promotion. A quota or successful training job
does not establish trading value.

## Non-goals and acceptance

There is no automated brokerage execution, short selling, derivatives, crypto,
OTC/TSXV/CSE scanning, extended-hours strategy execution, pooled FX accounting,
or LLM buy/sell authority. Models supplement deterministic evaluations.

Code tests, paper observations, and production commissioning are different forms
of evidence. Outstanding provider, soak, receiver, and hardware checks remain in
WIP and [deployment acceptance](../operations/paper-bot-deployment-acceptance.md).
