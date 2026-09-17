-- Paper-run identity must be market-scoped: identical dates/model versions can
-- legitimately run once for CAD/TSX and once for USD/US equities.
DROP INDEX IF EXISTS paper_bot_run_live_session_uq;
CREATE UNIQUE INDEX IF NOT EXISTS paper_bot_run_live_market_session_uq
  ON paper_bot_run(market_id, session_date, execution_model_version)
  WHERE source = 'LIVE';
