-- W7 note: discovered while getting a fresh PostgreSQL instance running to validate the W7
-- set-based persistence performance fixture (a `docker compose up -d postgres` with no prior
-- volume, and therefore no legacy schema history, is exactly what exposed this).
--
-- 025-operational-status.sql widened each research table's status CHECK constraint to allow
-- 'INTERRUPTED' by locating the existing constraint with an ILIKE search over the constraint
-- definition text. On a fresh `statistical_model` table that ILIKE search matched TWO
-- constraints -- the intended `statistical_model_status_check` column CHECK, and
-- `statistical_model_check` (`NOT active OR (status = 'COMPLETED' AND eligible_for_activation)`),
-- which also happens to mention "status" -- so the unordered `SELECT ... INTO` picked the wrong
-- one, dropped it, and the subsequent `ADD CONSTRAINT statistical_model_status_check` collided
-- with the untouched original, failing 025 outright on every from-scratch bootstrap. 025 itself
-- has been fixed in place (matching on the constraint's generated name instead of its definition
-- text) rather than worked around here, on the reasoning that a migration which fails
-- deterministically on every fresh install can never have a successful ledger entry anywhere to
-- protect via the "never edit an applied migration" checksum guard -- there is no environment
-- whose already-applied 025 this change can retroactively invalidate.
--
-- This migration is a defensive backstop, not the fix: it re-asserts 025's intended end state
-- using exact, unambiguous constraint names, so a database that somehow reached the broken
-- intermediate state described above (e.g. a manual recovery attempt before this fix existed)
-- still converges to the correct schema.
DO $$ BEGIN
  ALTER TABLE backtest_run DROP CONSTRAINT IF EXISTS backtest_run_status_check;
  ALTER TABLE backtest_run ADD CONSTRAINT backtest_run_status_check
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE calibration_run DROP CONSTRAINT IF EXISTS calibration_run_status_check;
  ALTER TABLE calibration_run ADD CONSTRAINT calibration_run_status_check
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE statistical_model DROP CONSTRAINT IF EXISTS statistical_model_status_check;
  ALTER TABLE statistical_model ADD CONSTRAINT statistical_model_status_check
    CHECK (status IN ('PENDING', 'TRAINING', 'COMPLETED', 'INSUFFICIENT_DATA', 'FAILED', 'INTERRUPTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ranking_research_run DROP CONSTRAINT IF EXISTS ranking_research_run_status_check;
  ALTER TABLE ranking_research_run ADD CONSTRAINT ranking_research_run_status_check
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The table-level composite check that 025's bug could have dropped instead, on a database that
-- reached the broken intermediate state. Restored unconditionally (same definition as
-- 012-phase12.sql); a no-op if it was never dropped.
DO $$ BEGIN
  ALTER TABLE statistical_model ADD CONSTRAINT statistical_model_check
    CHECK (NOT active OR (status = 'COMPLETED' AND eligible_for_activation));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
