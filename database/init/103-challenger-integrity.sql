-- Correct immutable challenger scope ownership without rewriting applied migrations.
ALTER TABLE challenger_model_scope DROP CONSTRAINT IF EXISTS challenger_model_scope_scope_hash_key;
ALTER TABLE challenger_model_scope ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE challenger_model_scope ADD COLUMN IF NOT EXISTS source_id UUID;
ALTER TABLE challenger_model_scope ADD COLUMN IF NOT EXISTS source_digest TEXT;
ALTER TABLE challenger_model_scope ADD COLUMN IF NOT EXISTS artifact_hash TEXT;
ALTER TABLE challenger_model_scope ADD COLUMN IF NOT EXISTS training_label_cutoff_at TIMESTAMPTZ;

CREATE TABLE challenger_capture_failure (
 experiment_id UUID NOT NULL REFERENCES challenger_experiment(id),
 observation_id UUID NOT NULL REFERENCES paper_signal_observation(id),
 reason TEXT NOT NULL CHECK(reason IN ('CAPTURE_FAILED','INPUT_INVALID')),
 captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(experiment_id,observation_id)
);
CREATE TRIGGER challenger_capture_failure_immutable BEFORE UPDATE OR DELETE ON challenger_capture_failure
FOR EACH ROW EXECUTE FUNCTION reject_challenger_acceptance_mutation();

CREATE OR REPLACE FUNCTION stamp_challenger_label_availability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.label_available_at := clock_timestamp();
 IF NEW.exit_at > NEW.label_available_at THEN RAISE EXCEPTION 'CHALLENGER_LABEL_FUTURE_EXIT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER challenger_label_availability_clock BEFORE INSERT ON challenger_label_evidence
FOR EACH ROW EXECUTE FUNCTION stamp_challenger_label_availability();

CREATE OR REPLACE FUNCTION stamp_challenger_attempt_recording() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.recorded_at := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER challenger_attempt_recording_clock BEFORE INSERT ON challenger_attempt
FOR EACH ROW EXECUTE FUNCTION stamp_challenger_attempt_recording();

INSERT INTO foundation_schema_version(version,description)
VALUES(103,'Challenger immutable source scope and database-clock evidence') ON CONFLICT(version) DO NOTHING;
