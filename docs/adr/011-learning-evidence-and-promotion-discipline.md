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

## Review practice

Review evidence quality weekly: completed outcomes by compatible group,
unresolved exits, missing features/provenance, overlap exclusions, and coverage
across symbols and market conditions. Re-estimate collection time after 5–10
completed trading sessions. This documents the review practice; it does not
create a recurring automation or authorize notifications.

The September 8 estimate of roughly 6–8 trading weeks for the busiest group was
an extrapolation from one incomplete day, not a deadline or an acceptance target.

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
and receipts. No Stage B approval exists, so every clause above remains in force.
Nothing above is rewritten by this link.
