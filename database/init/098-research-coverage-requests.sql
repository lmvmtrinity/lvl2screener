-- Remediation E02/E03: immutable frozen coverage requests, source receipts and
-- result links. Heavy extraction remains in the leased worker.
CREATE TABLE IF NOT EXISTS research_coverage_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request JSONB NOT NULL CHECK (jsonb_typeof(request)='object'),
  idempotency_key TEXT NOT NULL UNIQUE,
  latest_job_id UUID REFERENCES research_job(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(market_id,request_hash)
);
CREATE TABLE IF NOT EXISTS research_coverage_source_receipt (
  request_id UUID NOT NULL REFERENCES research_coverage_request(id) ON DELETE RESTRICT,
  source_identity_hash TEXT NOT NULL CHECK (source_identity_hash ~ '^[a-f0-9]{64}$'),
  source_descriptor JSONB NOT NULL CHECK (jsonb_typeof(source_descriptor)='object'),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(request_id,source_identity_hash)
);
CREATE TABLE IF NOT EXISTS research_coverage_request_result (
  work_key TEXT PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES research_coverage_request(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES research_job(id) ON DELETE RESTRICT,
  report_hash TEXT NOT NULL REFERENCES research_coverage_report(hash) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','INCOMPLETE','UNKNOWN')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_id,job_id)
);

CREATE OR REPLACE FUNCTION reject_research_coverage_request_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The frozen request and source/result facts are immutable. latest_job_id is
  -- the one operational pointer advanced by the enqueue transaction.
  IF TG_TABLE_NAME = 'research_coverage_request' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'IMMUTABLE_RESEARCH_COVERAGE_REQUEST_RECORD';
    END IF;
    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.market_id IS DISTINCT FROM NEW.market_id
       OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
       OR OLD.request IS DISTINCT FROM NEW.request
       OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'IMMUTABLE_RESEARCH_COVERAGE_REQUEST_RECORD';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_RESEARCH_COVERAGE_REQUEST_RECORD';
END;
$$;
DROP TRIGGER IF EXISTS research_coverage_request_immutable ON research_coverage_request;
CREATE TRIGGER research_coverage_request_immutable BEFORE UPDATE OR DELETE ON research_coverage_request
FOR EACH ROW EXECUTE FUNCTION reject_research_coverage_request_mutation();
DROP TRIGGER IF EXISTS research_coverage_source_receipt_immutable ON research_coverage_source_receipt;
CREATE TRIGGER research_coverage_source_receipt_immutable BEFORE UPDATE OR DELETE ON research_coverage_source_receipt
FOR EACH ROW EXECUTE FUNCTION reject_research_coverage_request_mutation();
DROP TRIGGER IF EXISTS research_coverage_request_result_immutable ON research_coverage_request_result;
CREATE TRIGGER research_coverage_request_result_immutable BEFORE UPDATE OR DELETE ON research_coverage_request_result
FOR EACH ROW EXECUTE FUNCTION reject_research_coverage_request_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES (98, 'Frozen research coverage requests and result links')
ON CONFLICT(version) DO NOTHING;
