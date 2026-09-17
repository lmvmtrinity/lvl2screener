-- Phase 1 of private development record (see ADR-009). Adds a dedicated,
-- immutable paper-bot schema: automated forward/backtest execution evidence
-- lives here, never in journal_trade, and carries no foreign key to
-- strategy_state_event or strategy_signal so normal scanner retention can
-- prune those tables independently of accumulated paper evidence.
--
-- Naming/judgment notes (see task report for the full list):
-- * A persisted "READY setup event" is strategy_state_event.new_state='READY'.
--   source_event_id references strategy_state_event.id and source_signal_id
--   references strategy_signal.id (via strategy_state_event.signal_id) as
--   plain UUID columns -- intentionally not foreign keys.
-- * profile_id/profile_config_id keep real foreign keys to scanner_profile /
--   scanner_profile_config because those configuration rows are not subject
--   to scanner retention; the immutable "snapshot" requirement is satisfied by
--   also storing denormalized profile_name/config_version/profile_parameters
--   text/JSONB columns so the observation still reads correctly even if the
--   configuration row is later edited.
-- * Assumption/feature JSONB keys use camelCase to match the convention
--   already used for scanner_profile_config.parameters and the TypeScript API
--   layer (see apps/api/src/backtests/backtest-repository.ts).

CREATE TABLE IF NOT EXISTS paper_bot_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('LIVE','BACKTEST')),
  session_date DATE NOT NULL,
  session_timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  scheduled_close_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','CLOSE_PENDING','COMPLETED','FAILED')),
  execution_model_version TEXT NOT NULL,
  assumptions JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(assumptions) = 'object'),
  CHECK (assumptions ?& ARRAY[
    'positionSize','slippageBps','feePerTrade','stopMethod','atrStopMultiple',
    'maxQuoteAgeSeconds','sessionTimezone','noonCloseTime'
  ]),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL),
  CHECK (status <> 'FAILED' OR (failed_at IS NOT NULL AND failure_reason IS NOT NULL))
);

-- Only one LIVE run may exist per session date and execution model version so
-- a restarting live processor (Phase 3) resumes it instead of creating a
-- duplicate. BACKTEST runs carry no such constraint since replaying the same
-- session under the same model version repeatedly is expected.
CREATE UNIQUE INDEX IF NOT EXISTS paper_bot_run_live_session_uq
  ON paper_bot_run(session_date, execution_model_version)
  WHERE source = 'LIVE';

CREATE INDEX IF NOT EXISTS paper_bot_run_status_idx ON paper_bot_run(status);

CREATE TABLE IF NOT EXISTS paper_signal_observation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES paper_bot_run(id) ON DELETE CASCADE,

  -- Plain identifiers into strategy_state_event / strategy_signal -- NOT
  -- foreign keys, so scanner retention can prune those tables freely.
  source_event_id UUID NOT NULL,
  source_signal_id UUID,
  setup_instance_id UUID,

  instrument_id UUID NOT NULL REFERENCES instrument(id),
  symbol TEXT NOT NULL,

  profile_id UUID NOT NULL REFERENCES scanner_profile(id),
  profile_name TEXT NOT NULL,
  profile_config_id UUID NOT NULL REFERENCES scanner_profile_config(id),
  config_version TEXT NOT NULL,
  profile_parameters JSONB NOT NULL,

  strategy_key TEXT NOT NULL,
  strategy_version TEXT NOT NULL,

  signal_timestamp TIMESTAMPTZ NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),

  entry_reference NUMERIC,
  stop_reference NUMERIC,
  target_reference NUMERIC,
  atr_14 NUMERIC,
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  reason_codes JSONB NOT NULL,
  source_event_payload JSONB NOT NULL,

  eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('ELIGIBLE','BELOW_SCORE_CUTOFF')),
  eligibility_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (jsonb_typeof(profile_parameters) = 'object'),
  CHECK (jsonb_typeof(reason_codes) = 'array'),
  CHECK (jsonb_typeof(source_event_payload) = 'object'),
  CHECK (jsonb_typeof(feature_snapshot) = 'object')
);

-- Primary lifecycle identity: one observation per run/profile-configuration/
-- setup lifecycle when the event carries a setup_instance_id.
CREATE UNIQUE INDEX IF NOT EXISTS paper_signal_observation_lifecycle_uq
  ON paper_signal_observation(run_id, profile_config_id, setup_instance_id)
  WHERE setup_instance_id IS NOT NULL;

-- Idempotency fallback for legacy events with no setup identity.
CREATE UNIQUE INDEX IF NOT EXISTS paper_signal_observation_legacy_event_uq
  ON paper_signal_observation(run_id, source_event_id)
  WHERE setup_instance_id IS NULL;

CREATE INDEX IF NOT EXISTS paper_signal_observation_run_idx
  ON paper_signal_observation(run_id, eligibility_status);
CREATE INDEX IF NOT EXISTS paper_signal_observation_profile_config_time_idx
  ON paper_signal_observation(profile_config_id, signal_timestamp DESC);
