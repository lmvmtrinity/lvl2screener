CREATE TABLE paper_funded_fact (
  run_id UUID NOT NULL REFERENCES paper_funded_run(run_id),
  fact_id TEXT NOT NULL,
  fact_at TIMESTAMPTZ NOT NULL,
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 3),
  sort_key TEXT NOT NULL,
  fact JSONB NOT NULL,
  outcome JSONB,
  processed_at TIMESTAMPTZ,
  PRIMARY KEY(run_id,fact_id)
);
CREATE INDEX paper_funded_fact_pending ON paper_funded_fact(run_id,fact_at,priority,sort_key,fact_id)
  WHERE outcome IS NULL;
