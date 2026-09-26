# ADR-011: Preserve Learning Evidence Quality and Require Forward Validation

**Status:** Accepted by the user on September 8, 2026

## Context

The user chose to maintain the current evidence collection pace and daily
learning checks, prioritizing credible evidence over reaching a training quota
quickly. A trained model is an experiment, not proof of improvement. This decision
extends [ADR-007](007-statistical-models-are-supplemental.md) and preserves its
limits on model influence and manual activation.

## Rules for agents

1. **Preserve the baseline.** Keep strategy rules, execution assumptions, risk
   limits, and evidence identity stable while gathering the baseline. Do not
   increase candidate intake, loosen screening, change exits, or alter costs
   merely to accelerate training or improve apparent results. Necessary fixes
   remain allowed within user authorization; document their effect on evidence
   comparability and preserve versioned ownership rather than rewriting history.
2. **Keep daily learning checks.** The default is worker startup plus 17:00
   America/New_York daily, with daylight-saving adjustment. Do not silently
   restore weekly checks, disable learning, or set the legacy interval override.
   A scheduled check may correctly produce no training job.
3. **Do not weaken qualification to obtain a model.** Preserve the current
   requirement of at least 200 usable outcomes per compatible evidence group,
   completed LIVE runs, closed QUOTE outcomes, immutable provenance, overlap
   purging, chronological label availability, class balance, and validation
   requirements. Markets, strategies, profiles, execution versions, and
   assumptions must not be pooled to reach the quota. Subsequent datasets retain
   the existing 50-new-outcome gate. The code remains the source of exact rules;
   these named protections are not an exhaustive replacement for it.
4. **Train inactive challengers only.** Automation may freeze qualified evidence
   and enqueue training. It must not activate a model, modify a profile, or change
   deterministic strategy decisions. Reaching a quota, passing historical gates,
   or improving prediction accuracy alone is not authorization for promotion.
5. **Require prospective evidence of added value.** Compare a frozen challenger
   against the deterministic baseline on the same subsequent, unseen opportunities
   in a shadow experiment. Record predictions at observation time; do not
   reconstruct them with a later model. Define the comparison and acceptance
   criteria before inspecting its results. Assess net returns after costs,
   drawdown, consistency across sessions/symbols/conditions, and prediction
   calibration. Any selection or portfolio comparison must model its own
   execution and constraints; independent outcomes are not an account balance.
   Manual activation still requires explicit user authorization and all existing
   gates. This rule does not itself authorize adding a model execution path.
6. **Report evidence honestly.** Distinguish observations, fills, closed outcomes,
   usable training rows, frozen datasets, trained models, and activated models.
   Never promise that elapsed time or 200 observations will produce a useful
   model. Preserve unsuccessful outcomes and unresolved-exit visibility.

Changes to this decision's collection policy, qualification gates, scheduling,
activation, or promotion requirements require an explicit user instruction
covering that change and an updated decision record with rationale and validation.
A generic refactor, dashboard fix, or request to improve learning does not
supersede these rules. Routine fixes and read-only reviews that preserve them do
not require additional approval.

## September 24, 2026 persistence cadence

The user authorized a storage and write reduction for live strategy observations.
The API retains every state-change event and its matching `strategy_signal` row
with the original event payload. A setup row is also written as soon as its
state, score, setup instance, or entry, stop or target reference changes, and a
context row as soon as its status or context score changes. Otherwise it writes
the signal/evaluation/context row and its feature snapshot on a 60-second
heartbeat. `STRATEGY_PERSIST_HEARTBEAT_MS=0` restores every-poll
persistence. A process restart or a cache miss writes the next observation;
the cache advances only after the strategy transaction commits. No strategy
threshold, training qualification gate, research source digest, or promotion
authority changes. The reduced row cadence is a new evidence collection regime,
so before and after row counts must be interpreted with that boundary in mind.

The September 24 cost reduction changes the funded paper clock outside the
close collection window from every two seconds to once a minute while no
funded fact or close-pending order is waiting. Pending facts and close-pending
orders retain the two-second recovery cadence. This changes the density of idle
clock facts; it does not change the learning qualification gates, trading
assumptions, or retained economic evidence.

## September 24, 2026 spread gate stabilization

The user authorized stabilizing the setup spread gate. Migration 153 moves every
setup profile to a new immutable configuration version ending
`+spread-stable-v1`, which blocks only a spread that stays above the limit for 3
quotes and 5 seconds, re-arms below 80% of the limit, and allows at least 3
ticks. Parameter defaults reproduce the legacy single-quote gate, so earlier
configuration versions and their evidence are unchanged. The new versions are a
new compatible cohort: learning gates, qualification and comparisons count them
separately and never pool them with legacy versions.


Later changes to these values require a new configuration version and a
replay comparison.

## September 24, 2026 trade reference floors

The user authorized widening tight setup stops and raising close targets.
Migration 154 moves every setup profile to a new configuration version ending
`+levels-v1` (a stop floor of 0.15 × daily ATR14 or 4 spreads, whichever is
wider, and a 1.5 R minimum target). Parameter defaults keep structural stops and
nearest-resistance targets, so earlier versions and their evidence are
unchanged and form separate cohorts. Qualification backtests now apply the
paper bot's entry economics. Excursions from unverified coverage are
`INDICATIVE` and never evidence.


## Review practice

Review evidence quality weekly: completed outcomes by compatible group,
unresolved exits, missing features/provenance, overlap exclusions, and coverage
across symbols and market conditions. Re-estimate collection time after 5–10
completed trading sessions. This documents the review practice; it does not
create a recurring automation or authorize notifications.


The existing requirement for positive returns in historical validation windows
before training deserves a separate research review: it may exclude cases where
ML filtering could help. It remains in force unless the user explicitly approves
a researched change. Do not relax it just to produce a model.

## Implementation entry points

All paths below are relative to the repository root:

- `apps/api/src/statistical-models/paper-evidence-qualification.ts`: sample,
  chronology, overlap, class, and historical validation gates.
- `apps/api/src/statistical-models/paper-evidence-training-repository.ts`:
  compatible cohort membership and frozen datasets.
- `apps/api/src/statistical-models/paper-evidence-training-scheduler.ts`:
  qualification and inactive challenger jobs.
- `apps/api/src/statistical-models/daily-learning-schedule.ts` and
  `apps/api/src/worker.ts`: daily checks and startup catch-up.
- `apps/api/src/statistical-models/learning-dashboard-service.ts` and
  `apps/web/src/views/LearningView.tsx`: honest readiness and lifecycle reporting.

## Enforcement limits

This is an accepted repository instruction for agents, not a new executable
promotion gate. Existing tests and runtime checks still apply. Do not claim
forward benefit or automated enforcement of this entire decision without evidence.

## September 15, 2026 forward link

[ADR-016](016-automatic-paper-funded-policy-control.md) was accepted at Stage A on
September 15, 2026 for authority-disabled implementation. It narrowly supersedes
rule 4's automatic-training-only limit and separate-manual-activation requirement
only after a later, explicit Stage B per-market approval freezes the numeric policy
and receipts. Until Stage B approval exists, every clause above remains in force.
Nothing above is rewritten by this link.
