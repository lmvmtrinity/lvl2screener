-- Durable, human-readable paper-bot activity journal. Database triggers keep
-- the journal complete even when a transition is written outside the live API
-- process, and the deduplication key makes migration backfill idempotent.

CREATE TABLE IF NOT EXISTS paper_bot_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES paper_bot_run(id) ON DELETE CASCADE,
  observation_id UUID REFERENCES paper_signal_observation(id) ON DELETE SET NULL,
  execution_id UUID REFERENCES paper_execution(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'RUN_STARTED','RUN_COMPLETED','RUN_CLOSE_PENDING','RUN_FAILED',
    'SIGNAL_ELIGIBLE','SIGNAL_BELOW_CUTOFF',
    'EXECUTION_PENDING','EXECUTION_OPENED','EXECUTION_CLOSED',
    'EXECUTION_NO_FILL','EXECUTION_CLOSE_PENDING','EXECUTION_ABANDONED'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('INFO','SUCCESS','WARNING','ERROR')),
  symbol TEXT,
  strategy_key TEXT,
  model TEXT CHECK (model IS NULL OR model IN ('QUOTE','CANDLE')),
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  deduplication_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_bot_activity_timeline_idx
  ON paper_bot_activity(occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS paper_bot_activity_run_timeline_idx
  ON paper_bot_activity(run_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION record_paper_bot_run_activity() RETURNS trigger AS $$
DECLARE
  activity_type TEXT;
  activity_severity TEXT;
  activity_time TIMESTAMPTZ;
  activity_message TEXT;
  observation_count INTEGER;
  execution_count INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO paper_bot_activity(
      run_id,occurred_at,event_type,severity,message,details,deduplication_key
    ) VALUES (
      NEW.id,NEW.started_at,'RUN_STARTED','INFO',
      format('Paper bot started the %s run for %s; scheduled close is %s.',
        lower(NEW.source),NEW.session_date,NEW.scheduled_close_at),
      jsonb_build_object('source',NEW.source,'status',NEW.status,
        'sessionDate',NEW.session_date,'scheduledCloseAt',NEW.scheduled_close_at,
        'executionModelVersion',NEW.execution_model_version),
      'run:' || NEW.id || ':started'
    ) ON CONFLICT (deduplication_key) DO NOTHING;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT count(*) INTO observation_count FROM paper_signal_observation WHERE run_id=NEW.id;
  SELECT count(*) INTO execution_count
    FROM paper_execution e JOIN paper_signal_observation o ON o.id=e.observation_id
    WHERE o.run_id=NEW.id;
  activity_type := CASE NEW.status
    WHEN 'COMPLETED' THEN 'RUN_COMPLETED'
    WHEN 'CLOSE_PENDING' THEN 'RUN_CLOSE_PENDING'
    WHEN 'FAILED' THEN 'RUN_FAILED'
    ELSE 'RUN_STARTED'
  END;
  activity_severity := CASE NEW.status
    WHEN 'COMPLETED' THEN 'SUCCESS'
    WHEN 'FAILED' THEN 'ERROR'
    WHEN 'CLOSE_PENDING' THEN 'WARNING'
    ELSE 'INFO'
  END;
  activity_time := COALESCE(NEW.completed_at,NEW.failed_at,now());
  activity_message := CASE NEW.status
    WHEN 'COMPLETED' THEN format(
      'Paper bot completed the %s run for %s with %s READY signal observation(s) and %s execution record(s).',
      lower(NEW.source),NEW.session_date,observation_count,execution_count)
    WHEN 'FAILED' THEN format('Paper bot run for %s failed: %s.',NEW.session_date,COALESCE(NEW.failure_reason,'unknown error'))
    WHEN 'CLOSE_PENDING' THEN format('Paper bot run for %s is waiting for remaining positions to close.',NEW.session_date)
    ELSE format('Paper bot run for %s resumed.',NEW.session_date)
  END;
  INSERT INTO paper_bot_activity(
    run_id,occurred_at,event_type,severity,message,details,deduplication_key
  ) VALUES (
    NEW.id,activity_time,activity_type,activity_severity,activity_message,
    jsonb_build_object('source',NEW.source,'status',NEW.status,
      'sessionDate',NEW.session_date,'observationCount',observation_count,
      'executionCount',execution_count,'failureReason',NEW.failure_reason),
    'run:' || NEW.id || ':status:' || NEW.status
  ) ON CONFLICT (deduplication_key) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_paper_signal_activity() RETURNS trigger AS $$
BEGIN
  INSERT INTO paper_bot_activity(
    run_id,observation_id,occurred_at,event_type,severity,symbol,strategy_key,
    message,details,deduplication_key
  ) VALUES (
    NEW.run_id,NEW.id,NEW.created_at,
    CASE NEW.eligibility_status WHEN 'ELIGIBLE' THEN 'SIGNAL_ELIGIBLE' ELSE 'SIGNAL_BELOW_CUTOFF' END,
    CASE NEW.eligibility_status WHEN 'ELIGIBLE' THEN 'SUCCESS' ELSE 'INFO' END,
    NEW.symbol,NEW.strategy_key,
    CASE NEW.eligibility_status
      WHEN 'ELIGIBLE' THEN format('%s %s reached READY with score %s and qualified for paper execution.',NEW.symbol,NEW.strategy_key,NEW.score)
      ELSE format('%s %s reached READY with score %s but stayed below the configured cutoff.',NEW.symbol,NEW.strategy_key,NEW.score)
    END,
    jsonb_build_object('score',NEW.score,'eligibilityStatus',NEW.eligibility_status,
      'eligibilityReason',NEW.eligibility_reason,'profileName',NEW.profile_name,
      'configVersion',NEW.config_version,'reasonCodes',NEW.reason_codes),
    'observation:' || NEW.id
  ) ON CONFLICT (deduplication_key) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
      ELSE 'EXECUTION_CLOSE_PENDING'
    END;
    activity_severity := CASE NEW.status
      WHEN 'OPEN' THEN 'SUCCESS'
      WHEN 'NO_FILL' THEN 'WARNING'
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
      'exitReason',NEW.exit_reason,'noFillReason',NEW.no_fill_reason,'shares',NEW.shares,
      'netPnl',NEW.net_pnl,'rMultiple',NEW.r_multiple,
      'unresolvedReason',NEW.unresolved_reason)),activity_key
  ) ON CONFLICT (deduplication_key) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill the durable history that can be reconstructed exactly.
