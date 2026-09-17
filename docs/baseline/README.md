# Current baseline

Reviewed against repository source on September 8, 2026. These are current behavior
and invariant guides, not profitability claims or deployment sign-off.

| Document | Scope |
| --- | --- |
| [Product](product.md) | Operator workflow, supported capability and non-goals |
| [Architecture](architecture.md) | Service ownership, data flow and deployment boundary |
| [Strategy specification](strategy-spec.md) | Implemented gates, formations, features and scoring |
| [Questrade integration](questrade-integration.md) | Adapter, auth, market normalization and collection |
| [Data model](data-model.md) | Storage relationships, provenance and actual retention policy |
| [API contracts](api-contracts.md) | Registered route inventory and contract owners |
| [Paper execution](paper-execution.md) | Independent/coordinated/funded simulations, close recovery and reporting |
| [Backtesting](backtesting.md) | Chronological captured replay and controlled research |
| [Learning](learning.md) | Completed-run evidence, qualification, scheduling and promotion |
| [Frontend styling](frontend-styling.md) | Tailwind layers, tokens, shared components and migration status |
| [Operations runbook](operations-runbook.md) | Startup, readiness, backups, retention and recovery |

The old phased roadmap and conceptual configuration YAML are
archived. The YAML was not loaded
by the application. Use [`.env.example`](../../.env.example),
[`config.ts`](../../apps/api/src/config.ts), Compose wiring and immutable database
profile configs for current settings. Active WIP is the roadmap
for unfinished work.
