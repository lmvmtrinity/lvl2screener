-- Durable fact ordering and monotonic paper-execution transitions.

ALTER TABLE paper_execution
  ADD COLUMN IF NOT EXISTS last_fact_timestamp TIMESTAMPTZ;

UPDATE paper_execution
SET last_fact_timestamp=entry_time
WHERE status IN ('OPEN','CLOSE_PENDING') AND last_fact_timestamp IS NULL;

ALTER TABLE paper_execution
  DROP CONSTRAINT IF EXISTS paper_execution_last_fact_check;
ALTER TABLE paper_execution
  ADD CONSTRAINT paper_execution_last_fact_check CHECK (
    status NOT IN ('OPEN','CLOSE_PENDING') OR last_fact_timestamp IS NOT NULL
  );

CREATE OR REPLACE FUNCTION paper_execution_guard_transition() RETURNS trigger AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  old_rank := CASE OLD.status
    WHEN 'PENDING' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'CLOSE_PENDING' THEN 2
    WHEN 'CLOSED' THEN 3 WHEN 'NO_FILL' THEN 3 END;
  new_rank := CASE NEW.status
    WHEN 'PENDING' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'CLOSE_PENDING' THEN 2
    WHEN 'CLOSED' THEN 3 WHEN 'NO_FILL' THEN 3 END;

  IF new_rank < old_rank OR
     (OLD.status='CLOSE_PENDING' AND NEW.status='NO_FILL') OR
     (OLD.status='OPEN' AND NEW.status='NO_FILL') OR
     (OLD.status='PENDING' AND NEW.status IN ('CLOSE_PENDING','CLOSED')) THEN
    RAISE EXCEPTION 'illegal paper_execution status transition % -> % for id=%',
      OLD.status, NEW.status, OLD.id;
  END IF;

  IF OLD.entry_price IS NOT NULL AND ROW(
       NEW.entry_price,NEW.entry_time,NEW.stop_price,NEW.target_price,
       NEW.shares,NEW.initial_risk,NEW.entry_market_snapshot,NEW.entry_size_coverage
     ) IS DISTINCT FROM ROW(
       OLD.entry_price,OLD.entry_time,OLD.stop_price,OLD.target_price,
       OLD.shares,OLD.initial_risk,OLD.entry_market_snapshot,OLD.entry_size_coverage
     ) THEN
    RAISE EXCEPTION 'paper_execution entry facts are immutable for id=%', OLD.id;
  END IF;

  IF OLD.status IN ('CLOSED','NO_FILL') AND ROW(
       NEW.status,NEW.exit_price,NEW.exit_time,NEW.exit_reason,NEW.fee,
       NEW.gross_pnl,NEW.net_pnl,NEW.r_multiple,NEW.no_fill_reason,
       NEW.exit_market_snapshot,NEW.exit_size_coverage,NEW.session_close_delay_ms
     ) IS DISTINCT FROM ROW(
       OLD.status,OLD.exit_price,OLD.exit_time,OLD.exit_reason,OLD.fee,
       OLD.gross_pnl,OLD.net_pnl,OLD.r_multiple,OLD.no_fill_reason,
       OLD.exit_market_snapshot,OLD.exit_size_coverage,OLD.session_close_delay_ms
     ) THEN
    RAISE EXCEPTION 'terminal paper_execution outcome is immutable for id=%', OLD.id;
  END IF;

  IF NEW.last_fact_timestamp IS NOT NULL AND OLD.last_fact_timestamp IS NOT NULL
     AND NEW.last_fact_timestamp < OLD.last_fact_timestamp THEN
    RAISE EXCEPTION 'paper_execution fact timestamp cannot move backwards for id=%', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_execution_transition_guard ON paper_execution;
CREATE TRIGGER paper_execution_transition_guard
BEFORE UPDATE ON paper_execution
FOR EACH ROW EXECUTE FUNCTION paper_execution_guard_transition();

INSERT INTO foundation_schema_version(version, description)
VALUES(35, 'Durable paper-execution fact ordering and monotonic transitions')
ON CONFLICT(version) DO NOTHING;
