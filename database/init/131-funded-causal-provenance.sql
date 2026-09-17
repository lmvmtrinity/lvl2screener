-- FP02-R5: exact causal funded provenance and chronology immutability.
--
-- Migration 130 assigned a historical-replay outcome version's knowledge
-- boundary from the run's *current* applied counter and frontier. A correction
-- appended later without a new causal fact could therefore reuse the earlier
-- boundary and leak into TRAIN before the holdout. This migration makes replay
-- provenance source-owned: each replay outcome version names the exact durable
-- funded fact that made it knowable (`source_fact_id`) and the database derives
-- the run, applied sequence and frontier from that fact row. It also makes the
-- applied chronology genuinely database-owned and immutable, and binds every
-- entry-order revision (and ledger event) to the exact fact that caused it.
--
-- Migration 130 was published in commit f4c9109 and is applied on the retained
-- database; it is not modified here.

-- ============================================================================
-- Run counter and frontier are database-internal
-- ============================================================================
-- Only the sequenced-fact assignment triggers may advance the run's applied
-- counter and frontier. A direct UPDATE (operator, repair script or fixture)
-- runs the guard at trigger depth 1 and is rejected.
CREATE OR REPLACE FUNCTION guard_paper_funded_run_applied_sequence_counter()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'Funded run applied sequence ownership is database-internal';
  END IF;
  IF NEW.applied_sequence_counter < OLD.applied_sequence_counter THEN
    RAISE EXCEPTION 'Funded run applied sequence counter cannot decrease';
  END IF;
  IF OLD.applied_frontier_at IS NOT NULL
     AND NEW.applied_frontier_at IS NOT NULL
     AND NEW.applied_frontier_at < OLD.applied_frontier_at THEN
    RAISE EXCEPTION 'Funded run applied fact frontier cannot decrease';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Per-fact causal frontier and complete immutable assignment
-- ============================================================================
-- Each sequenced fact carries the monotone knowledge frontier at its own
-- applied sequence: the greatest fact time applied at or before that sequence.
-- A replay outcome can then bind an exact causal fact rather than the run's
-- current boundary.
ALTER TABLE paper_funded_fact
  ADD COLUMN IF NOT EXISTS applied_frontier_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION assign_paper_funded_fact_applied_sequence()
RETURNS trigger AS $$
DECLARE
  processed_status TEXT;
  assigned BIGINT;
  frontier TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A caller may never choose a sequence or frontier; the statement-level
    -- trigger below assigns both from the locked run counter in this
    -- transaction.
    IF NEW.applied_sequence IS NOT NULL OR NEW.applied_frontier_at IS NOT NULL THEN
      RAISE EXCEPTION 'Funded fact applied sequence is database-owned';
    END IF;
    RETURN NEW;
  END IF;

  -- The bulk insert assignment (statement-level trigger) fills sequences that
  -- were still unassigned; a direct caller never reaches this depth.
  IF pg_trigger_depth() > 1
     AND OLD.applied_sequence IS NULL
     AND NEW.applied_sequence IS NOT NULL
     AND NEW.applied_frontier_at IS NOT NULL
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome THEN
    RETURN NEW;
  END IF;

  -- A previously assigned sequence and frontier are immutable, and a processed
  -- outcome may not be cleared or rewritten.
  IF NEW.applied_sequence IS DISTINCT FROM OLD.applied_sequence
     OR NEW.applied_frontier_at IS DISTINCT FROM OLD.applied_frontier_at THEN
    RAISE EXCEPTION 'Funded fact applied sequence is immutable';
  END IF;
  IF OLD.outcome IS NULL AND NEW.outcome IS NOT NULL THEN
    processed_status := NEW.outcome->>'status';
    IF processed_status IS NOT NULL AND processed_status <> 'LATE_FACT' THEN
      UPDATE paper_funded_run
         SET applied_sequence_counter = applied_sequence_counter + 1,
             applied_frontier_at = GREATEST(
               COALESCE(applied_frontier_at, 'epoch'::timestamptz),
               NEW.fact_at
             )
       WHERE run_id = NEW.run_id
      RETURNING applied_sequence_counter, applied_frontier_at
        INTO assigned, frontier;
      IF assigned IS NULL OR frontier IS NULL THEN
        RAISE EXCEPTION 'Funded fact % has no durable run counter', NEW.fact_id;
      END IF;
      NEW.applied_sequence := assigned;
      NEW.applied_frontier_at := frontier;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    RAISE EXCEPTION 'Processed funded fact outcome is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assign_inserted_paper_funded_fact_sequences()
