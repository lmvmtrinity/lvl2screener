-- Freeze research and model provenance to one market.  The market columns
-- were added in 056; this migration makes the data relationship enforceable.

UPDATE statistical_training_dataset
   SET market_id=COALESCE(cohort->>'marketId','CA_TSX')
 WHERE market_id IS DISTINCT FROM COALESCE(cohort->>'marketId','CA_TSX');

UPDATE statistical_model m
   SET market_id=d.market_id
  FROM statistical_training_dataset d
 WHERE d.id=m.training_dataset_id;

UPDATE statistical_model m
   SET market_id=b.market_id
  FROM backtest_run b
 WHERE b.id=m.backtest_run_id
   AND m.training_dataset_id IS NULL;

ALTER TABLE statistical_training_dataset
  ADD CONSTRAINT statistical_training_dataset_cohort_market_check
  CHECK (cohort ? 'marketId' AND cohort->>'marketId'=market_id);

CREATE OR REPLACE FUNCTION assert_statistical_model_market_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_market TEXT;
BEGIN
  IF NEW.training_dataset_id IS NOT NULL THEN
    SELECT market_id INTO source_market FROM statistical_training_dataset WHERE id=NEW.training_dataset_id;
  ELSIF NEW.backtest_run_id IS NOT NULL THEN
    SELECT market_id INTO source_market FROM backtest_run WHERE id=NEW.backtest_run_id;
  END IF;

  IF source_market IS NULL OR NEW.market_id IS DISTINCT FROM source_market THEN
    RAISE EXCEPTION 'statistical model market must match its immutable evidence source';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS statistical_model_market_match ON statistical_model;
CREATE TRIGGER statistical_model_market_match
  BEFORE INSERT OR UPDATE OF market_id,training_dataset_id,backtest_run_id ON statistical_model
  FOR EACH ROW EXECUTE FUNCTION assert_statistical_model_market_match();

CREATE INDEX IF NOT EXISTS statistical_training_dataset_market_created_idx
  ON statistical_training_dataset(market_id,created_at DESC);
CREATE INDEX IF NOT EXISTS statistical_model_market_created_idx
  ON statistical_model(market_id,created_at DESC);

INSERT INTO foundation_schema_version(version,description)
VALUES(59,'Market-isolated statistical training datasets and models')
ON CONFLICT(version) DO NOTHING;
