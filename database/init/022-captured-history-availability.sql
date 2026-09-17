-- Persist the exact captured-history window known when research was requested.
-- This prevents a later retention change from making an old result look more
-- complete than the input data that actually existed at execution time.
ALTER TABLE backtest_run
  ADD COLUMN IF NOT EXISTS captured_history_availability JSONB;
ALTER TABLE calibration_run
  ADD COLUMN IF NOT EXISTS captured_history_availability JSONB;

INSERT INTO foundation_schema_version (version, description)
VALUES (22, 'Captured-history availability provenance for research runs')
ON CONFLICT (version) DO NOTHING;