RETURNS trigger AS $$
BEGIN
  WITH targets AS (
    SELECT run_id, fact_id, fact_at,
           row_number() OVER (
             PARTITION BY run_id
             ORDER BY fact_at, priority, sort_key COLLATE "C",
                      fact_id COLLATE "C"
           ) AS ordinal,
           max(fact_at) OVER (
             PARTITION BY run_id
             ORDER BY fact_at, priority, sort_key COLLATE "C",
                      fact_id COLLATE "C"
           ) AS batch_frontier
      FROM new_facts
     WHERE outcome IS NOT NULL
       AND COALESCE(outcome->>'status', '') <> 'LATE_FACT'
  ),
  counted AS (
    SELECT run_id, count(*)::bigint AS assigned_count,
           max(fact_at) AS frontier_at
      FROM targets
     GROUP BY run_id
  ),
  -- The pre-statement frontier of each run; SELECT CTEs read the statement
  -- snapshot and cannot observe the run update in this same statement.
  priors AS (
    SELECT b.run_id, b.applied_frontier_at
      FROM paper_funded_run b
     WHERE b.run_id IN (SELECT run_id FROM counted)
  ),
  locked AS (
    UPDATE paper_funded_run b
       SET applied_sequence_counter =
             b.applied_sequence_counter + counted.assigned_count,
           applied_frontier_at = GREATEST(
             COALESCE(b.applied_frontier_at, 'epoch'::timestamptz),
             counted.frontier_at
           )
      FROM counted
     WHERE b.run_id = counted.run_id
    RETURNING b.run_id, b.applied_sequence_counter AS counter_after
  )
  UPDATE paper_funded_fact f
     SET applied_sequence =
           locked.counter_after - counted.assigned_count + targets.ordinal,
         applied_frontier_at = GREATEST(
           COALESCE(priors.applied_frontier_at, 'epoch'::timestamptz),
           targets.batch_frontier
         )
    FROM targets
    JOIN counted ON counted.run_id = targets.run_id
    JOIN locked ON locked.run_id = targets.run_id
    JOIN priors ON priors.run_id = targets.run_id
   WHERE f.run_id = targets.run_id AND f.fact_id = targets.fact_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Once a fact is processed its identity, timing, content, outcome, recorded
-- processing time and assigned sequence are immutable. A pending fact may
-- still transition to processed (the existing assignment trigger) and a
-- pending, unsequenced fact may still be removed; a processed or sequenced
-- fact may not.
CREATE OR REPLACE FUNCTION guard_processed_paper_funded_fact()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.outcome IS NOT NULL OR OLD.applied_sequence IS NOT NULL THEN
      RAISE EXCEPTION 'Processed funded facts are immutable';
    END IF;
    RETURN OLD;
  END IF;

  -- The statement-level insert trigger may fill the sequence and frontier of
  -- rows it inserted in this same statement.
  IF pg_trigger_depth() > 1
     AND OLD.applied_sequence IS NULL
     AND NEW.applied_sequence IS NOT NULL
     AND NEW.applied_frontier_at IS NOT NULL
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome THEN
    RETURN NEW;
  END IF;

  -- Pending-to-processed transition, including the permission for the
  -- assignment trigger to set the outcome, processed time, sequence and
  -- frontier.
  IF OLD.outcome IS NULL AND OLD.applied_sequence IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.fact_id IS DISTINCT FROM OLD.fact_id
     OR NEW.fact_at IS DISTINCT FROM OLD.fact_at
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.sort_key IS DISTINCT FROM OLD.sort_key
     OR NEW.fact IS DISTINCT FROM OLD.fact
     OR NEW.economic_key IS DISTINCT FROM OLD.economic_key
     OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.processed_at IS DISTINCT FROM OLD.processed_at
     OR NEW.applied_sequence IS DISTINCT FROM OLD.applied_sequence
     OR NEW.applied_frontier_at IS DISTINCT FROM OLD.applied_frontier_at THEN
    RAISE EXCEPTION 'Processed funded facts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_funded_fact_processed_guard
  ON paper_funded_fact;
