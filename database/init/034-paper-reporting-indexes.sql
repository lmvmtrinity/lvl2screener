-- Phase 5 reporting groups only immutable paper evidence. These indexes keep
-- exact-cohort aggregation database-side as the forward evidence population grows.
CREATE INDEX IF NOT EXISTS paper_bot_run_reporting_cohort_idx
  ON paper_bot_run(source, execution_model_version, session_date DESC, assumptions);
CREATE INDEX IF NOT EXISTS paper_signal_observation_reporting_cohort_idx
  ON paper_signal_observation(profile_id, profile_config_id, strategy_version, run_id, signal_timestamp DESC);
CREATE INDEX IF NOT EXISTS paper_execution_reporting_filter_idx
  ON paper_execution(model, status, no_fill_reason, exit_reason, observation_id);

INSERT INTO foundation_schema_version(version, description)
VALUES(34, 'Phase 5 paper evidence reporting indexes')
ON CONFLICT(version) DO NOTHING;
