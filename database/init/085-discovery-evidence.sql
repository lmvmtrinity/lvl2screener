CREATE TABLE discovery_policy (
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    version text NOT NULL,
    definition jsonb NOT NULL,
    effective_at timestamptz NOT NULL,
    PRIMARY KEY (market_id, version),
    CHECK (definition @> jsonb_build_object('marketId', market_id, 'version', version))
);

CREATE FUNCTION reject_discovery_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Discovery evidence/policy is immutable';
END;
$$;
CREATE TRIGGER discovery_policy_immutable BEFORE UPDATE OR DELETE ON discovery_policy
    FOR EACH ROW EXECUTE FUNCTION reject_discovery_immutable_change();

CREATE TABLE discovery_catalog_snapshot (
    id uuid PRIMARY KEY,
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    trading_date date NOT NULL,
    digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
    row_count integer NOT NULL CHECK (row_count > 0),
    fetched_at timestamptz NOT NULL,
    snapshot jsonb NOT NULL,
    UNIQUE (market_id, trading_date, digest),
    UNIQUE (id, market_id),
    CHECK (snapshot @> jsonb_build_object('marketId', market_id, 'tradingDate', trading_date::text, 'digest', digest))
);
CREATE TRIGGER discovery_catalog_snapshot_immutable BEFORE UPDATE ON discovery_catalog_snapshot
    FOR EACH ROW EXECUTE FUNCTION reject_discovery_immutable_change();

CREATE TABLE discovery_catalog_member (
    snapshot_id uuid NOT NULL REFERENCES discovery_catalog_snapshot(id) ON DELETE CASCADE,
    provider_exchange text NOT NULL,
    provider_code text NOT NULL,
    PRIMARY KEY (snapshot_id, provider_exchange, provider_code)
);
CREATE TRIGGER discovery_catalog_member_immutable BEFORE UPDATE ON discovery_catalog_member
    FOR EACH ROW EXECUTE FUNCTION reject_discovery_immutable_change();

CREATE TABLE discovery_run (
    id uuid PRIMARY KEY,
    market_id text NOT NULL,
    trading_date date NOT NULL,
    policy_version text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('SHADOW', 'AUTO_ADD')),
    evaluation_at timestamptz NOT NULL,
    completed_bar_end timestamptz NOT NULL,
    catalog_snapshot_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')),
    coverage jsonb NOT NULL,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    failure text,
    UNIQUE (market_id, trading_date, idempotency_key),
    UNIQUE (id, market_id, policy_version),
    UNIQUE (id, catalog_snapshot_id),
    FOREIGN KEY (market_id, policy_version) REFERENCES discovery_policy(market_id, version),
    FOREIGN KEY (catalog_snapshot_id, market_id) REFERENCES discovery_catalog_snapshot(id, market_id),
    CHECK (completed_bar_end <= evaluation_at),
    CHECK ((status = 'RUNNING') = (completed_at IS NULL)),
    CHECK (coverage ?& ARRAY['total','pass','fail','unevaluable','deferred']),
    CHECK ((coverage->>'total')::integer >= 0 AND (coverage->>'pass')::integer >= 0 AND (coverage->>'fail')::integer >= 0 AND (coverage->>'unevaluable')::integer >= 0 AND (coverage->>'deferred')::integer >= 0),
    CHECK ((coverage->>'total')::integer = (coverage->>'pass')::integer + (coverage->>'fail')::integer + (coverage->>'unevaluable')::integer + (coverage->>'deferred')::integer)
);
CREATE INDEX discovery_run_history_idx ON discovery_run(market_id, evaluation_at DESC, id);

CREATE FUNCTION guard_discovery_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.market_id,NEW.trading_date,NEW.policy_version,NEW.mode,NEW.evaluation_at,NEW.completed_bar_end,NEW.catalog_snapshot_id,NEW.idempotency_key,NEW.started_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.market_id,OLD.trading_date,OLD.policy_version,OLD.mode,OLD.evaluation_at,OLD.completed_bar_end,OLD.catalog_snapshot_id,OLD.idempotency_key,OLD.started_at)
        OR OLD.status <> 'RUNNING' THEN
        RAISE EXCEPTION 'Discovery run identity/completed evidence is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER discovery_run_identity BEFORE UPDATE ON discovery_run
    FOR EACH ROW EXECUTE FUNCTION guard_discovery_run_update();

CREATE TABLE discovery_evaluation (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL,
    market_id text NOT NULL,
    policy_version text NOT NULL,
    provider_code text NOT NULL,
    provider_exchange text NOT NULL,
    catalog_snapshot_id uuid NOT NULL,
    result jsonb NOT NULL,
    input_digest text CHECK (input_digest ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL,
    UNIQUE (run_id, provider_exchange, provider_code),
    FOREIGN KEY (run_id, market_id, policy_version) REFERENCES discovery_run(id, market_id, policy_version) ON DELETE CASCADE,
    FOREIGN KEY (run_id, catalog_snapshot_id) REFERENCES discovery_run(id, catalog_snapshot_id) ON DELETE CASCADE,
    FOREIGN KEY (catalog_snapshot_id, provider_exchange, provider_code) REFERENCES discovery_catalog_member(snapshot_id, provider_exchange, provider_code),
    CHECK (result @> jsonb_build_object('marketId', market_id, 'policyVersion', policy_version, 'providerCode', provider_code, 'providerExchange', provider_exchange))
);
CREATE INDEX discovery_evaluation_retention_idx ON discovery_evaluation(created_at);
CREATE TRIGGER discovery_evaluation_immutable BEFORE UPDATE ON discovery_evaluation
    FOR EACH ROW EXECUTE FUNCTION reject_discovery_immutable_change();

-- Separate payload table allows compaction without rewriting the immutable decision/digest.
CREATE TABLE discovery_evaluation_input (
    evaluation_id uuid PRIMARY KEY REFERENCES discovery_evaluation(id) ON DELETE CASCADE,
    payload jsonb NOT NULL
);
CREATE TRIGGER discovery_evaluation_input_immutable BEFORE UPDATE ON discovery_evaluation_input
    FOR EACH ROW EXECUTE FUNCTION reject_discovery_immutable_change();

-- Future intake/research links hold qualification inputs beyond ordinary retention.
CREATE TABLE discovery_evidence_hold (
    evaluation_id uuid PRIMARY KEY REFERENCES discovery_evaluation(id) ON DELETE RESTRICT,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
