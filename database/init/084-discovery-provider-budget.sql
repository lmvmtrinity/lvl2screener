-- Shared broker-identity allowance, separate from market-scoped evidence.
CREATE TABLE questrade_request_budget (
    namespace text PRIMARY KEY,
    blocked_until timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '1 hour'),
    last_started_at timestamptz,
    last_discovery_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE questrade_request_grant (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    namespace text NOT NULL REFERENCES questrade_request_budget(namespace),
    started_at timestamptz NOT NULL,
    discovery boolean NOT NULL
);
CREATE INDEX questrade_request_grant_window_idx
    ON questrade_request_grant(namespace, started_at);

-- Persist accepted catalogs, rejected-attempt evidence and mapping decisions.
CREATE TABLE discovery_catalog_cache (
    market_id text PRIMARY KEY CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    trading_date date NOT NULL,
    snapshot jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (snapshot->>'marketId' = market_id),
    CHECK ((snapshot->>'tradingDate')::date = trading_date)
);
CREATE TABLE discovery_catalog_attempt (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    trading_date date NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    failure_code text NOT NULL,
    retained_digest text
);
CREATE INDEX discovery_catalog_attempt_retention_idx ON discovery_catalog_attempt(attempted_at);

CREATE TABLE discovery_symbol_mapping (
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    provider_code text NOT NULL,
    provider_exchange text NOT NULL,
    catalog_fingerprint text NOT NULL,
    decision jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (market_id, provider_exchange, provider_code),
    CHECK (decision->>'marketId' = market_id),
    CHECK (decision->>'providerCode' = provider_code),
    CHECK (decision->>'providerExchange' = provider_exchange)
);
