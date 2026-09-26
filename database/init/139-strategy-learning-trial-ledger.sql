-- Append-only candidate attempts attached to the existing frozen strategy study.
CREATE TABLE strategy_study_trial_ledger (
  study_id UUID PRIMARY KEY REFERENCES strategy_study(id),
  study_spec_hash TEXT NOT NULL CHECK (study_spec_hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  binding JSONB NOT NULL CHECK (jsonb_typeof(binding)='object'),
  trial_budget INTEGER NOT NULL CHECK (trial_budget BETWEEN 1 AND 10000),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('EXECUTE_WHEN_READY','DIRECT_SUBMISSION')),
  authority_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (study_id, study_spec_hash, market_id)
);

-- Claim creation reserves one budget slot before a worker starts candidate work.
-- Claims are immutable and survive process/lease loss; retrying the same key can
-- resume the exact candidate without charging another slot.
CREATE TABLE strategy_study_trial_claim (
  study_id UUID NOT NULL REFERENCES strategy_study_trial_ledger(study_id),
  attempt_id UUID NOT NULL,
  candidate_identity TEXT NOT NULL CHECK (candidate_identity ~ '^[a-f0-9]{64}$'),
  candidate_spec JSONB NOT NULL CHECK (jsonb_typeof(candidate_spec)='object'),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  job_id UUID NOT NULL REFERENCES research_job(id),
  job_attempt_count INTEGER NOT NULL CHECK (job_attempt_count > 0),
  lease_owner TEXT NOT NULL CHECK (length(lease_owner)>0),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (study_id, attempt_id),
  UNIQUE (study_id, attempt_number),
  UNIQUE (study_id, candidate_identity),
  UNIQUE (study_id, attempt_id, candidate_identity, attempt_number)
);

