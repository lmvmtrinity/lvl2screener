# Paper execution and account reporting

Reviewed against source on September 8, 2026. Governing decisions:
[ADR-009](../adr/009-paper-bot-authoritative-execution.md),
[ADR-010](../adr/010-coordinated-portfolio-is-a-separate-projection.md), and
[ADR-011](../adr/011-learning-evidence-and-promotion-discipline.md), and
[ADR-012](../adr/012-durable-paper-effects-and-temporal-reporting.md).

## Separate projections

| Surface                             | What it measures                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| Independent QUOTE/CANDLE executions | Each observed eligible setup lifecycle; overlapping strategy evidence, not one account |
| Coordinated shadow positions        | Policy-selected positions in a durable market-specific simulated portfolio             |
| Opt-in funded account               | Simulated cash, reservations, pending orders, fills, risk controls and durable ledger  |

None is a brokerage holdings query or real order. Counts and P&L must retain their
projection, market, currency and execution identity. Independent and coordinated
totals must never be summed.

## Entries and exits

`backtests/execution-provenance.ts` declares `paper-execution-v7` as the current
authoritative identity. Each run retains its own immutable assumptions. Older
versions, including noon-close evidence, are not reinterpreted as v7.

Run-level `evidenceScope` provenance remains on the immutable run assumptions;
funded signal adapters omit it from strict execution facts. The September 9 live
adapter correction preserves economic inputs and existing durable retries while
preventing this metadata from aborting paper cycles before inbox enqueue. It does
not reconstruct missed submissions or resolve historical positions by itself.

QUOTE execution requires admissible market data and uses executable bid/ask,
slippage, costs and available displayed size. Economic viability and cost-inclusive
risk sizing can reject or cap an entry. A READY observation does not guarantee a
fill. CANDLE execution has explicit completed-bar admissibility and intrabar
ambiguity rules; it cannot prove an actionable bid/ask fill was available.

Provider quotes and `quote_snapshot` store normalized share quantities alongside
raw-unit provenance (`BOARD_LOTS` and its multiplier for Questrade). Live,
reconciliation and retained-history adapters translate that provenance to
`SHARES / 1` execution facts without multiplying quantities again. Unknown or
inconsistent units still fail closed; raw board-lot execution facts are rejected.

Positions can exit on their applicable stop, target, invalidation, time/portfolio
policy or session-close path. Policy applicability differs between independent,
coordinated and funded projections; do not copy one projection's limits to another.
Funded orders additionally expire and release reservations through the durable
order clock. Order expiry is not the expiry of owned shares.

## Session close and recovery

Current API wiring sets the independent/coordinated paper close assumption to
16:00 in the market's timezone. Legacy names such as `noonCloseTime` and
`noonBoundaryTimestamp` remain in the code but do not mean current runs close at
noon. Scanner preferred-entry end is a separate setting, not a liquidation time.

At the recorded close boundary, the normal processor requests exits regardless
of whether the trade is profitable. It uses eligible current or retained facts
and available liquidity. Missing/unusable quotes or insufficient capacity can
leave a position OPEN/CLOSE_PENDING for recovery; a timer does not fabricate a fill
or erase a holding. Partial closes retain the remainder. Delayed recovery records
its source, boundary, selected fact and delay. Do not claim guaranteed liquidation
at exactly 16:00 or verified early-close handling from the configured clock alone.

Startup and subsequent processing recover overdue work through normal execution
paths. An unresolved older position must remain visible even when a report filters
to today. Never repair an unresolved position with an ad-hoc historical UPDATE.

The closed-market cycle collects closing quotes and completed bars before asking
for settlement. It retries collection once per minute during the first five
minutes for publication lag, with one catch-up collection after a later startup;
failed collection remains retryable. This path does not scan for new entries.
Quotes must still meet the recorded close boundary; pre-close quotes are not
retimestamped or substituted. Independent evidence retains its abandonment
horizon, while coordinated positions continue recovery beyond that horizon and
remain unresolved until an executable fact closes the remaining shares.

The September 8 close-recovery correction fixes the provider metadata mismatch
and missing closing collection. It does not rewrite missed intraday exits or
relabel historical outcomes. Treat observations collected before this correction
as affected by the incident when assessing evidence comparability; delayed
recovery is not proof that a historical stop executed on time.

## Reporting and evidence

