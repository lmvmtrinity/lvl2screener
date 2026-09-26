-- Tighten the model authority boundary for the typed, canonical capture plan.
-- Migration 140 is retained unchanged for checksum compatibility.

CREATE OR REPLACE FUNCTION validate_signal_model_research_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run backtest_run%ROWTYPE;
  evidence research_evidence_binding%ROWTYPE;
  coverage research_coverage_report%ROWTYPE;
  src JSONB;
  stage TEXT;
  ids JSONB;
BEGIN
  SELECT * INTO run FROM backtest_run WHERE id=NEW.source_run_id;
  SELECT * INTO evidence FROM research_evidence_binding WHERE owner_kind='BACKTEST' AND owner_id=NEW.source_run_id;
  SELECT * INTO coverage FROM research_coverage_report WHERE hash=evidence.coverage_report_hash;
  src := NEW.plan->'source';
  IF run.id IS NULL OR evidence.owner_id IS NULL OR coverage.hash IS NULL THEN
    RAISE EXCEPTION 'SIGNAL_MODEL_SOURCE_PROVENANCE_MISSING';
  END IF;
  IF NEW.plan->>'version' IS DISTINCT FROM 'signal-model-experiment-v1'
     OR src->>'runId' IS DISTINCT FROM NEW.source_run_id::text
     OR src->>'marketId' IS DISTINCT FROM NEW.market_id
     OR src->>'sourceDigest' IS DISTINCT FROM NEW.source_digest
     OR src->>'sourceBindingHash' IS NULL
     OR src->>'orderedMembershipHash' IS NULL
     OR COALESCE((src->>'orderedMembershipCount')::integer,0) <= 0
     OR src->>'strategy' IS NULL
     OR src->>'strategyVersion' IS DISTINCT FROM run.strategy_version
     OR src->>'configVersion' IS DISTINCT FROM run.config_version
     OR src->>'executionModelVersion' IS DISTINCT FROM run.execution_model_version
     OR NEW.market_id IS DISTINCT FROM run.market_id
     OR run.status <> 'COMPLETED' OR run.data_source <> 'CAPTURED_QUOTES'
     OR run.execution_model_version <> 'paper-execution-v7'
     OR run.research_evidence IS DISTINCT FROM evidence.binding
     OR evidence.market_id IS DISTINCT FROM NEW.market_id
     OR evidence.input_hash IS DISTINCT FROM NEW.source_digest
     OR coverage.status <> 'VERIFIED'
     OR coverage.input_hash IS DISTINCT FROM NEW.source_digest
     OR NOT EXISTS (
       SELECT 1 FROM backtest_opportunity_capture_receipt receipt
       WHERE receipt.source_run_id=NEW.source_run_id
         AND receipt.membership_hash=src->>'orderedMembershipHash'
         AND receipt.expected_count=(src->>'orderedMembershipCount')::integer
         AND receipt.market_id=NEW.market_id
         AND receipt.execution_model_version=src->>'executionModelVersion'
         AND receipt.execution_assumptions_hash=src->>'executionAssumptionsHash'
     )
     OR NOT (run.strategies ? (src->>'strategy'))
     OR run.data_quality->>'spread' IS DISTINCT FROM 'CAPTURED'
     OR run.execution_assumptions IS NULL
     OR NEW.plan->'comparison'->>'unit' IS DISTINCT FROM (CASE WHEN NEW.market_id='CA_TSX' THEN 'CAD' ELSE 'USD' END)
     OR COALESCE((NEW.plan->>'trialBudget')::integer,0) IS DISTINCT FROM NEW.trial_budget
     OR COALESCE((NEW.plan->'model'->>'minimumTrainingSamples')::integer,0) < 20
     OR jsonb_typeof(NEW.plan->'model'->'thresholdCandidates') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.plan->'model'->'thresholdCandidates')=0
     OR COALESCE((NEW.plan->'comparison'->>'minimumUsefulNetPnlPerSelectedOpportunity')::double precision,0) <= 0
     OR COALESCE((NEW.plan->'comparison'->>'alpha')::double precision,0) NOT BETWEEN 0.01 AND 0.1
     OR COALESCE((NEW.plan->'comparison'->>'targetPower')::double precision,0) NOT BETWEEN 0.8 AND 0.99
     OR COALESCE((NEW.plan->'comparison'->>'minimumIndependentSessions')::integer,0) < 2
     OR COALESCE((NEW.plan->'comparison'->>'minimumValidationSessions')::integer,0) < 2
     OR COALESCE((NEW.plan->'comparison'->>'minimumClosedOutcomes')::integer,0) < 20
     OR COALESCE((NEW.plan->'comparison'->>'maximumMissedWinnerRate')::double precision,-1) NOT BETWEEN 0 AND 1
     OR COALESCE((NEW.plan->'comparison'->>'maximumDrawdownIncrease')::double precision,-1) < 0
     OR COALESCE((NEW.plan->'comparison'->>'maximumTurnoverIncrease')::double precision,-1) NOT BETWEEN 0 AND 10
     OR COALESCE((NEW.plan->'comparison'->>'maximumLargestSymbolShare')::double precision,-1) NOT BETWEEN 0 AND 1
     OR COALESCE((NEW.plan->'comparison'->>'maximumLargestSessionShare')::double precision,-1) NOT BETWEEN 0 AND 1
     OR jsonb_typeof(NEW.plan->'sessions'->'TRAIN') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.plan->'sessions'->'VALIDATION') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.plan->'sessions'->'TEST') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.plan->'sessions'->'TRAIN')=0
     OR jsonb_array_length(NEW.plan->'sessions'->'VALIDATION')=0
     OR jsonb_array_length(NEW.plan->'sessions'->'TEST')=0
     OR NEW.plan->'sessions'->'TRAIN'->>(jsonb_array_length(NEW.plan->'sessions'->'TRAIN')-1) >= NEW.plan->'sessions'->'VALIDATION'->>0
     OR NEW.plan->'sessions'->'VALIDATION'->>(jsonb_array_length(NEW.plan->'sessions'->'VALIDATION')-1) >= NEW.plan->'sessions'->'TEST'->>0
     OR COALESCE((NEW.plan->'overlapPurge'->>'labelHorizonSessions')::integer,-1) < 0
     OR jsonb_array_length(NEW.plan->'overlapPurge'->'trainValidationPurgeSessions') < (NEW.plan->'overlapPurge'->>'labelHorizonSessions')::integer
     OR jsonb_array_length(NEW.plan->'overlapPurge'->'validationTestPurgeSessions') < (NEW.plan->'overlapPurge'->>'labelHorizonSessions')::integer
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_AUTHORIZATION_SCOPE_MISMATCH'; END IF;

  -- Every partition member must be an exact captured opportunity in the frozen
  -- source scope. Stage is a plan partition, not mutable source metadata.
  FOREACH stage IN ARRAY ARRAY['TRAIN','VALIDATION','TEST'] LOOP
    ids := NEW.plan->'membership'->stage->'opportunityIds';
    IF jsonb_typeof(ids) IS DISTINCT FROM 'array' OR COALESCE(jsonb_array_length(ids),0)=0
       OR COALESCE((NEW.plan->'membership'->stage->>'membershipHash') ~ '^[a-f0-9]{64}$',FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'SIGNAL_MODEL_STAGE_MEMBERSHIP_INVALID';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(ids) AS item(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM backtest_opportunity_capture c
        WHERE c.source_run_id=NEW.source_run_id
          AND c.opportunity_id=item.id
          AND c.market_id=NEW.market_id
          AND c.strategy_name=src->>'strategy'
          AND c.strategy_version=src->>'strategyVersion'
          AND c.config_version=src->>'configVersion'
          AND c.execution_model_version=src->>'executionModelVersion'
          AND c.profile_id=(src->>'profileId')::uuid
          AND c.profile_name=src->>'profileName'
          AND c.execution_assumptions_hash=(src->>'executionAssumptionsHash')
          AND c.session_date::text = ANY(ARRAY(SELECT jsonb_array_elements_text(NEW.plan->'sessions'->stage)))
      )
    ) THEN RAISE EXCEPTION 'SIGNAL_MODEL_SOURCE_MEMBERSHIP_UNPROVEN'; END IF;
    IF jsonb_array_length(ids) <> (
      SELECT count(*)::integer FROM backtest_opportunity_capture c
      WHERE c.source_run_id=NEW.source_run_id AND c.market_id=NEW.market_id
        AND c.strategy_name=src->>'strategy' AND c.strategy_version=src->>'strategyVersion'
        AND c.config_version=src->>'configVersion' AND c.execution_model_version=src->>'executionModelVersion'
        AND c.profile_id=(src->>'profileId')::uuid AND c.profile_name=src->>'profileName'
        AND c.execution_assumptions_hash=src->>'executionAssumptionsHash'
        AND c.session_date::text = ANY(ARRAY(SELECT jsonb_array_elements_text(NEW.plan->'sessions'->stage)))
    ) THEN RAISE EXCEPTION 'SIGNAL_MODEL_STAGE_MEMBERSHIP_INCOMPLETE'; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT item.id,count(*) AS n FROM jsonb_array_elements_text(NEW.plan->'membership'->'TRAIN'->'opportunityIds') item(id) GROUP BY item.id
      UNION ALL
      SELECT item.id,count(*) AS n FROM jsonb_array_elements_text(NEW.plan->'membership'->'VALIDATION'->'opportunityIds') item(id) GROUP BY item.id
      UNION ALL
      SELECT item.id,count(*) AS n FROM jsonb_array_elements_text(NEW.plan->'membership'->'TEST'->'opportunityIds') item(id) GROUP BY item.id
    ) memberships GROUP BY id HAVING sum(n)>1
  ) THEN RAISE EXCEPTION 'SIGNAL_MODEL_OPPORTUNITY_MEMBERSHIP_OVERLAP'; END IF;
  RETURN NEW;
