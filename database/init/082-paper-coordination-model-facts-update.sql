-- 082-paper-coordination-model-facts-update.sql
-- Allow updating candidate_snapshot and shadow_decision on paper_coordination_decision
-- for asynchronous model-informed coordination facts, while ensuring all deterministic
-- decision fields remain strictly immutable.

CREATE OR REPLACE FUNCTION paper_coordination_decision_reject_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.run_id IS NOT DISTINCT FROM OLD.run_id
     AND NEW.symbol IS NOT DISTINCT FROM OLD.symbol
     AND NEW.decision_timestamp IS NOT DISTINCT FROM OLD.decision_timestamp
     AND NEW.trigger_observation_ids IS NOT DISTINCT FROM OLD.trigger_observation_ids
     AND NEW.selected_observation_id IS NOT DISTINCT FROM OLD.selected_observation_id
     AND NEW.selected_strategy_key IS NOT DISTINCT FROM OLD.selected_strategy_key
     AND NEW.confirmation_observation_ids IS NOT DISTINCT FROM OLD.confirmation_observation_ids
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.policy_version IS NOT DISTINCT FROM OLD.policy_version
     AND NEW.state_snapshot IS NOT DISTINCT FROM OLD.state_snapshot
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.context_snapshot IS NOT DISTINCT FROM OLD.context_snapshot
     AND NEW.portfolio_id IS NOT DISTINCT FROM OLD.portfolio_id
     AND NEW.market_id IS NOT DISTINCT FROM OLD.market_id THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'paper_coordination_decision rows are immutable; insert a new decision instead of updating id=%', OLD.id;
END;
$$ LANGUAGE plpgsql;

INSERT INTO foundation_schema_version(version, description)
VALUES(82, 'Permit asynchronous model fact updates on paper coordination decisions')
ON CONFLICT(version) DO NOTHING;
