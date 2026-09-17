# ADR-015: Point-in-time replay candidates and explicit empty-candidate waiting

**Status:** Accepted by the user on September 12, 2026

## Context

Automated profile qualification resolved replay candidates from the current
`instrument.active` universe. Historical replay therefore depended on mutable
live state: when the manual daily list reset to empty, the completion path of the
universe refresh deactivated every instrument, and every subsequent replay ran
with benchmark instruments only. Those runs completed successfully with zero
candidates, so the intended strategy evaluation never happened while the result
still looked like a fresh baseline. A zero-opportunity result after evaluating
candidates is valid; zero candidates is missing input, not evidence.

## Decision

1. **Per-session historical membership.** Historical replay resolves candidates
   for each captured market session from the latest completed
   `universe_refresh_run` that discovered symbols and finished before that
   session's open. A single latest run for the whole range, or a union of every
   symbol observed anywhere in the range, would introduce look-ahead and is not
   permitted. Benchmark instruments stay separate from candidates throughout.
2. **Empty discovery is not empty membership.** A completed refresh that
   discovered no symbols means membership was unavailable at that time, not that
   the list was intentionally empty. Proven empty membership (symbols were
   evaluated and none were eligible) and missing membership evidence are
   distinct frozen provenance values, not the same state.
3. **Captured-cohort fallback.** Where historical membership cannot be proven,
   explicitly requested symbols remain available as a clearly labeled captured
   cohort frozen into the input identity. It is useful exploratory research and
   must never claim point-in-time universe reconstruction.
4. **Empty candidates wait, visibly.** A range that resolves no candidate-bearing
   session enters a first-class waiting state (`NO_REPLAY_CANDIDATES`); no
   scanner work is dispatched. Membership identity participates in the input
   fingerprint, so resolving evidence reopens the affected work and repeated
   discovery of the same unresolved membership produces one stable waiting
   state. Empty replays already persisted remain in history but do not satisfy
   baseline freshness or qualification prerequisites.
5. **Separate concerns stay separate.** Preserving the live active set when a
   refresh is empty, and off-hours US quote eligibility, require their own
   decisions and validation; this record does not change them.

## Consequences

- `replay_input` snapshots gain backward-compatible provenance fields: legacy
  rows parse as `CURRENT_ACTIVE_UNIVERSE` with no per-session candidates; new
  rows freeze per-session membership or captured-cohort provenance and include
  it in the input hash.
- `118-backtest-automation-candidate-blocker.sql` extends the durable blocker
  enum so the waiting state can persist.
- Baseline comparability: attempts that used live-universe candidate resolution
  are identified by their stored provenance and cannot be silently compared with
  point-in-time reconstructions.
- Studies and verified coverage keep their existing frozen evidence paths; this
  record governs ordinary replay-input resolution.

## Validation

Recorded September 12, 2026: automation waiting/freshness unit tests,
`replay-membership-resolution-postgres.test.ts` (per-session resolution,
zero-discovery behavior, no look-ahead, frozen replay unchanged when the live
active list changes), 5 targeted PostgreSQL suites in sequence on a fresh
disposable TimescaleDB instance, the full API suite (996 non-database tests) and
the full isolated acceptance run (192 files, 1125/1125 tests, no skips) with
`AUDIT_TEST_DATABASE_URL`, `PERSISTENCE_TEST_DATABASE_URL` and
`REQUIRE_POSTGRES_INTEGRATION=true`.
