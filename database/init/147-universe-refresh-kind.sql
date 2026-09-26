-- Daily-list edits (add, replace, remove) no longer rebuild the whole universe.
-- An edit evaluates only the symbols it adds and carries every unchanged
-- member forward with its original metricsAsOf, then completes a run with the
-- full resulting membership so point-in-time replay (ADR-015) still resolves
-- each session from the latest completed run before its open.
--
-- refresh_kind records which path produced the run. Existing rows were all
-- full refreshes, so the default is correct for retained history.
ALTER TABLE universe_refresh_run
  ADD COLUMN IF NOT EXISTS refresh_kind TEXT NOT NULL DEFAULT 'FULL';

ALTER TABLE universe_refresh_run
  DROP CONSTRAINT IF EXISTS universe_refresh_run_refresh_kind_check;
ALTER TABLE universe_refresh_run
  ADD CONSTRAINT universe_refresh_run_refresh_kind_check
  CHECK (refresh_kind IN ('FULL', 'LIST_EDIT'));

INSERT INTO foundation_schema_version(version, description)
VALUES(147, 'Record whether a universe run was a full refresh or a list edit')
ON CONFLICT(version) DO NOTHING;
