-- Additive Phase 8 evidence and portfolio-risk reporting. Historical runs
-- remain readable with NULL evidence and NULL setup identities.
ALTER TABLE backtest_run ADD COLUMN IF NOT EXISTS evidence JSONB;
ALTER TABLE backtest_trade ADD COLUMN IF NOT EXISTS setup_instance_id UUID;
ALTER TABLE backtest_state_event ADD COLUMN IF NOT EXISTS setup_instance_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS backtest_trade_run_setup_instance_idx
  ON backtest_trade(run_id,setup_instance_id) WHERE setup_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS backtest_event_run_setup_instance_idx
  ON backtest_state_event(run_id,setup_instance_id) WHERE setup_instance_id IS NOT NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(19, 'Phase 8 setup-instance evidence ranges and portfolio risk reporting')
ON CONFLICT(version) DO NOTHING;
