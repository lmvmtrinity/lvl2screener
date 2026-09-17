-- Phases 4 and 5 of docs/paper-bot-performance-improvement-plan.md: the
-- coordinator now records symbol/sector exposure suppressions, market and
-- sector context vetoes, and distinguishes a suppression that can clear later
-- in the session (DEFERRED) from a judgment about this candidate batch
-- (REJECTED). Existing rows keep the outcome and reason they were written
-- with; only the permitted vocabulary widens.

ALTER TABLE paper_coordination_decision
  ADD COLUMN IF NOT EXISTS context_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE paper_coordination_decision
  DROP CONSTRAINT IF EXISTS paper_coordination_decision_context_snapshot_check;
ALTER TABLE paper_coordination_decision
  ADD CONSTRAINT paper_coordination_decision_context_snapshot_check
  CHECK (jsonb_typeof(context_snapshot) = 'array');

ALTER TABLE paper_coordination_decision
  DROP CONSTRAINT IF EXISTS paper_coordination_decision_outcome_check;
ALTER TABLE paper_coordination_decision
  ADD CONSTRAINT paper_coordination_decision_outcome_check
  CHECK (outcome IN ('APPROVED','REJECTED','DEFERRED'));

ALTER TABLE paper_coordination_decision
  DROP CONSTRAINT IF EXISTS paper_coordination_decision_reason_check;
ALTER TABLE paper_coordination_decision
  ADD CONSTRAINT paper_coordination_decision_reason_check CHECK (reason IN (
    'SELECTED_PRIMARY','NO_FEASIBLE_CANDIDATE','SYMBOL_POSITION_OPEN',
    'POST_STOP_COOLDOWN','NON_PRIMARY_CANDIDATE','MAX_CONCURRENT_POSITIONS',
    'PORTFOLIO_RISK_LIMIT','DAILY_LOSS_LIMIT','CONSECUTIVE_STOP_LIMIT',
    'SYMBOL_EXPOSURE_LIMIT','SECTOR_EXPOSURE_LIMIT',
    'CONTEXT_UNAVAILABLE','CONTEXT_STALE','CONTEXT_VETO'
  ));

-- The selection invariant is about approval, not about rejection wording: a
-- deferred decision selects nothing, exactly like a rejected one.
DO $$
DECLARE target_constraint TEXT;
BEGIN
  FOR target_constraint IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'paper_coordination_decision' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%selected_observation_id IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE paper_coordination_decision DROP CONSTRAINT %I', target_constraint);
  END LOOP;
END $$;

ALTER TABLE paper_coordination_decision
  ADD CONSTRAINT paper_coordination_decision_selection_check CHECK (
    (outcome = 'APPROVED'
      AND selected_observation_id IS NOT NULL AND selected_strategy_key IS NOT NULL)
    OR
    (outcome IN ('REJECTED','DEFERRED')
      AND selected_observation_id IS NULL AND selected_strategy_key IS NULL)
  );

INSERT INTO foundation_schema_version(version, description)
VALUES(50, 'Coordinated paper context, exposure, and deferred decisions')
ON CONFLICT(version) DO NOTHING;
