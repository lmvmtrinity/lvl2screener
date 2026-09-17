-- W2 corrective migration: fixes the retention policy introduced in
-- 020-phase9-observability.sql, which has never successfully pruned anything.
--
-- Root cause (confirmed): strategy_evaluation (retention 90d) and context_evaluation
-- (retention 30d) both declare a composite FOREIGN KEY(feature_snapshot_id, timestamp)
-- REFERENCES feature_snapshot(id, timestamp), while feature_snapshot itself was pruned at
-- 30d -- shorter than its own 90d-retained child. Any attempt to delete a feature_snapshot
-- row still referenced by a 31-90 day old evaluation/context row raised a foreign-key
-- violation, and because the whole function body ran in one transaction, that single failure
-- rolled back every table's deletes. Storage growth has been unbounded in practice since 020
-- shipped.
--
-- A second, previously undocumented instance of the same class of bug: strategy_signal was
-- pruned at 90d, but strategy_state_event.signal_id REFERENCES strategy_signal(id) NOT NULL
-- with no retention entry of its own at all, and scanner_alert.source_event_id /
-- journal_trade.source_event_id / journal_trade.signal_id all reference strategy_signal's
-- descendants indefinitely (those two tables are intentionally never pruned -- journal and
-- alert history are user-created evidence). Deleting an aged strategy_signal row that still
-- had a state_event, alert, or journal entry pointing at it would have hit the identical
-- foreign-key failure the moment the 020 function actually reached that far in its loop.
--
-- Policy decision applied here (operator-approved 2026-08-28): extend raw quote retention to
-- 180 days to match calibration's 180-day research-horizon default (comfortably covering
-- backtest's 30-day default too), rather than archiving externally or shrinking the UI's
-- research windows. This is an *extension*, not an archive: once a row passes its retention
-- window under this policy it is deleted, not moved anywhere. See
-- docs/operations-runbook.md section 11 ("Backup") for the operational writeup.
--
-- Final retention matrix (see also the confirmatory comment on observability_retention_policy
-- below):
--   quote_snapshot      180d  (was 14d)   -- raw quotes; no FK dependents
--   candle              365d  (new)       -- warm-up/replay source; cheaper per row than quotes,
--                                             kept longer; no FK dependents
--   feature_snapshot    180d  (was 30d)   -- parent of strategy_evaluation/context_evaluation;
--                                             raised so it is never shorter than any child
--   strategy_evaluation  90d  (unchanged) -- child of feature_snapshot
--   context_evaluation   30d  (unchanged) -- child of feature_snapshot
--   strategy_signal      90d  (unchanged) -- parent of strategy_state_event; protected rows
--                                             (see below) survive regardless of age
--   strategy_state_event 90d  (new entry) -- child of strategy_signal, parent of scanner_alert
--                                             and journal_trade; protected rows survive
--                                             regardless of age
--   scanner_alert / journal_trade / backtest_run / calibration_run / statistical_model
--                       indefinite (unchanged) -- never had a retention_policy row and still
--                                             don't; user-created evidence and audit trail
--
-- This migration only corrects the function and the policy table; it does not itself run or
-- schedule any deletion (see the "opt-in scheduling" note near the bottom). The very first
-- real run of prune_retention_history() against a database that has been silently
-- accumulating rows since 020 shipped could delete a large backlog in one pass -- that is
-- expected and is exactly the backlog this migration exists to bound, but an operator should
-- run it once by hand (or watch the first scheduled run) rather than assume it is a no-op.

