-- Phase 2 of docs/paper-bot-performance-improvement-plan.md: an executable
-- market whose modeled trade cannot pay for its own friction is a decision,
-- not a data failure. It gets its own terminal status, its own stable reason
-- vocabulary, and a persisted snapshot of every input and threshold that
-- produced it. Existing NO_FILL/NET_TARGET_NON_POSITIVE rows stay exactly as
-- they were written: history is never rewritten to match a newer policy.

ALTER TABLE paper_execution
  ADD COLUMN IF NOT EXISTS economics_reason TEXT,
  ADD COLUMN IF NOT EXISTS economics JSONB,
  ADD COLUMN IF NOT EXISTS sizing JSONB;

ALTER TABLE paper_execution
  DROP CONSTRAINT IF EXISTS paper_execution_economics_reason_check;
ALTER TABLE paper_execution
  ADD CONSTRAINT paper_execution_economics_reason_check CHECK (
    economics_reason IS NULL OR economics_reason IN (
      'NET_TARGET_NON_POSITIVE','SPREAD_COST_TOO_HIGH','STOP_DISTANCE_TOO_SMALL',
      'TARGET_DISTANCE_TOO_SMALL','NET_REWARD_RISK_TOO_LOW'
    )
  );

ALTER TABLE paper_execution
  DROP CONSTRAINT IF EXISTS paper_execution_economics_object_check;
ALTER TABLE paper_execution
  ADD CONSTRAINT paper_execution_economics_object_check CHECK (
    (economics IS NULL OR jsonb_typeof(economics) = 'object')
    AND (sizing IS NULL OR jsonb_typeof(sizing) = 'object')
  );

ALTER TABLE paper_execution DROP CONSTRAINT IF EXISTS paper_execution_status_check;
ALTER TABLE paper_execution
  ADD CONSTRAINT paper_execution_status_check CHECK (
    status IN ('PENDING','OPEN','CLOSE_PENDING','CLOSED','NO_FILL','REJECTED_ECONOMICS')
  );

-- A coordinated or strategy time stop is a risk control, not a strategy exit,
-- and must be storable as its own exit reason on the independent projection
-- too (the coordinated projection gained it in migration 048).
ALTER TABLE paper_execution DROP CONSTRAINT IF EXISTS paper_execution_exit_reason_check;
ALTER TABLE paper_execution
  ADD CONSTRAINT paper_execution_exit_reason_check CHECK (
    exit_reason IS NULL OR exit_reason IN
      ('TARGET','STOP','TIME_STOP','SESSION_CLOSE','SESSION_CLOSE_DELAYED')
  );

-- The per-status column-group invariant was declared inline (and so is
-- system-named). Locate it by its definition rather than guessing a name.
DO $$
DECLARE target_constraint TEXT;
BEGIN
  FOR target_constraint IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'paper_execution' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%status = ''PENDING''%'
  LOOP
    EXECUTE format('ALTER TABLE paper_execution DROP CONSTRAINT %I', target_constraint);
  END LOOP;
END $$;

ALTER TABLE paper_execution
  ADD CONSTRAINT paper_execution_status_columns_check CHECK (
    (status = 'PENDING' AND entry_price IS NULL AND exit_price IS NULL AND no_fill_reason IS NULL)
    OR
    (status = 'NO_FILL'
      AND no_fill_reason IS NOT NULL
      AND entry_price IS NULL AND entry_time IS NULL
      AND exit_price IS NULL AND exit_time IS NULL AND exit_reason IS NULL)
    OR
    (status = 'REJECTED_ECONOMICS'
      AND economics_reason IS NOT NULL AND economics IS NOT NULL
      AND no_fill_reason IS NULL
      AND entry_price IS NULL AND entry_time IS NULL
      AND exit_price IS NULL AND exit_time IS NULL AND exit_reason IS NULL)
    OR
    (status IN ('OPEN','CLOSE_PENDING')
      AND entry_price IS NOT NULL AND entry_time IS NOT NULL
      AND stop_price IS NOT NULL AND target_price IS NOT NULL
      AND shares IS NOT NULL AND initial_risk IS NOT NULL
      AND exit_price IS NULL AND exit_time IS NULL AND exit_reason IS NULL
      AND net_pnl IS NULL)
    OR
    (status = 'CLOSED'
      AND entry_price IS NOT NULL AND entry_time IS NOT NULL
      AND stop_price IS NOT NULL AND target_price IS NOT NULL
      AND shares IS NOT NULL AND initial_risk IS NOT NULL
      AND exit_price IS NOT NULL AND exit_time IS NOT NULL AND exit_reason IS NOT NULL
      AND fee IS NOT NULL AND gross_pnl IS NOT NULL AND net_pnl IS NOT NULL
      AND r_multiple IS NOT NULL)
  );

