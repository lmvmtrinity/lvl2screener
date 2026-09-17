-- 055-model-informed-coordination.sql
-- Model-Informed Coordinated Paper Portfolio (docs/model-informed-coordination-plan.md)
--
-- 1. Adds shadow_decision to paper_coordination_decision for v4 shadow ranking.
-- 2. Widens paper_coordination_decision.reason check constraint to include PREDICTED_LOW_EXPECTANCY.
-- 3. Adds append-only learning_automation_run for durable scheduler check history.

ALTER TABLE paper_coordination_decision
  ADD COLUMN IF NOT EXISTS shadow_decision JSONB DEFAULT NULL;

ALTER TABLE paper_coordination_decision
  DROP CONSTRAINT IF EXISTS paper_coordination_decision_reason_check;
ALTER TABLE paper_coordination_decision
  ADD CONSTRAINT paper_coordination_decision_reason_check CHECK (reason IN (
    'SELECTED_PRIMARY','NO_FEASIBLE_CANDIDATE','SYMBOL_POSITION_OPEN',
    'POST_STOP_COOLDOWN','NON_PRIMARY_CANDIDATE','MAX_CONCURRENT_POSITIONS',
    'PORTFOLIO_RISK_LIMIT','PORTFOLIO_RECONCILIATION_REQUIRED',
    'DAILY_LOSS_LIMIT','CONSECUTIVE_STOP_LIMIT','SYMBOL_EXPOSURE_LIMIT',
    'SECTOR_EXPOSURE_LIMIT','CONTEXT_UNAVAILABLE','CONTEXT_STALE',
    'SECTOR_CONTEXT_UNAVAILABLE','SECTOR_CONTEXT_STALE','CONTEXT_VETO',
    'PREDICTED_LOW_EXPECTANCY'
  ));

CREATE TABLE IF NOT EXISTS learning_automation_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduler_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('SUCCESS','NOOP','FAILED')),
  cohorts_examined JSONB NOT NULL DEFAULT '[]'::jsonb,
  noop_reason TEXT,
  created_dataset_id UUID REFERENCES statistical_training_dataset(id) ON DELETE SET NULL,
  created_job_id UUID REFERENCES research_job(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(cohorts_examined) = 'array')
);

CREATE INDEX IF NOT EXISTS learning_automation_run_created_at_idx
  ON learning_automation_run(created_at DESC);

INSERT INTO foundation_schema_version(version, description)
VALUES(55, 'Model-informed coordination shadow decisions and learning automation history')
ON CONFLICT(version) DO NOTHING;
