CREATE TABLE IF NOT EXISTS scanner_alert (
  id UUID PRIMARY KEY,
  source_event_id UUID NOT NULL UNIQUE REFERENCES strategy_state_event(id),
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  alert_type TEXT NOT NULL CHECK (alert_type IN ('READY', 'INVALIDATION')),
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  previous_state TEXT NOT NULL,
  state TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  reason_codes JSONB NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scanner_alert_history_idx ON scanner_alert(timestamp DESC);
INSERT INTO foundation_schema_version(version, description) VALUES(5,'Phase 6 scanner alerts') ON CONFLICT(version) DO NOTHING;
