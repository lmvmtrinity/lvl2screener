# Operations Runbook

Reviewed against repository configuration on September 8, 2026. Commands below are
operational procedures, not authorization to mutate a running deployment. Dated
incidents and pre-migration instructions are historical context. Read
[paper execution](paper-execution.md), [learning](learning.md), and the
[deployment acceptance checklist](../operations/paper-bot-deployment-acceptance.md)
for current lifecycle and commissioning boundaries.

## Continuous session schedule

Keep Docker Compose running with the existing `restart: unless-stopped` policies. Node owns separate `America/Toronto` and `America/New_York` market schedules and reduces closed-market work to an inexpensive session check. It warms the scanner when a new broker session is discovered, observes the 09:30–09:45 opening range, scans from 09:45, enables normal `READY` transitions at 10:00, marks entries after 11:30 as outside the preferred window, and accepts new entries through the regular 16:00 TSX close. All boundaries are configurable through the session variables documented in `.env.example`.

## 1. Purpose

This document describes how the system should behave operationally and how to diagnose failures.

## 2. Services

Expected Docker Compose services:

```text
web
api
scanner
postgres
worker
```

### Deployment trust boundary (W5)

The default Compose profile (`docker compose up --build`, no `--profile` flag) is
**localhost/private only**: it publishes exactly one host port, `web` on
`127.0.0.1:${WEB_PORT:-5173}` (nginx). `postgres`, `scanner`, and `api` have **no**
host port in this profile -- they only exist on the internal Compose network, and
the browser reaches every API/health/metrics/WebSocket route it needs through
nginx's reverse proxy (`apps/web/nginx.conf`), never directly. This is a
breaking change from earlier revisions of `docker-compose.yml`, which published
`5432`, `8000`, and `3000` on the host by default -- if you relied on connecting a
GUI client straight to Postgres or curling the scanner from the host, that no
longer works against the default profile.

If you need direct host access to Postgres/scanner during local development (for
example, `psql` from a GUI client, or the E2E suite's direct scanner health
check), layer the test/dev-only override:

```bash
docker compose -f docker-compose.yml -f docker-compose.debug-ports.yml up --build
```

This republishes `postgres` (`POSTGRES_HOST_PORT`, default `5432`), `scanner`
(`SCANNER_HOST_PORT`, default `8000`), and `api` (`API_HOST_PORT`, default
`3000`) on `127.0.0.1` only. Never apply this override to a deployment other
machines can reach.

The api/worker containers present a shared internal credential
(`SCANNER_SERVICE_TOKEN`) on every call to the scanner's `/internal/v1/*`
routes; the scanner rejects any request on those routes with a missing or
mismatched token once the variable is set (`services/scanner/app/main.py`).
`docker-compose.yml` sets a documented placeholder default for both sides in
the default profile -- change it (and everything else in "Secrets" below) before
running the optional remote profile.

`docker compose config` structurally verifies the default and remote profiles'
port exposure on every CI run; see `scripts/verify-compose-trust-boundary.mjs`
and the `pnpm run verify:compose` script.

#### Optional remote-access profile (W5 Phase B)

`docker-compose.yml` also defines a `web-remote` service, gated behind the
`remote` Compose profile, for the (opt-in, explicitly not the default) case
where this deployment needs to be reachable from somewhere other than the
operator's own machine. It reuses the same `web` image and static bundle with a
different, TLS-terminating nginx server block
(`apps/web/nginx.remote.conf`) that adds:

- TLS termination (self-signed or a real certificate -- see "TLS certificate"
  below);
- an edge rate limit and a smaller request-body-size cap ahead of the API's own
  limits;
- security headers including HSTS (the default profile's `web` service omits
  HSTS since it isn't served over TLS).

Enable it with:

```bash
docker compose --profile remote up --build
```

This starts `web-remote` **in addition to** the default `web` service unless
you also stop publishing `web`'s loopback port (set `WEB_BIND_ADDRESS` to an
address nothing binds, or otherwise avoid starting `web`). `web-remote` is
published on `${REMOTE_BIND_ADDRESS:-0.0.0.0}:${REMOTE_PORT:-8443}`, i.e. every
interface by default -- this is the one place in this stack that is meant to be
reachable from outside the host, and it requires everything under "Secrets"
below to be set to real values, not the documented local-development
placeholders.

##### TLS certificate

