CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS foundation_schema_version (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO foundation_schema_version (version, description)
VALUES (1, 'Phase 1 foundation')
ON CONFLICT (version) DO NOTHING;
