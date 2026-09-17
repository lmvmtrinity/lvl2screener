-- WP02 I02: durable completed-source cursor for bounded evidence catch-up.
-- A source completion is only a hint; without an explicit frozen manifest the
-- automation receipt remains WAITING and no coverage claim is fabricated.
CREATE TABLE IF NOT EXISTS research_evidence_source_watermark (
  market_id TEXT PRIMARY KEY CHECK (market_id IN ('CA_TSX','US_EQUITIES')),
  last_completed_at TIMESTAMPTZ,
  last_source_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO foundation_schema_version(version, description)
VALUES (91, 'WP02 bounded evidence source watermark')
ON CONFLICT (version) DO NOTHING;
