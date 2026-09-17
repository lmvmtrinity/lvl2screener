-- W8: durable, resumable research execution.
--
-- Backtests, calibrations, ranking studies, and statistical training used to run synchronously
-- inside the HTTP request that created them (see backtest-service.ts / calibration-service.ts /
-- etc.), holding the connection open for the full run and leaving the *_run row stuck in
-- RUNNING/TRAINING forever if the process died mid-run (patched around in W6 by
-- reconcile-orphaned-research.ts, a boot-time stopgap).
--
-- research_job is the durable queue that replaces the synchronous request/response cycle:
--   - POST handlers insert a QUEUED row and return 202 immediately.
--   - A worker process (apps/api/src/worker.ts) claims rows with FOR UPDATE SKIP LOCKED and holds
--     a time-boxed lease, renewed by heartbeat while it works; a lease that expires without a
--     heartbeat (worker crash) becomes claimable again by any worker.
--   - Progress, cancellation requests, attempt counts, and a coarse error category are persisted
--     so the UI can poll/cancel a run and an operator can see why an attempt failed without
--     grepping logs.
--   - result_ref_id points at the row in the existing backtest_run/calibration_run/
--     ranking_research_run/statistical_model table once the job finishes; those tables and their
--     synchronous creation code paths are unchanged, so this is additive.

CREATE TABLE IF NOT EXISTS research_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL
    CHECK (job_type IN ('BACKTEST', 'CALIBRATION', 'RANKING_RESEARCH', 'STATISTICAL_TRAINING')),
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN (
      'QUEUED', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'
    )),
  idempotency_key TEXT,
  request_payload JSONB NOT NULL,
  result_ref_id UUID,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  error_category TEXT
    CHECK (error_category IS NULL OR error_category IN (
      'VALIDATION', 'HISTORY_UNAVAILABLE', 'UPSTREAM_ENGINE', 'CANCELLED', 'LEASE_EXPIRED', 'UNKNOWN'
    )),
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  -- A duplicate Idempotency-Key for the same job type must return the original job rather than
  -- creating a second one; NULL keys (no header sent) are exempt from the uniqueness constraint.
  CONSTRAINT research_job_idempotency_key_unique UNIQUE (job_type, idempotency_key)
);

-- Claim queries filter on job_type + status and order by created_at; a partial index keeps the
-- claim scan cheap as the table accumulates terminal rows over time.
CREATE INDEX IF NOT EXISTS research_job_claimable_idx
  ON research_job (job_type, created_at)
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX IF NOT EXISTS research_job_result_ref_idx ON research_job (result_ref_id);
