-- Prospective canonical decision and outcome rows for lineage-verified replays.
-- Rows are written only alongside successful completion; no legacy run is backfilled.
CREATE TABLE backtest_opportunity_capture (
  source_run_id UUID NOT NULL REFERENCES backtest_run(id),
  capture_ordinal INTEGER NOT NULL CHECK (capture_ordinal >= 0),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  profile_id UUID NOT NULL,
  profile_name TEXT NOT NULL,
  execution_model_version TEXT NOT NULL,
  execution_assumptions_hash TEXT NOT NULL CHECK (execution_assumptions_hash ~ '^[a-f0-9]{64}$'),
  replay_id UUID NOT NULL,
  evidence_id UUID NOT NULL,
  opportunity_id TEXT NOT NULL,
  session_date DATE NOT NULL,
  decision_timestamp TIMESTAMPTZ NOT NULL,
  symbol TEXT NOT NULL,
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  baseline_selected BOOLEAN NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  prediction_features JSONB NOT NULL CHECK (jsonb_typeof(prediction_features)='object'),
  outcome JSONB NOT NULL CHECK (jsonb_typeof(outcome)='object'),
  capture_hash TEXT NOT NULL CHECK (capture_hash ~ '^[a-f0-9]{64}$'),
  label_available_at TIMESTAMPTZ,
  PRIMARY KEY (source_run_id, strategy_name, opportunity_id),
  UNIQUE (source_run_id, evidence_id),
  UNIQUE (source_run_id, capture_ordinal),
  CHECK (outcome->>'status' IN ('CLOSED','NO_FILL','INVALID')),
  CHECK (label_available_at IS NULL OR decision_timestamp <= label_available_at)
);

CREATE INDEX backtest_opportunity_capture_scope_idx
  ON backtest_opportunity_capture(market_id, strategy_name, profile_id, session_date, decision_timestamp);

CREATE TABLE backtest_opportunity_capture_receipt (
  source_run_id UUID PRIMARY KEY REFERENCES backtest_run(id),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  expected_count INTEGER NOT NULL CHECK (expected_count >= 0),
  membership_hash TEXT NOT NULL CHECK (membership_hash ~ '^[a-f0-9]{64}$'),
  execution_model_version TEXT NOT NULL,
  execution_assumptions_hash TEXT NOT NULL CHECK (execution_assumptions_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION reject_backtest_opportunity_capture_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_BACKTEST_OPPORTUNITY_CAPTURE_RECEIPT'; END $$;
CREATE TRIGGER backtest_opportunity_capture_receipt_immutable
  BEFORE UPDATE OR DELETE ON backtest_opportunity_capture_receipt
  FOR EACH ROW EXECUTE FUNCTION reject_backtest_opportunity_capture_receipt_mutation();

CREATE OR REPLACE FUNCTION validate_backtest_opportunity_capture_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM backtest_run source
    JOIN research_evidence_binding b ON b.owner_kind='BACKTEST' AND b.owner_id=source.id
    JOIN research_coverage_report r
      ON r.hash=b.coverage_report_hash AND r.market_id=b.market_id AND r.status='VERIFIED'
    WHERE source.id=NEW.source_run_id AND source.status='COMPLETED'
      AND source.market_id=NEW.market_id AND b.market_id=NEW.market_id
      AND b.input_hash=source.research_evidence->>'inputHash'
      AND source.execution_model_version=NEW.execution_model_version
  ) THEN RAISE EXCEPTION 'BACKTEST_OPPORTUNITY_CAPTURE_RECEIPT_LINEAGE_UNVERIFIED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER backtest_opportunity_capture_receipt_validate
  BEFORE INSERT ON backtest_opportunity_capture_receipt
  FOR EACH ROW EXECUTE FUNCTION validate_backtest_opportunity_capture_receipt();

CREATE OR REPLACE FUNCTION reject_backtest_opportunity_capture_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_BACKTEST_OPPORTUNITY_CAPTURE'; END $$;
CREATE TRIGGER backtest_opportunity_capture_immutable
  BEFORE UPDATE OR DELETE ON backtest_opportunity_capture
  FOR EACH ROW EXECUTE FUNCTION reject_backtest_opportunity_capture_mutation();

CREATE OR REPLACE FUNCTION validate_backtest_opportunity_capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE run_row RECORD;
BEGIN
  SELECT status,market_id,strategy_version,config_version,execution_model_version
    INTO run_row FROM backtest_run WHERE id=NEW.source_run_id;
  IF run_row.status <> 'COMPLETED'
     OR run_row.market_id <> NEW.market_id
     OR run_row.strategy_version <> NEW.strategy_version
     OR run_row.config_version <> NEW.config_version
     OR run_row.execution_model_version <> NEW.execution_model_version
  THEN RAISE EXCEPTION 'BACKTEST_OPPORTUNITY_CAPTURE_RUN_IDENTITY_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM instrument i WHERE i.id=NEW.instrument_id AND i.market_id=NEW.market_id)
  THEN RAISE EXCEPTION 'BACKTEST_OPPORTUNITY_CAPTURE_INSTRUMENT_MARKET_MISMATCH'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM backtest_opportunity_capture_receipt receipt
    WHERE receipt.source_run_id=NEW.source_run_id
      AND receipt.market_id=NEW.market_id
      AND receipt.execution_model_version=NEW.execution_model_version
      AND receipt.execution_assumptions_hash=NEW.execution_assumptions_hash
  ) THEN RAISE EXCEPTION 'BACKTEST_OPPORTUNITY_CAPTURE_RECEIPT_MISSING'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM research_evidence_binding b
    JOIN research_coverage_report r
      ON r.hash=b.coverage_report_hash AND r.market_id=b.market_id AND r.status='VERIFIED'
    JOIN backtest_run source ON source.id=b.owner_id
    WHERE b.owner_kind='BACKTEST' AND b.owner_id=NEW.source_run_id
      AND b.market_id=NEW.market_id
      AND b.input_hash=source.research_evidence->>'inputHash'
  ) THEN RAISE EXCEPTION 'BACKTEST_OPPORTUNITY_CAPTURE_LINEAGE_UNVERIFIED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER backtest_opportunity_capture_validate
  BEFORE INSERT ON backtest_opportunity_capture
  FOR EACH ROW EXECUTE FUNCTION validate_backtest_opportunity_capture();

INSERT INTO foundation_schema_version(version,description)
VALUES(141,'Prospective immutable backtest opportunity capture')
ON CONFLICT(version) DO NOTHING;
