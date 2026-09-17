\set ON_ERROR_STOP on

-- Forward paper-evidence fixture (private development record Phases 3, 5, 6).
--
-- Every row is timestamped inside the mock adapter's session date
-- (2026-08-24, America/Toronto), because that is the session the live
-- processor opens its run for. Its regular-close boundary is 2026-08-24T20:00:00Z.
-- Wall-clock "now" in CI is far past that, so the market is CLOSED. Startup
-- recovery collects a post-close mock book: every outcome below is produced by
-- the durable startup path -- reconciliation, then the overdue-run sweep -- which
-- is exactly the recovery behaviour that has to hold before commissioning.

CREATE OR REPLACE FUNCTION e2e_paper_payload(
  p_event_id UUID, p_instrument UUID, p_symbol TEXT, p_ts TIMESTAMPTZ,
  p_profile UUID, p_profile_name TEXT, p_config TEXT,
  p_previous TEXT, p_state TEXT, p_score INT, p_setup UUID,
  p_entry NUMERIC, p_stop NUMERIC, p_target NUMERIC, p_atr NUMERIC,
  p_price NUMERIC
) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'kind','SETUP',
    'eventId',p_event_id,
    'eventType','STRATEGY_STATE_CHANGED',
    'instrumentId',p_instrument,
    'symbol',p_symbol,
    'timestamp',to_char(p_ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'profileId',p_profile,
    'profileName',p_profile_name,
    'strategy','ORB_RETEST',
    'strategyVersion','1.0.0',
    'configVersion',p_config,
    'previousState',p_previous,
    'state',p_state,
    'score',p_score,
    'setupScore',p_score,
    'scoreVersion','setup-score-v1',
    'setupInstanceId',p_setup,
    'reasonCodes',jsonb_build_array('BREAKOUT_CONFIRMED','RETEST_HELD'),
    'entryReference',p_entry,
    'stopReference',p_stop,
    'targetReference',p_target,
    'estimatedRr',2.0,
    'featureSnapshot',jsonb_build_object(
      'instrumentId',p_instrument,'symbol',p_symbol,
      'timestamp',to_char(p_ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'timeframe','OneMinute','featureVersion','feature-v1','configVersion',p_config,
      'dataStatus','REALTIME','actionable',true,
      'price',p_price,'bid',p_price,'ask',p_price,'mid',p_price,
      'spreadAbsolute',0.01,'spreadPct',0.05,'changeFromOpenPct',1.2,
      'vwap',p_price,'distanceFromVwapPct',0.1,'closeAboveVwap',true,
      'last3ClosesAboveVwap',3,'vwapSlopePct',0.02,
      'touchVwap',false,'vwapReclaim',false,'vwapRejection',false,
      'atr14',p_atr,'atrPct',2.5,'rvolAtTime',1.8,
      'currentCumulativeVolume',250000,'historicalMeanCumulativeVolume',180000.0,
      'openingRange',jsonb_build_object(
        'high',p_price,'low',p_price,'mid',p_price,'width',0.2,
        'widthPct',1.0,'widthAtr',0.5,'volume',50000,'complete',true),
      'swingHighs',jsonb_build_array(),'swingLows',jsonb_build_array(),
      'nearestSupport',NULL,'nearestResistance',NULL,
      'distanceFromVwapAtr',0.1,'distanceFromOrhAtr',0.2,'changeFromOpenAtr',0.3,
      'consecutiveGreenCandles',2,'recentMoveVelocityAtr',0.4,
      'warmingUp',jsonb_build_array()
    )
  );
$$;

-- One (signal, state event) pair per scenario. Reconciliation inner-joins
-- strategy_signal for source_signal_id provenance and reads its config_version
-- to resolve the profile configuration, so both rows are required.
CREATE OR REPLACE FUNCTION e2e_paper_scenario(
  p_suffix TEXT, p_symbol TEXT, p_ts TIMESTAMPTZ,
  p_profile UUID, p_profile_name TEXT, p_config_id UUID, p_config TEXT,
  p_state TEXT, p_score INT,
  p_entry NUMERIC, p_stop NUMERIC, p_target NUMERIC, p_atr NUMERIC, p_price NUMERIC
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_instrument UUID;
  v_signal UUID := ('50000000-0000-4000-8000-000000000' || p_suffix || '1')::uuid;
  v_event  UUID := ('50000000-0000-4000-8000-000000000' || p_suffix || '2')::uuid;
  v_setup  UUID := ('50000000-0000-4000-8000-000000000' || p_suffix || '3')::uuid;
BEGIN
  SELECT id INTO STRICT v_instrument FROM instrument WHERE symbol = p_symbol;

  INSERT INTO strategy_signal(
    id, instrument_id, profile_id, strategy_name, strategy_version, config_version,
    timestamp, previous_state, state, score, entry_reference, stop_reference,
    target_reference, estimated_rr, feature_snapshot_json, reason_codes, setup_instance_id)
  VALUES(v_signal, v_instrument, p_profile, 'ORB_RETEST', '1.0.0', p_config,
    p_ts, 'FORMING', p_state, p_score, p_entry, p_stop, p_target, 2.0,
    '{}'::jsonb, '["BREAKOUT_CONFIRMED","RETEST_HELD"]'::jsonb, v_setup)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO strategy_state_event(
    id, signal_id, instrument_id, profile_id, strategy_name, strategy_version,
    timestamp, previous_state, new_state, score, reason_codes, payload, setup_instance_id)
  VALUES(v_event, v_signal, v_instrument, p_profile, 'ORB_RETEST', '1.0.0',
    p_ts, 'FORMING', p_state, p_score,
    '["BREAKOUT_CONFIRMED","RETEST_HELD"]'::jsonb,
    e2e_paper_payload(v_event, v_instrument, p_symbol, p_ts, p_profile, p_profile_name,
      p_config, 'FORMING', p_state, p_score, v_setup, p_entry, p_stop, p_target, p_atr, p_price),
    v_setup)
  ON CONFLICT (id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION e2e_paper_quote(
  p_symbol TEXT, p_ts TIMESTAMPTZ, p_bid NUMERIC, p_ask NUMERIC,
  p_delayed BOOLEAN, p_halted BOOLEAN
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO quote_snapshot(
    instrument_id, timestamp, bid, ask, bid_size, ask_size, last, last_size,
    day_volume, day_open, day_high, day_low, spread_absolute, spread_pct,
    delay_seconds, is_delayed, is_halted, source)
  SELECT id, p_ts, p_bid, p_ask, 900, 900, p_bid, 100, 250000,
    p_bid, p_ask, p_bid, p_ask - p_bid, 0.25,
    CASE WHEN p_delayed THEN 15 ELSE 0 END, p_delayed, p_halted, 'QUESTRADE_MOCK'
  FROM instrument WHERE symbol = p_symbol;
END;
$$;

-- ---------------------------------------------------------------------------
-- Decision-time quotes. The reconciliation join takes the newest quote at or
-- before each signal, so the ordering here is what selects each outcome.
-- ---------------------------------------------------------------------------

-- BTO.TO: actionable 20s before S1; the same quote is 1h stale by S4.
SELECT e2e_paper_quote('BTO.TO', '2026-08-24T13:59:40Z', 7.88, 7.90, false, false);
-- BTO.TO: actionable again, for the outside-levels scenario.
SELECT e2e_paper_quote('BTO.TO', '2026-08-24T15:30:45Z', 7.88, 7.90, false, false);
-- BAM.TO: nothing before S2 (MISSING_QUOTE); then a price too high to size.
SELECT e2e_paper_quote('BAM.TO', '2026-08-24T14:20:45Z', 19999, 20000, false, false);
-- QBR.B.TO: halted, then delayed, then actionable again.
SELECT e2e_paper_quote('QBR.B.TO', '2026-08-24T14:09:50Z', 35.42, 35.44, false, true);
SELECT e2e_paper_quote('QBR.B.TO', '2026-08-24T14:29:50Z', 35.42, 35.44, true, false);
SELECT e2e_paper_quote('QBR.B.TO', '2026-08-24T14:39:50Z', 35.42, 35.44, false, false);

-- Note on ordering: availability (halted/delayed/stale) is classified before
-- level derivation and sizing, so a scenario that is meant to fail on its
-- levels or its share count needs a quote inside the 30s maximum age. The
-- offsets above are deliberate, not incidental.

-- ---------------------------------------------------------------------------
-- Scenarios. Profile 0081/config 0091 has score_cutoff 0 (everything
-- eligible); profile 0083/config 0093 has score_cutoff 70.
-- ---------------------------------------------------------------------------

-- S1 canonical fill: fresh actionable ask 7.90 -> executable 7.90158,
-- v4 risk sizing yields 329 shares against the cost-inclusive stop.
SELECT e2e_paper_scenario('01', 'BTO.TO', '2026-08-24T14:00:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'READY', 88, 7.90, 7.60, 8.50, 0.30, 7.90);

-- S2 no decision-time quote at all. The candle model is independent of the
-- quote feed and still fills, which is the divergence pair that proves entry
-- sample counts only count comparable quote/candle pairs.
SELECT e2e_paper_scenario('02', 'BAM.TO', '2026-08-24T14:05:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'READY', 84, 72.00, 70.00, 75.00, 1.20, 72.00);

-- S3 halted book at the decision.
SELECT e2e_paper_scenario('03', 'QBR.B.TO', '2026-08-24T14:10:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'READY', 80, 35.44, 34.50, 37.00, 1.30, 35.44);

-- S4 newest quote is 3620s old against a 30s maximum.
SELECT e2e_paper_scenario('04', 'BTO.TO', '2026-08-24T15:00:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'READY', 82, 7.90, 7.60, 8.50, 0.30, 7.90);

-- S5 ask 20000 -> floor(10000/20004) = 0 shares.
SELECT e2e_paper_scenario('05', 'BAM.TO', '2026-08-24T14:21:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'READY', 79, 20000, 19000, 25000, 50.0, 20000);

-- S6 delayed book at the decision.
SELECT e2e_paper_scenario('06', 'QBR.B.TO', '2026-08-24T14:30:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'READY', 78, 35.44, 34.50, 37.00, 1.30, 35.44);

-- S7 stop above the executable entry: not a tradeable structure.
SELECT e2e_paper_scenario('07', 'BTO.TO', '2026-08-24T15:31:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'READY', 77, 7.90, 8.50, 9.00, 0.30, 7.90);

-- S8 no entry reference: both models reject on derivation, not on the feed.
SELECT e2e_paper_scenario('08', 'QBR.B.TO', '2026-08-24T14:40:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'READY', 76, NULL, 34.50, 37.00, 1.30, 35.44);

-- S9 below its profile's score_cutoff of 70: observed, but no executions.
SELECT e2e_paper_scenario('09', 'BTO.TO', '2026-08-24T14:45:00Z',
  '10000000-0000-4000-8000-000000000083', 'ORB Conservative',
  '10000000-0000-4000-8000-000000000093', 'profile-orb-conservative-v1',
  'READY', 50, 7.90, 7.60, 8.50, 0.30, 7.90);

-- S10 a non-READY lifecycle must never be observed at all.
SELECT e2e_paper_scenario('10', 'BTO.TO', '2026-08-24T14:50:00Z',
  '10000000-0000-4000-8000-000000000081', 'ORB Standard',
  '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
  'FORMING', 65, 7.90, 7.60, 8.50, 0.30, 7.90);

-- ---------------------------------------------------------------------------
-- The completed one-minute bars ending exactly at the regular-close boundary. These
-- exist only in persisted history and are never re-delivered by a live batch,
-- so closing on them proves the session close reads durable state.
-- ---------------------------------------------------------------------------
INSERT INTO candle(instrument_id, timeframe, start_time, end_time, open, high, low, close, volume, source, is_complete)
SELECT id, 'OneMinute', '2026-08-24T19:59:00Z', '2026-08-24T20:00:00Z', 8.10, 8.15, 8.05, 8.12, 14000, 'QUESTRADE_MOCK', true
FROM instrument WHERE symbol = 'BTO.TO'
ON CONFLICT DO NOTHING;
INSERT INTO candle(instrument_id, timeframe, start_time, end_time, open, high, low, close, volume, source, is_complete)
SELECT id, 'OneMinute', '2026-08-24T19:59:00Z', '2026-08-24T20:00:00Z', 73.00, 73.20, 72.90, 73.10, 9000, 'QUESTRADE_MOCK', true
FROM instrument WHERE symbol = 'BAM.TO'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Two earlier live runs left unresolved at their own regular close. The close horizon
-- is one later session, and the set of LIVE runs is the bot's own record of
-- the sessions it observed:
--   2026-08-10 has two later sessions (08-17 and the 08-24 run the processor
--     opens at startup) -> past the horizon, abandoned rather than filled;
--   2026-08-17 has one -> still eligible, and the startup catch-up book can
--     close it with delayed-close provenance.
-- Their assumptions deliberately differ from the configured ones, which is
-- also what proves a prior cohort is never re-priced under today's numbers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION e2e_paper_stranded_run(
  p_run UUID, p_observation UUID, p_session DATE, p_close TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_instrument UUID;
BEGIN
  SELECT id INTO STRICT v_instrument FROM instrument WHERE symbol = 'BTO.TO';

  INSERT INTO paper_bot_run(
    id, source, session_date, session_timezone, scheduled_close_at, status,
    execution_model_version, assumptions, started_at)
  VALUES(p_run, 'LIVE', p_session, 'America/Toronto', p_close, 'CLOSE_PENDING',
    'paper-execution-v1',
    '{"positionSize":1000,"slippageBps":10,"feePerTrade":1,"stopMethod":"STRUCTURAL","atrStopMultiple":2,"rewardRiskRatio":null,"maxQuoteAgeSeconds":30,"sessionTimezone":"America/Toronto","noonCloseTime":"16:00"}'::jsonb,
    p_close - interval '2 hours')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO paper_signal_observation(
    id, run_id, source_event_id, setup_instance_id, instrument_id, symbol,
    profile_id, profile_name, profile_config_id, config_version, profile_parameters,
    strategy_key, strategy_version, signal_timestamp, score,
    entry_reference, stop_reference, target_reference, atr_14,
    feature_snapshot, reason_codes, source_event_payload, eligibility_status)
  VALUES(p_observation, p_run, gen_random_uuid(), gen_random_uuid(), v_instrument, 'BTO.TO',
    '10000000-0000-4000-8000-000000000081', 'ORB Standard',
    '10000000-0000-4000-8000-000000000091', 'profile-orb-standard-v1',
    '{"scoreCutoff":0}'::jsonb, 'ORB_RETEST', '1.0.0', p_close - interval '2 hours', 81,
    10.00, 9.50, 11.00, 0.40, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'ELIGIBLE')
  ON CONFLICT (id) DO NOTHING;

  -- A stop far below and a target far above any plausible bid, so only a
  -- session close can ever resolve it.
  INSERT INTO paper_execution(
    observation_id, model, status, entry_price, entry_time, stop_price, target_price,
    shares, initial_risk, entry_market_snapshot, entry_size_coverage, last_fact_timestamp)
  VALUES(p_observation, 'QUOTE', 'CLOSE_PENDING', 10.01, p_close - interval '2 hours',
    0.01, 200000, 99, 50.49,
    jsonb_build_object('bid',9.99,'ask',10,'bidSize',500,'askSize',500,'spread',0.01,
      'quoteTimestamp',to_char((p_close - interval '2 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'dataStatus','REALTIME','stalenessSeconds',0),
    5.05, p_close)
  ON CONFLICT (observation_id, model) DO NOTHING;
END;
$$;

SELECT e2e_paper_stranded_run(
  '50000000-0000-4000-8000-0000000000A0', '50000000-0000-4000-8000-0000000000A1',
  DATE '2026-08-10', '2026-08-10T20:00:00Z');
SELECT e2e_paper_stranded_run(
  '50000000-0000-4000-8000-0000000000B0', '50000000-0000-4000-8000-0000000000B1',
  DATE '2026-08-17', '2026-08-17T20:00:00Z');
