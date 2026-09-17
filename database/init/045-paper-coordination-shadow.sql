-- Shadow-only coordinated portfolio decisions. These rows are intentionally
-- separate from paper_execution: per-strategy execution remains the unbiased
-- evidence projection, while this table explains what a cooperating portfolio
-- would have selected from the same candidate batch.
CREATE TABLE IF NOT EXISTS paper_coordination_decision (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES paper_bot_run(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  decision_timestamp TIMESTAMPTZ NOT NULL,
  trigger_observation_ids JSONB NOT NULL,
  candidate_snapshot JSONB NOT NULL,
  selected_observation_id UUID REFERENCES paper_signal_observation(id) ON DELETE SET NULL,
  selected_strategy_key TEXT,
  confirmation_observation_ids JSONB NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('APPROVED','REJECTED')),
  reason TEXT NOT NULL CHECK (reason IN (
    'SELECTED_PRIMARY','NO_FEASIBLE_CANDIDATE','SYMBOL_POSITION_OPEN',
    'POST_STOP_COOLDOWN','NON_PRIMARY_CANDIDATE'
  )),
  policy_version TEXT NOT NULL,
  state_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(trigger_observation_ids) = 'array'),
  CHECK (jsonb_typeof(candidate_snapshot) = 'array'),
  CHECK (jsonb_typeof(confirmation_observation_ids) = 'array'),
  CHECK (jsonb_typeof(state_snapshot) = 'object'),
  CHECK (
    (outcome = 'APPROVED' AND selected_observation_id IS NOT NULL AND selected_strategy_key IS NOT NULL)
    OR
    (outcome = 'REJECTED' AND selected_observation_id IS NULL AND selected_strategy_key IS NULL)
  ),
  UNIQUE(run_id, symbol, decision_timestamp)
);

CREATE INDEX IF NOT EXISTS paper_coordination_decision_run_symbol_idx
  ON paper_coordination_decision(run_id, symbol, decision_timestamp DESC);

CREATE OR REPLACE FUNCTION paper_coordination_decision_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'paper_coordination_decision rows are immutable; insert a new decision instead of updating id=%', OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_coordination_decision_immutable ON paper_coordination_decision;
CREATE TRIGGER paper_coordination_decision_immutable
BEFORE UPDATE ON paper_coordination_decision
FOR EACH ROW EXECUTE FUNCTION paper_coordination_decision_reject_update();

INSERT INTO foundation_schema_version(version, description)
VALUES(45, 'Immutable paper coordination shadow decisions')
ON CONFLICT(version) DO NOTHING;
