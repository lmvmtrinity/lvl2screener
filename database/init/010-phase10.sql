ALTER TABLE instrument ADD COLUMN IF NOT EXISTS last_price NUMERIC;
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS average_dollar_volume NUMERIC;
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS atr_14 NUMERIC;
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS atr_pct NUMERIC;
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS universe_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS universe_evaluated_at TIMESTAMPTZ;
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS universe_source TEXT;

CREATE TABLE IF NOT EXISTS universe_refresh_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),
  discovered_count INTEGER NOT NULL DEFAULT 0,
  evaluated_count INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  activated_count INTEGER NOT NULL DEFAULT 0,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS universe_membership (
  run_id UUID NOT NULL REFERENCES universe_refresh_run(id) ON DELETE CASCADE,
  instrument_id UUID REFERENCES instrument(id),
  symbol TEXT NOT NULL,
  description TEXT NOT NULL,
  exchange TEXT NOT NULL,
  sector TEXT,
  eligible BOOLEAN NOT NULL,
  reasons JSONB NOT NULL,
  price NUMERIC,
  market_cap NUMERIC,
  average_volume_20d NUMERIC,
  average_volume_90d NUMERIC,
  dollar_volume NUMERIC,
  atr_14 NUMERIC,
  atr_pct NUMERIC,
  metrics_as_of TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(run_id, symbol)
);

CREATE TABLE IF NOT EXISTS universe_watchlist (
  provider TEXT PRIMARY KEY,
  symbols JSONB NOT NULL,
  trading_date DATE NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE universe_watchlist ADD COLUMN IF NOT EXISTS trading_date DATE;
UPDATE universe_watchlist SET trading_date=((CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date) WHERE trading_date IS NULL;
ALTER TABLE universe_watchlist ALTER COLUMN trading_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS universe_refresh_run_started_idx ON universe_refresh_run(started_at DESC);
CREATE INDEX IF NOT EXISTS universe_membership_latest_idx ON universe_membership(symbol, run_id);
CREATE INDEX IF NOT EXISTS instrument_universe_eligible_idx ON instrument(universe_eligible, symbol);

INSERT INTO foundation_schema_version(version,description)
VALUES(10,'Phase 10 automated TSX universe maintenance')
ON CONFLICT(version) DO NOTHING;
