\set ON_ERROR_STOP on

INSERT INTO strategy_signal (
  id, instrument_id, profile_id, strategy_name, strategy_version, config_version,
  timestamp, previous_state, state, score, entry_reference, stop_reference,
  target_reference, estimated_rr, feature_snapshot_json, reason_codes, setup_instance_id
)
SELECT
  '20000000-0000-4000-8000-000000000001', i.id,
  '10000000-0000-4000-8000-000000000081', 'ORB_RETEST', '1.0.0',
  'profile-orb-standard-v1', now() - interval '2 minutes', 'WATCH',
  'READY', 88, 25.00, 24.50, 26.00, 2.0, '{}'::jsonb,
  '["BREAKOUT_CONFIRMED","RETEST_HELD"]'::jsonb,
  '20000000-0000-4000-8000-000000000099'
FROM instrument i
WHERE i.symbol = 'BTO.TO'
ON CONFLICT (id) DO NOTHING;

INSERT INTO strategy_state_event (
  id, signal_id, instrument_id, profile_id, strategy_name, strategy_version,
  timestamp, previous_state, new_state, score, reason_codes, payload
  , setup_instance_id
)
SELECT
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001', i.id,
  '10000000-0000-4000-8000-000000000081', 'ORB_RETEST', '1.0.0',
  now() - interval '2 minutes', 'WATCH', 'READY', 88,
  '["BREAKOUT_CONFIRMED","RETEST_HELD"]'::jsonb,
  jsonb_build_object('fixture', 'playwright-e2e', 'setupInstanceId', '20000000-0000-4000-8000-000000000099'),
  '20000000-0000-4000-8000-000000000099'
FROM instrument i
WHERE i.symbol = 'BTO.TO'
ON CONFLICT (id) DO NOTHING;

INSERT INTO scanner_alert (
  id, source_event_id, instrument_id, profile_id, alert_type, strategy_name,
  strategy_version, config_version, timestamp, previous_state, state, score,
  title, message, reason_codes, payload, setup_instance_id, deduplication_key
)
SELECT
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000002', i.id,
  '10000000-0000-4000-8000-000000000081', 'READY', 'ORB_RETEST', '1.0.0',
  'profile-orb-standard-v1', now() - interval '2 minutes', 'WATCH',
  'READY', 88, 'BTO.TO READY (E2E)',
  'Opening-range retest held with actionable mock data.',
  '["BREAKOUT_CONFIRMED","RETEST_HELD"]'::jsonb,
  jsonb_build_object(
    'alertId', '20000000-0000-4000-8000-000000000003',
    'eventId', '20000000-0000-4000-8000-000000000002',
    'type', 'READY',
    'symbol', 'BTO.TO',
    'strategy', 'ORB_RETEST',
    'profileId', '10000000-0000-4000-8000-000000000081',
    'profileName', 'ORB Standard',
    'strategyVersion', '1.0.0',
    'configVersion', 'profile-orb-standard-v1',
    'timestamp', to_char((now() - interval '2 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'previousState', 'WATCH',
    'state', 'READY',
    'score', 88,
    'title', 'BTO.TO READY (E2E)',
    'message', 'Opening-range retest held with actionable mock data.',
    'reasonCodes', jsonb_build_array('BREAKOUT_CONFIRMED', 'RETEST_HELD'),
    'entryReference', 25.00,
    'stopReference', 24.50,
    'targetReference', 26.00,
    'setupInstanceId', '20000000-0000-4000-8000-000000000099',
    'deduplicationKey', 'READY:20000000-0000-4000-8000-000000000099'
  ),
  '20000000-0000-4000-8000-000000000099',
  'READY:20000000-0000-4000-8000-000000000099'
FROM instrument i
WHERE i.symbol = 'BTO.TO'
ON CONFLICT (id) DO NOTHING;
