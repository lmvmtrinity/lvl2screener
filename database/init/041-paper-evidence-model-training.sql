-- Immutable forward-paper evidence snapshots for supplemental statistical-model
-- research. These artifacts are deliberately separate from statistical_model:
-- creating a snapshot cannot train, activate, or otherwise affect a model.

CREATE TABLE IF NOT EXISTS statistical_training_dataset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('PAPER_EVIDENCE')),
  policy_version TEXT NOT NULL,
  cohort JSONB NOT NULL,
  requested_cutoff TIMESTAMPTZ NOT NULL,
  effective_cutoff TIMESTAMPTZ NOT NULL,
  source_digest TEXT NOT NULL UNIQUE,
  source_row_count INTEGER NOT NULL CHECK (source_row_count >= 0),
  excluded_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(cohort) = 'object'),
  CHECK (jsonb_typeof(excluded_counts) = 'object'),
  CHECK (effective_cutoff <= requested_cutoff)
);

CREATE TABLE IF NOT EXISTS statistical_training_dataset_member (
  dataset_id UUID NOT NULL REFERENCES statistical_training_dataset(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_key TEXT NOT NULL,
  signal_timestamp TIMESTAMPTZ NOT NULL,
  normalized_row JSONB NOT NULL,
  PRIMARY KEY(dataset_id, ordinal),
  UNIQUE(dataset_id, source_key),
  CHECK (jsonb_typeof(normalized_row) = 'object')
);

CREATE INDEX IF NOT EXISTS statistical_training_dataset_cohort_idx
  ON statistical_training_dataset ((cohort->>'strategy'), effective_cutoff DESC);
CREATE INDEX IF NOT EXISTS statistical_training_dataset_member_time_idx
  ON statistical_training_dataset_member(dataset_id, signal_timestamp, ordinal);

CREATE OR REPLACE FUNCTION statistical_training_dataset_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'statistical training datasets are immutable; create a new snapshot instead of updating id=%', OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS statistical_training_dataset_immutable ON statistical_training_dataset;
CREATE TRIGGER statistical_training_dataset_immutable
BEFORE UPDATE OR DELETE ON statistical_training_dataset
FOR EACH ROW EXECUTE FUNCTION statistical_training_dataset_reject_update();

CREATE OR REPLACE FUNCTION statistical_training_dataset_member_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'statistical training dataset members are immutable; create a new snapshot instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS statistical_training_dataset_member_immutable ON statistical_training_dataset_member;
CREATE TRIGGER statistical_training_dataset_member_immutable
BEFORE UPDATE OR DELETE ON statistical_training_dataset_member
FOR EACH ROW EXECUTE FUNCTION statistical_training_dataset_member_reject_update();

COMMENT ON TABLE statistical_training_dataset IS
  'Immutable paper-evidence membership snapshots for supplemental research only; never an execution instruction.';

INSERT INTO foundation_schema_version(version, description)
VALUES(41, 'Immutable paper-evidence statistical-training datasets')
ON CONFLICT(version) DO NOTHING;
