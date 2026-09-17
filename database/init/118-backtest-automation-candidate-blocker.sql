-- Candidate-bearing replay state: a captured range whose historical membership
-- resolves no candidate session must wait visibly instead of running a
-- benchmark-only replay that would look like a fresh baseline. Extend the
-- durable blocker enum so that waiting state can persist.

ALTER TABLE backtest_automation_work
  DROP CONSTRAINT IF EXISTS backtest_automation_work_blocker_reason_check;
ALTER TABLE backtest_automation_work
  ADD CONSTRAINT backtest_automation_work_blocker_reason_check
  CHECK (blocker_reason IN ('NO_CAPTURED_HISTORY','HISTORY_RANGE_UNAVAILABLE','POLICY_VIOLATION','CAPACITY_LIMIT','NO_REPLAY_CANDIDATES'));

INSERT INTO foundation_schema_version(version, description)
VALUES(118, 'Waiting state for replays without candidate sessions')
ON CONFLICT (version) DO NOTHING;
