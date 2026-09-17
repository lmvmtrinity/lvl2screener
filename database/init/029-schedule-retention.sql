-- W2 completion: the retention policy in 028 was approved with a 180-day
-- captured-quote horizon and must run automatically after the corrected,
-- FK-safe function is installed. This is deliberately a new migration: 028
-- remains an immutable record of the policy/function rollout.
--
-- `add_job` is idempotently guarded so restored databases, manual operator
-- scheduling, and repeated startup migrations cannot create duplicate jobs.
-- Operators must complete the backup-and-restore checklist in
-- docs/operations-runbook.md before deploying this migration because the first
-- scheduled pass can remove the backlog accumulated before 028.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM timescaledb_information.jobs
    WHERE proc_name = 'run_scheduled_retention'
  ) THEN
    PERFORM add_job('run_scheduled_retention', INTERVAL '1 day');
  END IF;
END $$;

INSERT INTO foundation_schema_version(version, description)
VALUES(29, 'W2 completion: schedule daily FK-safe retention job')
ON CONFLICT(version) DO NOTHING;
