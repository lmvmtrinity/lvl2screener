-- FP04-R1: funded shadow-observation boundary hardening.
--
-- Additive hardening for the FP04 persistence added by migration 136. Migration
-- 136 remains applied and unmodified; this migration replaces three CHECK
-- constraints that could pass on NULL, adds two ownership foreign keys and
-- replaces four validation triggers with stricter, still append-only versions:
--
-- 1. Gate-policy Stage B and window checks reject missing/null/non-numeric
--    values and enforce the ADR-016 SHADOW window floor.
-- 2. The report no-authority check is NULL-safe.
-- 3. A projection must belong to its batch's market and currency.
-- 4. An attempt must belong to its batch's enrollment and funded run.
-- 5. A label requires its terminal attempt result.
-- 6. Re-sealing an already-projected batch resolves an identical member as a
--    no-op instead of raising, while a genuinely new member is still refused.
-- 7. A batch closes at `greatest(decision_at + lag, sealed_at + grace)`, so the
--    grace is part of the durable closure rule.

-- ============================================================================
-- Gate policy: NULL-safe Stage B and window checks with ADR-016 floors
-- ============================================================================
ALTER TABLE funded_shadow_gate_policy
  DROP CONSTRAINT IF EXISTS funded_shadow_gate_policy_stage_b_check;
ALTER TABLE funded_shadow_gate_policy
  ADD CONSTRAINT funded_shadow_gate_policy_stage_b_check CHECK(
    jsonb_typeof(stage_b_approval) = 'object' AND
    stage_b_approval ?& array[
      'approvalRef','approvedAt','approvedBy','mMarket','referenceSessionCount',
      'referenceSessionDigest','referenceWindowStart','referenceWindowEnd',
      'referenceEvidenceCutoffAt'
    ] AND
    jsonb_typeof(stage_b_approval->'referenceSessionCount') = 'number' AND
    jsonb_typeof(stage_b_approval->'mMarket') = 'number' AND
    COALESCE((stage_b_approval->>'referenceSessionCount')::int, 0) >= 40 AND
    COALESCE((stage_b_approval->>'mMarket')::numeric, 0) > 0
  );

ALTER TABLE funded_shadow_gate_policy
  DROP CONSTRAINT IF EXISTS funded_shadow_gate_policy_window_check;
ALTER TABLE funded_shadow_gate_policy
  ADD CONSTRAINT funded_shadow_gate_policy_window_check CHECK(
    jsonb_typeof(gate_window) = 'object' AND
    gate_window ?& array[
      'minDecisions','minSessions','horizonSessions','horizonDays'
    ] AND
    jsonb_typeof(gate_window->'minDecisions') = 'number' AND
    jsonb_typeof(gate_window->'minSessions') = 'number' AND
    jsonb_typeof(gate_window->'horizonSessions') = 'number' AND
    jsonb_typeof(gate_window->'horizonDays') = 'number' AND
    COALESCE((gate_window->>'minDecisions')::int, 0) >= 40 AND
    COALESCE((gate_window->>'minSessions')::int, 0) >= 20 AND
    COALESCE((gate_window->>'horizonSessions')::int, 0) >= 40 AND
    COALESCE((gate_window->>'horizonDays')::int, 0) >= 90
  );

-- ============================================================================
-- Report: NULL-safe no-authority marker
-- ============================================================================
ALTER TABLE funded_shadow_report
  DROP CONSTRAINT IF EXISTS funded_shadow_report_no_authority_check;
ALTER TABLE funded_shadow_report
  ADD CONSTRAINT funded_shadow_report_no_authority_check CHECK(
    jsonb_typeof(report) = 'object' AND
    (report->>'promotionAuthorized') IS NOT DISTINCT FROM 'false' AND
    (report->>'authorityEffect') IS NOT DISTINCT FROM 'NONE'
  );

-- ============================================================================
-- Projection ownership: bind market/currency to the batch
-- ============================================================================
ALTER TABLE funded_shadow_batch_projection
  DROP CONSTRAINT IF EXISTS funded_shadow_batch_projection_batch_ownership_fk;
