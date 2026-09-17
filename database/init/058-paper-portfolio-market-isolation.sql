ALTER TABLE paper_portfolio ADD COLUMN IF NOT EXISTS market_id TEXT NOT NULL DEFAULT 'CA_TSX';
ALTER TABLE paper_portfolio ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CAD';
ALTER TABLE paper_portfolio ADD CONSTRAINT paper_portfolio_market_id_check
  CHECK (market_id IN ('CA_TSX','US_EQUITIES'));
ALTER TABLE paper_portfolio ADD CONSTRAINT paper_portfolio_currency_check
  CHECK ((market_id='CA_TSX' AND currency='CAD') OR (market_id='US_EQUITIES' AND currency='USD'));
CREATE UNIQUE INDEX IF NOT EXISTS paper_portfolio_market_mode_uq ON paper_portfolio(market_id,mode);
INSERT INTO paper_portfolio(key,market_id,currency,mode,status)
VALUES('COORDINATED_SHADOW_US','US_EQUITIES','USD','SHADOW','ACTIVE')
ON CONFLICT(key) DO NOTHING;
