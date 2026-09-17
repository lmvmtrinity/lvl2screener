-- Bind parity audits to the run's own market. The original single-column
-- reference allowed an audit row to name one market while pointing at a run
-- owned by the other market.
ALTER TABLE discovery_run ADD CONSTRAINT discovery_run_id_market_unique UNIQUE (id, market_id);
ALTER TABLE discovery_parity_audit DROP CONSTRAINT IF EXISTS discovery_parity_audit_run_id_fkey;
ALTER TABLE discovery_parity_audit ADD CONSTRAINT discovery_parity_audit_run_market_fkey
    FOREIGN KEY (run_id, market_id) REFERENCES discovery_run(id, market_id) ON DELETE CASCADE;

-- Resolved mappings recorded under the superseded generic `Stock` acceptance
-- were never reviewed classification evidence. Remove them so the corrected
-- mapper must re-observe the symbol instead of trusting a stale promotion.
DELETE FROM discovery_symbol_mapping
WHERE decision->>'status' = 'RESOLVED'
  AND decision->'instrument'->>'securityType' = 'Stock';

INSERT INTO foundation_schema_version(version, description)
VALUES(111, 'Discovery parity market binding and classification evidence correction')
ON CONFLICT (version) DO NOTHING;
