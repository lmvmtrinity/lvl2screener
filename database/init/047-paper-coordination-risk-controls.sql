-- Phase 5 coordinated-portfolio entry suppressions. Existing decisions stay
-- immutable; this only widens the stable reason-code vocabulary for new rows.
ALTER TABLE paper_coordination_decision
  DROP CONSTRAINT IF EXISTS paper_coordination_decision_reason_check;
ALTER TABLE paper_coordination_decision
  ADD CONSTRAINT paper_coordination_decision_reason_check CHECK (reason IN (
    'SELECTED_PRIMARY','NO_FEASIBLE_CANDIDATE','SYMBOL_POSITION_OPEN',
    'POST_STOP_COOLDOWN','NON_PRIMARY_CANDIDATE','MAX_CONCURRENT_POSITIONS',
    'PORTFOLIO_RISK_LIMIT','DAILY_LOSS_LIMIT','CONSECUTIVE_STOP_LIMIT'
  ));

INSERT INTO foundation_schema_version(version, description)
VALUES(47, 'Coordinated paper portfolio circuit-breaker decisions')
ON CONFLICT(version) DO NOTHING;
