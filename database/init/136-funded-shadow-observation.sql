-- FP04: prospective funded champion/challenger SHADOW observation.
--
-- One immutable, market-scoped gate policy freezes the ADR-016 SHADOW window,
-- the approved challenger ordering policy, the prediction lag and the
-- operator-supplied Stage B approval reference before any eligible observation
-- exists. One immutable enrollment freezes the exact champion and inactive
-- challenger identities. The observer consumes committed FP01 funded decision
-- evidence, seals one simultaneous batch per funded run and exact decision
-- clock, records predictions through the FP02 forward-prediction boundary, and
-- appends terminal dispositions, projections, independent labels, reports and
-- observer receipts.
--
-- This migration is additive. Migrations 130-135 are retained and deployed;
-- none is modified here. Nothing in this schema grants a model authority: no
-- table carries an activation, promotion, canary, rollback or active-policy
-- pointer, and the report rejects an authority claim at the database layer.

-- ============================================================================
-- Immutability guard
-- ============================================================================
CREATE OR REPLACE FUNCTION reject_funded_shadow_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Funded shadow observation rows are immutable';
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Gate policy (immutable, content-addressed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_gate_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_policy_version TEXT NOT NULL CHECK(gate_policy_version = 'funded-shadow-gate-policy-v1'),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  stage_b_approval JSONB NOT NULL,
  gate_window JSONB NOT NULL,
  challenger_policy_version TEXT NOT NULL CHECK(challenger_policy_version = 'funded-comparison-execution-quality-ordering-v1'),
  max_prediction_lag_ms INTEGER NOT NULL CHECK(max_prediction_lag_ms BETWEEN 1000 AND 30000),
  gate_policy_digest TEXT NOT NULL CHECK(gate_policy_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT funded_shadow_gate_policy_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_shadow_gate_policy_stage_b_check CHECK(
    jsonb_typeof(stage_b_approval) = 'object' AND
    stage_b_approval ?& array['approvalRef','approvedAt','approvedBy','mMarket','referenceSessionCount','referenceSessionDigest','referenceWindowStart','referenceWindowEnd','referenceEvidenceCutoffAt'] AND
    (stage_b_approval->>'referenceSessionCount')::int >= 40 AND
    (stage_b_approval->>'mMarket')::numeric > 0
  ),
  CONSTRAINT funded_shadow_gate_policy_window_check CHECK(
    jsonb_typeof(gate_window) = 'object' AND
    gate_window ?& array['minDecisions','minSessions','horizonSessions','horizonDays'] AND
    (gate_window->>'minDecisions')::int > 0 AND
    (gate_window->>'minSessions')::int > 0 AND
    (gate_window->>'horizonSessions')::int > 0 AND
    (gate_window->>'horizonDays')::int > 0
  ),
  UNIQUE (gate_policy_digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS funded_shadow_gate_policy_id_market_currency_uq
  ON funded_shadow_gate_policy(id, market_id, currency);

CREATE INDEX IF NOT EXISTS funded_shadow_gate_policy_market_idx
  ON funded_shadow_gate_policy(market_id, created_at DESC);

CREATE OR REPLACE FUNCTION funded_shadow_gate_policy_validate()
RETURNS trigger AS $$
BEGIN
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_gate_policy_validate ON funded_shadow_gate_policy;
CREATE TRIGGER funded_shadow_gate_policy_validate
  BEFORE INSERT ON funded_shadow_gate_policy
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_gate_policy_validate();

DROP TRIGGER IF EXISTS funded_shadow_gate_policy_immutable ON funded_shadow_gate_policy;
CREATE TRIGGER funded_shadow_gate_policy_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_gate_policy
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Enrollment (immutable)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_enrollment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_policy_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  source_kind TEXT NOT NULL CHECK(source_kind = 'LIVE_PAPER'),
  champion_source_run_id UUID NOT NULL,
  champion_source_account_id UUID NOT NULL,
  champion_policy_digest TEXT NOT NULL CHECK(champion_policy_digest ~ '^[a-f0-9]{64}$'),
  champion_execution_model_version TEXT NOT NULL,
  champion_account_assumption_digest TEXT NOT NULL CHECK(champion_account_assumption_digest ~ '^[a-f0-9]{64}$'),
  champion_payload JSONB NOT NULL,
  challenger_model_id UUID NOT NULL,
  challenger_model_version TEXT NOT NULL,
  challenger_model_type TEXT NOT NULL CHECK(challenger_model_type = 'FUNDED_EXECUTION_QUALITY'),
  challenger_artifact_digest TEXT NOT NULL CHECK(challenger_artifact_digest ~ '^[a-f0-9]{64}$'),
  challenger_feature_version TEXT NOT NULL,
  challenger_cohort_digest TEXT NOT NULL CHECK(challenger_cohort_digest ~ '^[a-f0-9]{64}$'),
  challenger_dataset_digest TEXT NOT NULL CHECK(challenger_dataset_digest ~ '^[a-f0-9]{64}$'),
  challenger_training_partition_digest TEXT NOT NULL CHECK(challenger_training_partition_digest ~ '^[a-f0-9]{64}$'),
  challenger_training_evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  challenger_policy_digest TEXT NOT NULL CHECK(challenger_policy_digest ~ '^[a-f0-9]{64}$'),
  challenger_payload JSONB NOT NULL,
  evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  registration_request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  enrollment_digest TEXT NOT NULL CHECK(enrollment_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT funded_shadow_enrollment_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_shadow_enrollment_prospective_check CHECK(
    effective_from >= evidence_cutoff_at
  ),
  CONSTRAINT funded_shadow_enrollment_payload_check CHECK(
    jsonb_typeof(champion_payload) = 'object' AND
    jsonb_typeof(challenger_payload) = 'object'
  ),
  CONSTRAINT funded_shadow_enrollment_gate_policy_fk
    FOREIGN KEY (gate_policy_id, market_id, currency)
    REFERENCES funded_shadow_gate_policy(id, market_id, currency),
  CONSTRAINT funded_shadow_enrollment_champion_run_fk
    FOREIGN KEY (champion_source_run_id, champion_source_account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency),
  CONSTRAINT funded_shadow_enrollment_champion_market_fk
    FOREIGN KEY (champion_source_run_id, market_id)
    REFERENCES paper_bot_run(id, market_id),
  CONSTRAINT funded_shadow_enrollment_challenger_fk
    FOREIGN KEY (
      challenger_model_id, challenger_model_version, challenger_model_type,
      challenger_artifact_digest, challenger_feature_version,
      challenger_cohort_digest, market_id, currency
    ) REFERENCES funded_execution_challenger(
      id, model_version, model_type, artifact_digest, feature_version,
      cohort_digest, market_id, currency
    ),
  UNIQUE (registration_request_id),
  UNIQUE (enrollment_digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS funded_shadow_enrollment_id_market_currency_uq
  ON funded_shadow_enrollment(id, market_id, currency);

CREATE UNIQUE INDEX IF NOT EXISTS funded_shadow_enrollment_id_gate_policy_uq
  ON funded_shadow_enrollment(id, gate_policy_id);

CREATE INDEX IF NOT EXISTS funded_shadow_enrollment_market_idx
  ON funded_shadow_enrollment(market_id, created_at DESC);

CREATE OR REPLACE FUNCTION funded_shadow_enrollment_validate()
RETURNS trigger AS $$
DECLARE
  challenger_status TEXT;
  challenger_artifact JSONB;
  challenger_eligible BOOLEAN;
  challenger_active BOOLEAN;
BEGIN
  NEW.effective_from := clock_timestamp();
  NEW.created_at := clock_timestamp();
  SELECT status, artifact, eligible_for_activation, active
    INTO challenger_status, challenger_artifact, challenger_eligible, challenger_active
    FROM funded_execution_challenger
   WHERE id = NEW.challenger_model_id
   FOR SHARE;
  IF challenger_status IS DISTINCT FROM 'INACTIVE' THEN
    RAISE EXCEPTION 'Funded shadow enrollment requires an INACTIVE challenger';
  END IF;
  IF challenger_artifact IS NULL THEN
    RAISE EXCEPTION 'Funded shadow enrollment requires a retained challenger artifact';
  END IF;
  IF challenger_eligible OR challenger_active THEN
    RAISE EXCEPTION 'Funded shadow enrollment refuses an activation-eligible challenger';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_enrollment_validate ON funded_shadow_enrollment;
CREATE TRIGGER funded_shadow_enrollment_validate
  BEFORE INSERT ON funded_shadow_enrollment
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_enrollment_validate();

DROP TRIGGER IF EXISTS funded_shadow_enrollment_immutable ON funded_shadow_enrollment;
CREATE TRIGGER funded_shadow_enrollment_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_enrollment
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Enrollment lifecycle (append-only, SHADOW only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_enrollment_transition (
  enrollment_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  action TEXT NOT NULL CHECK(action IN ('PAUSE','RESUME','REVOKE')),
  state TEXT NOT NULL CHECK(state IN ('SHADOW','PAUSED','REVOKED')),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (enrollment_id, sequence),
  UNIQUE (enrollment_id, request_id),
  CONSTRAINT funded_shadow_enrollment_transition_enrollment_fk
    FOREIGN KEY (enrollment_id) REFERENCES funded_shadow_enrollment(id)
);

CREATE OR REPLACE FUNCTION funded_shadow_enrollment_transition_validate()
RETURNS trigger AS $$
BEGIN
  NEW.effective_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_enrollment_transition_validate ON funded_shadow_enrollment_transition;
CREATE TRIGGER funded_shadow_enrollment_transition_validate
  BEFORE INSERT ON funded_shadow_enrollment_transition
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_enrollment_transition_validate();

DROP TRIGGER IF EXISTS funded_shadow_enrollment_transition_immutable ON funded_shadow_enrollment_transition;
CREATE TRIGGER funded_shadow_enrollment_transition_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_enrollment_transition
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Simultaneous batches (immutable identity)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_batch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  run_id UUID NOT NULL,
  account_id UUID NOT NULL,
  session_date DATE NOT NULL,
  decision_at TIMESTAMPTZ NOT NULL,
  champion_identity_digest TEXT NOT NULL CHECK(champion_identity_digest ~ '^[a-f0-9]{64}$'),
  sealed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  batch_digest TEXT NOT NULL CHECK(batch_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT funded_shadow_batch_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_shadow_batch_enrollment_fk
    FOREIGN KEY (enrollment_id, market_id, currency)
    REFERENCES funded_shadow_enrollment(id, market_id, currency),
  CONSTRAINT funded_shadow_batch_run_fk
    FOREIGN KEY (run_id, market_id) REFERENCES paper_bot_run(id, market_id),
  CONSTRAINT funded_shadow_batch_account_fk
    FOREIGN KEY (run_id, account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency),
  UNIQUE (enrollment_id, run_id, decision_at),
  UNIQUE (batch_digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS funded_shadow_batch_id_enrollment_uq
  ON funded_shadow_batch(id, enrollment_id);

CREATE UNIQUE INDEX IF NOT EXISTS funded_shadow_batch_id_market_currency_uq
  ON funded_shadow_batch(id, market_id, currency);

CREATE INDEX IF NOT EXISTS funded_shadow_batch_enrollment_idx
  ON funded_shadow_batch(enrollment_id, decision_at DESC);

CREATE OR REPLACE FUNCTION funded_shadow_batch_validate()
RETURNS trigger AS $$
DECLARE
  latest_state TEXT;
  enrollment_effective TIMESTAMPTZ;
  champion_digest TEXT;
BEGIN
  NEW.sealed_at := clock_timestamp();
  SELECT COALESCE(
           (SELECT t.state
              FROM funded_shadow_enrollment_transition t
             WHERE t.enrollment_id = NEW.enrollment_id
             ORDER BY t.sequence DESC
             LIMIT 1),
           'SHADOW'),
         e.effective_from,
         e.champion_policy_digest
    INTO latest_state, enrollment_effective, champion_digest
    FROM funded_shadow_enrollment e
   WHERE e.id = NEW.enrollment_id;
  IF latest_state IS DISTINCT FROM 'SHADOW' THEN
    RAISE EXCEPTION 'A funded shadow batch requires an active SHADOW enrollment';
  END IF;
  IF NEW.decision_at < enrollment_effective THEN
    RAISE EXCEPTION 'A funded shadow batch decision precedes its enrollment';
  END IF;
  IF NEW.champion_identity_digest IS DISTINCT FROM champion_digest THEN
    RAISE EXCEPTION 'A funded shadow batch must freeze the enrolled champion identity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_batch_validate ON funded_shadow_batch;
CREATE TRIGGER funded_shadow_batch_validate
  BEFORE INSERT ON funded_shadow_batch
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_batch_validate();

DROP TRIGGER IF EXISTS funded_shadow_batch_immutable ON funded_shadow_batch;
CREATE TRIGGER funded_shadow_batch_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_batch
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Attempts (immutable identity with database-owned deadline)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_attempt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_version TEXT NOT NULL CHECK(attempt_version = 'funded-shadow-attempt-v1'),
  batch_id UUID NOT NULL,
  enrollment_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  run_id UUID NOT NULL,
  account_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  session_date DATE NOT NULL,
  decision_sequence INTEGER CHECK(decision_sequence IS NULL OR decision_sequence > 0),
  decision_input_digest TEXT CHECK(decision_input_digest IS NULL OR decision_input_digest ~ '^[a-f0-9]{64}$'),
  champion_action TEXT NOT NULL CHECK(champion_action IN ('SUBMIT','DECLINE','DEFER','UNAVAILABLE')),
  decision_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempt_digest TEXT NOT NULL CHECK(attempt_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT funded_shadow_attempt_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_shadow_attempt_input_check CHECK(
    (decision_sequence IS NULL AND decision_input_digest IS NULL AND champion_action = 'UNAVAILABLE') OR
    (decision_sequence IS NOT NULL AND decision_input_digest IS NOT NULL AND champion_action <> 'UNAVAILABLE')
  ),
  CONSTRAINT funded_shadow_attempt_deadline_check CHECK(deadline_at > decision_at),
  CONSTRAINT funded_shadow_attempt_batch_fk
    FOREIGN KEY (batch_id, market_id, currency)
    REFERENCES funded_shadow_batch(id, market_id, currency),
  CONSTRAINT funded_shadow_attempt_enrollment_fk
    FOREIGN KEY (enrollment_id, market_id, currency)
    REFERENCES funded_shadow_enrollment(id, market_id, currency),
  CONSTRAINT funded_shadow_attempt_run_fk
    FOREIGN KEY (run_id, market_id) REFERENCES paper_bot_run(id, market_id),
  CONSTRAINT funded_shadow_attempt_account_fk
    FOREIGN KEY (run_id, account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency),
  CONSTRAINT funded_shadow_attempt_observation_fk
    FOREIGN KEY (run_id, observation_id)
    REFERENCES paper_signal_observation(run_id, id),
  UNIQUE (enrollment_id, run_id, observation_id),
  UNIQUE (batch_id, observation_id),
  UNIQUE (attempt_digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS funded_shadow_attempt_id_enrollment_uq
  ON funded_shadow_attempt(id, enrollment_id);

CREATE UNIQUE INDEX IF NOT EXISTS funded_shadow_attempt_id_batch_uq
  ON funded_shadow_attempt(id, batch_id);

CREATE INDEX IF NOT EXISTS funded_shadow_attempt_enrollment_idx
  ON funded_shadow_attempt(enrollment_id, decision_at DESC);

CREATE INDEX IF NOT EXISTS funded_shadow_attempt_deadline_idx
  ON funded_shadow_attempt(deadline_at);

CREATE OR REPLACE FUNCTION funded_shadow_attempt_validate()
RETURNS trigger AS $$
DECLARE
  lag_ms INTEGER;
  enrollment_effective TIMESTAMPTZ;
  batch_decision TIMESTAMPTZ;
  decision_matches INTEGER;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT p.max_prediction_lag_ms, e.effective_from
    INTO lag_ms, enrollment_effective
    FROM funded_shadow_enrollment e
    JOIN funded_shadow_gate_policy p ON p.id = e.gate_policy_id
   WHERE e.id = NEW.enrollment_id;
  IF lag_ms IS NULL THEN
    RAISE EXCEPTION 'A funded shadow attempt requires an enrolled gate policy';
  END IF;
  NEW.deadline_at := NEW.decision_at + (lag_ms * interval '1 millisecond');
  SELECT b.decision_at INTO batch_decision
    FROM funded_shadow_batch b
   WHERE b.id = NEW.batch_id;
  IF batch_decision IS NULL OR batch_decision <> NEW.decision_at THEN
    RAISE EXCEPTION 'A funded shadow attempt must share its batch decision clock';
  END IF;
  IF NEW.decision_at < enrollment_effective THEN
    RAISE EXCEPTION 'A funded shadow attempt decision precedes its enrollment';
  END IF;
  IF NEW.decision_sequence IS NOT NULL THEN
    SELECT count(*) INTO decision_matches
      FROM funded_decision_evidence d
     WHERE d.run_id = NEW.run_id
       AND d.observation_id = NEW.observation_id
       AND d.sequence = NEW.decision_sequence
       AND d.content_digest = NEW.decision_input_digest
       AND d.market_id = NEW.market_id
       AND d.currency = NEW.currency;
    IF decision_matches = 0 THEN
      RAISE EXCEPTION 'A funded shadow attempt must bind a durable champion decision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_attempt_validate ON funded_shadow_attempt;
CREATE TRIGGER funded_shadow_attempt_validate
  BEFORE INSERT ON funded_shadow_attempt
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_attempt_validate();

DROP TRIGGER IF EXISTS funded_shadow_attempt_immutable ON funded_shadow_attempt;
CREATE TRIGGER funded_shadow_attempt_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_attempt
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Batch membership (append-only before projection)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_batch_member (
  batch_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  observation_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  member_digest TEXT NOT NULL CHECK(member_digest ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE (batch_id, observation_id),
  CONSTRAINT funded_shadow_batch_member_batch_fk
    FOREIGN KEY (batch_id) REFERENCES funded_shadow_batch(id),
  CONSTRAINT funded_shadow_batch_member_attempt_fk
    FOREIGN KEY (attempt_id, batch_id)
    REFERENCES funded_shadow_attempt(id, batch_id)
);

CREATE OR REPLACE FUNCTION funded_shadow_batch_member_validate()
RETURNS trigger AS $$
DECLARE
  batch_decision TIMESTAMPTZ;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT b.decision_at INTO batch_decision
    FROM funded_shadow_batch b
   WHERE b.id = NEW.batch_id;
  IF batch_decision IS NULL THEN
    RAISE EXCEPTION 'A funded shadow member requires its batch';
  END IF;
  -- Membership stays append-only until the batch is projected. A decision that
  -- arrives after projection is refused and counted as a late input; a
  -- prediction can never be recorded after its deadline because the FP02
  -- forward-prediction boundary independently refuses it.
  IF EXISTS (SELECT 1 FROM funded_shadow_batch_projection p WHERE p.batch_id = NEW.batch_id) THEN
    RAISE EXCEPTION 'A projected funded shadow batch is closed to new members';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_batch_member_validate ON funded_shadow_batch_member;
CREATE TRIGGER funded_shadow_batch_member_validate
  BEFORE INSERT ON funded_shadow_batch_member
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_batch_member_validate();

DROP TRIGGER IF EXISTS funded_shadow_batch_member_immutable ON funded_shadow_batch_member;
CREATE TRIGGER funded_shadow_batch_member_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_batch_member
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Terminal attempt results (append-only, one per attempt)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_attempt_result (
  attempt_id UUID PRIMARY KEY,
  enrollment_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  disposition TEXT NOT NULL CHECK(disposition IN ('TIMELY_PREDICTION','MISSED_DEADLINE','INVALID_IDENTITY','INFERENCE_FAILURE','INPUT_UNAVAILABLE')),
  prediction_id UUID,
  prediction_digest TEXT CHECK(prediction_digest IS NULL OR prediction_digest ~ '^[a-f0-9]{64}$'),
  failure_reason TEXT CHECK(failure_reason IS NULL OR failure_reason IN (
    'DECISION_MISSING','DECISION_NOT_V2','DECISION_CONTENT_INVALID',
    'DECISION_DIGEST_MISMATCH','DECISION_SEQUENCE_MISMATCH',
    'MARKET_CURRENCY_MISMATCH','MODEL_IDENTITY_MISMATCH','MODEL_NOT_INACTIVE',
    'MODEL_NOT_FOUND','PREDICTION_CONFLICT','PREDICTION_MISSING',
    'PREDICTION_LATE','PREDICTION_INVALID_IDENTITY','PREDICTION_INFERENCE_FAILED',
    'PREDICTION_INPUT_UNAVAILABLE','PREDICTION_NOT_RETAINED','DEADLINE_EXPIRED',
    'ENGINE_FAILED','INVALID_DIAGNOSTIC','OWNERSHIP_REFUSAL',
    'BATCH_ALREADY_CLOSED','LATE_INPUT','INTERNAL_ERROR'
  )),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  result_digest TEXT NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT funded_shadow_attempt_result_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_shadow_attempt_result_pairing_check CHECK(
    (disposition = 'TIMELY_PREDICTION' AND prediction_id IS NOT NULL AND prediction_digest IS NOT NULL AND failure_reason IS NULL) OR
    (disposition <> 'TIMELY_PREDICTION' AND prediction_id IS NULL AND prediction_digest IS NULL AND failure_reason IS NOT NULL)
  ),
  CONSTRAINT funded_shadow_attempt_result_attempt_fk
    FOREIGN KEY (attempt_id, enrollment_id)
    REFERENCES funded_shadow_attempt(id, enrollment_id),
  CONSTRAINT funded_shadow_attempt_result_prediction_fk
    FOREIGN KEY (prediction_id) REFERENCES funded_execution_prediction(id),
  UNIQUE (result_digest)
);

CREATE INDEX IF NOT EXISTS funded_shadow_attempt_result_enrollment_idx
  ON funded_shadow_attempt_result(enrollment_id, disposition);

CREATE OR REPLACE FUNCTION funded_shadow_attempt_result_validate()
RETURNS trigger AS $$
DECLARE
  attempt RECORD;
  prediction RECORD;
  challenger_model UUID;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT a.*, e.challenger_model_id
    INTO attempt
    FROM funded_shadow_attempt a
    JOIN funded_shadow_enrollment e ON e.id = a.enrollment_id
   WHERE a.id = NEW.attempt_id;
  IF attempt.id IS NULL THEN
    RAISE EXCEPTION 'A funded shadow result requires its attempt';
  END IF;
  IF NEW.enrollment_id <> attempt.enrollment_id
     OR NEW.market_id <> attempt.market_id
     OR NEW.currency <> attempt.currency THEN
    RAISE EXCEPTION 'A funded shadow result must match its attempt ownership';
  END IF;
  IF NEW.disposition = 'MISSED_DEADLINE'
     AND clock_timestamp() < attempt.deadline_at THEN
    RAISE EXCEPTION 'A funded shadow attempt cannot miss its deadline before it expires';
  END IF;
  IF NEW.disposition = 'TIMELY_PREDICTION' THEN
    SELECT * INTO prediction
      FROM funded_execution_prediction
     WHERE id = NEW.prediction_id;
    IF prediction.id IS NULL THEN
      RAISE EXCEPTION 'A timely funded shadow result requires its durable prediction';
    END IF;
    IF prediction.model_id <> attempt.challenger_model_id
       OR prediction.run_id <> attempt.run_id
       OR prediction.observation_id <> attempt.observation_id
       OR prediction.decision_sequence <> attempt.decision_sequence
       OR prediction.decision_input_digest <> attempt.decision_input_digest
       OR prediction.market_id <> attempt.market_id
       OR prediction.currency <> attempt.currency
       OR prediction.source_kind <> 'LIVE_PAPER'
       OR prediction.prediction_at > attempt.deadline_at THEN
      RAISE EXCEPTION 'A timely funded shadow result must bind its exact prediction identity';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_attempt_result_validate ON funded_shadow_attempt_result;
CREATE TRIGGER funded_shadow_attempt_result_validate
  BEFORE INSERT ON funded_shadow_attempt_result
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_attempt_result_validate();

DROP TRIGGER IF EXISTS funded_shadow_attempt_result_immutable ON funded_shadow_attempt_result;
CREATE TRIGGER funded_shadow_attempt_result_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_attempt_result
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Closed-batch counterfactual projection (immutable, one per batch)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_batch_projection (
  batch_id UUID PRIMARY KEY,
  projection_version TEXT NOT NULL CHECK(projection_version = 'funded-shadow-projection-v1'),
  enrollment_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  batch_disposition TEXT NOT NULL CHECK(batch_disposition IN ('CHALLENGER_ORDER','FALLBACK_CHAMPION_ORDER')),
  fallback_reason TEXT,
  ordered_attempt_ids UUID[] NOT NULL CHECK(cardinality(ordered_attempt_ids) BETWEEN 1 AND 500),
  prediction_coverage NUMERIC(6,5) NOT NULL CHECK(prediction_coverage BETWEEN 0 AND 1),
  order_changes INTEGER NOT NULL CHECK(order_changes >= 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  projection_digest TEXT NOT NULL CHECK(projection_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT funded_shadow_batch_projection_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_shadow_batch_projection_fallback_check CHECK(
    (batch_disposition = 'CHALLENGER_ORDER' AND fallback_reason IS NULL) OR
    (batch_disposition = 'FALLBACK_CHAMPION_ORDER' AND fallback_reason IS NOT NULL)
  ),
  CONSTRAINT funded_shadow_batch_projection_batch_fk
    FOREIGN KEY (batch_id, enrollment_id)
    REFERENCES funded_shadow_batch(id, enrollment_id),
  UNIQUE (projection_digest)
);

CREATE OR REPLACE FUNCTION funded_shadow_batch_projection_validate()
RETURNS trigger AS $$
DECLARE
  lag_ms INTEGER;
  batch_decision TIMESTAMPTZ;
  batch_run UUID;
  later_decision BOOLEAN;
  member_count INTEGER;
  terminal_count INTEGER;
  ordered_count INTEGER;
  distinct_count INTEGER;
  missing_attempt INTEGER;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT p.max_prediction_lag_ms, b.decision_at, b.run_id
    INTO lag_ms, batch_decision, batch_run
    FROM funded_shadow_batch b
    JOIN funded_shadow_enrollment e ON e.id = b.enrollment_id
    JOIN funded_shadow_gate_policy p ON p.id = e.gate_policy_id
   WHERE b.id = NEW.batch_id;
  IF batch_decision IS NULL THEN
    RAISE EXCEPTION 'A funded shadow projection requires its batch';
  END IF;
  -- A batch closes when its prediction deadline has passed or when the run has
  -- provably committed a later simultaneous decision clock, whichever is first.
  SELECT EXISTS (
    SELECT 1 FROM funded_decision_evidence d
     WHERE d.run_id = batch_run AND d.decision_at > batch_decision
  ) INTO later_decision;
  IF clock_timestamp() < batch_decision + (lag_ms * interval '1 millisecond')
     AND NOT later_decision THEN
    RAISE EXCEPTION 'A funded shadow batch cannot be projected before it closes';
  END IF;
  SELECT count(*) INTO member_count
    FROM funded_shadow_batch_member m WHERE m.batch_id = NEW.batch_id;
  SELECT count(*) INTO terminal_count
    FROM funded_shadow_batch_member m
    JOIN funded_shadow_attempt_result r ON r.attempt_id = m.attempt_id
   WHERE m.batch_id = NEW.batch_id;
  IF member_count = 0 OR terminal_count <> member_count THEN
    RAISE EXCEPTION 'A funded shadow projection requires a terminal result for every member';
  END IF;
  SELECT count(*) INTO ordered_count
    FROM unnest(NEW.ordered_attempt_ids) AS id;
  SELECT count(DISTINCT id) INTO distinct_count
    FROM unnest(NEW.ordered_attempt_ids) AS id;
  IF ordered_count <> member_count OR distinct_count <> member_count THEN
    RAISE EXCEPTION 'A funded shadow projection must order every member exactly once';
  END IF;
  SELECT 1 INTO missing_attempt
    FROM unnest(NEW.ordered_attempt_ids) AS id
   WHERE NOT EXISTS (
     SELECT 1 FROM funded_shadow_batch_member m
      WHERE m.batch_id = NEW.batch_id AND m.attempt_id = id
   )
   LIMIT 1;
  IF missing_attempt IS NOT NULL THEN
    RAISE EXCEPTION 'A funded shadow projection contains a foreign attempt';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_batch_projection_validate ON funded_shadow_batch_projection;
CREATE TRIGGER funded_shadow_batch_projection_validate
  BEFORE INSERT ON funded_shadow_batch_projection
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_batch_projection_validate();

DROP TRIGGER IF EXISTS funded_shadow_batch_projection_immutable ON funded_shadow_batch_projection;
CREATE TRIGGER funded_shadow_batch_projection_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_batch_projection
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Independent canonical outcome labels (append-only, one per attempt)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_label (
  attempt_id UUID PRIMARY KEY,
  label_version TEXT NOT NULL CHECK(label_version = 'funded-shadow-label-v1'),
  enrollment_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  status TEXT NOT NULL CHECK(status IN ('POSITIVE','NEGATIVE','UNRESOLVED')),
  r_multiple NUMERIC(20,8),
  label_available_at TIMESTAMPTZ,
  unresolved_reason TEXT CHECK(unresolved_reason IS NULL OR unresolved_reason IN ('CANONICAL_QUOTE_OUTCOME_NOT_RETAINED','R_MULTIPLE_NOT_RETAINED')),
  evidence_execution_id UUID REFERENCES paper_execution(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  label_digest TEXT NOT NULL CHECK(label_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT funded_shadow_label_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_shadow_label_pairing_check CHECK(
    (status = 'UNRESOLVED' AND r_multiple IS NULL AND label_available_at IS NULL AND unresolved_reason IS NOT NULL AND evidence_execution_id IS NULL) OR
    (status <> 'UNRESOLVED' AND r_multiple IS NOT NULL AND label_available_at IS NOT NULL AND unresolved_reason IS NULL AND evidence_execution_id IS NOT NULL)
  ),
  CONSTRAINT funded_shadow_label_sign_check CHECK(
    (status = 'POSITIVE' AND r_multiple > 0) OR
    (status = 'NEGATIVE' AND r_multiple <= 0) OR
    (status = 'UNRESOLVED')
  ),
  CONSTRAINT funded_shadow_label_attempt_fk
    FOREIGN KEY (attempt_id, enrollment_id)
    REFERENCES funded_shadow_attempt(id, enrollment_id),
  UNIQUE (label_digest)
);

CREATE OR REPLACE FUNCTION funded_shadow_label_validate()
RETURNS trigger AS $$
DECLARE
  attempt RECORD;
  run_status TEXT;
BEGIN
  NEW.recorded_at := clock_timestamp();
  SELECT * INTO attempt FROM funded_shadow_attempt WHERE id = NEW.attempt_id;
  IF attempt.id IS NULL THEN
    RAISE EXCEPTION 'A funded shadow label requires its attempt';
  END IF;
  IF NEW.enrollment_id <> attempt.enrollment_id
     OR NEW.market_id <> attempt.market_id
     OR NEW.currency <> attempt.currency THEN
    RAISE EXCEPTION 'A funded shadow label must match its attempt ownership';
  END IF;
  IF NEW.label_available_at IS NOT NULL
     AND NEW.label_available_at > NEW.recorded_at THEN
    RAISE EXCEPTION 'A funded shadow label cannot be available in the future';
  END IF;
  IF NEW.status <> 'UNRESOLVED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM paper_execution e
       WHERE e.id = NEW.evidence_execution_id
         AND e.observation_id = attempt.observation_id
         AND e.model = 'QUOTE'
         AND e.status = 'CLOSED'
         AND e.r_multiple IS NOT NULL
         AND date_trunc('milliseconds', e.exit_time) = NEW.label_available_at
    ) THEN
      RAISE EXCEPTION 'A resolved funded shadow label requires its independent canonical outcome';
    END IF;
  ELSE
    SELECT r.status INTO run_status
      FROM paper_bot_run r WHERE r.id = attempt.run_id;
    IF run_status IS DISTINCT FROM 'COMPLETED' THEN
      RAISE EXCEPTION 'An unresolved funded shadow label requires a completed run';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_label_validate ON funded_shadow_label;
CREATE TRIGGER funded_shadow_label_validate
  BEFORE INSERT ON funded_shadow_label
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_label_validate();

DROP TRIGGER IF EXISTS funded_shadow_label_immutable ON funded_shadow_label;
CREATE TRIGGER funded_shadow_label_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_label
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Reproducible report snapshots (immutable)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL,
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  as_of TIMESTAMPTZ NOT NULL,
  report JSONB NOT NULL,
  report_digest TEXT NOT NULL CHECK(report_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT funded_shadow_report_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_shadow_report_enrollment_fk
    FOREIGN KEY (enrollment_id, market_id, currency)
    REFERENCES funded_shadow_enrollment(id, market_id, currency),
  CONSTRAINT funded_shadow_report_no_authority_check CHECK(
    jsonb_typeof(report) = 'object' AND
    report->>'promotionAuthorized' = 'false' AND
    report->>'authorityEffect' = 'NONE'
  ),
  UNIQUE (report_digest)
);

CREATE INDEX IF NOT EXISTS funded_shadow_report_enrollment_idx
  ON funded_shadow_report(enrollment_id, created_at DESC);

CREATE OR REPLACE FUNCTION funded_shadow_report_validate()
RETURNS trigger AS $$
BEGIN
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_report_validate ON funded_shadow_report;
CREATE TRIGGER funded_shadow_report_validate
  BEFORE INSERT ON funded_shadow_report
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_report_validate();

DROP TRIGGER IF EXISTS funded_shadow_report_immutable ON funded_shadow_report;
CREATE TRIGGER funded_shadow_report_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_report
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Observer receipts (append-only operational evidence)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funded_shadow_observer_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  kind TEXT NOT NULL CHECK(kind IN ('LEASE_CONTENDED','LEASE_ACQUIRED','OBSERVER_FAILURE','RECONCILE_FAILURE','OWNERSHIP_REFUSAL','LATE_INPUT')),
  detail TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT funded_shadow_observer_event_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  )
);

CREATE INDEX IF NOT EXISTS funded_shadow_observer_event_market_idx
  ON funded_shadow_observer_event(market_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION funded_shadow_observer_event_validate()
RETURNS trigger AS $$
BEGIN
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_shadow_observer_event_validate ON funded_shadow_observer_event;
CREATE TRIGGER funded_shadow_observer_event_validate
  BEFORE INSERT ON funded_shadow_observer_event
  FOR EACH ROW EXECUTE FUNCTION funded_shadow_observer_event_validate();

DROP TRIGGER IF EXISTS funded_shadow_observer_event_immutable ON funded_shadow_observer_event;
CREATE TRIGGER funded_shadow_observer_event_immutable
  BEFORE UPDATE OR DELETE ON funded_shadow_observer_event
  FOR EACH ROW EXECUTE FUNCTION reject_funded_shadow_mutation();

-- ============================================================================
-- Schema version
-- ============================================================================
INSERT INTO foundation_schema_version (version, description)
VALUES (136, 'Prospective funded champion/challenger shadow observation')
ON CONFLICT (version) DO NOTHING;
