-- The scanner stopped writing this redundant JSON copy in September 2026.
-- Dropping the column is metadata-only; operators compact the table separately
-- after a verified backup and while the market is closed.
ALTER TABLE strategy_signal
  DROP COLUMN IF EXISTS feature_snapshot_json;

INSERT INTO foundation_schema_version(version, description)
VALUES(148, 'Remove the redundant strategy signal feature snapshot copy')
ON CONFLICT(version) DO NOTHING;
