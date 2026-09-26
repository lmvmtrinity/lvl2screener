-- Execution-diagnostics catch-up polls every completed funded run for facts
-- processed after the newest diagnostics job (`f.processed_at > last_job_at`
-- with `f.fact_at <= boundary_at`). Migration 112's (run_id, fact_at DESC)
-- index can only bound that probe by fact_at, so every poll filtered each
-- completed run's whole retained history: the September 23 production profile
-- measured ~126,575 index rows per run across 22 US runs (314k buffers, 1.09M
-- heap fetches, ~715 ms) while no completed run had a new processed fact.
--
-- Keying by processed time turns the steady-state probe into an empty range
-- scan. The partial predicate is implied by the strict `processed_at > ...`
-- comparison, so eligibility is unchanged and pending (unprocessed) facts are
-- never indexed. Processed facts are immutable (migration 131), so indexed
-- rows are never rewritten after insertion or their processing update.
CREATE INDEX IF NOT EXISTS paper_funded_fact_processed_revision_idx
  ON paper_funded_fact(run_id, processed_at)
  INCLUDE (fact_at)
  WHERE processed_at IS NOT NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(146, 'Index processed funded facts by run and processing time')
ON CONFLICT(version) DO NOTHING;