`web-remote` expects a certificate and key mounted at
`${REMOTE_CERT_DIR:-./certs}/server.crt` and `server.key`. For evaluation, a
self-signed pair is enough:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/server.key -out certs/server.crt \
  -days 365 -subj "/CN=your-hostname-or-ip"
```

For a real deployment, point `REMOTE_CERT_DIR` at a directory containing a
certificate issued by a real CA (e.g. a Let's Encrypt/ACME client run outside
this stack, or your own PKI) with the same two filenames.

##### Operator login

The remote profile requires a single-operator session login
(`apps/api/src/auth/`). Generate a password hash once:

```bash
node -e "
const {randomBytes,scryptSync}=require('crypto');
const salt=randomBytes(16);
const hash=scryptSync(process.argv[1],salt,64);
console.log('scrypt:'+salt.toString('hex')+':'+hash.toString('hex'));
" 'your-chosen-password'
```

Export the result as `OPERATOR_PASSWORD_HASH`, and export a random
`SESSION_SECRET` of at least 32 characters (e.g. `openssl rand -hex 32`), then:

```bash
REMOTE_ACCESS_ENABLED=true \
OPERATOR_PASSWORD_HASH='scrypt:...' \
SESSION_SECRET='...' \
POSTGRES_PASSWORD='a-real-secret' \
SCANNER_SERVICE_TOKEN='a-real-secret' \
docker compose --profile remote up --build
```

Once running, `POST /api/auth/login` with `{"password": "..."}` sets an
`HttpOnly` session cookie (`tsx_session`) and a readable CSRF cookie
(`tsx_csrf`); every subsequent request needs the session cookie, and every
mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) additionally needs an
`X-CSRF-Token` header matching `tsx_csrf` (double-submit cookie pattern).
`GET /health/live`, `GET /health/ready`, and `POST /api/auth/login` itself stay
reachable without a session so container healthchecks and the login form keep
working. All of this is inert in the default profile -- `REMOTE_ACCESS_ENABLED`
defaults to `false`, and a single trusted operator on their own machine never
sees a login screen.

### Pre-commissioning end-to-end check

Install the Playwright Chromium binary once with `pnpm exec playwright install chromium`,
then run `pnpm test:e2e`. The runner owns a separate `tsx-scanner-e2e` Compose project,
uses non-default host ports, seeds one deterministic persisted READY event, exercises
the dashboard, universe refresh, profile lifecycle, and full paper-entry/exit workflow,
and always removes the disposable database volume. Do not use the seed fixture against
a live or paper-production database.

### Metrics and optional monitoring

The default stack exposes `/metrics` through localhost:5173 but includes no scraper.
`docker-compose.monitoring.yml` supplies optional Prometheus/Alertmanager services
and market-specific scrapes. Use [paper-bot monitoring](../operations/paper-bot-monitoring.md)
for configuration and the isolated receiver smoke procedure. A smoke receiver pass
is not production notification commissioning. Redis/Grafana are not required
runtime services.

## 3. Health Endpoints

Node:

```text
GET /health/live
GET /health/ready
```

Python:

```text
GET /health/live
GET /health/ready
```

### Readiness boundary

HTTP readiness requires reachable database and scanner dependencies. Auth, market
session, benchmarks and synchronization belong to operational readiness below.
Do not add trading opportunity gates to a process health probe.

### Service-ready versus operationally actionable

`computeOperationalStatus` (`apps/api/src/foundation/operational-status.ts`) is
the single place every operator surface — `GET /health/ready`, `GET
/api/system/status`, `GET /metrics`, and the web footer — derives its status
from. It returns three distinct booleans, and conflating them is the failure
mode W6 exists to prevent:

- **`serviceReady`** — the process/dependency layer only: the database is
  reachable and the scanner service is reachable. This is what
  `GET /health/ready` gates on (HTTP 503 when false). A `serviceReady: true`
  system can still be operationally useless — for example, freshly started
  with no resolved universe yet.
- **`operationalReady`** — `serviceReady` plus a fully resolved session:
  market status is known, Questrade auth is `CONNECTED`, benchmarks are
  resolved, and the scanner has synchronized to the current profile set.
- **`actionable`** — `serviceReady` plus zero `reasonCodes` (see
  `OperationalReasonCode` in `@tsx-scanner/contracts`), i.e. the system is not
  just "up" but currently capable of producing a tradeable signal: the
  universe is non-empty and resolved, evaluations are being written during an
  open session, data is not stale, and the market is open. `actionable` is the
  boolean the web footer's `ACTIONABLE`/live-mode label must key off — never
  a single field like `market.dataStatus === "REALTIME"` in isolation, which
  ignores auth, scanner sync, session state, and universe/benchmark readiness.

The current helper checks quote/candle ages against a 60-second default only
when an age is non-null and the market is open. Benchmark/evaluation ages are
reported but are not separate freshness gates in this helper. Per-instrument
strategy actionability has additional checks. Do not treat this aggregate boolean
as proof that every symbol or every reported timestamp is fresh.

An empty or not-yet-evaluated universe, a closed market, unresolved
benchmarks, required re-authorization, and stale data are all non-actionable
`reasonCodes`, never a silent `ACTIVE`. `serviceReady: true` does not imply
`actionable: true`, and readiness turning green must never be read as "the
scanner is finding setups."

### Startup and readiness

`docker compose up --build` starts `web`, `api`, `worker`, `scanner`, and `postgres`. Compose waits for health checks in dependency order. In mock mode, API readiness reports the initialized mock adapter as the known market-data state. In live mode, operational readiness additionally requires the market runtime to synchronize. HTTP service readiness alone does not prove authentication, universe resolution, or actionability.

The foundation status contract is available at:

```text
GET /api/system/status
```

It remains HTTP 200 while degraded so the web console can render dependency failures. `GET /health/ready` returns HTTP 503 when service readiness fails; a market-only non-actionable condition does not necessarily make that endpoint fail.

### Market-data service and auth

API startup applies checksum-verified ordered migrations, then loads the mode-specific encrypted refresh token, rotates it atomically, enriches the universe symbols, loads each enabled market's hours, warms candles, and begins two-second quote polling. The persisted daily watchlist supplies candidates; external-catalog provider caches and shared broker budgets are implemented; automated screening/intake remain inactive. Relevant endpoints are:

```text
GET /api/market/status
GET /api/universe
```

Mock mode uses a deterministic mock-only encryption key when `APP_MASTER_KEY` is unset. A user-provided 32-byte base64 or 64-character hexadecimal master key is mandatory when live commissioning is enabled. Changing the key after credentials have been persisted makes the stored token intentionally unreadable.

For live mode, `QUESTRADE_REFRESH_TOKEN` bootstraps the `questrade_live` database record once. Every redemption invalidates the prior token, and the replacement is stored atomically before requests resume. Do not delete the PostgreSQL volume or change `APP_MASTER_KEY` after successful commissioning. If either happens, generate a new manual token and recreate the live credential record. `TSX_UNIVERSE_SYMBOLS` is an optional initial watchlist seed, not a complete exchange catalog or an override of the persisted daily list.

The Questrade personal app must authorize both account-information and market-data scopes. Account-information scope is needed for symbol lookup/detail calls even though this scanner does not retrieve account balances, positions, orders, or executions.

### Feature engine

At startup Node sends the enriched session to Python, warms it with 30 daily sessions and 10 prior intraday sessions, and then forwards candle and quote batches. Python returns feature snapshot `1.1.0`; Node persists it before exposing it at:

```text
GET /api/features
GET /api/features/:symbol
```

If Python restarts or loses its in-memory session, the market-data service becomes degraded, re-sends the session and warm-up history, and resumes feature generation automatically. A snapshot's `warmingUp` array identifies inputs that do not yet have enough history.

### Alerts

Node creates alerts only from authoritative strategy transitions: entry into `READY`, and `READY → INVALIDATED`. Alert records are persisted before they are exposed through `GET /api/alerts` and WebSocket snapshots. In-app alerts require no permission; browser notifications require explicit browser permission, and sound is opt-in. Browser preferences are local to that browser profile.

### Scanner board

The scanner board keeps one state-first best setup per symbol while preserving
other-setup counts and explicit warming/unavailable rows. Use its state, setup,
sector, context, readiness, and spread filters for attention management; do not
interpret a context-only or unavailable row as a trade. Candidate detail must
show readiness first, then setup scores/identity, context provenance, risk
geometry, and the transition timeline.

READY delivery is once per setup instance. The alert controls persist a 0–120
minute cooldown and either allow each new setup instance immediately or require
the prior delivered instance to invalidate first. Browser, sound, durable, and
reconnect delivery share the setup-instance deduplication key. Context
notifications remain off and cannot be enabled through the policy endpoint.

### Backtesting

Backtests are managed at `/api/backtests` and in the BACKTESTS dashboard tab. Runs use only quote/candle history already captured in PostgreSQL and execute synchronously through the scanner service. A run with no history is a valid completed research result with explicit data-quality warnings, not invented spread or volume data. Long runs may keep the request open; do not restart API/scanner services while a run is `RUNNING`. Failed runs retain their error for diagnosis.

Before accepting a parameter comparison, confirm the response from `/api/backtests/compare` is `comparable: true`. If not, control the listed date, universe, source, capital, sizing, slippage, or fee differences. Database backups must include `backtest_run`, `backtest_trade`, and `backtest_state_event`.

### Scanner profiles and strategy lab

- Confirm schema version 8 exists before starting the API on an upgraded database.
- `GET /api/strategies` lists registered modules; `GET /api/scanner-profiles` lists the current immutable configuration selection for each tab.
- Enabling, disabling, duplicating, or editing a profile synchronizes the enabled profile set to Python immediately. It does not restart or duplicate Questrade collection.
- Use `GET /api/opportunities` to verify the `ALL` best-per-symbol projection and `GET /api/evaluations?profileId=<uuid>` for audit history.
- Profile comparisons must use the same shared universe and explicit date/source/time controls. Empty paper or backtest outcomes are valid and must not be represented as wins.

### Calibration

- Calibration studies are managed at `/api/calibrations` and in the CALIBRATION dashboard tab. They use only captured quotes/candles and execute synchronously, so keep API and scanner services running until the request finishes.
- Keep grids bounded. The API caps tested combinations, discloses truncation, and rejects inputs more than 100 times larger than the requested cap.
- Treat `recommendedConfig: null` as the correct result when segment samples are thin, validation/test expectancy is not positive, or no neighboring plateau exists. A robustness score alone is not deployment approval.
- Review the leading sector, ATR-regime, and RVOL-regime slices for concentration. Calibration never edits or enables a scanner profile automatically.
- Database backups must include `calibration_run` in addition to the Phase 8 research tables.

### Universe automation

- The universe refreshes during API startup and when a new market session is detected. Use the UNIVERSE dashboard or `POST /api/universe/refresh` for an operator-triggered refresh.
- Confirm the latest run is `COMPLETED`, `activatedCount` meets `UNIVERSE_MINIMUM_SIZE`, and the exclusion reasons match the configured `UNIVERSE_*` thresholds before the scan window.
- Refresh activation is one database transaction. A failed provider request, missing evidence, or implausibly small result records a failed run and retains the previous active instruments.
- `GET /api/universe/runs` is the audit trail. Database backups must include `universe_refresh_run`, `universe_membership`, and the Phase 10 instrument metrics.
- The mock catalog validates orchestration only. Final commissioning requires a licensed or official complete TSX catalog behind the existing provider boundary.

### Statistical models and daily learning

Use the Learning view for readiness and automation history. The worker checks at
startup and daily at 17:00 America/New_York; unset/empty interval override selects
this schedule. Verify effective named settings, scheduler logs, job state and
materialized datasets rather than assuming “Auto enabled” proves a recent check.

Paper training requires completed LIVE runs and fully qualified closed QUOTE
outcomes. Backtest-source training uses a supported immutable captured run.
Insufficient data is valid. [Learning](learning.md) documents the exact source and
gates; [ADR-011](../adr/011-learning-evidence-and-promotion-discipline.md) requires
stable collection and prospective evidence before explicit promotion. Automation
creates inactive challengers only. Preserve source datasets, artifacts and observed
prediction snapshots in backups.

## 4. Dashboard Status Bar

Always display:

```text
Questrade: CONNECTED / DISCONNECTED / AUTH_REQUIRED
Market Data: REALTIME / DELAYED / STALE / UNKNOWN
TSX: OPEN / CLOSED
Scanner: ACTIVE / WARMING_UP / PAUSED / DEGRADED
Candidates: N
READY: N
Last quote: timestamp
Last engine update: timestamp
```

## 5. Freshness Monitoring

Track:

- last_quote_received
- last_candle_received
- last_engine_update
- last_frontend_broadcast

Suggested initial rule during regular hours:

```text
quote age > 10 seconds
→ DATA_STALE
→ no new READY signals
```

Configurable.

## 6. Failure Procedures

### Questrade unavailable

- set scanner `DEGRADED`
- stop READY transitions
- retain market-data ingestion retries
- exponential backoff
- surface visible warning

### Access token expired

- pause Questrade calls
- refresh token
- resume

### Refresh token failed

- set `AUTH_REQUIRED`
- stop actionable signals
- notify user

### Delayed data detected

- set `DATA_DELAYED`
- hard-disable READY transitions
- show critical UI warning

### Halt detected

- set candidate `HALTED`
- invalidate current setup
- suppress trade alerts; do not assume a dedicated halt-notification type exists

### Scanner/Python unavailable

- Node may continue ingesting market data
- no strategy evaluation
- system state `ENGINE_UNAVAILABLE`

### Database unavailable

Prefer pausing actionable signals rather than creating unauditable events.

## 7. Logging

Use structured logs.

Recommended categories:

```text
AUTH
MARKET_DATA
RATE_LIMIT
CANDLES
FEATURES
STRATEGY
SIGNAL
WEBSOCKET
DATABASE
BACKTEST
ERROR
```

Example:

```json
{
  "service": "scanner",
  "symbol": "BTO.TO",
  "event": "STRATEGY_STATE_CHANGED",
  "strategy": "ORB_RETEST",
  "from": "FORMING",
  "to": "READY",
  "score": 86,
  "timestamp": "2026-08-24T14:02:15Z"
}
```

Never log credentials or tokens.

## 8. Token Rotation Safety

Refresh-token rotation must be atomic.

Use a mutex or lock.

Failure to persist the new refresh token should prevent the old token state from being silently discarded.

## 9. Daily Startup Checklist

1. Start services.
2. Confirm DB healthy.
3. Confirm Questrade connected.
4. Confirm data is real-time.
5. Load market hours.
6. Paste the morning TradingView candidates into **Daily List** and review all
   five paste-report groups; resolve `unsupported` and `failed` inputs.
7. Confirm every submitted symbol remains visible as `WARMING`, `ANALYZABLE`,
   `FORMING`, `READY`, `INVALIDATED`, or `UNAVAILABLE`; review the displayed
   reason for anything unavailable.
8. Wait for required daily/1m/5m history to leave the per-symbol warm-up list.
9. Confirm scanner `ACTIVE` before the intended scan window.
10. Confirm browser WebSocket connected.
11. Confirm alert audio/notifications.

## 10. End-of-Day Tasks

Operational checklist (not every item below has an automatic scheduled job):

- inspect requested paper exits and visible unresolved remainders; do not fabricate closes
- verify the daily learning check, including legitimate NOOP outcomes
- close session state
- persist final candles
- calculate daily metrics
- rotate/compress logs
- backup configuration changes
- generate optional daily summary

## 11. Backup

Back up:

- PostgreSQL
- active strategy configs
- Questrade encrypted auth state
- signal history

### 11.1 Raw data retention (W2)

`database/init/028-retention-correction.sql` fixes the retention policy shipped in
020-phase9-observability.sql, which never successfully pruned anything (a foreign-key
violation between `feature_snapshot` and its children caused the whole prune to roll back).
Migration 119 removed the manual paper journal (`journal_trade`) and its guards from the
retention function. The current migration-defined windows (including migration 054) are:

| Table                                                                                                                                                                                                                                |  Retention | Notes                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------: | ----------------------------------------------------------------------------------------------------------------------- |
| `quote_snapshot`                                                                                                                                                                                                                     |   180 days | matches calibration's 180-day research horizon; comfortably covers backtest's 30-day default                            |
| `candle`                                                                                                                                                                                                                             |   365 days | cheaper per row than quotes, kept longer; warm-up/replay source                                                         |
| `feature_snapshot`                                                                                                                                                                                                                   |   180 days | parent of `strategy_evaluation`/`context_evaluation`; never shorter than either child                                   |
| `strategy_evaluation`                                                                                                                                                                                                                |    14 days | child of `feature_snapshot`                                                                                             |
| `context_evaluation`                                                                                                                                                                                                                 |    30 days | child of `feature_snapshot`                                                                                             |
| `strategy_signal`                                                                                                                                                                                                                    |    14 days | parent of `strategy_state_event`; rows still referenced by a surviving `strategy_state_event` survive regardless of age |
| `strategy_state_event`                                                                                                                                                                                                               |    90 days | rows still referenced by `scanner_alert` survive regardless of age                                                      |
| `scanner_alert`, `paper_bot_run`, `paper_signal_observation`, `paper_execution`, `paper_coordination_decision`, `paper_coordination_position`, `paper_profile_qualification`, `backtest_run`, `calibration_run`, `statistical_model` | indefinite | never pruned; automated evidence and audit trail                                                                        |

**This is an extension of the retention window, not an archive.** Once a row passes its window
and is deleted by `prune_retention_history()`, it is gone -- not moved to cold storage, not
recoverable except by restoring the whole database from a backup taken before that prune ran.
If you need quote/candle history beyond these windows for a specific study, export it (or take
a dedicated backup) before it ages out.

**Growth expectations.** Raw quotes are the dominant volume driver: at one row per instrument
per poll cycle, 180 days of retained history is roughly 13x the previous (never-actually-
enforced) 14-day policy's target size. Size `quote_snapshot`/`candle` storage for the
180-/365-day steady state, not for the un-pruned backlog that has accumulated since 020 shipped
-- see the next paragraph.

**Daily retention is scheduled by `029-schedule-retention.sql`.** `028` adds the corrected
`prune_retention_history()` function, the TimescaleDB procedure, and the run-history table;
`029` registers the daily Timescale job; migration 054 reduces strategy evaluation/signal retention to 14 days. The approved 180-day raw-quote and 365-day
candle policy is therefore enforced after deployment. Because 020 never successfully pruned,
the initial scheduled pass can remove a large backlog. Complete the backup-and-restore checklist
before deploying 029, and make a supervised dry run against the restored copy first:

```sql
-- One-time: run it by hand first and read the result before scheduling anything, so you know
-- what the first pass actually deletes.
SELECT * FROM prune_retention_history();

