-- Strategy research experiments. Existing profiles retain their prior JSON
-- configuration; the new switches default to disabled in the shared contract.
UPDATE strategy_definition
SET parameter_schema = parameter_schema || '{
  "retestVolumeContractionEnabled":"integer",
  "retestHighBreakEnabled":"integer",
  "retestRejectionEnabled":"integer",
  "retestVolumeContractionMaxRatio":"number",
  "rejectionLowerWickBodyMin":"number",
  "rejectionUpperWickRangeMaxPct":"number",
  "rejectionCloseLocationMinPct":"number",
  "dailyEmaFilterEnabled":"integer"
}'::jsonb
WHERE strategy_key IN ('ORB_RETEST','VWAP_HOLD');

INSERT INTO strategy_definition(
  id,strategy_key,version,name,description,enabled,parameter_schema
) VALUES (
  '10000000-0000-4000-8000-000000000079',
  'RSI_VWAP_RECLAIM',
  '1.0.0',
  'RSI/VWAP Reclaim',
  'Confirmed bullish RSI divergence followed by a completed VWAP reclaim, hold, and resistance break.',
  true,
  '{
    "rvolAtTimeMin":"number",
    "spreadHardMaxPct":"number",
    "atrPctMin":"number",
    "retestTolerancePct":"number",
    "breakoutBufferPct":"number",
    "rsiPeriod":"integer",
    "rsiPivotLeftBars":"integer",
    "rsiPivotRightBars":"integer",
    "rsiPivotMinSpacingBars":"integer",
    "rsiPivotMaxSpacingBars":"integer",
    "rsiDivergenceMinPoints":"number",
    "rsiDivergenceVolumeContractionMaxRatio":"number",
    "rsiSetupTimeoutMinutes":"integer",
    "dailyEmaFilterEnabled":"integer",
    "stopPolicy":"string",
    "scoreCutoff":"integer"
  }'
)
ON CONFLICT(strategy_key,version) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  enabled=EXCLUDED.enabled,
  parameter_schema=EXCLUDED.parameter_schema;

INSERT INTO foundation_schema_version(version,description)
VALUES(80,'Strategy research experiment definitions and opt-in retest parameters')
ON CONFLICT(version) DO NOTHING;
