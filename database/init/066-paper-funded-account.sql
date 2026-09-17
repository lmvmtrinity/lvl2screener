CREATE TABLE paper_funded_account (
  id UUID PRIMARY KEY,
  initial_state JSONB NOT NULL,
  state JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state->>'version' = 'funded-ledger-v1'),
  CHECK (state->>'currency' IN ('CAD','USD'))
);
CREATE TABLE paper_funded_event (
  account_id UUID NOT NULL REFERENCES paper_funded_account(id),
  event_id TEXT NOT NULL,
  event JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,event_id)
);
