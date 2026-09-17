# API and event contracts

Reviewed against route registrations on September 10, 2026. Exact request/response
fields, defaults and validation live in [shared contracts](../../contracts/src/domains/),
[route handlers](../../apps/api/src/routes/) and [Python models](../../services/scanner/app/models.py).
The inventory below lists registered paths, not example query strings. Services
can return unavailable errors when their dependencies are not configured.

## Public HTTP inventory

Default origin: `http://localhost:5173` through nginx. `/ws` is a WebSocket upgrade.
Remote-auth login/logout routes are registered only when remote access is enabled.

| Method | Path                                             | Owner under `apps/api/src/`    |
| ------ | ------------------------------------------------ | ------------------------------ |
| GET    | `/api/captured-history/availability`             | `routes/backtests.ts`          |
| GET    | `/api/backtests`                                 | `routes/backtests.ts`          |
| GET    | `/api/backtests/compare`                         | `routes/backtests.ts`          |
| GET    | `/api/backtests/:id`                             | `routes/backtests.ts`          |
| POST   | `/api/backtests`                                 | `routes/backtests.ts`          |
| GET    | `/api/backtest-automation/status`                | `routes/backtests.ts`          |
| POST   | `/api/backtest-automation/refresh`               | `routes/backtests.ts`          |
| GET    | `/api/funded-historical-policies`                | `routes/backtests.ts`          |
| POST   | `/api/funded-historical-policies`                | `routes/backtests.ts`          |
| POST   | `/api/funded-historical-policies/:id/revoke`     | `routes/backtests.ts`          |
| GET    | `/api/funded-replays`                            | `routes/funded-replays.ts`     |
| GET    | `/api/funded-replays/:id`                        | `routes/funded-replays.ts`     |
| GET    | `/api/paper-bot/funded-account`                  | `routes/funded-replays.ts`     |
| GET    | `/api/calibrations`                              | `routes/calibrations.ts`       |
| GET    | `/api/calibrations/:id`                          | `routes/calibrations.ts`       |
| POST   | `/api/calibrations`                              | `routes/calibrations.ts`       |
| GET    | `/api/learning/overview`                         | `routes/learning.ts`           |
| GET    | `/api/learning/automation-runs`                  | `routes/learning.ts`           |
| GET    | `/api/learning/coordination-decisions`           | `routes/learning.ts`           |
| GET    | `/api/market/status`                             | `routes/market-data.ts`        |
| GET    | `/api/universe`                                  | `routes/market-data.ts`        |
| GET    | `/api/universe/runs`                             | `routes/market-data.ts`        |
| POST   | `/api/universe/refresh`                          | `routes/market-data.ts`        |
| PUT    | `/api/universe/watchlist`                        | `routes/market-data.ts`        |
| GET    | `/api/features`                                  | `routes/market-data.ts`        |
| GET    | `/api/features/:symbol`                          | `routes/market-data.ts`        |
| GET    | `/api/candidates`                                | `routes/market-data.ts`        |
| GET    | `/api/contexts`                                  | `routes/market-data.ts`        |
| GET    | `/api/candidates/:symbol`                        | `routes/market-data.ts`        |
| GET    | `/api/signals`                                   | `routes/market-data.ts`        |
| GET    | `/api/alerts`                                    | `routes/market-data.ts`        |
| GET    | `/api/alerts/policy`                             | `routes/market-data.ts`        |
| PUT    | `/api/alerts/policy`                             | `routes/market-data.ts`        |
| POST   | `/api/universe/candidates`                       | `routes/market-data.ts`        |
| GET    | `/api/paper-bot/activities`                      | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/runs`                            | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/commission-sensitivity`          | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/coordination/decisions`          | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/coordination/summary`            | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/observations`                    | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/executions`                      | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/journal`                         | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/performance`                     | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/aggregates`                      | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/curves`                          | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/qualifications`                  | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/divergences`                     | `routes/paper-reporting.ts`    |
| GET    | `/api/paper-bot/comparisons`                     | `routes/paper-reporting.ts`    |
| GET    | `/api/strategies`                                | `routes/profiles.ts`           |
| GET    | `/api/scanner-profiles`                          | `routes/profiles.ts`           |
| POST   | `/api/scanner-profiles`                          | `routes/profiles.ts`           |
| POST   | `/api/scanner-profiles/:id/duplicate`            | `routes/profiles.ts`           |
| PUT    | `/api/scanner-profiles/:id`                      | `routes/profiles.ts`           |
| GET    | `/api/scanner-profiles/:id/configs`              | `routes/profiles.ts`           |
| GET    | `/api/evaluations`                               | `routes/profiles.ts`           |
| GET    | `/api/opportunities`                             | `routes/profiles.ts`           |
| GET    | `/api/comparisons`                               | `routes/profiles.ts`           |
| GET    | `/api/ranking-research`                          | `routes/ranking-research.ts`   |
| GET    | `/api/ranking-research/:id`                      | `routes/ranking-research.ts`   |
| POST   | `/api/ranking-research`                          | `routes/ranking-research.ts`   |
| GET    | `/api/research-jobs/:id`                         | `routes/research-jobs.ts`      |
| POST   | `/api/research-jobs/:id/cancel`                  | `routes/research-jobs.ts`      |
| GET    | `/api/statistical-models/forward-monitoring`     | `routes/statistical-models.ts` |
| GET    | `/api/statistical-models/paper-evidence/cohorts` | `routes/statistical-models.ts` |
| GET    | `/api/statistical-models`                        | `routes/statistical-models.ts` |
| POST   | `/api/statistical-models`                        | `routes/statistical-models.ts` |
| GET    | `/api/statistical-models/active/predictions`     | `routes/statistical-models.ts` |
| GET    | `/api/statistical-models/:id/predictions`        | `routes/statistical-models.ts` |
| POST   | `/api/statistical-models/:id/activate`           | `routes/statistical-models.ts` |
| POST   | `/api/statistical-models/:id/deactivate`         | `routes/statistical-models.ts` |
| GET    | `/api/statistical-models/:id`                    | `routes/statistical-models.ts` |
| GET    | `/ws`                                            | `routes/system.ts`             |
| GET    | `/metrics`                                       | `routes/system.ts`             |
| GET    | `/health/live`                                   | `routes/system.ts`             |
| GET    | `/health/ready`                                  | `routes/system.ts`             |
| GET    | `/api/system/status`                             | `routes/system.ts`             |
| GET    | `/api/system/retention`                          | `routes/system.ts`             |
| POST   | `/api/system/retention/run`                      | `routes/system.ts`             |
| POST   | `/api/auth/login`                                | `auth/remote-auth-plugin.ts`   |
| POST   | `/api/auth/logout`                               | `auth/remote-auth-plugin.ts`   |

