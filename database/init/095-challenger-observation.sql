-- WP04: inactive challenger observation is a separate, observation-only evidence path.
-- Experiment specifications and terminal outcomes are immutable. Lifecycle state is
-- reconstructed from the append-only transition stream so direct UPDATEs cannot
-- skip authorization or rewrite an interval.

ALTER TABLE paper_signal_observation
  ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION stamp_paper_observation_capture()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.captured_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS paper_signal_observation_capture ON paper_signal_observation;
CREATE TRIGGER paper_signal_observation_capture
BEFORE INSERT ON paper_signal_observation
FOR EACH ROW EXECUTE FUNCTION stamp_paper_observation_capture();

CREATE TABLE IF NOT EXISTS challenger_experiment (
  id UUID PRIMARY KEY,
  model_id UUID NOT NULL REFERENCES statistical_model(id) ON DELETE RESTRICT,
  model_version TEXT NOT NULL,
  artifact_hash TEXT NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK (currency IN ('CAD','USD')),
  scope JSONB NOT NULL CHECK (jsonb_typeof(scope)='object'),
  research_evidence JSONB NOT NULL CHECK (jsonb_typeof(research_evidence)='object'),
  baseline_identity_hash TEXT NOT NULL CHECK (baseline_identity_hash ~ '^[a-f0-9]{64}$'),
  acceptance_plan_hash TEXT NOT NULL CHECK (acceptance_plan_hash ~ '^[a-f0-9]{64}$'),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  max_prediction_lag_ms INTEGER NOT NULL CHECK (max_prediction_lag_ms BETWEEN 1 AND 30000),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  registration_request_id TEXT NOT NULL CHECK (length(registration_request_id) BETWEEN 1 AND 200),
  registration_request_hash TEXT NOT NULL CHECK (registration_request_hash ~ '^[a-f0-9]{64}$'),
  CHECK (ends_at > starts_at),
  CHECK ((market_id='CA_TSX' AND currency='CAD') OR (market_id='US_EQUITIES' AND currency='USD')),
  UNIQUE (registration_request_id)
);

CREATE INDEX IF NOT EXISTS challenger_experiment_market_idx
  ON challenger_experiment(market_id, registered_at DESC);

CREATE OR REPLACE FUNCTION challenger_experiment_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'challenger experiment specifications are immutable';
END;
$$;

DROP TRIGGER IF EXISTS challenger_experiment_immutable ON challenger_experiment;
CREATE TRIGGER challenger_experiment_immutable
BEFORE UPDATE OR DELETE ON challenger_experiment
FOR EACH ROW EXECUTE FUNCTION challenger_experiment_reject_mutation();

