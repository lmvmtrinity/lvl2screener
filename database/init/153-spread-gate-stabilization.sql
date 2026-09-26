-- Spread gate stabilization (strategy config spread-stable-v1).
--
-- The hard spread gate used to block a setup on the first quote above
-- spreadHardMaxPct. Symbols trading near the limit flipped WATCH/INACTIVE on
-- almost every quote, and single wide quotes invalidated FORMING and READY
-- setups whose spread recovered within seconds. The scanner now accepts four
-- opt-in parameters whose defaults reproduce the old gate exactly. This
-- migration declares them for every setup strategy and moves every setup
-- profile, enabled or not, to a new immutable configuration version that
-- enables them, so enabling a profile later cannot restore the old gate.
-- Earlier configuration versions and every row recorded under them are
-- unchanged, so old and new evidence remain separate cohorts (ADR-011).
UPDATE strategy_definition
SET parameter_schema = parameter_schema || '{
  "spreadConfirmQuotes":"integer",
  "spreadConfirmSeconds":"number",
  "spreadRecoveryPct":"number",
  "spreadMinTicks":"integer"
}'::jsonb
WHERE analysis_kind = 'SETUP';

WITH current_config AS (
  SELECT p.id AS profile_id, p.market_id, c.config_version, c.parameters
  FROM scanner_profile p
  JOIN strategy_definition d ON d.id = p.strategy_definition_id
  JOIN scanner_profile_config c ON c.id = p.current_config_id
  WHERE d.analysis_kind = 'SETUP'
    AND NOT (c.parameters ? 'spreadConfirmQuotes')
), inserted AS (
  INSERT INTO scanner_profile_config(profile_id, market_id, config_version, parameters)
  SELECT profile_id, market_id, config_version || '+spread-stable-v1',
         parameters || '{
           "spreadConfirmQuotes":3,
           "spreadConfirmSeconds":5,
           "spreadRecoveryPct":80,
           "spreadMinTicks":3
         }'::jsonb
  FROM current_config
  RETURNING id, profile_id
)
UPDATE scanner_profile p
SET current_config_id = inserted.id, updated_at = now()
FROM inserted
WHERE p.id = inserted.profile_id;

INSERT INTO foundation_schema_version(version, description)
VALUES(153, 'Stabilize the setup spread gate with new profile configuration versions')
ON CONFLICT(version) DO NOTHING;
