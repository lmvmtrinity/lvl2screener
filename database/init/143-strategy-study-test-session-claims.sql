-- Reserve holdout sessions once per frozen baseline scope. The uniqueness key
-- deliberately excludes study/candidate IDs so a revised challenger cannot
-- reopen the same TEST dates. Existing historical receipts are not backfilled.

CREATE TABLE strategy_study_test_session_reservation (
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  strategy_key TEXT NOT NULL,
  baseline_profile_id UUID NOT NULL REFERENCES scanner_profile(id) ON DELETE RESTRICT,
  baseline_profile_config_id UUID NOT NULL REFERENCES scanner_profile_config(id) ON DELETE RESTRICT,
  strategy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  execution_model_version TEXT NOT NULL,
  execution_assumptions JSONB NOT NULL CHECK (jsonb_typeof(execution_assumptions)='object'),
  session_date DATE NOT NULL,
  study_id UUID NOT NULL REFERENCES strategy_study(id) ON DELETE RESTRICT,
  study_spec_hash TEXT NOT NULL CHECK (study_spec_hash ~ '^[a-f0-9]{64}$'),
  challenger_profile_config_id UUID NOT NULL REFERENCES scanner_profile_config(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES research_job(id) ON DELETE RESTRICT,
  job_attempt_count INTEGER NOT NULL CHECK (job_attempt_count > 0),
  lease_owner TEXT NOT NULL,
  authority JSONB NOT NULL CHECK (jsonb_typeof(authority) IN ('object','null')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT strategy_study_test_session_scope_uq UNIQUE (
    market_id,source_digest,strategy_key,baseline_profile_id,
    baseline_profile_config_id,strategy_version,config_version,
    execution_model_version,execution_assumptions,session_date
  )
);

CREATE INDEX strategy_study_test_session_lineage_idx
  ON strategy_study_test_session_reservation(market_id,source_digest,session_date);

CREATE OR REPLACE FUNCTION reject_strategy_study_test_session_reservation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_STRATEGY_STUDY_TEST_SESSION_RESERVATION';
END $$;
CREATE TRIGGER strategy_study_test_session_reservation_immutable
BEFORE UPDATE OR DELETE ON strategy_study_test_session_reservation
FOR EACH ROW EXECUTE FUNCTION reject_strategy_study_test_session_reservation_mutation();

CREATE OR REPLACE FUNCTION guard_signal_model_test_session_overlap()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority signal_model_research_authorization%ROWTYPE;
DECLARE session_dates DATE[];
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR OLD.stage <> 'TEST' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO authority
    FROM signal_model_research_authorization
   WHERE id=NEW.authorization_id;
  IF authority.id IS NULL THEN
    RAISE EXCEPTION 'SIGNAL_MODEL_TEST_AUTHORITY_MISSING';
  END IF;

  -- Match migration142's scope lock so study claims and model release serialize.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(authority.market_id || ':' || authority.source_digest,0)
  );
  SELECT array_agg(session_date::date ORDER BY session_date)
    INTO session_dates
    FROM jsonb_array_elements_text(authority.plan->'sessions'->'TEST') AS dates(session_date);
  IF COALESCE(cardinality(session_dates),0)=0 THEN
    RAISE EXCEPTION 'SIGNAL_MODEL_TEST_SCOPE_UNPROVEN';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM strategy_study_test_session_reservation reservation
     WHERE reservation.market_id=authority.market_id
       AND reservation.source_digest=authority.source_digest
       AND reservation.session_date=ANY(session_dates)
  ) THEN
    RAISE EXCEPTION 'SIGNAL_MODEL_TEST_SESSION_ALREADY_RESERVED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_signal_model_test_session_overlap_guard
BEFORE UPDATE OF consumed_at ON signal_model_research_stage_claim
FOR EACH ROW EXECUTE FUNCTION guard_signal_model_test_session_overlap();

CREATE OR REPLACE FUNCTION validate_strategy_study_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected BOOLEAN;
  run_market TEXT;
  expected_market TEXT;
  run_input_hash TEXT;
  result_input_hash TEXT;
  study_spec JSONB;
  study_spec_hash TEXT;
  scope_digest TEXT;
  baseline JSONB;
  expected_assumptions JSONB;
  scope_row RECORD;
  test_date DATE;
  claim_job research_job%ROWTYPE;
