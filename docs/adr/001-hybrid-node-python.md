# ADR-001: Use Node.js for Orchestration and Python for Strategy Analytics

**Status:** Accepted

## Context

The application needs both:

- network-heavy API/WebSocket/OAuth orchestration
- numerical time-series strategy processing and backtesting

## Decision

Use:

- Node.js + TypeScript for the application/API layer
- Python for feature calculation, strategy state machines, scoring, and backtesting

## Consequences

### Positive

- clear service ownership
- TypeScript integrates naturally with React
- Python ecosystem supports analytics/backtesting
- strategy code can evolve independently from frontend infrastructure

### Negative

- two runtimes
- internal service contracts required
- slightly more local-development complexity

## Constraint

Authoritative strategy decisions must live in Python, not duplicated in Node or React.

## September 8, 2026 ownership clarification

“Backtesting” above means authoritative analytics and chronological signal replay
in Python. TypeScript owns current paper fill economics and the captured replay
execution accumulator, as specified by
[ADR-009](009-paper-bot-authoritative-execution.md). The worker owns durable job
execution. Neither Node nor React should duplicate strategy decisions, and Python's
legacy fill path is not the current authoritative execution definition.

The separate automated discovery evaluator also lives in Python
(`services/scanner/app/discovery.py`). TypeScript collects inputs and persists
evidence; it does not recalculate screening metrics. Discovery qualification does
not initialize or change strategy state. The discovery work plan
records the implemented WP3 boundary and remaining pipeline/activation gates.
