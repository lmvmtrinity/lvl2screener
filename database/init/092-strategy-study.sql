-- WP03: immutable frozen study specifications, stage claims/results and
-- evidence-bound canonical run diagnostics.

ALTER TABLE research_job DROP CONSTRAINT IF EXISTS research_job_job_type_check;
ALTER TABLE research_job ADD CONSTRAINT research_job_job_type_check
  CHECK (job_type IN (
    'BACKTEST', 'CALIBRATION', 'RANKING_RESEARCH', 'STATISTICAL_TRAINING',
    'COVERAGE_VERIFICATION', 'STRATEGY_STUDY'
  ));

ALTER TABLE backtest_trade
  ADD COLUMN IF NOT EXISTS sampled_excursion JSONB;

CREATE TABLE IF NOT EXISTS strategy_study (
  id UUID PRIMARY KEY,
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  spec_hash TEXT NOT NULL CHECK (spec_hash ~ '^[a-f0-9]{64}$'),
  spec JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS strategy_study_receipt (
  study_id UUID NOT NULL REFERENCES strategy_study(id),
  receipt_key TEXT NOT NULL CHECK (receipt_key IN (
    'TRAIN_CLAIM','TRAIN_RESULT',
    'VALIDATION_CLAIM','VALIDATION_RESULT',
    'SELECTION',
    'TEST_CLAIM','TEST_RESULT',
    'REPORT','COVERAGE_REFUSAL'
  )),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (study_id, receipt_key)
);

CREATE INDEX IF NOT EXISTS strategy_study_market_created_idx
  ON strategy_study(market_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_strategy_study_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_STRATEGY_STUDY_EVIDENCE';
END $$;

DROP TRIGGER IF EXISTS immutable_strategy_study ON strategy_study;
CREATE TRIGGER immutable_strategy_study
BEFORE UPDATE OR DELETE ON strategy_study
FOR EACH ROW EXECUTE FUNCTION reject_strategy_study_mutation();

DROP TRIGGER IF EXISTS immutable_strategy_study_receipt ON strategy_study_receipt;
CREATE TRIGGER immutable_strategy_study_receipt
BEFORE UPDATE OR DELETE ON strategy_study_receipt
FOR EACH ROW EXECUTE FUNCTION reject_strategy_study_mutation();

CREATE OR REPLACE FUNCTION validate_strategy_study_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected BOOLEAN;
  run_market TEXT;
  expected_market TEXT;
  run_input_hash TEXT;
  result_input_hash TEXT;
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
    IF NOT EXISTS (SELECT 1 FROM strategy_study_receipt WHERE study_id=NEW.study_id AND receipt_key='TEST_RESULT')
       AND NOT EXISTS (SELECT 1 FROM strategy_study_receipt WHERE study_id=NEW.study_id AND receipt_key='COVERAGE_REFUSAL')
       AND NOT ((NEW.payload->>'status') = 'INTERRUPTED'
         AND EXISTS (SELECT 1 FROM strategy_study_receipt WHERE study_id=NEW.study_id AND receipt_key='TEST_CLAIM')) THEN
      RAISE EXCEPTION 'STRATEGY_STUDY_REPORT_PREREQUISITE_MISSING';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS validate_strategy_study_receipt_insert ON strategy_study_receipt;
CREATE TRIGGER validate_strategy_study_receipt_insert
BEFORE INSERT ON strategy_study_receipt
FOR EACH ROW EXECUTE FUNCTION validate_strategy_study_receipt();

INSERT INTO foundation_schema_version(version, description)
VALUES (92, 'WP03 immutable strategy study specifications and stage receipts')
ON CONFLICT (version) DO NOTHING;
