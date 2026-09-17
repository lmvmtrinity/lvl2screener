-- WP05/I06: immutable derived execution diagnostics and their durable worker type.
-- This migration adds no economic capture path and never rewrites funded facts,
-- orders, liquidity or ledger history.

ALTER TABLE research_job DROP CONSTRAINT IF EXISTS research_job_job_type_check;
ALTER TABLE research_job ADD CONSTRAINT research_job_job_type_check
  CHECK (job_type IN (
    'BACKTEST', 'CALIBRATION', 'RANKING_RESEARCH', 'STATISTICAL_TRAINING',
    'COVERAGE_VERIFICATION', 'STRATEGY_STUDY', 'EXECUTION_DIAGNOSTICS'
  ));

CREATE TABLE IF NOT EXISTS execution_diagnostic_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES paper_bot_run(id),
  account_id UUID NOT NULL REFERENCES paper_funded_account(id),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK (currency IN ('CAD','USD')),
  temporal_scope TEXT NOT NULL CHECK (temporal_scope IN ('RUN_END','AS_OF','CURRENT_ACCOUNT')),
  as_of TIMESTAMPTZ NOT NULL,
  report_version TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  identity_hash TEXT NOT NULL UNIQUE CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(report) = 'object')
);

CREATE INDEX IF NOT EXISTS execution_diagnostic_report_run_idx
  ON execution_diagnostic_report(run_id, temporal_scope, as_of DESC);
CREATE INDEX IF NOT EXISTS execution_diagnostic_report_market_idx
  ON execution_diagnostic_report(market_id, created_at DESC);

CREATE OR REPLACE FUNCTION protect_execution_diagnostic_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_EXECUTION_DIAGNOSTIC_REPORT';
END;
$$;

DROP TRIGGER IF EXISTS protect_execution_diagnostic_report_update
  ON execution_diagnostic_report;
CREATE TRIGGER protect_execution_diagnostic_report_update
BEFORE UPDATE OR DELETE ON execution_diagnostic_report
FOR EACH ROW EXECUTE FUNCTION protect_execution_diagnostic_report();

INSERT INTO foundation_schema_version(version, description)
VALUES (96, 'WP05 immutable execution diagnostic reports and worker type')
ON CONFLICT(version) DO NOTHING;
