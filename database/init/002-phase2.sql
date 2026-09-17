CREATE TABLE IF NOT EXISTS market_data_auth (
  provider TEXT PRIMARY KEY,
  encrypted_refresh_token TEXT NOT NULL,
  encrypted_previous_refresh_token TEXT,
  rotation_started_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instrument (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  questrade_symbol_id BIGINT NOT NULL UNIQUE,
  symbol TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  exchange TEXT NOT NULL,
  currency TEXT NOT NULL,
  security_type TEXT NOT NULL,
  market_cap NUMERIC,
  average_volume_20d BIGINT,
  average_volume_3m BIGINT,
  industry_sector TEXT,
  industry_group TEXT,
  is_quotable BOOLEAN NOT NULL,
  is_tradable BOOLEAN NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quote_snapshot (
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  timestamp TIMESTAMPTZ NOT NULL,
  bid NUMERIC NOT NULL,
  ask NUMERIC NOT NULL,
  bid_size BIGINT NOT NULL,
  ask_size BIGINT NOT NULL,
  last NUMERIC NOT NULL,
  last_size BIGINT NOT NULL,
  day_volume BIGINT NOT NULL,
  day_open NUMERIC NOT NULL,
  day_high NUMERIC NOT NULL,
  day_low NUMERIC NOT NULL,
  spread_absolute NUMERIC NOT NULL,
  spread_pct NUMERIC NOT NULL,
  delay_seconds INTEGER,
  is_delayed BOOLEAN NOT NULL,
  is_halted BOOLEAN NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (instrument_id, timestamp, source)
);

CREATE TABLE IF NOT EXISTS candle (
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  timeframe TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume BIGINT NOT NULL,
  source TEXT NOT NULL,
  is_complete BOOLEAN NOT NULL,
  PRIMARY KEY (instrument_id, timeframe, start_time)
);

CREATE INDEX IF NOT EXISTS quote_snapshot_instrument_time_idx ON quote_snapshot (instrument_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS candle_instrument_timeframe_time_idx ON candle (instrument_id, timeframe, start_time DESC);

SELECT create_hypertable('quote_snapshot', 'timestamp', if_not_exists => TRUE);
SELECT create_hypertable('candle', 'start_time', if_not_exists => TRUE);

INSERT INTO foundation_schema_version (version, description)
VALUES (2, 'Phase 2 Questrade data service')
ON CONFLICT (version) DO NOTHING;
