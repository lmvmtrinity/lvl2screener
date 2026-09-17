ALTER TABLE universe_watchlist
  ADD COLUMN IF NOT EXISTS candidates JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE universe_watchlist watchlist
SET candidates = COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'source', 'MANUAL',
    'tradingDate', watchlist.trading_date::text,
    'addedAt', watchlist.updated_at,
    'originalInput', symbol,
    'normalizedSymbol', symbol,
    'note', NULL,
    'tags', '[]'::jsonb
  ) ORDER BY symbol)
  FROM jsonb_array_elements_text(watchlist.symbols) AS symbol
), '[]'::jsonb)
WHERE candidates = '[]'::jsonb
  AND jsonb_array_length(symbols) > 0;

ALTER TABLE universe_watchlist
  DROP CONSTRAINT IF EXISTS universe_watchlist_candidates_array;
ALTER TABLE universe_watchlist
  ADD CONSTRAINT universe_watchlist_candidates_array CHECK (jsonb_typeof(candidates) = 'array');

ALTER TABLE strategy_signal ADD COLUMN IF NOT EXISTS setup_instance_id UUID;
ALTER TABLE strategy_evaluation ADD COLUMN IF NOT EXISTS setup_instance_id UUID;
ALTER TABLE strategy_state_event ADD COLUMN IF NOT EXISTS setup_instance_id UUID;
ALTER TABLE scanner_alert ADD COLUMN IF NOT EXISTS setup_instance_id UUID;
ALTER TABLE scanner_alert ADD COLUMN IF NOT EXISTS deduplication_key TEXT;

UPDATE strategy_state_event
SET setup_instance_id=(payload->>'setupInstanceId')::uuid
WHERE setup_instance_id IS NULL
  AND payload->>'setupInstanceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
UPDATE scanner_alert
SET setup_instance_id=(payload->>'setupInstanceId')::uuid
WHERE setup_instance_id IS NULL
  AND payload->>'setupInstanceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
UPDATE scanner_alert
SET deduplication_key=alert_type || ':' || COALESCE(setup_instance_id::text,source_event_id::text)
WHERE deduplication_key IS NULL;
ALTER TABLE scanner_alert ALTER COLUMN deduplication_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS scanner_alert_deduplication_idx ON scanner_alert(deduplication_key);
CREATE UNIQUE INDEX IF NOT EXISTS scanner_alert_ready_setup_instance_idx
  ON scanner_alert(setup_instance_id) WHERE alert_type='READY' AND setup_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scanner_alert_policy (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  cooldown_minutes INTEGER NOT NULL DEFAULT 5 CHECK(cooldown_minutes BETWEEN 0 AND 120),
  rearm_rule TEXT NOT NULL DEFAULT 'NEW_SETUP_INSTANCE' CHECK(rearm_rule IN ('NEW_SETUP_INSTANCE','AFTER_INVALIDATION')),
  context_notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK(context_notifications_enabled=FALSE),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO scanner_alert_policy(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING;

INSERT INTO foundation_schema_version(version,description)
VALUES(18,'Phase 7 daily workflow, operator UX, and setup-instance alert policy')
ON CONFLICT(version) DO NOTHING;
