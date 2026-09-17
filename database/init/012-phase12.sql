CREATE TABLE IF NOT EXISTS statistical_model (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','TRAINING','COMPLETED','INSUFFICIENT_DATA','FAILED')),
  model_type TEXT NOT NULL CHECK(model_type='LOGISTIC_SETUP_QUALITY'),
  model_version TEXT NOT NULL,
  backtest_run_id UUID NOT NULL REFERENCES backtest_run(id),
  strategy_name TEXT NOT NULL,
  input JSONB NOT NULL,
  artifact JSONB,
  train_metrics JSONB,
  test_metrics JSONB,
  calibration JSONB NOT NULL DEFAULT '[]'::jsonb,
  eligible_for_activation BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT false,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  training_start TIMESTAMPTZ,
  training_end TIMESTAMPTZ,
  test_start TIMESTAMPTZ,
  test_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK(NOT active OR (status='COMPLETED' AND eligible_for_activation))
);
CREATE INDEX IF NOT EXISTS statistical_model_created_idx ON statistical_model(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS statistical_model_one_active_strategy_idx ON statistical_model(strategy_name) WHERE active=true;

INSERT INTO foundation_schema_version(version,description)
VALUES(12,'Phase 12 optional statistical models')
ON CONFLICT(version) DO NOTHING;
