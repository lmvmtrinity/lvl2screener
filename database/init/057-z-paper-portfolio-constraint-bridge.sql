-- 056 introduced these market/currency checks. 058 was authored against an
-- earlier base and creates the same named checks unconditionally. Keep both
-- immutable migrations intact: this bridge runs immediately before 058 and
-- removes only the duplicate predecessors on databases still awaiting 058.
-- Databases that have already applied 058 retain its constraints unchanged.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migration
    WHERE filename='058-paper-portfolio-market-isolation.sql'
  ) THEN
    ALTER TABLE paper_portfolio
      DROP CONSTRAINT IF EXISTS paper_portfolio_market_id_check,
      DROP CONSTRAINT IF EXISTS paper_portfolio_currency_check;
  END IF;
END;
$$;
