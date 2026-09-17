DO $$
DECLARE guard_name TEXT;
DECLARE definition TEXT;
BEGIN
  FOREACH guard_name IN ARRAY ARRAY[
    'require_authoritative_statistical_evidence',
    'require_authoritative_profile_evidence',
    'require_authoritative_calibration_source',
    'require_authoritative_ranking_study',
    'require_ranking_activation_evidence'
  ] LOOP
    SELECT pg_get_functiondef(oid) INTO STRICT definition
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=guard_name;
    EXECUTE replace(definition, 'paper-execution-v1', 'paper-execution-v7');
  END LOOP;
END $$;

ALTER TABLE paper_execution ADD COLUMN IF NOT EXISTS execution_state JSONB;

CREATE TABLE IF NOT EXISTS paper_evidence_regeneration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id UUID NOT NULL REFERENCES paper_bot_run(id),
  replacement_run_id UUID NOT NULL UNIQUE REFERENCES paper_bot_run(id),
  request_digest TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode='FILL_ONLY'),
  input_digest TEXT NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
