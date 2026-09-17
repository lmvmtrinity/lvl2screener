-- FP03: immutable primary funded historical-comparison records.
--
-- One content-addressed specification freezes the baseline, ordered session and
-- source-opportunity membership, both policy identities, the model artifact
-- identity, capital and the evidence cutoff. The complete policy-neutral shared
-- exogenous stream is materialized into immutable input chunks before the
-- specification freeze; later replay reads only those chunks. Per-session run
-- bindings, policy evaluations and session metrics are append-only identity rows
-- (completion is derived, never updated), and one paired result row per
-- specification is written once by the finalization transaction.
--
-- This migration is additive. Migrations 130 and 131 are retained and deployed;
-- neither is modified here. Nothing in this schema grants a model authority: no
-- table carries an activation, promotion or funded-policy mutation path.

-- ============================================================================
-- Job type
-- ============================================================================
-- The comparison runs on the existing durable research-job queue, lease and
-- idempotency-key deduplication.
ALTER TABLE research_job DROP CONSTRAINT IF EXISTS research_job_job_type_check;
ALTER TABLE research_job ADD CONSTRAINT research_job_job_type_check
  CHECK (job_type IN ('BACKTEST', 'CALIBRATION', 'RANKING_RESEARCH', 'STATISTICAL_TRAINING', 'COVERAGE_VERIFICATION', 'STRATEGY_STUDY', 'EXECUTION_DIAGNOSTICS', 'FUNDED_HISTORICAL_REPLAY', 'FUNDED_EXECUTION_TRAINING', 'FUNDED_COMPARISON'));

-- ============================================================================
-- Ownership keys required by the comparison foreign keys
-- ============================================================================
-- The baseline must be provably owned by the comparison's market.
CREATE UNIQUE INDEX IF NOT EXISTS backtest_run_id_market_unique
  ON backtest_run(id, market_id);

