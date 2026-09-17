-- quote_snapshot.bid_size/ask_size are normalized displayed shares from v4
-- onward. Retain the provider values and conversion metadata so execution
-- evidence can disclose its liquidity-unit contract.
ALTER TABLE quote_snapshot
  ADD COLUMN IF NOT EXISTS bid_size_raw BIGINT,
  ADD COLUMN IF NOT EXISTS ask_size_raw BIGINT,
  ADD COLUMN IF NOT EXISTS size_unit TEXT,
  ADD COLUMN IF NOT EXISTS size_multiplier INTEGER;

INSERT INTO foundation_schema_version(version, description)
VALUES(52, 'Persist provider quote-size units and normalized displayed shares')
ON CONFLICT(version) DO NOTHING;
