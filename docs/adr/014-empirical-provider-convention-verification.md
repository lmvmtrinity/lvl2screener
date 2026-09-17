# ADR-014: Empirical verification for provider data conventions

**Status:** Accepted user decision, September 10, 2026, in the context of the
discovery production-unblock work. Scope is limited to establishing discovery
calendar and adjustment provenance. No trading, execution, learning or
activation policy is changed.

## Context

The automated candidate discovery plan
required an authoritative session calendar and a provider-confirmed candle
adjustment convention before the discovery input flags could be marked
verified. Questrade support has not answered the adjustment/revision question,
and the September 10 review reverted earlier unverified claims. A full provider
migration was considered but rejected for now because it would introduce new
feed, identity and volume-comparability questions while calendar and
commissioning work is outstanding.

The user chose to keep Questrade for live data and EODHD for independent
reference evidence, and to accept a bounded empirical verification instead of
indefinitely waiting for a provider answer.

## Decision

- Provider data conventions may be established by retained empirical
  verification against independent corporate-action evidence, in place of a
  vendor support answer, when the sample set and acceptance criteria are
  predeclared, repeated snapshots are retained, and revision detection plus
  affected-baseline invalidation are implemented.
- Input provenance flags remain unverified until the predeclared protocol
  passes. Failures and limitations are recorded and cannot be re-scoped or
  tuned away after results are seen.
- A firm stop condition governs whether Questrade history is retained; if it
  triggers, Questrade history is replaced and a candidate provider is evaluated
  under the same protocol before any integration.
- A paid catalog subscription is not sufficient evidence of suitable history.
- The plan that implements this decision is the
  discovery production unblock plan.

## Consequences

[ADR-017](017-discovery-feed-feasibility-and-valid-decision-acceptance.md) authorizes
a subsequent provider-specific feasibility proposal, without authorizing a new
empirical protocol or reopening the stopped US verification. The adjustment
verification rules in this ADR remain in force.

- The provider-support dependency becomes an executable, time-boxed acceptance
  project with retained evidence and an explicit keep-or-replace gate.
- Calendar provenance still requires an authoritative, versioned source; the
  empirical method covers adjustment and revision behavior, not holiday
  schedules.
- No threshold, formula, policy-version or evidence-pooling rule changes, and
  no activation authorization follows from a passing verification.
- A replacement provider, if selected, requires its own plan and separate
  authorization.