CREATE TRIGGER paper_funded_fact_processed_guard
  BEFORE UPDATE OR DELETE ON paper_funded_fact
  FOR EACH ROW EXECUTE FUNCTION guard_processed_paper_funded_fact();

-- ============================================================================
-- Replay outcome provenance names the exact causal fact
-- ============================================================================
ALTER TABLE funded_decision_outcome
  ADD COLUMN IF NOT EXISTS source_fact_id TEXT;

ALTER TABLE funded_decision_outcome
  DROP CONSTRAINT IF EXISTS funded_decision_outcome_source_fact_fk;
-- Composite ownership: a replay source fact must belong to the outcome's own
-- run. NULL keeps a version unavailable to replay training.
ALTER TABLE funded_decision_outcome
  ADD CONSTRAINT funded_decision_outcome_source_fact_fk
  FOREIGN KEY (run_id, source_fact_id)
  REFERENCES paper_funded_fact(run_id, fact_id);

CREATE OR REPLACE FUNCTION assign_funded_decision_outcome_knowledge_boundary()
RETURNS trigger AS $$
DECLARE
  decision_source TEXT;
  source_fact paper_funded_fact%ROWTYPE;
  source_status TEXT;
BEGIN
  SELECT d.source_kind INTO decision_source
    FROM funded_decision_evidence d
   WHERE d.run_id=NEW.run_id AND d.observation_id=NEW.observation_id;
  IF decision_source IS NULL THEN
    RAISE EXCEPTION 'Funded outcome has no owning decision';
  END IF;
  IF NEW.knowledge_applied_sequence IS NOT NULL OR NEW.knowledge_at IS NOT NULL THEN
    RAISE EXCEPTION 'Funded outcome knowledge boundary is database-owned';
  END IF;
  IF decision_source <> 'HISTORICAL_REPLAY' THEN
    -- Live capture keeps its database clock; it never carries a replay source.
    IF NEW.source_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'Live funded outcome knowledge is database capture, not a replay source';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_fact_id IS NULL THEN
    -- No provable causal fact: the version stays unavailable to replay
    -- training instead of manufacturing a boundary.
    RETURN NEW;
  END IF;
  -- Lock the source while validating it, so an unacknowledged fact cannot be
  -- read as processed or a processed fact mutated underneath this insert.
  SELECT * INTO source_fact
    FROM paper_funded_fact f
   WHERE f.run_id=NEW.run_id AND f.fact_id=NEW.source_fact_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Replay funded outcome source fact is not durable';
  END IF;
  IF source_fact.outcome IS NULL THEN
    RAISE EXCEPTION 'Replay funded outcome source fact is not processed';
  END IF;
  source_status := source_fact.outcome->>'status';
  IF source_status IS NULL OR source_status = 'LATE_FACT' THEN
    RAISE EXCEPTION 'Replay funded outcome source fact is refused or unknown';
  END IF;
  IF source_fact.applied_sequence IS NULL
     OR source_fact.applied_frontier_at IS NULL THEN
    RAISE EXCEPTION 'Replay funded outcome source fact has no applied sequence';
  END IF;
  NEW.knowledge_applied_sequence := source_fact.applied_sequence;
  NEW.knowledge_at := source_fact.applied_frontier_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Entry-order revisions and ledger events name their exact causal fact
-- ============================================================================
ALTER TABLE paper_entry_order
  ADD COLUMN IF NOT EXISTS last_fact_id TEXT;
ALTER TABLE paper_entry_order_history
  ADD COLUMN IF NOT EXISTS fact_id TEXT;
