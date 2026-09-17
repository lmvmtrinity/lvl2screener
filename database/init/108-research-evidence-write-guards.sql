-- Keep immutable owner identity and coverage-result ownership consistent at commit.
CREATE FUNCTION validate_coverage_result_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM research_coverage_request q
    JOIN research_job j ON j.id=NEW.job_id
    JOIN research_coverage_report r ON r.hash=NEW.report_hash
    WHERE q.id=NEW.request_id AND q.latest_job_id=j.id
      AND j.job_type='COVERAGE_VERIFICATION'
      AND j.request_payload->>'version'='coverage-verification-v2'
      AND j.request_payload->>'requestId'=q.id::text
      AND j.request_payload->'request'=q.request
      AND r.market_id=q.market_id AND r.status=NEW.status
      AND r.report->>'manifestHash'=q.request->'manifest'->>'hash'
  ) THEN RAISE EXCEPTION 'COVERAGE_RESULT_OWNERSHIP_MISMATCH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coverage_result_ownership BEFORE INSERT ON research_coverage_request_result
FOR EACH ROW EXECUTE FUNCTION validate_coverage_result_ownership();

CREATE FUNCTION protect_research_owner_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.research_evidence IS NOT NULL AND OLD.research_evidence IS DISTINCT FROM NEW.research_evidence
  THEN RAISE EXCEPTION 'IMMUTABLE_RESEARCH_OWNER_BINDING'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION validate_research_owner_column() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved JSONB; column_value JSONB; owner_table TEXT; owner_type TEXT; owner_uuid UUID;
BEGIN
  IF TG_TABLE_NAME='research_evidence_binding' THEN
    owner_type:=NEW.owner_kind; owner_uuid:=NEW.owner_id;
    owner_table:=CASE owner_type WHEN 'JOB' THEN 'research_job' WHEN 'BACKTEST' THEN 'backtest_run'
      WHEN 'CALIBRATION' THEN 'calibration_run' WHEN 'DATASET' THEN 'statistical_training_dataset'
      WHEN 'MODEL' THEN 'statistical_model' END;
    EXECUTE format('SELECT research_evidence FROM %I WHERE id=$1',owner_table) INTO column_value USING owner_uuid;
    saved:=NEW.binding;
  ELSE
    owner_type:=TG_ARGV[0]; owner_uuid:=NEW.id;
    -- Read final transaction state, not an earlier deferred UPDATE image.
    EXECUTE format('SELECT research_evidence FROM %I WHERE id=$1',TG_TABLE_NAME) INTO column_value USING owner_uuid;
    SELECT binding INTO saved FROM research_evidence_binding WHERE owner_kind=owner_type AND owner_id=owner_uuid;
  END IF;
  IF column_value IS DISTINCT FROM saved THEN RAISE EXCEPTION 'EVIDENCE_OWNER_COLUMN_MISMATCH'; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE item RECORD; BEGIN
  FOR item IN SELECT * FROM (VALUES ('research_job','JOB'),('backtest_run','BACKTEST'),
    ('calibration_run','CALIBRATION'),('statistical_training_dataset','DATASET'),('statistical_model','MODEL')) AS owners(tbl,kind)
  LOOP
    EXECUTE format('CREATE TRIGGER research_owner_binding_immutable BEFORE UPDATE OF research_evidence ON %I FOR EACH ROW EXECUTE FUNCTION protect_research_owner_binding()',item.tbl);
    EXECUTE format('CREATE CONSTRAINT TRIGGER research_owner_column_consistency AFTER INSERT OR UPDATE OF research_evidence ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_research_owner_column(%L)',item.tbl,item.kind);
  END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER research_binding_column_consistency AFTER INSERT ON research_evidence_binding
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_research_owner_column();

-- 106 introduced these tables without a foundation marker. Do not rewrite it.
INSERT INTO foundation_schema_version(version,description) VALUES
 (106,'Coverage request aliases and immutable replay sessions'),
 (108,'Research owner columns and coverage result ownership guards')
ON CONFLICT(version) DO NOTHING;
