CREATE TABLE IF NOT EXISTS strategy_definition (
  id UUID PRIMARY KEY,
  strategy_key TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  parameter_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(strategy_key, version)
);

CREATE TABLE IF NOT EXISTS scanner_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  strategy_definition_id UUID NOT NULL REFERENCES strategy_definition(id),
  enabled BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0),
  current_config_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scanner_profile_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES scanner_profile(id) ON DELETE CASCADE,
  config_version TEXT NOT NULL UNIQUE,
  parameters JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(profile_id, id)
);

DO $$ BEGIN
  ALTER TABLE scanner_profile ADD CONSTRAINT scanner_profile_current_config_fk
    FOREIGN KEY(current_config_id) REFERENCES scanner_profile_config(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS strategy_evaluation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES scanner_profile(id),
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  feature_snapshot_id UUID NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  strategy_key TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  previous_state TEXT NOT NULL,
  state TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  entry_reference NUMERIC,
  stop_reference NUMERIC,
  target_reference NUMERIC,
  estimated_rr NUMERIC,
  reason_codes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(profile_id, instrument_id, feature_snapshot_id),
  FOREIGN KEY(feature_snapshot_id, timestamp) REFERENCES feature_snapshot(id, timestamp)
);
CREATE INDEX IF NOT EXISTS strategy_evaluation_profile_latest_idx ON strategy_evaluation(profile_id, instrument_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS strategy_evaluation_opportunities_idx ON strategy_evaluation(instrument_id, timestamp DESC, score DESC);

ALTER TABLE strategy_signal ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES scanner_profile(id);
ALTER TABLE strategy_state_event ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES scanner_profile(id);
ALTER TABLE scanner_alert ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES scanner_profile(id);
ALTER TABLE strategy_signal DROP CONSTRAINT IF EXISTS strategy_signal_instrument_id_strategy_name_strategy_version_timestamp_key;
-- PostgreSQL preserves the generated _key suffix when truncating this legacy
-- constraint, which differs from truncating the long explicit name above.
ALTER TABLE strategy_signal DROP CONSTRAINT IF EXISTS strategy_signal_instrument_id_strategy_name_strategy_versio_key;
DROP INDEX IF EXISTS strategy_signal_profile_timestamp_uq;
CREATE UNIQUE INDEX strategy_signal_profile_timestamp_uq ON strategy_signal(profile_id, instrument_id, timestamp) WHERE profile_id IS NOT NULL;

INSERT INTO strategy_definition(id,strategy_key,version,name,description,enabled,parameter_schema) VALUES
('10000000-0000-4000-8000-000000000071','ORB_RETEST','1.0.0','Opening Range Breakout Retest','Breakout above the completed opening range followed by a supported retest.',true,'{"rvolAtTimeMin":"number","spreadHardMaxPct":"number","breakoutVolumeRatioMin":"number","retestTolerancePct":"number","scoreCutoff":"integer"}'),
('10000000-0000-4000-8000-000000000072','VWAP_HOLD','1.0.0','VWAP Hold','Bullish structure that pulls back to VWAP and confirms the hold.',true,'{"rvolAtTimeMin":"number","spreadHardMaxPct":"number","breakoutVolumeRatioMin":"number","retestTolerancePct":"number","scoreCutoff":"integer"}')
ON CONFLICT(id) DO NOTHING;

INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order) VALUES
('10000000-0000-4000-8000-000000000081','ORB Standard','10000000-0000-4000-8000-000000000071',true,0),
('10000000-0000-4000-8000-000000000082','VWAP Hold','10000000-0000-4000-8000-000000000072',true,1),
('10000000-0000-4000-8000-000000000083','ORB Conservative','10000000-0000-4000-8000-000000000071',true,2)
ON CONFLICT(id) DO NOTHING;

INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters) VALUES
('10000000-0000-4000-8000-000000000091','10000000-0000-4000-8000-000000000081','profile-orb-standard-v1','{"rvolAtTimeMin":1.5,"spreadHardMaxPct":0.25,"breakoutVolumeRatioMin":1.5,"retestTolerancePct":0.15,"scoreCutoff":0}'),
('10000000-0000-4000-8000-000000000092','10000000-0000-4000-8000-000000000082','profile-vwap-hold-v1','{"rvolAtTimeMin":1.5,"spreadHardMaxPct":0.25,"breakoutVolumeRatioMin":1.5,"retestTolerancePct":0.15,"scoreCutoff":0}'),
('10000000-0000-4000-8000-000000000093','10000000-0000-4000-8000-000000000083','profile-orb-conservative-v1','{"rvolAtTimeMin":2.0,"spreadHardMaxPct":0.15,"breakoutVolumeRatioMin":2.0,"retestTolerancePct":0.10,"scoreCutoff":70}')
ON CONFLICT(id) DO NOTHING;

UPDATE scanner_profile SET current_config_id=CASE id
  WHEN '10000000-0000-4000-8000-000000000081' THEN '10000000-0000-4000-8000-000000000091'::uuid
  WHEN '10000000-0000-4000-8000-000000000082' THEN '10000000-0000-4000-8000-000000000092'::uuid
  WHEN '10000000-0000-4000-8000-000000000083' THEN '10000000-0000-4000-8000-000000000093'::uuid END
WHERE id IN ('10000000-0000-4000-8000-000000000081','10000000-0000-4000-8000-000000000082','10000000-0000-4000-8000-000000000083');

INSERT INTO foundation_schema_version(version, description) VALUES(8,'Phase 8A scanner profiles and strategy lab') ON CONFLICT(version) DO NOTHING;