-- Composite-FK anti-join guards below need to look up children by feature_snapshot_id
-- efficiently; neither index existed before (only the UNIQUE(profile_id, instrument_id,
-- feature_snapshot_id) constraint, which doesn't help a bare feature_snapshot_id lookup).
CREATE INDEX IF NOT EXISTS strategy_evaluation_feature_snapshot_idx ON strategy_evaluation(feature_snapshot_id);
CREATE INDEX IF NOT EXISTS context_evaluation_feature_snapshot_idx ON context_evaluation(feature_snapshot_id);

-- Retention lookups for strategy_state_event/strategy_signal protection guards.
CREATE INDEX IF NOT EXISTS scanner_alert_source_event_idx ON scanner_alert(source_event_id);
CREATE INDEX IF NOT EXISTS journal_trade_source_event_idx ON journal_trade(source_event_id);
CREATE INDEX IF NOT EXISTS journal_trade_signal_idx ON journal_trade(signal_id);
CREATE INDEX IF NOT EXISTS strategy_state_event_signal_idx ON strategy_state_event(signal_id);

-- Not every retained table's time column is named "timestamp" (candle uses start_time), so the
-- policy table now records which column each row's window applies to instead of the pruning
-- function assuming one universal column name.
ALTER TABLE observability_retention_policy ADD COLUMN IF NOT EXISTS time_column TEXT NOT NULL DEFAULT 'timestamp';

INSERT INTO observability_retention_policy(table_name, retention_days, time_column) VALUES
  ('quote_snapshot', 180, 'timestamp'),
  ('candle', 365, 'start_time'),
  ('feature_snapshot', 180, 'timestamp'),
  ('strategy_evaluation', 90, 'timestamp'),
  ('strategy_signal', 90, 'timestamp'),
  ('strategy_state_event', 90, 'timestamp'),
  ('context_evaluation', 30, 'timestamp')
ON CONFLICT(table_name) DO UPDATE
  SET retention_days = EXCLUDED.retention_days, time_column = EXCLUDED.time_column;

-- Operator-visible run history: every invocation of prune_retention_history(), whether it ran,
-- was skipped because a concurrent run held the advisory lock, or hit a per-table error, gets a
-- row here so a failed or skipped run is discoverable without grepping logs (W2 requirement:
-- "a failed retention run is visible in metrics and logs").
CREATE TABLE IF NOT EXISTS retention_job_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED_CONCURRENT')),
  -- One element per table attempted this run: {"table": "...", "rowsDeleted": n, "error": null|"..."}
  table_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT
);
CREATE INDEX IF NOT EXISTS retention_job_run_started_idx ON retention_job_run(started_at DESC);

