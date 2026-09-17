-- Completion-triggered reconciliation: a settled durable job re-runs the
-- market cycle so waiting capacity work drains immediately instead of idling
-- until the next daily cycle. The trigger origin is recorded separately from
-- every other origin so completion drains stay auditable. Waiting work also
-- records the moment it started waiting (as opposed to its last evaluation),
-- so age measurements survive repeated completion drains.

ALTER TABLE backtest_automation_work
  DROP CONSTRAINT IF EXISTS backtest_automation_work_trigger_origin_check;
ALTER TABLE backtest_automation_work
  ADD CONSTRAINT backtest_automation_work_trigger_origin_check
  CHECK (trigger_origin IN ('PROFILE_SAVE','SCHEDULED_CATCH_UP','REFRESH_NOW','EXPLICIT_EXPERIMENT','JOB_COMPLETION'));

ALTER TABLE backtest_automation_cycle
  DROP CONSTRAINT IF EXISTS backtest_automation_cycle_trigger_origin_check;
ALTER TABLE backtest_automation_cycle
  ADD CONSTRAINT backtest_automation_cycle_trigger_origin_check
  CHECK (trigger_origin IN ('PROFILE_SAVE','SCHEDULED_CATCH_UP','REFRESH_NOW','EXPLICIT_EXPERIMENT','JOB_COMPLETION'));

ALTER TABLE backtest_automation_work
  ADD COLUMN IF NOT EXISTS waiting_since TIMESTAMPTZ;

INSERT INTO foundation_schema_version(version, description)
VALUES(117, 'Completion-triggered backtest automation reconciliation')
ON CONFLICT (version) DO NOTHING;