Repeated invalidations of a pre-submission-suppressed order are acknowledged without
an order only when `FundedOrderService.cancel` finds the original, acknowledged
suppression in the same run at or before the cancellation time. The original fact
must retain its matching invalidation envelope ID and pre-submission event ID.
Unacknowledged, future or unrelated suppression cannot hide an unknown-order error.
This recovers the durable inbox without rewriting facts or creating economic effects.

Wall-clock settlement can mark a run CLOSE_PENDING while its funded inbox still
contains pre-close signals. Recovery may submit only the exact pending SIGNAL
envelope claimed by that run's in-flight barrier, including unchanged instrument,
order and reservation inputs. Its submission time must precede the scheduled close
and must not precede the funded clock. Direct submissions, completed runs and
signals at or after the close remain blocked.

Funded intake uses migration `088-funded-fact-lookup-indexes.sql` for acknowledged
fact chronology, pre-submission suppression lookups and the enqueued collection
clock. These indexes keep repeated intake queries from scanning the complete fact
history as a session grows. They do not change fact ordering, acknowledgement,
execution assumptions or the bounded live drain budget.

Coordination health counts unknown quote-size units from each market instrument's
latest retained quote using an indexed lookup. It includes inactive instruments
with retained quotes and does not scan every historical quote on each cycle.

Bot activities are operational funnel counts: observations, fills, missing market,
economic rejections, open positions and pending closes. The paper-bot journal
surface defaults to the coordinated projection; independent QUOTE is a different
explicit view. Unresolved rows are excluded from closed-trade performance and
paper training.

The Bot evidence glance defaults to the funded paper account bound to the selected
market (`GET /api/paper-bot/funded-account?marketId=...`) and offers the
coordinated shadow as an explicit switch; the two totals are never summed. The
funded read is `CURRENT_ACCOUNT` scope: it reports the account's current ledger
valuation with order counts from the latest live funded run only, is explicitly
not qualified for capital allocation, and returns an unavailable state rather than
inferring an account from another market or a finished session.

Funded CLI reports default to a proven run-end snapshot. `funded-report <run UUID>
--current` explicitly reads current account state and account-wide orders;
`--as-of=<ISO timestamp>` requests a historical boundary. These flags are mutually
exclusive. A legacy run without provable historical snapshots is unavailable rather
than reconstructed from today's balance.

Execution diagnostics are a separate, read-only explanation layer. The durable
worker prepares a `RUN_END` artifact from the funded run's immutable boundary;
`AS_OF` and `CURRENT_ACCOUNT` are explicit projections and never relabel or replace
that artifact. The API endpoint is
`GET /api/paper-bot/runs/:id/execution-diagnostics?marketId=...&mode=...` and
returns typed READY, PENDING or UNAVAILABLE states. Reports are content-addressed
by run, account, market/currency, time scope, version and source digest; duplicate
retries reuse the first immutable row.

The diagnostic projection can identify repeated identical displayed books and
canonical allocation ordering, but it does not prove that an exchange replenished
liquidity or that an unobserved counterparty was absent. Missing quote/order history,
legacy event ordering, ambiguous fill links and incomplete allocation inputs remain
unknown. It must never substitute the latest budget, current account state or a
later quote for historical evidence, and it does not change fills, reservations,
ledger events, costs or funded execution policy. Bot Performance exposes the time
basis, freshness, partial-fill/side-liquidity evidence and these limitations with
accessible explanations.

## Code and verification entry points

- `apps/api/src/paper-bot/paper-bot-live-processor.ts`: independent/coordinated lifecycle and close recovery.
- `quote-execution.ts`, `candle-execution.ts`, `financials.ts`, `cost-policy.ts` under that directory: execution and economics.
- `funded-live-adapter.ts`, `funded-fact-adapter.ts`, `funded-session-driver.ts`: durable input/recovery orchestration.
- `funded-order-service.ts`, `funded-ledger-repository.ts`, `shared-entry-liquidity.ts`, `shared-exit-liquidity.ts`: transactional account and capacity controls.
- `paper-reporting-service.ts`, `funded-reporting-service.ts`: projection and temporal reporting.

See [deployment acceptance](../operations/paper-bot-deployment-acceptance.md) and
active realism work for remaining
provider, recovery, monitoring and performance gates. Dated test results are not
current production certification.
