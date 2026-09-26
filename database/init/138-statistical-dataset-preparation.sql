-- Immutable prospective inputs for asynchronous dataset coverage.
-- The preparation freezes the exact materialization input before a coverage
-- request is dispatched. It is never an authority source by itself: the
-- scheduler revalidates ownership and the canonical dataset path still owns
-- qualification and model eligibility.
CREATE TABLE IF NOT EXISTS statistical_training_dataset_preparation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  cohort JSONB NOT NULL CHECK (jsonb_typeof(cohort)='object'),
  requested_cutoff TIMESTAMPTZ NOT NULL,
  effective_cutoff TIMESTAMPTZ NOT NULL,
  source_digest TEXT NOT NULL UNIQUE CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  excluded_counts JSONB NOT NULL CHECK (jsonb_typeof(excluded_counts)='object'),
  research_qualification JSONB NOT NULL CHECK (jsonb_typeof(research_qualification)='object'),
  qualified_rows JSONB NOT NULL CHECK (jsonb_typeof(qualified_rows)='array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (effective_cutoff <= requested_cutoff),
  CHECK ((cohort ? 'marketId') IS TRUE
         AND (cohort->>'marketId'=market_id) IS TRUE)
);

CREATE INDEX IF NOT EXISTS statistical_training_dataset_preparation_owner_idx
  ON statistical_training_dataset_preparation(
    market_id,
    (cohort->>'strategy'),
    (cohort->>'strategyVersion'),
    (cohort->>'profileConfigId'),
    (cohort->>'configVersion'),
    (cohort->>'executionModelVersion'),
    created_at DESC
  );

CREATE OR REPLACE FUNCTION statistical_training_dataset_preparation_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'statistical dataset preparations are immutable; create a new preparation instead';
END;
$$;

DROP TRIGGER IF EXISTS statistical_training_dataset_preparation_immutable
  ON statistical_training_dataset_preparation;
CREATE TRIGGER statistical_training_dataset_preparation_immutable
BEFORE UPDATE OR DELETE ON statistical_training_dataset_preparation
FOR EACH ROW EXECUTE FUNCTION statistical_training_dataset_preparation_reject_mutation();

INSERT INTO foundation_schema_version(version,description)
VALUES(138,'Immutable prospective statistical dataset preparation inputs')
ON CONFLICT(version) DO NOTHING;
