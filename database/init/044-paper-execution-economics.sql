-- v2 execution safety: a structurally valid setup must still have positive
-- expected net P&L at its target after the run's modeled round-trip friction.
-- Existing NO_FILL rows remain immutable evidence; this merely permits the
-- new explicit rejection reason for future executions.

ALTER TABLE paper_execution
  DROP CONSTRAINT IF EXISTS paper_execution_no_fill_reason_check;

ALTER TABLE paper_execution
  ADD CONSTRAINT paper_execution_no_fill_reason_check CHECK (
    no_fill_reason IS NULL OR no_fill_reason IN (
      'HALTED','DELAYED','STALE','MISSING_QUOTE',
      'MISSING_REFERENCE','SHARES_BELOW_ONE','EXECUTABLE_PRICE_OUTSIDE_LEVELS',
      'NET_TARGET_NON_POSITIVE'
    )
  );

INSERT INTO foundation_schema_version(version, description)
VALUES(44, 'Paper execution v2 economics rejection reason')
ON CONFLICT(version) DO NOTHING;