-- 029 registers the daily job automatically. Confirm it is present:
SELECT job_id, proc_name, schedule_interval
FROM timescaledb_information.jobs
WHERE proc_name = 'run_scheduled_retention';
```

`GET /api/system/retention` and the `scanner_retention_last_run_*` gauges on `/metrics` report
the most recent run's status (`RUNNING`/`SUCCEEDED`/`FAILED`/`SKIPPED_CONCURRENT`), per-table
rows deleted, and any error. `POST /api/system/retention/run` triggers an ad hoc run (e.g. for
the one-time backlog pass above, or to re-check after fixing a failure) and returns the same
summary; it responds `207` if any table's delete raised an error so a failed run is visible in
the HTTP response as well as in `retention_job_run` and the logs.

**Compression is not configured by the repository migrations.** No migration
sets Timescale compression options or registers a compression policy. The previous
`add_compression_policy` examples omitted required hypertable setup and are not a
ready-to-run procedure. Any future compression change needs a versioned migration,
checks against the deployed Timescale version, foreign-key and query compatibility,
and measured ingest/replay/retention and restore behavior on a disposable copy.
Do not infer compression safety solely from the absence of incoming foreign keys.

Do not rely solely on container-local storage.

### 11.1b Backup contents, snapshot consistency and verified restore

`pnpm backup:db -- backups/postgres-YYYYMMDDTHHMMSS.dump` writes the archive and
a `schemaVersion: 2` manifest. The manifest and the archive describe the same
database snapshot: the helper exports one snapshot, holds its transaction open
while it collects extension versions, hypertables and chunk counts, validated
foreign-key definitions, Timescale jobs and public row counts, and passes that
same snapshot to `pg_dump --snapshot`. Writers that commit after the snapshot
are excluded from both, so a concurrent write cannot make a valid archive fail
its manifest. The archive includes the TimescaleDB extension metadata required
to reconstruct hypertables, chunks and policies; it no longer excludes the
extension.

`pnpm backup:verify -- backups/postgres-YYYYMMDDTHHMMSS.dump` restores into a
disposable TimescaleDB container and checks the checksum, public row counts,
extension versions, registered hypertables and chunk counts, validated foreign
keys and Timescale jobs against the manifest. The restore is phased:
`timescaledb_pre_restore()` around pre-data and data, indexes/primary keys
before `timescaledb_post_restore()`, then foreign keys after it so they can
validate against re-attached chunks. Every restored Timescale job is paused
before `timescaledb_post_restore()` starts the scheduler and stays paused while
counts and integrity are checked, so a restored retention/compression job cannot
mutate the verification target; the job configuration itself is still compared
against the manifest. A `schemaVersion: 1` manifest predates the Timescale
metadata and is rejected with an explicit diagnostic; the September 14 retained
archive/manifest must not be overwritten or repaired in place.

Run the repeatable isolated regression harness before changing this pipeline:

```powershell
pnpm backup:test
```

It creates a task-owned TimescaleDB container, runs both real helpers, commits
rows during the backup to prove snapshot consistency, restores the archive with
the real verifier, and checks that a corrupt archive and a legacy manifest fail
visibly. It cleans up its container, temporary databases and generated
archives. It requires Docker and skips with a message when Docker is
unavailable.

### 11.2 Coordinated paper-portfolio remediation

Migration `053-paper-coordination-portfolio-remediation.sql` creates the durable
`COORDINATED_SHADOW` portfolio and backfills existing decisions and positions.
Before deploying it, run `pnpm backup:db` followed by `pnpm backup:verify`.

Use this read-only query before and after every restart or recovery. A `COMPLETED` run with an unresolved position violates completion integrity. An
overdue OPEN/CLOSE_PENDING row requires visible recovery investigation; missing
executable facts can legitimately prevent immediate closure. Never
repair one with an ad-hoc `UPDATE`.

```sql
SELECT p.id,p.symbol,p.session_date,p.status,r.status AS run_status,
       r.scheduled_close_at,p.state->>'lastFactTimestamp' AS last_fact,
       p.recovery_source,p.recovery_boundary,p.recovery_fact_timestamp,
       p.recovery_delay_ms,now()-coalesce(
         (p.state->>'lastFactTimestamp')::timestamptz,
         (p.state->'position'->>'entryTime')::timestamptz,p.created_at) AS age
