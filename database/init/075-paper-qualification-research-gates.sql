-- Paper profile qualification v3 is a capital-allocation research gate, not
-- an execution-count projection. It is scoped to explicit provenance, uses
-- closed labels only, and requires a chronological four-block walk-forward
-- with adequate samples and positive holdout expectancy in every test block.

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
    SELECT x.id,x.r_multiple,x.exit_time,o.instrument_id,o.profile_config_id,o.strategy_key,o.strategy_version,
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
      AND COALESCE(o.source_event_payload->>'signalSemanticsVersion','UNKNOWN') NOT IN ('','UNKNOWN')
      AND COALESCE(r.assumptions->>'evidenceScope','UNKNOWN') NOT IN ('','UNKNOWN')
  ),
  sequenced AS (
    SELECT e.*,max(exit_time) OVER (
      PARTITION BY instrument_id ORDER BY signal_timestamp,id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS prior_exit_time
    FROM eligible e
  ),
  non_overlapping AS (
    SELECT * FROM sequenced
    WHERE prior_exit_time IS NULL OR signal_timestamp >= prior_exit_time
  ),
  dates AS (
    SELECT DISTINCT session_date FROM non_overlapping
  ),
  date_buckets AS (
    SELECT session_date,ntile(4) OVER (ORDER BY session_date) AS block
    FROM dates
  ),
  bucketed AS (
    SELECT e.*,d.block
    FROM non_overlapping e JOIN date_buckets d USING(session_date)
  ),
  summary AS (
    SELECT profile_config_id,strategy_key,strategy_version,
           count(*)::integer AS total,
           count(*) FILTER (WHERE block <= 3)::integer AS train_rows,
           count(*) FILTER (WHERE block = 4)::integer AS test_rows,
           count(*) FILTER (WHERE block <= 3 AND r_multiple > 0)::integer AS train_pos,
           count(*) FILTER (WHERE block <= 3 AND r_multiple <= 0)::integer AS train_neg,
           count(*) FILTER (WHERE block = 4 AND r_multiple > 0)::integer AS test_pos,
           count(*) FILTER (WHERE block = 4 AND r_multiple <= 0)::integer AS test_neg,
           count(*) FILTER (WHERE r_multiple > 0)::integer AS wins,
           coalesce(avg(r_multiple) FILTER (WHERE block = 4),0) AS test_expectancy,
           count(DISTINCT session_date)::integer AS sessions
    FROM bucketed
    GROUP BY profile_config_id,strategy_key,strategy_version
  ),
  walk_forward_windows AS (
    SELECT b.profile_config_id,b.strategy_key,b.strategy_version,w.index,
           count(b.id) FILTER (WHERE b.block < w.index)::integer AS train_rows,
           count(b.id) FILTER (WHERE b.block = w.index)::integer AS test_rows,
           count(b.id) FILTER (WHERE b.block = w.index AND b.r_multiple > 0)::integer AS test_pos,
           count(b.id) FILTER (WHERE b.block = w.index AND b.r_multiple <= 0)::integer AS test_neg,
           coalesce(avg(b.r_multiple) FILTER (WHERE b.block = w.index),0) AS test_expectancy
    FROM generate_series(2,4) AS w(index)
    LEFT JOIN bucketed b ON true
    GROUP BY b.profile_config_id,b.strategy_key,b.strategy_version,w.index
  ),
  walk_forward AS (
    SELECT profile_config_id,strategy_key,strategy_version,
           count(*) FILTER (
             WHERE train_rows >= 100 AND test_rows >= 30
               AND test_pos > 0 AND test_neg > 0 AND test_expectancy > 0
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
    cohort_assumptions,'paper-qualification-v3',completed_run_id,
    s.total,s.wins,coalesce(sum(b.r_multiple),0),coalesce(sum(b.r_multiple),0),coalesce(avg(b.r_multiple),0),
    CASE WHEN s.total >= 200 AND s.sessions >= 4
              AND s.train_rows >= 100 AND s.test_rows >= 40
              AND s.train_pos > 0 AND s.train_neg > 0
              AND s.test_pos > 0 AND s.test_neg > 0
              AND s.test_expectancy > 0
              AND wf.qualified_windows >= 2
              AND wf.windows = 3
         THEN 'PAPER_QUALIFIED' ELSE 'EXPLORATORY' END
  FROM summary s
  JOIN bucketed b
    ON b.profile_config_id=s.profile_config_id
   AND b.strategy_key=s.strategy_key
   AND b.strategy_version=s.strategy_version
  JOIN walk_forward wf
    ON wf.profile_config_id=s.profile_config_id
   AND wf.strategy_key=s.strategy_key
   AND wf.strategy_version=s.strategy_version
  GROUP BY s.profile_config_id,s.strategy_key,s.strategy_version,
           s.total,s.wins,s.test_pos,s.train_rows,s.test_rows,s.train_pos,s.train_neg,
           s.test_neg,s.test_expectancy,s.sessions,wf.qualified_windows,wf.windows;
END;
$$ LANGUAGE plpgsql;

-- Seed the stricter projection from existing explicit evidence. Existing v1/v2
-- rows remain historical and are no longer consumed by the profile repository.
SELECT refresh_paper_profile_qualifications(id)
FROM paper_bot_run WHERE source='LIVE' AND status='COMPLETED';

INSERT INTO foundation_schema_version(version,description)
VALUES(75,'Paper profile qualification v3: provenance and walk-forward gates')
ON CONFLICT(version) DO NOTHING;
