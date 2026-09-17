# Questrade integration

Reviewed against repository implementation on September 8, 2026. This documents
the adapter and configuration, not a fresh certification of provider entitlements,
pricing, exchange policies or production connectivity. Provider observations and
remaining commissioning requirements belong in commissioning evidence
and the US checklist.

## Supported boundary

The adapter handles OAuth token redemption, dynamic API-server URLs, symbol
search/details, market hours, batched Level-1 quotes and historical candles.
It has no account-balance/holdings query or broker order-entry path. Paper fills
are generated internally and must never be presented as Questrade executions.

`MARKET_DATA_MODE=mock` is the default. The deterministic mock supports rotating
tokens, symbols, market hours and market-data fixtures; it cannot verify live
entitlement or execution quality. `live` selects the production HTTP transport.

## Authentication and secrets

Live bootstrap uses `QUESTRADE_REFRESH_TOKEN` and a valid `APP_MASTER_KEY` in the
ignored local environment. Client-ID/redirect settings do not implement an
interactive authorization flow. After first successful redemption, the encrypted
PostgreSQL token record is authoritative, not the now-stale bootstrap token.

`token-manager.ts`, `token-crypto.ts` and `market-data/postgres-token-store.ts`
coordinate rotation and encrypted persistence with concurrency protection. The
transport validates the returned API-server URL and response shape. Live and mock
token records remain separate. Restart must preserve the database and encryption
key; deleting either is not a routine auth fix.

Never expose tokens, database credentials, complete environment dumps or raw
account information in browser responses, logs, fixtures or documentation. Verify
required provider permissions during commissioning using sanitized samples.

## Intake, normalization and market isolation

`universe/` owns provider enumeration and the dated manual watchlist. Questrade
symbol search is not treated as a complete exchange catalog. `TSX_UNIVERSE_SYMBOLS`
is an optional seed, not a recurring replacement for the stored daily list.
Automatic external-catalog discovery has provider/cache infrastructure implemented; screening and intake remain inactive.

`normalizers.ts` and market policies preserve symbol, market, native currency,
exchange aliases, tick and displayed-size provenance. Canadian board-lot sizes
must be normalized to shares with their raw quantity and multiplier retained.
Unknown semantics cannot be guessed into an actionable execution. Supported market
identity and defaults are declared in `markets/market-profile.ts` and configuration.

US collection requires both `ENABLED_MARKETS=CA_TSX,US_EQUITIES` and
`US_MARKET_DATA_ENABLED=true`. `US_PAPER_TRADING_ENABLED` is independent. Do not
change it merely to diagnose data collection. Market and sector benchmarks are
configured separately and are never selected from the candidate list.

## Collection and feature readiness

`market-data/quote-service.ts`, `candle-service.ts`, `symbol-service.ts` and
`session-manager.ts` orchestrate normalized collection. Quotes are batched with a
default two-second poll. Candles are warmed/refreshed at 1m, 5m and 1d resolutions;
completed-bar availability controls strategy chronology. Exact batch/warm-up bounds
come from config and service code, not a historical suggested cadence.

The shared priority limiter orders queued broker work, observes rate headers and
blocks near exhaustion. In-flight calls are not preempted. Priority is not proof
that one market can never suffer contention; measure both markets' freshness and
queue/load behavior during soak tests.

Halts, delayed/stale data and unavailable dependencies fail applicable actionable
gates. Missing benchmark context affects its dependent signal rather than
fabricating a neutral observed return. A running collector can still be
non-actionable while warming up or outside its session.

## Calendar and recovery

Store timestamps in UTC and use America/Toronto or America/New_York for local
session logic. Use provider market hours for open/closed state, with configured
scanner/entry windows inside that operational model. Do not infer all holiday or
early-close cases are certified from matching normal-day clock times.

Session phase and scan/new-entry permissions are bounded by the provider's open
interval, including an early close. One market's close does not close its peer.

Auth, rate-limit, provider and scanner failures remain visible in market/system
status. Preserve durable token state on restart and diagnose the owning layer
before changing flags or stored data. See the [runbook](operations-runbook.md)
for readiness probes and safe recovery.

### Scanner recovery safeguard

Full scanner history reloads are limited to three attempts per market runtime
in a rolling hour. Startup, universe refresh and session/recovery reloads share
the allowance; an attempt is counted before its first history request, including
failed or partial fetches. Refused startup/refresh retries are checked before
universe enrichment so they do not start another round of broker requests.

Scanner failures also delay recovery by 30, 60, 120, 240 and then at most 300
seconds. Repeated poll ticks during a pause do not consume an attempt or extend
the deadline. The later of the retry delay and rolling-hour allowance determines
the next permitted reload. A successful upload alone does not reset the failure
streak: a complete open-market scan must succeed. Success never refunds an attempt.

The existing market-data error surface reports the pause reason, next allowed
attempt in UTC and original failure. Paused scanners stay unsynchronized; the
existing closed-market paper settlement path can still run. Candidate validation,
strategy rules, paper economics and broker limits are unchanged.

This guard is local to each running market service and resets when the API
process is replaced. The shared PostgreSQL broker budget still survives restart;
restarting does not restore spent broker requests. The safeguard bounds reload
attempts, not the number of requests in one reload, which depends on universe
size and provider pagination. It does not cache or replace retained market history.

## Source map

All paths are under `apps/api/src/`:

- `questrade/adapter.ts`, `types.ts`: supported calls and transport contracts.
- `questrade/live-transport.ts`, `mock-transport.ts`: production and fixture transport.
- `questrade/token-manager.ts`, `token-crypto.ts`: credential lifecycle.
- `questrade/rate-limiter.ts`, `normalizers.ts`: scheduling and provider normalization.
- `questrade/exchange.ts`: shared exchange aliases for intake, persisted membership
  and benchmark resolution. Benchmarks require exactly one quotable match with
  compatible currency and venue; ambiguous/unknown matches remain unresolved.
- `market-data/service.ts`, `runtime-coordinator.ts`: collection and independent runtimes.
- `market-data/scanner-recovery.ts`: full-history attempt limit and failure backoff.
- `markets/market-profile.ts`, `config.ts`: market identity, policy and configuration.

Universe-history queries carry the selected market through the service/store
boundary. New US universe refreshes record `AUTOMATED_US_UNIVERSE` provenance;
TSX retains its existing label. Local acceptance and outstanding live gates are
separated in the US code package.

## Durable broker budget (discovery WP2)

`questrade/postgres-request-budget.ts` now owns live market-data grants under one
`questrade_live` namespace shared by both markets and API instances. Grants are
committed before dispatch: 20 per rolling second, 15,000 per rolling hour, with
50ms minimum spacing. Discovery has at most 1,800/hour and one/second, leaves
6,000/hour monitoring headroom, and uses a bounded expiring queue. Shared provider
reset/429 blocks survive restart. Authentication is a separate category and cannot
lose rotated tokens to a failed market-budget observation write.

A previously unknown namespace conservatively waits one hour for unrecorded prior
usage to expire. First deployment must allow that pause outside market hours; API
HTTP/metrics serving remains available while market initialization waits. Normal
restarts retain spent allowance. Never erase/re-key budget state to bypass the wait.
Explicit mock transports can use a mock budget with fixed simulation clocks.
This code is not evidence of deployed capacity or completed discovery commissioning.
