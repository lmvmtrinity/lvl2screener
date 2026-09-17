-- Preserve the exact context observations used by captured-history ranking studies.
-- Legacy backtest trades remain neutral and readable.
ALTER TABLE backtest_trade ADD COLUMN IF NOT EXISTS context_score INTEGER NOT NULL DEFAULT 50 CHECK (context_score BETWEEN 0 AND 100);
ALTER TABLE backtest_trade ADD COLUMN IF NOT EXISTS context_evaluations JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS ranking_research_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  backtest_run_id UUID NOT NULL REFERENCES backtest_run(id),
  input JSONB NOT NULL,
  active_formula_version_at_start TEXT NOT NULL REFERENCES ranking_formula(version),
  chronological_split_at TIMESTAMPTZ,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ranking_research_run_created_idx ON ranking_research_run(created_at DESC);
CREATE INDEX IF NOT EXISTS ranking_research_run_backtest_idx ON ranking_research_run(backtest_run_id,created_at DESC);

INSERT INTO foundation_schema_version(version,description)
VALUES(17,'Phase 6 captured-context ranking studies and activation evidence')
ON CONFLICT(version) DO NOTHING;
