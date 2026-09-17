CREATE TABLE discovery_run_diagnostic (
    run_id uuid NOT NULL,
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    attempt_id uuid NOT NULL,
    schema_version text NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    payload jsonb NOT NULL,
    PRIMARY KEY (run_id, attempt_id),
    FOREIGN KEY (run_id, market_id) REFERENCES discovery_run(id, market_id) ON DELETE CASCADE,
    CHECK (payload @> jsonb_build_object('runId', run_id, 'marketId', market_id, 'attemptId', attempt_id)),
    CHECK (schema_version = 'discovery-attempt-diagnostics-v1'),
    CHECK (payload @> jsonb_build_object('schemaVersion', schema_version)),
    CHECK (payload ? 'capturedAt' AND (payload->>'capturedAt')::timestamptz = captured_at)
);

CREATE INDEX discovery_run_diagnostic_market_idx ON discovery_run_diagnostic(market_id, captured_at DESC, run_id, attempt_id);
CREATE INDEX discovery_run_diagnostic_run_idx ON discovery_run_diagnostic(run_id, captured_at DESC, attempt_id);

CREATE TRIGGER discovery_run_diagnostic_immutable BEFORE UPDATE ON discovery_run_diagnostic
    FOR EACH ROW EXECUTE FUNCTION reject_discovery_immutable_change();

CREATE FUNCTION guard_discovery_run_diagnostic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    parent discovery_run%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- A child can only disappear with its parent during normal run retention.
        IF EXISTS (SELECT 1 FROM discovery_run WHERE id = OLD.run_id) THEN
            RAISE EXCEPTION 'Discovery diagnostic is immutable';
        END IF;
        RETURN OLD;
    END IF;
    SELECT * INTO parent FROM discovery_run WHERE id = NEW.run_id AND market_id = NEW.market_id;
    -- Missing/wrong-market parents are rejected by the composite foreign key.
    IF FOUND AND (parent.status = 'RUNNING'
        OR NEW.payload->'finalRunCoverage' IS DISTINCT FROM parent.coverage
        OR (NEW.payload->>'frozenEvaluationAt')::timestamptz IS DISTINCT FROM parent.evaluation_at) THEN
        RAISE EXCEPTION 'Discovery diagnostic requires completed run evidence';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER discovery_run_diagnostic_guard BEFORE INSERT OR DELETE ON discovery_run_diagnostic
    FOR EACH ROW EXECUTE FUNCTION guard_discovery_run_diagnostic();

INSERT INTO foundation_schema_version(version, description)
VALUES(120, 'Immutable market-bound completed discovery attempt diagnostics')
ON CONFLICT (version) DO NOTHING;
