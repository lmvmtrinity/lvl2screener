-- Allow a first revocation after dispatch; frozen job and prior revocation remain immutable.
CREATE OR REPLACE FUNCTION protect_study_execution_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.market_id IS DISTINCT FROM NEW.market_id
     OR OLD.frozen_plan_hash IS DISTINCT FROM NEW.frozen_plan_hash
     OR OLD.prerequisite_policy_hash IS DISTINCT FROM NEW.prerequisite_policy_hash
     OR OLD.source_window_start IS DISTINCT FROM NEW.source_window_start
     OR OLD.source_window_end IS DISTINCT FROM NEW.source_window_end
     OR OLD.engine_revision IS DISTINCT FROM NEW.engine_revision
     OR OLD.runtime_fingerprint IS DISTINCT FROM NEW.runtime_fingerprint
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.max_studies IS DISTINCT FROM NEW.max_studies
     OR OLD.max_session_executions IS DISTINCT FROM NEW.max_session_executions
     OR OLD.mode IS DISTINCT FROM NEW.mode
     OR OLD.plan IS DISTINCT FROM NEW.plan
     OR OLD.granted_at IS DISTINCT FROM NEW.granted_at
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR (OLD.revoke_idempotency_key IS NOT NULL AND NEW.revoke_idempotency_key IS DISTINCT FROM OLD.revoke_idempotency_key)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.dispatched_job_id IS NOT NULL AND NEW.dispatched_job_id IS DISTINCT FROM OLD.dispatched_job_id)
  THEN
    RAISE EXCEPTION 'IMMUTABLE_STUDY_EXECUTION_AUTHORIZATION';
  END IF;
  RETURN NEW;
END $$;

INSERT INTO foundation_schema_version(version,description) VALUES(107,'Permit revocation of dispatched study authority') ON CONFLICT(version) DO NOTHING;
