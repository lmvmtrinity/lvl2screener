-- Phase 4/4a provenance groundwork. Historical rows deliberately remain NULL:
-- their exact execution implementation and assumptions cannot be reconstructed
-- safely after the fact. New rows are labelled by their writer.
ALTER TABLE backtest_run
  ADD COLUMN IF NOT EXISTS execution_model_version TEXT,
  ADD COLUMN IF NOT EXISTS execution_assumptions JSONB,
  ADD COLUMN IF NOT EXISTS supersedes_backtest_run_id UUID REFERENCES backtest_run(id);

ALTER TABLE backtest_run DROP CONSTRAINT IF EXISTS backtest_run_execution_provenance_check;
ALTER TABLE backtest_run ADD CONSTRAINT backtest_run_execution_provenance_check CHECK (
  (execution_model_version IS NULL AND execution_assumptions IS NULL)
  OR
  (execution_model_version IS NOT NULL AND jsonb_typeof(execution_assumptions) = 'object')
);
CREATE INDEX IF NOT EXISTS backtest_run_execution_model_idx
  ON backtest_run(execution_model_version, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS backtest_run_supersedes_uq
  ON backtest_run(supersedes_backtest_run_id)
  WHERE supersedes_backtest_run_id IS NOT NULL;

ALTER TABLE calibration_run
  ADD COLUMN IF NOT EXISTS execution_model_version TEXT,
  ADD COLUMN IF NOT EXISTS execution_assumptions JSONB;
ALTER TABLE calibration_run DROP CONSTRAINT IF EXISTS calibration_run_execution_provenance_check;
ALTER TABLE calibration_run ADD CONSTRAINT calibration_run_execution_provenance_check CHECK (
  (execution_model_version IS NULL AND execution_assumptions IS NULL)
  OR
  (execution_model_version IS NOT NULL AND jsonb_typeof(execution_assumptions) = 'object')
);

-- These links make selective Phase 4a migration discoverable instead of
-- guessing from matching parameter JSON or activation timestamps.
ALTER TABLE scanner_profile_config
  ADD COLUMN IF NOT EXISTS source_calibration_run_id UUID REFERENCES calibration_run(id);
ALTER TABLE ranking_formula
  ADD COLUMN IF NOT EXISTS activation_research_run_id UUID REFERENCES ranking_research_run(id);

CREATE OR REPLACE FUNCTION reject_execution_provenance_update() RETURNS trigger AS $$
BEGIN
  IF OLD.execution_model_version IS DISTINCT FROM NEW.execution_model_version
     OR OLD.execution_assumptions IS DISTINCT FROM NEW.execution_assumptions THEN
    RAISE EXCEPTION 'execution provenance is immutable for %.id=%', TG_TABLE_NAME, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS backtest_run_execution_provenance_immutable ON backtest_run;
CREATE TRIGGER backtest_run_execution_provenance_immutable
BEFORE UPDATE ON backtest_run
FOR EACH ROW EXECUTE FUNCTION reject_execution_provenance_update();

DROP TRIGGER IF EXISTS calibration_run_execution_provenance_immutable ON calibration_run;
CREATE TRIGGER calibration_run_execution_provenance_immutable
BEFORE UPDATE ON calibration_run
FOR EACH ROW EXECUTE FUNCTION reject_execution_provenance_update();

INSERT INTO foundation_schema_version(version, description)
VALUES(31, 'Phase 4 execution provenance and replacement lineage')
ON CONFLICT(version) DO NOTHING;
