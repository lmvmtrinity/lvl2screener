INSERT INTO strategy_definition(id,strategy_key,version,name,description,enabled,parameter_schema) VALUES
('10000000-0000-4000-8000-000000000073','VWAP_RECLAIM','1.0.0','VWAP Reclaim','A completed-bar reclaim of session VWAP followed by a hold above it.',true,'{"rvolAtTimeMin":"number","spreadHardMaxPct":"number","atrPctMin":"number","retestTolerancePct":"number","setupTimeoutMinutes":"integer","scoreCutoff":"integer"}'),
('10000000-0000-4000-8000-000000000074','HIGH_OF_DAY_BREAKOUT','1.0.0','High-of-Day Breakout','Volume-confirmed close above the high established by prior completed intraday bars.',true,'{"rvolAtTimeMin":"number","spreadHardMaxPct":"number","atrPctMin":"number","breakoutVolumeRatioMin":"number","breakoutBufferPct":"number","retestTolerancePct":"number","scoreCutoff":"integer"}'),
('10000000-0000-4000-8000-000000000075','BULL_FLAG','1.0.0','Bull Flag','ATR-normalized impulse, controlled low-volume pullback, and volume-confirmed continuation.',true,'{"rvolAtTimeMin":"number","spreadHardMaxPct":"number","atrPctMin":"number","breakoutVolumeRatioMin":"number","flagpoleMinAtr":"number","flagRetracementMaxPct":"number","scoreCutoff":"integer"}'),
('10000000-0000-4000-8000-000000000076','PRIOR_DAY_HIGH_BREAKOUT','1.0.0','Prior-Day-High Breakout','Volume-confirmed close through the previous completed daily session high.',true,'{"rvolAtTimeMin":"number","spreadHardMaxPct":"number","atrPctMin":"number","breakoutVolumeRatioMin":"number","breakoutBufferPct":"number","retestTolerancePct":"number","scoreCutoff":"integer"}'),
('10000000-0000-4000-8000-000000000077','SECTOR_RELATIVE_STRENGTH','1.0.0','Sector-Relative Strength','Outperformance versus the equal-weight change of current same-sector scanner peers.',true,'{"rvolAtTimeMin":"number","spreadHardMaxPct":"number","atrPctMin":"number","relativeStrengthMinPct":"number","scoreCutoff":"integer"}'),
('10000000-0000-4000-8000-000000000078','MARKET_RELATIVE_STRENGTH','1.0.0','Market-Relative Strength','Outperformance versus the equal-weight change of the current shared scanner universe.',true,'{"rvolAtTimeMin":"number","spreadHardMaxPct":"number","atrPctMin":"number","relativeStrengthMinPct":"number","scoreCutoff":"integer"}')
ON CONFLICT(strategy_key,version) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  enabled=EXCLUDED.enabled,
  parameter_schema=EXCLUDED.parameter_schema;

INSERT INTO foundation_schema_version(version,description)
VALUES(11,'Phase 11 additional deterministic strategy modules')
ON CONFLICT(version) DO NOTHING;
