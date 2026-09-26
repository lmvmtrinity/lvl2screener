-- Lookup indexes superseded by the market/profile scoped indexes introduced
-- with market identity (strategy_signal_market_profile_latest_idx,
-- strategy_evaluation_market_profile_latest_idx). All three held zero lifetime
-- scans at the September 18 review and together occupy roughly 3.3GB; dropping
-- them also removes write amplification from the two hottest strategy tables.
-- strategy_evaluation_feature_snapshot_idx is deliberately retained: it is the
-- referencing-side index for the (feature_snapshot_id, timestamp) foreign key,
-- and the retention delete of feature_snapshot rows depends on it.
DROP INDEX IF EXISTS strategy_signal_latest_idx;
DROP INDEX IF EXISTS strategy_evaluation_profile_latest_idx;
DROP INDEX IF EXISTS strategy_evaluation_opportunities_idx;

INSERT INTO foundation_schema_version(version, description)
VALUES(134, 'Drop superseded strategy lookup indexes')
ON CONFLICT(version) DO NOTHING;
