-- Phase 4a retires evidence produced by execution models other than the
-- authoritative paper core. Historical artifacts remain readable; this ledger
-- records why each cited run was retired and which authoritative run replaced it.
CREATE TABLE IF NOT EXISTS execution_evidence_migration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_backtest_run_id UUID NOT NULL UNIQUE REFERENCES backtest_run(id),
  replacement_backtest_run_id UUID UNIQUE REFERENCES backtest_run(id),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING','RUNNING','REPLACED','UNREPLAYABLE_LEGACY','FAILED'
  )),
  reason TEXT,
  report JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (
    (status = 'REPLACED' AND replacement_backtest_run_id IS NOT NULL)
    OR (status <> 'REPLACED' AND replacement_backtest_run_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS calibration_evidence_migration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_calibration_run_id UUID NOT NULL UNIQUE REFERENCES calibration_run(id),
  replacement_calibration_run_id UUID UNIQUE REFERENCES calibration_run(id),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING','RUNNING','REPLACED','UNREPLAYABLE_LEGACY','FAILED'
  )),
  reason TEXT,
  report JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (
    (status = 'REPLACED' AND replacement_calibration_run_id IS NOT NULL)
    OR (status <> 'REPLACED' AND replacement_calibration_run_id IS NULL)
  )
);

ALTER TABLE ranking_research_run
  ADD COLUMN IF NOT EXISTS execution_model_version TEXT;

-- Discover the selective migration set before revoking anything. A row is
-- load-bearing when it supports an active model, a current qualification, or
-- an explicitly linked ranking activation.
INSERT INTO execution_evidence_migration (
  source_backtest_run_id, status, reason, report
)
SELECT r.id, 'PENDING', 'LEGACY_EXECUTION_EVIDENCE', jsonb_build_object(
  'activeStatisticalModelIds', COALESCE((
    SELECT jsonb_agg(m.id ORDER BY m.created_at)
    FROM statistical_model m WHERE m.backtest_run_id=r.id AND m.active
  ), '[]'::jsonb),
  'qualifiedProfileConfigIds', COALESCE((
    SELECT jsonb_agg(DISTINCT e.profile_config_id)
    FROM profile_config_evidence e
    WHERE e.backtest_run_id=r.id AND e.revoked_at IS NULL
      AND e.qualification='EVIDENCE_QUALIFIED'
  ), '[]'::jsonb),
  'activatedRankingFormulaVersions', COALESCE((
    SELECT jsonb_agg(f.version ORDER BY f.version)
    FROM ranking_formula f
    JOIN ranking_research_run s ON s.id=f.activation_research_run_id
    WHERE s.backtest_run_id=r.id AND f.status='ACTIVE'
  ), '[]'::jsonb)
)
FROM backtest_run r
WHERE r.execution_model_version IS DISTINCT FROM 'paper-execution-v1'
  AND (
    EXISTS (SELECT 1 FROM statistical_model m WHERE m.backtest_run_id=r.id AND m.active)
    OR EXISTS (
      SELECT 1 FROM profile_config_evidence e
      WHERE e.backtest_run_id=r.id AND e.revoked_at IS NULL
        AND e.qualification='EVIDENCE_QUALIFIED'
    )
    OR EXISTS (
      SELECT 1 FROM ranking_formula f
      JOIN ranking_research_run s ON s.id=f.activation_research_run_id
      WHERE s.backtest_run_id=r.id AND f.status='ACTIVE'
    )
  )
ON CONFLICT (source_backtest_run_id) DO NOTHING;

INSERT INTO calibration_evidence_migration (
  source_calibration_run_id, status, reason, report
)
SELECT c.id, 'PENDING', 'LEGACY_EXECUTION_CALIBRATION', jsonb_build_object(
  'profileConfigIds', COALESCE(jsonb_agg(pc.id ORDER BY pc.created_at), '[]'::jsonb)
)
FROM calibration_run c
JOIN scanner_profile_config pc ON pc.source_calibration_run_id=c.id
WHERE c.execution_model_version IS DISTINCT FROM 'paper-execution-v1'
GROUP BY c.id
ON CONFLICT (source_calibration_run_id) DO NOTHING;

-- Cut legacy dependencies over to a safe inactive/exploratory state before an
-- operator starts the potentially long replay. The ledger retains the exact
-- affected identifiers for the final migration report.
UPDATE statistical_model m
SET active=false,
    warnings=COALESCE(m.warnings, '[]'::jsonb) ||
      '["Deactivated by Phase 4a: source outcomes use retired execution semantics."]'::jsonb
FROM execution_evidence_migration x
WHERE x.source_backtest_run_id=m.backtest_run_id AND m.active;

UPDATE ranking_formula f
SET status='RESEARCH'
FROM ranking_research_run s, execution_evidence_migration x
WHERE f.activation_research_run_id=s.id
  AND s.backtest_run_id=x.source_backtest_run_id
  AND f.status='ACTIVE'
  AND f.version <> 'ranking-tiebreak-v1';