-- ============================================================================
-- Frozen specification
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_comparison_spec (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  spec_version TEXT NOT NULL,
  baseline_backtest_run_id UUID NOT NULL,
  baseline_config_version TEXT NOT NULL,
  baseline_start_date DATE NOT NULL,
  baseline_end_date DATE NOT NULL,
  baseline_execution_model_version TEXT NOT NULL,
  baseline_replay_input_digest TEXT NOT NULL CHECK(baseline_replay_input_digest ~ '^[a-f0-9]{64}$'),
  baseline_result_digest TEXT NOT NULL CHECK(baseline_result_digest ~ '^[a-f0-9]{64}$'),
  baseline_completed_at TIMESTAMPTZ NOT NULL,
  champion_policy_digest TEXT NOT NULL CHECK(champion_policy_digest ~ '^[a-f0-9]{64}$'),
  champion_source_run_id UUID NOT NULL,
  champion_source_account_id UUID NOT NULL,
  champion_execution_model_version TEXT NOT NULL,
  champion_account_assumption_digest TEXT NOT NULL CHECK(champion_account_assumption_digest ~ '^[a-f0-9]{64}$'),
  challenger_model_id UUID NOT NULL,
  challenger_model_version TEXT NOT NULL,
  challenger_model_type TEXT NOT NULL CHECK(challenger_model_type = 'FUNDED_EXECUTION_QUALITY'),
  challenger_artifact_digest TEXT NOT NULL CHECK(challenger_artifact_digest ~ '^[a-f0-9]{64}$'),
  challenger_feature_version TEXT NOT NULL,
  challenger_cohort_digest TEXT NOT NULL CHECK(challenger_cohort_digest ~ '^[a-f0-9]{64}$'),
  challenger_policy_digest TEXT NOT NULL CHECK(challenger_policy_digest ~ '^[a-f0-9]{64}$'),
  initial_cash NUMERIC(20,6) NOT NULL CHECK(initial_cash > 0),
  daily_loss_limit NUMERIC(20,6) NOT NULL CHECK(daily_loss_limit > 0),
  risk_configuration_digest TEXT NOT NULL CHECK(risk_configuration_digest ~ '^[a-f0-9]{64}$'),
  evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  specification_frozen_at TIMESTAMPTZ NOT NULL,
  comparison_spec_digest TEXT NOT NULL CHECK(comparison_spec_digest ~ '^[a-f0-9]{64}$'),
  specification JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT funded_comparison_spec_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_comparison_spec_cutoff_check CHECK(
    specification_frozen_at >= evidence_cutoff_at
  ),
  CONSTRAINT funded_comparison_spec_payload_check CHECK(
    jsonb_typeof(specification) = 'object'
  ),
  -- One frozen specification identity. Reusing the same frozen identity with a
  -- different digest fails visibly as a conflicting retry instead of creating a
  -- second specification for the same comparison.
  UNIQUE (comparison_spec_digest),
  UNIQUE (market_id, baseline_backtest_run_id, champion_policy_digest, challenger_policy_digest, evidence_cutoff_at),
  CONSTRAINT funded_comparison_spec_champion_run_fk
    FOREIGN KEY (champion_source_run_id, champion_source_account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency),
  CONSTRAINT funded_comparison_spec_champion_market_fk
    FOREIGN KEY (champion_source_run_id, market_id)
    REFERENCES paper_bot_run(id, market_id),
  CONSTRAINT funded_comparison_spec_baseline_fk
    FOREIGN KEY (baseline_backtest_run_id, market_id)
    REFERENCES backtest_run(id, market_id),
  -- The challenger columns must match the persisted inactive challenger exactly.
  CONSTRAINT funded_comparison_spec_challenger_fk
    FOREIGN KEY (
      challenger_model_id, challenger_model_version, challenger_model_type,
      challenger_artifact_digest, challenger_feature_version,
      challenger_cohort_digest, market_id, currency
    ) REFERENCES funded_execution_challenger(
      id, model_version, model_type, artifact_digest, feature_version,
      cohort_digest, market_id, currency
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS funded_comparison_spec_id_market_unique
  ON funded_comparison_spec(id, market_id);

CREATE UNIQUE INDEX IF NOT EXISTS funded_comparison_spec_id_market_currency_unique
  ON funded_comparison_spec(id, market_id, currency);

CREATE INDEX IF NOT EXISTS funded_comparison_spec_market_idx
  ON funded_comparison_spec(market_id, specification_frozen_at DESC);

-- ============================================================================
-- Ordered session and source-opportunity membership
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_comparison_spec_session (
  spec_id UUID NOT NULL REFERENCES funded_comparison_spec(id) ON DELETE RESTRICT,
  session_date DATE NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  session_start_at TIMESTAMPTZ NOT NULL,
  scheduled_close_at TIMESTAMPTZ NOT NULL,
  session_timezone TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK(item_count > 0),
  chunk_count INTEGER NOT NULL CHECK(chunk_count > 0),
  session_input_digest TEXT NOT NULL CHECK(session_input_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (spec_id, session_date),
  UNIQUE (spec_id, ordinal),
  CONSTRAINT funded_comparison_spec_session_window_check CHECK(
    scheduled_close_at > session_start_at
  )
);

CREATE TABLE IF NOT EXISTS funded_comparison_spec_opportunity (
  spec_id UUID NOT NULL,
  source_opportunity_id TEXT NOT NULL,
  session_date DATE NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  source_event_id TEXT NOT NULL,
  setup_instance_id TEXT NOT NULL,
  instrument_id UUID NOT NULL,
  profile_config_id UUID NOT NULL,
  signal_timestamp TIMESTAMPTZ NOT NULL,
  source_content_digest TEXT NOT NULL CHECK(source_content_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (spec_id, source_opportunity_id),
  UNIQUE (spec_id, session_date, ordinal),
  -- The same source opportunity must always belong to the same frozen session,
  -- so a policy evaluation can prove its source/session ownership by key.
  CONSTRAINT funded_comparison_spec_opportunity_session_unique
    UNIQUE (spec_id, source_opportunity_id, session_date),
  FOREIGN KEY (spec_id, session_date)
    REFERENCES funded_comparison_spec_session(spec_id, session_date)
);

-- ============================================================================
-- Immutable policy-neutral shared input
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_comparison_input_chunk (
  spec_id UUID NOT NULL,
  session_date DATE NOT NULL,
  chunk_ordinal INTEGER NOT NULL CHECK(chunk_ordinal > 0),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 1000),
  first_effective_at TIMESTAMPTZ NOT NULL,
  last_effective_at TIMESTAMPTZ NOT NULL,
  chunk_digest TEXT NOT NULL CHECK(chunk_digest ~ '^[a-f0-9]{64}$'),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (spec_id, session_date, chunk_ordinal),
  CONSTRAINT funded_comparison_input_chunk_window_check CHECK(
    last_effective_at >= first_effective_at
  ),
  CONSTRAINT funded_comparison_input_chunk_payload_check CHECK(
    jsonb_typeof(payload) = 'array' AND jsonb_array_length(payload) = item_count
  ),
  FOREIGN KEY (spec_id, session_date)
    REFERENCES funded_comparison_spec_session(spec_id, session_date)
);

-- ============================================================================
-- Per-session run bindings (identity only; completion is derived)
-- ============================================================================
-- Provisioning spans the existing account/run/ledger stores. This immutable
-- intent is committed first so a crash after the historical run commits but
-- before its binding is inserted leaves a comparison-owned adoption proof.
CREATE TABLE IF NOT EXISTS funded_comparison_provisioning_intent (
  spec_id UUID NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('CHAMPION','CHALLENGER')),
  session_date DATE NOT NULL,
  account_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  policy_digest TEXT NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  execution_model_version TEXT NOT NULL,
  account_assumption_digest TEXT NOT NULL CHECK(account_assumption_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (spec_id, side, session_date),
  UNIQUE (account_id, session_date),
  CONSTRAINT funded_comparison_provisioning_intent_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  FOREIGN KEY (spec_id, session_date)
    REFERENCES funded_comparison_spec_session(spec_id, session_date),
  CONSTRAINT funded_comparison_provisioning_intent_spec_currency_fk
    FOREIGN KEY (spec_id, market_id, currency)
    REFERENCES funded_comparison_spec(id, market_id, currency)
);

CREATE TABLE IF NOT EXISTS funded_comparison_run_binding (
  spec_id UUID NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('CHAMPION','CHALLENGER')),
  session_date DATE NOT NULL,
  run_id UUID NOT NULL,
  account_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  policy_digest TEXT NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  execution_model_version TEXT NOT NULL,
  account_assumption_digest TEXT NOT NULL CHECK(account_assumption_digest ~ '^[a-f0-9]{64}$'),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (spec_id, side, session_date),
  -- A binding key lets a policy evaluation prove its exact destination run.
  CONSTRAINT funded_comparison_run_binding_run_unique
    UNIQUE (spec_id, side, session_date, run_id),
  -- One funded run belongs to exactly one comparison side/session coordinate.
  CONSTRAINT funded_comparison_run_binding_run_id_unique
    UNIQUE (run_id),
  CONSTRAINT funded_comparison_run_binding_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  FOREIGN KEY (spec_id, session_date)
    REFERENCES funded_comparison_spec_session(spec_id, session_date),
  -- The binding market/currency is the specification's own, never a caller claim.
  CONSTRAINT funded_comparison_run_binding_spec_currency_fk
    FOREIGN KEY (spec_id, market_id, currency)
    REFERENCES funded_comparison_spec(id, market_id, currency),
  FOREIGN KEY (run_id, market_id)
    REFERENCES paper_bot_run(id, market_id),
  FOREIGN KEY (run_id, account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency)
);

-- ============================================================================
-- Source-to-destination mapping and comparison-owned policy evaluations
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_comparison_policy_evaluation (
  spec_id UUID NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('CHAMPION','CHALLENGER')),
  session_date DATE NOT NULL,
  source_opportunity_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK(source_ordinal > 0),
  signal_timestamp TIMESTAMPTZ NOT NULL,
  batch_key TEXT NOT NULL,
  champion_rank INTEGER NOT NULL CHECK(champion_rank > 0),
  applied_rank INTEGER NOT NULL CHECK(applied_rank > 0),
  destination_run_id UUID NOT NULL,
  destination_observation_id UUID NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('CHAMPION_ORDER','PREDICTED','FALLBACK_CHAMPION_ORDER')),
  fallback_reason TEXT,
  prediction JSONB,
  evaluation_digest TEXT NOT NULL CHECK(evaluation_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (spec_id, side, session_date, source_opportunity_id),
  CONSTRAINT funded_comparison_policy_evaluation_prediction_check CHECK(
    (disposition = 'PREDICTED' AND prediction IS NOT NULL AND jsonb_typeof(prediction) = 'object' AND fallback_reason IS NULL) OR
    (disposition = 'FALLBACK_CHAMPION_ORDER' AND prediction IS NULL AND fallback_reason IS NOT NULL AND applied_rank = champion_rank) OR
    (disposition = 'CHAMPION_ORDER' AND prediction IS NULL)
  ),
  CONSTRAINT funded_comparison_policy_evaluation_batch_check CHECK(
    side = 'CHALLENGER' OR applied_rank = champion_rank
  ),
  FOREIGN KEY (spec_id, side, session_date)
    REFERENCES funded_comparison_run_binding(spec_id, side, session_date),
  -- The destination run must be exactly the run bound to this side/session.
  CONSTRAINT funded_comparison_policy_evaluation_destination_binding_fk
    FOREIGN KEY (spec_id, side, session_date, destination_run_id)
    REFERENCES funded_comparison_run_binding(spec_id, side, session_date, run_id),
  FOREIGN KEY (spec_id, source_opportunity_id)
    REFERENCES funded_comparison_spec_opportunity(spec_id, source_opportunity_id),
  -- The source opportunity must belong to the same frozen session.
  CONSTRAINT funded_comparison_policy_evaluation_source_session_fk
    FOREIGN KEY (spec_id, source_opportunity_id, session_date)
    REFERENCES funded_comparison_spec_opportunity(spec_id, source_opportunity_id, session_date),
  -- The destination observation must be owned by the bound destination run.
  FOREIGN KEY (destination_run_id, destination_observation_id)
    REFERENCES paper_signal_observation(run_id, id)
);

-- ============================================================================
-- Per-side/session metric rows
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_comparison_session_metric (
  spec_id UUID NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('CHAMPION','CHALLENGER')),
  session_date DATE NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  valuation TEXT NOT NULL CHECK(valuation IN ('UNION_GRID_MTM','UNAVAILABLE')),
  valuation_reason TEXT,
  net_return NUMERIC(20,6),
  max_drawdown NUMERIC(20,6),
  trade_count INTEGER NOT NULL DEFAULT 0 CHECK(trade_count >= 0),
  unrealized_position_count INTEGER NOT NULL DEFAULT 0 CHECK(unrealized_position_count >= 0),
  unresolved_order_count INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_order_count >= 0),
  unresolved_reservation_count INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_reservation_count >= 0),
  stale_mark_count INTEGER NOT NULL DEFAULT 0 CHECK(stale_mark_count >= 0),
  valuation_point_count INTEGER NOT NULL DEFAULT 0 CHECK(valuation_point_count >= 0),
  metric_digest TEXT NOT NULL CHECK(metric_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (spec_id, side, session_date),
  CONSTRAINT funded_comparison_session_metric_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_comparison_session_metric_proven_check CHECK(
    (valuation = 'UNION_GRID_MTM' AND valuation_reason IS NULL AND net_return IS NOT NULL AND max_drawdown IS NOT NULL) OR
    (valuation = 'UNAVAILABLE' AND valuation_reason IS NOT NULL AND net_return IS NULL AND max_drawdown IS NULL)
  ),
  FOREIGN KEY (spec_id, side, session_date)
    REFERENCES funded_comparison_run_binding(spec_id, side, session_date),
  -- A metric cannot claim a market/currency the specification does not own.
  CONSTRAINT funded_comparison_session_metric_spec_currency_fk
    FOREIGN KEY (spec_id, market_id, currency)
    REFERENCES funded_comparison_spec(id, market_id, currency)
);

