-- WP5: automatic provenance, durable PASS delivery and same-day exclusions.
-- Lock order for every mutation path: discovery_mode -> exclusion -> watchlist ->
-- discovery_intake_outbox. The evidence transaction only locks discovery_mode
-- before inserting a PASS outbox row; it never waits on provider/runtime I/O.

CREATE TABLE discovery_intake_exclusion (
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    trading_date date NOT NULL,
    normalized_symbol text NOT NULL CHECK (length(normalized_symbol) BETWEEN 1 AND 20),
    instrument_id uuid REFERENCES instrument(id) ON DELETE SET NULL,
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    cleared_at timestamptz,
    PRIMARY KEY (market_id, trading_date, normalized_symbol)
);
CREATE INDEX discovery_intake_exclusion_active_idx
    ON discovery_intake_exclusion(market_id, trading_date, normalized_symbol)
    WHERE cleared_at IS NULL;

CREATE TABLE discovery_intake_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_id uuid NOT NULL UNIQUE REFERENCES discovery_evaluation(id) ON DELETE RESTRICT,
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    trading_date date NOT NULL,
    policy_version text NOT NULL,
    mode_revision bigint NOT NULL CHECK (mode_revision >= 0),
    normalized_symbol text NOT NULL CHECK (length(normalized_symbol) BETWEEN 1 AND 20),
    provider_code text NOT NULL CHECK (length(provider_code) BETWEEN 1 AND 100),
    provider_exchange text NOT NULL CHECK (length(provider_exchange) BETWEEN 1 AND 50),
    questrade_symbol_id bigint NOT NULL CHECK (questrade_symbol_id > 0),
    instrument_id uuid REFERENCES instrument(id) ON DELETE SET NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'SYNCING', 'EXPIRED', 'FAILED')),
    sync_status text NOT NULL CHECK (sync_status IN ('PENDING', 'COMPLETE')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_expires_at timestamptz,
    last_error text,
    intake_at timestamptz,
    synchronized_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX discovery_intake_outbox_active_identity_idx
    ON discovery_intake_outbox(market_id, trading_date, normalized_symbol)
    WHERE status IN ('PENDING', 'PROCESSING', 'SYNCING')
       OR (status = 'DELIVERED' AND sync_status = 'PENDING');
CREATE INDEX discovery_intake_outbox_pending_idx
    ON discovery_intake_outbox(market_id, status, next_attempt_at, created_at);
CREATE INDEX discovery_intake_outbox_evaluation_idx
    ON discovery_intake_outbox(evaluation_id);
