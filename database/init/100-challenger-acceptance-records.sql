-- Remediation C01/C02: immutable model scope and human-declared acceptance
-- records. These records do not activate models or authorize trading.
CREATE TABLE IF NOT EXISTS challenger_model_scope (
  model_id UUID PRIMARY KEY REFERENCES statistical_model(id) ON DELETE RESTRICT,
  scope_hash TEXT NOT NULL UNIQUE CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  scope JSONB NOT NULL CHECK (jsonb_typeof(scope)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS challenger_baseline_record (
  identity_hash TEXT PRIMARY KEY CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  record JSONB NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS challenger_acceptance_plan (
  identity_hash TEXT PRIMARY KEY CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  record JSONB NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS challenger_condition_definition (
  identity_hash TEXT PRIMARY KEY CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  record JSONB NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION reject_challenger_acceptance_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CHALLENGER_ACCEPTANCE_RECORD'; END;
$$;
DROP TRIGGER IF EXISTS challenger_model_scope_immutable ON challenger_model_scope;
CREATE TRIGGER challenger_model_scope_immutable BEFORE UPDATE OR DELETE ON challenger_model_scope
FOR EACH ROW EXECUTE FUNCTION reject_challenger_acceptance_mutation();
DROP TRIGGER IF EXISTS challenger_baseline_immutable ON challenger_baseline_record;
CREATE TRIGGER challenger_baseline_immutable BEFORE UPDATE OR DELETE ON challenger_baseline_record
FOR EACH ROW EXECUTE FUNCTION reject_challenger_acceptance_mutation();
DROP TRIGGER IF EXISTS challenger_plan_immutable ON challenger_acceptance_plan;
CREATE TRIGGER challenger_plan_immutable BEFORE UPDATE OR DELETE ON challenger_acceptance_plan
FOR EACH ROW EXECUTE FUNCTION reject_challenger_acceptance_mutation();
DROP TRIGGER IF EXISTS challenger_condition_immutable ON challenger_condition_definition;
CREATE TRIGGER challenger_condition_immutable BEFORE UPDATE OR DELETE ON challenger_condition_definition
FOR EACH ROW EXECUTE FUNCTION reject_challenger_acceptance_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES (100, 'Immutable challenger model scope and acceptance records')
ON CONFLICT(version) DO NOTHING;
