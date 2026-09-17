-- Phase 9 production robustness: indexing and a retention policy for the tables
-- written every scan cycle, so evaluation volume does not grow unbounded.
-- Additive only; historical rows are unaffected until prune_evaluation_history()
-- is invoked by an operator or a scheduled job.

CREATE INDEX IF NOT EXISTS strategy_evaluation_timestamp_idx ON strategy_evaluation(timestamp);
CREATE INDEX IF NOT EXISTS strategy_signal_timestamp_idx ON strategy_signal(timestamp);
CREATE INDEX IF NOT EXISTS feature_snapshot_timestamp_idx ON feature_snapshot(timestamp);
CREATE INDEX IF NOT EXISTS quote_snapshot_timestamp_idx ON quote_snapshot(timestamp);
CREATE INDEX IF NOT EXISTS context_evaluation_timestamp_idx ON context_evaluation(timestamp);

CREATE TABLE IF NOT EXISTS observability_retention_policy (
  table_name TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL CHECK (retention_days > 0)
);
INSERT INTO observability_retention_policy(table_name, retention_days) VALUES
  ('quote_snapshot', 14),
  ('feature_snapshot', 30),
  ('strategy_evaluation', 90),
  ('strategy_signal', 90),
  ('context_evaluation', 30)
ON CONFLICT(table_name) DO NOTHING;

-- Deletes rows older than each table's configured retention window and reports
-- what it did. Intended to be invoked by an operator or scheduled job; it is
-- not run automatically by this migration.
CREATE OR REPLACE FUNCTION prune_evaluation_history() RETURNS TABLE(pruned_table TEXT, rows_deleted BIGINT) AS $$
DECLARE
  policy RECORD;
  deleted BIGINT;
BEGIN
  FOR policy IN SELECT table_name, retention_days FROM observability_retention_policy LOOP
    EXECUTE format('DELETE FROM %I WHERE "timestamp" < now() - (%L || '' days'')::interval', policy.table_name, policy.retention_days);
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := policy.table_name;
    rows_deleted := deleted;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

INSERT INTO foundation_schema_version(version, description)
VALUES(20, 'Phase 9 evaluation-volume indexing and retention policy')
ON CONFLICT(version) DO NOTHING;