-- Economics rejections must be as visible in the operator journal as no-fills.
ALTER TABLE paper_bot_activity DROP CONSTRAINT IF EXISTS paper_bot_activity_event_type_check;
ALTER TABLE paper_bot_activity
  ADD CONSTRAINT paper_bot_activity_event_type_check CHECK (event_type IN (
    'RUN_STARTED','RUN_COMPLETED','RUN_CLOSE_PENDING','RUN_FAILED',
    'SIGNAL_ELIGIBLE','SIGNAL_BELOW_CUTOFF',
    'EXECUTION_PENDING','EXECUTION_OPENED','EXECUTION_CLOSED',
    'EXECUTION_NO_FILL','EXECUTION_CLOSE_PENDING','EXECUTION_ABANDONED',
    'EXECUTION_REJECTED_ECONOMICS'
  ));

CREATE OR REPLACE FUNCTION record_paper_execution_activity() RETURNS trigger AS $$
DECLARE
  observed paper_signal_observation%ROWTYPE;
  activity_type TEXT;
  activity_severity TEXT;
  activity_time TIMESTAMPTZ;
  activity_message TEXT;
  activity_key TEXT;
BEGIN
  SELECT * INTO observed FROM paper_signal_observation WHERE id=NEW.observation_id;
  IF TG_OP = 'UPDATE' AND NEW.close_abandoned_at IS DISTINCT FROM OLD.close_abandoned_at
     AND NEW.close_abandoned_at IS NOT NULL THEN
    activity_type := 'EXECUTION_ABANDONED';
    activity_severity := 'ERROR';
    activity_time := NEW.close_abandoned_at;
    activity_key := 'execution:' || NEW.id || ':abandoned';
    activity_message := format('%s %s execution for %s was abandoned unresolved: %s.',
      NEW.model,lower(NEW.status),observed.symbol,COALESCE(NEW.unresolved_reason,'close horizon expired'));
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    activity_type := CASE NEW.status
      WHEN 'PENDING' THEN 'EXECUTION_PENDING'
      WHEN 'OPEN' THEN 'EXECUTION_OPENED'
      WHEN 'CLOSED' THEN 'EXECUTION_CLOSED'
      WHEN 'NO_FILL' THEN 'EXECUTION_NO_FILL'
      WHEN 'REJECTED_ECONOMICS' THEN 'EXECUTION_REJECTED_ECONOMICS'
      ELSE 'EXECUTION_CLOSE_PENDING'
    END;
    activity_severity := CASE NEW.status
      WHEN 'OPEN' THEN 'SUCCESS'
      WHEN 'NO_FILL' THEN 'WARNING'
      WHEN 'REJECTED_ECONOMICS' THEN 'INFO'
      WHEN 'CLOSE_PENDING' THEN 'WARNING'
      ELSE 'INFO'
    END;
    activity_time := COALESCE(NEW.exit_time,NEW.entry_time,NEW.updated_at,NEW.created_at);
    activity_key := 'execution:' || NEW.id || ':status:' || NEW.status;
    activity_message := CASE NEW.status
      WHEN 'PENDING' THEN format('%s execution for %s is waiting for its first completed candle.',NEW.model,observed.symbol)
      WHEN 'OPEN' THEN format('%s paper position opened for %s at %s with %s share(s).',NEW.model,observed.symbol,NEW.entry_price,NEW.shares)
      WHEN 'CLOSED' THEN format('%s paper position for %s closed at %s via %s; net P&L %s, R multiple %s.',
        NEW.model,observed.symbol,NEW.exit_price,replace(NEW.exit_reason,'_',' '),NEW.net_pnl,NEW.r_multiple)
      WHEN 'NO_FILL' THEN format('%s execution for %s did not fill: %s.',NEW.model,observed.symbol,replace(NEW.no_fill_reason,'_',' '))
      WHEN 'REJECTED_ECONOMICS' THEN format('%s execution for %s was declined on economics: %s.',
        NEW.model,observed.symbol,replace(NEW.economics_reason,'_',' '))
      ELSE format('%s position for %s is waiting for actionable liquidity to close.',NEW.model,observed.symbol)
    END;
  END IF;
  INSERT INTO paper_bot_activity(
    run_id,observation_id,execution_id,occurred_at,event_type,severity,symbol,
    strategy_key,model,message,details,deduplication_key
  ) VALUES (
    observed.run_id,observed.id,NEW.id,activity_time,activity_type,activity_severity,
    observed.symbol,observed.strategy_key,NEW.model,activity_message,
    jsonb_strip_nulls(jsonb_build_object('status',NEW.status,'entryPrice',NEW.entry_price,
      'entryTime',NEW.entry_time,'exitPrice',NEW.exit_price,'exitTime',NEW.exit_time,
      'exitReason',NEW.exit_reason,'noFillReason',NEW.no_fill_reason,
      'economicsReason',NEW.economics_reason,'shares',NEW.shares,
      'netPnl',NEW.net_pnl,'rMultiple',NEW.r_multiple,
      'unresolvedReason',NEW.unresolved_reason)),activity_key
  ) ON CONFLICT (deduplication_key) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Rejections are terminal like NO_FILL, so exclude them from the open-work
-- scans that the live processor and reporting funnel run every cycle.
CREATE INDEX IF NOT EXISTS paper_execution_rejected_economics_idx
  ON paper_execution(economics_reason)
  WHERE status = 'REJECTED_ECONOMICS';

INSERT INTO foundation_schema_version(version, description)
VALUES(49, 'Paper execution economic-viability gate')
ON CONFLICT(version) DO NOTHING;
