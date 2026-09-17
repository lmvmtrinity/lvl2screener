-- Bounded funded-ledger reconstruction checkpoints.
--
-- The FP01 decision capture and the reporting AS_OF fallback reconstruct
-- decision-time account state by replaying durable ledger events. Live funded
-- accounts roll through sessions and accumulate hundreds of thousands of
-- per-quote MARK events, so a replay that starts at account creation is
-- quadratic in history and can wedge the API process. Durable event_sequence
-- rows (migration 079) and the immutable run-boundary snapshot (migration 079)
-- let reconstruction start from a verified checkpoint instead.
--
-- This migration adds the sequence cursor to the run snapshot and backfills it
-- only where it can be proven. A snapshot's boundary cursor is provable when
-- the snapshot state's final retained event is durably verified at exactly the
-- boundary time and no later-sequenced event claims a time at or before that
-- boundary. Snapshots that cannot prove the cursor stay NULL and remain
-- unavailable as reconstruction checkpoints; they are still authoritative for
-- run-end reporting.

ALTER TABLE paper_funded_run_snapshot
  ADD COLUMN IF NOT EXISTS boundary_event_sequence BIGINT;

-- Legacy snapshots whose final retained event proves the cursor.
WITH final AS (
  SELECT s.run_id,
         s.account_id,
         s.boundary_at,
         s.state->'events'->-1->>'id' AS final_event_id
    FROM paper_funded_run_snapshot s
), proof AS (
  SELECT f.run_id, e.event_sequence AS anchor
    FROM final f
    JOIN paper_funded_event e
      ON e.account_id = f.account_id
     AND e.event_id = f.final_event_id
   WHERE f.final_event_id IS NOT NULL
     AND e.event_sequence_verified
     AND (e.event->>'at')::timestamptz = f.boundary_at
)
UPDATE paper_funded_run_snapshot s
   SET boundary_event_sequence = p.anchor
  FROM proof p
 WHERE s.run_id = p.run_id
   AND NOT EXISTS (
     SELECT 1 FROM paper_funded_event x
      WHERE x.account_id = s.account_id
        AND x.event_sequence > p.anchor
        AND (x.event->>'at')::timestamptz <= s.boundary_at
   );

CREATE INDEX IF NOT EXISTS paper_funded_run_snapshot_account_boundary_idx
  ON paper_funded_run_snapshot(account_id, boundary_at DESC, boundary_event_sequence DESC);

INSERT INTO foundation_schema_version(version, description)
VALUES(123, 'Funded run snapshot event-sequence checkpoints for bounded ledger replay')
ON CONFLICT(version) DO NOTHING;
