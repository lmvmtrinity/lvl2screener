-- Execution-diagnostics catch-up polls for completed runs whose retained boundary
-- evidence changed after the newest diagnostics job. These indexes keep the
-- eligibility checks index probes instead of full scans on every cycle; the full
-- source-revision digest remains reserved for runs that actually need dispatch.
CREATE INDEX paper_funded_fact_boundary_revision_idx
  ON paper_funded_fact (run_id, fact_at DESC)
  INCLUDE (processed_at);

CREATE INDEX paper_funded_event_account_recorded_idx
  ON paper_funded_event (account_id, recorded_at DESC);

INSERT INTO foundation_schema_version(version, description)
VALUES(112, 'Execution-diagnostics catch-up eligibility indexes')
ON CONFLICT (version) DO NOTHING;
