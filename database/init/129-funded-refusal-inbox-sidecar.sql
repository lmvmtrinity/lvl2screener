-- FP01-R5: refusal request inbox sidecar.
--
-- The exact live refusal request must be durable before its associated cycle
-- input can be acknowledged. The funded inbox enqueue transaction therefore
-- writes the immutable refusal source (live) or this additive fact-row sidecar
-- (historical replay, whose chronological cursor is captured by the ordered
-- drain) atomically with the facts. The sidecar is evidence metadata on the
-- inbox row, never part of the strict session-driver envelope that
-- `processFundedSessionFacts` receives.

ALTER TABLE paper_funded_fact
  ADD COLUMN IF NOT EXISTS refusal_request JSONB;

ALTER TABLE paper_funded_fact
  ADD CONSTRAINT paper_funded_fact_refusal_request_check CHECK(
    refusal_request IS NULL OR jsonb_typeof(refusal_request) = 'object'
  );

CREATE INDEX IF NOT EXISTS paper_funded_fact_refusal_request_pending_idx
  ON paper_funded_fact(run_id, fact_at, fact_id)
  WHERE refusal_request IS NOT NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(129, 'Funded refusal request inbox sidecar')
ON CONFLICT(version) DO NOTHING;
