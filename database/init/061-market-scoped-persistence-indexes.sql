-- The market-aware persistence paths read the latest state and resolve a
-- feature snapshot by market on every scan cycle. Existing pre-market indexes
-- cannot satisfy those predicates without scanning sibling-market history.

CREATE INDEX IF NOT EXISTS strategy_signal_market_profile_latest_idx
  ON strategy_signal(market_id,profile_id,instrument_id,timestamp DESC)
  WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS strategy_evaluation_market_profile_latest_idx
  ON strategy_evaluation(market_id,profile_id,instrument_id,timestamp DESC);
CREATE INDEX IF NOT EXISTS feature_snapshot_market_instrument_version_time_idx
  ON feature_snapshot(market_id,instrument_id,feature_version,timestamp DESC);
CREATE INDEX IF NOT EXISTS context_evaluation_market_feature_idx
  ON context_evaluation(market_id,feature_snapshot_id);

INSERT INTO foundation_schema_version(version,description)
VALUES(61,'Indexes for market-scoped scan persistence')
ON CONFLICT(version) DO NOTHING;