END $$;

-- Allow the single authorized revocation transition even after dispatch. The
-- migration-140 guard accidentally made any post-dispatch UPDATE impossible.
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
     OR (NEW.revoked_at IS NOT NULL AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS DISTINCT FROM transaction_timestamp() OR NEW.revoke_idempotency_key IS NULL))
     OR (NEW.revoke_idempotency_key IS NOT NULL AND OLD.revoke_idempotency_key IS NOT NULL)
  THEN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_AUTHORIZATION'; END IF;
  RETURN NEW;
END $$;

ALTER TABLE signal_model_research_stage_claim
  ADD COLUMN trial_cost INTEGER NOT NULL DEFAULT 0 CHECK (trial_cost BETWEEN 0 AND 1);

CREATE OR REPLACE FUNCTION protect_signal_model_stage_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE authority signal_model_research_authorization%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' OR OLD.authorization_id IS DISTINCT FROM NEW.authorization_id
     OR OLD.execution_job_id IS DISTINCT FROM NEW.execution_job_id
     OR OLD.stage IS DISTINCT FROM NEW.stage OR OLD.claim_id IS DISTINCT FROM NEW.claim_id
     OR OLD.membership_hash IS DISTINCT FROM NEW.membership_hash
     OR OLD.trial_cost IS DISTINCT FROM NEW.trial_cost
     OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
     OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR NEW.stage <> 'TEST' OR NEW.consumed_at IS DISTINCT FROM transaction_timestamp()
  THEN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_STAGE_CLAIM'; END IF;
  SELECT * INTO authority FROM signal_model_research_authorization WHERE id=NEW.authorization_id;
  IF authority.id IS NULL OR NEW.membership_hash IS DISTINCT FROM authority.plan->'membership'->'TEST'->>'membershipHash'
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_TEST_MEMBERSHIP_SCOPE_MISMATCH'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(authority.market_id || ':' || authority.source_digest,0));
  IF EXISTS (
    SELECT 1 FROM signal_model_research_test_consumption prior
    WHERE prior.market_id=authority.market_id AND prior.source_digest=authority.source_digest
      AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements_text(prior.test_sessions) prior_session
          WHERE authority.plan->'sessions'->'TEST' ? prior_session.value)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(prior.test_opportunity_ids) prior_id
          WHERE authority.plan->'membership'->'TEST'->'opportunityIds' ? prior_id.value)
      )
  ) THEN RAISE EXCEPTION 'SIGNAL_MODEL_TEST_MEMBERSHIP_ALREADY_CONSUMED'; END IF;
  INSERT INTO signal_model_research_test_consumption
    (authorization_id,market_id,source_run_id,source_digest,claim_id,membership_hash,test_sessions,test_opportunity_ids,consumed_at)
  VALUES (authority.id,authority.market_id,authority.source_run_id,authority.source_digest,NEW.claim_id,NEW.membership_hash,
    authority.plan->'sessions'->'TEST',authority.plan->'membership'->'TEST'->'opportunityIds',NEW.consumed_at);
  RETURN NEW;
