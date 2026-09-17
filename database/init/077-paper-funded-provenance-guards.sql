-- Funded account funding and run binding are immutable provenance. The service
-- checks these values, but the database must reject direct SQL writers too.

CREATE OR REPLACE FUNCTION reject_funded_account_provenance_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.initial_state IS DISTINCT FROM NEW.initial_state THEN
    RAISE EXCEPTION 'funded account initial funding is immutable for id=%', OLD.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS paper_funded_account_provenance_immutable ON paper_funded_account;
CREATE TRIGGER paper_funded_account_provenance_immutable
BEFORE UPDATE OF initial_state ON paper_funded_account
FOR EACH ROW EXECUTE FUNCTION reject_funded_account_provenance_update();

CREATE OR REPLACE FUNCTION reject_funded_run_provenance_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.account_id IS DISTINCT FROM NEW.account_id
     OR OLD.currency IS DISTINCT FROM NEW.currency
     OR OLD.policy IS DISTINCT FROM NEW.policy THEN
    RAISE EXCEPTION 'funded run binding and policy are immutable for run_id=%', OLD.run_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS paper_funded_run_provenance_immutable ON paper_funded_run;
CREATE TRIGGER paper_funded_run_provenance_immutable
BEFORE UPDATE OF account_id,currency,policy ON paper_funded_run
FOR EACH ROW EXECUTE FUNCTION reject_funded_run_provenance_update();

INSERT INTO foundation_schema_version(version,description)
VALUES(77,'Funded account and run provenance immutability guards')
ON CONFLICT(version) DO NOTHING;
