-- Stage 1 of removing the redundant strategy_signal.feature_snapshot_json copy.
-- The canonical snapshot is feature_snapshot.snapshot_json, reached through
-- feature_snapshot_id; the signal row's copy was byte-identical to it and
-- duplicated roughly eight times per snapshot (32GB of TOAST at review time).
-- No reader in api/worker/web/scanner selects it; candidate and profile reads
-- join feature_snapshot for the canonical JSON. This migration only relaxes
-- NOT NULL so the application can stop writing it. The column and its retained
-- history stay in place until a later deployment drops it, and rows are not
-- rewritten, so no table rewrite or VACUUM FULL is triggered here.
ALTER TABLE strategy_signal ALTER COLUMN feature_snapshot_json DROP NOT NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(133, 'Strategy signal duplicate snapshot copy made nullable')
ON CONFLICT(version) DO NOTHING;