END $$;

CREATE TABLE signal_model_research_test_consumption (
  authorization_id UUID PRIMARY KEY REFERENCES signal_model_research_authorization(id) ON DELETE RESTRICT,
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  source_run_id UUID NOT NULL,
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  claim_id UUID NOT NULL UNIQUE,
  membership_hash TEXT NOT NULL CHECK (membership_hash ~ '^[a-f0-9]{64}$'),
  test_sessions JSONB NOT NULL CHECK (jsonb_typeof(test_sessions)='array' AND jsonb_array_length(test_sessions)>0),
  test_opportunity_ids JSONB NOT NULL CHECK (jsonb_typeof(test_opportunity_ids)='array' AND jsonb_array_length(test_opportunity_ids)>0),
  consumed_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (authorization_id,claim_id) REFERENCES signal_model_research_stage_claim(authorization_id,claim_id) ON DELETE RESTRICT
);

CREATE INDEX signal_model_research_test_consumption_lineage_idx
  ON signal_model_research_test_consumption(market_id,source_digest);

CREATE OR REPLACE FUNCTION reject_signal_model_test_consumption_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_TEST_CONSUMPTION'; END $$;
CREATE TRIGGER signal_model_test_consumption_immutable
BEFORE UPDATE OR DELETE ON signal_model_research_test_consumption
FOR EACH ROW EXECUTE FUNCTION reject_signal_model_test_consumption_mutation();

