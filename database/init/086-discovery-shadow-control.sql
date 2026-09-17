-- WP4: durable discovery mode authority and fenced shadow-run ownership.
-- Mode is PostgreSQL-owned; environment variables never override these rows.
CREATE TABLE discovery_mode (
    market_id text PRIMARY KEY CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    mode text NOT NULL CHECK (mode IN ('OFF', 'SHADOW', 'AUTO_ADD')),
    revision bigint NOT NULL CHECK (revision >= 0),
    updated_at timestamptz NOT NULL,
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500)
);

INSERT INTO discovery_mode(market_id, mode, revision, updated_at, actor, reason)
VALUES
    ('CA_TSX', 'OFF', 0, clock_timestamp(), 'system', 'WP4 default: discovery is disabled'),
    ('US_EQUITIES', 'OFF', 0, clock_timestamp(), 'system', 'WP4 default: discovery is disabled')
ON CONFLICT (market_id) DO NOTHING;

CREATE TABLE discovery_mode_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id text NOT NULL REFERENCES discovery_mode(market_id),
    previous_mode text NOT NULL CHECK (previous_mode IN ('OFF', 'SHADOW', 'AUTO_ADD')),
    mode text NOT NULL CHECK (mode IN ('OFF', 'SHADOW', 'AUTO_ADD')),
    previous_revision bigint NOT NULL CHECK (previous_revision >= 0),
    revision bigint NOT NULL CHECK (revision > previous_revision),
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX discovery_mode_audit_history_idx
    ON discovery_mode_audit(market_id, changed_at DESC, id);

-- One logical scheduled identity can have only one current owner. A re-claim after
-- expiry increments fencing_generation; stale workers must include both owner_token
-- and generation on every renewal, bind, result, and finalization write.
CREATE TABLE discovery_schedule_lease (
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    trading_date date NOT NULL,
    policy_version text NOT NULL,
    completed_bar_end timestamptz NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    owner_token uuid NOT NULL,
    fencing_generation bigint NOT NULL CHECK (fencing_generation > 0),
    run_id uuid REFERENCES discovery_run(id) ON DELETE SET NULL,
    lease_expires_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    renewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (market_id, trading_date, policy_version, completed_bar_end, idempotency_key)
);
CREATE INDEX discovery_schedule_lease_active_idx
    ON discovery_schedule_lease(market_id, status, lease_expires_at);
CREATE INDEX discovery_schedule_lease_run_idx
    ON discovery_schedule_lease(run_id);