CREATE TABLE strategy_study_trial_attempt (
  study_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  candidate_identity TEXT NOT NULL CHECK (candidate_identity ~ '^[a-f0-9]{64}$'),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED','INSUFFICIENT_EVIDENCE','FAILED','CANCELED','INTERRUPTED')),
  outcome JSONB NOT NULL CHECK (jsonb_typeof(outcome)='object'),
  job_id UUID NOT NULL REFERENCES research_job(id),
  job_attempt_count INTEGER NOT NULL CHECK (job_attempt_count > 0),
  lease_owner TEXT NOT NULL CHECK (length(lease_owner)>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (study_id, attempt_id),
  FOREIGN KEY (study_id,attempt_id,candidate_identity,attempt_number)
    REFERENCES strategy_study_trial_claim(study_id,attempt_id,candidate_identity,attempt_number)
);

CREATE TABLE strategy_study_final_test_link (
  study_id UUID PRIMARY KEY REFERENCES strategy_study(id),
  study_spec_hash TEXT NOT NULL CHECK (study_spec_hash ~ '^[a-f0-9]{64}$'),
  test_claim_id UUID NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION reject_strategy_learning_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_STRATEGY_LEARNING_LEDGER'; END $$;
CREATE TRIGGER strategy_study_trial_ledger_immutable BEFORE UPDATE OR DELETE ON strategy_study_trial_ledger
FOR EACH ROW EXECUTE FUNCTION reject_strategy_learning_ledger_mutation();
CREATE TRIGGER strategy_study_trial_claim_immutable BEFORE UPDATE OR DELETE ON strategy_study_trial_claim
FOR EACH ROW EXECUTE FUNCTION reject_strategy_learning_ledger_mutation();
CREATE TRIGGER strategy_study_trial_attempt_immutable BEFORE UPDATE OR DELETE ON strategy_study_trial_attempt
FOR EACH ROW EXECUTE FUNCTION reject_strategy_learning_ledger_mutation();
CREATE TRIGGER strategy_study_final_test_link_immutable BEFORE UPDATE OR DELETE ON strategy_study_final_test_link
FOR EACH ROW EXECUTE FUNCTION reject_strategy_learning_ledger_mutation();

CREATE OR REPLACE FUNCTION strategy_study_trial_authority_valid(
  target_study_id UUID, target_job_id UUID, target_attempt_count INTEGER, target_lease_owner TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE ledger strategy_study_trial_ledger%ROWTYPE; study_spec JSONB; study_market TEXT;
BEGIN
  SELECT * INTO ledger FROM strategy_study_trial_ledger WHERE study_id=target_study_id;
  SELECT spec,market_id INTO study_spec,study_market FROM strategy_study WHERE id=target_study_id;
  IF NOT FOUND OR study_market <> ledger.market_id THEN RETURN FALSE; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM research_job j
     WHERE j.id=target_job_id AND j.job_type='STRATEGY_STUDY'
       AND j.status='RUNNING' AND j.lease_owner=target_lease_owner
       AND j.attempt_count=target_attempt_count
       AND j.lease_expires_at>clock_timestamp() AND NOT j.cancellation_requested
       AND j.request_payload->'plan'=study_spec
  ) THEN RETURN FALSE; END IF;
  IF ledger.authority_kind='EXECUTE_WHEN_READY' THEN
    RETURN EXISTS (
      SELECT 1 FROM study_execution_authorization a
       WHERE a.id=ledger.authority_id AND a.market_id=ledger.market_id
         AND a.frozen_plan_hash=ledger.study_spec_hash
         AND a.mode='EXECUTE_WHEN_READY' AND a.revoked_at IS NULL
         AND a.expires_at>clock_timestamp() AND a.dispatched_job_id=target_job_id
         AND a.plan=study_spec AND a.plan->>'experimentId'=target_study_id::text
    );
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM study_execution_grant g
     WHERE g.id=ledger.authority_id AND g.kind='DIRECT_SUBMISSION'
       AND g.job_id=target_job_id AND g.experiment_id=target_study_id
       AND g.market_id=ledger.market_id AND g.plan_hash=ledger.study_spec_hash
       AND g.plan=study_spec
  );
END $$;

CREATE OR REPLACE FUNCTION validate_strategy_study_trial_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE budget INTEGER; spec JSONB; study_market TEXT; ledger_hash TEXT; actual_hash TEXT; ledger_market TEXT;
BEGIN
  SELECT l.trial_budget,l.market_id,l.study_spec_hash,s.spec,s.market_id,s.spec_hash
    INTO budget,ledger_market,ledger_hash,spec,study_market,actual_hash
    FROM strategy_study_trial_ledger l JOIN strategy_study s ON s.id=l.study_id
   WHERE l.study_id=NEW.study_id FOR UPDATE OF l;
  IF budget IS NULL THEN RAISE EXCEPTION 'STRATEGY_STUDY_LEDGER_NOT_FOUND'; END IF;
  IF study_market <> ledger_market OR spec->'comparison'->>'marketId' <> ledger_market
     OR spec->'binding' IS DISTINCT FROM (SELECT binding FROM strategy_study_trial_ledger WHERE study_id=NEW.study_id)
     OR spec->'binding'->>'inputHash' <> (SELECT source_digest FROM strategy_study_trial_ledger WHERE study_id=NEW.study_id)
     OR actual_hash <> ledger_hash
  THEN RAISE EXCEPTION 'STRATEGY_STUDY_LEDGER_IDENTITY_MISMATCH'; END IF;
  IF NOT strategy_study_trial_authority_valid(NEW.study_id,NEW.job_id,NEW.job_attempt_count,NEW.lease_owner)
  THEN RAISE EXCEPTION 'STRATEGY_STUDY_AUTHORITY_INVALID'; END IF;
  IF (SELECT count(*) FROM strategy_study_trial_claim WHERE study_id=NEW.study_id) >= budget
  THEN RAISE EXCEPTION 'STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED'; END IF;
  IF NEW.attempt_number <> (SELECT count(*)+1 FROM strategy_study_trial_claim WHERE study_id=NEW.study_id)
  THEN RAISE EXCEPTION 'STRATEGY_STUDY_TRIAL_SEQUENCE_MISMATCH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER strategy_study_trial_claim_validate BEFORE INSERT ON strategy_study_trial_claim
FOR EACH ROW EXECUTE FUNCTION validate_strategy_study_trial_claim();

CREATE OR REPLACE FUNCTION validate_strategy_study_trial_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE claim strategy_study_trial_claim%ROWTYPE;
BEGIN
  SELECT * INTO claim FROM strategy_study_trial_claim
   WHERE study_id=NEW.study_id AND attempt_id=NEW.attempt_id;
  IF NOT FOUND OR claim.candidate_identity <> NEW.candidate_identity
     OR claim.attempt_number <> NEW.attempt_number THEN
    RAISE EXCEPTION 'STRATEGY_STUDY_TRIAL_CLAIM_REQUIRED';
  END IF;
  IF NOT strategy_study_trial_authority_valid(NEW.study_id,NEW.job_id,NEW.job_attempt_count,NEW.lease_owner)
  THEN RAISE EXCEPTION 'STRATEGY_STUDY_AUTHORITY_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER strategy_study_trial_attempt_validate BEFORE INSERT ON strategy_study_trial_attempt
FOR EACH ROW EXECUTE FUNCTION validate_strategy_study_trial_attempt();

CREATE OR REPLACE FUNCTION validate_strategy_study_final_test_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM strategy_study s JOIN strategy_study_receipt r ON r.study_id=s.id
     WHERE s.id=NEW.study_id AND s.spec_hash=NEW.study_spec_hash
       AND r.receipt_key='TEST_CLAIM' AND r.payload->>'jobId'=NEW.test_claim_id::text
  ) THEN RAISE EXCEPTION 'STRATEGY_STUDY_TEST_CLAIM_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER strategy_study_final_test_link_validate BEFORE INSERT ON strategy_study_final_test_link
FOR EACH ROW EXECUTE FUNCTION validate_strategy_study_final_test_link();

INSERT INTO foundation_schema_version(version,description)
VALUES(139,'Immutable bounded strategy study candidate trial ledger')
ON CONFLICT(version) DO NOTHING;
