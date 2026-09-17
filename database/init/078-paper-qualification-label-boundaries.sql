-- Profile research policy v4 purges training labels at each test boundary.
-- Older projections remain historical; consumers require v4. Training labels
-- must be known strictly before the first test signal, across instruments.
-- Session partitions are per profile/strategy cohort, matching the TS gate.

CREATE OR REPLACE FUNCTION refresh_paper_profile_qualifications(completed_run_id UUID) RETURNS void AS $$
DECLARE
  cohort_market TEXT;
  cohort_version TEXT;
  cohort_assumptions JSONB;
BEGIN
  SELECT market_id,execution_model_version,assumptions
    INTO cohort_market,cohort_version,cohort_assumptions
  FROM paper_bot_run
  WHERE id=completed_run_id AND source='LIVE' AND status='COMPLETED';
  IF NOT FOUND THEN RETURN; END IF;

  WITH eligible AS (
    SELECT x.id,x.r_multiple,x.net_pnl,x.exit_time,o.instrument_id,o.profile_config_id,o.strategy_key,o.strategy_version,
           o.signal_timestamp,
           CASE WHEN cohort_market='US_EQUITIES'
             THEN (o.signal_timestamp AT TIME ZONE 'America/New_York')::date
             ELSE (o.signal_timestamp AT TIME ZONE 'America/Toronto')::date
           END AS session_date
    FROM paper_execution x
    JOIN paper_signal_observation o ON o.id=x.observation_id
    JOIN paper_bot_run r ON r.id=o.run_id
    WHERE r.market_id=cohort_market AND r.source='LIVE' AND r.status='COMPLETED'
      AND r.execution_model_version=cohort_version AND r.execution_model_version='paper-execution-v7'
      AND r.assumptions=cohort_assumptions
      AND x.model='QUOTE' AND x.status='CLOSED' AND x.r_multiple IS NOT NULL
      AND x.exit_time >= o.signal_timestamp
      AND COALESCE(o.source_event_payload->>'signalSemanticsVersion','UNKNOWN') NOT IN ('','UNKNOWN')
      AND COALESCE(r.assumptions->>'evidenceScope','UNKNOWN') NOT IN ('','UNKNOWN')
  ),
  sequenced AS (
    SELECT e.*,max(exit_time) OVER (
      PARTITION BY profile_config_id,strategy_key,strategy_version,instrument_id ORDER BY signal_timestamp,id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS prior_exit_time
    FROM eligible e
  ),
  non_overlapping AS (
    SELECT * FROM sequenced
    WHERE prior_exit_time IS NULL OR signal_timestamp >= prior_exit_time
  ),
  dates AS (
    SELECT DISTINCT profile_config_id,strategy_key,strategy_version,session_date FROM non_overlapping
  ),
  ranked_dates AS (
    SELECT *,row_number() OVER cohort AS ordinal,count(*) OVER (
      PARTITION BY profile_config_id,strategy_key,strategy_version
    ) AS session_count
    FROM dates
    WINDOW cohort AS (PARTITION BY profile_config_id,strategy_key,strategy_version ORDER BY session_date)
  ),
  date_buckets AS (
    SELECT *,least(4,1+(ordinal-1)/greatest(1,session_count/4)) AS block,
      ordinal <= greatest(1,least(session_count-1,floor(session_count*0.8))) AS is_train
    FROM ranked_dates
  ),
  bucketed AS (
    SELECT e.*,d.block,d.is_train
    FROM non_overlapping e JOIN date_buckets d
      USING(profile_config_id,strategy_key,strategy_version,session_date)
  ),
  boundaries AS (
    SELECT *,min(signal_timestamp) FILTER (WHERE NOT is_train) OVER (
      PARTITION BY profile_config_id,strategy_key,strategy_version
    ) AS holdout_start
    FROM bucketed
  ),
  summary AS (
    SELECT profile_config_id,strategy_key,strategy_version,
           count(*)::integer AS total,
           count(*) FILTER (WHERE is_train AND exit_time < holdout_start)::integer AS train_rows,
           count(*) FILTER (WHERE NOT is_train)::integer AS test_rows,
           count(*) FILTER (WHERE is_train AND exit_time < holdout_start AND r_multiple > 0)::integer AS train_pos,
           count(*) FILTER (WHERE is_train AND exit_time < holdout_start AND r_multiple <= 0)::integer AS train_neg,
           count(*) FILTER (WHERE NOT is_train AND r_multiple > 0)::integer AS test_pos,
           count(*) FILTER (WHERE NOT is_train AND r_multiple <= 0)::integer AS test_neg,
           count(*) FILTER (WHERE r_multiple > 0)::integer AS wins,
           coalesce(avg(r_multiple) FILTER (WHERE NOT is_train),0) AS test_expectancy,
           count(DISTINCT session_date)::integer AS sessions
    FROM boundaries
    GROUP BY profile_config_id,strategy_key,strategy_version
  ),
  window_boundaries AS (
    SELECT profile_config_id,strategy_key,strategy_version,block AS index,
           min(signal_timestamp) AS test_start
    FROM bucketed WHERE block >= 2
    GROUP BY profile_config_id,strategy_key,strategy_version,block
  ),
  walk_forward_windows AS (
    SELECT b.profile_config_id,b.strategy_key,b.strategy_version,w.index,
           count(b.id) FILTER (WHERE b.block < w.index AND b.exit_time < w.test_start)::integer AS train_rows,
           count(b.id) FILTER (WHERE b.block = w.index)::integer AS test_rows,
           coalesce(avg(b.r_multiple) FILTER (WHERE b.block = w.index),0) AS test_expectancy
    FROM window_boundaries w
    JOIN bucketed b USING(profile_config_id,strategy_key,strategy_version)
    GROUP BY b.profile_config_id,b.strategy_key,b.strategy_version,w.index
  ),
  walk_forward AS (
    SELECT profile_config_id,strategy_key,strategy_version,
           count(*) FILTER (
             WHERE train_rows > 0 AND test_rows >= 30 AND test_expectancy > 0
           )::integer AS qualified_windows,
           count(*)::integer AS windows
    FROM walk_forward_windows
    GROUP BY profile_config_id,strategy_key,strategy_version
  )
  INSERT INTO paper_profile_qualification(
    market_id,profile_config_id,strategy_key,strategy_version,execution_model_version,
    assumptions,policy_version,as_of_run_id,closed_trades,wins,net_pnl,cumulative_r,average_r,qualification
  )
  SELECT cohort_market,s.profile_config_id,s.strategy_key,s.strategy_version,cohort_version,
    cohort_assumptions,'paper-qualification-v4',completed_run_id,
    s.total,s.wins,coalesce(sum(b.net_pnl),0),coalesce(sum(b.r_multiple),0),coalesce(avg(b.r_multiple),0),
    CASE WHEN s.train_rows + s.test_rows >= 200 AND s.sessions >= 4
              AND s.train_rows >= 100 AND s.test_rows >= 40
              AND s.train_pos > 0 AND s.train_neg > 0
              AND s.test_pos > 0 AND s.test_neg > 0
              AND s.test_expectancy > 0
              AND wf.qualified_windows = 3
              AND wf.windows = 3
         THEN 'PAPER_QUALIFIED' ELSE 'EXPLORATORY' END
  FROM summary s
  JOIN bucketed b
    ON b.profile_config_id=s.profile_config_id
   AND b.strategy_key=s.strategy_key
   AND b.strategy_version=s.strategy_version
  LEFT JOIN walk_forward wf
    ON wf.profile_config_id=s.profile_config_id
   AND wf.strategy_key=s.strategy_key
   AND wf.strategy_version=s.strategy_version
  GROUP BY s.profile_config_id,s.strategy_key,s.strategy_version,
           s.total,s.wins,s.test_pos,s.train_rows,s.test_rows,s.train_pos,s.train_neg,
           s.test_neg,s.test_expectancy,s.sessions,wf.qualified_windows,wf.windows
  ON CONFLICT(market_id,profile_config_id,strategy_key,strategy_version,execution_model_version,assumptions,policy_version)
  DO UPDATE SET as_of_run_id=EXCLUDED.as_of_run_id,
    closed_trades=EXCLUDED.closed_trades,wins=EXCLUDED.wins,net_pnl=EXCLUDED.net_pnl,
    cumulative_r=EXCLUDED.cumulative_r,average_r=EXCLUDED.average_r,
    qualification=EXCLUDED.qualification,computed_at=now();
END;
$$ LANGUAGE plpgsql;

-- Seed v4 idempotently without rewriting earlier policy evidence.
SELECT refresh_paper_profile_qualifications(id)
FROM paper_bot_run WHERE source='LIVE' AND status='COMPLETED';

INSERT INTO foundation_schema_version(version,description)
VALUES(78,'Paper profile qualification v4: label-boundary purging')
ON CONFLICT(version) DO NOTHING;
