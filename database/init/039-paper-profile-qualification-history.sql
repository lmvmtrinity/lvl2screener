-- Persist the bot-derived qualification result for each immutable evidence
-- cohort. Raw bot observations/executions remain the source of truth; this is
-- a fast, explainable projection refreshed only after a LIVE run completes.

CREATE TABLE IF NOT EXISTS paper_profile_qualification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_config_id UUID NOT NULL REFERENCES scanner_profile_config(id),
  strategy_key TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  execution_model_version TEXT NOT NULL,
  assumptions JSONB NOT NULL CHECK (jsonb_typeof(assumptions) = 'object'),
  policy_version TEXT NOT NULL DEFAULT 'paper-qualification-v1',
  as_of_run_id UUID NOT NULL REFERENCES paper_bot_run(id),
  closed_trades INTEGER NOT NULL CHECK (closed_trades >= 0),
  wins INTEGER NOT NULL CHECK (wins >= 0 AND wins <= closed_trades),
  net_pnl NUMERIC NOT NULL,
  cumulative_r NUMERIC NOT NULL,
  average_r NUMERIC NOT NULL,
  qualification TEXT NOT NULL CHECK (qualification IN ('EXPLORATORY','PAPER_QUALIFIED')),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(profile_config_id,strategy_key,strategy_version,execution_model_version,assumptions,policy_version)
);

CREATE INDEX IF NOT EXISTS paper_profile_qualification_active_idx
  ON paper_profile_qualification(profile_config_id,execution_model_version,computed_at DESC);

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
    assumptions,as_of_run_id,closed_trades,wins,net_pnl,cumulative_r,average_r,qualification
  )
  SELECT o.profile_config_id,o.strategy_key,o.strategy_version,cohort_version,
    cohort_assumptions,completed_run_id,
    count(*)::integer,count(*) FILTER (WHERE x.net_pnl>0)::integer,
    coalesce(sum(x.net_pnl),0),coalesce(sum(x.r_multiple),0),coalesce(avg(x.r_multiple),0),
    CASE WHEN count(*) >= 30 AND coalesce(sum(x.net_pnl),0)>0
              AND count(*) FILTER (WHERE x.net_pnl>0)>0
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

CREATE OR REPLACE FUNCTION refresh_paper_profile_qualifications_on_run_complete() RETURNS trigger AS $$
BEGIN
  IF NEW.source='LIVE' AND NEW.status='COMPLETED' THEN
    IF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM refresh_paper_profile_qualifications(NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill every existing completed cohort, then keep the projection current
-- as future runs settle. Re-running is safe because the cohort key is unique.
SELECT refresh_paper_profile_qualifications(id)
FROM paper_bot_run WHERE source='LIVE' AND status='COMPLETED';

DROP TRIGGER IF EXISTS paper_profile_qualification_refresh ON paper_bot_run;
CREATE TRIGGER paper_profile_qualification_refresh
AFTER INSERT OR UPDATE OF status ON paper_bot_run
FOR EACH ROW EXECUTE FUNCTION refresh_paper_profile_qualifications_on_run_complete();

INSERT INTO foundation_schema_version(version, description)
VALUES(39, 'Persisted paper-bot qualification history by execution cohort')
ON CONFLICT(version) DO NOTHING;
