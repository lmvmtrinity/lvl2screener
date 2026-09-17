-- Bound strategy-formation evidence must outlive in-memory state. These
-- additive JSONB columns preserve the exact pivots, RSI samples, retest bars,
-- contraction ratios, and frozen levels used when each evaluation was made.
ALTER TABLE strategy_signal
  ADD COLUMN IF NOT EXISTS formation_evidence JSONB;

ALTER TABLE strategy_evaluation
  ADD COLUMN IF NOT EXISTS formation_evidence JSONB;

ALTER TABLE strategy_state_event
  ADD COLUMN IF NOT EXISTS formation_evidence JSONB;

INSERT INTO foundation_schema_version(version,description)
VALUES(81,'Versioned strategy formation evidence persistence')
ON CONFLICT(version) DO NOTHING;
