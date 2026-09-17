ALTER TABLE paper_coordination_position
  DROP CONSTRAINT IF EXISTS paper_coordination_position_exit_reason_check;
ALTER TABLE paper_coordination_position
  ADD CONSTRAINT paper_coordination_position_exit_reason_check CHECK (
    exit_reason IS NULL OR exit_reason IN ('TARGET','STOP','TIME_STOP','SESSION_CLOSE','SESSION_CLOSE_DELAYED')
  );
INSERT INTO foundation_schema_version(version, description)
VALUES(48, 'Coordinated paper time-stop exits') ON CONFLICT(version) DO NOTHING;
