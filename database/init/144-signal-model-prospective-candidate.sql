-- Preserve exact signal semantics on newly captured replay opportunities.
-- Existing rows stay NULL and are not upgraded by this migration.
ALTER TABLE backtest_opportunity_capture
  ADD COLUMN signal_semantics_version TEXT;

ALTER TABLE statistical_model
  ADD COLUMN signal_model_research_authorization_id UUID
    REFERENCES signal_model_research_authorization(id) ON DELETE RESTRICT;

ALTER TABLE statistical_model DROP CONSTRAINT statistical_model_source_check;
ALTER TABLE statistical_model ADD CONSTRAINT statistical_model_source_check CHECK (
  (source_kind='BACKTEST_RUN' AND backtest_run_id IS NOT NULL AND training_dataset_id IS NULL AND signal_model_research_authorization_id IS NULL)
  OR
  (source_kind='PAPER_EVIDENCE' AND backtest_run_id IS NULL AND training_dataset_id IS NOT NULL AND signal_model_research_authorization_id IS NULL)
  OR
  (source_kind='CAPTURED_BACKTEST_RESEARCH' AND backtest_run_id IS NOT NULL AND training_dataset_id IS NULL AND signal_model_research_authorization_id IS NOT NULL AND active=false AND eligible_for_activation=false)
);

ALTER TABLE statistical_model DROP CONSTRAINT IF EXISTS statistical_model_source_kind_check;
ALTER TABLE statistical_model ADD CONSTRAINT statistical_model_source_kind_check
  CHECK (source_kind IN ('BACKTEST_RUN','PAPER_EVIDENCE','CAPTURED_BACKTEST_RESEARCH'));

CREATE UNIQUE INDEX statistical_model_signal_research_authorization_idx
  ON statistical_model(signal_model_research_authorization_id)
  WHERE signal_model_research_authorization_id IS NOT NULL;

INSERT INTO foundation_schema_version(version,description)
VALUES(144,'Inactive captured backtest research candidates with exact prospective scope')
ON CONFLICT(version) DO NOTHING;
