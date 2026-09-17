CREATE TABLE IF NOT EXISTS journal_trade (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id UUID NOT NULL UNIQUE REFERENCES strategy_state_event(id),
  signal_id UUID NOT NULL REFERENCES strategy_signal(id),
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  signal_timestamp TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  entry_time TIMESTAMPTZ NOT NULL,
  entry_price NUMERIC NOT NULL CHECK (entry_price > 0),
  stop_price NUMERIC NOT NULL CHECK (stop_price > 0 AND stop_price < entry_price),
  target_price NUMERIC NOT NULL CHECK (target_price > entry_price),
  exit_time TIMESTAMPTZ,
  exit_price NUMERIC CHECK (exit_price > 0),
  shares INTEGER NOT NULL CHECK (shares > 0),
  initial_risk NUMERIC NOT NULL CHECK (initial_risk > 0),
  gross_pnl NUMERIC,
  net_pnl NUMERIC,
  r_multiple NUMERIC,
  notes TEXT NOT NULL DEFAULT '',
  source_event_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'OPEN' AND exit_time IS NULL AND exit_price IS NULL AND gross_pnl IS NULL AND net_pnl IS NULL AND r_multiple IS NULL)
      OR (status = 'CLOSED' AND exit_time IS NOT NULL AND exit_price IS NOT NULL AND gross_pnl IS NOT NULL AND net_pnl IS NOT NULL AND r_multiple IS NOT NULL)),
  CHECK (exit_time IS NULL OR exit_time >= entry_time)
);

CREATE INDEX IF NOT EXISTS journal_trade_history_idx ON journal_trade(entry_time DESC);
CREATE INDEX IF NOT EXISTS journal_trade_strategy_idx ON journal_trade(strategy_name, strategy_version, config_version, entry_time DESC);
INSERT INTO foundation_schema_version(version, description) VALUES(6,'Phase 7 paper-trading journal') ON CONFLICT(version) DO NOTHING;
