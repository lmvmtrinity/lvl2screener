-- Trade reference floors (strategy configuration +levels-v1).
--
-- Setup stops were the tighter of the pattern stop and nearest support, often
-- within two or three spreads of entry, and targets were the nearest resistance
-- even when it was closer than the stop. Replay showed stops firing within
-- minutes on moves that later reached target, and targets near 0.5R. The
-- scanner now accepts three opt-in parameters whose defaults keep the
-- structural stop and nearest-resistance target exactly. This migration
-- declares them for every setup strategy and moves every setup profile to a new
-- immutable configuration version derived from its current one. Earlier
-- versions and their evidence are unchanged and stay separate cohorts (ADR-011).
UPDATE strategy_definition
SET parameter_schema = parameter_schema || '{
  "stopMinAtrFraction":"number",
  "stopMinSpreads":"number",
  "targetMinR":"number"
}'::jsonb
WHERE analysis_kind = 'SETUP';

WITH current_config AS (
  SELECT p.id AS profile_id, p.market_id, c.config_version, c.parameters
  FROM scanner_profile p
  JOIN strategy_definition d ON d.id = p.strategy_definition_id
  JOIN scanner_profile_config c ON c.id = p.current_config_id
  WHERE d.analysis_kind = 'SETUP'
    AND NOT (c.parameters ? 'stopMinAtrFraction')
), inserted AS (
  INSERT INTO scanner_profile_config(profile_id, market_id, config_version, parameters)
  SELECT profile_id, market_id, config_version || '+levels-v1',
         parameters || '{
           "stopMinAtrFraction":0.15,
           "stopMinSpreads":4,
           "targetMinR":1.5
         }'::jsonb
  FROM current_config
  RETURNING id, profile_id
)
UPDATE scanner_profile p
SET current_config_id = inserted.id, updated_at = now()
FROM inserted
WHERE p.id = inserted.profile_id;

INSERT INTO foundation_schema_version(version, description)
VALUES(154, 'Floor setup stops and targets with new profile configuration versions')
ON CONFLICT(version) DO NOTHING;
