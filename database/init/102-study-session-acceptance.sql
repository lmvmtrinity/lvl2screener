-- Remediation S03 correction: STARTED exposure receipts are immutable, so an
-- accepted result is recorded in a separate immutable relation rather than
-- mutating the STARTED row in migration 099.
CREATE TABLE IF NOT EXISTS study_session_acceptance (
  authority_id UUID NOT NULL REFERENCES study_execution_authorization(id) ON DELETE RESTRICT,
  experiment_id UUID NOT NULL REFERENCES strategy_study(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('TRAIN','VALIDATION','TEST')),
  side TEXT NOT NULL CHECK (side IN ('baseline','challenger')),
  session_date DATE NOT NULL,
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  job_id UUID NOT NULL REFERENCES research_job(id) ON DELETE RESTRICT,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(authority_id,experiment_id,stage,side,session_date)
);

CREATE OR REPLACE FUNCTION reject_study_session_acceptance_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_STUDY_SESSION_ACCEPTANCE'; END;
$$;
DROP TRIGGER IF EXISTS study_session_acceptance_immutable
  ON study_session_acceptance;
CREATE TRIGGER study_session_acceptance_immutable
BEFORE UPDATE OR DELETE ON study_session_acceptance
FOR EACH ROW EXECUTE FUNCTION reject_study_session_acceptance_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES (102, 'Immutable study session acceptance receipts')
ON CONFLICT(version) DO NOTHING;
