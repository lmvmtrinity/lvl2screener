# ADR-017: Discovery feed feasibility and valid-decision acceptance

**Status:** Accepted September 15, 2026, through the user's delegated request to
make the DR-02/DR-03 next-step decision. This authorizes the bounded proposal below
and adopts a prospective commissioning requirement. Application enforcement is
implemented locally in `37e2a97`; deployment is not established here. The subsequent
Stage A decision below narrowly authorizes one provider probe; deployment and
activation remain unauthorized.

## Subsequent decision: one CA Stage A attempt

Following review of the corrected proposal, the user's delegated next-step
decision authorizes **one CA_TSX REST-only capability attempt** under
execution plan section 15.10.6.
The executing agent must freeze the exact five-symbol cohort, session date and
boundary before calling the provider, preserve shared budget/token ownership,
and implement the specified dispatch, first-error stop and expiry rules.
No further design approval is needed when these preconditions are met. If they
cannot be met, retain a blocked result and notify the user without making calls.

This narrowly supersedes the original no-new-provider-calls restriction below
for this attempt only. It does not reopen the US adjustment protocol, authorize
streaming, change budgets, authorize Stage B or establish adjustment provenance.
Failed/expired attempts do not authorize automatic repetition. The result is
access/availability evidence, not commissioning or full-catalog capacity proof.
No probe or schedule was executed by the decision-recording task.

## Context

The completed capacity investigation
and staged feasibility analysis establish limits of the current REST pipeline.
They do not prove a compatible $0 full-catalog current feed or the population
exclusion rates needed by the staged alternative. Repeating the synthetic fixture
or increasing worker concurrency alone cannot establish either capability.

The commissioning report currently measures valid decisions separately but can
pass its coverage gate when all evaluated admitted rows are `UNEVALUABLE`.
Correctly recording unknown outcomes is necessary but does not establish useful
screening coverage. Zero opportunities remains a valid result when backed by
valid `FAIL` decisions.

## Decision 1: Authorize a bounded provider/data-architecture proposal

Proceed now with a provider-specific proposal using existing retained evidence,
read-only local configuration and current primary provider documentation. Reuse
the completed fixture and capacity report; do not reopen their completed work.
Assess the existing accessible path first, then at most three credible alternatives.
The additional-provider budget remains **$0**.

For each candidate, record:

- Separate CA and US instrument coverage, account entitlement, API access, costs
  and permitted retention. A free website quote or advertised tier is not proof
  of usable API access for this account and workload.
- Fresh quotes meeting both existing observation/trade timestamp rules, completed
  five-minute bars, original observation identity, adjustment provenance,
  revisions and invalidation. Mark each unsupported capability unproven.
- Market-specific and combined capacity under the unchanged 120-second and
  30-second-freshness requirements, shared request limits, recovery load and
  active-monitoring protection. Cover the full frozen admitted population and
  account separately for structural exclusions; do not assume unmeasured pruning.
- The proposed collection/storage/evaluation boundaries, restart recovery and
  exact missing evidence. Existing captured data may demonstrate reproducibility
  or replay but cannot prove current live freshness.

Deliver one recommendation with an evidence table and a clear disposition:
either a credible $0 candidate ready for a separately authorized bounded test,
or no proven $0 candidate and the smallest specific entitlement, cost or scope
decision needed. Do not claim that all zero-cost solutions are impossible merely
because the assessed candidates are unproven. Do not purchase or change scope.

A provider support response is not the sole route to evidence. Use documented
contracts, existing entitlement evidence and, when separately authorized, a
predeclared empirical protocol. The proposal may draft that protocol with exact
endpoints, market/account scope, sample counts, request caps, time window,
acceptance criteria, evidence identities and stop conditions; it may not execute
it. No external messages, new provider calls, collector activation, durable
preparation prototype or provider integration are authorized by this decision.

[ADR-014](014-empirical-provider-convention-verification.md) continues to govern
empirical adjustment verification. It does not provide blanket authorization for
a new capacity or replacement-provider protocol. The retained US protocol STOP
and disabled legacy collector remain binding. DR-02/DR-03 proposal work is
unblocked; production pipeline implementation remains stopped pending feed and
feasibility evidence.

## Decision 2: Adopt the 0.99 valid-decision gate prospectively

Future commissioning requires, for every scheduled discovery cycle in each
market's declared acceptance window:

`validDecisionCoverageFraction = (admitted PASS + admitted FAIL) / admittedCount >= 0.99`

- Use the frozen admitted denominator already defined by the
  commissioning protocol.
  Missing quotes, history, provenance, mappings or calendar facts do not remove
  members. Unknown/deferred/expired/cancelled outcomes do not count as valid.
- Preserve exact result semantics and reason codes. Do not convert unknowns to
  `FAIL`, invent early rejections or relax strategy rules to meet the gate.
  Genuine unavailable inputs can therefore keep commissioning blocked.
- Do not pool markets or average good cycles over failing cycles. Empty
  denominators, missing scheduled runs and incomplete evidence cannot pass.
  Account for every catalog member, including structural exclusions.
- Keep existing evaluated coverage, latency, freshness, monitoring impact,
  provenance, calendar, parity and session/restart gates. This requirement is
  additional and does not demand any positive `PASS` count.
- Apply the decision prospectively with a recorded acceptance-policy identity.
  Preserve historical reports unchanged; any reassessment must be separately
  labeled with the new criterion.

The next implementation package may add the explicit valid-decision gate to the
commissioning report's `passed` calculation and relevant consumers. Verify the
0.99 boundary, a value below it, all-UNEVALUABLE coverage, empty/missing evidence
and market/cycle isolation. Record the code revision and enforcement status.
Until that change is verified and deployed, the existing report's `passed` value
does not establish acceptance under this ADR. This ADR itself changes no code.

## Sequence and remaining gates

1. **Now / outside market hours:** produce the bounded proposal and implement/test
   the report gate locally. Prepare an executable measurement plan for a credible
   candidate; name unresolved capabilities rather than repeatedly collecting
   evidence that cannot resolve them.
2. **After specific protocol authorization, during relevant market hours:** prove
   live freshness and completed-bar availability using the predeclared bounded
   test. Offline replay is insufficient for those claims. Revision/adjustment
   observations follow their separately declared protocol windows.
3. **After prerequisites pass:** plan deployment and market-specific commissioning,
   including Canadian adjustment evidence, calendar observation, parity and
   session/restart acceptance. Deployment authorization remains separate.

Existing observation jobs retain their current scope. This decision neither
creates schedules nor expands collection permissions. Scheduled observations
should preserve useful evidence and flag errors, unusable evidence and changed
blockers under their existing instructions; they cannot close a missing feed
capability by accumulating the same failed observations.

AUTO_ADD stays blocked. Trading, learning qualification and promotion policy are
unchanged. This ADR supersedes only the pending decision on proposal scope and
the proposed-only status of the 0.99 valid-decision requirement in the
project overview, commissioning
protocol and historical work receipts. It does not supersede their failed results
or the US STOP.
