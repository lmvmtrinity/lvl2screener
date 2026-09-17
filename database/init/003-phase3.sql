CREATE TABLE IF NOT EXISTS feature_snapshot (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  timestamp TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL,
  price NUMERIC NOT NULL,
  vwap NUMERIC,
  distance_from_vwap_pct NUMERIC,
  atr_14 NUMERIC,
  atr_pct NUMERIC,
  rvol_at_time NUMERIC,
  change_from_open_pct NUMERIC NOT NULL,
  opening_range_high NUMERIC,
  opening_range_low NUMERIC,
  opening_range_mid NUMERIC,
  opening_range_width_pct NUMERIC,
  opening_range_width_atr NUMERIC,
  spread_pct NUMERIC NOT NULL,
  nearest_support NUMERIC,
  nearest_support_type TEXT,
  nearest_resistance NUMERIC,
  nearest_resistance_type TEXT,
  extension_atr NUMERIC,
  config_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  PRIMARY KEY (id, timestamp),
  UNIQUE (instrument_id, timestamp, feature_version)
);

CREATE INDEX IF NOT EXISTS feature_snapshot_instrument_time_idx ON feature_snapshot (instrument_id, timestamp DESC);
SELECT create_hypertable('feature_snapshot', 'timestamp', if_not_exists => TRUE);

INSERT INTO foundation_schema_version (version, description)
VALUES (3, 'Phase 3 deterministic feature engine')
ON CONFLICT (version) DO NOTHING;
