-- Qualification projections are evidence cohorts, not global profile state.
-- The v2 function predated market identity and otherwise writes every future
-- US row through its CA_TSX default.

DO $$
DECLARE existing_constraint TEXT;
BEGIN
  SELECT conname INTO existing_constraint
  FROM pg_constraint
  WHERE conrelid='paper_profile_qualification'::regclass
    AND contype='u'
    AND pg_get_constraintdef(oid) LIKE '%profile_config_id%strategy_key%strategy_version%execution_model_version%assumptions%policy_version%'
  LIMIT 1;
  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE paper_profile_qualification DROP CONSTRAINT %I', existing_constraint);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS paper_profile_qualification_market_cohort_uq
  ON paper_profile_qualification(
    market_id,profile_config_id,strategy_key,strategy_version,
    execution_model_version,assumptions,policy_version
  );

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

  INSERT INTO paper_profile_qualification(
    market_id,profile_config_id,strategy_key,strategy_version,execution_model_version,
    assumptions,policy_version,as_of_run_id,closed_trades,wins,net_pnl,cumulative_r,average_r,qualification
  )
  SELECT cohort_market,o.profile_config_id,o.strategy_key,o.strategy_version,cohort_version,
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
  WHERE r.market_id=cohort_market AND r.source='LIVE' AND r.status='COMPLETED'
    AND r.execution_model_version=cohort_version AND r.assumptions=cohort_assumptions
    AND x.model='QUOTE' AND x.status='CLOSED'
  GROUP BY o.profile_config_id,o.strategy_key,o.strategy_version
  ON CONFLICT(market_id,profile_config_id,strategy_key,strategy_version,execution_model_version,assumptions,policy_version)
  DO UPDATE SET as_of_run_id=EXCLUDED.as_of_run_id,
    closed_trades=EXCLUDED.closed_trades,wins=EXCLUDED.wins,net_pnl=EXCLUDED.net_pnl,
    cumulative_r=EXCLUDED.cumulative_r,average_r=EXCLUDED.average_r,
    qualification=EXCLUDED.qualification,computed_at=now();
END;
$$ LANGUAGE plpgsql;

-- Existing rows are immutable CA_TSX history; refresh keeps that cohort
-- intact while creating independent projections for future US runs.
SELECT refresh_paper_profile_qualifications(id)
FROM paper_bot_run WHERE source='LIVE' AND status='COMPLETED';

INSERT INTO foundation_schema_version(version,description)
VALUES(60,'Market-scoped paper profile qualification cohorts')
ON CONFLICT(version) DO NOTHING;
