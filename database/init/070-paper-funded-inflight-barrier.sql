ALTER TABLE paper_funded_run
  ADD COLUMN inflight_fact_id TEXT,
  ADD COLUMN inflight_fact_at TIMESTAMPTZ,
  ADD COLUMN inflight_priority INTEGER,
  ADD COLUMN inflight_sort_key TEXT;

ALTER TABLE paper_funded_run
  ADD CONSTRAINT paper_funded_inflight_barrier_complete CHECK (
    (inflight_fact_id IS NULL AND inflight_fact_at IS NULL
      AND inflight_priority IS NULL AND inflight_sort_key IS NULL)
    OR (inflight_fact_id IS NOT NULL AND inflight_fact_at IS NOT NULL
      AND inflight_priority IS NOT NULL AND inflight_sort_key IS NOT NULL)
  );