CREATE OR REPLACE FUNCTION validate_signal_model_stage_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  authority signal_model_research_authorization%ROWTYPE;
  grant_row signal_model_research_execution_grant%ROWTYPE;
  charged INTEGER;
  job research_job%ROWTYPE;
  stage_plan JSONB;
  stage_key TEXT;
  prior_claim signal_model_research_stage_claim%ROWTYPE;
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
  SELECT * INTO prior_claim FROM signal_model_research_stage_claim
    WHERE authorization_id=NEW.authorization_id AND stage=NEW.stage FOR SHARE;
  IF prior_claim.claim_id IS NOT NULL THEN
    IF prior_claim.claim_id=NEW.claim_id
       AND prior_claim.execution_job_id=NEW.execution_job_id
       AND prior_claim.membership_hash=NEW.membership_hash
       AND prior_claim.trial_cost=NEW.trial_cost
    THEN RETURN NEW;
    ELSE RAISE EXCEPTION 'SIGNAL_MODEL_STAGE_CLAIM_CONFLICT'; END IF;
  END IF;
  stage_key := NEW.stage;
  stage_plan := authority.plan->'membership'->stage_key;
  IF stage_plan IS NULL OR stage_plan->>'membershipHash' IS DISTINCT FROM NEW.membership_hash
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_STAGE_MEMBERSHIP_MISMATCH'; END IF;
  IF (NEW.stage='TRAIN' AND NEW.trial_cost<>1) OR (NEW.stage<>'TRAIN' AND NEW.trial_cost<>0)
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_TRIAL_CHARGE_INVALID'; END IF;
  SELECT COALESCE(sum(trial_cost),0) INTO charged FROM signal_model_research_stage_claim WHERE authorization_id=NEW.authorization_id;
  IF charged + NEW.trial_cost > authority.trial_budget
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_TRIAL_BUDGET_EXHAUSTED'; END IF;
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

-- One model candidate consumes one trial even though the immutable phase ledger
-- stores TRAIN, VALIDATION, and TEST receipts for it.
CREATE OR REPLACE FUNCTION validate_signal_model_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  authority signal_model_research_authorization%ROWTYPE;
  claim signal_model_research_stage_claim%ROWTYPE;
  job research_job%ROWTYPE;
  budget INTEGER;
  prior_count INTEGER;
  distinct_candidates INTEGER;
BEGIN
  SELECT * INTO authority FROM signal_model_research_authorization WHERE id=NEW.authorization_id FOR UPDATE;
  SELECT * INTO claim FROM signal_model_research_stage_claim WHERE authorization_id=NEW.authorization_id AND claim_id=NEW.claim_id FOR SHARE;
  SELECT * INTO job FROM research_job WHERE id=claim.execution_job_id FOR SHARE;
  IF authority.id IS NULL OR claim.claim_id IS NULL OR job.id IS NULL
     OR authority.mode <> 'EXECUTE_WHEN_READY' OR authority.revoked_at IS NOT NULL OR authority.expires_at <= clock_timestamp()
     OR job.job_type <> 'SIGNAL_MODEL_RESEARCH' OR job.status <> 'RUNNING' OR job.lease_expires_at <= clock_timestamp()
     OR job.cancellation_requested OR job.lease_owner IS DISTINCT FROM NEW.job_lease_owner
     OR job.attempt_count IS DISTINCT FROM NEW.job_attempt_count OR claim.stage IS DISTINCT FROM NEW.stage
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_ATTEMPT_AUTHORITY_INVALID'; END IF;
  IF NEW.stage='TEST' AND NEW.status='SUCCEEDED' AND claim.consumed_at IS NULL
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_TEST_CLAIM_NOT_CONSUMED'; END IF;
  SELECT count(*) INTO prior_count FROM signal_model_research_attempt WHERE authorization_id=NEW.authorization_id;
  SELECT count(DISTINCT candidate_identity) INTO distinct_candidates FROM signal_model_research_attempt WHERE authorization_id=NEW.authorization_id;
  budget := authority.trial_budget;
  IF NOT EXISTS (SELECT 1 FROM signal_model_research_attempt WHERE authorization_id=NEW.authorization_id AND candidate_identity=NEW.candidate_identity)
     AND distinct_candidates >= budget
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_TRIAL_BUDGET_EXHAUSTED'; END IF;
  IF NEW.attempt_number <> prior_count+1
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_ATTEMPT_SEQUENCE_MISMATCH'; END IF;
  IF NEW.stage='VALIDATION' AND NEW.status='SUCCEEDED'
     AND (NEW.outcome->>'selectedCandidateIdentity' IS DISTINCT FROM NEW.candidate_identity
       OR COALESCE((NEW.outcome->>'selectedThreshold')::double precision, -1) NOT BETWEEN 0 AND 100)
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_VALIDATION_SELECTION_INVALID'; END IF;
  RETURN NEW;
