-- Profiles are operational policy, not a shared strategy-code default.  Keep
-- the shared strategy definitions, but bind every profile/configuration to one
-- market so a US calibration can never retune the TSX runtime.

ALTER TABLE scanner_profile
  ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE scanner_profile_config
  ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';

ALTER TABLE scanner_profile
  ADD CONSTRAINT scanner_profile_market_id_check
  CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE scanner_profile_config
  ADD CONSTRAINT scanner_profile_config_market_id_check
  CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));

-- Existing profile history is TSX history.  The composite relationship makes a
-- configuration from the other market unrepresentable, including as a current
-- configuration pointer.
ALTER TABLE scanner_profile
  ADD CONSTRAINT scanner_profile_id_market_key UNIQUE (id, market_id);
ALTER TABLE scanner_profile_config
  ADD CONSTRAINT scanner_profile_config_id_market_key UNIQUE (id, market_id);
ALTER TABLE scanner_profile_config
  ADD CONSTRAINT scanner_profile_config_profile_market_fk
  FOREIGN KEY (profile_id, market_id)
  REFERENCES scanner_profile (id, market_id) ON DELETE CASCADE;
ALTER TABLE scanner_profile
  ADD CONSTRAINT scanner_profile_current_config_market_fk
  FOREIGN KEY (current_config_id, market_id)
  REFERENCES scanner_profile_config (id, market_id);

-- Seed disabled-by-default US v1 baselines from the immutable current TSX
-- parameters.  Their IDs are database-generated, their configuration versions
-- are clearly US-scoped, and no existing TSX row is modified.
INSERT INTO scanner_profile(name, market_id, strategy_definition_id, enabled, display_order)
SELECT 'US ' || source.name, 'US_EQUITIES', source.strategy_definition_id, false, source.display_order
FROM scanner_profile source
WHERE source.market_id = 'CA_TSX'
  AND NOT EXISTS (
    SELECT 1 FROM scanner_profile target
    WHERE target.market_id = 'US_EQUITIES'
      AND target.name = 'US ' || source.name
      AND target.strategy_definition_id = source.strategy_definition_id
  );

INSERT INTO scanner_profile_config(profile_id, market_id, config_version, parameters)
SELECT target.id, 'US_EQUITIES',
  'profile-us-' || substring(source_config.config_version FROM 9),
  source_config.parameters
FROM scanner_profile source
JOIN scanner_profile_config source_config ON source_config.id = source.current_config_id
JOIN strategy_definition definition ON definition.id = source.strategy_definition_id
JOIN scanner_profile target
  ON target.market_id = 'US_EQUITIES'
 AND target.name = 'US ' || source.name
 AND target.strategy_definition_id = source.strategy_definition_id
WHERE source.market_id = 'CA_TSX'
  AND NOT EXISTS (
    SELECT 1 FROM scanner_profile_config existing
    WHERE existing.profile_id = target.id
  );

UPDATE scanner_profile profile
SET current_config_id = config.id
FROM scanner_profile_config config
WHERE profile.market_id = 'US_EQUITIES'
  AND config.profile_id = profile.id
  AND config.market_id = profile.market_id;

-- Strategy-evaluation rows already carry market_id.  This relationship blocks
-- a US runtime from persisting an evaluation for a TSX profile (and vice versa).
ALTER TABLE strategy_evaluation
  ADD CONSTRAINT strategy_evaluation_profile_market_fk
  FOREIGN KEY (profile_id, market_id)
  REFERENCES scanner_profile (id, market_id)
  NOT VALID;

-- Some pre-market historical evaluations contain a provider/runtime market tag
-- that predates profile market identity.  Keep those immutable evidence rows;
-- NOT VALID still checks every new insert/update and can be validated after a
-- separately reviewed historical-data remediation.

INSERT INTO foundation_schema_version(version,description)
VALUES(62,'Market-scoped scanner profiles and seeded US baselines')
ON CONFLICT(version) DO NOTHING;