INSERT INTO paper_bot_activity(run_id,occurred_at,event_type,severity,message,details,deduplication_key)
SELECT id,started_at,'RUN_STARTED','INFO',
  format('Paper bot started the %s run for %s; scheduled close is %s.',lower(source),session_date,scheduled_close_at),
  jsonb_build_object('source',source,'status',status,'sessionDate',session_date,
    'scheduledCloseAt',scheduled_close_at,'executionModelVersion',execution_model_version),
  'run:' || id || ':started'
FROM paper_bot_run ON CONFLICT (deduplication_key) DO NOTHING;

INSERT INTO paper_bot_activity(run_id,occurred_at,event_type,severity,message,details,deduplication_key)
SELECT r.id,COALESCE(r.completed_at,r.failed_at,r.started_at),
  CASE r.status WHEN 'COMPLETED' THEN 'RUN_COMPLETED' WHEN 'FAILED' THEN 'RUN_FAILED' ELSE 'RUN_CLOSE_PENDING' END,
  CASE r.status WHEN 'COMPLETED' THEN 'SUCCESS' WHEN 'FAILED' THEN 'ERROR' ELSE 'WARNING' END,
  CASE r.status
    WHEN 'COMPLETED' THEN format('Paper bot completed the %s run for %s with %s READY signal observation(s) and %s execution record(s).',lower(r.source),r.session_date,
      (SELECT count(*) FROM paper_signal_observation o WHERE o.run_id=r.id),
      (SELECT count(*) FROM paper_execution e JOIN paper_signal_observation o ON o.id=e.observation_id WHERE o.run_id=r.id))
    WHEN 'FAILED' THEN format('Paper bot run for %s failed: %s.',r.session_date,COALESCE(r.failure_reason,'unknown error'))
    ELSE format('Paper bot run for %s is waiting for remaining positions to close.',r.session_date)
  END,
  jsonb_build_object('source',r.source,'status',r.status,'sessionDate',r.session_date,'failureReason',r.failure_reason),
  'run:' || r.id || ':status:' || r.status
FROM paper_bot_run r WHERE r.status IN ('COMPLETED','FAILED','CLOSE_PENDING')
ON CONFLICT (deduplication_key) DO NOTHING;

