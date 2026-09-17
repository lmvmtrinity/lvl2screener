-- Qualification must cite the exact profile configuration and strategy that
-- produced it. Existing rows are deliberately not backfilled: matching old
-- parameter JSON cannot establish that historical provenance.
CREATE TABLE IF NOT EXISTS profile_config_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_config_id UUID NOT NULL REFERENCES scanner_profile_config(id) ON DELETE CASCADE,
  strategy_definition_id UUID NOT NULL REFERENCES strategy_definition(id),
  strategy_key TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  backtest_run_id UUID NOT NULL REFERENCES backtest_run(id) ON DELETE CASCADE,
  qualification TEXT NOT NULL CHECK (qualification IN ('EXPLORATORY','EVIDENCE_QUALIFIED')),
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE(profile_config_id, backtest_run_id, strategy_key, strategy_version)
);
CREATE INDEX IF NOT EXISTS profile_config_evidence_current_idx
  ON profile_config_evidence(profile_config_id, qualification, created_at DESC)
  WHERE revoked_at IS NULL;

INSERT INTO foundation_schema_version (version, description)
VALUES (24, 'Exact profile configuration evidence provenance')
ON CONFLICT (version) DO NOTHING;
