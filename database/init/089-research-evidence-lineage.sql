-- WP02: immutable manifests, content-addressed retained-input coverage reports and
-- owner-scoped evidence bindings. Legacy rows remain readable without a binding.

CREATE TABLE IF NOT EXISTS research_manifest (
  hash TEXT PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  manifest JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (hash, market_id)
);

ALTER TABLE research_job
  ADD COLUMN IF NOT EXISTS research_evidence JSONB;
ALTER TABLE backtest_run
  ADD COLUMN IF NOT EXISTS research_evidence JSONB;
ALTER TABLE calibration_run
  ADD COLUMN IF NOT EXISTS research_evidence JSONB;
ALTER TABLE statistical_training_dataset
  ADD COLUMN IF NOT EXISTS research_evidence JSONB;
ALTER TABLE statistical_model
  ADD COLUMN IF NOT EXISTS research_evidence JSONB;

CREATE TABLE IF NOT EXISTS research_coverage_report (
  hash TEXT PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','INCOMPLETE','UNKNOWN')),
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (hash, market_id, input_hash)
);

CREATE TABLE IF NOT EXISTS research_evidence_binding (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('JOB','BACKTEST','CALIBRATION','DATASET','MODEL')),
  owner_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  coverage_report_hash TEXT NOT NULL CHECK (coverage_report_hash ~ '^[a-f0-9]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  binding JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_kind, owner_id),
  FOREIGN KEY (manifest_hash, market_id)
    REFERENCES research_manifest(hash, market_id),
  FOREIGN KEY (coverage_report_hash, market_id, input_hash)
    REFERENCES research_coverage_report(hash, market_id, input_hash)
);

CREATE INDEX IF NOT EXISTS research_coverage_report_market_created_idx
  ON research_coverage_report(market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_evidence_binding_report_idx
  ON research_evidence_binding(coverage_report_hash, market_id);

CREATE OR REPLACE FUNCTION reject_research_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RESEARCH_EVIDENCE';
END $$;

DROP TRIGGER IF EXISTS immutable_research_manifest ON research_manifest;
CREATE TRIGGER immutable_research_manifest
BEFORE UPDATE OR DELETE ON research_manifest
FOR EACH ROW EXECUTE FUNCTION reject_research_evidence_mutation();

DROP TRIGGER IF EXISTS immutable_research_coverage ON research_coverage_report;
CREATE TRIGGER immutable_research_coverage
BEFORE UPDATE OR DELETE ON research_coverage_report
FOR EACH ROW EXECUTE FUNCTION reject_research_evidence_mutation();

DROP TRIGGER IF EXISTS immutable_research_binding ON research_evidence_binding;
CREATE TRIGGER immutable_research_binding
BEFORE UPDATE OR DELETE ON research_evidence_binding
FOR EACH ROW EXECUTE FUNCTION reject_research_evidence_mutation();

CREATE OR REPLACE FUNCTION validate_research_evidence_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  report_market TEXT;
  report_input TEXT;
  report_status TEXT;
  report_manifest TEXT;
  report_verified_at TEXT;
  manifest_market TEXT;
BEGIN
  SELECT market_id,input_hash,status,report->>'manifestHash',report->>'verifiedAt'
    INTO report_market,report_input,report_status,report_manifest,report_verified_at
    FROM research_coverage_report
   WHERE hash=NEW.coverage_report_hash;
  IF report_market IS NULL THEN
    RAISE EXCEPTION 'EVIDENCE_REPORT_NOT_FOUND';
  END IF;
  IF report_status <> 'VERIFIED' THEN
    RAISE EXCEPTION 'EVIDENCE_REPORT_NOT_VERIFIED';
  END IF;
  IF NEW.market_id <> report_market OR NEW.input_hash <> report_input THEN
    RAISE EXCEPTION 'EVIDENCE_MARKET_OR_INPUT_MISMATCH';
  END IF;
  IF NEW.manifest_hash <> report_manifest
     OR NEW.binding->>'manifestHash' IS DISTINCT FROM NEW.manifest_hash
     OR NEW.binding->>'coverageReportHash' IS DISTINCT FROM NEW.coverage_report_hash
     OR NEW.binding->>'inputHash' IS DISTINCT FROM NEW.input_hash THEN
    RAISE EXCEPTION 'EVIDENCE_BINDING_IDENTITY_MISMATCH';
  END IF;
  SELECT market_id INTO manifest_market FROM research_manifest WHERE hash=NEW.manifest_hash;
  IF manifest_market IS NULL OR manifest_market <> NEW.market_id THEN
    RAISE EXCEPTION 'EVIDENCE_MANIFEST_MARKET_MISMATCH';
  END IF;
  IF NEW.binding->>'verifiedAt' IS NULL OR NEW.binding->>'verifiedAt' <> report_verified_at THEN
    RAISE EXCEPTION 'EVIDENCE_VERIFICATION_TIME_MISSING';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS validate_research_evidence_binding_insert ON research_evidence_binding;
CREATE TRIGGER validate_research_evidence_binding_insert
BEFORE INSERT ON research_evidence_binding
FOR EACH ROW EXECUTE FUNCTION validate_research_evidence_binding();

INSERT INTO foundation_schema_version(version, description)
VALUES (89, 'Immutable research coverage reports and evidence lineage bindings')
ON CONFLICT (version) DO NOTHING;