CREATE INDEX IF NOT EXISTS paper_signal_observation_instrument_idx
  ON paper_signal_observation(instrument_id, signal_timestamp DESC);

-- Immutable: corrections create a new versioned run rather than rewriting
-- observed history (private development record, Phase 1; ADR-009).
CREATE OR REPLACE FUNCTION paper_signal_observation_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'paper_signal_observation rows are immutable; insert a new run instead of updating id=%', OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_signal_observation_immutable ON paper_signal_observation;
CREATE TRIGGER paper_signal_observation_immutable
BEFORE UPDATE ON paper_signal_observation
FOR EACH ROW EXECUTE FUNCTION paper_signal_observation_reject_update();

CREATE TABLE IF NOT EXISTS paper_execution (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES paper_signal_observation(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (model IN ('QUOTE','CANDLE')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','OPEN','CLOSE_PENDING','CLOSED','NO_FILL')),

  entry_price NUMERIC,
  entry_time TIMESTAMPTZ,
  stop_price NUMERIC,
  target_price NUMERIC,
  shares BIGINT CHECK (shares IS NULL OR shares > 0),
  initial_risk NUMERIC,

  exit_price NUMERIC,
  exit_time TIMESTAMPTZ,
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('TARGET','STOP','SESSION_CLOSE','SESSION_CLOSE_DELAYED')),

  fee NUMERIC,
  gross_pnl NUMERIC,
  net_pnl NUMERIC,
  r_multiple NUMERIC,

  no_fill_reason TEXT CHECK (no_fill_reason IS NULL OR no_fill_reason IN (
    'HALTED','DELAYED','STALE','MISSING_QUOTE',
    'MISSING_REFERENCE','SHARES_BELOW_ONE','EXECUTABLE_PRICE_OUTSIDE_LEVELS'
  )),

  entry_market_snapshot JSONB,
  exit_market_snapshot JSONB,
  entry_size_coverage NUMERIC,
  exit_size_coverage NUMERIC,
  session_close_delay_ms BIGINT CHECK (session_close_delay_ms IS NULL OR session_close_delay_ms >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(observation_id, model),

  -- Require complete, mutually consistent column groups per status.
  CHECK (
    (status = 'PENDING' AND entry_price IS NULL AND exit_price IS NULL AND no_fill_reason IS NULL)
    OR
    (status = 'NO_FILL'
      AND no_fill_reason IS NOT NULL
      AND entry_price IS NULL AND entry_time IS NULL
      AND exit_price IS NULL AND exit_time IS NULL AND exit_reason IS NULL)
    OR
    (status IN ('OPEN','CLOSE_PENDING')
      AND entry_price IS NOT NULL AND entry_time IS NOT NULL
      AND stop_price IS NOT NULL AND target_price IS NOT NULL
      AND shares IS NOT NULL AND initial_risk IS NOT NULL
      AND exit_price IS NULL AND exit_time IS NULL AND exit_reason IS NULL
      AND net_pnl IS NULL)
    OR
    (status = 'CLOSED'
      AND entry_price IS NOT NULL AND entry_time IS NOT NULL
      AND stop_price IS NOT NULL AND target_price IS NOT NULL
      AND shares IS NOT NULL AND initial_risk IS NOT NULL
      AND exit_price IS NOT NULL AND exit_time IS NOT NULL AND exit_reason IS NOT NULL
      AND fee IS NOT NULL AND gross_pnl IS NOT NULL AND net_pnl IS NOT NULL
      AND r_multiple IS NOT NULL)
  )
);

-- Current open and close-pending executions (the durable live processor's
-- resume-on-startup query, Phase 3).
CREATE INDEX IF NOT EXISTS paper_execution_open_close_pending_idx
  ON paper_execution(status)
  WHERE status IN ('OPEN','CLOSE_PENDING');

-- Profile configuration, model, and signal time: paired with
-- paper_signal_observation_profile_config_time_idx to support cohort scans
-- joined on observation_id and filtered by model.
CREATE INDEX IF NOT EXISTS paper_execution_observation_model_idx
  ON paper_execution(observation_id, model, status);

-- Session run and status (join through observation.run_id).
CREATE INDEX IF NOT EXISTS paper_execution_status_idx ON paper_execution(status, model);

-- Aggregate scans over closed canonical (QUOTE model) executions.
CREATE INDEX IF NOT EXISTS paper_execution_closed_quote_idx
  ON paper_execution(exit_time)
  WHERE status = 'CLOSED' AND model = 'QUOTE';

CREATE OR REPLACE FUNCTION paper_execution_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_execution_touch_updated_at ON paper_execution;
CREATE TRIGGER paper_execution_touch_updated_at
BEFORE UPDATE ON paper_execution
FOR EACH ROW EXECUTE FUNCTION paper_execution_touch_updated_at();

INSERT INTO foundation_schema_version(version, description)
VALUES(30, 'Phase 1 immutable paper-bot schema (paper_bot_run, paper_signal_observation, paper_execution)')
ON CONFLICT(version) DO NOTHING;