`GET /api/comparisons` accepts `profileIds` (comma-separated UUIDs, 2–10),
`source` (`LIVE`, `PAPER`, or `BACKTEST`), `startDate`, `endDate`, optional
`timeStart`/`timeEnd` (`HH:mm`), `marketId`, and an optional JSON `cohortKeys`
object mapping profile UUIDs to server-returned cohort keys. The response
includes `status` (`CONTROLLED`, `UNCONTROLLED`, or `UNVERIFIED`), explicit
scope `differences`, optional `availableCohorts`, and per-profile metrics.
Metric `maximumDrawdown` is nullable and is accompanied by
`drawdownBasis: "REALIZED_CLOSED_OUTCOMES"` and
`drawdownStatus` (`AVAILABLE`, `NO_CLOSED_OUTCOMES`, or `UNAVAILABLE`).
`COMPARISON_COHORT_REQUIRED` is returned as HTTP 409 with the available cohort
choices when a profile spans incompatible retained evidence.

## Market and projection semantics

Use each route's schema; there is no universal “every read accepts ALL” or “every
write requires a marketId body field” contract. Market data reads explicitly
validate supported scopes; per-symbol routes and ID-based resources have their own
ownership rules. Research derives/validates market from its source, and mixed
candidate intake is handled by the dedicated candidate route. Invalid `ALL`
mutations must not fall back to a single market silently.