CREATE TABLE IF NOT EXISTS challenger_experiment_transition (
  experiment_id UUID NOT NULL REFERENCES challenger_experiment(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK (action IN ('START','PAUSE','RESUME','END','REVOKE')),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','PAUSED','ENDED','REVOKED')),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (experiment_id, sequence),
  UNIQUE (experiment_id, request_id)
);

CREATE INDEX IF NOT EXISTS challenger_experiment_transition_latest_idx
  ON challenger_experiment_transition(experiment_id, sequence DESC);

CREATE OR REPLACE FUNCTION challenger_experiment_transition_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'challenger experiment transitions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS challenger_experiment_transition_immutable ON challenger_experiment_transition;
CREATE TRIGGER challenger_experiment_transition_immutable
BEFORE UPDATE OR DELETE ON challenger_experiment_transition
FOR EACH ROW EXECUTE FUNCTION challenger_experiment_transition_reject_mutation();

CREATE TABLE IF NOT EXISTS challenger_attempt (
  experiment_id UUID NOT NULL REFERENCES challenger_experiment(id) ON DELETE RESTRICT,
  observation_id UUID NOT NULL REFERENCES paper_signal_observation(id) ON DELETE RESTRICT,
  model_version TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deadline_at TIMESTAMPTZ NOT NULL,
  input_snapshot JSONB NOT NULL CHECK (jsonb_typeof(input_snapshot)='object'),
  PRIMARY KEY (experiment_id, observation_id),
  CHECK (deadline_at > observed_at)
);

CREATE INDEX IF NOT EXISTS challenger_unfinished_deadline
  ON challenger_attempt(deadline_at, experiment_id, observation_id);

CREATE OR REPLACE FUNCTION challenger_attempt_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  experiment_row RECORD;
  observation_market TEXT;
  observation_strategy TEXT;
  observation_strategy_version TEXT;
  observation_profile_config UUID;
  observation_timestamp TIMESTAMPTZ;
BEGIN
  SELECT e.max_prediction_lag_ms,e.model_version,e.market_id,e.scope,e.starts_at,e.ends_at
    INTO experiment_row
    FROM challenger_experiment e
   WHERE e.id=NEW.experiment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'challenger experiment not found';
  END IF;
  SELECT r.market_id,o.strategy_key,o.strategy_version,o.profile_config_id,o.signal_timestamp
    INTO observation_market,observation_strategy,observation_strategy_version,observation_profile_config,observation_timestamp
    FROM paper_signal_observation o
    JOIN paper_bot_run r ON r.id=o.run_id
   WHERE o.id=NEW.observation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paper signal observation not found';
  END IF;
  IF observation_market IS DISTINCT FROM experiment_row.market_id
     OR NEW.model_version IS DISTINCT FROM experiment_row.model_version
     OR NEW.observed_at IS DISTINCT FROM observation_timestamp
     OR (NEW.input_snapshot->>'marketId') IS DISTINCT FROM observation_market
     OR (NEW.input_snapshot->>'strategy') IS DISTINCT FROM observation_strategy
     OR (NEW.input_snapshot->>'profileConfigId') IS DISTINCT FROM observation_profile_config::text
     OR (experiment_row.scope->>'strategy') IS DISTINCT FROM observation_strategy
     OR (experiment_row.scope->>'strategyVersion') IS DISTINCT FROM observation_strategy_version
     OR (experiment_row.scope->>'profileConfigId') IS DISTINCT FROM observation_profile_config::text
  THEN
    RAISE EXCEPTION 'challenger attempt scope or identity mismatch';
  END IF;
  IF NEW.deadline_at IS DISTINCT FROM
     NEW.observed_at + (experiment_row.max_prediction_lag_ms * interval '1 millisecond')
  THEN
    RAISE EXCEPTION 'challenger attempt deadline does not match experiment policy';
  END IF;
  IF NEW.observed_at < experiment_row.starts_at OR NEW.observed_at >= experiment_row.ends_at THEN
    RAISE EXCEPTION 'challenger attempt is outside the frozen experiment window';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS challenger_attempt_validate_insert ON challenger_attempt;
CREATE TRIGGER challenger_attempt_validate_insert
BEFORE INSERT ON challenger_attempt
FOR EACH ROW EXECUTE FUNCTION challenger_attempt_validate();

CREATE OR REPLACE FUNCTION challenger_attempt_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'challenger attempts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS challenger_attempt_immutable ON challenger_attempt;
CREATE TRIGGER challenger_attempt_immutable
BEFORE UPDATE OR DELETE ON challenger_attempt
FOR EACH ROW EXECUTE FUNCTION challenger_attempt_reject_mutation();

CREATE TABLE IF NOT EXISTS challenger_outcome (
  experiment_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREDICTED','MISSED_DEADLINE','ENGINE_FAILED','INPUT_INVALID','EXPERIMENT_REVOKED')),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome JSONB NOT NULL CHECK (jsonb_typeof(outcome)='object'),
  PRIMARY KEY (experiment_id, observation_id),
  FOREIGN KEY (experiment_id, observation_id)
    REFERENCES challenger_attempt(experiment_id, observation_id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION challenger_outcome_validate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deadline TIMESTAMPTZ;
BEGIN
  SELECT deadline_at INTO deadline
    FROM challenger_attempt
   WHERE experiment_id=NEW.experiment_id AND observation_id=NEW.observation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'challenger attempt not found'; END IF;
  IF NEW.outcome->>'status' IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'challenger outcome status does not match its payload';
  END IF;
  -- The database clock is authoritative. A caller cannot supply an earlier time
  -- to turn an overdue prediction into prospective evidence.
  NEW.completed_at := clock_timestamp();
  NEW.outcome := jsonb_set(
    NEW.outcome,
    '{completedAt}',
    to_jsonb(
      to_char(
        NEW.completed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    ),
    true
  );
  IF NEW.status='PREDICTED' AND NEW.completed_at >= deadline THEN
    RAISE EXCEPTION 'challenger prediction completed after deadline';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS challenger_outcome_validate_insert ON challenger_outcome;
CREATE TRIGGER challenger_outcome_validate_insert
BEFORE INSERT ON challenger_outcome
FOR EACH ROW EXECUTE FUNCTION challenger_outcome_validate();

CREATE OR REPLACE FUNCTION challenger_outcome_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'challenger outcomes are immutable';
END;
$$;

DROP TRIGGER IF EXISTS challenger_outcome_immutable ON challenger_outcome;
CREATE TRIGGER challenger_outcome_immutable
BEFORE UPDATE OR DELETE ON challenger_outcome
FOR EACH ROW EXECUTE FUNCTION challenger_outcome_reject_mutation();

COMMENT ON TABLE challenger_experiment IS
  'Explicitly enrolled inactive-model experiment specifications; observation only, never execution authority.';
COMMENT ON TABLE challenger_attempt IS
  'Immutable future observation attempts with original input and hard prediction deadline.';
COMMENT ON TABLE challenger_outcome IS
  'One immutable terminal result per challenger attempt, including prospective failures.';

INSERT INTO foundation_schema_version(version, description)
VALUES (95, 'Prospective inactive challenger observation evidence')
ON CONFLICT(version) DO NOTHING;
