# ADR-005: Deterministic and Explainable Strategy Logic

**Status:** Accepted

## Context

The scanner must be auditable, testable, and replayable.

Opaque model outputs are difficult to validate with small datasets and can hide regime-specific failure modes.

## Decision

Initial live strategy logic will be deterministic and rule-based.

Every state/score includes reason codes.

## Consequences

### Positive
- easy replay
- easy debugging
- exact strategy versioning
- understandable alerts
- safer parameter calibration

### Negative
- potentially less adaptive than future statistical methods

## Future

Machine learning may later supplement ranking if sufficient clean data exists, but deterministic state machines remain the baseline.