ALTER TABLE funded_shadow_batch_projection
  ADD CONSTRAINT funded_shadow_batch_projection_batch_ownership_fk
  FOREIGN KEY (batch_id, market_id, currency)
  REFERENCES funded_shadow_batch(id, market_id, currency);

-- ============================================================================
-- Attempt validation: batch/enrollment/run cross-check
-- ============================================================================
CREATE OR REPLACE FUNCTION funded_shadow_attempt_validate()
RETURNS trigger AS $$
DECLARE
  lag_ms INTEGER;
  enrollment_effective TIMESTAMPTZ;
  batch_decision TIMESTAMPTZ;
  batch_enrollment UUID;
  batch_run UUID;
  decision_matches INTEGER;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT p.max_prediction_lag_ms, e.effective_from
    INTO lag_ms, enrollment_effective
    FROM funded_shadow_enrollment e
    JOIN funded_shadow_gate_policy p ON p.id = e.gate_policy_id
   WHERE e.id = NEW.enrollment_id;
  IF lag_ms IS NULL THEN
    RAISE EXCEPTION 'A funded shadow attempt requires an enrolled gate policy';
  END IF;
  -- The database owns the deadline; a caller-supplied value is ignored.
  NEW.deadline_at := NEW.decision_at + (lag_ms * interval '1 millisecond');
  SELECT b.decision_at, b.enrollment_id, b.run_id
    INTO batch_decision, batch_enrollment, batch_run
    FROM funded_shadow_batch b
   WHERE b.id = NEW.batch_id;
  IF batch_decision IS NULL OR batch_decision <> NEW.decision_at THEN
    RAISE EXCEPTION 'A funded shadow attempt must share its batch decision clock';
  END IF;
  IF batch_enrollment <> NEW.enrollment_id OR batch_run <> NEW.run_id THEN
    RAISE EXCEPTION 'A funded shadow attempt must belong to its batch enrollment and run';
  END IF;
  IF NEW.decision_at < enrollment_effective THEN
    RAISE EXCEPTION 'A funded shadow attempt decision precedes its enrollment';
  END IF;
  IF NEW.decision_sequence IS NOT NULL THEN
    SELECT count(*) INTO decision_matches
      FROM funded_decision_evidence d
     WHERE d.run_id = NEW.run_id
       AND d.observation_id = NEW.observation_id
       AND d.sequence = NEW.decision_sequence
       AND d.content_digest = NEW.decision_input_digest
       AND d.market_id = NEW.market_id
       AND d.currency = NEW.currency;
    IF decision_matches = 0 THEN
      RAISE EXCEPTION 'A funded shadow attempt must bind a durable champion decision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Member validation: identical re-seal is a no-op; projected batches stay closed
-- ============================================================================
CREATE OR REPLACE FUNCTION funded_shadow_batch_member_validate()
RETURNS trigger AS $$
DECLARE
  batch_decision TIMESTAMPTZ;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT b.decision_at INTO batch_decision
    FROM funded_shadow_batch b
   WHERE b.id = NEW.batch_id;
  IF batch_decision IS NULL THEN
    RAISE EXCEPTION 'A funded shadow member requires its batch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM funded_shadow_batch_member m
     WHERE m.batch_id = NEW.batch_id
       AND m.observation_id = NEW.observation_id
       AND m.attempt_id = NEW.attempt_id
  ) THEN
    -- An exact member re-seal is a no-op, including on a projected batch.
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM funded_shadow_batch_projection p WHERE p.batch_id = NEW.batch_id
  ) THEN
    RAISE EXCEPTION 'A projected funded shadow batch is closed to new members';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Projection validation: planned closure rule with the durable seal grace
