-- Preserve every accepted idempotency key, including aliases of identical content.
CREATE TABLE research_coverage_request_key (
  idempotency_key TEXT PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES research_coverage_request(id),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
INSERT INTO research_coverage_request_key(idempotency_key,request_id,request_hash)
SELECT idempotency_key,id,request_hash FROM research_coverage_request;
CREATE TRIGGER research_coverage_request_key_immutable
BEFORE UPDATE OR DELETE ON research_coverage_request_key
FOR EACH ROW EXECUTE FUNCTION reject_research_coverage_request_mutation();

CREATE TABLE research_coverage_session (
  report_hash TEXT NOT NULL REFERENCES research_coverage_report(hash),
  session_date DATE NOT NULL,
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  payload JSONB NOT NULL,
  PRIMARY KEY(report_hash,session_date)
);
CREATE TRIGGER research_coverage_session_immutable
BEFORE UPDATE OR DELETE ON research_coverage_session
FOR EACH ROW EXECUTE FUNCTION reject_research_coverage_request_mutation();
