-- The funded inbox and event tables accumulate every run's facts, but each
-- drain lookup is scoped to one run (or one account). With the default
-- autovacuum_analyze_scale_factor (10%), a 3.1M-row inbox is re-analyzed only
-- after ~310,000 changes, so the current session's run is absent from the
-- run_id statistics for most or all of the session. The planner then estimates
-- one row for the run and resolves primary-key lookups (run_id, fact_id) and
-- the processed-time probe through the smaller run-prefixed indexes, filtering
-- every row of the run on each per-fact query. The September 23 production
-- review measured 17 ms / 17,492 buffers per PK lookup on a 55,667-fact run
-- (0.06 ms / 4 buffers after ANALYZE), and a live US funded drain that fell
-- behind arrival as the run grew. A fixed row-count threshold keeps the
-- current run represented; ANALYZE samples a bounded 30,000 rows per pass.
ALTER TABLE paper_funded_fact SET (
  autovacuum_analyze_scale_factor = 0,
  autovacuum_analyze_threshold = 5000
);

ALTER TABLE paper_funded_event SET (
  autovacuum_analyze_scale_factor = 0,
  autovacuum_analyze_threshold = 5000
);

ANALYZE paper_funded_fact;
ANALYZE paper_funded_event;

INSERT INTO foundation_schema_version(version, description)
VALUES(145, 'Analyze funded inbox and events on a fixed change cadence')
ON CONFLICT(version) DO NOTHING;
