# ADR-004: Human-in-the-Loop, No Automated Order Execution

**Status:** Accepted

## Context

The product is designed as a selective trading decision-support tool.

Automated execution adds:
- brokerage restrictions
- materially higher risk
- order-state complexity
- execution/slippage logic
- additional compliance/operational concerns

## Decision

The application will:
- scan
- rank
- explain
- alert
- journal

The user will manually place or skip trades.

## Consequences

### Positive
- safer initial deployment
- easier validation
- strategy mistakes cannot directly place orders
- preserves discretionary chart/news judgment

### Negative
- execution remains manual
- realized fills may differ from modeled references

## Constraint

No brokerage order-submission action belongs in V1. Simulated BUY/SELL ledger
actions and automated paper measurement are permitted under ADR-008/009/010;
they must have no broker write path.
