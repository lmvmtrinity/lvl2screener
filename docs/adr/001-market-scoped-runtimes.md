# ADR 001: Market-scoped runtimes and evidence

## Status

Accepted

## Decision

The scanner treats `CA_TSX` and `US_EQUITIES` as separate trading domains.
Every market-sensitive boundary uses the closed `MarketId` contract. The
runtime coordinator owns one independent market runtime per enabled market;
they share transport and rate limiting but never session, universe, benchmark,
portfolio, or evidence state.

Research artifacts—backtests, frozen training datasets, models, paper runs,
and qualifications—are market-homogeneous. Read APIs may offer `ALL` only as
an aggregation filter; it is not persisted as market, venue, or currency.

## Consequences

The application can disable or recover one market without altering the other.
Market-specific storage/indexes and explicit provenance add implementation
cost, but prevent silent CAD/USD or benchmark contamination.