FROM paper_coordination_position p
JOIN paper_coordination_decision d ON d.id=p.decision_id
JOIN paper_bot_run r ON r.id=d.run_id
JOIN paper_portfolio portfolio ON portfolio.id=p.portfolio_id
WHERE portfolio.key='COORDINATED_SHADOW'
  AND p.status IN ('OPEN','CLOSE_PENDING')
ORDER BY p.session_date,p.created_at;
```

Historical migration-053 incident procedure (not a claim that ELD is still open):
to repair the then-known ELD position, take and verify the backup, deploy the
migration with new approvals disabled, start the API once, and let the startup
overdue-run sweep call the same `requestQuoteSessionClose` path used live. Check
that the row became `CLOSED` or remains visibly `CLOSE_PENDING`, and record the
selected fact and recovery columns. Do not enable approvals while the query
returns an older unresolved row; policy v3 also enforces this fail-closed rule.

For the five-session acceptance gate, retain one dated result of the query
above plus `/api/system/status`, `/api/paper-bot/journal?projection=COORDINATED`, and
benchmark readiness for each session. Acceptance requires five consecutive
sessions with no completed-run orphan, no overdue invisible close, no unknown
quote-size unit, and exact agreement between database, API, and dashboard.
The same conditions are exported for alerting as
`scanner_paper_bot_completed_runs_with_unresolved_positions`,
`scanner_paper_bot_oldest_unresolved_position_age_ms`,
`scanner_paper_bot_unknown_quote_size_units`,
`scanner_paper_bot_overdue_runs`, and
`scanner_required_context_unavailable` Prometheus gauges.

## 12. Security

- TLS for external access -- the `remote` Compose profile's `web-remote`
  service terminates TLS (see "Optional remote-access profile" above); the
  default profile is HTTP-only because it is bound to `127.0.0.1` and never
  leaves the machine.
- secrets outside Git -- `.env` is git-ignored; `.env.example` documents names
  only, and every documented default is explicitly a local-development
  placeholder (see "Secrets" below).
- refresh tokens encrypted -- unchanged from earlier phases
  (`apps/api/src/questrade/token-crypto.ts`).
- browser never sees broker credentials -- unchanged from earlier phases.
- authenticated UI if exposed beyond localhost/private network -- the `remote`
  profile adds single-operator session login, CSRF protection on mutations,
  edge + API rate limits, and mutation audit logging (see "Optional
  remote-access profile" above and `apps/api/src/auth/`). The default profile
  intentionally has none of this: it never listens on anything but loopback,
  so a login screen would only get in a trusted operator's own way.
- internal service boundary -- `SCANNER_SERVICE_TOKEN` gates every api/worker
  call into the scanner's `/internal/v1/*` routes, independent of network
  placement (see "Deployment trust boundary" above).
- container hardening -- `api`, `worker`, `scanner`, `web`, and `web-remote`
  all run as a non-root user, with `cap_drop: [ALL]`, `read_only: true` root
  filesystems (writable `tmpfs` only where a process needs it, e.g. nginx's
  cache/run directories), and `no-new-privileges`. The API and scanner images
  are multi-stage builds: the runtime image ships only compiled output and
  production dependencies, never TypeScript sources, tests, Playwright, or
  build tooling.
- image scanning -- CI builds all three images and scans them with Trivy
  (`.github/workflows/ci.yml`, `container-scan` job). It's informational today
  (findings don't fail the build) until a vulnerability baseline/ignore-list
  policy exists.

### Secrets

Everything below has a documented "local development only" default suitable
for the default (loopback) profile, and every one of them must be overridden
with a real secret before running the `remote` profile -- the API refuses to
boot the `remote` profile with any of the documented defaults still in place
(`apps/api/src/config.ts`'s `REMOTE_ACCESS_ENABLED` validation).

| Variable                 | Default profile                                                           | Remote profile                                                  |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `POSTGRES_PASSWORD`      | `local_development_only` (fine -- Postgres has no host port)              | required real secret                                            |
| `SCANNER_SERVICE_TOKEN`  | `local-development-only-scanner-token` (fine -- scanner has no host port) | required real secret                                            |
| `OPERATOR_PASSWORD_HASH` | unused                                                                    | required (`scrypt:<salt>:<hash>`, see login instructions above) |
| `SESSION_SECRET`         | unused                                                                    | required, 32+ characters                                        |
| `APP_MASTER_KEY`         | required only for `MARKET_DATA_MODE=live`                                 | same                                                            |

None of these belong in `docker-compose.yml` itself; set them in a git-ignored
`.env` file or your process manager's secret store.

## 13. US Market Operations, Monitoring, and Rollback

### Enablement workflow

1. **Mock evaluation:** Run with `MARKET_DATA_MODE=mock`, `ENABLED_MARKETS=CA_TSX,US_EQUITIES`, `US_MARKET_DATA_ENABLED=true`, and `US_PAPER_TRADING_ENABLED=false`.
2. **Live observation:** Set `MARKET_DATA_MODE=live`, `ENABLED_MARKETS=CA_TSX,US_EQUITIES`, `US_MARKET_DATA_ENABLED=true`, `US_PAPER_TRADING_ENABLED=false`.
3. **Commissioning:** Complete the US commissioning checklist over at least two full trading sessions.
4. **Paper trading:** Only after sign-off, enable `US_PAPER_TRADING_ENABLED=true` with a conservative risk budget.

### Independent operational monitoring

- Check market statuses independently at `/api/market/status?marketId=ALL`.
- Telemetry: verify Prometheus gauges and logs carry `market_id` (`CA_TSX` or `US_EQUITIES`).
- Rate budget: monitor `429` responses and limiter queue depths. The shared priority limiter prioritizes queued live work; verify both markets under measured load rather than assuming starvation is impossible.
- Delayed data containment: delayed US quotes fail closed and will not produce trade signals or alerts.

### Rollback procedures

- **Stage 1 (Paper execution issues):** Set `US_PAPER_TRADING_ENABLED=false`. Preserve CA settings. Recreate API/worker to load the environment change and verify both markets afterward; the shared service recreation has an availability impact.
- **Stage 2 (Market data / provider issues):** Set `US_MARKET_DATA_ENABLED=false` or remove `US_EQUITIES` from `ENABLED_MARKETS`. Preserve CA settings and state; environment changes require service recreation, whose temporary availability impact must be checked.
- **Database rollback:** Do not infer old-binary compatibility from additive migration names (056–061 or later). Review the deployed revision and schema guards before rollback. Do not run ad hoc SQL down migrations. If database rollback is necessary, restore from the verified pre-migration backup taken before deployment.
