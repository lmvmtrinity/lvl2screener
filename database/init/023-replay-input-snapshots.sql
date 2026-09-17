-- Preserve the resolved candidate/benchmark universe used by every replay.
-- Existing runs remain readable with NULL replay_input and are explicitly
-- treated as legacy runs whose exact universe cannot be reconstructed.
ALTER TABLE backtest_run ADD COLUMN IF NOT EXISTS replay_input JSONB;

INSERT INTO foundation_schema_version (version, description)
VALUES (23, 'Resolved replay-input snapshots for reproducible backtests')
ON CONFLICT (version) DO NOTHING;
