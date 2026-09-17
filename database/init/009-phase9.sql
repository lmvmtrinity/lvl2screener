ALTER TABLE backtest_trade ADD COLUMN IF NOT EXISTS sector TEXT;
ALTER TABLE backtest_trade ADD COLUMN IF NOT EXISTS atr_pct NUMERIC;
ALTER TABLE backtest_trade ADD COLUMN IF NOT EXISTS rvol_at_time NUMERIC;

CREATE TABLE IF NOT EXISTS calibration_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  strategy_name TEXT NOT NULL,
  symbols JSONB NOT NULL,
  data_source TEXT NOT NULL CHECK(data_source='CAPTURED_QUOTES'),
  input JSONB NOT NULL,
  combinations_tested INTEGER NOT NULL DEFAULT 0,
  total_combinations INTEGER NOT NULL DEFAULT 0,
  truncated BOOLEAN NOT NULL DEFAULT false,
  split_dates JSONB,
  recommendation TEXT NOT NULL DEFAULT '',
  recommended_config JSONB,
  trials JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK(end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS calibration_run_created_idx ON calibration_run(created_at DESC);

UPDATE strategy_definition
SET parameter_schema=parameter_schema || '{"atrPctMin":"number"}'::jsonb
WHERE strategy_key IN ('ORB_RETEST','VWAP_HOLD');

INSERT INTO foundation_schema_version(version,description)
VALUES(9,'Phase 9 robust parameter calibration')
ON CONFLICT(version) DO NOTHING;
