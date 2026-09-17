-- New calibration jobs have one durable result identity. Legacy runs remain
-- unchanged and retain their original all-trial TEST reports.
ALTER TABLE calibration_run
  ADD COLUMN research_job_id UUID UNIQUE REFERENCES research_job(id),
  ADD COLUMN holdout_selection JSONB;

CREATE FUNCTION guard_calibration_holdout_selection() RETURNS trigger AS $$
BEGIN
  IF OLD.research_job_id IS DISTINCT FROM NEW.research_job_id THEN
    RAISE EXCEPTION 'Calibration job identity is immutable';
  END IF;
  IF OLD.holdout_selection IS NOT NULL AND
     OLD.holdout_selection IS DISTINCT FROM NEW.holdout_selection THEN
    RAISE EXCEPTION 'Calibration holdout selection is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calibration_holdout_selection_immutable
BEFORE UPDATE ON calibration_run
FOR EACH ROW EXECUTE FUNCTION guard_calibration_holdout_selection();

INSERT INTO foundation_schema_version(version,description)
VALUES(83,'Durable calibration job identity and frozen holdout selection')
ON CONFLICT(version) DO NOTHING;