`/api/market/status?marketId=US_EQUITIES` returns 409 when that runtime is disabled.
Check both `ENABLED_MARKETS` and `US_MARKET_DATA_ENABLED`; do not remove the guard.
The `ALL` status view aggregates market status, not financial balances.

Paper filters are defined by `paperEvidenceFiltersSchema`; coordinated routes use
the applicable run/market filters rather than filtering a multi-profile decision
as if it belonged to one profile. The paper-bot journal requests select exactly
one projection: `FUNDED`, `COORDINATED` (the API default), or `INDEPENDENT`.
`FUNDED` reads the configured funded account's filled orders through the funded
reporting service; unfilled, cancelled and rejected submissions are decisions,
not trades, and the shadow projections never include them. Independent default
model is QUOTE. Unresolved positions remain visible outside a selected date
window.

`GET /api/paper-bot/performance` serves one account's $ curve per request:
`account=COORDINATED` (default) reads realized coordinated P&L from the shared
positions ledger, and `account=FUNDED` reads the configured funded account's
equity at immutable run-end boundaries. Explicit `startDate`, `endDate` and
`granularity` (`TRADE`/`DAY`), an optional `source`, and `marketId` (defaults to
`CA_TSX`) scope the read; the two accounts are never combined in one response
(ADR-010). Funded points are never marked to a later price, runs without a
retained boundary are omitted and reported in `warnings`, and a market with no
configured funded account returns an empty curve with
`FUNDED_ACCOUNT_NOT_CONFIGURED`.

Candidate detail responses include retained `formationEvidence`, strategy state
events and the versioned feature snapshot. The Detail chart projects those records
into bounded SVG markers using the snapshot cutoff: state markers use the exact
event timestamp, formation origins are annotations rather than retroactive
eligibility, and missing provenance remains unknown. Feature levels produced by
identity `1.2.0` may contain nullable `provenance` with `levelId`, `originAt` and
`availableAt`; legacy `1.1.0` payloads remain valid without that field.

## Asynchronous research

POST backtests, calibrations, ranking research and statistical models returns
HTTP 202 with a durable job. Poll `/api/research-jobs/:id`; retrieve the finished
resource using the result identity. Cancellation is a separate POST. A successful
submission is not a completed backtest or trained model.

Calibration reports expose nullable `holdoutSelection`. New trials have nullable
TEST/ALL metrics: null means not evaluated, never zero performance. `analysesScope`
is VALIDATION for new runs and defaults to ALL for legacy reports. Completed
calibration job retries reuse their run; interrupted attempts require review
instead of automatic holdout re-execution.

Model requests support the source variants defined in `statistical-models.ts`:
completed captured backtest or frozen PAPER_EVIDENCE dataset. Activation is an
explicit mutation subject to source/validation gates and the
[learning policy](learning.md). Deactivation does not delete evidence.

## Inactive challenger observation

Inactive models are observed only through an explicitly registered, frozen
experiment. The API exposes read routes requiring a selected market:

```text
GET  /api/challenger-experiments?marketId=CA_TSX|US_EQUITIES
GET  /api/challenger-experiments/:id?marketId=...
GET  /api/challenger-experiments/:id/report?marketId=...&asOf=...
POST /api/challenger-experiments                 (Idempotency-Key required)
POST /api/challenger-experiments/:id/transitions (Idempotency-Key required)
```

Registration returns `REGISTERED`; explicit `START`, `PAUSE`, `RESUME`, `END`
and `REVOKE` actions append lifecycle transitions and never activate a model.
The report preserves pending, missed-deadline, engine-failure, invalid-input,
revoked and capture-unknown counts. Predictions are accepted only before their
original database-validated deadline. The Learning view is read-only and does
not expose enrollment or lifecycle mutation controls. This observation evidence
is not a broker order, paper-account balance, or automatic promotion decision.

## Contract map

