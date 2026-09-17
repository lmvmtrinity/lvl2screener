-- WP02 I02: durable, content-addressed automation work and append-only receipts.
-- A work row owns one dispatch link; receipts preserve attempts and no-op evidence.
CREATE TABLE IF NOT EXISTS research_evidence_work (
  work_key TEXT PRIMARY KEY CHECK (work_key ~ '^[a-f0-9]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('COVERAGE','STUDY','DIAGNOSTICS')),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  input_identity_hash TEXT NOT NULL CHECK (input_identity_hash ~ '^[a-f0-9]{64}$'),
  processor_version TEXT NOT NULL,
  job_id UUID UNIQUE REFERENCES research_job(id),
  identity JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS research_evidence_work_receipt (
  work_key TEXT NOT NULL REFERENCES research_evidence_work(work_key),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[a-f0-9]{64}$'),
  receipt JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (work_key, receipt_hash)
);

CREATE INDEX IF NOT EXISTS research_evidence_work_market_idx
  ON research_evidence_work(market_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS research_evidence_work_receipt_time_idx
  ON research_evidence_work_receipt(work_key, recorded_at DESC);

ALTER TABLE research_job DROP CONSTRAINT IF EXISTS research_job_job_type_check;
ALTER TABLE research_job ADD CONSTRAINT research_job_job_type_check
  CHECK (job_type IN ('BACKTEST', 'CALIBRATION', 'RANKING_RESEARCH', 'STATISTICAL_TRAINING', 'COVERAGE_VERIFICATION'));

INSERT INTO foundation_schema_version (version, description)
VALUES (90, 'WP02 evidence automation work receipts')
ON CONFLICT (version) DO NOTHING;
