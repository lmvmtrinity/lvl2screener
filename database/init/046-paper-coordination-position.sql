CREATE TABLE IF NOT EXISTS paper_coordination_position (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL UNIQUE REFERENCES paper_coordination_decision(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL REFERENCES paper_signal_observation(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSE_PENDING','CLOSED','NO_FILL')),
  state JSONB NOT NULL,
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('TARGET','STOP','SESSION_CLOSE','SESSION_CLOSE_DELAYED')),
  exit_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(state) = 'object')
);
CREATE INDEX IF NOT EXISTS paper_coordination_position_open_idx ON paper_coordination_position(status) WHERE status IN ('OPEN','CLOSE_PENDING');
CREATE OR REPLACE FUNCTION paper_coordination_position_touch_updated_at() RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER paper_coordination_position_touch_updated_at BEFORE UPDATE ON paper_coordination_position FOR EACH ROW EXECUTE FUNCTION paper_coordination_position_touch_updated_at();
INSERT INTO foundation_schema_version(version, description) VALUES(46, 'Coordinated paper shadow position lifecycle') ON CONFLICT(version) DO NOTHING;
