CREATE TABLE IF NOT EXISTS backtest_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  strategies JSONB NOT NULL,
  symbols JSONB NOT NULL,
  data_source TEXT NOT NULL CHECK (data_source = 'CAPTURED_QUOTES'),
  strategy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  starting_capital NUMERIC NOT NULL CHECK (starting_capital > 0),
  position_size NUMERIC NOT NULL CHECK (position_size > 0),
  slippage_bps NUMERIC NOT NULL CHECK (slippage_bps >= 0),
  fee_per_trade NUMERIC NOT NULL CHECK (fee_per_trade >= 0),
  parameters JSONB NOT NULL,
  metrics JSONB,
  analyses JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_quality JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS backtest_trade (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  symbol TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  signal_timestamp TIMESTAMPTZ NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  entry_time TIMESTAMPTZ NOT NULL,
  entry_price NUMERIC NOT NULL,
  stop_price NUMERIC NOT NULL,
  target_price NUMERIC NOT NULL,
  exit_time TIMESTAMPTZ NOT NULL,
  exit_price NUMERIC NOT NULL,
  shares BIGINT NOT NULL CHECK (shares > 0),
  exit_reason TEXT NOT NULL CHECK (exit_reason IN ('STOP','TARGET','SESSION_CLOSE')),
  gross_pnl NUMERIC NOT NULL,
  net_pnl NUMERIC NOT NULL,
  r_multiple NUMERIC NOT NULL,
  hold_minutes NUMERIC NOT NULL,
  reason_codes JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_state_event (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  symbol TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  previous_state TEXT NOT NULL,
  state TEXT NOT NULL,
  score INTEGER NOT NULL,
  reason_codes JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS backtest_run_created_idx ON backtest_run(created_at DESC);
CREATE INDEX IF NOT EXISTS backtest_trade_run_entry_idx ON backtest_trade(run_id, entry_time);
CREATE INDEX IF NOT EXISTS backtest_event_run_time_idx ON backtest_state_event(run_id, timestamp);

INSERT INTO foundation_schema_version(version, description)
VALUES(7, 'Phase 8 historical replay and backtesting')
ON CONFLICT(version) DO NOTHING;
