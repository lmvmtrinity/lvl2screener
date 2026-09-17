-- WP03 I05: explicit, bounded authorization for one frozen study dispatch.

CREATE TABLE IF NOT EXISTS study_execution_authorization (
  id UUID PRIMARY KEY,
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  frozen_plan_hash TEXT NOT NULL CHECK (frozen_plan_hash ~ '^[a-f0-9]{64}$'),
  prerequisite_policy_hash TEXT NOT NULL CHECK (prerequisite_policy_hash ~ '^[a-f0-9]{64}$'),
  source_window_start DATE NOT NULL,
  source_window_end DATE NOT NULL CHECK (source_window_end >= source_window_start),
  engine_revision TEXT NOT NULL,
  runtime_fingerprint TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_studies INTEGER NOT NULL CHECK (max_studies = 1),
  max_session_executions INTEGER NOT NULL CHECK (max_session_executions > 0),
  mode TEXT NOT NULL CHECK (mode IN ('PREPARE_ONLY','EXECUTE_WHEN_READY')),
  plan JSONB NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  dispatched_job_id UUID UNIQUE REFERENCES research_job(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  revoke_idempotency_key TEXT UNIQUE,
  UNIQUE (frozen_plan_hash)
);

CREATE INDEX IF NOT EXISTS study_execution_authorization_ready_idx
  ON study_execution_authorization (market_id, expires_at)
  WHERE revoked_at IS NULL AND dispatched_job_id IS NULL;

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
     OR (NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NOT NULL)
     OR (NEW.revoke_idempotency_key IS NOT NULL AND OLD.revoke_idempotency_key IS NOT NULL)
     OR (NEW.dispatched_job_id IS NOT NULL AND OLD.dispatched_job_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'IMMUTABLE_STUDY_EXECUTION_AUTHORIZATION';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protect_study_execution_authorization_update
  ON study_execution_authorization;
CREATE TRIGGER protect_study_execution_authorization_update
BEFORE UPDATE ON study_execution_authorization
FOR EACH ROW EXECUTE FUNCTION protect_study_execution_authorization();

INSERT INTO foundation_schema_version(version, description)
VALUES (93, 'WP03 bounded study execution authorization')
ON CONFLICT (version) DO NOTHING;
