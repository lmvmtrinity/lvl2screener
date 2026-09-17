-- WP03 correction: a frozen study that fails development selection has a durable
-- NOT_SELECTED report after SELECTION, without claiming TEST.

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

INSERT INTO foundation_schema_version(version, description)
VALUES (94, 'WP03 NOT_SELECTED study report prerequisite correction')
ON CONFLICT (version) DO NOTHING;
