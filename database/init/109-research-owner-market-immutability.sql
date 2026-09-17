-- A valid insertion cannot later be moved into another market by editing its owner.
CREATE FUNCTION protect_bound_research_owner_market() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_market TEXT; after_market TEXT; kind TEXT;
BEGIN
  kind:=TG_ARGV[0];
  IF TG_TABLE_NAME='research_job' THEN
    before_market:=research_job_owner_market(OLD.request_payload,OLD.job_type);
    after_market:=research_job_owner_market(NEW.request_payload,NEW.job_type);
  ELSE
    before_market:=OLD.market_id; after_market:=NEW.market_id;
  END IF;
  IF before_market IS DISTINCT FROM after_market AND
    (OLD.research_evidence IS NOT NULL OR EXISTS (
      SELECT 1 FROM research_evidence_binding WHERE owner_kind=kind AND owner_id=OLD.id))
  THEN RAISE EXCEPTION 'IMMUTABLE_RESEARCH_OWNER_MARKET'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bound_research_job_market BEFORE UPDATE OF request_payload,job_type ON research_job
FOR EACH ROW EXECUTE FUNCTION protect_bound_research_owner_market('JOB');
DO $$ DECLARE item RECORD; BEGIN
  FOR item IN SELECT * FROM (VALUES ('backtest_run','BACKTEST'),('calibration_run','CALIBRATION'),
    ('statistical_training_dataset','DATASET'),('statistical_model','MODEL')) AS owners(tbl,kind)
  LOOP
    EXECUTE format('CREATE TRIGGER bound_research_owner_market BEFORE UPDATE OF market_id ON %I FOR EACH ROW EXECUTE FUNCTION protect_bound_research_owner_market(%L)',item.tbl,item.kind);
  END LOOP;
END $$;
INSERT INTO foundation_schema_version(version,description)
VALUES(109,'Preserve bound research owner market on updates') ON CONFLICT(version) DO NOTHING;
