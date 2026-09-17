-- E04: first-class, immutable derivation record for statistical training datasets.
-- Coverage of a date/instrument range does not prove how each frozen feature was
-- produced. This column retains the manifest-defined derivation facts captured at
-- materialization (feature/runtime identity, exact row membership digest and the
-- verified source coverage identities when they exist). NULL stays readable for
-- legacy datasets and remains intentionally unproven.

ALTER TABLE statistical_training_dataset
  ADD COLUMN IF NOT EXISTS research_derivation JSONB;

DO $$ BEGIN
  ALTER TABLE statistical_training_dataset
    ADD CONSTRAINT statistical_training_dataset_derivation_check
    CHECK (research_derivation IS NULL OR jsonb_typeof(research_derivation) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO foundation_schema_version(version,description)
VALUES(121,'Statistical training dataset derivation provenance record')
ON CONFLICT(version) DO NOTHING;
