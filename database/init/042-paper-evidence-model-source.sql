-- A statistical model is sourced from exactly one immutable evidence artifact:
-- either the existing completed backtest or a frozen paper-evidence dataset.
ALTER TABLE statistical_model ALTER COLUMN backtest_run_id DROP NOT NULL;
ALTER TABLE statistical_model
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'BACKTEST_RUN'
    CHECK (source_kind IN ('BACKTEST_RUN','PAPER_EVIDENCE')),
  ADD COLUMN IF NOT EXISTS training_dataset_id UUID
    REFERENCES statistical_training_dataset(id) ON DELETE RESTRICT;

ALTER TABLE statistical_model DROP CONSTRAINT IF EXISTS statistical_model_source_check;
ALTER TABLE statistical_model ADD CONSTRAINT statistical_model_source_check CHECK (
  (source_kind='BACKTEST_RUN' AND backtest_run_id IS NOT NULL AND training_dataset_id IS NULL)
  OR
  (source_kind='PAPER_EVIDENCE' AND backtest_run_id IS NULL AND training_dataset_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS statistical_model_training_dataset_idx
  ON statistical_model(training_dataset_id);

-- Replace the legacy backtest-only authority guard. Both evidence sources must
-- carry the authoritative execution semantics, but only activation changes
-- model use; no trigger can make a model active automatically.
CREATE OR REPLACE FUNCTION require_authoritative_statistical_evidence() RETURNS trigger AS $$
DECLARE source_version TEXT;
BEGIN
  IF NEW.source_kind='PAPER_EVIDENCE' THEN
    SELECT cohort->>'executionModelVersion' INTO source_version
      FROM statistical_training_dataset WHERE id=NEW.training_dataset_id;
  ELSE
    SELECT execution_model_version INTO source_version
      FROM backtest_run WHERE id=NEW.backtest_run_id;
  END IF;
  IF source_version IS DISTINCT FROM 'paper-execution-v1' THEN
    RAISE EXCEPTION 'statistical model evidence must use paper-execution-v1';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS statistical_model_authoritative_evidence ON statistical_model;
CREATE TRIGGER statistical_model_authoritative_evidence
BEFORE INSERT OR UPDATE OF source_kind,backtest_run_id,training_dataset_id,active ON statistical_model
FOR EACH ROW EXECUTE FUNCTION require_authoritative_statistical_evidence();

INSERT INTO foundation_schema_version(version, description)
VALUES(42, 'Statistical models may use immutable paper-evidence datasets')
ON CONFLICT(version) DO NOTHING;
