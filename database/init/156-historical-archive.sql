-- Historical research archive (ADR-019).
--
-- Provider history imported for exploratory US backtests, kept apart from the
-- Questrade `candle` and `quote_snapshot` tables so an import can never replace
-- a captured row. Every stored row points at the import that first wrote it;
-- later imports never overwrite values and count differing rows instead.

CREATE TABLE historical_archive_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('MASSIVE', 'DATABENTO')),
  dataset text NOT NULL,
  schema_name text NOT NULL CHECK (
    schema_name IN ('aggs-1m', 'aggs-1d', 'cbbo-1m')
  ),
  market_id text NOT NULL CHECK (market_id = 'US_EQUITIES'),
  instrument_id uuid NOT NULL REFERENCES instrument(id),
  provider_symbol text NOT NULL,
  range_start date NOT NULL,
  range_end date NOT NULL,
  request_params jsonb NOT NULL,
  response_sha256 text NOT NULL CHECK (response_sha256 ~ '^[a-f0-9]{64}$'),
  response_bytes bigint NOT NULL CHECK (response_bytes >= 0),
  record_count integer NOT NULL CHECK (record_count >= 0),
  inserted_count integer NOT NULL CHECK (inserted_count >= 0),
  conflicting_count integer NOT NULL CHECK (conflicting_count >= 0),
  cost_usd numeric CHECK (cost_usd IS NULL OR cost_usd >= 0),
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (range_end >= range_start)
);

CREATE INDEX historical_archive_import_scope_idx
  ON historical_archive_import (instrument_id, provider, schema_name, range_start);

CREATE TABLE historical_bar (
  instrument_id uuid NOT NULL REFERENCES instrument(id),
  provider text NOT NULL CHECK (provider = 'MASSIVE'),
  timeframe text NOT NULL CHECK (timeframe IN ('OneMinute', 'OneDay')),
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  open numeric NOT NULL CHECK (open > 0),
  high numeric NOT NULL CHECK (high > 0),
  low numeric NOT NULL CHECK (low > 0),
  close numeric NOT NULL CHECK (close > 0),
  volume numeric NOT NULL CHECK (volume >= 0),
  vwap numeric,
  trade_count integer,
  import_id uuid NOT NULL REFERENCES historical_archive_import(id),
  PRIMARY KEY (instrument_id, provider, timeframe, start_time),
  CHECK (end_time > start_time),
  CHECK (low <= high)
);

SELECT create_hypertable(
  'historical_bar', 'start_time',
  chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE
);

CREATE TABLE historical_quote_minute (
  instrument_id uuid NOT NULL REFERENCES instrument(id),
  provider text NOT NULL CHECK (provider = 'DATABENTO'),
  dataset text NOT NULL,
  sampled_at timestamptz NOT NULL,
  bid numeric NOT NULL CHECK (bid > 0),
  ask numeric NOT NULL CHECK (ask > 0),
  bid_size bigint NOT NULL CHECK (bid_size >= 0),
  ask_size bigint NOT NULL CHECK (ask_size >= 0),
  import_id uuid NOT NULL REFERENCES historical_archive_import(id),
  PRIMARY KEY (instrument_id, provider, dataset, sampled_at)
);

SELECT create_hypertable(
  'historical_quote_minute', 'sampled_at',
  chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE
);

-- Backtests may now replay the archive. Such runs stay exploratory: they never
-- carry captured spreads, so statistical training and signal-model research
-- keep rejecting them through their existing CAPTURED_QUOTES checks.
ALTER TABLE backtest_run DROP CONSTRAINT backtest_run_data_source_check;
ALTER TABLE backtest_run ADD CONSTRAINT backtest_run_data_source_check
  CHECK (data_source IN ('CAPTURED_QUOTES', 'HISTORICAL_ARCHIVE'));
