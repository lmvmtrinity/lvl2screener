-- Quote and candle history is now retained by Timescale chunk policies.
-- Feature rows stay in row storage because converting a chunk with incoming
-- strategy/context evaluation foreign keys fails on TimescaleDB 2.29.2.
ALTER TABLE quote_snapshot SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'instrument_id'
);
ALTER TABLE candle SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'instrument_id,timeframe'
);
CALL add_columnstore_policy('quote_snapshot', after => INTERVAL '3 days');
CALL add_columnstore_policy('candle', after => INTERVAL '7 days');
SELECT add_retention_policy('quote_snapshot', INTERVAL '180 days');
SELECT add_retention_policy('candle', INTERVAL '365 days');
CREATE OR REPLACE FUNCTION prune_retention_history()
RETURNS TABLE(pruned_table TEXT, rows_deleted BIGINT, prune_error TEXT) AS $$
DECLARE
  run_id UUID;
  deleted BIGINT;
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

  -- 4. strategy_state_event -- rows still pointed at by scanner_alert survive regardless of age;
  -- that table is never pruned.
  BEGIN
    DELETE FROM strategy_state_event se
    WHERE se."timestamp" < now() - (state_event_days || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM scanner_alert sa WHERE sa.source_event_id = se.id);
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
  -- ones protected forever by step 4) survive regardless of age.
  BEGIN
    DELETE FROM strategy_signal ss
    WHERE ss."timestamp" < now() - (signal_days || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM strategy_state_event se WHERE se.signal_id = ss.id);
    GET DIAGNOSTICS deleted = ROW_COUNT;
    pruned_table := 'strategy_signal'; rows_deleted := deleted; prune_error := NULL;
    UPDATE retention_job_run SET table_results = table_results || jsonb_build_object('table', pruned_table, 'rowsDeleted', deleted, 'error', NULL) WHERE id = run_id;
    RETURN NEXT;
  EXCEPTION WHEN OTHERS THEN
    pruned_table := 'strategy_signal'; rows_deleted := 0; prune_error := SQLERRM;
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
INSERT INTO foundation_schema_version(version, description)
VALUES(150, 'Compress quote and candle history and retain by dropping old chunks')
ON CONFLICT(version) DO NOTHING;
