ALTER TABLE paper_funded_fact
  ADD COLUMN economic_key TEXT;

CREATE UNIQUE INDEX paper_funded_fact_economic_key_uq
  ON paper_funded_fact(run_id, economic_key)
  WHERE economic_key IS NOT NULL;
