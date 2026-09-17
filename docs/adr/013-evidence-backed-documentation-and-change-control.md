# ADR-013: Evidence-backed documentation and change control

**Status:** Accepted documentation guardrails, September 8, 2026, under the user's
documentation-audit request. No trading or deployment policy is changed.

## Context

Phased plans, dated test results and active specifications had overlapping claims.
The September 8 refresh also linked to an absent audit and a git-ignored local plan.
A document's existence, a healthy service or a completed implementation checklist
does not establish deployment readiness or research value.

## Decision

- Baseline documents describe implemented behavior and name source owners. Mark
  known implementation gaps explicitly; an accepted policy remains binding even
  when the code does not yet enforce it. Do not describe intended behavior as shipped.
- ADRs record decisions and guardrails at stable paths. Clarify or explicitly
  supersede scope, with reciprocal links, rather than erasing earlier rationale.
- Active WIP owns unresolved requirements. Before archiving a completed report or
  superseded plan, name its replacement and carry remaining requirements forward.
  Preserve dated findings and failed/skipped results as historical evidence.
- Current navigation must work in a fresh checkout, without ignored local documents,
  downloaded reading material or workstation-only absolute links. Check local links
  and heading anchors after moves, including historical navigation.
- Distinguish source review, unit verification, isolated database acceptance,
  production observation, research qualification and authorized activation. Record
  revision, workload and limitations with validation results. Recheck effective
  configuration when diagnosing deployment behavior; source defaults are not proof
  of runtime flags.
- Schema changes use new numbered migrations and updated startup/deployment guards.
  Do not edit applied SQL or broaden checksum exceptions to make startup succeed.
  Retention, backup and recovery claims require actual storage configuration and
  verified restore evidence, not merely a suggested SQL command.

## Implementation and enforcement limits

The [documentation index](../README.md) and root [agent guide](../../AGENTS.md)
define navigation and operating practice. `apps/api/src/database/migrate.ts`
implements checksums and schema requirements; `scripts/verify-paper-bot-deployment.mjs`
checks deployment prerequisites. Documentation discipline is a review obligation,
not an executable assertion of every architectural claim.

Authorization follows the current user request. Ordinary fixes within scope do not
need renewed approval; publishing, activation or a running-stack change cannot be
inferred from a documentation edit. [ADR-011](011-learning-evidence-and-promotion-discipline.md)
continues to govern learning and promotion.

## Consequences

Maintainers can distinguish what exists, what was measured and what remains open.
Documentation changes require source review and navigation checks, but not an
unrelated application suite or destructive operational rehearsal.
