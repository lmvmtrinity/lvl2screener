-- Execution authority is immutable and bound to exactly one reviewed plan/job.
CREATE TABLE study_execution_grant (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('EXECUTE_WHEN_READY','DIRECT_SUBMISSION')),
  authorization_id UUID UNIQUE REFERENCES study_execution_authorization(id),
  job_id UUID NOT NULL UNIQUE REFERENCES research_job(id),
  experiment_id UUID NOT NULL UNIQUE,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  plan_hash TEXT NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
  plan JSONB NOT NULL,
  admitted_executions INTEGER NOT NULL CHECK(admitted_executions>0),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind='EXECUTE_WHEN_READY' AND authorization_id=id) OR
         (kind='DIRECT_SUBMISSION' AND authorization_id IS NULL))
);
CREATE TRIGGER study_execution_grant_immutable BEFORE UPDATE OR DELETE ON study_execution_grant
FOR EACH ROW EXECUTE FUNCTION reject_study_authority_mutation();
-- Old exposure records remain unchanged. NOT VALID preserves their historical
-- identities without granting old jobs new execution authority.
ALTER TABLE study_session_plan DROP CONSTRAINT study_session_plan_authorization_id_fkey;
ALTER TABLE study_session_plan ADD CONSTRAINT study_session_plan_grant_fkey
FOREIGN KEY(authorization_id) REFERENCES study_execution_grant(id) NOT VALID;
ALTER TABLE study_session_receipt DROP CONSTRAINT study_session_receipt_authority_id_fkey;
ALTER TABLE study_session_receipt ADD CONSTRAINT study_session_receipt_grant_fkey
FOREIGN KEY(authority_id) REFERENCES study_execution_grant(id) NOT VALID;
ALTER TABLE study_session_acceptance DROP CONSTRAINT study_session_acceptance_authority_id_fkey;
ALTER TABLE study_session_acceptance ADD CONSTRAINT study_session_acceptance_grant_fkey
FOREIGN KEY(authority_id) REFERENCES study_execution_grant(id) NOT VALID;
ALTER TABLE study_session_acceptance ADD CONSTRAINT study_session_acceptance_started_fkey
FOREIGN KEY(authority_id,experiment_id,stage,side,session_date)
REFERENCES study_session_receipt(authority_id,experiment_id,stage,side,session_date) NOT VALID;
INSERT INTO foundation_schema_version(version,description) VALUES(104,'Bound direct and automatic study execution grants')
ON CONFLICT(version) DO NOTHING;
