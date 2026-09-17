CREATE TABLE paper_entry_liquidity (
  run_id UUID NOT NULL REFERENCES paper_bot_run(id),
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  quote_at TIMESTAMPTZ NOT NULL,
  state JSONB NOT NULL,
  orders JSONB NOT NULL,
  PRIMARY KEY(run_id,instrument_id)
);
