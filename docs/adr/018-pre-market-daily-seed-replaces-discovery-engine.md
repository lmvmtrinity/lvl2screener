# ADR-018: Pre-market daily seed is the primary candidate source

**Status:** Accepted September 24, 2026, at the user's request. It freezes the
ADR-017 discovery engine and makes the pre-market daily seed (`daily-seed-v1`)
the primary automatic source of daily-list candidates. It records no empirical
acceptance of the seed.

## Context

The pre-market seed uses a bounded design: previous-session data, a pool of
resolved stocks, one batched symbol-details request per 50 symbols and one
daily-candle request per survivor. It fills an empty daily list while preserving
the shared broker request budget.


## Decision

1. **Primary path.** `apps/api/src/universe/daily-list-seeder.ts` is the primary
   automatic candidate source. It fills only an empty list, on session days, at
   `DAILY_LIST_SEED_TIME`, through ordinary `MANUAL` intake tagged with its
   version. An operator list always takes precedence. Behavior is documented in
   the [operations runbook](../baseline/operations-runbook.md#pre-market-daily-list-seed).
2. **Versioning.** Changes to the pool, filters, score weights or pick counts
   create a new seed version (`daily-seed-v2`, and so on) so paper outcomes of
   seeded lists stay comparable. Weight changes should cite retained session
   outcomes.
3. **Frozen discovery engine.** The ADR-017 engine is frozen: its code, tables
   and retained evidence stay in place, `discovery_mode` stays `OFF` for both
   markets, and no further provider probes, protocol restarts, commissioning
   runs or AUTO_ADD work proceed under ADR-017. Its project documents move to
   private development record.
4. **Retained dependency.** The seed's pool reads `discovery_symbol_mapping`
   and the latest `discovery_catalog_snapshot`. Those tables and the code that
   refreshes them stay until the seed owns its own pool refresh.
5. **Later steps, each needing its own decision.** (a) An intraday extension
   that rescans the seed's own survivors for relative volume and change from
   open. (b) Moving the pool refresh into the seed. (c) Retiring the discovery
   engine's code. (d) Archiving or dropping its tables, which requires explicit
   operator approval and a verified backup first; ADR-013 evidence retention
   applies.

### Implemented September 25, 2026: decision 5(a)

The early-session rescan (`daily-seed-v2`) is implemented at the user's
request, off by default and enabled per market. It reuses the seed pool and the
discovery policy's relative-volume and move thresholds, adds at most a few
symbols to a list the seed filled, and records its outcomes separately so its
additions can be judged apart from the pre-market picks. See the
[operations runbook](../baseline/operations-runbook.md#early-session-rescan-daily-seed-v2).

## Consequences

- The seed is a ranking heuristic, not a validated edge. Its picks carry no
  discovery evidence rows and satisfy no discovery commissioning gate.
- Candidates that start moving at the open can be added by the early-session
  rescan when it is enabled; a stock that starts moving later in the session
  is not added automatically.


- Discovery tables remain until decision 5(d).

## Supersession

This decision supersedes [ADR-017](017-discovery-feed-feasibility-and-valid-decision-acceptance.md)
for future work: its authorizations lapse unused, and its 0.99 valid-decision
gate applies only if the engine is revived. [ADR-014](014-empirical-provider-convention-verification.md)
remains accepted as a general rule for provider conventions but has no active
discovery protocol under it.