-- ============================================================================
-- One immutable paired result per specification
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_comparison_result (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  result_version TEXT NOT NULL,
  session_count INTEGER NOT NULL CHECK(session_count > 0),
  historical_volume_status TEXT NOT NULL CHECK(historical_volume_status IN ('INSUFFICIENT_SESSIONS','SUFFICIENT_FOR_LATER_G2')),
  champion_evaluation_digest TEXT NOT NULL CHECK(champion_evaluation_digest ~ '^[a-f0-9]{64}$'),
  challenger_evaluation_digest TEXT NOT NULL CHECK(challenger_evaluation_digest ~ '^[a-f0-9]{64}$'),
  champion_metrics_digest TEXT NOT NULL CHECK(champion_metrics_digest ~ '^[a-f0-9]{64}$'),
  challenger_metrics_digest TEXT NOT NULL CHECK(challenger_metrics_digest ~ '^[a-f0-9]{64}$'),
  result_digest TEXT NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (spec_id),
  UNIQUE (result_digest),
  CONSTRAINT funded_comparison_result_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_comparison_result_payload_check CHECK(
    jsonb_typeof(result) = 'object'
  ),
  FOREIGN KEY (spec_id, market_id)
    REFERENCES funded_comparison_spec(id, market_id)
);

-- ============================================================================
-- Append-only failure and availability receipts
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_comparison_failure (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id UUID NOT NULL REFERENCES funded_comparison_spec(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL,
  side TEXT CHECK(side IN ('CHAMPION','CHALLENGER')),
  session_date DATE,
  reason TEXT NOT NULL CHECK(reason IN (
    'BASELINE_LINEAGE_UNAVAILABLE','REPLAY_LINEAGE_UNAVAILABLE',
    'SESSION_MEMBERSHIP_MISMATCH','OPPORTUNITY_MEMBERSHIP_MISMATCH',
    'MARKET_CURRENCY_MISMATCH','CHAMPION_POLICY_IDENTITY_MISMATCH',
    'CHALLENGER_POLICY_IDENTITY_MISMATCH','MODEL_IDENTITY_MISMATCH',
    'ARTIFACT_IDENTITY_MISMATCH','RUNTIME_IDENTITY_MISMATCH',
    'COST_IDENTITY_MISMATCH','RISK_IDENTITY_MISMATCH',
    'SOURCE_CUTOFF_AFTER_FREEZE','RETAINED_INPUT_MISSING',
    'QUOTE_COVERAGE_MISSING','TRAINING_CHRONOLOGY_UNPROVEN',
    'TRAINING_WINDOW_OVERLAP','COMPARISON_WINDOW_NOT_AFTER_TRAINING',
    'LIVE_ACCOUNT_REPLAY_TARGET','ACCOUNT_IDENTITY_COLLISION',
    'CHAMPION_NOT_RETAINED','PREDICTION_DECISION_UNAVAILABLE','STALE_MARK',
    'UNPROVABLE_CAUSAL_ORDER','UNRESOLVED_ORDER','UNRESOLVED_RESERVATION',
    'UNRESOLVED_POSITION','INCOMPLETE_SESSION','CANCELLED','LEASE_LOST',
    'CONFLICTING_RETRY','RESULT_DIGEST_CONFLICT','INTERNAL_ERROR'
  )),
  classification TEXT NOT NULL CHECK(classification IN ('TERMINAL','INTERRUPTION')),
  detail TEXT NOT NULL CHECK(length(detail) > 0),
  failure_digest TEXT NOT NULL CHECK(failure_digest ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- Cancellation and lease loss are resumable interruptions; every other
  -- reason is terminal for the specification.
  CONSTRAINT funded_comparison_failure_resumable_check CHECK(
    (reason IN ('CANCELLED','LEASE_LOST')) = (classification = 'INTERRUPTION')
  ),
  -- An exact attempt/reason retry returns the existing receipt; a changed
  -- receipt under the same coordinate fails visibly. NULL side/session compare
  -- equal so a spec-level failure can never be duplicated.
  UNIQUE NULLS NOT DISTINCT (spec_id, attempt_id, reason, side, session_date)
);

CREATE INDEX IF NOT EXISTS funded_comparison_failure_spec_idx
  ON funded_comparison_failure(spec_id, recorded_at);

-- ============================================================================
-- Immutability
-- ============================================================================
CREATE OR REPLACE FUNCTION reject_funded_comparison_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Funded comparison rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_comparison_spec_immutable ON funded_comparison_spec;
CREATE TRIGGER funded_comparison_spec_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_spec
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_spec_session_immutable ON funded_comparison_spec_session;
CREATE TRIGGER funded_comparison_spec_session_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_spec_session
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_spec_opportunity_immutable ON funded_comparison_spec_opportunity;
CREATE TRIGGER funded_comparison_spec_opportunity_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_spec_opportunity
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_input_chunk_immutable ON funded_comparison_input_chunk;
CREATE TRIGGER funded_comparison_input_chunk_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_input_chunk
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_run_binding_immutable ON funded_comparison_run_binding;
CREATE TRIGGER funded_comparison_run_binding_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_run_binding
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_provisioning_intent_immutable ON funded_comparison_provisioning_intent;
CREATE TRIGGER funded_comparison_provisioning_intent_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_provisioning_intent
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_policy_evaluation_immutable ON funded_comparison_policy_evaluation;
CREATE TRIGGER funded_comparison_policy_evaluation_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_policy_evaluation
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_session_metric_immutable ON funded_comparison_session_metric;
CREATE TRIGGER funded_comparison_session_metric_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_session_metric
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_result_immutable ON funded_comparison_result;
CREATE TRIGGER funded_comparison_result_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_result
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

DROP TRIGGER IF EXISTS funded_comparison_failure_immutable ON funded_comparison_failure;
CREATE TRIGGER funded_comparison_failure_immutable
  BEFORE UPDATE OR DELETE ON funded_comparison_failure
  FOR EACH ROW EXECUTE FUNCTION reject_funded_comparison_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES(132, 'Immutable funded historical-comparison records')
ON CONFLICT(version) DO NOTHING;
