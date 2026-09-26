-- Independent inactive signal-model research authority and phase ledger.
-- PREPARE_ONLY is the default. No row here can activate or enroll a model.

ALTER TABLE research_job DROP CONSTRAINT IF EXISTS research_job_job_type_check;
ALTER TABLE research_job ADD CONSTRAINT research_job_job_type_check CHECK (job_type IN (
  'BACKTEST','CALIBRATION','RANKING_RESEARCH','STATISTICAL_TRAINING',
  'COVERAGE_VERIFICATION','STRATEGY_STUDY','EXECUTION_DIAGNOSTICS',
  'FUNDED_HISTORICAL_REPLAY','FUNDED_EXECUTION_TRAINING','FUNDED_COMPARISON',
  'SIGNAL_MODEL_RESEARCH'
));

CREATE TABLE signal_model_research_authorization (
  id UUID PRIMARY KEY,
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  source_run_id UUID NOT NULL,
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  plan JSONB NOT NULL CHECK (jsonb_typeof(plan)='object'),
  trial_budget INTEGER NOT NULL CHECK (trial_budget BETWEEN 1 AND 10000),
  mode TEXT NOT NULL DEFAULT 'PREPARE_ONLY'
    CHECK (mode IN ('PREPARE_ONLY','EXECUTE_WHEN_READY')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_idempotency_key TEXT UNIQUE,
  dispatched_job_id UUID UNIQUE REFERENCES research_job(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  UNIQUE (id,market_id,source_run_id,source_digest,plan_hash),
  FOREIGN KEY (source_run_id,market_id)
    REFERENCES backtest_run(id,market_id) ON DELETE RESTRICT,
  CHECK (expires_at > granted_at)
);
CREATE INDEX signal_model_research_authorization_ready_idx
  ON signal_model_research_authorization(market_id,expires_at)
  WHERE revoked_at IS NULL AND dispatched_job_id IS NULL;

CREATE TABLE signal_model_research_execution_grant (
  authorization_id UUID PRIMARY KEY
    REFERENCES signal_model_research_authorization(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL UNIQUE REFERENCES research_job(id) ON DELETE RESTRICT,
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  source_run_id UUID NOT NULL,
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (authorization_id,job_id),
  FOREIGN KEY (authorization_id,market_id,source_run_id,source_digest,plan_hash)
    REFERENCES signal_model_research_authorization(id,market_id,source_run_id,source_digest,plan_hash)
    ON DELETE RESTRICT
);

CREATE TABLE signal_model_research_stage_claim (
  authorization_id UUID NOT NULL REFERENCES signal_model_research_authorization(id) ON DELETE RESTRICT,
  execution_job_id UUID NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('TRAIN','VALIDATION','TEST')),
  claim_id UUID NOT NULL UNIQUE,
  membership_hash TEXT NOT NULL CHECK (membership_hash ~ '^[a-f0-9]{64}$'),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (authorization_id,stage),
  UNIQUE (authorization_id,claim_id),
  FOREIGN KEY (authorization_id,execution_job_id)
    REFERENCES signal_model_research_execution_grant(authorization_id,job_id)
    ON DELETE RESTRICT
);

CREATE TABLE signal_model_research_attempt (
  authorization_id UUID NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('TRAIN','VALIDATION','TEST')),
  claim_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  candidate_identity TEXT NOT NULL CHECK (candidate_identity ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED','INSUFFICIENT_EVIDENCE','FAILED','CANCELED','INTERRUPTED')),
  outcome JSONB NOT NULL CHECK (jsonb_typeof(outcome)='object'),
  job_lease_owner TEXT NOT NULL,
  job_attempt_count INTEGER NOT NULL CHECK (job_attempt_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (authorization_id,attempt_id),
  UNIQUE (authorization_id,attempt_number),
  FOREIGN KEY (authorization_id,claim_id)
    REFERENCES signal_model_research_stage_claim(authorization_id,claim_id)
    ON DELETE RESTRICT
);

CREATE TABLE signal_model_validation_selection (
  authorization_id UUID PRIMARY KEY
    REFERENCES signal_model_research_authorization(id) ON DELETE RESTRICT,
  validation_attempt_id UUID NOT NULL UNIQUE,
  candidate_identity TEXT NOT NULL CHECK (candidate_identity ~ '^[a-f0-9]{64}$'),
  threshold DOUBLE PRECISION NOT NULL CHECK (threshold >= 0 AND threshold <= 100),
  selected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (authorization_id,validation_attempt_id)
    REFERENCES signal_model_research_attempt(authorization_id,attempt_id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION validate_signal_model_research_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE run backtest_run%ROWTYPE; evidence research_evidence_binding%ROWTYPE; coverage research_coverage_report%ROWTYPE;
BEGIN
  SELECT * INTO run FROM backtest_run WHERE id=NEW.source_run_id;
  SELECT * INTO evidence FROM research_evidence_binding WHERE owner_kind='BACKTEST' AND owner_id=NEW.source_run_id;
  SELECT * INTO coverage FROM research_coverage_report WHERE hash=evidence.coverage_report_hash;
  IF run.id IS NULL OR evidence.owner_id IS NULL OR coverage.hash IS NULL THEN
    RAISE EXCEPTION 'SIGNAL_MODEL_SOURCE_PROVENANCE_MISSING';
  END IF;
  IF run.status <> 'COMPLETED' OR run.data_source <> 'CAPTURED_QUOTES'
     OR run.execution_model_version <> 'paper-execution-v7'
     OR run.market_id IS DISTINCT FROM NEW.market_id
     OR run.research_evidence IS DISTINCT FROM evidence.binding
     OR evidence.market_id IS DISTINCT FROM NEW.market_id
     OR evidence.input_hash IS DISTINCT FROM NEW.source_digest
     OR coverage.status <> 'VERIFIED'
     OR coverage.input_hash IS DISTINCT FROM NEW.source_digest
     OR NEW.plan->>'sourceRunId' IS DISTINCT FROM NEW.source_run_id::text
     OR NEW.plan->>'marketId' IS DISTINCT FROM NEW.market_id
     OR NEW.plan->>'sourceDigest' IS DISTINCT FROM NEW.source_digest
     OR NEW.plan->>'sourceBindingHash' IS NULL
     OR NEW.plan->>'strategy' IS NULL
     OR NEW.plan->'memberships' IS NULL
     OR NEW.plan->'comparisonCriteria' IS NULL
     OR NEW.plan->'modelParameters' IS NULL
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_AUTHORIZATION_SCOPE_MISMATCH'; END IF;
  IF NOT (run.strategies ? (NEW.plan->>'strategy'))
     OR run.data_quality->>'spread' IS DISTINCT FROM 'CAPTURED'
     OR run.execution_assumptions IS NULL
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_SOURCE_UNVERIFIED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_model_research_authorization_validate
BEFORE INSERT ON signal_model_research_authorization
FOR EACH ROW EXECUTE FUNCTION validate_signal_model_research_authorization();

CREATE OR REPLACE FUNCTION protect_signal_model_research_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.market_id IS DISTINCT FROM NEW.market_id
     OR OLD.source_run_id IS DISTINCT FROM NEW.source_run_id
     OR OLD.source_digest IS DISTINCT FROM NEW.source_digest
     OR OLD.plan_hash IS DISTINCT FROM NEW.plan_hash
     OR OLD.plan IS DISTINCT FROM NEW.plan
     OR OLD.trial_budget IS DISTINCT FROM NEW.trial_budget
     OR OLD.mode IS DISTINCT FROM NEW.mode
     OR OLD.granted_at IS DISTINCT FROM NEW.granted_at
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.revoke_idempotency_key IS NOT NULL AND NEW.revoke_idempotency_key IS DISTINCT FROM OLD.revoke_idempotency_key)
     OR (OLD.dispatched_job_id IS NOT NULL AND NEW.dispatched_job_id IS DISTINCT FROM OLD.dispatched_job_id)
     OR (NEW.revoked_at IS NOT NULL AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS DISTINCT FROM transaction_timestamp()))
     OR (NEW.revoke_idempotency_key IS NOT NULL AND OLD.revoke_idempotency_key IS NOT NULL)
     OR (NEW.dispatched_job_id IS NOT NULL AND OLD.dispatched_job_id IS NOT NULL)
  THEN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_AUTHORIZATION'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_model_research_authorization_immutable
BEFORE UPDATE OR DELETE ON signal_model_research_authorization
FOR EACH ROW EXECUTE FUNCTION protect_signal_model_research_authorization();

CREATE OR REPLACE FUNCTION validate_signal_model_research_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE authority signal_model_research_authorization%ROWTYPE; job research_job%ROWTYPE;
BEGIN
  SELECT * INTO authority FROM signal_model_research_authorization WHERE id=NEW.authorization_id FOR SHARE;
  SELECT * INTO job FROM research_job WHERE id=NEW.job_id FOR SHARE;
  IF authority.id IS NULL OR job.id IS NULL
     OR authority.mode <> 'EXECUTE_WHEN_READY'
     OR authority.revoked_at IS NOT NULL OR authority.expires_at <= clock_timestamp()
     OR NEW.market_id IS DISTINCT FROM authority.market_id
     OR NEW.source_run_id IS DISTINCT FROM authority.source_run_id
     OR NEW.source_digest IS DISTINCT FROM authority.source_digest
     OR NEW.plan_hash IS DISTINCT FROM authority.plan_hash
     OR job.job_type <> 'SIGNAL_MODEL_RESEARCH'
     OR job.status NOT IN ('QUEUED','RUNNING')
     OR job.request_payload->>'authorizationId' IS DISTINCT FROM authority.id::text
     OR job.request_payload->>'planHash' IS DISTINCT FROM authority.plan_hash
     OR job.request_payload->'plan' IS DISTINCT FROM authority.plan
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_EXECUTION_GRANT_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_model_research_grant_validate
BEFORE INSERT ON signal_model_research_execution_grant
FOR EACH ROW EXECUTE FUNCTION validate_signal_model_research_grant();
CREATE TRIGGER signal_model_research_grant_immutable
BEFORE UPDATE OR DELETE ON signal_model_research_execution_grant
FOR EACH ROW EXECUTE FUNCTION reject_strategy_learning_ledger_mutation();

CREATE OR REPLACE FUNCTION protect_signal_model_stage_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.authorization_id IS DISTINCT FROM NEW.authorization_id
     OR OLD.execution_job_id IS DISTINCT FROM NEW.execution_job_id
     OR OLD.stage IS DISTINCT FROM NEW.stage OR OLD.claim_id IS DISTINCT FROM NEW.claim_id
     OR OLD.membership_hash IS DISTINCT FROM NEW.membership_hash
     OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
     OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR NEW.stage <> 'TEST' OR NEW.consumed_at IS DISTINCT FROM transaction_timestamp()
  THEN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_STAGE_CLAIM'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_model_stage_claim_immutable
BEFORE UPDATE OR DELETE ON signal_model_research_stage_claim
FOR EACH ROW EXECUTE FUNCTION protect_signal_model_stage_claim();

CREATE OR REPLACE FUNCTION validate_signal_model_stage_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE authority signal_model_research_authorization%ROWTYPE; grant_row signal_model_research_execution_grant%ROWTYPE;
DECLARE job research_job%ROWTYPE; stage_plan JSONB;
BEGIN
  SELECT * INTO authority FROM signal_model_research_authorization WHERE id=NEW.authorization_id FOR SHARE;
  SELECT * INTO grant_row FROM signal_model_research_execution_grant
   WHERE authorization_id=NEW.authorization_id AND job_id=NEW.execution_job_id FOR SHARE;
  SELECT * INTO job FROM research_job WHERE id=NEW.execution_job_id FOR SHARE;
  IF authority.id IS NULL OR grant_row.authorization_id IS NULL OR job.id IS NULL
     OR authority.mode <> 'EXECUTE_WHEN_READY' OR authority.revoked_at IS NOT NULL
     OR authority.expires_at <= clock_timestamp()
     OR job.job_type <> 'SIGNAL_MODEL_RESEARCH' OR job.status <> 'RUNNING'
     OR job.lease_expires_at <= clock_timestamp() OR job.cancellation_requested
     OR job.lease_owner IS NULL
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_ACTIVE_JOB_REQUIRED'; END IF;
  stage_plan := authority.plan->'memberships'->lower(NEW.stage);
  IF stage_plan IS NULL OR stage_plan->>'membershipHash' IS DISTINCT FROM NEW.membership_hash
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_STAGE_MEMBERSHIP_MISMATCH'; END IF;
  IF NEW.stage='VALIDATION' AND NOT EXISTS (
    SELECT 1 FROM signal_model_research_attempt a
    WHERE a.authorization_id=NEW.authorization_id AND a.stage='TRAIN' AND a.status='SUCCEEDED'
  ) THEN RAISE EXCEPTION 'SIGNAL_MODEL_TRAINING_RESULT_REQUIRED'; END IF;
  IF NEW.stage='TEST' AND NOT EXISTS (
    SELECT 1 FROM signal_model_validation_selection s
    JOIN signal_model_research_attempt a ON a.authorization_id=s.authorization_id
      AND a.attempt_id=s.validation_attempt_id AND a.stage='VALIDATION' AND a.status='SUCCEEDED'
    WHERE s.authorization_id=NEW.authorization_id
  ) THEN RAISE EXCEPTION 'SIGNAL_MODEL_VALIDATION_SELECTION_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_model_stage_claim_validate
BEFORE INSERT ON signal_model_research_stage_claim
FOR EACH ROW EXECUTE FUNCTION validate_signal_model_stage_claim();

CREATE OR REPLACE FUNCTION reject_signal_model_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_ATTEMPT'; END $$;
CREATE TRIGGER signal_model_attempt_immutable
BEFORE UPDATE OR DELETE ON signal_model_research_attempt
FOR EACH ROW EXECUTE FUNCTION reject_signal_model_attempt_mutation();

CREATE OR REPLACE FUNCTION validate_signal_model_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE authority signal_model_research_authorization%ROWTYPE; budget INTEGER; claim signal_model_research_stage_claim%ROWTYPE;
DECLARE job research_job%ROWTYPE; expected_stage TEXT;
BEGIN
  SELECT * INTO authority FROM signal_model_research_authorization WHERE id=NEW.authorization_id FOR UPDATE;
  SELECT * INTO claim FROM signal_model_research_stage_claim
   WHERE authorization_id=NEW.authorization_id AND claim_id=NEW.claim_id FOR SHARE;
  SELECT * INTO job FROM research_job WHERE id=claim.execution_job_id FOR SHARE;
  IF authority.id IS NULL OR claim.claim_id IS NULL OR job.id IS NULL
     OR authority.mode <> 'EXECUTE_WHEN_READY' OR authority.revoked_at IS NOT NULL
     OR authority.expires_at <= clock_timestamp()
     OR job.job_type <> 'SIGNAL_MODEL_RESEARCH' OR job.status <> 'RUNNING'
     OR job.lease_expires_at <= clock_timestamp() OR job.cancellation_requested
     OR job.lease_owner IS DISTINCT FROM NEW.job_lease_owner
     OR job.attempt_count IS DISTINCT FROM NEW.job_attempt_count
     OR claim.stage IS DISTINCT FROM NEW.stage
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_ATTEMPT_AUTHORITY_INVALID'; END IF;
  IF NEW.stage='TEST' AND NEW.status='SUCCEEDED' AND claim.consumed_at IS NULL
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_TEST_CLAIM_NOT_CONSUMED'; END IF;
  IF (SELECT count(*) FROM signal_model_research_attempt WHERE authorization_id=NEW.authorization_id) >= authority.trial_budget
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_TRIAL_BUDGET_EXHAUSTED'; END IF;
  IF NEW.attempt_number <> (SELECT count(*)+1 FROM signal_model_research_attempt WHERE authorization_id=NEW.authorization_id)
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_ATTEMPT_SEQUENCE_MISMATCH'; END IF;
  IF NEW.stage='VALIDATION' AND NEW.status='SUCCEEDED'
     AND (NEW.outcome->>'selectedCandidateIdentity' IS DISTINCT FROM NEW.candidate_identity
       OR COALESCE((NEW.outcome->>'selectedThreshold')::double precision, -1) NOT BETWEEN 0 AND 100)
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_VALIDATION_SELECTION_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_model_attempt_validate
BEFORE INSERT ON signal_model_research_attempt
FOR EACH ROW EXECUTE FUNCTION validate_signal_model_attempt();

CREATE OR REPLACE FUNCTION reject_signal_model_selection_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_SELECTION'; END $$;
CREATE TRIGGER signal_model_validation_selection_immutable
BEFORE UPDATE OR DELETE ON signal_model_validation_selection
FOR EACH ROW EXECUTE FUNCTION reject_signal_model_selection_mutation();

CREATE OR REPLACE FUNCTION validate_signal_model_selection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE attempt signal_model_research_attempt%ROWTYPE;
BEGIN
  SELECT * INTO attempt FROM signal_model_research_attempt
   WHERE authorization_id=NEW.authorization_id AND attempt_id=NEW.validation_attempt_id;
  IF attempt.attempt_id IS NULL OR attempt.stage <> 'VALIDATION'
     OR attempt.status <> 'SUCCEEDED'
     OR attempt.candidate_identity IS DISTINCT FROM NEW.candidate_identity
     OR attempt.outcome->>'selectedCandidateIdentity' IS DISTINCT FROM NEW.candidate_identity
     OR (attempt.outcome->>'selectedThreshold')::double precision IS DISTINCT FROM NEW.threshold
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_VALIDATION_SELECTION_MISMATCH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_model_validation_selection_validate
BEFORE INSERT ON signal_model_validation_selection
FOR EACH ROW EXECUTE FUNCTION validate_signal_model_selection();

INSERT INTO foundation_schema_version(version,description)
VALUES(140,'Independent dormant signal-model research authorization and phase ledger')
ON CONFLICT(version) DO NOTHING;
