# ADR 002: Versioned tick, quote-size, and execution-cost policies

## Status

Accepted

## Decision

Tick size, quote-size interpretation, and execution-cost assumptions are
market-scoped, versioned policies. An actionable or sized paper trade requires
known tick and quote-size semantics. Unknown, delayed, halted, or stale market
data fails closed.

Each execution stores an immutable native-currency cost breakdown. CAD and USD
books are separate; an aggregate account value is deferred until an audited FX
conversion policy records source, timestamp, direction, and rounding.

## Consequences

Historical evidence retains the policy used when it was created. A policy
change requires a new effective version and cannot silently reinterpret old
research or executions.