-- The FK-safe replacement for the 020 function. Ordering and the anti-join guards below are the
-- actual fix:
--   1. context_evaluation, 2. strategy_evaluation  -- children of feature_snapshot, deleted first
--   3. feature_snapshot                             -- parent; window (180d) is >= every child's
--                                                       window, and the guard defends against any
--                                                       row a future change makes an exception to
--                                                       that invariant instead of silently
--                                                       violating the FK
--   4. strategy_state_event                         -- child of strategy_signal, parent of
--                                                       scanner_alert/journal_trade; rows still
--                                                       referenced by either survive regardless of
--                                                       age
--   5. strategy_signal                               -- parent of strategy_state_event and
--                                                        directly of journal_trade; rows still
--                                                        referenced by either survive regardless
--                                                        of age
--   6. quote_snapshot, 7. candle                      -- no FK dependents, independent of the rest
--
-- Each table's delete runs in its own nested BEGIN/EXCEPTION block (an implicit savepoint), so an
-- unexpected failure on one table is recorded and skipped rather than rolling back every table's
-- work the way the single-shot 020 function did.
--
-- Concurrency: pg_try_advisory_xact_lock is non-blocking and scoped to the calling transaction,
-- so two overlapping invocations never interleave deletes -- the second returns immediately with
-- a single SKIPPED_CONCURRENT row and its own retention_job_run entry, and touches no data.
--
-- Idempotency: every delete is a plain age-threshold predicate (plus the anti-join guards), so a
-- second run back-to-back deletes zero additional rows and raises no error.
CREATE OR REPLACE FUNCTION prune_retention_history()
RETURNS TABLE(pruned_table TEXT, rows_deleted BIGINT, prune_error TEXT) AS $$
DECLARE
  run_id UUID;
  deleted BIGINT;
  quote_days INT;
  candle_days INT;
  feature_days INT;
  eval_days INT;
  context_days INT;
  signal_days INT;
  state_event_days INT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(748203962) THEN
    INSERT INTO retention_job_run(status, finished_at, error)
    VALUES ('SKIPPED_CONCURRENT', now(), 'Another retention run already holds the advisory lock.')
    RETURNING id INTO run_id;
    pruned_table := 'SKIPPED_CONCURRENT';
    rows_deleted := 0;
    prune_error := 'Another retention run already holds the advisory lock.';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO retention_job_run(status) VALUES ('RUNNING') RETURNING id INTO run_id;

  SELECT retention_days INTO quote_days FROM observability_retention_policy WHERE table_name = 'quote_snapshot';
  SELECT retention_days INTO candle_days FROM observability_retention_policy WHERE table_name = 'candle';
  SELECT retention_days INTO feature_days FROM observability_retention_policy WHERE table_name = 'feature_snapshot';
  SELECT retention_days INTO eval_days FROM observability_retention_policy WHERE table_name = 'strategy_evaluation';
  SELECT retention_days INTO context_days FROM observability_retention_policy WHERE table_name = 'context_evaluation';
  SELECT retention_days INTO signal_days FROM observability_retention_policy WHERE table_name = 'strategy_signal';
  SELECT retention_days INTO state_event_days FROM observability_retention_policy WHERE table_name = 'strategy_state_event';

  -- 1. context_evaluation
  BEGIN
    DELETE FROM context_evaluation WHERE "timestamp" < now() - (context_days || ' days')::interval;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := 'context_evaluation'; rows_deleted := deleted; prune_error := NULL;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', deleted, 'error', NULL) WHERE id = run_id;
    RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    pruned_table := 'context_evaluation'; rows_deleted := 0; prune_error := SQLERRM;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', 0, 'error', prune_error) WHERE id = run_id;
    RETURN NEXT;
  END;

  -- 2. strategy_evaluation
  BEGIN
    DELETE FROM strategy_evaluation WHERE "timestamp" < now() - (eval_days || ' days')::interval;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := 'strategy_evaluation'; rows_deleted := deleted; prune_error := NULL;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', deleted, 'error', NULL) WHERE id = run_id;
    RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    pruned_table := 'strategy_evaluation'; rows_deleted := 0; prune_error := SQLERRM;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', 0, 'error', prune_error) WHERE id = run_id;
    RETURN NEXT;
  END;

  -- 3. feature_snapshot (parent of the two tables above; guard is defense-in-depth on top of the
  -- window ordering, since the composite FK guarantees a referencing row's own timestamp equals
  -- its parent's, so anything still referenced would already have failed its own, shorter window)
  BEGIN
    DELETE FROM feature_snapshot fs
    WHERE fs."timestamp" < now() - (feature_days || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM strategy_evaluation se WHERE se.feature_snapshot_id = fs.id)
      AND NOT EXISTS (SELECT 1 FROM context_evaluation ce WHERE ce.feature_snapshot_id = fs.id);
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := 'feature_snapshot'; rows_deleted := deleted; prune_error := NULL;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', deleted, 'error', NULL) WHERE id = run_id;
    RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    pruned_table := 'feature_snapshot'; rows_deleted := 0; prune_error := SQLERRM;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', 0, 'error', prune_error) WHERE id = run_id;
    RETURN NEXT;
  END;

  -- 4. strategy_state_event -- rows still pointed at by scanner_alert or journal_trade survive
  -- regardless of age; those two tables are never pruned.
  BEGIN
    DELETE FROM strategy_state_event se
    WHERE se."timestamp" < now() - (state_event_days || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM scanner_alert sa WHERE sa.source_event_id = se.id)
      AND NOT EXISTS (SELECT 1 FROM journal_trade jt WHERE jt.source_event_id = se.id);
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := 'strategy_state_event'; rows_deleted := deleted; prune_error := NULL;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', deleted, 'error', NULL) WHERE id = run_id;
    RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    pruned_table := 'strategy_state_event'; rows_deleted := 0; prune_error := SQLERRM;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', 0, 'error', prune_error) WHERE id = run_id;
    RETURN NEXT;
  END;

  -- 5. strategy_signal -- rows still pointed at by a surviving strategy_state_event (including
  -- ones protected forever by step 4) or directly by journal_trade survive regardless of age.
  BEGIN
    DELETE FROM strategy_signal ss
    WHERE ss."timestamp" < now() - (signal_days || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM strategy_state_event se WHERE se.signal_id = ss.id)
      AND NOT EXISTS (SELECT 1 FROM journal_trade jt WHERE jt.signal_id = ss.id);
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := 'strategy_signal'; rows_deleted := deleted; prune_error := NULL;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', deleted, 'error', NULL) WHERE id = run_id;
    RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    pruned_table := 'strategy_signal'; rows_deleted := 0; prune_error := SQLERRM;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', 0, 'error', prune_error) WHERE id = run_id;
    RETURN NEXT;
  END;

  -- 6. quote_snapshot -- no FK dependents.
  BEGIN
    DELETE FROM quote_snapshot WHERE "timestamp" < now() - (quote_days || ' days')::interval;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := 'quote_snapshot'; rows_deleted := deleted; prune_error := NULL;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', deleted, 'error', NULL) WHERE id = run_id;
    RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    pruned_table := 'quote_snapshot'; rows_deleted := 0; prune_error := SQLERRM;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', 0, 'error', prune_error) WHERE id = run_id;
    RETURN NEXT;
  END;

  -- 7. candle -- time column is start_time, not timestamp; no FK dependents.
  BEGIN
    DELETE FROM candle WHERE start_time < now() - (candle_days || ' days')::interval;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := 'candle'; rows_deleted := deleted; prune_error := NULL;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', deleted, 'error', NULL) WHERE id = run_id;
    RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    pruned_table := 'candle'; rows_deleted := 0; prune_error := SQLERRM;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', 0, 'error', prune_error) WHERE id = run_id;
    RETURN NEXT;
  END;

  UPDATE retention_job_run
    SET status = CASE WHEN EXISTS (
                   SELECT 1 FROM jsonb_array_elements(table_results) e WHERE e ->> 'error' IS NOT NULL
                 ) THEN 'FAILED' ELSE 'SUCCEEDED' END,
        finished_at = now(),
        error = (SELECT string_agg(e ->> 'table' || ': ' || (e ->> 'error'), '; ')
                 FROM jsonb_array_elements(table_results) e WHERE e ->> 'error' IS NOT NULL)
    WHERE id = run_id;
END;
$$ LANGUAGE plpgsql;

-- Deprecated alias kept for anyone still calling the 020 function name directly; delegates to
-- the corrected implementation and narrows its result to the original two-column shape. The
-- 020 function is superseded, not merely edited in place -- 020 itself is left untouched per the
-- migration ledger's checksum guard.
CREATE OR REPLACE FUNCTION prune_evaluation_history() RETURNS TABLE(pruned_table TEXT, rows_deleted BIGINT) AS $$
  SELECT pruned_table, rows_deleted FROM prune_retention_history() WHERE pruned_table <> 'SKIPPED_CONCURRENT';
$$ LANGUAGE sql;

-- Timescale job-scheduler entry point (job_id/config signature required by add_job). Not
-- registered by this migration -- see the "opt-in scheduling" note above and
-- docs/operations-runbook.md section 11. An operator who has confirmed backup coverage and
-- accepted the one-time backlog-deletion risk described above enables it explicitly with:
--   CALL add_job('run_scheduled_retention', INTERVAL '1 day');
CREATE OR REPLACE PROCEDURE run_scheduled_retention(job_id INT, config JSONB) LANGUAGE plpgsql AS $$
BEGIN
  PERFORM prune_retention_history();
END;
$$;

INSERT INTO foundation_schema_version(version, description)
VALUES(28, 'W2 retention correction: FK-safe pruning, 180-day quote/feature retention, operator-visible job history')
ON CONFLICT(version) DO NOTHING;
