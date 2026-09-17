-- W6: allow research lifecycle rows to be reconciled to INTERRUPTED after an API restart leaves
-- them orphaned mid-run (backtests, calibrations, ranking studies, statistical training). The
-- reconciliation itself is a startup stopgap in apps/api/src/database/reconcile-orphaned-research.ts;
-- this migration only widens the CHECK constraints that would otherwise reject the new status.
--
-- W7 fix (found while bootstrapping a fresh database to run the W7 persistence fixture, see
-- database/init/026-operational-status-constraint-fix.sql for the full writeup): the original
-- lookup below matched on `pg_get_constraintdef(...) ILIKE '%status%'`, which also matches
-- `statistical_model`'s table-level composite check (`NOT active OR (status = 'COMPLETED' AND
-- eligible_for_activation)`) alongside its column CHECK -- both mention "status". Without an
-- ORDER BY/LIMIT, `SELECT ... INTO` on that two-row match nondeterministically picked either one;
-- on a from-scratch bootstrap it consistently dropped the wrong constraint and then collided with
-- the untouched original, failing this migration outright on every fresh database. Matching on the
-- constraint's own generated name (`<table>_status_check`, unambiguous and specific to the column
-- CHECK) instead of its definition text fixes the false match without changing behavior for the
-- other three tables here, which only ever had one status-related constraint to begin with.

DO $$
DECLARE
  target_conname text;
BEGIN
  SELECT c.conname INTO target_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'backtest_run' AND c.contype = 'c'
    AND c.conname LIKE '%\_status\_check' ESCAPE '\';
  IF target_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE backtest_run DROP CONSTRAINT %I', target_conname);
  END IF;
END $$;
ALTER TABLE backtest_run ADD CONSTRAINT backtest_run_status_check
  CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'));

DO $$
DECLARE
  target_conname text;
BEGIN
  SELECT c.conname INTO target_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'calibration_run' AND c.contype = 'c'
    AND c.conname LIKE '%\_status\_check' ESCAPE '\';
  IF target_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE calibration_run DROP CONSTRAINT %I', target_conname);
  END IF;
END $$;
ALTER TABLE calibration_run ADD CONSTRAINT calibration_run_status_check
  CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'));

DO $$
DECLARE
  target_conname text;
BEGIN
  SELECT c.conname INTO target_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'statistical_model' AND c.contype = 'c'
    AND c.conname LIKE '%\_status\_check' ESCAPE '\';
  IF target_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE statistical_model DROP CONSTRAINT %I', target_conname);
  END IF;
END $$;
ALTER TABLE statistical_model ADD CONSTRAINT statistical_model_status_check
  CHECK (status IN ('PENDING', 'TRAINING', 'COMPLETED', 'INSUFFICIENT_DATA', 'FAILED', 'INTERRUPTED'));

DO $$
DECLARE
  target_conname text;
BEGIN
  SELECT c.conname INTO target_conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'ranking_research_run' AND c.contype = 'c'
    AND c.conname LIKE '%\_status\_check' ESCAPE '\';
  IF target_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE ranking_research_run DROP CONSTRAINT %I', target_conname);
  END IF;
END $$;
ALTER TABLE ranking_research_run ADD CONSTRAINT ranking_research_run_status_check
  CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'));
