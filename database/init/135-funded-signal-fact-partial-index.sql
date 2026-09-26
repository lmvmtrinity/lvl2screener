-- The funded decision repair/projection candidate bodies scan completed SIGNAL
-- facts per run. The outcome-status index cannot serve the type predicate, so
-- the September 18 review measured a parallel bitmap scan reading 241,550
-- completed rows to find 29 SIGNAL facts, several times per funded cycle. This
-- partial index matches the exact branch predicate (SIGNAL facts with an
-- outcome), so the same lookup reads only the SIGNAL rows.
CREATE INDEX IF NOT EXISTS paper_funded_fact_signal_outcome_idx
  ON paper_funded_fact(run_id)
  WHERE (fact->>'type')='SIGNAL' AND outcome IS NOT NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(135, 'Index completed SIGNAL facts per funded run')
ON CONFLICT(version) DO NOTHING;