INSERT INTO paper_bot_activity(run_id,observation_id,occurred_at,event_type,severity,symbol,strategy_key,message,details,deduplication_key)
SELECT o.run_id,o.id,o.created_at,
  CASE o.eligibility_status WHEN 'ELIGIBLE' THEN 'SIGNAL_ELIGIBLE' ELSE 'SIGNAL_BELOW_CUTOFF' END,
  CASE o.eligibility_status WHEN 'ELIGIBLE' THEN 'SUCCESS' ELSE 'INFO' END,
  o.symbol,o.strategy_key,
  CASE o.eligibility_status
    WHEN 'ELIGIBLE' THEN format('%s %s reached READY with score %s and qualified for paper execution.',o.symbol,o.strategy_key,o.score)
    ELSE format('%s %s reached READY with score %s but stayed below the configured cutoff.',o.symbol,o.strategy_key,o.score)
  END,
  jsonb_build_object('score',o.score,'eligibilityStatus',o.eligibility_status,
    'eligibilityReason',o.eligibility_reason,'profileName',o.profile_name,
    'configVersion',o.config_version,'reasonCodes',o.reason_codes),
  'observation:' || o.id
FROM paper_signal_observation o ON CONFLICT (deduplication_key) DO NOTHING;

-- Current execution state is backfilled. Future transitions are captured by
-- the trigger below, preserving the full timeline from this migration onward.
INSERT INTO paper_bot_activity(run_id,observation_id,execution_id,occurred_at,event_type,severity,symbol,strategy_key,model,message,details,deduplication_key)
SELECT o.run_id,o.id,e.id,COALESCE(e.exit_time,e.entry_time,e.updated_at,e.created_at),
  CASE e.status WHEN 'PENDING' THEN 'EXECUTION_PENDING' WHEN 'OPEN' THEN 'EXECUTION_OPENED'
    WHEN 'CLOSED' THEN 'EXECUTION_CLOSED' WHEN 'NO_FILL' THEN 'EXECUTION_NO_FILL'
    ELSE 'EXECUTION_CLOSE_PENDING' END,
  CASE e.status WHEN 'OPEN' THEN 'SUCCESS' WHEN 'NO_FILL' THEN 'WARNING'
    WHEN 'CLOSE_PENDING' THEN 'WARNING' ELSE 'INFO' END,
  o.symbol,o.strategy_key,e.model,
  CASE e.status
    WHEN 'PENDING' THEN format('%s execution for %s is waiting for its first completed candle.',e.model,o.symbol)
    WHEN 'OPEN' THEN format('%s paper position opened for %s at %s with %s share(s).',e.model,o.symbol,e.entry_price,e.shares)
    WHEN 'CLOSED' THEN format('%s paper position for %s closed at %s via %s; net P&L %s, R multiple %s.',e.model,o.symbol,e.exit_price,replace(e.exit_reason,'_',' '),e.net_pnl,e.r_multiple)
    WHEN 'NO_FILL' THEN format('%s execution for %s did not fill: %s.',e.model,o.symbol,replace(e.no_fill_reason,'_',' '))
    ELSE format('%s position for %s is waiting for actionable liquidity to close.',e.model,o.symbol)
  END,
  jsonb_strip_nulls(jsonb_build_object('status',e.status,'entryPrice',e.entry_price,
    'entryTime',e.entry_time,'exitPrice',e.exit_price,'exitTime',e.exit_time,
    'exitReason',e.exit_reason,'noFillReason',e.no_fill_reason,'shares',e.shares,
    'netPnl',e.net_pnl,'rMultiple',e.r_multiple,'unresolvedReason',e.unresolved_reason)),
  'execution:' || e.id || ':status:' || e.status
FROM paper_execution e JOIN paper_signal_observation o ON o.id=e.observation_id
ON CONFLICT (deduplication_key) DO NOTHING;

DROP TRIGGER IF EXISTS paper_bot_run_activity ON paper_bot_run;
CREATE TRIGGER paper_bot_run_activity AFTER INSERT OR UPDATE OF status ON paper_bot_run
FOR EACH ROW EXECUTE FUNCTION record_paper_bot_run_activity();

DROP TRIGGER IF EXISTS paper_signal_activity ON paper_signal_observation;
CREATE TRIGGER paper_signal_activity AFTER INSERT ON paper_signal_observation
FOR EACH ROW EXECUTE FUNCTION record_paper_signal_activity();

DROP TRIGGER IF EXISTS paper_execution_activity ON paper_execution;
CREATE TRIGGER paper_execution_activity AFTER INSERT OR UPDATE OF status,close_abandoned_at ON paper_execution
FOR EACH ROW EXECUTE FUNCTION record_paper_execution_activity();

INSERT INTO foundation_schema_version(version, description)
VALUES(37, 'Durable human-readable paper-bot activity journal')
ON CONFLICT(version) DO NOTHING;
