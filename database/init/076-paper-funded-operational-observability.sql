-- Preserve the first time a funded order entered CLOSE_PENDING. This is
-- deliberately separate from updated_at: subsequent quote retries may update
-- the order while it remains unresolved, but the alert must measure the age of
-- the unresolved close request itself.
ALTER TABLE paper_entry_order
  ADD COLUMN IF NOT EXISTS close_pending_at TIMESTAMPTZ;

UPDATE paper_entry_order
SET close_pending_at = COALESCE(close_pending_at, updated_at)
WHERE state->'execution'->>'status' = 'CLOSE_PENDING';

CREATE INDEX IF NOT EXISTS paper_entry_order_funded_close_pending_idx
  ON paper_entry_order(run_id, close_pending_at)
  WHERE state->'execution'->>'status' = 'CLOSE_PENDING';

CREATE OR REPLACE FUNCTION track_funded_close_pending_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state->'execution'->>'status' = 'CLOSE_PENDING' THEN
    IF TG_OP = 'INSERT'
       OR OLD.state->'execution'->>'status' IS DISTINCT FROM 'CLOSE_PENDING' THEN
      NEW.close_pending_at = COALESCE(NEW.close_pending_at, now());
    ELSE
      NEW.close_pending_at = COALESCE(OLD.close_pending_at, NEW.close_pending_at, now());
    END IF;
  ELSE
    NEW.close_pending_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS track_funded_close_pending_at ON paper_entry_order;
CREATE TRIGGER track_funded_close_pending_at
  BEFORE INSERT OR UPDATE OF state ON paper_entry_order
  FOR EACH ROW EXECUTE FUNCTION track_funded_close_pending_at();

INSERT INTO foundation_schema_version(version, description)
VALUES(76, 'Funded close-pending age and operational observability state')
ON CONFLICT(version) DO NOTHING;
