CREATE TABLE IF NOT EXISTS strategy_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), config_version TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false, config JSONB NOT NULL, notes TEXT
);

CREATE TABLE IF NOT EXISTS strategy_signal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), instrument_id UUID NOT NULL REFERENCES instrument(id),
  strategy_name TEXT NOT NULL, strategy_version TEXT NOT NULL, config_version TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL, previous_state TEXT NOT NULL, state TEXT NOT NULL, score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  entry_reference NUMERIC, stop_reference NUMERIC, target_reference NUMERIC, estimated_rr NUMERIC,
  feature_snapshot_id UUID, feature_snapshot_json JSONB NOT NULL, reason_codes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(instrument_id, strategy_name, strategy_version, timestamp)
);
CREATE INDEX IF NOT EXISTS strategy_signal_latest_idx ON strategy_signal(instrument_id, strategy_name, timestamp DESC);

CREATE TABLE IF NOT EXISTS strategy_state_event (
  id UUID PRIMARY KEY, signal_id UUID NOT NULL REFERENCES strategy_signal(id), instrument_id UUID NOT NULL REFERENCES instrument(id),
  strategy_name TEXT NOT NULL, strategy_version TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL,
  previous_state TEXT NOT NULL, new_state TEXT NOT NULL, score INTEGER NOT NULL, reason_codes JSONB NOT NULL, payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS strategy_state_event_timeline_idx ON strategy_state_event(instrument_id, timestamp);

INSERT INTO strategy_config(config_version, created_by, is_active, config, notes) VALUES
('phase4-default-v1','system',true,'{"strategyVersion":"1.0.0","spreadHardMaxPct":0.25,"rvolAtTimeMin":1.5,"retestTolerancePct":0.15,"retestMax5mBars":4}'::jsonb,'Phase 4 deterministic defaults')
ON CONFLICT(config_version) DO NOTHING;
INSERT INTO foundation_schema_version(version, description) VALUES(4,'Phase 4 deterministic strategy engine') ON CONFLICT(version) DO NOTHING;
