-- Deploy the four deterministic setup modules that shipped with code and a
-- strategy_definition (011) but never got a scanner_profile, so the engine only
-- ever evaluated ORB_RETEST and VWAP_HOLD. Profiles are the unit the engine
-- iterates, so a definition without one is dormant.

-- Declarations must match what each module actually reads (the invariant 014
-- established), otherwise the strategy lab renders no control for a parameter
-- the module depends on and the API pins it to its default forever.
UPDATE strategy_definition
SET parameter_schema = parameter_schema || '{"setupTimeoutMinutes":"integer","consolidationBarsMin":"integer","consolidationRangeMaxPct":"number"}'::jsonb
WHERE strategy_key = 'HIGH_OF_DAY_BREAKOUT';
UPDATE strategy_definition
SET parameter_schema = parameter_schema || '{"setupTimeoutMinutes":"integer"}'::jsonb
WHERE strategy_key = 'PRIOR_DAY_HIGH_BREAKOUT';
UPDATE strategy_definition
SET parameter_schema = parameter_schema || '{"flagDurationBarsMin":"integer","flagDurationBarsMax":"integer","flagpoleMinSlopeAtrPerBar":"number","volumeContractionMaxPct":"number"}'::jsonb
WHERE strategy_key = 'BULL_FLAG';

-- Baseline configurations: every declared parameter at its contract default, so
-- each profile starts from the same neutral footing ORB Standard did rather than
-- from an untested hand-tuned combination.
INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order) VALUES
('10000000-0000-4000-8000-000000000086','VWAP Reclaim','10000000-0000-4000-8000-000000000073',true,3),
('10000000-0000-4000-8000-000000000087','High-of-Day Breakout','10000000-0000-4000-8000-000000000074',true,4),
('10000000-0000-4000-8000-000000000088','Bull Flag','10000000-0000-4000-8000-000000000075',true,5),
('10000000-0000-4000-8000-000000000089','Prior-Day-High Breakout','10000000-0000-4000-8000-000000000076',true,6)
ON CONFLICT(id) DO NOTHING;

INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters) VALUES
('10000000-0000-4000-8000-000000000096','10000000-0000-4000-8000-000000000086','profile-vwap-reclaim-v1',
 '{"rvolAtTimeMin":1.5,"spreadHardMaxPct":0.25,"atrPctMin":0,"retestTolerancePct":0.15,"setupTimeoutMinutes":20,"scoreCutoff":0}'),
('10000000-0000-4000-8000-000000000097','10000000-0000-4000-8000-000000000087','profile-high-of-day-breakout-v1',
 '{"rvolAtTimeMin":1.5,"spreadHardMaxPct":0.25,"atrPctMin":0,"breakoutVolumeRatioMin":1.5,"breakoutBufferPct":0.05,"retestTolerancePct":0.15,"setupTimeoutMinutes":20,"consolidationBarsMin":3,"consolidationRangeMaxPct":0.75,"scoreCutoff":0}'),
('10000000-0000-4000-8000-000000000098','10000000-0000-4000-8000-000000000088','profile-bull-flag-v1',
 '{"rvolAtTimeMin":1.5,"spreadHardMaxPct":0.25,"atrPctMin":0,"breakoutVolumeRatioMin":1.5,"flagpoleMinAtr":0.5,"flagRetracementMaxPct":50,"setupTimeoutMinutes":20,"flagDurationBarsMin":1,"flagDurationBarsMax":2,"flagpoleMinSlopeAtrPerBar":0,"volumeContractionMaxPct":100,"scoreCutoff":0}'),
('10000000-0000-4000-8000-000000000099','10000000-0000-4000-8000-000000000089','profile-prior-day-high-breakout-v1',
 '{"rvolAtTimeMin":1.5,"spreadHardMaxPct":0.25,"atrPctMin":0,"breakoutVolumeRatioMin":1.5,"breakoutBufferPct":0.05,"retestTolerancePct":0.15,"setupTimeoutMinutes":20,"scoreCutoff":0}')
ON CONFLICT(id) DO NOTHING;

UPDATE scanner_profile SET current_config_id=CASE id
  WHEN '10000000-0000-4000-8000-000000000086' THEN '10000000-0000-4000-8000-000000000096'::uuid
  WHEN '10000000-0000-4000-8000-000000000087' THEN '10000000-0000-4000-8000-000000000097'::uuid
  WHEN '10000000-0000-4000-8000-000000000088' THEN '10000000-0000-4000-8000-000000000098'::uuid
  WHEN '10000000-0000-4000-8000-000000000089' THEN '10000000-0000-4000-8000-000000000099'::uuid END
WHERE id IN (
  '10000000-0000-4000-8000-000000000086','10000000-0000-4000-8000-000000000087',
  '10000000-0000-4000-8000-000000000088','10000000-0000-4000-8000-000000000089'
) AND current_config_id IS NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(38, 'Deploy VWAP Reclaim, High-of-Day Breakout, Bull Flag and Prior-Day-High Breakout profiles')
ON CONFLICT(version) DO NOTHING;
