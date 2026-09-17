-- Remediation S01/S03: immutable admitted session plans and durable authority
-- receipts. Existing legacy study rows remain readable but are not enriched.
CREATE TABLE IF NOT EXISTS study_session_plan (
  authorization_id UUID PRIMARY KEY REFERENCES study_execution_authorization(id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  plan JSONB NOT NULL CHECK (jsonb_typeof(plan)='object'),
  admitted_executions INTEGER NOT NULL CHECK (admitted_executions > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS study_session_receipt (
  authority_id UUID NOT NULL REFERENCES study_execution_authorization(id) ON DELETE RESTRICT,
  experiment_id UUID NOT NULL REFERENCES strategy_study(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('TRAIN','VALIDATION','TEST')),
  side TEXT NOT NULL CHECK (side IN ('baseline','challenger')),
  session_date DATE NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('STARTED','ACCEPTED','INTERRUPTED')),
  result_hash TEXT CHECK (result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'),
  job_id UUID NOT NULL REFERENCES research_job(id) ON DELETE RESTRICT,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(authority_id,experiment_id,stage,side,session_date)
);
CREATE OR REPLACE FUNCTION reject_study_authority_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_STUDY_AUTHORITY_RECORD'; END;
$$;
DROP TRIGGER IF EXISTS study_session_plan_immutable ON study_session_plan;
CREATE TRIGGER study_session_plan_immutable BEFORE UPDATE OR DELETE ON study_session_plan
FOR EACH ROW EXECUTE FUNCTION reject_study_authority_mutation();
DROP TRIGGER IF EXISTS study_session_receipt_immutable ON study_session_receipt;
CREATE TRIGGER study_session_receipt_immutable BEFORE UPDATE OR DELETE ON study_session_receipt
FOR EACH ROW EXECUTE FUNCTION reject_study_authority_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES (99, 'Study session plans and authority receipts')
ON CONFLICT(version) DO NOTHING;
