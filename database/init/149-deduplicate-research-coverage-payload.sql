-- Keep every report/date/hash identity while storing identical immutable
-- coverage payloads once. The swap happens in the migration transaction so
-- readers never see a partly converted table.
CREATE TABLE research_coverage_payload (
  payload_hash TEXT PRIMARY KEY CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  payload JSONB NOT NULL
);

INSERT INTO research_coverage_payload(payload_hash, payload)
SELECT DISTINCT ON (payload_hash) payload_hash, payload
FROM research_coverage_session
ORDER BY payload_hash, report_hash, session_date;

CREATE TRIGGER research_coverage_payload_immutable
BEFORE UPDATE OR DELETE ON research_coverage_payload
FOR EACH ROW EXECUTE FUNCTION reject_research_coverage_request_mutation();

CREATE TABLE research_coverage_session_new (
  report_hash TEXT NOT NULL REFERENCES research_coverage_report(hash),
  session_date DATE NOT NULL,
  payload_hash TEXT NOT NULL REFERENCES research_coverage_payload(payload_hash),
  PRIMARY KEY(report_hash, session_date)
);

INSERT INTO research_coverage_session_new(report_hash, session_date, payload_hash)
SELECT report_hash, session_date, payload_hash
FROM research_coverage_session;

DO $$
BEGIN
  IF (SELECT count(*) FROM research_coverage_session_new)
     <> (SELECT count(*) FROM research_coverage_session) THEN
    RAISE EXCEPTION 'Research coverage session copy is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM research_coverage_session original
    JOIN research_coverage_payload shared USING (payload_hash)
    WHERE original.payload IS DISTINCT FROM shared.payload
  ) THEN
    RAISE EXCEPTION 'Research coverage payload hash has conflicting content';
  END IF;
END $$;

DROP TABLE research_coverage_session;
ALTER TABLE research_coverage_session_new RENAME TO research_coverage_session;
CREATE TRIGGER research_coverage_session_immutable
BEFORE UPDATE OR DELETE ON research_coverage_session
FOR EACH ROW EXECUTE FUNCTION reject_research_coverage_request_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES(149, 'Store immutable research coverage payloads once per content hash')
ON CONFLICT(version) DO NOTHING;
