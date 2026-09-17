-- Remediation C04: append-only first-availability evidence for closed QUOTE
-- labels. Legacy closed executions remain unavailable until observed here.
CREATE TABLE IF NOT EXISTS challenger_label_evidence (
  execution_id UUID PRIMARY KEY REFERENCES paper_execution(id) ON DELETE RESTRICT,
  observation_id UUID NOT NULL REFERENCES paper_signal_observation(id) ON DELETE RESTRICT,
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  model TEXT NOT NULL CHECK (model='QUOTE'),
  exit_at TIMESTAMPTZ NOT NULL,
  label_available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  source_revision TEXT NOT NULL,
  label JSONB NOT NULL CHECK (jsonb_typeof(label)='object'),
  UNIQUE(execution_id,source_revision)
);
CREATE OR REPLACE FUNCTION reject_challenger_label_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CHALLENGER_LABEL_EVIDENCE'; END;
$$;
DROP TRIGGER IF EXISTS challenger_label_evidence_immutable ON challenger_label_evidence;
CREATE TRIGGER challenger_label_evidence_immutable BEFORE UPDATE OR DELETE ON challenger_label_evidence
FOR EACH ROW EXECUTE FUNCTION reject_challenger_label_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES (101, 'Causal challenger label availability evidence')
ON CONFLICT(version) DO NOTHING;
