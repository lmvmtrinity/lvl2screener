CREATE TABLE discovery_parity_audit (
    id uuid PRIMARY KEY,
    market_id text NOT NULL CHECK (market_id IN ('CA_TSX', 'US_EQUITIES')),
    trading_date date NOT NULL,
    run_id uuid REFERENCES discovery_run(id) ON DELETE CASCADE,
    audited_at timestamptz NOT NULL,
    tradingview_count integer NOT NULL CHECK (tradingview_count >= 0),
    questrade_pass_count integer NOT NULL CHECK (questrade_pass_count >= 0),
    overlap_count integer NOT NULL CHECK (overlap_count >= 0),
    overlap_ratio double precision NOT NULL CHECK (overlap_ratio >= 0.0 AND overlap_ratio <= 1.0),
    overlap_symbols jsonb NOT NULL,
    missed_movers jsonb NOT NULL,
    questrade_only jsonb NOT NULL,
    metric_differences jsonb NOT NULL,
    discrepancy_summary jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX discovery_parity_audit_history_idx
    ON discovery_parity_audit(market_id, audited_at DESC, id);

CREATE INDEX discovery_parity_audit_run_idx
    ON discovery_parity_audit(run_id);

CREATE TRIGGER discovery_parity_audit_immutable BEFORE UPDATE ON discovery_parity_audit
    FOR EACH ROW EXECUTE FUNCTION reject_discovery_immutable_change();

INSERT INTO foundation_schema_version(version, description)
VALUES(110, 'TradingView secondary shadow comparator and parity audit evidence')
ON CONFLICT (version) DO NOTHING;
