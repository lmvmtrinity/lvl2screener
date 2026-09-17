-- Authoritative quote execution can remain pending past noon and close at the
-- first later actionable bid. Closed canonical trades retain that distinction.
ALTER TABLE backtest_trade DROP CONSTRAINT IF EXISTS backtest_trade_exit_reason_check;
ALTER TABLE backtest_trade ADD CONSTRAINT backtest_trade_exit_reason_check
  CHECK (exit_reason IN ('STOP','TARGET','SESSION_CLOSE','SESSION_CLOSE_DELAYED'));

INSERT INTO foundation_schema_version(version, description)
VALUES(32, 'Phase 4 authoritative delayed backtest session-close outcomes')
ON CONFLICT(version) DO NOTHING;
