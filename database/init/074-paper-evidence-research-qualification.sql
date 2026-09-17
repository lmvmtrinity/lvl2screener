-- Research qualification is an immutable property of a frozen evidence
-- snapshot. Legacy datasets remain readable, but are deliberately treated as
-- unqualified because their signal/label boundaries and provenance were not
-- audited under the current policy.

ALTER TABLE statistical_training_dataset
  ADD COLUMN IF NOT EXISTS research_qualification JSONB NOT NULL DEFAULT
    '{"policyVersion":"legacy-unqualified","qualified":false,"reasons":["LEGACY_DATASET_MISSING_RESEARCH_QUALIFICATION"],"sourceRowCount":0,"acceptedRowCount":0,"distinctSessionCount":0,"chronologicalSplitAt":null,"walkForwardWindows":[],"excludedCounts":{}}'::jsonb;

ALTER TABLE statistical_training_dataset
  DROP CONSTRAINT IF EXISTS statistical_training_dataset_research_qualification_check;
ALTER TABLE statistical_training_dataset
  ADD CONSTRAINT statistical_training_dataset_research_qualification_check
  CHECK (jsonb_typeof(research_qualification) = 'object');

COMMENT ON COLUMN statistical_training_dataset.research_qualification IS
  'Immutable leakage/provenance/chronological holdout gate; only qualified=true datasets may train or activate paper statistical models.';

INSERT INTO foundation_schema_version(version, description)
VALUES(74, 'Fail-closed paper evidence research qualification snapshots')
ON CONFLICT(version) DO NOTHING;
