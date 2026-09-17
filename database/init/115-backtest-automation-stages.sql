-- A2 prerequisite-driven stages. Each row records one follow-on evaluation for
-- a completed baseline work item: prerequisites, immutable input identity,
-- authorization scope, retry/backoff and terminal outcome. Training and study
-- stages are never launched by automation; a stage can only reach QUEUED through
-- an explicitly authorized dispatcher (see the funded replay policy in 116).

CREATE TABLE IF NOT EXISTS backtest_automation_stage (
  stage_key TEXT NOT NULL CHECK (
    stage_key IN ('COVERAGE','CALIBRATION','TRAINING','STRATEGY_STUDY','FUNDED_REPLAY')
  ),
  work_key TEXT NOT NULL REFERENCES backtest_automation_work(work_key) ON DELETE CASCADE,
  market_id TEXT NOT NULL CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  state TEXT NOT NULL CHECK (
    state IN ('WAITING_FOR_EVIDENCE','NOT_ELIGIBLE','RETRY_SCHEDULED','QUEUED','RUNNING','FAILED','COMPLETED','SKIPPED')
  ),
  authorization_scope TEXT NOT NULL CHECK (
    authorization_scope IN ('AUTOMATIC','QUALIFICATION_OWNED','AUTHORIZATION_REQUIRED','POLICY_REQUIRED')
  ),
  input_identity_hash TEXT CHECK (input_identity_hash ~ '^[a-f0-9]{64}$'),
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  job_id UUID REFERENCES research_job(id),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  failure_message TEXT,
  last_evaluated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (stage_key, work_key)
);

CREATE INDEX IF NOT EXISTS backtest_automation_stage_market_idx
  ON backtest_automation_stage(market_id, state, updated_at DESC);

INSERT INTO foundation_schema_version(version, description)
VALUES(115, 'Backtest automation prerequisite-driven stages')
ON CONFLICT (version) DO NOTHING;
