-- Generic funded ledger checkpoints: run-start and periodic sequence anchors.
--
-- Run-end boundaries live in paper_funded_run_snapshot and stay immutable.
-- This table is a different concern: durable reconstruction anchors captured
-- while an account is live, so a first session on a fresh account (and a long
-- Mark-heavy session on any account) never needs to replay from account
-- creation. Each row proves a durable `event_sequence`: the row is written in
-- the same transaction that applied the last reflected event, `boundary_at`
-- equals that state's `lastEventAt`, and any later-sequenced event with an
-- equal timestamp is fetched by the reconstruction window as usual.
--
-- `paper_funded_account.checkpoint_sequence` tracks the newest anchor for the
-- account so the live apply path decides whether a periodic checkpoint is due
-- without an extra query.

ALTER TABLE paper_funded_account
  ADD COLUMN IF NOT EXISTS checkpoint_sequence BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS paper_funded_ledger_checkpoint (
  account_id UUID NOT NULL REFERENCES paper_funded_account(id),
  event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
  boundary_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('RUN_START','PERIODIC')),
  state JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, event_sequence),
  CHECK (state->>'version' = 'funded-ledger-v1'),
  CHECK ((state->>'currency') IN ('CAD','USD')),
  CHECK (state->>'lastEventAt' IS NOT NULL)
);

INSERT INTO foundation_schema_version(version, description)
VALUES(125, 'Generic funded ledger checkpoints for bounded reconstruction')
ON CONFLICT(version) DO NOTHING;
