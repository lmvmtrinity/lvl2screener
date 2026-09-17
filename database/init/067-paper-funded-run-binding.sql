CREATE TABLE paper_funded_run (
  run_id UUID PRIMARY KEY REFERENCES paper_bot_run(id),
  account_id UUID NOT NULL UNIQUE REFERENCES paper_funded_account(id),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
