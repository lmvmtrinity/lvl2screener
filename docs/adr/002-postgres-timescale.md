# ADR-002: Use PostgreSQL + TimescaleDB

**Status:** Accepted

## Context

The project stores:
- quotes
- candles
- features
- signals
- configs
- journals
- backtest results

The dominant access pattern is time-series data joined with relational entities.

## Decision

Use PostgreSQL with TimescaleDB extensions.

## Consequences

### Positive
- strong relational integrity
- excellent time-range queries
- suitable for hypertables/compression
- one database for market data and application metadata

### Negative
- operationally heavier than SQLite
- Timescale-specific tuning may be needed later

## Constraint

Configuration and manual-journal records remain retained. Explicit retention
policies have since been introduced for high-frequency signals and evaluations
(migrations 028/029 and 054), with reference protection in the pruning function.
See the [current data model](../baseline/data-model.md#retention); indefinite
retention of every signal row is no longer the implemented policy.
