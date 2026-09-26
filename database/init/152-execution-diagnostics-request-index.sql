CREATE INDEX IF NOT EXISTS research_job_execution_diagnostics_lookup_idx
ON research_job (
  (request_payload->>'runId'),
  (request_payload->>'reportVersion'),
  created_at DESC
)
WHERE job_type='EXECUTION_DIAGNOSTICS';

INSERT INTO foundation_schema_version(version, description)
VALUES(152, 'Index execution diagnostics jobs by run and report version')
ON CONFLICT(version) DO NOTHING;
