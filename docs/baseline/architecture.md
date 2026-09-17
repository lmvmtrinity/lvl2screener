# System architecture

Reviewed against source on September 8, 2026.

## Services and ownership

| Component | Implementation                                | Responsibility                                                                                                 |
| --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Web       | React 19, TypeScript, Vite, nginx             | Scanner, detail chart, profiles, paper performance and learning views                                          |
| API       | Node.js 22+, TypeScript ESM, Fastify, Zod, pg | Broker transport, market orchestration, persistence, HTTP and browser WebSocket                                |
| Scanner   | Python 3.12+, FastAPI, Pydantic               | Authoritative shared features, deterministic strategies/scoring, signal replay, statistical training/inference |
| Worker    | Separate Node process using API package       | Durable research jobs and scheduled paper-evidence learning checks                                             |
| Database  | PostgreSQL 17 with TimescaleDB                | Market history, immutable evidence/configuration, job state, auth and paper ledgers                            |

The Python runtime currently uses standard-library numerical implementations;
NumPy/Pandas/Polars are not runtime dependencies. Browser state/fetching lives in
`App.tsx` and `lib/resources.ts`; the detail candle chart is implemented locally.
See package manifests for exact dependency versions.

## Data flow

```text
Questrade → shared credential manager / priority limiter
          → market runtime (CA or US)
          → universe + separate benchmarks + quotes/candles
          → Python shared features → setup/context profile evaluations
          → persisted snapshots, transitions and alerts → HTTP/WebSocket → web
          → independent paper evidence
          → separate coordinated shadow / opt-in funded paper projections

Captured inputs → durable research job → worker → Python signal replay
                → TypeScript authoritative execution → persisted research result
Completed LIVE closed QUOTE evidence → qualified frozen dataset
                                    → inactive statistical challenger
```

Node owns paper execution economics, order/ledger transitions and recovery. Python
owns strategy decisions; React never independently recalculates authoritative
features or signals. Research cannot mutate a live profile or activate a model
implicitly. The [learning policy](../adr/011-learning-evidence-and-promotion-discipline.md)
adds prospective-validation requirements beyond executable training gates.

## Market isolation

Live market timers start together without awaiting another market's initial cycle.
Independent paper exits complete on the collection cycle; funded replay runs as
one background batch per market, yielding between acknowledged facts. The bounded
pass starts at 100 facts or 1,000 ms and extends by one second per 1,000
unacknowledged facts plus one second while the five-minute arrival-minus-drain
rate is positive (up to ten seconds) so an in-session backlog is drained, not only
matched; the drain returns as soon as the inbox is empty. Retained inputs recover
skipped scheduling ticks. Shutdown and session changes await the in-flight batch.
Recovery-only holdings receive quotes without becoming scanner candidates or
feature inputs. Successful processing timestamps and account-wide pending facts
expose progress separately from process readiness.

`runtime-coordinator.ts` owns separate CA and US market runtimes. They share
broker transport, credentials and request limiting, not market-sensitive session,
universe, benchmark, feature-engine, portfolio or evidence state. Market ownership
must survive database queries, replay, model provenance and browser filtering.
`ALL` is read-only aggregation; CAD/USD totals stay separate.

Session timezone is America/Toronto for CA and America/New_York for US. Provider
market-hours data controls market availability; local scanner windows govern
phases and entry eligibility. Storage uses UTC. Paper-close assumptions are
versioned separately; see [paper execution](paper-execution.md).

## Startup and background work

`apps/api/src/index.ts` loads validated configuration, applies checksum-verified
migrations, composes repositories/services, and starts market collection and HTTP.
`worker.ts` executes queued research work and checks paper learning at startup and
17:00 Eastern daily. An explicit legacy interval setting overrides that schedule.
The worker must not start live funded processing.

Jobs are durable and asynchronous: creation routes return HTTP 202; clients poll
job status and then retrieve the resulting resource. Restart/retry behavior belongs
to the research worker and repositories, not a browser request's lifetime.

## Repository map

Automated discovery has a separate stateless Python evaluator in `app/discovery.py`
and an internal authenticated endpoint. TypeScript owns provider access and durable
catalog/policy/run/input/result storage through `PostgresDiscoveryEvidenceStore`.
This follows the existing Python analytics boundary and does not mutate strategy
sessions, profiles or paper execution. The scheduled shadow pipeline and durable
daily-list intake are implemented, with automatic intake disabled in composition.
Verified live calendar/adjustment provenance and commissioning remain open. See the
active plan.

| Path                                                                                  | Contents                                                                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/api/src/routes/`                                                                | HTTP domain handlers; `app.ts` composes them                            |
| `apps/api/src/market-data/`, `markets/`, `questrade/`, `universe/`                    | Collection, market identity and broker boundary                         |
| `apps/api/src/paper-bot/`                                                             | Independent/coordinated execution and funded order/ledger/recovery      |
| `apps/api/src/backtests/`, `calibration/`, `ranking-research/`, `statistical-models/` | Research services                                                       |
| `apps/api/src/research-jobs/`, `worker/`                                              | Durable jobs and handlers                                               |
| `services/scanner/app/`                                                               | Feature engine, indicators, strategy engine, scoring, replay and models |
| `contracts/src/domains/`                                                              | Runtime-validated shared contracts                                      |
| `database/init/`                                                                      | Ordered SQL migrations; not a proposed schema                           |
| `apps/web/src/views/`, `lib/`                                                         | Browser views, projections and resource requests                        |
| `monitoring/`, `scripts/`, `docs/operations/`                                         | Operational checks and procedures                                       |

## Transport and deployment

Broker ingestion uses batched REST polling (default two seconds). Browser `/ws`
sends market snapshots with change suppression and per-connection sequencing;
it is not a broker streaming connection or a stream of every conceptual event.

Default Compose services are postgres, scanner, api, worker and web. Only web is
published, on loopback port 5173. nginx proxies HTTP/WebSocket traffic. Direct
service ports require the explicit debug override; remote access uses the remote
profile's TLS and operator authentication. Internal scanner calls require
`SCANNER_SERVICE_TOKEN`. Monitoring has a separate optional Compose overlay.

`serviceReady`, `operationalReady`, and `actionable` represent different checks.
A healthy process can have an empty universe or closed market. See the
[runbook](operations-runbook.md) for probes and recovery.
