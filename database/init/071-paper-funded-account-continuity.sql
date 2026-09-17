ALTER TABLE paper_funded_run
  DROP CONSTRAINT IF EXISTS paper_funded_run_account_id_key;

CREATE INDEX paper_funded_run_account_idx
  ON paper_funded_run(account_id, created_at DESC);
