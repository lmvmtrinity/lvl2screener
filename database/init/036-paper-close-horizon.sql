-- Bounds how long a session close may wait for liquidity, and records the
-- outcome when it never arrives.
--
-- A CLOSE_PENDING execution previously waited for the first actionable bid
-- indefinitely, so an execution stranded by a halt could be closed against a
-- quote from an unrelated session days later. That price is not evidence
-- about the session the signal belongs to. Past the horizon the execution is
-- abandoned instead: it keeps status CLOSE_PENDING (so it stays out of every
-- closed-trade statistic and is reported as unresolved) but is no longer
-- offered new facts.

ALTER TABLE paper_execution
  ADD COLUMN IF NOT EXISTS close_abandoned_at TIMESTAMPTZ;
ALTER TABLE paper_execution
  ADD COLUMN IF NOT EXISTS unresolved_reason TEXT;

ALTER TABLE paper_execution
  DROP CONSTRAINT IF EXISTS paper_execution_abandoned_check;
ALTER TABLE paper_execution
  ADD CONSTRAINT paper_execution_abandoned_check CHECK (
    close_abandoned_at IS NULL
    OR (status = 'CLOSE_PENDING' AND unresolved_reason IS NOT NULL)
  );

-- The sweep's working set: unfinished executions that are still worth
-- offering facts to.
CREATE INDEX IF NOT EXISTS paper_execution_unresolved_idx
  ON paper_execution(status)
  WHERE status IN ('OPEN','CLOSE_PENDING') AND close_abandoned_at IS NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(36, 'Paper session-close horizon and abandoned-close accounting')
ON CONFLICT(version) DO NOTHING;
