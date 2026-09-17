CREATE TABLE paper_entry_order (
  order_id TEXT PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES paper_bot_run(id),
  instrument_id UUID NOT NULL REFERENCES instrument(id),
  submission JSONB NOT NULL,
  state JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state->>'orderId' = order_id),
  CHECK (state->>'version' = 'pending-entry-v1'),
  CHECK (state->>'status' IN ('PENDING', 'FILLED', 'CANCELLED', 'REJECTED'))
);
CREATE INDEX paper_entry_order_pending ON paper_entry_order(run_id, instrument_id)
  WHERE state->>'status' = 'PENDING';
