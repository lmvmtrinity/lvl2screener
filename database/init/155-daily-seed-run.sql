-- Pre-market daily-list seed runs (daily-seed-v1, ADR-018).
--
-- One row per scheduled or operator-triggered seed attempt that reached an
-- outcome. Previews are not recorded. `symbols` is the list the run left or
-- found: the picks when APPLIED, the operator's symbols when the list was
-- already present. `selection` keeps the ranked picks and funnel counts.
CREATE TABLE daily_seed_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
  trading_date date NOT NULL,
  version text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('SCHEDULE', 'MANUAL')),
  status text NOT NULL CHECK (
    status IN ('APPLIED', 'SKIPPED_LIST_PRESENT', 'NO_PICKS', 'FAILED')
  ),
  symbols jsonb NOT NULL DEFAULT '[]'::jsonb,
  selection jsonb,
  error text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX daily_seed_run_market_date_idx
  ON daily_seed_run (market_id, trading_date DESC, finished_at DESC);