ALTER TABLE paper_funded_event
  ADD COLUMN IF NOT EXISTS fact_run_id UUID,
  ADD COLUMN IF NOT EXISTS fact_id TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='paper_funded_event_fact_pair_check'
       AND conrelid='paper_funded_event'::regclass
  ) THEN
    ALTER TABLE paper_funded_event
      ADD CONSTRAINT paper_funded_event_fact_pair_check
      CHECK ((fact_run_id IS NULL) = (fact_id IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='paper_funded_event_fact_fk'
       AND conrelid='paper_funded_event'::regclass
  ) THEN
    ALTER TABLE paper_funded_event
      ADD CONSTRAINT paper_funded_event_fact_fk
      FOREIGN KEY (fact_run_id, fact_id)
      REFERENCES paper_funded_fact(run_id, fact_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_paper_funded_event_causal_identity()
RETURNS trigger AS $$
BEGIN
  IF (NEW.fact_run_id IS NULL) <> (NEW.fact_id IS NULL) THEN
    RAISE EXCEPTION 'Paper funded event cause requires both run and fact identity';
  END IF;
  IF NEW.fact_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM paper_funded_run r
      JOIN paper_funded_fact f
        ON f.run_id=r.run_id AND f.fact_id=NEW.fact_id
     WHERE r.run_id=NEW.fact_run_id AND r.account_id=NEW.account_id
  ) THEN
    RAISE EXCEPTION
      'Paper funded event causal fact must belong to a run bound to the same funded account';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_funded_event_causal_identity_validate
  ON paper_funded_event;
CREATE TRIGGER paper_funded_event_causal_identity_validate
BEFORE INSERT OR UPDATE ON paper_funded_event
FOR EACH ROW EXECUTE FUNCTION validate_paper_funded_event_causal_identity();

CREATE OR REPLACE FUNCTION reject_paper_funded_event_causal_identity_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.fact_run_id IS DISTINCT FROM OLD.fact_run_id
     OR NEW.fact_id IS DISTINCT FROM OLD.fact_id THEN
    RAISE EXCEPTION 'Paper funded event causal identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_funded_event_causal_identity_immutable
  ON paper_funded_event;
CREATE TRIGGER paper_funded_event_causal_identity_immutable
BEFORE UPDATE OF fact_run_id, fact_id ON paper_funded_event
FOR EACH ROW EXECUTE FUNCTION reject_paper_funded_event_causal_identity_update();

CREATE OR REPLACE FUNCTION capture_paper_entry_order_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  existing paper_entry_order_history%ROWTYPE;
BEGIN
  SELECT * INTO existing
    FROM paper_entry_order_history
   WHERE order_id=NEW.order_id AND revision=NEW.revision;
  IF FOUND THEN
    -- The exact revision already exists. An identical re-observation is a
    -- no-op; any different fact time, state or causal fact is a conflicting
    -- replay and fails.
    IF existing.fact_at IS DISTINCT FROM NEW.last_fact_at
       OR existing.state IS DISTINCT FROM NEW.state
       OR existing.fact_id IS DISTINCT FROM NEW.last_fact_id THEN
      RAISE EXCEPTION
        'Paper entry order revision % for order % already exists with different content',
        NEW.revision, NEW.order_id;
    END IF;
    RETURN NEW;
  END IF;
  -- The recording time is left to the history authority trigger, which always
  -- assigns the database clock and rejects a caller-supplied value.
  INSERT INTO paper_entry_order_history(order_id,revision,fact_at,state,fact_id)
  VALUES(NEW.order_id,NEW.revision,NEW.last_fact_at,NEW.state,NEW.last_fact_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION authorize_paper_entry_order_history_insert()
RETURNS trigger AS $$
DECLARE
  current_order paper_entry_order%ROWTYPE;
BEGIN
  IF NEW.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Paper entry order history recording time is database-owned';
  END IF;
  SELECT * INTO current_order
    FROM paper_entry_order
   WHERE order_id=NEW.order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paper entry order history requires its parent order';
  END IF;
  IF NEW.revision IS DISTINCT FROM current_order.revision
     OR NEW.fact_at IS DISTINCT FROM current_order.last_fact_at
     OR NEW.state IS DISTINCT FROM current_order.state
     OR NEW.fact_id IS DISTINCT FROM current_order.last_fact_id THEN
    RAISE EXCEPTION
      'Paper entry order history must match the current locked order revision for order %',
      NEW.order_id;
  END IF;
  -- A causal fact identity must be a durable fact of the same run. It may be
  -- retained before that fact is acknowledged; training only uses it once the
  -- fact has a durable applied sequence.
  IF NEW.fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM paper_funded_fact f
     WHERE f.run_id=current_order.run_id AND f.fact_id=NEW.fact_id
  ) THEN
    RAISE EXCEPTION
      'Paper entry order history causal fact is not durable for order %',
      NEW.order_id;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

INSERT INTO foundation_schema_version(version, description)
VALUES(131, 'Exact causal funded provenance and chronology immutability')
ON CONFLICT(version) DO NOTHING;
