-- Observational facts only: a snapshot records what an already-active
-- supplemental model predicted when a paper observation was captured. It is
-- never an execution instruction and cannot be rewritten after an outcome.
CREATE TABLE IF NOT EXISTS paper_model_prediction_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES paper_signal_observation(id) ON DELETE CASCADE,
  model_id UUID NOT NULL,
  model_version TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  input_snapshot JSONB NOT NULL,
  prediction JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(observation_id, model_id, model_version),
  CHECK (jsonb_typeof(input_snapshot) = 'object'),
  CHECK (jsonb_typeof(prediction) = 'object')
);
CREATE INDEX IF NOT EXISTS paper_model_prediction_snapshot_model_idx
  ON paper_model_prediction_snapshot(model_id, model_version, created_at);

CREATE OR REPLACE FUNCTION paper_model_prediction_snapshot_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'paper model prediction snapshots are immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS paper_model_prediction_snapshot_immutable ON paper_model_prediction_snapshot;
CREATE TRIGGER paper_model_prediction_snapshot_immutable
BEFORE UPDATE OR DELETE ON paper_model_prediction_snapshot
FOR EACH ROW EXECUTE FUNCTION paper_model_prediction_snapshot_reject_update();

COMMENT ON TABLE paper_model_prediction_snapshot IS
  'Observational model prediction facts; never used for paper execution, sizing, or signal state.';

INSERT INTO foundation_schema_version(version, description)
VALUES(43, 'Immutable paper-observation statistical-model prediction snapshots')
ON CONFLICT(version) DO NOTHING;