| Domain contract                                         | Important distinction                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `candidates.ts`, `scoring.ts`, `strategies.ts`          | SETUP versus CONTEXT; deterministic score components, state, references and formation evidence |
| `market-data.ts`, `markets.ts`, `universe.ts`           | Instrument identity, quality, market scope, daily intake and coverage                          |
| `system-status.ts`                                      | Service readiness, operational readiness and actionability                                     |
| `profiles.ts`, `alerts.ts`                              | Immutable profile configs and READY/invalidation delivery                                      |
| `paper-bot.ts`                                          | Independent/coordinated reporting, execution state, economics and unresolved positions         |
| `paper-evidence-training.ts`                            | Cohorts, frozen datasets, qualification, learning overview and audit                           |
| `research-evidence.ts`, `evidence-automation.ts`        | Coverage cells/reports, immutable bindings, automation stages and work receipts                |
| `statistical-models.ts`                                 | Source/artifact provenance, eligibility, predictions and forward monitoring                    |
| `backtests.ts`, `calibration.ts`, `ranking-research.ts` | Captured replay, research controls and metrics                                                 |
| `events-jobs.ts`                                        | Browser frames and durable job state                                                           |

Candidate list rows use the current setup-evaluation contract, not the early flat
`{ price, bestStrategy, score }` sketch. Context rows have no trade references.
Legacy score/provenance defaults are explicit compatibility values, not reconstructed
current evidence.

## Browser WebSocket

`/ws?marketId=CA_TSX` or `US_EQUITIES` selects a market snapshot source. The current
handler defaults unrecognized/missing scope to CA; do not describe this as an ALL
socket or strict invalid-scope rejection. The frame contains `type: "snapshot"`,
timestamp, market, universe, candidates, contexts and alerts, with per-connection
sequence/schema metadata. Identical content is suppressed; connection/reconnection
gets an initial full frame. See `market-data/ws-frame.ts` and `routes/system.ts`.
The broadcaster is polled every two seconds. Conceptual event names in old design
documents are not all emitted browser message types.

## Internal scanner HTTP inventory

The API/worker use the internal Compose address. `/internal/v1/*` requires the
shared scanner credential; health endpoints are separate. Session startup is
singular `/session/start`, not `/sessions/start`; no session/end route is registered.

```text
GET  /health/live
GET  /health/ready
POST /internal/v1/session/start
PUT  /internal/v1/profiles
POST /internal/v1/candles/batch
POST /internal/v1/quotes/batch
POST /internal/v1/discovery/evaluate
POST /internal/v1/instruments/warm
GET  /internal/v1/candidates
GET  /internal/v1/symbol/{instrument_id}/features
POST /internal/v1/backtests
POST /internal/v1/backtests/signals
POST /internal/v1/backtests/signals/chunk
POST /internal/v1/backtests/chunk
POST /internal/v1/statistical-models/train
POST /internal/v1/statistical-models/predict
```

Batch envelopes preserve one market and reject inconsistent payload ownership.
Quote ingestion returns features/evaluations for persistence. Signal replay and
chunk endpoints support authoritative TypeScript execution; the legacy internal
backtest endpoint is not a promise that Python owns current paper fills.

Discovery evaluation is stateless and separate from strategy sessions. Its strict
input includes market identity, quote timestamps, daily/slot history and verified
calendar/adjustment provenance; its result contains metrics, availability times
and PASS/FAIL/UNEVALUABLE/DEFERRED reasons. `discovery-evidence.ts` and Python
`discovery_models.py` share tested synthetic fixtures. `ScannerFeatureClient`
rejects mismatched response ownership. Public discovery status/history/preview and
mode routes are wired; AUTO_ADD remains blocked pending commissioning.

Incremental instrument warm-up requires `marketId`, `instrument`, `candles` and
an explicit `asOf` timestamp. Its readiness response checks continuous one-minute
coverage through the last completed minute, the full opening range, ten matching
historical prefixes, daily history and configured benchmarks. Missing coverage
does not establish readiness. Deploy API and scanner images from the same revision
when changing this internal request contract.

## Authentication and operations

Default localhost mode does not require an operator login. The remote profile uses
session cookies and CSRF protection for protected mutations; see the
[operations runbook](operations-runbook.md). Health readiness gates dependencies;
HTTP 200 system status may describe degraded/non-actionable operation. Retention
mutation can return 207 with per-table failure details. A metrics endpoint existing
does not prove an external scraper/receiver has been commissioned.
