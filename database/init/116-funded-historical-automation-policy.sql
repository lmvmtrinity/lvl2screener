-- A3 funded replay automation policy. A policy is an explicit, auditable user
-- approval for one experiment scope; it freezes the dedicated historical replay
-- account identity (derived from policy_hash) and the per-job session bound.
-- Live funded accounts, promotion and any write outside an active policy remain
-- out of scope. Revocation is additive; approval fields are immutable.

CREATE TABLE IF NOT EXISTS funded_historical_automation_policy (
  policy_id UUID PRIMARY KEY,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  scope JSONB NOT NULL,
  max_sessions INTEGER NOT NULL CHECK (max_sessions BETWEEN 1 AND 60),
  approved_by TEXT NOT NULL,
  approval_note TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > approved_at),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS funded_historical_automation_policy_hash_idx
  ON funded_historical_automation_policy(policy_hash);
CREATE INDEX IF NOT EXISTS funded_historical_automation_policy_market_idx
  ON funded_historical_automation_policy(market_id, expires_at DESC);

ALTER TABLE research_job DROP CONSTRAINT IF EXISTS research_job_job_type_check;
ALTER TABLE research_job ADD CONSTRAINT research_job_job_type_check
  CHECK (job_type IN ('BACKTEST', 'CALIBRATION', 'RANKING_RESEARCH', 'STATISTICAL_TRAINING', 'COVERAGE_VERIFICATION', 'STRATEGY_STUDY', 'EXECUTION_DIAGNOSTICS', 'FUNDED_HISTORICAL_REPLAY'));

INSERT INTO foundation_schema_version(version, description)
VALUES(116, 'Funded historical replay automation policy')
ON CONFLICT (version) DO NOTHING;
