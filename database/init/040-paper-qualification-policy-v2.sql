-- Strengthen paper qualification without rewriting v1 history. A v2 row is a
-- separate, explainable policy result for the same immutable cohort.

CREATE OR REPLACE FUNCTION refresh_paper_profile_qualifications(completed_run_id UUID) RETURNS void AS $$
DECLARE
  cohort_version TEXT;
  cohort_assumptions JSONB;
BEGIN
  SELECT execution_model_version,assumptions INTO cohort_version,cohort_assumptions
  FROM paper_bot_run
  WHERE id=completed_run_id AND source='LIVE' AND status='COMPLETED';
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO paper_profile_qualification(
    profile_config_id,strategy_key,strategy_version,execution_model_version,
    assumptions,policy_version,as_of_run_id,closed_trades,wins,net_pnl,cumulative_r,average_r,qualification
  )
  SELECT o.profile_config_id,o.strategy_key,o.strategy_version,cohort_version,
    cohort_assumptions,'paper-qualification-v2',completed_run_id,
    count(*)::integer,count(*) FILTER (WHERE x.net_pnl>0)::integer,
    coalesce(sum(x.net_pnl),0),coalesce(sum(x.r_multiple),0),coalesce(avg(x.r_multiple),0),
    CASE WHEN count(*) >= 30
              AND coalesce(sum(x.net_pnl),0)>0
              AND coalesce(sum(x.r_multiple),0)>0
              AND coalesce(avg(x.r_multiple),0)>0
              AND count(*) FILTER (WHERE x.net_pnl>0)::numeric / count(*) >= 0.35
         THEN 'PAPER_QUALIFIED' ELSE 'EXPLORATORY' END
  FROM paper_execution x
  JOIN paper_signal_observation o ON o.id=x.observation_id
  JOIN paper_bot_run r ON r.id=o.run_id
  WHERE r.source='LIVE' AND r.status='COMPLETED'
    AND r.execution_model_version=cohort_version AND r.assumptions=cohort_assumptions
    AND x.model='QUOTE' AND x.status='CLOSED'
  GROUP BY o.profile_config_id,o.strategy_key,o.strategy_version
  ON CONFLICT(profile_config_id,strategy_key,strategy_version,execution_model_version,assumptions,policy_version)
  DO UPDATE SET as_of_run_id=EXCLUDED.as_of_run_id,
    closed_trades=EXCLUDED.closed_trades,wins=EXCLUDED.wins,net_pnl=EXCLUDED.net_pnl,
    cumulative_r=EXCLUDED.cumulative_r,average_r=EXCLUDED.average_r,
    qualification=EXCLUDED.qualification,computed_at=now();
END;
$$ LANGUAGE plpgsql;

-- Seed v2 from immutable existing evidence, then the existing completion
-- trigger keeps it current for every new LIVE run.
SELECT refresh_paper_profile_qualifications(id)
FROM paper_bot_run WHERE source='LIVE' AND status='COMPLETED';

INSERT INTO foundation_schema_version(version, description)
VALUES(40, 'Paper qualification policy v2: positive R and minimum 35% win rate')
ON CONFLICT(version) DO NOTHING;