-- Permanent database guards. They intentionally use IS DISTINCT FROM so NULL
-- provenance is rejected instead of slipping through SQL three-valued logic.
CREATE OR REPLACE FUNCTION require_authoritative_statistical_evidence() RETURNS trigger AS $$
DECLARE source_version TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT NEW.active THEN RETURN NEW; END IF;
  SELECT execution_model_version INTO source_version
  FROM backtest_run WHERE id=NEW.backtest_run_id;
  IF source_version IS DISTINCT FROM 'paper-execution-v1' THEN
    RAISE EXCEPTION 'statistical model evidence must use paper-execution-v1';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS statistical_model_authoritative_evidence ON statistical_model;
CREATE TRIGGER statistical_model_authoritative_evidence
BEFORE INSERT OR UPDATE OF backtest_run_id, active ON statistical_model
FOR EACH ROW EXECUTE FUNCTION require_authoritative_statistical_evidence();

CREATE OR REPLACE FUNCTION require_authoritative_profile_evidence() RETURNS trigger AS $$
DECLARE source_version TEXT;
BEGIN
  SELECT execution_model_version INTO source_version
  FROM backtest_run WHERE id=NEW.backtest_run_id;
  IF NEW.revoked_at IS NULL AND source_version IS DISTINCT FROM 'paper-execution-v1' THEN
    RAISE EXCEPTION 'profile qualification must use paper-execution-v1';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profile_config_authoritative_evidence ON profile_config_evidence;
CREATE TRIGGER profile_config_authoritative_evidence
BEFORE INSERT OR UPDATE OF backtest_run_id, qualification, revoked_at
ON profile_config_evidence
FOR EACH ROW EXECUTE FUNCTION require_authoritative_profile_evidence();

CREATE OR REPLACE FUNCTION require_authoritative_calibration_source() RETURNS trigger AS $$
DECLARE source_version TEXT;
DECLARE source_status TEXT;
BEGIN
  IF NEW.source_calibration_run_id IS NULL THEN RETURN NEW; END IF;
  SELECT execution_model_version, status INTO source_version, source_status
  FROM calibration_run WHERE id=NEW.source_calibration_run_id;
  IF source_version IS DISTINCT FROM 'paper-execution-v1' OR source_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'applied calibration must be completed under paper-execution-v1';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profile_config_authoritative_calibration ON scanner_profile_config;
CREATE TRIGGER profile_config_authoritative_calibration
BEFORE INSERT OR UPDATE OF source_calibration_run_id ON scanner_profile_config
FOR EACH ROW EXECUTE FUNCTION require_authoritative_calibration_source();

CREATE OR REPLACE FUNCTION require_authoritative_ranking_study() RETURNS trigger AS $$
DECLARE source_version TEXT;
BEGIN
  SELECT execution_model_version INTO source_version
  FROM backtest_run WHERE id=NEW.backtest_run_id;
  IF source_version IS DISTINCT FROM 'paper-execution-v1' THEN
    RAISE EXCEPTION 'ranking research must use paper-execution-v1';
  END IF;
  NEW.execution_model_version := source_version;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ranking_study_authoritative_evidence ON ranking_research_run;
CREATE TRIGGER ranking_study_authoritative_evidence
BEFORE INSERT OR UPDATE OF backtest_run_id ON ranking_research_run
FOR EACH ROW EXECUTE FUNCTION require_authoritative_ranking_study();

CREATE OR REPLACE FUNCTION require_ranking_activation_evidence() RETURNS trigger AS $$
DECLARE source_version TEXT;
DECLARE study_status TEXT;
DECLARE eligible BOOLEAN;
BEGIN
  IF NEW.status <> 'ACTIVE' OR NEW.version = 'ranking-tiebreak-v1' THEN RETURN NEW; END IF;
  SELECT s.status, r.execution_model_version,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(s.results) AS result(value)
      WHERE result.value->>'formulaVersion'=NEW.version
        AND COALESCE((result.value->'gate'->>'eligibleForActivation')::boolean, false)
    )
  INTO study_status, source_version, eligible
  FROM ranking_research_run s
  JOIN backtest_run r ON r.id=s.backtest_run_id
  WHERE s.id=NEW.activation_research_run_id;
  IF study_status IS DISTINCT FROM 'COMPLETED'
     OR source_version IS DISTINCT FROM 'paper-execution-v1'
     OR eligible IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ranking activation requires eligible paper-execution-v1 research evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ranking_formula_authoritative_activation ON ranking_formula;
CREATE TRIGGER ranking_formula_authoritative_activation
BEFORE INSERT OR UPDATE OF status, activation_research_run_id ON ranking_formula
FOR EACH ROW EXECUTE FUNCTION require_ranking_activation_evidence();

INSERT INTO foundation_schema_version(version, description)
VALUES(33, 'Phase 4a existing evidence migration and permanent authority guards')
ON CONFLICT(version) DO NOTHING;
