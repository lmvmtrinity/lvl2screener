-- NULL preserves unknown policy for pre-migration funded evidence.
ALTER TABLE paper_funded_run ADD COLUMN policy JSONB;
ALTER TABLE paper_funded_run ADD COLUMN clock_at TIMESTAMPTZ;
ALTER TABLE paper_funded_run ADD CONSTRAINT paper_funded_policy_object
  CHECK (policy IS NULL OR jsonb_typeof(policy) = 'object');

CREATE FUNCTION protect_funded_run_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'COMPLETED' AND EXISTS (
    SELECT 1 FROM paper_entry_order o JOIN paper_funded_run b ON b.run_id=o.run_id
    WHERE o.run_id=NEW.id AND (o.state->>'status'='PENDING'
      OR o.state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING'))
  ) THEN
    RAISE EXCEPTION 'Funded run has unresolved orders or positions';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_funded_run_completion BEFORE UPDATE OF status ON paper_bot_run
  FOR EACH ROW EXECUTE FUNCTION protect_funded_run_completion();
