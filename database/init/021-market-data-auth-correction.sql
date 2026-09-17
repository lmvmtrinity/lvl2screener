-- The original API-side Phase 2 helper carried these two additive changes while
-- the Compose SQL path did not. Keep this correction as a new migration so the
-- filename ledger never needs a historical checksum rewritten.
ALTER TABLE market_data_auth
  ADD COLUMN IF NOT EXISTS encrypted_previous_refresh_token TEXT;
ALTER TABLE market_data_auth
  ADD COLUMN IF NOT EXISTS rotation_started_at TIMESTAMPTZ;

INSERT INTO foundation_schema_version (version, description)
VALUES (21, 'Phase 2 market-data authentication schema reconciliation')
ON CONFLICT (version) DO NOTHING;