-- ============================================================================
CREATE OR REPLACE FUNCTION funded_shadow_batch_projection_validate()
RETURNS trigger AS $$
DECLARE
  lag_ms INTEGER;
  batch_decision TIMESTAMPTZ;
  batch_sealed TIMESTAMPTZ;
  closed_at TIMESTAMPTZ;
  member_count INTEGER;
  terminal_count INTEGER;
  ordered_count INTEGER;
  distinct_count INTEGER;
  missing_attempt INTEGER;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT p.max_prediction_lag_ms, b.decision_at, b.sealed_at
    INTO lag_ms, batch_decision, batch_sealed
    FROM funded_shadow_batch b
    JOIN funded_shadow_enrollment e ON e.id = b.enrollment_id
    JOIN funded_shadow_gate_policy p ON p.id = e.gate_policy_id
   WHERE b.id = NEW.batch_id;
  IF batch_decision IS NULL THEN
    RAISE EXCEPTION 'A funded shadow projection requires its batch';
  END IF;
  closed_at := GREATEST(
    batch_decision + (lag_ms * interval '1 millisecond'),
    batch_sealed + interval '5000 milliseconds'
  );
  IF clock_timestamp() < closed_at THEN
    RAISE EXCEPTION 'A funded shadow batch cannot be projected before it closes';
  END IF;
  SELECT count(*) INTO member_count
    FROM funded_shadow_batch_member m WHERE m.batch_id = NEW.batch_id;
  SELECT count(*) INTO terminal_count
    FROM funded_shadow_batch_member m
    JOIN funded_shadow_attempt_result r ON r.attempt_id = m.attempt_id
   WHERE m.batch_id = NEW.batch_id;
  IF member_count = 0 OR terminal_count <> member_count THEN
    RAISE EXCEPTION 'A funded shadow projection requires a terminal result for every member';
  END IF;
  SELECT count(*) INTO ordered_count
    FROM unnest(NEW.ordered_attempt_ids) AS id;
  SELECT count(DISTINCT id) INTO distinct_count
    FROM unnest(NEW.ordered_attempt_ids) AS id;
  IF ordered_count <> member_count OR distinct_count <> member_count THEN
    RAISE EXCEPTION 'A funded shadow projection must order every member exactly once';
  END IF;
  SELECT 1 INTO missing_attempt
    FROM unnest(NEW.ordered_attempt_ids) AS id
   WHERE NOT EXISTS (
     SELECT 1 FROM funded_shadow_batch_member m
      WHERE m.batch_id = NEW.batch_id AND m.attempt_id = id
   )
   LIMIT 1;
  IF missing_attempt IS NOT NULL THEN
    RAISE EXCEPTION 'A funded shadow projection contains a foreign attempt';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Label validation: a label requires its terminal attempt result
-- ============================================================================
CREATE OR REPLACE FUNCTION funded_shadow_label_validate()
RETURNS trigger AS $$
DECLARE
  attempt RECORD;
  run_status TEXT;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT * INTO attempt FROM funded_shadow_attempt WHERE id = NEW.attempt_id;
  IF attempt.id IS NULL THEN
    RAISE EXCEPTION 'A funded shadow label requires its attempt';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM funded_shadow_attempt_result r
     WHERE r.attempt_id = NEW.attempt_id
  ) THEN
    RAISE EXCEPTION 'A funded shadow label requires its terminal attempt result';
  END IF;
  IF NEW.enrollment_id <> attempt.enrollment_id
     OR NEW.market_id <> attempt.market_id
     OR NEW.currency <> attempt.currency THEN
    RAISE EXCEPTION 'A funded shadow label must match its attempt ownership';
  END IF;
  IF NEW.label_available_at IS NOT NULL
     AND NEW.label_available_at > NEW.recorded_at THEN
    RAISE EXCEPTION 'A funded shadow label cannot be available in the future';
  END IF;
  IF NEW.status <> 'UNRESOLVED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM paper_execution e
       WHERE e.id = NEW.evidence_execution_id
         AND e.observation_id = attempt.observation_id
         AND e.model = 'QUOTE'
         AND e.status = 'CLOSED'
         AND e.r_multiple IS NOT NULL
         AND date_trunc('milliseconds', e.exit_time) = NEW.label_available_at
    ) THEN
      RAISE EXCEPTION 'A resolved funded shadow label requires its independent canonical outcome';
    END IF;
  ELSE
    SELECT r.status INTO run_status
      FROM paper_bot_run r WHERE r.id = attempt.run_id;
    IF run_status IS DISTINCT FROM 'COMPLETED' THEN
      RAISE EXCEPTION 'An unresolved funded shadow label requires a completed run';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Schema version
-- ============================================================================
INSERT INTO foundation_schema_version (version, description)
VALUES (137, 'Funded shadow observation boundary hardening')
ON CONFLICT (version) DO NOTHING;
