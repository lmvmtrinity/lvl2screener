-- Constant-time checkpoint cadence and database-clock funded inbox rates.
--
-- `checkpoint_sequence` proves the newest checkpoint cursor, but using it to
-- COUNT the growing suffix on every ledger write makes checkpoint eligibility
-- quadratic within each interval. Maintain the account-local suffix count in
-- the same locked transaction instead. The insert trigger keeps the counter
-- correct while old and new application versions overlap during deployment.
ALTER TABLE paper_funded_account
  ADD COLUMN events_since_checkpoint BIGINT NOT NULL DEFAULT 0
  CHECK (events_since_checkpoint >= 0);

CREATE FUNCTION increment_funded_checkpoint_event_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE paper_funded_account a
  SET events_since_checkpoint = a.events_since_checkpoint + inserted.count
  FROM (
    SELECT account_id,count(*) AS count
    FROM inserted_funded_events
    GROUP BY account_id
  ) inserted
  WHERE a.id = inserted.account_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER paper_funded_event_checkpoint_count
AFTER INSERT ON paper_funded_event
REFERENCING NEW TABLE AS inserted_funded_events
FOR EACH STATEMENT EXECUTE FUNCTION increment_funded_checkpoint_event_count();

-- The trigger is installed before this statement inside the migration
-- transaction. Events committed before its table lock are included here;
-- writers released after commit use the trigger, leaving no cutover gap.
UPDATE paper_funded_account a
SET events_since_checkpoint = (
  SELECT count(*)
  FROM paper_funded_event e
  WHERE e.account_id = a.id
    AND e.event_sequence > a.checkpoint_sequence
);

-- `fact_at` is economic time and can be historical when retained facts are
-- enqueued later. Minute buckets record database time without rewriting or
-- indexing the mature fact table during API startup. Triggers cover old and
-- new application writers and roll back atomically with the fact mutation.
CREATE TABLE paper_funded_fact_rate_minute (
  run_id UUID NOT NULL REFERENCES paper_funded_run(run_id) ON DELETE CASCADE,
  bucket_at TIMESTAMPTZ NOT NULL,
  enqueued_count BIGINT NOT NULL DEFAULT 0 CHECK (enqueued_count >= 0),
  processed_count BIGINT NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  PRIMARY KEY(run_id, bucket_at)
);

CREATE FUNCTION record_funded_fact_rate_minute()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  observed_bucket TIMESTAMPTZ := date_trunc('minute', clock_timestamp());
  enqueued_delta BIGINT := 0;
  processed_delta BIGINT := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    enqueued_delta := 1;
    IF NEW.processed_at IS NOT NULL THEN processed_delta := 1; END IF;
  ELSIF OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL THEN
    processed_delta := 1;
  END IF;

  IF enqueued_delta > 0 OR processed_delta > 0 THEN
    INSERT INTO paper_funded_fact_rate_minute(
      run_id,bucket_at,enqueued_count,processed_count
    ) VALUES(NEW.run_id,observed_bucket,enqueued_delta,processed_delta)
    ON CONFLICT(run_id,bucket_at) DO UPDATE SET
      enqueued_count = paper_funded_fact_rate_minute.enqueued_count
        + EXCLUDED.enqueued_count,
      processed_count = paper_funded_fact_rate_minute.processed_count
        + EXCLUDED.processed_count;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER paper_funded_fact_rate_insert
AFTER INSERT ON paper_funded_fact
FOR EACH ROW EXECUTE FUNCTION record_funded_fact_rate_minute();

CREATE TRIGGER paper_funded_fact_rate_processed
AFTER UPDATE OF processed_at ON paper_funded_fact
FOR EACH ROW EXECUTE FUNCTION record_funded_fact_rate_minute();

INSERT INTO foundation_schema_version(version, description)
VALUES(126, 'Constant-time funded checkpoints and database-clock inbox rates')
ON CONFLICT(version) DO NOTHING;
