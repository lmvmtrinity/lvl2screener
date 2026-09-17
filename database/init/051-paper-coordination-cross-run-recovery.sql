-- A coordinated position models one shadow account, not one paper-bot run.
-- Keep its symbol on the position so the database can enforce the account's
-- one-open-position-per-symbol invariant across restarts and model cohorts.
ALTER TABLE paper_coordination_position
  ADD COLUMN IF NOT EXISTS symbol TEXT;

UPDATE paper_coordination_position p
SET symbol = d.symbol
FROM paper_coordination_decision d
WHERE d.id = p.decision_id
  AND p.symbol IS NULL;

ALTER TABLE paper_coordination_position
  ALTER COLUMN symbol SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS paper_coordination_position_one_open_symbol_idx
  ON paper_coordination_position(symbol)
  WHERE status IN ('OPEN','CLOSE_PENDING');

INSERT INTO foundation_schema_version(version, description)
VALUES(51, 'Coordinated positions survive run boundaries and enforce open-symbol uniqueness')
ON CONFLICT(version) DO NOTHING;
