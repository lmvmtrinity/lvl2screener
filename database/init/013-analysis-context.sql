ALTER TABLE strategy_definition ADD COLUMN IF NOT EXISTS analysis_kind TEXT NOT NULL DEFAULT 'SETUP';

-- Phase 0 baseline: record how every definition and profile was classified before
-- the setup/context split so the migration stays auditable and reversible.
CREATE TABLE IF NOT EXISTS analysis_migration_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope TEXT NOT NULL CHECK (scope IN ('DEFINITION','PROFILE')),
  subject_id UUID NOT NULL,
  subject_name TEXT NOT NULL,
  strategy_key TEXT NOT NULL,
  previous_kind TEXT NOT NULL,
  classified_kind TEXT NOT NULL CHECK (classified_kind IN ('SETUP','CONTEXT')),
  UNIQUE (scope, subject_id)
);

INSERT INTO analysis_migration_inventory (scope, subject_id, subject_name, strategy_key, previous_kind, classified_kind)
SELECT 'DEFINITION', d.id, d.name, d.strategy_key, d.analysis_kind,
       CASE WHEN d.strategy_key IN ('SECTOR_RELATIVE_STRENGTH','MARKET_RELATIVE_STRENGTH') THEN 'CONTEXT' ELSE 'SETUP' END
FROM strategy_definition d
ON CONFLICT (scope, subject_id) DO NOTHING;

INSERT INTO analysis_migration_inventory (scope, subject_id, subject_name, strategy_key, previous_kind, classified_kind)
SELECT 'PROFILE', p.id, p.name, d.strategy_key, d.analysis_kind,
       CASE WHEN d.strategy_key IN ('SECTOR_RELATIVE_STRENGTH','MARKET_RELATIVE_STRENGTH') THEN 'CONTEXT' ELSE 'SETUP' END
FROM scanner_profile p JOIN strategy_definition d ON d.id = p.strategy_definition_id
ON CONFLICT (scope, subject_id) DO NOTHING;
UPDATE strategy_definition SET analysis_kind = CASE
  WHEN strategy_key IN ('SECTOR_RELATIVE_STRENGTH','MARKET_RELATIVE_STRENGTH') THEN 'CONTEXT'
  ELSE 'SETUP'
END;
DO $$ BEGIN
  ALTER TABLE strategy_definition ADD CONSTRAINT strategy_definition_analysis_kind_check
    CHECK (analysis_kind IN ('SETUP','CONTEXT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE strategy_definition SET
  description='Outperformance versus a configured, stable sector benchmark.'
WHERE strategy_key='SECTOR_RELATIVE_STRENGTH';
UPDATE strategy_definition SET
  description='Outperformance versus a configured, stable broad-market benchmark.'
WHERE strategy_key='MARKET_RELATIVE_STRENGTH';

ALTER TABLE strategy_evaluation ADD COLUMN IF NOT EXISTS analysis_kind TEXT NOT NULL DEFAULT 'SETUP';
DO $$ BEGIN
  ALTER TABLE strategy_evaluation ADD CONSTRAINT strategy_evaluation_setup_only_check
    CHECK (analysis_kind = 'SETUP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS context_evaluation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES scanner_profile(id),
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  feature_snapshot_id UUID NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  signal_key TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('UNAVAILABLE','WEAK','NEUTRAL','STRONG','STALE')),
  context_score INTEGER NOT NULL CHECK(context_score BETWEEN 0 AND 100),
  observed_value NUMERIC,
  benchmark_instrument_id UUID REFERENCES instrument(id),
  benchmark_value NUMERIC,
  benchmark_timestamp TIMESTAMPTZ,
  lookback TEXT NOT NULL CHECK(lookback='SESSION_FROM_OPEN'),
  reason_codes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(profile_id, instrument_id, feature_snapshot_id),
  FOREIGN KEY(feature_snapshot_id, timestamp) REFERENCES feature_snapshot(id, timestamp)
);
CREATE INDEX IF NOT EXISTS context_evaluation_symbol_latest_idx
  ON context_evaluation(instrument_id, timestamp DESC);

INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order) VALUES
('10000000-0000-4000-8000-000000000084','Market Context','10000000-0000-4000-8000-000000000078',true,100),
('10000000-0000-4000-8000-000000000085','Sector Context','10000000-0000-4000-8000-000000000077',true,101)
ON CONFLICT(id) DO NOTHING;

INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters) VALUES
('10000000-0000-4000-8000-000000000094','10000000-0000-4000-8000-000000000084','profile-market-context-v1','{"relativeStrengthMinPct":0.5}'),
('10000000-0000-4000-8000-000000000095','10000000-0000-4000-8000-000000000085','profile-sector-context-v1','{"relativeStrengthMinPct":0.5}')
ON CONFLICT(id) DO NOTHING;

UPDATE scanner_profile SET current_config_id=CASE id
  WHEN '10000000-0000-4000-8000-000000000084' THEN '10000000-0000-4000-8000-000000000094'::uuid
  WHEN '10000000-0000-4000-8000-000000000085' THEN '10000000-0000-4000-8000-000000000095'::uuid END
WHERE id IN ('10000000-0000-4000-8000-000000000084','10000000-0000-4000-8000-000000000085');

CREATE OR REPLACE FUNCTION enforce_analysis_evaluation_kind() RETURNS trigger AS $$
DECLARE expected_kind TEXT;
BEGIN
  SELECT d.analysis_kind INTO expected_kind
  FROM scanner_profile p JOIN strategy_definition d ON d.id=p.strategy_definition_id
  WHERE p.id=NEW.profile_id;
  IF expected_kind IS DISTINCT FROM TG_ARGV[0] THEN
    RAISE EXCEPTION 'Profile % has analysis kind %, expected %', NEW.profile_id, expected_kind, TG_ARGV[0];
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS strategy_evaluation_kind_guard ON strategy_evaluation;
CREATE TRIGGER strategy_evaluation_kind_guard BEFORE INSERT OR UPDATE OF profile_id ON strategy_evaluation
FOR EACH ROW EXECUTE FUNCTION enforce_analysis_evaluation_kind('SETUP');
DROP TRIGGER IF EXISTS context_evaluation_kind_guard ON context_evaluation;
CREATE TRIGGER context_evaluation_kind_guard BEFORE INSERT OR UPDATE OF profile_id ON context_evaluation
FOR EACH ROW EXECUTE FUNCTION enforce_analysis_evaluation_kind('CONTEXT');

-- Benchmark instruments must stay distinguishable from daily candidates in every
-- reader, including captured-history replay.
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS benchmark_kind TEXT;
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS benchmark_sector TEXT;
DO $$ BEGIN
  ALTER TABLE instrument ADD CONSTRAINT instrument_benchmark_kind_check
    CHECK (benchmark_kind IS NULL OR benchmark_kind IN ('MARKET','SECTOR'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS instrument_benchmark_kind_idx ON instrument(benchmark_kind) WHERE benchmark_kind IS NOT NULL;

-- Context signals are never journal-eligible. NOT VALID keeps any pre-migration
-- row readable while rejecting every new write.
DO $$ BEGIN
  ALTER TABLE journal_trade ADD CONSTRAINT journal_trade_setup_only_check
    CHECK (strategy_name NOT IN ('SECTOR_RELATIVE_STRENGTH','MARKET_RELATIVE_STRENGTH')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO foundation_schema_version(version,description)
VALUES(13,'Setup/context analysis separation and stable benchmark support')
ON CONFLICT(version) DO NOTHING;
