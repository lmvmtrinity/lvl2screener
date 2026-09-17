\set ON_ERROR_STOP on

-- Reopens the crash window the durability requirements care about: an
-- observation is committed, but one of its two execution children is not.
-- Reconciliation excludes any event whose evidence is already complete, so
-- repairing this depends on it also detecting an observation that is missing a
-- child -- not merely a missing observation.
--
-- Applied between two API restarts, so the next startup is the only thing that
-- can put the CANDLE row back.
DELETE FROM paper_execution e
USING paper_signal_observation o
WHERE o.id = e.observation_id
  AND e.model = 'CANDLE'
  AND o.source_event_id = '50000000-0000-4000-8000-000000000012'::uuid;

-- Prove the deletion actually matched: a silent no-op here would make the
-- recovery assertion vacuous.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM paper_execution e
    JOIN paper_signal_observation o ON o.id = e.observation_id
    WHERE e.model = 'CANDLE'
      AND o.source_event_id = '50000000-0000-4000-8000-000000000012'::uuid
  ) THEN
    RAISE EXCEPTION 'paper-bot damage fixture did not remove the CANDLE execution';
  END IF;
END;
$$;