END $$;

CREATE TABLE signal_model_research_report (
  authorization_id UUID PRIMARY KEY REFERENCES signal_model_research_authorization(id) ON DELETE RESTRICT,
  experiment_id UUID NOT NULL,
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  job_id UUID NOT NULL REFERENCES research_job(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('WAITING','INSUFFICIENT','COMPLETED','INTERRUPTED','FAILED')),
  selected_candidate_identity TEXT CHECK (selected_candidate_identity ~ '^[a-f0-9]{64}$'),
  selected_threshold DOUBLE PRECISION CHECK (selected_threshold BETWEEN 0 AND 100),
  evaluation JSONB CHECK (evaluation IS NULL OR jsonb_typeof(evaluation)='object'),
  reason_codes JSONB NOT NULL CHECK (jsonb_typeof(reason_codes)='array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'COMPLETED' OR (selected_candidate_identity IS NOT NULL AND selected_threshold IS NOT NULL AND evaluation IS NOT NULL))
);
CREATE OR REPLACE FUNCTION validate_signal_model_research_report() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  authority signal_model_research_authorization%ROWTYPE;
  grant_row signal_model_research_execution_grant%ROWTYPE;
  job research_job%ROWTYPE;
BEGIN
  SELECT * INTO authority FROM signal_model_research_authorization WHERE id=NEW.authorization_id;
  SELECT * INTO grant_row FROM signal_model_research_execution_grant WHERE authorization_id=NEW.authorization_id AND job_id=NEW.job_id;
  SELECT * INTO job FROM research_job WHERE id=NEW.job_id;
  IF authority.id IS NULL OR grant_row.authorization_id IS NULL OR job.id IS NULL
    OR NEW.experiment_id IS DISTINCT FROM (authority.plan->>'experimentId')::uuid
    OR NEW.source_digest IS DISTINCT FROM authority.source_digest
    OR NEW.plan_hash IS DISTINCT FROM authority.plan_hash
    OR job.job_type <> 'SIGNAL_MODEL_RESEARCH'
  THEN RAISE EXCEPTION 'SIGNAL_MODEL_REPORT_IDENTITY_MISMATCH'; END IF;
  IF TG_OP='UPDATE' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_REPORT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signal_model_research_report_validate
BEFORE INSERT OR UPDATE OR DELETE ON signal_model_research_report
FOR EACH ROW EXECUTE FUNCTION validate_signal_model_research_report();

CREATE TABLE signal_model_research_readiness_check (
  id BIGSERIAL PRIMARY KEY,
  authorization_id UUID NOT NULL REFERENCES signal_model_research_authorization(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('WAITING','READY','UNAVAILABLE')),
  blockers JSONB NOT NULL CHECK (jsonb_typeof(blockers)='array'),
  next_action TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX signal_model_research_readiness_latest_idx
  ON signal_model_research_readiness_check(authorization_id,checked_at DESC,id DESC);
CREATE OR REPLACE FUNCTION reject_signal_model_readiness_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_SIGNAL_MODEL_READINESS_CHECK'; END $$;
CREATE TRIGGER signal_model_research_readiness_immutable
BEFORE UPDATE OR DELETE ON signal_model_research_readiness_check
FOR EACH ROW EXECUTE FUNCTION reject_signal_model_readiness_mutation();

INSERT INTO foundation_schema_version(version,description)
VALUES(142,'Typed signal-model plan, bounded readiness dispatch, and immutable inactive research reports')
ON CONFLICT(version) DO NOTHING;
