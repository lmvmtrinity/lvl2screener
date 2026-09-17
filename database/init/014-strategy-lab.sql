-- Phase 3: parameter declarations must match what each module actually reads, so
-- the strategy lab can render only the controls a definition really uses.
UPDATE strategy_definition SET parameter_schema=parameter_schema || '{"setupTimeoutMinutes":"integer"}'::jsonb
WHERE strategy_key IN ('ORB_RETEST','VWAP_HOLD','BULL_FLAG');
UPDATE strategy_definition SET parameter_schema=parameter_schema - 'breakoutVolumeRatioMin'
WHERE strategy_key='VWAP_HOLD';

-- Names that describe the gate instead of the quantity.
UPDATE strategy_definition SET description='Volume-confirmed close above the high established by prior completed intraday bars. Breakout volume ratio compares the latest completed candle volume with the mean of the 3 previous completed candles.'
WHERE strategy_key='HIGH_OF_DAY_BREAKOUT';
UPDATE strategy_definition SET description='Volume-confirmed close through the previous completed daily session high. Breakout volume ratio compares the latest completed candle volume with the mean of the 3 previous completed candles.'
WHERE strategy_key='PRIOR_DAY_HIGH_BREAKOUT';

CREATE INDEX IF NOT EXISTS scanner_profile_config_history_idx ON scanner_profile_config(profile_id, created_at);

INSERT INTO foundation_schema_version(version,description)
VALUES(14,'Phase 3 schema-driven strategy lab parameter declarations')
ON CONFLICT(version) DO NOTHING;
