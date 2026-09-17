-- Remediation E01: keep research evidence owners market-scoped even when a
-- job's market is nested inside its validated request payload.
CREATE OR REPLACE FUNCTION research_job_owner_market(payload JSONB, kind TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF kind='COVERAGE_VERIFICATION' THEN
    IF payload->>'version'='coverage-verification-v2' THEN
      RETURN payload->'request'->'recipe'->>'marketId';
    END IF;
    RETURN payload->'request'->>'marketId';
  ELSIF kind='STRATEGY_STUDY' THEN
    RETURN payload->'plan'->'comparison'->>'marketId';
  END IF;
  RETURN payload->>'marketId';
END;
$$;

CREATE OR REPLACE FUNCTION validate_research_owner_market()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_market TEXT;
BEGIN
  IF NEW.owner_kind='JOB' THEN
    SELECT research_job_owner_market(request_payload,job_type)
      INTO owner_market FROM research_job WHERE id=NEW.owner_id;
  ELSE
    EXECUTE format('SELECT market_id FROM %I WHERE id=$1',
      CASE NEW.owner_kind
        WHEN 'BACKTEST' THEN 'backtest_run'
        WHEN 'CALIBRATION' THEN 'calibration_run'
        WHEN 'DATASET' THEN 'statistical_training_dataset'
        WHEN 'MODEL' THEN 'statistical_model'
      END)
      INTO owner_market USING NEW.owner_id;
  END IF;
  IF owner_market IS NULL OR owner_market IS DISTINCT FROM NEW.market_id THEN
    RAISE EXCEPTION 'EVIDENCE_OWNER_MARKET_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_research_owner_market_insert ON research_evidence_binding;
CREATE TRIGGER validate_research_owner_market_insert
BEFORE INSERT ON research_evidence_binding
FOR EACH ROW EXECUTE FUNCTION validate_research_owner_market();

INSERT INTO foundation_schema_version(version, description)
VALUES (97, 'Research evidence owner market consistency remediation')
ON CONFLICT(version) DO NOTHING;
