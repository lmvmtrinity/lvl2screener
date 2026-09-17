-- Additive market boundary. Existing records are immutable TSX history and are
-- therefore backfilled to CA_TSX. Do not edit earlier migrations: the ledger
-- validates their checksums.

ALTER TABLE instrument ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE universe_refresh_run ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE universe_membership ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE universe_watchlist ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE feature_snapshot ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE strategy_signal ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE strategy_state_event ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE strategy_evaluation ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE context_evaluation ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE scanner_alert ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE journal_trade ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE backtest_run ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE calibration_run ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE ranking_research_run ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_bot_run ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_signal_observation ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_execution ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_portfolio ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_coordination_decision ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_coordination_position ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE statistical_training_dataset ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE statistical_model ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_model_prediction_snapshot ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_profile_qualification ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE learning_automation_run ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';

ALTER TABLE instrument ADD CONSTRAINT instrument_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE universe_refresh_run ADD CONSTRAINT universe_refresh_run_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE universe_membership ADD CONSTRAINT universe_membership_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE universe_watchlist ADD CONSTRAINT universe_watchlist_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE feature_snapshot ADD CONSTRAINT feature_snapshot_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE strategy_signal ADD CONSTRAINT strategy_signal_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE strategy_state_event ADD CONSTRAINT strategy_state_event_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE strategy_evaluation ADD CONSTRAINT strategy_evaluation_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE context_evaluation ADD CONSTRAINT context_evaluation_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE scanner_alert ADD CONSTRAINT scanner_alert_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE journal_trade ADD CONSTRAINT journal_trade_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE backtest_run ADD CONSTRAINT backtest_run_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE calibration_run ADD CONSTRAINT calibration_run_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE ranking_research_run ADD CONSTRAINT ranking_research_run_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE paper_bot_run ADD CONSTRAINT paper_bot_run_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE paper_signal_observation ADD CONSTRAINT paper_signal_observation_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE paper_execution ADD CONSTRAINT paper_execution_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE paper_portfolio ADD CONSTRAINT paper_portfolio_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE paper_coordination_decision ADD CONSTRAINT paper_coordination_decision_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE paper_coordination_position ADD CONSTRAINT paper_coordination_position_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE statistical_training_dataset ADD CONSTRAINT statistical_training_dataset_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE statistical_model ADD CONSTRAINT statistical_model_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE paper_model_prediction_snapshot ADD CONSTRAINT paper_model_prediction_snapshot_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE paper_profile_qualification ADD CONSTRAINT paper_profile_qualification_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));
ALTER TABLE learning_automation_run ADD CONSTRAINT learning_automation_run_market_id_check CHECK (market_id IN ('CA_TSX', 'US_EQUITIES'));

ALTER TABLE instrument ADD CONSTRAINT instrument_market_currency_check CHECK (
  (market_id = 'CA_TSX' AND currency = 'CAD') OR
  (market_id = 'US_EQUITIES' AND currency = 'USD')
);

ALTER TABLE instrument DROP CONSTRAINT IF EXISTS instrument_symbol_key;
ALTER TABLE instrument ADD CONSTRAINT instrument_market_symbol_key UNIQUE (market_id, symbol);
ALTER TABLE universe_watchlist DROP CONSTRAINT IF EXISTS universe_watchlist_pkey;
ALTER TABLE universe_watchlist ADD CONSTRAINT universe_watchlist_pkey PRIMARY KEY (market_id, provider);

CREATE INDEX IF NOT EXISTS instrument_market_active_symbol_idx ON instrument (market_id, active, symbol);
CREATE INDEX IF NOT EXISTS universe_refresh_run_market_started_idx ON universe_refresh_run (market_id, started_at DESC);
CREATE INDEX IF NOT EXISTS universe_membership_market_symbol_idx ON universe_membership (market_id, symbol);
CREATE INDEX IF NOT EXISTS feature_snapshot_market_timestamp_idx ON feature_snapshot (market_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS strategy_evaluation_market_timestamp_idx ON strategy_evaluation (market_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS paper_bot_run_market_started_idx ON paper_bot_run (market_id, started_at DESC);

INSERT INTO foundation_schema_version(version,description)
VALUES(56,'Market identity and CA_TSX compatibility backfill')
ON CONFLICT(version) DO NOTHING;
