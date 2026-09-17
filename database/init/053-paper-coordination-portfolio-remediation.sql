-- A coordinated shadow portfolio is an account boundary. Runs remain immutable
-- evidence cohorts and must never scope exposure or lifecycle ownership.
CREATE TABLE IF NOT EXISTS paper_portfolio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('SHADOW')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO paper_portfolio(key,mode,status)
VALUES('COORDINATED_SHADOW','SHADOW','ACTIVE')
ON CONFLICT(key) DO NOTHING;

ALTER TABLE paper_coordination_decision
  ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES paper_portfolio(id);

-- Decision rows are immutable to application code. Temporarily remove and
-- restore the trigger solely for this idempotent ownership backfill.
DROP TRIGGER IF EXISTS paper_coordination_decision_immutable ON paper_coordination_decision;
UPDATE paper_coordination_decision
SET portfolio_id=(SELECT id FROM paper_portfolio WHERE key='COORDINATED_SHADOW')
WHERE portfolio_id IS NULL;
CREATE TRIGGER paper_coordination_decision_immutable
BEFORE UPDATE ON paper_coordination_decision
FOR EACH ROW EXECUTE FUNCTION paper_coordination_decision_reject_update();

ALTER TABLE paper_coordination_decision
  ALTER COLUMN portfolio_id SET NOT NULL;

ALTER TABLE paper_coordination_decision
  DROP CONSTRAINT IF EXISTS paper_coordination_decision_reason_check;
ALTER TABLE paper_coordination_decision
  ADD CONSTRAINT paper_coordination_decision_reason_check CHECK (reason IN (
    'SELECTED_PRIMARY','NO_FEASIBLE_CANDIDATE','SYMBOL_POSITION_OPEN',
    'POST_STOP_COOLDOWN','NON_PRIMARY_CANDIDATE','MAX_CONCURRENT_POSITIONS',
    'PORTFOLIO_RISK_LIMIT','PORTFOLIO_RECONCILIATION_REQUIRED',
    'DAILY_LOSS_LIMIT','CONSECUTIVE_STOP_LIMIT','SYMBOL_EXPOSURE_LIMIT',
    'SECTOR_EXPOSURE_LIMIT','CONTEXT_UNAVAILABLE','CONTEXT_STALE',
    'SECTOR_CONTEXT_UNAVAILABLE','SECTOR_CONTEXT_STALE','CONTEXT_VETO'
  ));

ALTER TABLE paper_coordination_position
  ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES paper_portfolio(id),
  ADD COLUMN IF NOT EXISTS session_date DATE,
  ADD COLUMN IF NOT EXISTS recovery_source TEXT,
  ADD COLUMN IF NOT EXISTS recovery_boundary TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_fact_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_delay_ms BIGINT;

UPDATE paper_coordination_position p
SET portfolio_id=d.portfolio_id,
    session_date=r.session_date
FROM paper_coordination_decision d
JOIN paper_bot_run r ON r.id=d.run_id
WHERE d.id=p.decision_id
  AND (p.portfolio_id IS NULL OR p.session_date IS NULL);

ALTER TABLE paper_coordination_position
  ALTER COLUMN portfolio_id SET NOT NULL,
  ALTER COLUMN session_date SET NOT NULL;

ALTER TABLE paper_coordination_position
  DROP CONSTRAINT IF EXISTS paper_coordination_position_recovery_delay_check;
ALTER TABLE paper_coordination_position
  ADD CONSTRAINT paper_coordination_position_recovery_delay_check
  CHECK (recovery_delay_ms IS NULL OR recovery_delay_ms >= 0);

DROP INDEX IF EXISTS paper_coordination_position_one_open_symbol_idx;
CREATE UNIQUE INDEX IF NOT EXISTS paper_coordination_position_one_open_symbol_idx
  ON paper_coordination_position(portfolio_id,symbol)
  WHERE status IN ('OPEN','CLOSE_PENDING');

CREATE INDEX IF NOT EXISTS paper_coordination_position_portfolio_session_idx
  ON paper_coordination_position(portfolio_id,session_date,status,created_at);

ALTER TABLE quote_snapshot
  DROP CONSTRAINT IF EXISTS quote_snapshot_size_unit_check;
ALTER TABLE quote_snapshot
  ADD CONSTRAINT quote_snapshot_size_unit_check
  CHECK (size_unit IS NULL OR size_unit IN ('SHARES','BOARD_LOTS','UNKNOWN'));

INSERT INTO foundation_schema_version(version, description)
VALUES(53, 'Durable coordinated portfolio identity and close-recovery provenance')
ON CONFLICT(version) DO NOTHING;
