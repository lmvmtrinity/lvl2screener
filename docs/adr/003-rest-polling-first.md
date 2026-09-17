# ADR-003: Use Batched REST Polling Before Streaming

**Status:** Accepted for V1

## Context

Questrade provides live market-data access, and a scanner for approximately 30–50 active candidates does not require ultra-low-latency infrastructure.

Streaming introduces additional connection lifecycle and recovery complexity.

## Decision

Use batched REST polling for V1.

Initial cadence:

- Level-1 quotes every 1–2 seconds
- 1m candles shortly after minute boundaries
- 5m strategy evaluation on completed bars

## Consequences

### Positive

- simpler reconnection
- deterministic snapshots
- easier debugging
- easier rate-limit control
- simpler auth lifecycle

### Negative

- less granular than full streaming
- more periodic request overhead

## Future

Streaming may be reconsidered after V1 if measured latency materially limits strategy quality.

## September 8, 2026 scope clarification

The cadence above records the initial design, not a current capacity guarantee.
Quote polling defaults to two seconds; quote batches trigger engine evaluations
while strategies use completed bars where their rules require them. The browser's
separate two-second snapshot WebSocket does not imply broker streaming. Shared
rate limiting prioritizes queued work without preempting inflight calls; measure
both markets under representative load. See
[Questrade integration](../baseline/questrade-integration.md).

## September 8, 2026 discovery budget implementation

The authorized discovery work adds durable shared market-data request grants in
migration 084. Both markets/API instances share a broker-identity allowance; the
research worker still makes no broker calls. Requests are paced and discovery is
capped below monitoring capacity. Unknown prior usage imposes a one-hour initial
market-data pause; persisted grants and provider blocks survive later restarts.
Authentication retains its separate category so budget bookkeeping cannot discard
rotated tokens. These controls do not establish production capacity or authorize
deployment/discovery activation. WP2 evidence and remaining gates are recorded in
automated candidate discovery.