BEGIN
  IF NEW.receipt_key = 'TEST_CLAIM' THEN
    SELECT (payload->>'selected')::boolean INTO selected
      FROM strategy_study_receipt
     WHERE study_id=NEW.study_id AND receipt_key='SELECTION';
    IF selected IS DISTINCT FROM TRUE
       OR NOT EXISTS (SELECT 1 FROM strategy_study_receipt WHERE study_id=NEW.study_id AND receipt_key='TRAIN_RESULT')
       OR NOT EXISTS (SELECT 1 FROM strategy_study_receipt WHERE study_id=NEW.study_id AND receipt_key='VALIDATION_RESULT') THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_TEST_PREREQUISITE_MISSING';
    END IF;

    SELECT market_id,spec,spec_hash
      INTO expected_market,study_spec,study_spec_hash
      FROM strategy_study WHERE id=NEW.study_id;
    IF study_spec IS NULL
       OR jsonb_typeof(study_spec->'sessionPlan'->'sessions'->'TEST') IS DISTINCT FROM 'array'
       OR COALESCE(jsonb_array_length(study_spec->'sessionPlan'->'sessions'->'TEST'),0)=0
       OR study_spec->'binding'->>'inputHash' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_TEST_SCOPE_UNPROVEN';
    END IF;

    scope_digest := study_spec->'binding'->>'inputHash';
    baseline := study_spec->'inputs'->'TEST'->'baseline';
    IF baseline IS NULL
       OR baseline->>'marketId' IS DISTINCT FROM expected_market
       OR baseline->>'dataSource' IS DISTINCT FROM 'CAPTURED_QUOTES'
       OR jsonb_typeof(baseline->'strategies') IS DISTINCT FROM 'array'
       OR jsonb_array_length(baseline->'strategies') <> 1
       OR baseline->>'startDate' IS NULL OR baseline->>'endDate' IS NULL THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_TEST_SCOPE_UNPROVEN';
    END IF;

    SELECT profile.id AS baseline_profile_id,
           config.id AS baseline_profile_config_id,
           config.config_version,
           definition.strategy_key,
           definition.version AS strategy_version
      INTO scope_row
      FROM scanner_profile_config config
      JOIN scanner_profile profile ON profile.id=config.profile_id
      JOIN strategy_definition definition ON definition.id=profile.strategy_definition_id
     WHERE config.id=(study_spec->>'baselineProfileConfigId')::uuid
       AND config.market_id=expected_market
       AND profile.market_id=expected_market
       AND definition.strategy_key=baseline->'strategies'->>0;
    IF scope_row.baseline_profile_id IS NULL THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_TEST_SCOPE_UNPROVEN';
    END IF;

    expected_assumptions := jsonb_build_object(
      'startingCapital',(baseline->>'startingCapital')::numeric,
      'positionSize',(baseline->>'positionSize')::numeric,
      'slippageBps',(baseline->>'slippageBps')::numeric,
      'feePerTrade',(baseline->>'feePerTrade')::numeric,
      'stopMethod','STRUCTURAL',
      'atrStopMultiple',1,
      'rewardRiskRatio',NULL,
      'maxQuoteAgeSeconds',30,
      'sessionTimezone',CASE WHEN expected_market='US_EQUITIES' THEN 'America/New_York' ELSE 'America/Toronto' END,
      'noonCloseTime','16:00',
      'executionMode','UNCONSTRAINED',
      'latencyMs',0,
      'fillAuthority','TYPESCRIPT_PAPER_EXECUTION_CORE'
    );

    SELECT * INTO claim_job FROM research_job
     WHERE id=(NEW.payload->>'jobId')::uuid FOR SHARE;
    IF claim_job.id IS NULL OR claim_job.job_type <> 'STRATEGY_STUDY'
       OR claim_job.status <> 'RUNNING'
       OR claim_job.lease_owner IS DISTINCT FROM NEW.payload->>'leaseOwner'
       OR claim_job.attempt_count IS DISTINCT FROM (NEW.payload->>'attemptCount')::integer
       OR claim_job.lease_expires_at IS NULL
       OR claim_job.lease_expires_at <= clock_timestamp()
       OR claim_job.cancellation_requested THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_TEST_AUTHORITY_INVALID';
    END IF;

    -- This is the same transaction/advisory key used by signal-model TEST
    -- consumption. It serializes cross-path overlap checks on source scope.
    PERFORM pg_advisory_xact_lock(
      hashtextextended(expected_market || ':' || scope_digest,0)
    );
    FOR test_date IN
      SELECT session_date::date
        FROM jsonb_array_elements_text(study_spec->'sessionPlan'->'sessions'->'TEST') AS dates(session_date)
       ORDER BY session_date
    LOOP
      IF EXISTS (
        SELECT 1
          FROM signal_model_research_test_consumption consumed
         WHERE consumed.market_id=expected_market
           AND consumed.source_digest=scope_digest
           AND consumed.test_sessions ? test_date::text
      ) THEN
        RAISE EXCEPTION 'STRATEGY_STUDY_TEST_SESSION_ALREADY_RESERVED';
      END IF;
      IF EXISTS (
        SELECT 1 FROM strategy_study_test_session_reservation prior
         WHERE prior.market_id=expected_market AND prior.source_digest=scope_digest
           AND prior.strategy_key=scope_row.strategy_key
           AND prior.baseline_profile_id=scope_row.baseline_profile_id
           AND prior.baseline_profile_config_id=scope_row.baseline_profile_config_id
           AND prior.strategy_version=scope_row.strategy_version
           AND prior.config_version=scope_row.config_version
           AND prior.execution_model_version='paper-execution-v7'
           AND prior.execution_assumptions=expected_assumptions
           AND prior.session_date=test_date
      ) THEN
        RAISE EXCEPTION 'STRATEGY_STUDY_TEST_SESSION_ALREADY_RESERVED';
      END IF;
      INSERT INTO strategy_study_test_session_reservation(
        market_id,source_digest,strategy_key,baseline_profile_id,
        baseline_profile_config_id,strategy_version,config_version,
        execution_model_version,execution_assumptions,session_date,
        study_id,study_spec_hash,challenger_profile_config_id,
        job_id,job_attempt_count,lease_owner,authority
      ) VALUES (
        expected_market,scope_digest,scope_row.strategy_key,scope_row.baseline_profile_id,
        scope_row.baseline_profile_config_id,scope_row.strategy_version,scope_row.config_version,
        'paper-execution-v7',expected_assumptions,test_date,
        NEW.study_id,study_spec_hash,
        (study_spec->>'challengerProfileConfigId')::uuid,
        claim_job.id,claim_job.attempt_count,claim_job.lease_owner,
        COALESCE(claim_job.request_payload->'authority','null'::jsonb)
      );
    END LOOP;
  ELSIF NEW.receipt_key IN ('TRAIN_RESULT','VALIDATION_RESULT','TEST_RESULT') THEN
    IF NOT EXISTS (
      SELECT 1 FROM strategy_study_receipt
       WHERE study_id=NEW.study_id
         AND receipt_key = CASE NEW.receipt_key
           WHEN 'TRAIN_RESULT' THEN 'TRAIN_CLAIM'
           WHEN 'VALIDATION_RESULT' THEN 'VALIDATION_CLAIM'
           ELSE 'TEST_CLAIM'
         END
    ) THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_CLAIM_REQUIRED';
    END IF;
    SELECT market_id INTO expected_market FROM strategy_study WHERE id=NEW.study_id;
    SELECT market_id,research_evidence->>'inputHash'
      INTO run_market,run_input_hash
      FROM backtest_run
     WHERE id=(NEW.payload->>'baselineRunId')::uuid;
    result_input_hash := NEW.payload->'binding'->>'inputHash';
    IF run_market IS NULL OR run_market <> expected_market OR run_input_hash IS DISTINCT FROM result_input_hash THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_BASELINE_RUN_IDENTITY_MISMATCH';
    END IF;
    SELECT market_id,research_evidence->>'inputHash'
      INTO run_market,run_input_hash
      FROM backtest_run
     WHERE id=(NEW.payload->>'challengerRunId')::uuid;
    IF run_market IS NULL OR run_market <> expected_market OR run_input_hash IS DISTINCT FROM result_input_hash THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_CHALLENGER_RUN_IDENTITY_MISMATCH';
    END IF;
  ELSIF NEW.receipt_key = 'REPORT' THEN
    IF (NEW.payload->>'status') = 'NOT_SELECTED' THEN
      SELECT (payload->>'selected')::boolean INTO selected
        FROM strategy_study_receipt
       WHERE study_id=NEW.study_id AND receipt_key='SELECTION';
      IF selected IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'STRATEGY_STUDY_REPORT_PREREQUISITE_MISSING';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM strategy_study_receipt WHERE study_id=NEW.study_id AND receipt_key='TEST_RESULT')
       AND NOT EXISTS (SELECT 1 FROM strategy_study_receipt WHERE study_id=NEW.study_id AND receipt_key='COVERAGE_REFUSAL')
       AND NOT ((NEW.payload->>'status') = 'INTERRUPTED'
         AND EXISTS (SELECT 1 FROM strategy_study_receipt WHERE study_id=NEW.study_id AND receipt_key='TEST_CLAIM')) THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_REPORT_PREREQUISITE_MISSING';
    END IF;
  END IF;
  RETURN NEW;
END $$;

INSERT INTO foundation_schema_version(version,description)
VALUES(143,'One-use cross-path strategy TEST session reservations')
ON CONFLICT(version) DO NOTHING;
