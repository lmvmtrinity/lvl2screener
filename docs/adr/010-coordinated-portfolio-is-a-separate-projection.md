# ADR-010: The Coordinated Portfolio Is a Separate Projection

**Status:** Accepted

## Context

ADR-009 made the paper bot's execution model authoritative and gave automated
evidence its own immutable tables. What it did not settle is what the bot
*is*: it observes every eligible `READY` lifecycle from every profile and
opens an independent execution for each. That is exactly right for unbiased
per-strategy evidence, and exactly wrong as a model of how a single
cooperating account would have traded — one account cannot hold six
overlapping positions in the same symbol, re-enter immediately after a stop,
or size every setup as if no other position existed.

Two failure modes follow from leaving this unresolved. Reading the
independent totals as portfolio performance overstates what a real account
could have achieved. Filtering the independent executions down to a
portfolio's worth of trades destroys the unbiased sample that strategy
qualification depends on, and does it invisibly.

A second conflation sits underneath: a setup whose modeled target cannot
cover its own friction was being recorded as `NO_FILL`, the same outcome used
when the market was halted, stale, or missing. One is a decision the bot made;
the other is data it never had. Merging them makes both uninterpretable.

## Decision

1. **Two projections, never summed.** The independent projection keeps one
   execution per observed strategy lifecycle and remains the only input to
   profile qualification. The coordinated projection
   (`paper_coordination_decision` → `paper_coordination_position`) makes one
   auditable decision per symbol using all current strategy states, context,
   economics, cooldowns, and portfolio limits. Their P&L figures are reported
   on separate surfaces and are never combined into one number.
2. **Coordination filters nothing upstream.** Every candidate the coordinator
   considered, rejected, or deferred is persisted with its rank, reasons, and
   the exposure and context state it was judged against. The coordinator
   cannot suppress, alter, or delay an independent observation or execution,
   and never touches strategy state.
3. **A declined trade is not a missing market.** `REJECTED_ECONOMICS` with a
   stable reason code and a persisted snapshot of every gate input and
   threshold records a market the bot could have traded and chose not to.
   `NO_FILL` remains reserved for unavailable or non-executable market data.
4. **Context can veto, never lead.** Market and sector signals form their own
   strategy family. They may confirm, reduce priority, or withhold a
   coordinated entry; they can never be the primary setup, and an inapplicable
   context reading is neutral rather than bearish.
5. **Cost and policy changes create a version, not a reinterpretation.** The
   economic gate, the cost-inclusive R definition, and the coordination policy
   each carry a version (the original decision used `paper-execution-v3`,
   `paper-economics-v1`, `paper-coordination-v2`; these are historical identities,
   not the current deployment defaults). Cohorts from different versions are reported
   separately and are never merged without an explicit comparison.

## Constraint

This decision does not relax ADR-004 or ADR-008: the coordinated projection is
still measurement, has no broker write path, and runs in shadow beside the
independent evidence. Promotion of a coordination policy requires
chronological replay plus out-of-sample forward evidence under conservative
slippage, not a single session's results.

## Consequences

### Positive

- The question "what would one account have made?" and the question "does
  this strategy have an edge?" get separate, honest answers instead of one
  misleading one.
- Every coordinated suppression is visible and attributable, so coordination
  cannot introduce silent selection bias into qualification data.
- Rejections carry their own inputs and thresholds, so a policy can be
  re-derived and back-tested rather than merely believed.

### Negative

- Two projections mean two sets of totals, and a reader who ignores the
  labelling can still misread them; the separation is enforced in storage,
  API, and dashboard, but not in the reader's head.
- Coordinated evidence accumulates far more slowly than independent evidence —
  one decision per symbol, gated by exposure and cooldown — so its statistical
  power lags, and promotion decisions must wait for it rather than borrowing
  significance from the independent sample.
- The economics gate necessarily declines trades that would sometimes have
  won; the rejection records make that cost measurable, not zero.

## September 8, 2026 implementation clarification

The separate opt-in funded paper ledger now models cash, reservations, pending
orders and durable recovery. It does not replace independent strategy evidence or
make either shadow portfolio a brokerage account. Model-informed coordination
experiments remain separately identified shadow research and cannot authorize
promotion. See [paper execution](../baseline/paper-execution.md) and
[ADR-011](011-learning-evidence-and-promotion-discipline.md).
