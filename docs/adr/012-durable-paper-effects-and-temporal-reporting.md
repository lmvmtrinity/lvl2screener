# ADR-012: Durable paper effects and explicit reporting time

**Status:** Accepted documentation of existing constraints, September 8, 2026.
Extends [ADR-009](009-paper-bot-authoritative-execution.md) and
[ADR-010](010-coordinated-portfolio-is-a-separate-projection.md).

## Context

A process can crash after an economic effect commits but before its inbox fact is
acknowledged. A later run can also change an account that an older report refers to.
Retrying with newly calculated inputs or reporting today's balance as yesterday's
result corrupts evidence even when individual requests succeed.

## Decision

1. Persist immutable fact identity and economic inputs. Reuse durable effects on
   retry; do not regenerate timestamps, reservations or prices under the same ID.
   Driver envelopes contain only the expected ID and fact, not inbox outcomes.
2. Commit order, reservation, ledger and shared-liquidity effects under their
   existing transactional ownership before acknowledgement. Preserve run/account
   locks and the inflight barrier unless an equivalent concurrency design is proven.
3. Reconcile known pre-submission invalidation before execution, including quotes
   at the submission timestamp. Preserve original audit time separately from the
   effective reconciliation boundary. A proven durable reservation veto or an
   acknowledged earlier pre-submission suppression in the same run permits
   cancellation without an order; unknown ownership or conflicting facts fail visibly.
   The September 9 repeated-invalidation correction requires the original suppression
   envelope identity and timestamp, preserving the existing intentional no-order state.
4. Include commission in cash reservation while preserving notional and risk caps.
   Bind market, account policy and run identity; do not assign modern policy fields
   retroactively to legacy accounts.
5. State reporting time explicitly: default run-end snapshot, requested historical
   as-of boundary, or explicit current account. Unprovable historical state is
   unavailable. Compaction must not erase durable economic events or fabricate history.
6. Expose account-wide unresolved recovery across runs. Order expiry releases an
   unfilled reservation; it does not liquidate owned shares. Missing executable
   facts leave visible unresolved positions rather than invented closes.

## Implementation and verification

Source under `apps/api/src/paper-bot/`: `funded-fact-adapter.ts`,
`funded-session-driver.ts`, `funded-order-service.ts`, `financials.ts`,
`funded-ledger-repository.ts`, and `funded-reporting-service.ts`.
The [paper baseline](../baseline/paper-execution.md) describes current surfaces.
Regression entry points under `apps/api/tests/` include `paper-audit-postgres.test.ts`,
`funded-gap-postgres.test.ts`, and `funded-live-adapter.test.ts`.

Changes must cover same-time invalidation and crash/retry boundaries where affected,
using isolated PostgreSQL for transactional claims. Unit success or a skipped
database suite is insufficient evidence for durable acceptance. This decision
does not certify production feed coverage, liquidity realism or deployment capacity.

## Consequences

September 9 operational implementation: live inbox drains yield only after durable
acknowledgement and barrier clearing. Run settlement and subsequent account binding
also check pending inbox facts. Atomically enqueued clocks provide the retained-input
collection watermark while execution continues from the inbox. Account snapshots
retain at most 256 duplicate events only when each evicted event has an identical
durable copy; unverified legacy history remains intact. The isolated
`production-recovery-postgres.test.ts` covers backlog restart, watermark recovery,
bounded snapshots, old-event retry/conflict detection and market-scoped recovery quotes.

Retries and reports are auditable, at the cost of durable history, serialized
allocation and explicit unavailable legacy reports. Optimize only with measured
evidence while retaining these guarantees; do not weaken them to pass a benchmark.
