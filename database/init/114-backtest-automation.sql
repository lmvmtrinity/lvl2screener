-- A1 backtest automation: durable control state, one work registry row per
-- immutable profile configuration, append-only cycle receipts, and a job
-- priority column so explicit requests can outrank scheduled catch-up while
-- still preserving FIFO within a class. The work identity is the computation
-- key; trigger origin and input fingerprint are recorded separately so
-- duplicate triggers coalesce and late-arriving inputs reopen the same item.

CREATE TABLE IF NOT EXISTS backtest_automation_control (
  market_id TEXT PRIMARY KEY CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cadence TEXT NOT NULL DEFAULT 'DAILY_POST_SESSION'
    CHECK (cadence IN ('DAILY_POST_SESSION')),
  max_outstanding INTEGER NOT NULL DEFAULT 2
    CHECK (max_outstanding BETWEEN 0 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS backtest_automation_work (
  work_key TEXT PRIMARY KEY CHECK (work_key ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  kind TEXT NOT NULL CHECK (kind IN ('PROFILE_QUALIFICATION')),
  config_id UUID NOT NULL,
  config_version TEXT NOT NULL,
  strategy_key TEXT NOT NULL,
  identity JSONB NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('WAITING','BLOCKED','QUEUED','RUNNING','SUCCEEDED','RETRY_SCHEDULED','FAILED','CANCELLED')
  ),
  trigger_origin TEXT NOT NULL CHECK (
    trigger_origin IN ('PROFILE_SAVE','SCHEDULED_CATCH_UP','REFRESH_NOW','EXPLICIT_EXPERIMENT')
  ),
  attempt_key TEXT NOT NULL CHECK (attempt_key ~ '^[a-f0-9]{64}$'),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  dispatched_fingerprint TEXT CHECK (dispatched_fingerprint ~ '^[a-f0-9]{64}$'),
  consumed_fingerprint TEXT CHECK (consumed_fingerprint ~ '^[a-f0-9]{64}$'),
  blocker_reason TEXT CHECK (
    blocker_reason IN ('NO_CAPTURED_HISTORY','HISTORY_RANGE_UNAVAILABLE','POLICY_VIOLATION','CAPACITY_LIMIT')
  ),
  job_id UUID REFERENCES research_job(id),
  run_id UUID,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  failure_message TEXT,
  last_dispatched_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS backtest_automation_work_market_idx
  ON backtest_automation_work(market_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS backtest_automation_cycle (
  cycle_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  trigger_origin TEXT NOT NULL CHECK (
    trigger_origin IN ('PROFILE_SAVE','SCHEDULED_CATCH_UP','REFRESH_NOW','EXPLICIT_EXPERIMENT')
  ),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('CHANGED','NO_CHANGES','BLOCKED','DISABLED','FAILED')
  ),
  evaluated INTEGER NOT NULL DEFAULT 0 CHECK (evaluated >= 0),
  dispatched INTEGER NOT NULL DEFAULT 0 CHECK (dispatched >= 0),
  coalesced INTEGER NOT NULL DEFAULT 0 CHECK (coalesced >= 0),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked >= 0),
  retried INTEGER NOT NULL DEFAULT 0 CHECK (retried >= 0),
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS backtest_automation_cycle_market_idx
  ON backtest_automation_cycle(market_id, started_at DESC);

-- Explicit (requested/experimental) work above scheduled work; the claim
-- ordering also ages jobs so a stream of new requests cannot starve scheduled
-- work permanently.
ALTER TABLE research_job
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

INSERT INTO foundation_schema_version(version, description)
VALUES(114, 'Backtest automation work registry, cycle receipts and job priority')
ON CONFLICT (version) DO NOTHING;
