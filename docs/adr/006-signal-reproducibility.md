# ADR-006: Every Signal Must Be Reproducible

**Status:** Accepted

## Context

Without stored inputs and versions, historical analysis becomes unreliable.

## Decision

Every signal/state event must reference:

- instrument
- timestamp
- feature snapshot
- strategy name/version
- configuration version
- reason codes

## Consequences

### Positive

- reliable backtesting/replay
- easier debugging
- defensible parameter research
- agents can understand why a historical signal occurred

### Negative

- more storage
- stricter schema/version management

## September 8, 2026 retention and chronology clarification

Reproducibility includes market, immutable profile/config identity, setup instance,
feature/score versions and formation evidence. A pivot's confirmation time is its
availability boundary; its earlier bar timestamp cannot authorize an earlier signal.
Migration 081 retains formation evidence on evaluations, signals and events.

This decision is a lineage requirement, not indefinite raw-input retention.
[Retention](../baseline/data-model.md#retention) can remove captured quotes and
candles while outcomes survive. Replay or corrected-strategy regeneration must
check retained coverage and fail visibly when it is unavailable. Regeneration
creates versioned replacement lineage; it must not rewrite the original observation
or claim that execution-only replay reran corrected signal detection.
